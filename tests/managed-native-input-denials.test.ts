import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ManagedNativeInput, type NativeInputConfiguration } from "../src/web/v1/managed-native-input";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { NODE_PROTOCOL_V1, signNodeFrame, type NodeMessageBodyMap, type NodeMessageType,
  type UnsignedNodeFrame } from "../src/node-protocol/v1";
import { binding, digest, enrollment, instant, nativeRunId } from "./hermes-native-fixture";
import { inputDigest, observation, registration } from "./native-task-fixture";

const at = (offset = 0) => new Date(instant + offset).toISOString();
const signal = () => new AbortController().signal;
const task = { projectId: binding.projectId, jobId: binding.jobId, inputDigest, packetDigest: digest("f") };
const configuredTask = { projectId: task.projectId, jobId: task.jobId,
  attemptId: registration.attemptId, inputDigest: task.inputDigest };
const actor: VerifiedWebIdentity = { provider: "https://identity.example.test", subject: "owner:test", tokenDigest: digest("e"),
  issuedAt: at(-1000), expiresAt: at(60_000), verificationExpiresAt: at(60_000) };
const keys = generateKeyPairSync("ed25519");
let sequence = 0;

function wire<T extends NodeMessageType>(type: T, body: NodeMessageBodyMap[T], causationId?: string): string {
  sequence++;
  const frame: UnsignedNodeFrame<T> = { protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
    tenantId: enrollment.tenantId, actorId: enrollment.nodeId, keyId: "key:test", connectionId: "connection:input",
    sequence, messageId: `message:input:${sequence}`, correlationId: "correlation:input",
    nonce: `input_${sequence}_${"n".repeat(32)}`, sentAt: at(), expiresAt: at(60_000),
    ...(causationId ? { causationId } : {}), type, body } as UnsignedNodeFrame<T>;
  return JSON.stringify(signNodeFrame(frame, keys.privateKey));
}

const hello = () => wire("connection.hello", { supportedProtocols: [NODE_PROTOCOL_V1],
  features: ["harness.native.dispatch.v1", "harness.native.snapshot.v1"], requestedMaxFrameBytes: 131_072,
  lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [registration.attemptId] });
const reconciliation = () => wire("node.reconciliation.report", { lastAcknowledgedServerSequence: 0,
  attempts: [{ attemptId: registration.attemptId, leaseId: registration.nativeTask!.leaseId,
    leaseEpoch: registration.nativeTask!.leaseEpoch, state: "running", lastEventSequence: 0, checkpointIds: [] }] });
const acknowledgement = () => wire("protocol.ack", { acknowledgedMessageIds: ["message:server:1"],
  highestContiguousSequence: 1, disposition: "accepted" });
const receipt = () => wire("harness.native.dispatch.receipt", {
  schema: "control-room.native-task-dispatch-receipt/v1", queueId: "native-queue:input",
  dispatchMessageId: "message:dispatch", dispatchBodyDigest: digest("1"), tenantId: enrollment.tenantId,
  projectId: task.projectId, nodeId: enrollment.nodeId, jobId: task.jobId, attemptId: registration.attemptId,
  packetDigest: task.packetDigest, bindingDigest: registration.nativeTask!.bindingDigest, recordedAt: at(),
  disposition: "recorded", safeReason: "none", startsWork: false, grantsExecutionAuthority: false,
}, "message:dispatch");
const progress = () => wire("harness.native.snapshot", observation({ version: 4, state: "running",
  nativeRunId, observedAt: instant }));

type Method = "hello" | "reconcile" | "stage" | "transmit" | "receipt" | "register" | "recover" | "progress" | "close";
type Call = { method: Method; args: unknown[] };
type Handle = ConstructorParameters<typeof ManagedNativeInput>[0];
type Register = ConstructorParameters<typeof ManagedNativeInput>[2];

