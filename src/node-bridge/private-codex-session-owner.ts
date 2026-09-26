import { types } from "node:util";
import { digestSchema, localId } from "../harness/v1/native-run-identifiers";
import { sha256Digest } from "../security/canonical-digest";
import { assertSynchronousFence } from "../security/synchronous-fence";
import { PortableNodeBridge } from "./bridge";
import { SqliteBridgeJournal } from "./journal";

/**
 * The private node installation creates this owner around the actual bridge,
 * journal, and protected current-policy port. It is not browser/task input.
 * The policy port is the deliberately narrow outer-composition injection: the
 * current source has no concrete installed Codex admission owner yet.
 */
export const PRIVATE_CODEX_SESSION_OWNER_V1 = "control-room.private-codex-session-owner/v1" as const;
export const PRIVATE_CODEX_SESSION_CAPABILITY_V1 = "control-room.private-codex-session-capability/v1" as const;

const unavailable = (): never => { throw new Error("private_codex_session_owner_unavailable"); };

export interface PrivateCodexCurrentPolicyPortV1 {
  currentAdmissionDigest(queueId: string): string;
  currentServerTrustRevision(): string;
  /** Must synchronously reject revoked enrollment, changed admission or trust. */
  assertCurrent(queueId: string): void;
}

export interface PrivateCodexSessionOwnerInputV1 {
  /** Real, already authenticated/reconciled bridge; never a request object. */
  bridge: PortableNodeBridge;
  /** Real protected journal containing accepted delivery and activation evidence. */
  journal: SqliteBridgeJournal;
  /** Supplied by the one future installed Codex admission/trust owner. */
  currentPolicy: PrivateCodexCurrentPolicyPortV1;
  /** Private monotonic clock from that same outer composition boundary. */
  clock(): number;
}

type BoundSession = Readonly<{
  tenantId: string;
  nodeId: string;
  enrollmentDigest: string;
  connectorProfileDigest: string;
  sessionIdentityDigest: string;
  assertCurrent: () => void;
}>;

const capabilities = new WeakMap<object, BoundSession>();

export type PrivateCodexSessionCapabilityV1 = Readonly<{
  schema: typeof PRIVATE_CODEX_SESSION_CAPABILITY_V1;
}>;

export type PrivateCodexSessionOwnerV1 = Readonly<{
  schema: typeof PRIVATE_CODEX_SESSION_OWNER_V1;
  startsWork: false;
  mint(queueId: string): Readonly<{
    schema: typeof PRIVATE_CODEX_SESSION_CAPABILITY_V1;
    capability: PrivateCodexSessionCapabilityV1;
    binding: Readonly<{
      tenantId: string; nodeId: string; enrollmentDigest: string;
      connectorProfileDigest: string; sessionIdentityDigest: string;
    }>;
  }>;
}>;

/**
 * Creates a closure-owned minting owner. Construction does not read a record,
 * contact a bridge, launch Codex, or perform any other effect. Evidence is
 * read and revalidated only when the private installer asks to mint for one
 * concrete queue id.
 */
