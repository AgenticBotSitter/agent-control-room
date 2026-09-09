import { z } from "zod";
import { PortableNodeBridge, type BridgeFrameSigner, type BridgeTransport } from "../../node-bridge/bridge";
import { NativeDispatchIntakeHandler } from "../../node-bridge/native-dispatch-handler";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import { NATIVE_DELIVERY_FEATURE, NATIVE_LEASE_DELIVERY_FEATURE, matchNativeTaskDispatchReceipt, prepareNativeTaskDispatchIntake } from "../v1/native-delivery";
import { signedNodeFrameSchema, verifyNodeFrameSignature, type NodeProtocolAuthenticator } from "../../node-protocol/v1";
import { sha256Digest } from "../../security";
import { enrollmentSchema, localId, type NativeRunTransport, type NativeWireRequest } from "./contracts";
import { prepareNativeExecutionHandoff } from "./execution-handoff";
import { NativeObservationReporter } from "./observation-reporter";
import { createNativeRecoveryAuthority, type NativeRecoveryDependencies } from "./recovery-authority";
import { HermesNativeRunAdapter } from "./adapter";
import { verifyNativeTaskApprovalBinding } from "../v1/native-task-approval-binding";
import { encodeNativeWire, decodeNativeWire } from "../v1/native-wire";
import { createNativeCurrentPolicy } from "./current-policy";
import { createNativeLeaseCommandHandler } from "./lease-intake";
import { assertNativeLeaseDispatchPair } from "../v1/native-lease-dispatch-pair";
import type { BridgeCommandHandler } from "../../node-bridge/admission-handler";
import { readNativeRestartInventory } from "./restart-inventory";

const configuration = z.object({ queueId: localId, enrollment: enrollmentSchema, nodeKeyId: localId,
  serverId: localId, serverKeyId: localId, serverPublicKeySpki: z.string().min(16).max(4096) }).strict();
export type NativeNodeRuntimeConfiguration = z.input<typeof configuration>;
export const validateNativeNodeRuntimeConfiguration = (input: unknown) => configuration.parse(input);
const unassignedConfiguration = configuration.omit({ queueId: true }).extend({ assignment: z.literal("queue") }).strict();
export type UnassignedNativeNodeRuntimeConfiguration = z.input<typeof unassignedConfiguration>;
type Handoff = Awaited<ReturnType<typeof prepareNativeExecutionHandoff>>;
type HandoffDependencies = Parameters<typeof prepareNativeExecutionHandoff>[1];
export type NativeNodeRuntimeDependencies = Omit<HandoffDependencies, "deliveries" | "reporting" | "recovery"> & {
  journal: SqliteBridgeJournal;
  signer: BridgeFrameSigner;
  serverAuthenticator: NodeProtocolAuthenticator;
  recovery: Omit<NativeRecoveryDependencies, "journal" | "effects" | "executions" | "clock">;
};
type PolicyConfiguration = Omit<Parameters<typeof createNativeCurrentPolicy>[0], "request" | "leaseMessageId" | "serverActorId">;
type PolicyResources = Parameters<typeof createNativeCurrentPolicy>[1];
type RestartResources = Parameters<typeof readNativeRestartInventory>[1];
export type LeaseAwareNativeNodeRuntimeDependencies = Omit<NativeNodeRuntimeDependencies, "local" | "security" | "runs"> & {
  security: NativeNodeRuntimeDependencies["security"] & PolicyResources["security"];
  runs: NativeNodeRuntimeDependencies["runs"] & RestartResources["runs"];
  local: Omit<NativeNodeRuntimeDependencies["local"], "readCurrent" | "effects" | "executions"> & {
    effects: NativeNodeRuntimeDependencies["local"]["effects"] & PolicyResources["effects"] & RestartResources["effects"];
    executions: NativeNodeRuntimeDependencies["local"]["executions"] & RestartResources["executions"];
  };
  keys: PolicyResources["keys"];
  localPaused: PolicyResources["localPaused"];
};
const fail = (): never => { throw new Error("native_node_runtime_unavailable"); };