function rawHandle(options: { before?: (method: Method, args: unknown[], current?: AbortSignal) => void | Promise<void> } = {}) {
  const calls: Call[] = [];
  let closes = 0;
  const closePromise = Promise.resolve();
  const invoke = async (method: Method, args: unknown[], current?: AbortSignal) => {
    calls.push({ method, args }); await options.before?.(method, args, current);
  };
  const handle = {
    nodeId: enrollment.nodeId, grantsExecutionAuthority: false as const,
    async hello(raw: string | Uint8Array, current: AbortSignal) { await invoke("hello", [raw], current); },
    async reconcile(raw: string | Uint8Array, current: AbortSignal) { await invoke("reconcile", [raw], current); },
    async stage(identity: VerifiedWebIdentity, value: typeof task, current: AbortSignal) {
      await invoke("stage", [identity, value], current);
      return { projectId: task.projectId, jobId: task.jobId, attemptId: registration.attemptId,
        queueId: "native-queue:input", messageId: "message:dispatch", connectionId: "connection:input",
        frameDigest: digest("1"), bodyDigest: digest("2"), packetDigest: task.packetDigest,
        stagedAt: at(), expiresAt: at(60_000), evidence: "stored_signed_delivery_envelope",
        startsWork: false, grantsExecutionAuthority: false };
    },
    async transmit(identity: VerifiedWebIdentity, value: typeof task, current: AbortSignal) {
      await invoke("transmit", [identity, value], current);
      return { receipt: { projectId: task.projectId, jobId: task.jobId, attemptId: registration.attemptId,
        queueId: "native-queue:input", messageId: "message:dispatch", connectionId: "connection:input",
        frameDigest: digest("1"), packetDigest: task.packetDigest, requestedAt: at(),
        evidence: "stored_transmission_intent", deliveryConfirmed: false, grantsExecutionAuthority: false },
      transportResult: "returned_without_receipt", deliveryConfirmed: false };
    },
    async receipt(raw: string | Uint8Array, current: AbortSignal) {
      await invoke("receipt", [raw], current); return { projectId: task.projectId, jobId: task.jobId,
        attemptId: registration.attemptId, queueId: "native-queue:input", dispatchMessageId: "message:dispatch",
        receiptMessageId: "message:receipt", packetDigest: task.packetDigest, nodeReportedDisposition: "recorded",
        safeReason: "none", recordedAt: at(), receivedAt: at(), evidence: "stored_authenticated_node_receipt",
        startsWork: false, executionConfirmed: false, grantsExecutionAuthority: false };
    },
    async recover(value: typeof configuredTask, current: AbortSignal) {
      await invoke("recover", [value], current); return { recovered: true, grantsExecutionAuthority: false };
    },
    async progress(raw: string | Uint8Array, bytes: Uint8Array | undefined, current: AbortSignal) {
      await invoke("progress", [raw, bytes], current);
      return { runId: binding.runId, state: "running", replayed: false, executionAuthorized: false };
    },
    close() { closes++; calls.push({ method: "close", args: [] }); return closePromise; },
  } as unknown as Handle;
  return { handle, calls, closes: () => closes, closePromise };
}

function inputFixture(mode: NativeInputConfiguration["mode"], raw = rawHandle()) {
  const registerCalls: { value: unknown; signal: AbortSignal }[] = [];
  const register = (async (value: typeof configuredTask, current: AbortSignal) => {
    registerCalls.push({ value: structuredClone(value), signal: current });
    raw.calls.push({ method: "register", args: [structuredClone(value)] });
    return { receipt: { targetId: "target:test" }, replayed: false };
  }) as unknown as Register;
  let available = true;
  const input = new ManagedNativeInput(raw.handle, { mode, task: configuredTask }, register,
    () => { if (!available) throw new Error("synthetic_input_unavailable"); });
  return { input, raw, registerCalls, setAvailable(value: boolean) { available = value; } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accepted => { resolve = accepted; });
  return { promise, resolve };
}

const methods = (calls: Call[]) => calls.map(call => call.method);

test("initial input owns one FIFO and requires explicit stage and transmit", async () => {
  const gate = deferred(), entered = deferred();
  const raw = rawHandle({ async before(method) {
    if (method === "hello") { entered.resolve(); await gate.promise; }
  } });
  const x = inputFixture("initial", raw);
  assert.equal(x.input.grantsExecutionAuthority, false);
  const first = x.input.receive(hello(), undefined, signal());
  const second = x.input.receive(reconciliation(), undefined, signal());
  const third = x.input.stage(actor, task, signal());
  await entered.promise;
  assert.deepEqual(methods(raw.calls), ["hello"]);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{ kind: "hello" }, { kind: "reconciliation" }]);
  await third;
  assert.deepEqual(methods(raw.calls), ["hello", "reconcile", "stage"]);
  assert.equal(methods(raw.calls).includes("transmit"), false);
  await x.input.transmit(actor, task, signal());
  assert.deepEqual(methods(raw.calls), ["hello", "reconcile", "stage", "transmit"]);
  await x.input.close();
});

