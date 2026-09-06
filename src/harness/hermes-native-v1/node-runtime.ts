import { z } from "zod";
import { PortableNodeBridge, type BridgeFrameSigner, type BridgeTransport } from "../../node-bridge/bridge";
import { NativeDispatchIntakeHandler } from "../../node-bridge/native-dispatch-handler";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import { NATIVE_DELIVERY_FEATURE, matchNativeTaskDispatchReceipt, prepareNativeTaskDispatchIntake } from "../v1/native-delivery";
import { signedNodeFrameSchema, verifyNodeFrameSignature, type NodeProtocolAuthenticator } from "../../node-protocol/v1";
import { sha256Digest } from "../../security";
import { enrollmentSchema, localId, type NativeRunTransport, type NativeWireRequest } from "./contracts";
import { prepareNativeExecutionHandoff } from "./execution-handoff";
import { NativeObservationReporter } from "./observation-reporter";
import { createNativeRecoveryAuthority, type NativeRecoveryDependencies } from "./recovery-authority";
import { HermesNativeRunAdapter } from "./adapter";
import { verifyNativeTaskApprovalBinding } from "../v1/native-task-approval-binding";

const configuration = z.object({ queueId: localId, enrollment: enrollmentSchema, nodeKeyId: localId,
  serverId: localId, serverKeyId: localId, serverPublicKeySpki: z.string().min(16).max(4096) }).strict();
export type NativeNodeRuntimeConfiguration = z.input<typeof configuration>;
type Handoff = Awaited<ReturnType<typeof prepareNativeExecutionHandoff>>;
type HandoffDependencies = Parameters<typeof prepareNativeExecutionHandoff>[1];
export type NativeNodeRuntimeDependencies = Omit<HandoffDependencies, "deliveries" | "reporting" | "recovery"> & {
  journal: SqliteBridgeJournal;
  signer: BridgeFrameSigner;
  serverAuthenticator: NodeProtocolAuthenticator;
  recovery: Omit<NativeRecoveryDependencies, "journal" | "effects" | "executions" | "clock">;
};
const fail = (): never => { throw new Error("native_node_runtime_unavailable"); };

/** Node-private supplied-resource owner. No listener, journal opening, credential lookup,
 * scheduling or implicit execution. Supplied journals remain owned by the host. */
