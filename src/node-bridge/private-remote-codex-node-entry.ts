import { types } from "node:util";
import { digestSchema, localId } from "../harness/v1/native-run-identifiers";
import { assertSynchronousFence } from "../security/synchronous-fence";
import { createCodexWorkerCompositionV1, type CodexWorkerCompositionInputV1 } from "./codex-worker-composition";

/**
 * Private, installation-owned node entry for the first remote Codex worker.
 * A task, browser, or ordinary configuration reader cannot supply its own
 * process ports: only an installation composition may first seal them behind
 * this one-use, in-memory capability.
 */
export const PRIVATE_REMOTE_CODEX_NODE_ENTRY_V1 =
  "control-room.private-remote-codex-node-entry/v1" as const;
export const PRIVATE_REMOTE_CODEX_NODE_ENTRY_CAPABILITY_V1 =
  "control-room.private-remote-codex-node-entry-capability/v1" as const;

const unavailable = (): never => { throw new Error("private_remote_codex_node_entry_unavailable"); };

export type PrivateRemoteCodexAuthenticatedSessionV1 = Readonly<{
  snapshot: Readonly<{
    tenantId: string;
    nodeId: string;
    enrollmentDigest: string;
    connectorProfileDigest: string;
    sessionIdentityDigest: string;
  }>;
  /** Installation session fence: it must reject a revoked/changed enrollment. */
  assertEnrollmentAndRevocationCurrent(): void;
}>;

export type PrivateRemoteCodexNodeEntryBindingV1 = Readonly<{
  /** Supplied only by the authenticated private node session owner. */
  session: PrivateRemoteCodexAuthenticatedSessionV1;
  /** Supplied only by the existing private Codex installer composition. */
  composition: CodexWorkerCompositionInputV1;
}>;

export type PrivateRemoteCodexNodeEntryCapabilityV1 = Readonly<{
  schema: typeof PRIVATE_REMOTE_CODEX_NODE_ENTRY_CAPABILITY_V1;
}>;

const capabilities = new WeakMap<object, Readonly<{
  worker: ReturnType<typeof createCodexWorkerCompositionV1>;
}>>();

function captureSession(value: PrivateRemoteCodexAuthenticatedSessionV1): Readonly<{
  tenantId: string; nodeId: string; enrollmentDigest: string;
  connectorProfileDigest: string; sessionIdentityDigest: string;
  assertCurrent: () => void;
}> {
  const session = value;
  if (!session || typeof session !== "object" || types.isProxy(session)
    || !session.snapshot || typeof session.snapshot !== "object" || types.isProxy(session.snapshot)
    || typeof session.assertEnrollmentAndRevocationCurrent !== "function") unavailable();
  const snapshot = session.snapshot;
  try {
    localId.parse(snapshot.tenantId); localId.parse(snapshot.nodeId);
    digestSchema.parse(snapshot.enrollmentDigest); digestSchema.parse(snapshot.connectorProfileDigest);
    digestSchema.parse(snapshot.sessionIdentityDigest);
  } catch { unavailable(); }
  const assertCurrent = session.assertEnrollmentAndRevocationCurrent.bind(session);
  assertSynchronousFence(assertCurrent, unavailable);
  return Object.freeze({ tenantId: snapshot.tenantId, nodeId: snapshot.nodeId,
    enrollmentDigest: snapshot.enrollmentDigest, connectorProfileDigest: snapshot.connectorProfileDigest,
    sessionIdentityDigest: snapshot.sessionIdentityDigest, assertCurrent });
}

/**
 * The private installer seals its already-open authenticated-session snapshot
 * and existing Codex composition. It performs no I/O, process acquisition,
 * network connection, or task start. The returned capability is opaque and
 * can be consumed once by the node launcher; it is not task/browser input.
 */
export function createPrivateRemoteCodexNodeEntryCapabilityV1(
  value: PrivateRemoteCodexNodeEntryBindingV1,
): Readonly<{ schema: typeof PRIVATE_REMOTE_CODEX_NODE_ENTRY_V1; startsWork: false;
  capability: PrivateRemoteCodexNodeEntryCapabilityV1 }> {
  const session = captureSession(value.session);
  const composition = value.composition;
  const binding = composition?.binding;
  if (!binding || binding.tenantId !== session.tenantId || binding.nodeId !== session.nodeId
    || binding.enrollmentDigest !== session.enrollmentDigest
    || binding.connectorProfileDigest !== session.connectorProfileDigest
    || binding.sessionIdentityDigest !== session.sessionIdentityDigest
    || !digestSchema.safeParse(binding.activationFrameDigest).success
    || typeof composition.assertSessionCurrent !== "function") unavailable();
  const compositionCurrent = composition.assertSessionCurrent.bind(composition);
  const worker = createCodexWorkerCompositionV1({ ...composition,
    binding: Object.freeze({ ...binding }),
    assertSessionCurrent() {
      assertSynchronousFence(session.assertCurrent, unavailable);
      assertSynchronousFence(compositionCurrent, unavailable);
    },
  });
  const capability = Object.freeze({ schema: PRIVATE_REMOTE_CODEX_NODE_ENTRY_CAPABILITY_V1 });
  capabilities.set(capability, Object.freeze({ worker }));
  return Object.freeze({ schema: PRIVATE_REMOTE_CODEX_NODE_ENTRY_V1, startsWork: false as const, capability });
}

/**
 * Consume an installation/session-owned capability. Raw composition, paths,
 * credentials, callbacks, and browser-selected settings are rejected: the
 * launcher receives only the opaque object from the private installer.
 */
export function createPrivateRemoteCodexNodeEntryV1(value: unknown) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || (value as { schema?: unknown }).schema !== PRIVATE_REMOTE_CODEX_NODE_ENTRY_CAPABILITY_V1) unavailable();
  const capability = value as PrivateRemoteCodexNodeEntryCapabilityV1;
  const bound = capabilities.get(capability) ?? unavailable();
  if (!capabilities.delete(capability)) unavailable();
  return Object.freeze({
    schema: PRIVATE_REMOTE_CODEX_NODE_ENTRY_V1,
    startsWork: false as const,
    grantsExecutionAuthority: false as const,
    async start(signal: AbortSignal) { return bound.worker.start(signal); },
    async recoverAndReturn(signal: AbortSignal) { return bound.worker.recoverAndReturn(signal); },
    async close() { await bound.worker.close(); },
  });
}
