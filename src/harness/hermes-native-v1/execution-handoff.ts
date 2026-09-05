import { sha256Digest } from "../../security";
import { verifyNodeFrameSignature } from "../../node-protocol/v1";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import { prepareNativeTaskDispatchIntake } from "../v1/native-delivery";
import { createNativeApprovalIntake } from "../v1/native-approval-intake";
import type { ServerTrustStore } from "../../node-policy/v1/stores";
import { createNativeStartAuthority, type NativeStartAuthorityDependencies } from "./start-authority";
import { HermesNativeRunAdapter } from "./adapter";
import type { NativeRunJournal, NativeRunTransport } from "./contracts";

type Trust = Parameters<typeof createNativeApprovalIntake>[1];
type Dependencies = {
  deliveries: Pick<SqliteBridgeJournal, "acceptedNativeDelivery">;
  runs: NativeRunJournal;
  approvals: Trust["approvals"];
  security: Trust["security"] & Pick<ServerTrustStore, "resolveServerKey">;
  local: NativeStartAuthorityDependencies;
  transport: NativeRunTransport;
  clock: () => number;
};

/** Inert supplied-resource composition. Preparation performs no provider calls or native journal
 * reservation. Calling start uses the existing adapter/controller, including durable no-restart rules.
 * This is node-private code, not a browser operation or deployment bootstrap. */
export async function prepareNativeExecutionHandoff(config: { queueId: string; enrollment: unknown; serverActorId: string },
  dependencies: Dependencies, signal: AbortSignal) {
  const load = dependencies.deliveries.acceptedNativeDelivery.bind(dependencies.deliveries);
  const revision = dependencies.security.currentServerTrustRevision.bind(dependencies.security);
  const resolve = dependencies.security.resolveServerKey.bind(dependencies.security);
  const clock = dependencies.clock;
  const approvals = dependencies.approvals, runs = dependencies.runs, transport = dependencies.transport;
  const local = { ...dependencies.local };
  const security = { currentServerTrustRevision: revision };
  const queueId = config.queueId, actor = config.serverActorId;
  const saved = load(queueId);
  if (!saved || !actor || saved.frame.actorId !== actor) throw new Error("native_handoff_unavailable");
  const material = prepareNativeTaskDispatchIntake(saved.frame.body, config.enrollment);
  const digest = sha256Digest(saved), before = revision();
  let closed = false, highWater = -1;
  const assertCurrent = () => {
    const now = clock();
    if (closed || signal.aborted || !Number.isSafeInteger(now) || now < highWater || now < Date.parse(saved.receipt.recordedAt)
      || now >= Date.parse(saved.frame.expiresAt) || revision() !== before || sha256Digest(load(queueId)) !== digest)
      throw new Error("native_handoff_unavailable");
    highWater = now;
  };
  assertCurrent();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  let verified: Awaited<ReturnType<ReturnType<typeof createNativeApprovalIntake>>>;
  try {
    verified = await Promise.race([(async () => {
      const key = await resolve(saved.frame.keyId);
      assertCurrent();
      if (controller.signal.aborted || !key || saved.frame.bodyDigest !== sha256Digest(saved.frame.body)
        || !verifyNodeFrameSignature(saved.frame, Buffer.from(key).toString("base64url"))) throw new Error("native_handoff_unavailable");
      return createNativeApprovalIntake(material, { approvals, security, clock })(material.packet, controller.signal);
    })(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { closed = true; controller.abort(); reject(new Error("native_handoff_uncertain")); }, 5000);
    })]);
    assertCurrent(); verified.assertFresh();
  } catch { closed = true; throw new Error("native_handoff_unavailable"); }
  finally { if (timer) clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); }
  const guard = () => { assertCurrent(); verified.assertFresh(); };
  const read = local.readCurrent.bind(local);
  const authority = createNativeStartAuthority(verified, { ...local, clock, async readCurrent(cancel) {
    guard(); const policy = await read(cancel); guard();
    const policyFresh = policy.assertFresh;
    return { ...policy, assertFresh: () => { policyFresh?.(); guard(); } };
  } });
  const adapter = new HermesNativeRunAdapter(verified.enrollment, runs, authority.authority, transport, clock);
  const runId = verified.binding.runId;
  return Object.freeze({ queueId, runId,
    start: () => { guard(); return adapter.start(verified.start); },
    poll: () => { guard(); return adapter.poll(runId); },
    observe: () => { guard(); return adapter.observe(runId); },
    snapshot: () => adapter.snapshot(runId),
    close: () => { closed = true; authority.close(); },
    // Closing is not a physical stop; separately signed recovery remains required.
  });
}
