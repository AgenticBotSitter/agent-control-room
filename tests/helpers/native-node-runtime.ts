import assert from "node:assert/strict";
import { managedNativeSessionFixture, currentSignal, type ManagedNativePreparedContext } from "./managed-native-session";
import { createNativeNodeRuntime, createUnassignedNativeNodeRuntime, createLeaseAwareNativeNodeRuntime, type NativeNodeRuntimeDependencies } from "../../src/harness/hermes-native-v1/node-runtime";
import { SqliteBridgeJournal } from "../../src/node-bridge/journal";
import { NodeProtocolAuthenticator, FixedWindowProtocolRateLimiter, signNodeFrame, signedNodeFrameSchema } from "../../src/node-protocol/v1";
import { response, statusBody } from "../hermes-native-fixture";

/** Synthetic node runtime plus actual restricted managed server. All stores are disposable;
 * canonical approval/dispatch setup remains labelled privileged fixture composition. */
export async function nativeNodeRuntimeFixture(context?: ManagedNativePreparedContext, options: { queue?: boolean; unassigned?: boolean; leaseAware?: boolean; leaseCeiling?: boolean } = {}) {
  // The managed fixture owns supplied context immediately, including setup failure.
  const x = await managedNativeSessionFixture(context, { ...options, leaseDelivery: options.leaseAware });
  let closeJournal: (() => void) | undefined;
  try {
  const journal = new SqliteBridgeJournal(":memory:"); closeJournal = () => journal.close();
  const config = { queueId: "", enrollment: x.f.prepared.enrollment,
    nodeKeyId: "key:test", serverId: x.settings.nodes[0].serverId, serverKeyId: x.settings.nodes[0].serverKeyId,
    serverPublicKeySpki: x.settings.nodes[0].serverPublicKeySpki };
  // The queue identity is derived by canonical queue insertion, not a worker-created identifier.
  const queued = await x.admin(async () => { await x.f.save();
    return x.f.coordinator.enqueueNativeTask(...x.f.args, x.task.packetDigest, currentSignal()); });
  config.queueId = queued.queueId;
  let resultText: string | undefined, recoveryAllowed = true;
  const dependencies: NativeNodeRuntimeDependencies = { journal, runs: x.local.journal, approvals: x.f.approvals,
    security: { currentServerTrustRevision: () => x.f.native.trust.currentServerTrustRevision(),
      async resolveServerKey() { return new Uint8Array(Buffer.from(config.serverPublicKeySpki, "base64url")); } },
    local: x.local.dependencies, clock: x.f.clock,
    recovery: { async readCurrent() { return { approvalKey: x.local.policy.approvalKey!, credentialAvailable: true, recoveryAllowed }; },
      assertProfileCurrent: x.local.dependencies.assertProfileCurrent },
    signer: { async sign(frame) { return signNodeFrame(frame, x.f.keys.privateKey); } },
    serverAuthenticator: new NodeProtocolAuthenticator({ async resolve(value) {
      return { ...value, algorithm: "ed25519", publicKeySpki: config.serverPublicKeySpki,
        state: "active", principalState: "active", validFrom: new Date(x.f.clock() - 60_000).toISOString() };
    } }, journal, new FixedWindowProtocolRateLimiter(120, 60)),
    transport: { ...x.local.transport, async json(wire) {
      if (wire.operation === "stop") {
        await wire.authorize(); x.local.calls.push(wire.operation);
        return response({ run_id: wire.nativeRunId, status: "stopping" });
      }
      if (wire.operation === "status" && resultText !== undefined) {
        await wire.authorize(); x.local.calls.push(wire.operation);
        return response(statusBody("completed", { ...(context ? { run_id: context.providerRunId } : {}),
          session_id: x.f.prepared.binding.sessionId,
          output: resultText, usage: { input_tokens: 12, output_tokens: 5 } }));
      }
      return x.local.transport.json(wire);
    } },
  };
  const runtimes: ReturnType<typeof createNativeNodeRuntime>[] = [];
  const create = (taskConfig = config, taskDependencies = dependencies) => {
    const runtime = createNativeNodeRuntime(taskConfig, taskDependencies); runtimes.push(runtime); return runtime;
  };
  const unassignedConfig = { assignment: "queue" as const, enrollment: config.enrollment, nodeKeyId: config.nodeKeyId,
    serverId: config.serverId, serverKeyId: config.serverKeyId, serverPublicKeySpki: config.serverPublicKeySpki };
  const createUnassigned = (taskDependencies = dependencies) => {
    const runtime = createUnassignedNativeNodeRuntime(unassignedConfig, taskDependencies); runtimes.push(runtime); return runtime;
  };
  let paused = false;
  if (options.leaseAware) {
    if (options.leaseCeiling !== false) await x.f.native.provisionCeiling();
    journal.initializeNodeControlState({ nodeId: config.enrollment.nodeId, nodeVersion: 1, state: "active", updatedAt: new Date(x.f.clock()).toISOString() });
  }
  const createLeaseAware = (taskDependencies = dependencies) => {
    const node = createLeaseAwareNativeNodeRuntime(unassignedConfig, {
    executor: x.local.policy.executor, nodeClass: "personal-compute", nodeSigningKeyReferenceId: "key:test", parentAuthorities: [],
  }, { ...taskDependencies, runs: x.local.journal, security: { ...taskDependencies.security,
    loadCeiling: x.f.native.trust.loadCeiling.bind(x.f.native.trust), currentPolicyRevision: x.f.native.trust.currentPolicyRevision.bind(x.f.native.trust) },
    local: { ...taskDependencies.local, effects: x.local.effects, executions: x.local.executions,
      // Deliberately poisonous legacy callback: the new runtime must never call it.
      ...{ readCurrent: async () => { throw new Error("synthetic legacy policy must not be used"); } } },
    keys: { async availability() { return x.local.policy.keyAvailability; } }, localPaused: () => paused,
  }); runtimes.push(node); return node;
  };
  const runtime = options.leaseAware ? createLeaseAware() : options.unassigned ? createUnassigned() : create();
  type Runtime = typeof runtime;
  type Input = Awaited<ReturnType<typeof x.manager.attachInput>>;
  async function connect(mode: "initial" | "recover" = "initial", node = runtime, task: typeof x.request | "queue" = x.request) {
    if (task === "queue" && mode !== "initial") throw new Error("synthetic_queue_binding_requires_initial");
    const incoming: string[] = [], outgoing: string[] = [], nodeSent: string[] = [], serverSent: string[] = [];
    const state = { nodeCloses: 0, serverCloses: 0, available: true };
    const server = await x.manager.attachInput(config.enrollment.nodeId, {
      async send(raw) { outgoing.push(raw); serverSent.push(raw); },
      async close() { state.serverCloses++; state.available = false; }, isAvailable: () => state.available,
    }, task === "queue" ? { mode: "initial", assignment: "queue" } : { mode, task });
    await x.admin(() => node.open({ async send(raw) { incoming.push(raw); nodeSent.push(raw); },
      async close() { state.nodeCloses++; } }, "transport:managed-server", currentSignal()));
    const connection = { incoming, outgoing, nodeSent, serverSent, state, server, node };
    await pump(connection); return connection;
  }
  async function pump(connection: { incoming: string[]; outgoing: string[]; server: Input; node: Runtime }) {
    for (let i = 0; i < 20 && (connection.incoming.length || connection.outgoing.length); i++) {
      while (connection.outgoing.length) await x.admin(() => connection.node.receive(connection.outgoing.shift()!, currentSignal()));
      const frames = connection.incoming.splice(0);
      await Promise.all(frames.map(raw => {
        const frame = signedNodeFrameSchema.parse(JSON.parse(raw));
        const bytes = frame.type === "harness.native.snapshot" && frame.body.state === "completed" && frame.body.result
          ? connection.node.readResult(frame.body, currentSignal()) : undefined;
        return connection.server.receive(raw, bytes, currentSignal());
      }));
    }
    assert.equal(connection.incoming.length + connection.outgoing.length, 0);
  }
  async function dispatch(connection: Awaited<ReturnType<typeof connect>>) {
    await connection.server.stage(x.f.identity, x.task, currentSignal());
    await connection.server.transmit(x.f.identity, x.task, currentSignal()); await pump(connection);
  }
  return { x, config, unassignedConfig, queued, dependencies, runtime, journal, create, createUnassigned, createLeaseAware, connect, pump, dispatch,
    setPaused: (value: boolean) => { paused = value; },
    setResult: (value: string) => { resultText = value; }, setRecoveryAllowed: (value: boolean) => { recoveryAllowed = value; },
    advance: (ms = 1000) => { const now = x.f.clock() + ms; x.f.setNow(now); x.local.setNow(now); },
    close: async () => { let failed = false;
      for (const owned of runtimes) { try { await owned.close(); } catch { failed = true; } }
      journal.close(); await x.close(); if (failed) throw new Error("synthetic_node_runtime_cleanup_uncertain");
    } };
  } catch (error) {
    try { closeJournal?.(); } finally { await x.close(); }
    throw error;
  }
}
