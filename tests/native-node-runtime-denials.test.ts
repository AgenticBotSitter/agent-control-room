import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { signNodeFrame, signedNodeFrameSchema, type SignedNodeFrame, type UnsignedNodeFrame } from "../src/node-protocol/v1";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { currentSignal } from "./helpers/managed-native-session";

type Fixture = Awaited<ReturnType<typeof nativeNodeRuntimeFixture>>;
type Runtime = Fixture["runtime"];
type Connection = Awaited<ReturnType<Fixture["connect"]>>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accepted => { resolve = accepted; });
  return { promise, resolve };
}

function unsigned(frame: SignedNodeFrame<"harness.native.dispatch">): UnsignedNodeFrame<"harness.native.dispatch"> {
  const { signature, bodyDigest, ...value } = frame;
  void signature; void bodyDigest;
  return value;
}

async function pendingDispatch(x: Fixture, runtime: Runtime = x.runtime) {
  const connection = await x.connect("initial", runtime);
  await connection.server.stage(x.x.f.identity, x.x.task, currentSignal());
  await connection.server.transmit(x.x.f.identity, x.x.task, currentSignal());
  assert.equal(connection.outgoing.length, 1);
  const parsed = signedNodeFrameSchema.parse(JSON.parse(connection.outgoing[0]));
  assert.equal(parsed.type, "harness.native.dispatch");
  return { connection, frame: parsed as SignedNodeFrame<"harness.native.dispatch"> };
}

async function receiveFailure(x: Fixture, raw: string, connection: Connection) {
  const calls = [...x.x.local.calls];
  await assert.rejects(x.runtime.receive(raw, currentSignal()), { message: "native_node_runtime_uncertain" });
  await x.runtime.close();
  assert.deepEqual(x.x.local.calls, calls); assert.equal(connection.state.nodeCloses, 1);
}

test("the frozen facade captures configuration and methods before factory return and serializes native authority", async t => {
  const x = await nativeNodeRuntimeFixture(); t.after(x.close);
  const runtime = x.runtime;
  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "disconnected", "grantsExecutionAuthority", "nodeId", "observe",
    "open", "poll", "queueId", "readResult", "receive", "report", "start", "stop"]);
  assert.equal(runtime.grantsExecutionAuthority, false);
  assert.equal("journal" in runtime || "runs" in runtime || "approvals" in runtime || "transport" in runtime
    || "security" in runtime || "recovery" in runtime || "signer" in runtime, false);

  const startGate = deferred(), startEntered = deferred(), observeEntered = deferred();
  const original = {
    queueId: x.config.queueId, nodeKeyId: x.config.nodeKeyId, serverId: x.config.serverId,
    serverKeyId: x.config.serverKeyId,
    clock: x.dependencies.clock, revision: x.dependencies.security.currentServerTrustRevision,
    resolve: x.dependencies.security.resolveServerKey, sign: x.dependencies.signer.sign,
    json: x.dependencies.transport.json, events: x.dependencies.transport.events,
    recoveryRead: x.dependencies.recovery.readCurrent, recoveryProfile: x.dependencies.recovery.assertProfileCurrent,
    localRead: x.dependencies.local.readCurrent, localProfile: x.dependencies.local.assertProfileCurrent,
  };
  let holdStart = true;
  x.dependencies.transport.json = async request => {
    if (request.operation === "start" && holdStart) { startEntered.resolve(); await startGate.promise; }
    return original.json(request);
  };
  x.dependencies.transport.events = async request => {
    await request.authorize(); x.x.local.calls.push("events"); observeEntered.resolve();
    return new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort",
      () => reject(new Error("synthetic observation interrupted")), { once: true }));
  };
  const captured = x.create();
  x.config.queueId = "native-queue:mutated"; x.config.nodeKeyId = "key:mutated-node";
  x.config.serverId = "server:mutated"; x.config.serverKeyId = "key:mutated-server";
  x.dependencies.clock = () => -1;
  x.dependencies.security.currentServerTrustRevision = () => { throw new Error("mutated revision used"); };
  x.dependencies.security.resolveServerKey = async () => { throw new Error("mutated resolver used"); };
  x.dependencies.signer.sign = async () => { throw new Error("mutated signer used"); };
  x.dependencies.transport.json = async () => { throw new Error("mutated JSON transport used"); };
  x.dependencies.transport.events = async () => { throw new Error("mutated event transport used"); };
  x.dependencies.recovery.readCurrent = async () => { throw new Error("mutated recovery reader used"); };
  x.dependencies.recovery.assertProfileCurrent = async () => { throw new Error("mutated recovery profile used"); };
  x.dependencies.local.readCurrent = async () => { throw new Error("mutated local reader used"); };
  x.dependencies.local.assertProfileCurrent = async () => { throw new Error("mutated local profile used"); };
  try {
    assert.equal(captured.queueId, original.queueId); assert.equal(captured.nodeId, x.x.f.prepared.enrollment.nodeId);
    const connection = await x.connect("initial", captured); await x.dispatch(connection);
    const starting = captured.start(currentSignal()); await startEntered.promise;
    const beforeBusy = [...x.x.local.calls];
    await assert.rejects(captured.poll(currentSignal()), { message: "native_node_runtime_unavailable" });
    assert.deepEqual(x.x.local.calls, beforeBusy);
    holdStart = false; startGate.resolve();
    const started = await starting; assert.equal(started.binding.runId, x.x.f.prepared.binding.runId);
    assert.equal(x.x.local.calls.filter(value => value === "start").length, 1); await x.pump(connection);

    const observing = captured.observe(currentSignal()); await observeEntered.promise;
    x.setRecoveryAllowed(false);
    const stopping = captured.stop(currentSignal());
    await assert.rejects(observing, { message: "native_node_observation_interrupted" });
    const refused = await stopping;
    assert.equal(refused.state, "ambiguous"); assert.equal(refused.stopAttempted, true);
    assert.equal(x.x.local.calls.filter(value => value === "events").length, 1);
    assert.equal(x.x.local.calls.includes("stop"), false);
    // An ambiguous local observation is not evidence that the provider process physically stopped.
  } finally {
    x.config.queueId = original.queueId; x.config.nodeKeyId = original.nodeKeyId; x.config.serverId = original.serverId;
    x.config.serverKeyId = original.serverKeyId;
    x.dependencies.clock = original.clock;
    x.dependencies.security.currentServerTrustRevision = original.revision;
    x.dependencies.security.resolveServerKey = original.resolve; x.dependencies.signer.sign = original.sign;
    x.dependencies.transport.json = original.json; x.dependencies.transport.events = original.events;
    x.dependencies.recovery.readCurrent = original.recoveryRead;
    x.dependencies.recovery.assertProfileCurrent = original.recoveryProfile;
    x.dependencies.local.readCurrent = original.localRead; x.dependencies.local.assertProfileCurrent = original.localProfile;
  }
});