export function createNativeNodeRuntime(input: NativeNodeRuntimeConfiguration, dependencies: NativeNodeRuntimeDependencies) {
  const config = configuration.parse(input), clock = dependencies.clock.bind(dependencies);
  const journal = dependencies.journal, runs = dependencies.runs;
  const revision = dependencies.security.currentServerTrustRevision.bind(dependencies.security), trustRevision = revision();
  const resolve = dependencies.security.resolveServerKey.bind(dependencies.security);
  const lifetime = new AbortController(), pending = new Set<Promise<unknown>>();
  let closed = false, closing: Promise<void> | undefined, highWater = -1, nativeBusy = false;
  let handoff: Handoff | undefined, recovery: ReturnType<typeof createNativeRecoveryAuthority> | undefined;
  let recoveryAdapter: HermesNativeRunAdapter | undefined, recoveryRunId: string | undefined;
  let recoveryDeliveryDigest: string | undefined;
  let operation: { kind: string; cancel: AbortController; interrupted: boolean; settled: Promise<void> } | undefined;
  const current = () => {
    const now = clock();
    if (closed || lifetime.signal.aborted || revision() !== trustRevision || !Number.isSafeInteger(now) || now < 0 || now < highWater) return fail();
    highWater = now; return now;
  };
  const recoveryDependencies: NativeRecoveryDependencies = { ...dependencies.recovery, clock, journal: runs,
    effects: dependencies.local.effects, executions: dependencies.local.executions,
    readCurrent: async signal => { current(); const value = await readRecovery(signal); current(); return value; },
    assertProfileCurrent: async (enrollment, now, signal) => {
      current(); const check = await profileRecovery(enrollment, now, signal); current();
      return () => { current(); check?.(); };
    },
  };
  const readRecovery = dependencies.recovery.readCurrent.bind(dependencies.recovery);
  const profileRecovery = dependencies.recovery.assertProfileCurrent.bind(dependencies.recovery);
  const intake = new NativeDispatchIntakeHandler(config.enrollment, journal,
    { approvals: dependencies.approvals, security: { currentServerTrustRevision: revision } }, current);
  const sign = dependencies.signer.sign.bind(dependencies.signer);
  const bridge = new PortableNodeBridge({ tenantId: config.enrollment.tenantId, nodeId: config.enrollment.nodeId,
    keyId: config.nodeKeyId, features: [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"] }, journal,
  { sign: async frame => { current(); const result = await sign(frame); current(); return result; } },
  dependencies.serverAuthenticator, undefined, undefined, intake);
  const reporter = new NativeObservationReporter({ queueId: config.queueId, enrollment: config.enrollment,
    serverId: config.serverId, serverKeyId: config.serverKeyId, serverPublicKeySpki: config.serverPublicKeySpki },
  { deliveries: journal, runs, bridge, clock, assertAvailable: current });

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  function bounded<T>(work: () => Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
    current(); if (!(signal instanceof AbortSignal) || signal.aborted) return Promise.reject(new Error("native_node_runtime_unavailable"));
    let timer: ReturnType<typeof setTimeout> | undefined, rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const abort = () => { rejectCancelled(new Error("native_node_runtime_uncertain")); void close().catch(() => {}); };
    const stopped = () => rejectCancelled(new Error("native_node_runtime_uncertain"));
    signal.addEventListener("abort", abort, { once: true }); lifetime.signal.addEventListener("abort", stopped, { once: true });
    timer = setTimeout(abort, milliseconds);
    const active = track(Promise.resolve().then(() => { current(); return work(); }).then(value => { current(); return value; }));
    return Promise.race([active, cancelled]).finally(() => {
      clearTimeout(timer); signal.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", stopped);
    });
  }
  const json = dependencies.transport.json.bind(dependencies.transport), events = dependencies.transport.events.bind(dependencies.transport);
  async function nativeRequest<T>(request: NativeWireRequest, work: (owned: NativeWireRequest) => Promise<T>) {
    current(); const cancel = new AbortController();
    const operationSignal = operation?.cancel.signal;
    const abort = () => cancel.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true }); request.signal?.addEventListener("abort", abort, { once: true });
    operationSignal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted || operationSignal?.aborted) cancel.abort();
    let rejectStopped!: (reason: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const stop = () => rejectStopped(new Error("native_node_runtime_uncertain"));
    cancel.signal.addEventListener("abort", stop, { once: true });
    try {
      if (cancel.signal.aborted) return fail();
      const owned = { ...request, signal: cancel.signal, authorize: async () => {
        current(); if (cancel.signal.aborted) return fail(); await request.authorize(); current(); if (cancel.signal.aborted) return fail();
      } };
      const result = await Promise.race([work(owned), stopped]); current(); return result;
    } finally { cancel.abort(); lifetime.signal.removeEventListener("abort", abort); request.signal?.removeEventListener("abort", abort);
      operationSignal?.removeEventListener("abort", abort); }
  }
  const nativeTransport: NativeRunTransport = {
    json: request => nativeRequest(request, json),
    events: (request, receive) => nativeRequest(request, owned => events(owned, chunk => {
      current(); if (owned.signal?.aborted) return fail(); receive(chunk);
    })),
  };
  const readLocal = dependencies.local.readCurrent.bind(dependencies.local), profileLocal = dependencies.local.assertProfileCurrent.bind(dependencies.local);
  const local = { ...dependencies.local, clock,
    readCurrent: async (signal: AbortSignal) => { current(); const value = await readLocal(signal); current(); return value; },
    assertProfileCurrent: async (...args: Parameters<typeof profileLocal>) => {
      current(); const check = await profileLocal(...args); current(); return () => { current(); check?.(); };
    },
  };
  const approvals = dependencies.approvals;
  async function prepared() {
    if (!handoff) handoff = await prepareNativeExecutionHandoff({ queueId: config.queueId, enrollment: config.enrollment,
      serverActorId: config.serverId }, { deliveries: journal, runs, approvals,
      security: { currentServerTrustRevision: revision, resolveServerKey: resolve }, local, transport: nativeTransport,
      clock, recovery: recoveryDependencies }, lifetime.signal);
    current(); return handoff;
  }
  function recover() {
    current(); const saved = journal.acceptedNativeDelivery(config.queueId); if (!saved) return fail();
    const frame = signedNodeFrameSchema.parse(saved.frame);
    if (frame.type !== "harness.native.dispatch" || frame.actorId !== config.serverId || frame.keyId !== config.serverKeyId
      || !verifyNodeFrameSignature(frame, config.serverPublicKeySpki)) return fail();
    matchNativeTaskDispatchReceipt(saved.receipt, frame);
    const material = prepareNativeTaskDispatchIntake(frame.body, config.enrollment);
    const { binding } = verifyNativeTaskApprovalBinding(material.enrollment, material.request, material.start);
    const digest = sha256Digest(saved);
    if (recoveryDeliveryDigest !== undefined && digest !== recoveryDeliveryDigest) return fail();
    if (!recovery) {
      recovery = createNativeRecoveryAuthority({ enrollment: material.enrollment, binding,
        permission: material.packet.recovery }, recoveryDependencies);
      recoveryAdapter = new HermesNativeRunAdapter(material.enrollment, runs, recovery.authority, nativeTransport, clock);
      recoveryRunId = binding.runId; recoveryDeliveryDigest = digest;
    }
    return { adapter: recoveryAdapter!, runId: recoveryRunId! };
  }
  async function native<T>(kind: string, signal: AbortSignal, work: () => Promise<T>) {
    current(); if (nativeBusy) return fail(); nativeBusy = true;
    let finish!: () => void;
    const active = { kind, cancel: new AbortController(), interrupted: false, settled: new Promise<void>(resolve => { finish = resolve; }) };
    operation = active;
    try {
      const result = await bounded(work, signal, 45_000);
      if (active.interrupted) throw new Error("native_node_observation_interrupted");
      return result;
    } catch {
      if (!active.interrupted) void close().catch(() => {});
      throw new Error(active.interrupted ? "native_node_observation_interrupted" : "native_node_runtime_uncertain");
    } finally { active.cancel.abort(); operation = undefined; nativeBusy = false; finish(); }
  }
  async function publish<T>(result: T): Promise<T> {
    current(); if (!operation?.interrupted) await reporter.report(lifetime.signal); return result;
  }
  let wireTail: Promise<unknown> = Promise.resolve(), wireCount = 0, wireBytes = 0;
  function wire<T>(bytes: number, signal: AbortSignal, work: () => Promise<T>) {
    try { current(); if (wireCount >= 16 || wireBytes + bytes > 1_048_576) return fail(); }
    catch { void close().catch(() => {}); return Promise.reject(new Error("native_node_runtime_uncertain")); }
    wireCount++; wireBytes += bytes;
    // Capture the previous tail before publishing this operation as the new tail.
    const previous = wireTail;
    const active = bounded(async () => { await previous; current(); return work(); }, signal, 10_000)
      .catch(error => { void close().catch(() => {}); throw error; });
    wireTail = active.catch(() => {});
    return active.finally(() => { wireCount--; wireBytes -= bytes; });
  }
  const transports = new WeakSet<object>();
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; lifetime.abort(); intake.close(); handoff?.close(); recovery?.close(); reporter.close();
    const cleanup = bridge.close();
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([cleanup, Promise.allSettled([...pending])]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native_node_runtime_close_uncertain")), 10_000);
      })]); }
      finally { clearTimeout(timer); }
    })();
    return closing;
  }
  return Object.freeze({ nodeId: config.enrollment.nodeId, queueId: config.queueId, grantsExecutionAuthority: false as const,
    open(transport: BridgeTransport, transportIdentity: string, signal: AbortSignal) {
      current(); localId.parse(transportIdentity);
      if (!transport || transports.has(transport) || typeof transport.send !== "function" || typeof transport.close !== "function") return fail();
      transports.add(transport); const send = transport.send.bind(transport), dispose = transport.close.bind(transport);
      let closingTransport: Promise<void> | undefined;
      return wire(0, signal, () => bridge.open({ send: async raw => { current(); await send(raw); current(); },
        close: () => closingTransport ??= Promise.resolve().then(dispose) }, { now: new Date(current()).toISOString(), transportIdentity }));
    },
    receive(raw: string | Uint8Array, signal: AbortSignal) {
      let frame: z.infer<typeof signedNodeFrameSchema>, copy: string | Uint8Array, size: number;
      try {
        current(); if (typeof raw !== "string" && !(raw instanceof Uint8Array)) return fail();
        size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength; if (size > 131_072) return fail();
        copy = typeof raw === "string" ? raw : Uint8Array.from(raw);
        frame = signedNodeFrameSchema.parse(JSON.parse(typeof copy === "string" ? copy : Buffer.from(copy).toString("utf8")));
        if (!["connection.accepted", "node.reconciliation.request", "protocol.ack", "harness.native.dispatch"].includes(frame.type)
          || frame.direction !== "server_to_node" || frame.actorId !== config.serverId || frame.keyId !== config.serverKeyId
          || !verifyNodeFrameSignature(frame, config.serverPublicKeySpki)
          || frame.type === "harness.native.dispatch" && frame.body.queueId !== config.queueId) return fail();
      } catch { void close().catch(() => {}); return Promise.reject(new Error("native_node_runtime_uncertain")); }
      return wire(size, signal, () => bridge.receive(copy, new Date(current()).toISOString()));
    },
    disconnected(signal: AbortSignal) { return wire(0, signal, () => bridge.disconnected()); },
    start(signal: AbortSignal) { return native("start", signal, async () => {
      bridge.nativeDeliveryChannel()?.assertCurrent(); if (!bridge.nativeDeliveryChannel()) return fail();
      return publish(await (await prepared()).start());
    }); },
    observe(signal: AbortSignal) { return native("observe", signal, async () => {
      return publish(await (await prepared()).observe());
    }); },
    poll(signal: AbortSignal) { return native("poll", signal, async () => {
      const value = recover(); return publish(await value.adapter.poll(value.runId));
    }); },
    async stop(signal: AbortSignal) {
      current(); if (!(signal instanceof AbortSignal) || signal.aborted) return fail();
      const prior = operation;
      if (prior && (prior.kind === "observe" || prior.kind === "poll")) {
        prior.interrupted = true; prior.cancel.abort(); await bounded(() => prior.settled, signal, 10_000);
      }
      return native("stop", signal, async () => { const value = recover(); return publish(await value.adapter.stop(value.runId)); });
    },
    report(signal: AbortSignal) { return native("report", signal, () => reporter.report(signal)); },
    readResult: reporter.readResult.bind(reporter),
    close,
  });
}
