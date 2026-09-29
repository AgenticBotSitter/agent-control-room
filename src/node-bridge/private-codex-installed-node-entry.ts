import { types } from "node:util";
import { EncryptedFileNodePrivateKeyStore } from "../node-policy/v1/encrypted-file-key-store";
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
  /** First-release Linux custody. Other platforms require their own reviewed concrete wrapper. */
  keys: EncryptedFileNodePrivateKeyStore;
  clock?: () => number;
}) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || !(value.bridge instanceof PortableNodeBridge) || !(value.journal instanceof SqliteBridgeJournal)
    || !(value.security instanceof SqliteNodeSecurityStateRepository)
    || !(value.approvals instanceof PinnedApprovalTrustStore)
    || !(value.keys instanceof EncryptedFileNodePrivateKeyStore) || types.isProxy(value.keys)
    || Object.getPrototypeOf(value.keys) !== EncryptedFileNodePrivateKeyStore.prototype
    || Object.hasOwn(value.keys, "reference") || Object.hasOwn(value.keys, "sign")
    || value.clock !== undefined && typeof value.clock !== "function") unavailable();
  const bridge = value.bridge, journal = value.journal, clock = value.clock ?? Date.now;
  const reader = createPrivateCodexCurrentAdmissionReaderV1({ ...value, clock });
  const issued = new Set<string>();

  return Object.freeze({
    schema: PRIVATE_CODEX_INSTALLED_NODE_ENTRY_V1,
    startsWork: false as const,
    grantsExecutionAuthority: false as const,
    async exchange(queueId: string, signal: AbortSignal, responseTimeoutMs = 5_000): Promise<Readonly<{
      schema: typeof PRIVATE_CODEX_INSTALLED_NODE_ENTRY_V1;
      startsWork: false;
      grantsExecutionAuthority: false;
      sessionCapability: PrivateCodexSessionCapabilityV1;
      binding: Readonly<{ tenantId: string; nodeId: string; enrollmentDigest: string;
        connectorProfileDigest: string; sessionIdentityDigest: string }>;
    }>> {
      if (issued.has(queueId)) unavailable();
      if (!(signal instanceof AbortSignal)) unavailable();
      // Burn before reservation or transport. Uncertain journal/sign/send or a
      // lost answer cannot become a second request for the same activation.
      issued.add(queueId);
      try {
        const prepared = await reader.issue(queueId);
        const carried = await bridge.exchangeCodexCurrentAdmission(prepared.request.body,
          prepared.request.sentAt, prepared.request.expiresAt, signal, responseTimeoutMs);
        const accepted = await reader.accept(queueId, JSON.stringify(carried.response), carried.request);
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