test("malformed, wrong-pinned and foreign-queue input closes without a native request", async t => {
  await t.test("malformed frame", async t => {
    const x = await nativeNodeRuntimeFixture(); t.after(x.close);
    const connection = await x.connect(); await receiveFailure(x, "{}", connection);
  });

  await t.test("validly signed frame with the wrong server key pin", async t => {
    const x = await nativeNodeRuntimeFixture(); t.after(x.close);
    const { connection, frame } = await pendingDispatch(x);
    const wrong = signedNodeFrameSchema.parse(await x.x.settings.sign({ ...unsigned(frame), keyId: "key:foreign-server" }));
    await receiveFailure(x, JSON.stringify(wrong), connection);
    assert.equal(x.journal.acceptedNativeDelivery(x.config.queueId), undefined);
  });

  await t.test("validly signed dispatch for a foreign queue", async t => {
    const x = await nativeNodeRuntimeFixture(); t.after(x.close);
    const { connection, frame } = await pendingDispatch(x);
    const queueId = x.config.queueId; x.config.queueId = "native-queue:foreign";
    const foreignRuntime = x.create(); x.config.queueId = queueId;
    const calls = [...x.x.local.calls];
    await assert.rejects(foreignRuntime.receive(JSON.stringify(frame), currentSignal()),
      { message: "native_node_runtime_uncertain" });
    await foreignRuntime.close(); assert.deepEqual(x.x.local.calls, calls);
    assert.equal(connection.state.nodeCloses, 0);
    assert.equal(x.journal.acceptedNativeDelivery(x.config.queueId), undefined);
  });
});

test("a saved delivery signed under another key is refused before preparation or native start", async t => {
  const x = await nativeNodeRuntimeFixture(); t.after(x.close); await x.runtime.close();
  const otherKeys = generateKeyPairSync("ed25519"), load = x.journal.acceptedNativeDelivery.bind(x.journal);
  const resolve = x.dependencies.security.resolveServerKey.bind(x.dependencies.security);
  x.dependencies.security.resolveServerKey = async key => key === "key:foreign-saved-source"
    ? new Uint8Array(otherKeys.publicKey.export({ format: "der", type: "spki" })) : resolve(key);
  x.journal.acceptedNativeDelivery = queueId => {
    const saved = load(queueId); if (!saved) return saved;
    return { ...saved, frame: signNodeFrame({ ...unsigned(saved.frame), keyId: "key:foreign-saved-source" }, otherKeys.privateKey) };
  };
  const foreignRuntime = x.create(), connection = await x.connect("initial", foreignRuntime); await x.dispatch(connection);
  const calls = [...x.x.local.calls];
  await assert.rejects(x.x.admin(() => foreignRuntime.start(currentSignal())), { message: "native_node_runtime_uncertain" });
  assert.deepEqual(x.x.local.calls, calls);
  assert.equal(x.x.local.journal.load(x.x.f.prepared.binding.runId), undefined);
});