test("mutable frames, bytes and stage commands are captured before waiting in the FIFO", async t => {
  await t.test("frame and bytes", async () => {
    const gate = deferred(), entered = deferred();
    const raw = rawHandle({ async before(method) {
      if (method === "reconcile") { entered.resolve(); await gate.promise; }
    } });
    const x = inputFixture("recover", raw);
    await x.input.receive(hello(), undefined, signal());
    const recovering = x.input.receive(reconciliation(), undefined, signal());
    await entered.promise;
    const original = progress(), frame = Uint8Array.from(Buffer.from(original));
    const bytes = Uint8Array.from([1, 2, 3, 4]), queued = x.input.receive(frame, bytes, signal());
    frame.fill(0); bytes.fill(9); gate.resolve(); await recovering; await queued;
    const call = raw.calls.find(value => value.method === "progress"); assert.ok(call);
    assert.equal(Buffer.from(call.args[0] as Uint8Array).toString("utf8"), original);
    assert.deepEqual(call.args[1], Uint8Array.from([1, 2, 3, 4]));
    await x.input.close();
  });
  await t.test("stage command", async () => {
    const gate = deferred(), entered = deferred();
    const raw = rawHandle({ async before(method) {
      if (method === "reconcile") { entered.resolve(); await gate.promise; }
    } });
    const x = inputFixture("initial", raw);
    await x.input.receive(hello(), undefined, signal());
    const reconciling = x.input.receive(reconciliation(), undefined, signal()); await entered.promise;
    const mutableActor = { ...actor }, mutableTask = { ...task };
    const staging = x.input.stage(mutableActor, mutableTask, signal());
    mutableActor.subject = "owner:mutated"; mutableTask.jobId = "job:mutated";
    gate.resolve(); await reconciling; await staging;
    const call = raw.calls.find(value => value.method === "stage"); assert.ok(call);
    assert.deepEqual(call.args, [actor, task]); await x.input.close();
  });
});

test("initial receipt registration is ordered before progress", async () => {
  const x = inputFixture("initial");
  await x.input.receive(hello(), undefined, signal());
  await x.input.receive(reconciliation(), undefined, signal());
  await x.input.stage(actor, task, signal()); await x.input.transmit(actor, task, signal());
  const accepted = await x.input.receive(receipt(), undefined, signal());
  assert.equal(accepted.kind, "receipt"); assert.equal(x.registerCalls.length, 1);
  await x.input.receive(progress(), undefined, signal());
  assert.deepEqual(methods(x.raw.calls), ["hello", "reconcile", "stage", "transmit", "receipt", "register", "progress"]);
  assert.deepEqual(x.registerCalls[0].value, configuredTask); await x.input.close();
});

test("recovery occurs after reconciliation and before progress or a trailing acknowledgement", async () => {
  const x = inputFixture("recover");
  await x.input.receive(hello(), undefined, signal());
  await x.input.receive(reconciliation(), undefined, signal());
  await x.input.receive(progress(), undefined, signal());
  await x.input.receive(acknowledgement(), undefined, signal());
  assert.deepEqual(methods(x.raw.calls), ["hello", "reconcile", "recover", "progress", "reconcile"]);
  assert.equal(x.registerCalls.length, 0); await x.input.close();
});

test("a reentrant input queued during handle work does not deadlock its producer", async () => {
  let nested: Promise<unknown> | undefined;
  const raw = rawHandle({ before(method) {
    // Models a supplied transport send callback: enqueue the dependent frame but do not await it behind this operation.
    if (method === "hello") nested = input.receive(acknowledgement(), undefined, signal());
  } });
  const x = inputFixture("initial", raw), input: ManagedNativeInput = x.input;
  assert.deepEqual(await x.input.receive(hello(), undefined, signal()), { kind: "hello" });
  assert.ok(nested); await nested;
  assert.deepEqual(methods(raw.calls), ["hello", "reconcile"]); await x.input.close();
});