/** Node-private supplied-resource owner. No listener, journal opening, credential lookup,
 * scheduling or implicit execution. Supplied journals remain owned by the host. */
export function createNativeNodeRuntime(input: NativeNodeRuntimeConfiguration, dependencies: NativeNodeRuntimeDependencies) {
  return createRuntime(configuration.parse(input), dependencies);
}

/** Initial, one-task discovery only. Kept separate from the production fixed-task
 * validator/launcher. Outstanding work must be reconciled before a host chooses this
 * mode; this factory does not supply that lifecycle or authorize native execution. */
export function createUnassignedNativeNodeRuntime(input: UnassignedNativeNodeRuntimeConfiguration, dependencies: NativeNodeRuntimeDependencies) {
  return createRuntime({ ...unassignedConfiguration.parse(input), queueId: undefined }, dependencies);
}

/** Opt-in one-task runtime using the retained canonical lease and existing verified
 * current-policy composition. Does not change fixed launcher defaults or supply a
 * multi-task lifecycle, profile qualification, key availability or native transport. */
export function createLeaseAwareNativeNodeRuntime(input: UnassignedNativeNodeRuntimeConfiguration,
  policy: PolicyConfiguration, dependencies: LeaseAwareNativeNodeRuntimeDependencies) {
  const config = { ...unassignedConfiguration.parse(input), queueId: undefined };
  const policySnapshot = structuredClone(policy);
  // Capture the resource set before any supplied inventory reader can run. The
  // caller may replace its container fields, but not which stores we checked/use.
  dependencies = { ...dependencies, local: { ...dependencies.local }, recovery: { ...dependencies.recovery } };
  // A necessary local refusal gate, not a cross-process reservation. The host
  // must still own its lifecycle exclusively and reconcile canonical server state.
  const retained = readNativeRestartInventory(config.enrollment, { bridge: dependencies.journal, runs: dependencies.runs,
    effects: dependencies.local.effects, executions: dependencies.local.executions }, new AbortController().signal);
  if (retained.status !== "no_unresolved_local_work") throw new Error("native_node_restart_reconciliation_required");
  const security = dependencies.security;
  const capturedSecurity = { resolveServerKey: security.resolveServerKey.bind(security),
    currentServerTrustRevision: security.currentServerTrustRevision.bind(security),
    loadCeiling: security.loadCeiling.bind(security), currentPolicyRevision: security.currentPolicyRevision.bind(security) };
  return createRuntime(config, { ...dependencies, security: capturedSecurity,
    local: { ...dependencies.local, readCurrent: async () => fail() } }, {
    config: policySnapshot, security: capturedSecurity,
    keys: { availability: dependencies.keys.availability.bind(dependencies.keys) },
    effects: { countActive: dependencies.local.effects.countActive.bind(dependencies.local.effects) },
    localPaused: dependencies.localPaused.bind(dependencies),
  });
}