async function blockedStartFixture() {
  const x = await nativeNodeRuntimeFixture(), entered = deferred();
  let providerCalls = 0, sawAbort = false;
  const original = x.dependencies.transport.json;
  x.dependencies.transport.json = async request => {
    if (request.operation !== "start") return original(request);
    providerCalls++; entered.resolve();
    return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => {
      sawAbort = true; reject(new Error("synthetic provider request aborted"));
    }, { once: true }));
  };
  const runtime = x.create(); x.dependencies.transport.json = original;
  const connection = await x.connect("initial", runtime); await x.dispatch(connection);
  return { x, runtime, entered, providerCalls: () => providerCalls, sawAbort: () => sawAbort };
}

test("caller abort and runtime close forward cancellation to active native transport without claiming a physical stop", async t => {
  await t.test("caller abort", async t => {
    const f = await blockedStartFixture(); t.after(f.x.close);
    const controller = new AbortController(), starting = f.runtime.start(controller.signal); await f.entered.promise;
    controller.abort();
    await assert.rejects(starting, { message: "native_node_runtime_uncertain" }); await f.runtime.close();
    assert.equal(f.sawAbort(), true); assert.equal(f.providerCalls(), 1);
    assert.equal(f.x.x.local.calls.includes("start") || f.x.x.local.calls.includes("stop"), false);
    const calls = [...f.x.x.local.calls];
    await assert.rejects(f.runtime.observe(currentSignal()), { message: "native_node_runtime_unavailable" });
    assert.deepEqual(f.x.x.local.calls, calls);
  });

  await t.test("owner close", async t => {
    const f = await blockedStartFixture(); t.after(f.x.close);
    const starting = f.runtime.start(currentSignal()); await f.entered.promise;
    const closing = f.runtime.close();
    await assert.rejects(starting, { message: "native_node_runtime_uncertain" }); await closing;
    assert.equal(f.sawAbort(), true); assert.equal(f.providerCalls(), 1);
    assert.equal(f.x.x.local.calls.includes("start") || f.x.x.local.calls.includes("stop"), false);
    const calls = [...f.x.x.local.calls];
    await assert.rejects(f.runtime.poll(currentSignal()), { message: "native_node_runtime_unavailable" });
    assert.deepEqual(f.x.x.local.calls, calls);
  });
});

test("close owns queued transports before bridge open and late settlement cannot install them", async t => {
  const x = await nativeNodeRuntimeFixture(); t.after(x.close);
  const gate = deferred(), entered = deferred();
  let firstSends = 0, secondSends = 0, firstCloses = 0, secondCloses = 0;
  const first = x.runtime.open({ async send() { firstSends++; entered.resolve(); await gate.promise; },
    async close() { firstCloses++; } }, "transport:first", currentSignal()).catch(error => error);
  await entered.promise;
  const second = x.runtime.open({ async send() { secondSends++; }, async close() { secondCloses++; } },
    "transport:second", currentSignal()).catch(error => error);
  const closing = x.runtime.close(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(firstCloses, 1); assert.equal(secondCloses, 1); assert.equal(secondSends, 0);
  assert.equal((await first).message, "native_node_runtime_uncertain");
  assert.equal((await second).message, "native_node_runtime_uncertain");
  gate.resolve(); await closing;
  assert.equal(firstSends, 1); assert.equal(secondSends, 0); assert.equal(firstCloses, 1); assert.equal(secondCloses, 1);
  await assert.rejects(async () => x.runtime.open({ async send() {}, async close() {} }, "transport:late", currentSignal()),
    { message: "native_node_runtime_unavailable" });
});

test("transport sends may enqueue without deadlock and the sixteen-operation FIFO cap fails closed", async t => {
  await t.test("reentrant enqueue", async t => {
    const x = await nativeNodeRuntimeFixture(); t.after(x.close);
    let nested: Promise<unknown> | undefined, sends = 0;
    const opened = x.runtime.open({ async send() {
      sends++; nested = x.runtime.disconnected(currentSignal());
    }, async close() {} }, "transport:reentrant", currentSignal());
    await opened; assert.ok(nested); await nested;
    assert.equal(sends, 1); assert.deepEqual(x.x.local.calls, []);
  });

  await t.test("FIFO cap", async t => {
    const x = await nativeNodeRuntimeFixture(); t.after(x.close);
    const gate = deferred(), entered = deferred(); let closes = 0;
    const active = x.runtime.open({ async send() { entered.resolve(); await gate.promise; }, async close() { closes++; } },
      "transport:bounded", currentSignal()).catch(error => error);
    await entered.promise;
    const queued = Array.from({ length: 15 }, () => x.runtime.disconnected(currentSignal()).catch(error => error));
    await assert.rejects(x.runtime.disconnected(currentSignal()), { message: "native_node_runtime_uncertain" });
    assert.equal((await active).message, "native_node_runtime_uncertain");
    assert.equal((await Promise.all(queued)).every(value => value.message === "native_node_runtime_uncertain"), true);
    gate.resolve(); await x.runtime.close();
    assert.equal(closes, 1); assert.deepEqual(x.x.local.calls, []);
  });
});