test("the sixteen-operation ceiling closes and cancels the entire queued suffix", async () => {
  const gate = deferred(), raw = rawHandle({ before: method => method === "hello" ? gate.promise : undefined });
  const x = inputFixture("initial", raw);
  const pending = Array.from({ length: 16 }, () => x.input.receive(hello(), undefined, signal()).then(
    value => ({ value }), error => ({ error })));
  await assert.rejects(x.input.receive(hello(), undefined, signal()), { message: "native_input_uncertain" });
  gate.resolve(); const settled = await Promise.all(pending);
  assert.equal(settled.every(value => "error" in value), true);
  assert.equal(raw.closes(), 1);
});

test("the one-MiB aggregate ceiling is enforced below the operation-count ceiling", async () => {
  const checkpoints = Array.from({ length: 1000 }, (_, index) => `checkpoint:${index}:${"x".repeat(100)}`);
  const large = wire("node.reconciliation.report", { lastAcknowledgedServerSequence: 0,
    attempts: [{ attemptId: registration.attemptId, leaseId: registration.nativeTask!.leaseId,
      leaseEpoch: 1, state: "running", lastEventSequence: 0, checkpointIds: checkpoints }] });
  const size = Buffer.byteLength(large), first = hello();
  assert.ok(size > 100_000 && size <= 131_072);
  const count = Math.floor((1_048_576 - Buffer.byteLength(first)) / size);
  assert.ok(count > 0 && count + 2 < 16);
  const gate = deferred(), raw = rawHandle({ before: method => method === "hello" ? gate.promise : undefined });
  const x = inputFixture("initial", raw);
  const pending = [x.input.receive(first, undefined, signal()),
    ...Array.from({ length: count }, () => x.input.receive(large, undefined, signal()))]
    .map(value => value.then(result => ({ result }), error => ({ error })));
  await assert.rejects(x.input.receive(large, undefined, signal()), { message: "native_input_uncertain" });
  gate.resolve(); assert.equal((await Promise.all(pending)).every(value => "error" in value), true);
  assert.equal(raw.closes(), 1);
});

test("queued and active cancellation close the owner and abort the ordered suffix", async t => {
  await t.test("queued", async () => {
    const gate = deferred(), entered = deferred();
    const raw = rawHandle({ before(method) {
      if (method === "hello") { entered.resolve(); return gate.promise; }
    } });
    const x = inputFixture("initial", raw), queuedAbort = new AbortController();
    const active = x.input.receive(hello(), undefined, signal()).catch(error => error);
    await entered.promise;
    const queued = x.input.receive(reconciliation(), undefined, queuedAbort.signal).catch(error => error);
    queuedAbort.abort(); gate.resolve();
    assert.equal((await active).message, "native_input_uncertain");
    assert.equal((await queued).message, "native_input_uncertain");
    assert.deepEqual(methods(raw.calls).filter(value => value !== "close"), ["hello"]); assert.equal(raw.closes(), 1);
  });
  await t.test("active", async () => {
    let sawAbort = false; const entered = deferred();
    const raw = rawHandle({ before(method, _args, current) {
      if (method !== "hello") return;
      entered.resolve(); return new Promise<void>((_resolve, reject) => current!.addEventListener("abort", () => {
        sawAbort = true; reject(new Error("synthetic active abort"));
      }, { once: true }));
    } });
    const x = inputFixture("initial", raw), controller = new AbortController();
    const active = x.input.receive(hello(), undefined, controller.signal); await entered.promise; controller.abort();
    await assert.rejects(active, { message: "native_input_uncertain" });
    assert.equal(sawAbort, true); assert.equal(raw.closes(), 1);
  });
});