function createRuntime(config: Omit<z.infer<typeof configuration>, "queueId"> & { queueId: string | undefined }, dependencies: NativeNodeRuntimeDependencies,
  leasePolicy?: Pick<PolicyResources, "security" | "keys" | "effects" | "localPaused"> & { config: PolicyConfiguration }) {
  const clock = dependencies.clock.bind(dependencies);
  let boundQueue = config.queueId;
  const queue = () => boundQueue ?? fail();
  const journal = dependencies.journal;
  const leaseJournal = leasePolicy ? Object.freeze({ acceptedCommand: journal.acceptedCommand.bind(journal),
    attemptSummary: journal.attemptSummary.bind(journal), nodeControlState: journal.nodeControlState.bind(journal),
    recordInitialLease: journal.recordInitialLease.bind(journal) }) : undefined;
  const deliveries = Object.freeze({ acceptedNativeDelivery: journal.acceptedNativeDelivery.bind(journal) });
  const runs = Object.freeze({ reserve: dependencies.runs.reserve.bind(dependencies.runs),
    load: dependencies.runs.load.bind(dependencies.runs), update: dependencies.runs.update.bind(dependencies.runs) });
  const source = dependencies.local;
  const stores = {
    admissions: Object.freeze({ record: source.admissions.record.bind(source.admissions), findEquivalent: source.admissions.findEquivalent.bind(source.admissions) }),
    executions: Object.freeze({ create: source.executions.create.bind(source.executions), load: source.executions.load.bind(source.executions), apply: source.executions.apply.bind(source.executions) }),
    effects: Object.freeze({ claim: source.effects.claim.bind(source.effects), load: source.effects.load.bind(source.effects),
      commitPreEffectMarker: source.effects.commitPreEffectMarker.bind(source.effects), recover: source.effects.recover.bind(source.effects) }),
  };
  const revision = dependencies.security.currentServerTrustRevision.bind(dependencies.security), trustRevision = revision();
  const resolve = dependencies.security.resolveServerKey.bind(dependencies.security);
  const lifetime = new AbortController(), pending = new Set<Promise<unknown>>();
  const rawNative = new Set<Promise<unknown>>();
  let closed = false, closing: Promise<void> | undefined, highWater = -1, nativeBusy = false;
  let handoff: Handoff | undefined, recovery: ReturnType<typeof createNativeRecoveryAuthority> | undefined;
  let recoveryAdapter: HermesNativeRunAdapter | undefined, recoveryRunId: string | undefined;
  let recoveryDeliveryDigest: string | undefined;
  let sourceDigest: string | undefined;
  let sourceBindingDigest: string | undefined;
  let operation: { kind: string; cancel: AbortController; interrupted: boolean; settled: Promise<void> } | undefined;
  const current = () => {
    const now = clock();
    if (closed || lifetime.signal.aborted || revision() !== trustRevision || !Number.isSafeInteger(now) || now < 0 || now < highWater) return fail();
    highWater = now; return now;
  };
  const recoveryDependencies: NativeRecoveryDependencies = { ...dependencies.recovery, clock, journal: runs,
    effects: stores.effects, executions: stores.executions,
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
  let leaseHandler: ReturnType<typeof createNativeLeaseCommandHandler> | undefined;
  let leaseIdentity: { messageId: string; digest: string } | undefined;
  let readLeasePolicy: ReturnType<typeof createNativeCurrentPolicy> | undefined;
  const leaseCurrent = () => {
    current(); const channel = bridge.nativeDeliveryChannel();
    if (!channel || !bridge.status().enabledFeatures?.includes(NATIVE_LEASE_DELIVERY_FEATURE)) return fail();
    channel.assertCurrent(); const { saved } = savedSource();
    if (channel.connectionId !== saved.frame.connectionId) return fail();
    return true as const;
  };
  const commandHandler: BridgeCommandHandler | undefined = leasePolicy ? { async handle(frame, receivedAt) {
    if (frame.type !== "job.lease.grant") return false;
    leaseCurrent(); const { saved, material } = savedSource();
    assertNativeLeaseDispatchPair(saved.frame, frame);
    if (leaseIdentity && (leaseIdentity.messageId !== frame.messageId || leaseIdentity.digest !== sha256Digest(frame))) return fail();
    leaseHandler ??= createNativeLeaseCommandHandler({ request: material.request, serverActorId: config.serverId,
      serverKeyId: config.serverKeyId, serverPublicKeySpki: config.serverPublicKeySpki }, {
      journal: leaseJournal!, trust: { resolveServerKey: resolve, currentServerTrustRevision: revision }, clock: current,
      channel: () => bridge.nativeDeliveryChannel(), assertTaskCurrent: leaseCurrent,
    });
    await leaseHandler.handle(frame, receivedAt); leaseCurrent();
    leaseIdentity = { messageId: frame.messageId, digest: sha256Digest(frame) };
    return true;
  } } : undefined;
  const bridge = new PortableNodeBridge({ tenantId: config.enrollment.tenantId, nodeId: config.enrollment.nodeId,
    keyId: config.nodeKeyId, features: [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1", ...(leasePolicy ? [NATIVE_LEASE_DELIVERY_FEATURE] : [])] }, journal,
  { sign: async frame => { current(); const result = await sign(frame); current(); return result; } },
  dependencies.serverAuthenticator, undefined, commandHandler, intake);
  let reporter: NativeObservationReporter | undefined;
  const reporting = () => {
    if (closed) return fail();
    return reporter ??= new NativeObservationReporter({ queueId: queue(), enrollment: config.enrollment,
      serverId: config.serverId, serverKeyId: config.serverKeyId, serverPublicKeySpki: config.serverPublicKeySpki },
    { deliveries, runs, bridge, clock, assertAvailable: current });
  };
  if (boundQueue !== undefined) reporting();

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  function bounded<T>(work: () => Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
    current(); if (!(signal instanceof AbortSignal) || signal.aborted) return Promise.reject(new Error("native_node_runtime_unavailable"));
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const abort = () => { rejectCancelled(new Error("native_node_runtime_uncertain")); void close().catch(() => {}); };
    const stopped = () => rejectCancelled(new Error("native_node_runtime_uncertain"));
    signal.addEventListener("abort", abort, { once: true }); lifetime.signal.addEventListener("abort", stopped, { once: true });
    const timer = setTimeout(abort, milliseconds);
    const active = track(Promise.resolve().then(() => { current(); return work(); }).then(value => { current(); return value; }));
    return Promise.race([active, cancelled]).finally(() => {
      clearTimeout(timer); signal.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", stopped);
    });
  }
  const json = dependencies.transport.json.bind(dependencies.transport), events = dependencies.transport.events.bind(dependencies.transport);
  async function nativeRequest<T>(request: NativeWireRequest, work: (owned: NativeWireRequest) => Promise<T>) {
    current();
    // Retain an interrupted observation while admitting its separately authorized stop,
    // but never accumulate more unresolved physical transport calls behind timeouts.
    if (rawNative.size >= 2) { void close().catch(() => {}); return fail(); }
    const cancel = new AbortController();
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
      const raw = track(Promise.resolve().then(() => {
        current(); if (cancel.signal.aborted) return fail(); return work(owned);
      }));
      rawNative.add(raw); void raw.then(() => rawNative.delete(raw), () => rawNative.delete(raw));
      const result = await Promise.race([raw, stopped]); current(); return result;
    } finally { cancel.abort(); lifetime.signal.removeEventListener("abort", abort); request.signal?.removeEventListener("abort", abort);
      operationSignal?.removeEventListener("abort", abort); }
  }
  const nativeTransport: NativeRunTransport = {
    json: request => nativeRequest(request, json),
    events: (request, receive) => nativeRequest(request, owned => events(owned, chunk => {
      current(); if (owned.signal?.aborted) return fail(); receive(chunk);
    })),
  };
  const readLocal = leasePolicy ? async (signal: AbortSignal) => {
    requireLease(); const { material } = savedSource();
    readLeasePolicy ??= createNativeCurrentPolicy({ ...leasePolicy.config,
      request: { ...material.request, approval: material.packet.approval }, leaseMessageId: leaseIdentity!.messageId,
      serverActorId: config.serverId }, { ...leasePolicy, approvals: dependencies.approvals, journal: leaseJournal!, clock: current });
    const policy = await readLeasePolicy(signal); requireLease();
    const fresh = policy.assertFresh;
    return { ...policy, assertFresh: () => { requireLease(); fresh?.(); requireLease(); } };
  } : dependencies.local.readCurrent.bind(dependencies.local);
  const profileLocal = dependencies.local.assertProfileCurrent.bind(dependencies.local);
  const local = { ...dependencies.local, ...stores, clock,
    readCurrent: async (signal: AbortSignal) => { current(); const value = await readLocal(signal); current(); return value; },
    assertProfileCurrent: async (...args: Parameters<typeof profileLocal>) => {
      current(); const check = await profileLocal(...args); current(); return () => { current(); check?.(); };
    },
  };
  const approvals = dependencies.approvals;
  function savedSource() {
    current(); const saved = deliveries.acceptedNativeDelivery(queue()); if (!saved) return fail();
    const frame = signedNodeFrameSchema.parse(saved.frame);
    if (frame.type !== "harness.native.dispatch" || frame.direction !== "server_to_node"
      || frame.actorId !== config.serverId || frame.keyId !== config.serverKeyId
      || frame.tenantId !== config.enrollment.tenantId || frame.body.queueId !== queue()
      || !verifyNodeFrameSignature(frame, config.serverPublicKeySpki)) return fail();
    matchNativeTaskDispatchReceipt(saved.receipt, frame);
    const material = prepareNativeTaskDispatchIntake(frame.body, config.enrollment), digest = sha256Digest(saved);
    if (sourceDigest !== undefined && sourceDigest !== digest) return fail(); sourceDigest = digest;
    sourceBindingDigest = frame.body.bindingDigest;
    return { saved, material };
  }
  function requireLease() {
    if (!leasePolicy) return;
    leaseCurrent(); if (!leaseIdentity) return fail();
    const accepted = leaseJournal!.acceptedCommand(leaseIdentity.messageId);
    if (!accepted || sha256Digest(accepted.frame) !== leaseIdentity.digest || accepted.frame.type !== "job.lease.grant") return fail();
    const grant = accepted.frame.body, attempt = leaseJournal!.attemptSummary(grant.attemptId);
    if (!attempt || attempt.jobId !== grant.jobId || attempt.leaseId !== grant.leaseId || attempt.leaseEpoch !== grant.leaseEpoch
      || !["leased", "running", "waiting"].includes(attempt.state) || current() >= Date.parse(grant.expiresAt)
      || current() >= Date.parse(grant.authority.expiresAt)) return fail();
  }
  async function prepared() {
    savedSource();
    if (!handoff) handoff = await prepareNativeExecutionHandoff({ queueId: queue(), enrollment: config.enrollment,
      serverActorId: config.serverId }, { deliveries, runs, approvals,
      security: { currentServerTrustRevision: revision, resolveServerKey: resolve }, local, transport: nativeTransport,
      clock, recovery: recoveryDependencies }, lifetime.signal);
    current(); return handoff;
  }
  function recover() {
    const { saved, material } = savedSource();
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
    current(); if (!operation?.interrupted) await reporting().report(lifetime.signal); return result;
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
  const transports = new WeakSet<object>(), ownedTransports = new Set<() => Promise<void>>();
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; lifetime.abort(); intake.close(); leaseHandler?.close(); handoff?.close(); recovery?.close(); reporter?.close();
    const cleanup = Promise.all([bridge.close(), ...[...ownedTransports].map(dispose => dispose())]);
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([cleanup, Promise.allSettled([...pending])]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native_node_runtime_close_uncertain")), 10_000);
      })]); }
      finally { clearTimeout(timer); }
    })();
    return closing;
  }
  function open(transport: BridgeTransport, transportIdentity: string, signal: AbortSignal, packet = false) {
      current(); localId.parse(transportIdentity);
      if (!transport || transports.has(transport) || typeof transport.send !== "function" || typeof transport.close !== "function") return fail();
      transports.add(transport); const send = transport.send.bind(transport), dispose = transport.close.bind(transport);
      let closingTransport: Promise<void> | undefined;
      const closeTransport = () => closingTransport ??= Promise.resolve().then(dispose).then(() => { ownedTransports.delete(closeTransport); });
      ownedTransports.add(closeTransport);
      return wire(0, signal, () => bridge.open({ send: async raw => {
        current();
        const output = packet ? encodeNativeWire(raw, "node_to_server", body => reporting().readResult(body, lifetime.signal)) : raw;
        current(); await send(output); current();
      },
        close: closeTransport }, { now: new Date(current()).toISOString(), transportIdentity }));
  }
  function receive(raw: string | Uint8Array, signal: AbortSignal) {
      let frame: z.infer<typeof signedNodeFrameSchema>, copy: string | Uint8Array, size: number;
      try {
        current(); if (typeof raw !== "string" && !(raw instanceof Uint8Array)) return fail();
        size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength; if (size > 131_072) return fail();
        copy = typeof raw === "string" ? raw : Uint8Array.from(raw);
        frame = signedNodeFrameSchema.parse(JSON.parse(typeof copy === "string" ? copy : Buffer.from(copy).toString("utf8")));
        if (!["connection.accepted", "node.reconciliation.request", "protocol.ack", "harness.native.dispatch", ...(leasePolicy ? ["job.lease.grant"] : [])].includes(frame.type)
          || frame.direction !== "server_to_node" || frame.actorId !== config.serverId || frame.keyId !== config.serverKeyId
          || !verifyNodeFrameSignature(frame, config.serverPublicKeySpki)
          || frame.type === "harness.native.dispatch" && boundQueue !== undefined && frame.body.queueId !== boundQueue) return fail();
      } catch { void close().catch(() => {}); return Promise.reject(new Error("native_node_runtime_uncertain")); }
      return wire(size, signal, async () => {
        // Queued receives may have parsed while still unbound. Recheck under the
        // same FIFO immediately before admission, not only before enqueueing.
        if (frame.type === "harness.native.dispatch" && boundQueue !== undefined && frame.body.queueId !== boundQueue) return fail();
        await bridge.receive(copy, new Date(current()).toISOString()); current();
        if (frame.type === "harness.native.dispatch" && boundQueue === undefined) {
          const accepted = deliveries.acceptedNativeDelivery(frame.body.queueId);
          if (!accepted || accepted.receipt.disposition !== "recorded" || sha256Digest(accepted.frame) !== sha256Digest(frame)) return fail();
          boundQueue = frame.body.queueId;
          savedSource(); reporting();
        }
      });
  }
  return Object.freeze({ nodeId: config.enrollment.nodeId, get queueId() { return queue(); }, grantsExecutionAuthority: false as const,
    hasAcceptedDispatch() {
      current(); if (boundQueue === undefined || !deliveries.acceptedNativeDelivery(boundQueue)) return false;
      if (leasePolicy && !leaseIdentity) return false;
      requireLease();
      savedSource(); return true;
    },
    open: (transport: BridgeTransport, identity: string, signal: AbortSignal) => open(transport, identity, signal),
    openWire: (transport: BridgeTransport, identity: string, signal: AbortSignal) => open(transport, identity, signal, true),
    receive,
    receiveWire(packet: string | Uint8Array, signal: AbortSignal) {
      try { current(); return receive(decodeNativeWire(packet, "server_to_node").raw, signal); }
      catch { void close().catch(() => {}); return Promise.reject(new Error("native_node_runtime_uncertain")); }
    },
    disconnected(signal: AbortSignal) { return wire(0, signal, () => bridge.disconnected()); },
    start(signal: AbortSignal) {
      // Incomplete delivery is not an attempted native start. Refuse before the
      // adapter reserves the approved run, keeping the node able to receive grant.
      if (leasePolicy) { try { requireLease(); } catch { return Promise.reject(new Error("native_node_runtime_not_ready")); } }
      return native("start", signal, async () => {
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
    report(signal: AbortSignal) { return native("report", signal, () => reporting().report(signal)); },
    readResult: (...args: Parameters<NativeObservationReporter["readResult"]>) => reporting().readResult(...args),
    close,
    async closeForSettlement(bindingDigest: string) {
      if (!sourceBindingDigest || sourceBindingDigest !== bindingDigest) return fail();
      await close();
      const assertClosed = (): void => {
        if (!closed || !lifetime.signal.aborted || rawNative.size !== 0 || pending.size !== 0
          || sourceBindingDigest !== bindingDigest) return fail();
      };
      assertClosed();
      return Object.freeze({ bindingDigest, descendantsStoppedVerified: false as const, assertClosed });
    },
  });
}
