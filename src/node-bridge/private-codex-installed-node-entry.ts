import { types } from "node:util";
import type { NodePrivateKeyStore } from "../node-policy/v1/stores";
import { PinnedApprovalTrustStore } from "../node-policy/v1/pinned-approval-trust";
import { SqliteNodeSecurityStateRepository } from "../node-policy/v1/persistent-security-state";
import { PortableNodeBridge } from "./bridge";
import { SqliteBridgeJournal } from "./journal";
import { createPrivateCodexCurrentAdmissionReaderV1,
  consumePrivateCodexCurrentAdmissionCapabilityV1 } from "./private-codex-current-admission-read";
import { createPrivateCodexSessionOwnerV1, type PrivateCodexSessionCapabilityV1 }
  from "./private-codex-session-owner";

export const PRIVATE_CODEX_INSTALLED_NODE_ENTRY_V1 =
  "control-room.private-codex-installed-node-entry/v1" as const;

const unavailable = (): never => { throw new Error("private_codex_installed_node_entry_unavailable"); };

/**
 * Source-only protected join for the installed Linux Codex node.  It owns the
 * admission reader and never exposes the current-policy port it derives from
 * the signed controller answer.  Construction and issue are non-executing;
 * the returned session capability is still only input to the later bounded
 * Codex worker composition.
 *
 * The outer installer remains responsible for creating these exact live
 * objects from protected paths/key custody and for closing them.  This module
 * neither opens paths nor resolves credentials or transport.
 */
export function createPrivateCodexInstalledNodeEntryV1(value: {
  bridge: PortableNodeBridge;
  journal: SqliteBridgeJournal;
  security: SqliteNodeSecurityStateRepository;
  approvals: PinnedApprovalTrustStore;
  keys: NodePrivateKeyStore;
  clock?: () => number;
}) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || !(value.bridge instanceof PortableNodeBridge) || !(value.journal instanceof SqliteBridgeJournal)
    || !(value.security instanceof SqliteNodeSecurityStateRepository)
    || !(value.approvals instanceof PinnedApprovalTrustStore)
    || !value.keys || typeof value.keys !== "object" || types.isProxy(value.keys)
    || typeof value.keys.reference !== "function" || typeof value.keys.sign !== "function"
    || value.clock !== undefined && typeof value.clock !== "function") unavailable();
  const bridge = value.bridge, journal = value.journal, clock = value.clock ?? Date.now;
  const reader = createPrivateCodexCurrentAdmissionReaderV1({ ...value, clock });
  const issued = new Set<string>();

  return Object.freeze({
    schema: PRIVATE_CODEX_INSTALLED_NODE_ENTRY_V1,
    startsWork: false as const,
    grantsExecutionAuthority: false as const,
    async issue(queueId: string) {
      if (issued.has(queueId)) unavailable();
      // Burn before the signed request leaves this boundary. Uncertain send or
      // a lost answer cannot become a second request for the same activation.
      issued.add(queueId);
      try { return await reader.issue(queueId); } catch { return unavailable(); }
    },
    async accept(queueId: string, rawResponse: string | Uint8Array): Promise<Readonly<{
      schema: typeof PRIVATE_CODEX_INSTALLED_NODE_ENTRY_V1;
      startsWork: false;
      grantsExecutionAuthority: false;
      sessionCapability: PrivateCodexSessionCapabilityV1;
      binding: Readonly<{ tenantId: string; nodeId: string; enrollmentDigest: string;
        connectorProfileDigest: string; sessionIdentityDigest: string }>;
    }>> {
      if (!issued.has(queueId)) unavailable();
      try {
        const accepted = await reader.accept(queueId, rawResponse);
        const policy = consumePrivateCodexCurrentAdmissionCapabilityV1(accepted.capability);
        const owner = createPrivateCodexSessionOwnerV1({ bridge, journal, currentPolicy: policy, clock });
        const minted = owner.mint(queueId);
        return Object.freeze({ schema: PRIVATE_CODEX_INSTALLED_NODE_ENTRY_V1,
          startsWork: false as const, grantsExecutionAuthority: false as const,
          sessionCapability: minted.capability, binding: minted.binding });
      } catch { return unavailable(); }
    },
  });
}