export function createPrivateCodexSessionOwnerV1(value: PrivateCodexSessionOwnerInputV1): PrivateCodexSessionOwnerV1 {
  const input = value;
  if (!input || typeof input !== "object" || types.isProxy(input)
    || !(input.bridge instanceof PortableNodeBridge) || !(input.journal instanceof SqliteBridgeJournal)
    || !input.currentPolicy || typeof input.currentPolicy !== "object" || types.isProxy(input.currentPolicy)
    || typeof input.currentPolicy.currentAdmissionDigest !== "function"
    || typeof input.currentPolicy.currentServerTrustRevision !== "function"
    || typeof input.currentPolicy.assertCurrent !== "function" || typeof input.clock !== "function") unavailable();
  const bridge = input.bridge, journal = input.journal;
  const policy = Object.freeze({
    currentAdmissionDigest: input.currentPolicy.currentAdmissionDigest.bind(input.currentPolicy),
    currentServerTrustRevision: input.currentPolicy.currentServerTrustRevision.bind(input.currentPolicy),
    assertCurrent: input.currentPolicy.assertCurrent.bind(input.currentPolicy),
  });
  const clock = input.clock.bind(input);
  const mintedQueueSessions = new Set<string>();

  return Object.freeze({
    schema: PRIVATE_CODEX_SESSION_OWNER_V1,
    startsWork: false as const,
    mint(queueId: string) {
      try {
        localId.parse(queueId);
        const channel = bridge.codexActivationChannel();
        if (!channel) return unavailable();
        if (channel.grantsExecutionAuthority !== false) return unavailable();
        const delivery = journal.acceptedCodexDelivery(queueId);
        const activation = journal.acceptedCodexActivation(queueId);
        if (!delivery) return unavailable();
        if (!activation) return unavailable();
        const start = delivery.frame.body.start;
        const assertCurrent = () => {
          channel.assertCurrent();
          const now = clock();
          if (!Number.isSafeInteger(now) || now < Date.parse(activation.frame.sentAt)
            || now >= Date.parse(activation.frame.expiresAt)) unavailable();
          assertSynchronousFence(() => policy.assertCurrent(queueId), unavailable);
          if (policy.currentAdmissionDigest(queueId) !== activation.frame.body.currentAdmissionDigest) unavailable();
        };
        assertCurrent();
        const trustRevision = policy.currentServerTrustRevision();
        localId.parse(trustRevision);
        if (channel.tenantId !== start.tenantId || channel.nodeId !== start.nodeId
          || activation.frame.tenantId !== start.tenantId || activation.frame.body.nodeId !== start.nodeId
          || activation.frame.connectionId !== channel.connectionId
          || channel.grantsExecutionAuthority !== false) unavailable();
        // The activation journal's integrity reader performs the exact
        // signed dispatch/receipt/activation recheck. Do not manufacture an
        // alternate receipt object at this outer boundary.
        const binding = Object.freeze({ tenantId: start.tenantId, nodeId: start.nodeId,
          enrollmentDigest: start.enrollmentDigest, connectorProfileDigest: start.connectorProfileDigest,
          sessionIdentityDigest: sha256Digest({ schema: "control-room.private-codex-session-binding/v1",
            tenantId: start.tenantId, nodeId: start.nodeId, queueId, connectionId: channel.connectionId,
            activationFrameDigest: sha256Digest(activation.frame), dispatchFrameDigest: sha256Digest(delivery.frame),
            trustRevision }) });
        // This is deliberately burned before the capability leaves this
        // closure. A lost, unused, or later-invalid capability is inspect-only
        // evidence; it never earns a second mint for this queue/session.
        const mintKey = sha256Digest({ tenantId: start.tenantId, nodeId: start.nodeId,
          queueId, connectionId: channel.connectionId, activationFrameDigest: sha256Digest(activation.frame) });
        if (mintedQueueSessions.has(mintKey)) unavailable();
        mintedQueueSessions.add(mintKey);
        const capability = Object.freeze({ schema: PRIVATE_CODEX_SESSION_CAPABILITY_V1 });
        capabilities.set(capability, Object.freeze({ ...binding, assertCurrent: () => {
          assertCurrent();
          if (policy.currentServerTrustRevision() !== trustRevision) unavailable();
        } }));
        return Object.freeze({ schema: PRIVATE_CODEX_SESSION_CAPABILITY_V1, capability, binding });
      } catch { return unavailable(); }
    },
  });
}

/** Private node-entry composition consumes a minted capability once. */
export function consumePrivateCodexSessionCapabilityV1(value: unknown): BoundSession {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || (value as { schema?: unknown }).schema !== PRIVATE_CODEX_SESSION_CAPABILITY_V1) unavailable();
  const capability = value as PrivateCodexSessionCapabilityV1;
  const bound = capabilities.get(capability) ?? unavailable();
  if (!capabilities.delete(capability)) unavailable();
  return bound;
}