test("the fixed deadline includes FIFO waiting and late work cannot revive the suffix", async t => {
  await t.test("a queued operation receives no fresh deadline when it dequeues", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const headGate = deferred(), headEntered = deferred(), queuedGate = deferred(), queuedEntered = deferred();
    const raw = rawHandle({ before(method) {
      if (method === "hello") { headEntered.resolve(); return headGate.promise; }
      if (method === "reconcile") { queuedEntered.resolve(); return queuedGate.promise; }
    } });
    const x = inputFixture("initial", raw);
    const head = x.input.receive(hello(), undefined, signal()); await headEntered.promise;
    const queued = x.input.receive(reconciliation(), undefined, signal()).catch(error => error);
    const suffix = x.input.stage(actor, task, signal()).catch(error => error);
    t.mock.timers.tick(9_999); headGate.resolve();
    assert.deepEqual(await head, { kind: "hello" }); await queuedEntered.promise;
    assert.deepEqual(methods(raw.calls), ["hello", "reconcile"]);
    t.mock.timers.tick(1);
    assert.equal((await queued).message, "native_input_uncertain");
    assert.equal((await suffix).message, "native_input_uncertain");
    assert.equal(raw.closes(), 1);
    queuedGate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(methods(raw.calls), ["hello", "reconcile", "close"]);
  });

  await t.test("expiry rejects a held head and its suffix before late completion", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gate = deferred(), entered = deferred();
    const raw = rawHandle({ before(method) {
      if (method === "hello") { entered.resolve(); return gate.promise; }
    } });
    const x = inputFixture("initial", raw);
    const head = x.input.receive(hello(), undefined, signal()).catch(error => error); await entered.promise;
    const queued = x.input.receive(reconciliation(), undefined, signal()).catch(error => error);
    const suffix = x.input.stage(actor, task, signal()).catch(error => error);
    t.mock.timers.tick(10_000);
    for (const result of await Promise.all([head, queued, suffix])) assert.equal(result.message, "native_input_uncertain");
    assert.deepEqual(methods(raw.calls), ["hello", "close"]); assert.equal(raw.closes(), 1);
    gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(methods(raw.calls), ["hello", "close"]); assert.equal(raw.closes(), 1);
  });
});

test("close is idempotent and invalidates retained operations", async () => {
  const x = inputFixture("initial");
  const first = x.input.close(), second = x.input.close();
  assert.equal(first, second); await first; assert.equal(x.raw.closes(), 1);
  await assert.rejects(x.input.receive(hello(), undefined, signal()), { message: "native_input_uncertain" });
  assert.equal(x.raw.closes(), 1);
});

test("a failed head rejects its suffix without invoking execution-shaped methods", async () => {
  const raw = rawHandle({ before(method) { if (method === "hello") throw new Error("synthetic head failure"); } });
  const x = inputFixture("initial", raw);
  const head = x.input.receive(hello(), undefined, signal()).catch(error => error);
  const suffix = x.input.receive(reconciliation(), undefined, signal()).catch(error => error);
  const staged = x.input.stage(actor, task, signal()).catch(error => error);
  assert.equal((await head).message, "native_input_uncertain");
  assert.equal((await suffix).message, "native_input_uncertain");
  assert.equal((await staged).message, "native_input_uncertain");
  assert.deepEqual(methods(raw.calls).filter(value => value !== "close"), ["hello"]);
  assert.equal(x.registerCalls.length, 0); assert.equal(raw.closes(), 1);
});

test("fixed-task and mode checks reject implicit or foreign dispatch", async t => {
  await t.test("initial handshake does not dispatch", async () => {
    const x = inputFixture("initial");
    await x.input.receive(hello(), undefined, signal()); await x.input.receive(reconciliation(), undefined, signal());
    assert.deepEqual(methods(x.raw.calls), ["hello", "reconcile"]);
    await assert.rejects(x.input.stage(actor, { ...task, jobId: "job:other" }, signal()),
      { message: "native_input_uncertain" });
    assert.deepEqual(methods(x.raw.calls).filter(value => value !== "close"), ["hello", "reconcile"]);
  });
  await t.test("recovery cannot stage", async () => {
    const x = inputFixture("recover");
    await x.input.receive(hello(), undefined, signal()); await x.input.receive(reconciliation(), undefined, signal());
    assert.deepEqual(methods(x.raw.calls), ["hello", "reconcile", "recover"]);
    await assert.rejects(x.input.stage(actor, task, signal()), { message: "native_input_uncertain" });
    assert.equal(methods(x.raw.calls).includes("stage"), false);
  });
});

test("availability failure closes without invoking a raw handle operation", async () => {
  const x = inputFixture("initial"); x.setAvailable(false);
  await assert.rejects(x.input.receive(hello(), undefined, signal()), { message: "native_input_uncertain" });
  assert.deepEqual(methods(x.raw.calls), ["close"]); assert.equal(x.raw.closes(), 1);
});
