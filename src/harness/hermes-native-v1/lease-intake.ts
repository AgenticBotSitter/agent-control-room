import { normalizedLocalPolicyRequestSchema } from "../../node-policy/v1/schemas";
import type { ServerTrustStore } from "../../node-policy/v1/stores";
import type { SqliteNodeSecurityStateRepository } from "../../node-policy/v1/persistent-security-state";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import { signedNodeFrameSchema, verifyNodeFrameSignature } from "../../node-protocol/v1";
import { assertAuthorityDigest } from "../../security";
import { localId } from "./contracts";
import type { BridgeCommandHandler } from "../../node-bridge/admission-handler";
import type { NativeDeliveryChannel } from "../../node-bridge/bridge";

const fail = (): never => { throw new Error("native_lease_intake_unavailable"); };

/** One exact task/channel intake, after authenticated replay consumption. No lease
 * producer, execution permission, renewal, connection opening or runtime wiring.
 * The task fence belongs to the owner of the already-verified task dispatch. */
export function createNativeLeaseIntake(config: { request: unknown; serverActorId: string;
  serverKeyId: string; serverPublicKeySpki: string; connectionId: string }, deps: {
  journal: Pick<SqliteBridgeJournal, "recordInitialLease">;
  trust: Pick<ServerTrustStore, "resolveServerKey"> & Pick<SqliteNodeSecurityStateRepository, "currentServerTrustRevision">;
  assertTaskCurrent: () => true; clock: () => number;
}) {
  const request = normalizedLocalPolicyRequestSchema.parse(config.request);
  const actor = localId.parse(config.serverActorId), keyId = localId.parse(config.serverKeyId);
  const connectionId = localId.parse(config.connectionId), spki = config.serverPublicKeySpki;
  if (request.operationId !== "harness.hermes.native.start" || typeof spki !== "string" || spki.length < 16 || spki.length > 4096) return fail();
  const record = deps.journal.recordInitialLease.bind(deps.journal), resolve = deps.trust.resolveServerKey.bind(deps.trust);
  const revision = deps.trust.currentServerTrustRevision.bind(deps.trust), initialRevision = revision();
  const task = deps.assertTaskCurrent.bind(deps), clock = deps.clock.bind(deps);
  let closed = false, busy = false, highWater = -1;
  const close = () => { closed = true; };
  return Object.freeze({ close, grantsExecutionAuthority: false as const,
    async accept(input: unknown, receivedAt: string, signal: AbortSignal) {
      if (closed || busy || !(signal instanceof AbortSignal)) { close(); return fail(); }
      busy = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      try {
        const frame = signedNodeFrameSchema.parse(input), received = Date.parse(receivedAt);
        if (frame.type !== "job.lease.grant" || frame.direction !== "server_to_node" || frame.senderKind !== "control_room"
          || frame.tenantId !== request.tenantId || frame.actorId !== actor || frame.keyId !== keyId || frame.connectionId !== connectionId
          || !Number.isFinite(received) || !verifyNodeFrameSignature(frame, spki)) return fail();
        const grant = frame.body;
        if (grant.nodeId !== request.nodeId || grant.jobId !== request.jobId || grant.attemptId !== request.attemptId
          || grant.leaseId !== request.leaseId || grant.leaseEpoch !== request.leaseEpoch
          || grant.authorityDigest !== request.authorityDigest || grant.authority.digest !== grant.authorityDigest
          || grant.authority.projectId !== request.projectId) return fail();
        assertAuthorityDigest(grant.authority);
        const tick = () => {
          const observedRevision = revision();
          const now = clock();
          if (closed || signal.aborted || performance.now() - started >= 5000 || observedRevision !== initialRevision
            || !Number.isSafeInteger(now) || now < 0 || now < highWater || now < received
            || now < Date.parse(grant.acquiredAt) || now >= Date.parse(grant.expiresAt)
            || now >= Date.parse(grant.authority.expiresAt) || now >= Date.parse(frame.expiresAt)) return fail();
          highWater = now;
        };
        const current = (): true => {
          tick();
          const result: unknown = task();
          if (result !== true) { if (result instanceof Promise) void result.catch(() => {}); return fail(); }
          // A slow synchronous task fence may cross the deadline before timers run.
          tick();
          return true;
        };
        current();
        const key = await Promise.race([resolve(keyId), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { close(); reject(new Error("native_lease_intake_unavailable")); }, 5000);
        })]);
        current();
        if (!key || Buffer.from(key).toString("base64url") !== spki) return fail();
        const disposition = record(frame, receivedAt, current);
        return Object.freeze({ disposition, messageId: frame.messageId, grantsExecutionAuthority: false as const });
      } catch { close(); return fail(); }
      finally { busy = false; if (timer) clearTimeout(timer); }
    },
  });
}

/** Adapter for the existing authenticated PortableNodeBridge command path. The
 * enclosing task owner supplies the exact request and current dispatch fence.
 * Does not select tasks or enable the native runtime's receive allowlist. */
export function createNativeLeaseCommandHandler(
  config: Omit<Parameters<typeof createNativeLeaseIntake>[0], "connectionId">,
  dependencies: Parameters<typeof createNativeLeaseIntake>[1] & { channel: () => NativeDeliveryChannel | undefined },
): BridgeCommandHandler & { close(): void } {
  const captured = { ...config, request: normalizedLocalPolicyRequestSchema.parse(config.request) };
  const channel = dependencies.channel.bind(dependencies), task = dependencies.assertTaskCurrent.bind(dependencies);
  const deps = { journal: { recordInitialLease: dependencies.journal.recordInitialLease.bind(dependencies.journal) },
    trust: { resolveServerKey: dependencies.trust.resolveServerKey.bind(dependencies.trust),
      currentServerTrustRevision: dependencies.trust.currentServerTrustRevision.bind(dependencies.trust) }, clock: dependencies.clock.bind(dependencies) };
  const lifetime = new AbortController();
  let intake: ReturnType<typeof createNativeLeaseIntake> | undefined, boundConnection: string | undefined;
  const close = () => { lifetime.abort(); intake?.close(); };
  return Object.freeze({ close, async handle(frame: Parameters<BridgeCommandHandler["handle"]>[0], receivedAt: string) {
    if (lifetime.signal.aborted) return fail();
    try {
      frame = signedNodeFrameSchema.parse(frame);
      if (frame.type !== "job.lease.grant") return false;
      const active = channel();
      if (!active || active.tenantId !== captured.request.tenantId || active.nodeId !== captured.request.nodeId
        || frame.connectionId !== active.connectionId || boundConnection !== undefined && boundConnection !== active.connectionId) return fail();
      active.assertCurrent();
      if (!intake) {
        boundConnection = active.connectionId;
        intake = createNativeLeaseIntake({ ...captured, connectionId: active.connectionId }, { ...deps,
          assertTaskCurrent: () => { active.assertCurrent(); const result = task(); active.assertCurrent(); return result; } });
      }
      await intake.accept(frame, receivedAt, lifetime.signal);
      active.assertCurrent(); return true;
    } catch { close(); return fail(); }
  } });
}
