import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { NativeSnapshot } from "../src/harness/hermes-native-v1/contracts";
import { NativeObservationReporter } from "../src/harness/hermes-native-v1/observation-reporter";
import { nativeTaskObservation } from "../src/harness/hermes-native-v1/task-observation";
import { prepareNativeTaskDispatchIntake } from "../src/harness/v1/native-delivery";
import { verifyNativeTaskApprovalBinding } from "../src/harness/v1/native-task-approval-binding";
import { nativeTaskRegistration } from "../src/harness/v1/native-task-registration";
import type { NativeTaskSnapshotBody } from "../src/harness/v1/native-observation";
import { NativeDispatchIntakeHandler } from "../src/node-bridge/native-dispatch-handler";
import { sha256Digest } from "../src/security";
import { canonicalApprovalStorageFixture } from "./helpers/canonical-approval-storage";
import { nativeEnvelopeSession } from "./helpers/native-envelope-session";

const currentSignal = () => new AbortController().signal;

async function recordedDeliveryFixture() {
  const f = await canonicalApprovalStorageFixture();
  try {
    await f.save();
    await f.coordinator.enqueueNativeTask(...f.args, sha256Digest(f.packet), f.abort.signal);
    const session = await nativeEnvelopeSession(f, { nativeHandler(journal) {
      return new NativeDispatchIntakeHandler(f.prepared.enrollment, journal,
        { approvals: f.approvals, security: f.native.trust }, f.clock);
    } });
    try {
      await f.coordinator.stageQueuedNativeDelivery(...f.args, sha256Digest(f.packet), session.session, f.abort.signal);
      await f.coordinator.transmitQueuedNativeDelivery(...f.args, sha256Digest(f.packet), session.session, f.abort.signal);
      const raw = session.sent.find(value => JSON.parse(value).type === "harness.native.dispatch");
      assert.ok(raw);
      await session.bridge.receive(raw, new Date(f.clock()).toISOString());
      const queueId = JSON.parse(raw).body.queueId as string;
      const saved = session.journal.acceptedNativeDelivery(queueId);
      assert.ok(saved);
      const material = prepareNativeTaskDispatchIntake(saved.frame.body, f.prepared.enrollment);
      const { binding } = verifyNativeTaskApprovalBinding(material.enrollment, material.request, material.start);
      const registration = nativeTaskRegistration(binding, saved.frame.body.inputDigest,
        material.request.leaseId, material.request.leaseEpoch, saved.receipt.recordedAt);
      assert.ok(registration.nativeTask);
      return { f, session, saved, queueId, binding, nativeTask: registration.nativeTask, now: f.clock(),
        close: async () => { await session.close(); await f.close(); } };
    } catch (error) { await session.close(); throw error; }
  } catch (error) { await f.close(); throw error; }
}

type Base = Awaited<ReturnType<typeof recordedDeliveryFixture>>;

function snapshot(base: Base, patch: Partial<NativeSnapshot> = {}): NativeSnapshot {
  return { binding: base.binding, version: 1, state: "queued", nativeRunId: `run_${"1".repeat(32)}`,
    observedAt: base.now, upstreamUpdatedAt: null, availability: "current", streamAttempted: false,
    stopAttempted: false, resultText: null, usage: null, lastActivity: "none", safeReason: "none", ...patch };
}

function harness(base: Base, initial = snapshot(base)) {
  let delivery: Base["saved"] | undefined = structuredClone(base.saved);
  let run: NativeSnapshot | undefined = structuredClone(initial);
  let now = base.now, available = true;
  const published: { body: NativeTaskSnapshotBody; recordedAt: string }[] = [];
  const calls = { delivery: 0, run: 0, publish: 0, available: 0 };
  const config = { queueId: base.queueId, enrollment: structuredClone(base.f.prepared.enrollment),
    serverId: base.saved.frame.actorId, serverKeyId: base.saved.frame.keyId, serverPublicKeySpki: base.session.spki };
  const dependencies = {
    deliveries: { acceptedNativeDelivery(queueId: string) {
      calls.delivery++; return queueId === base.queueId && delivery ? structuredClone(delivery) : undefined;
    } },
    runs: { load(runId: string) {
      calls.run++; return runId === base.binding.runId && run ? structuredClone(run) : undefined;
    } },
    bridge: { async publishNativeSnapshot(body: NativeTaskSnapshotBody, recordedAt: string) {
      calls.publish++; published.push({ body: structuredClone(body), recordedAt }); return "recorded" as const;
    } },
    clock() { return now; },
    assertAvailable() { calls.available++; if (!available) throw new Error("synthetic_reporter_unavailable"); },
  };
  const reporter = new NativeObservationReporter(config, dependencies);
  return { reporter, config, dependencies, calls, published,
    body: () => nativeTaskObservation(run!, base.nativeTask),
    setDelivery: (value: Base["saved"] | undefined) => { delivery = value; },
    setRun: (value: NativeSnapshot | undefined) => { run = value; },
    setNow: (value: number) => { now = value; }, setAvailable: (value: boolean) => { available = value; },
  };
}

test("reporter accepts exact saved delivery and snapshot without any native execution dependency", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const x = harness(base);
  assert.deepEqual(Object.keys(x.dependencies).sort(), ["assertAvailable", "bridge", "clock", "deliveries", "runs"]);
  assert.deepEqual(await x.reporter.report(currentSignal()), { runId: base.binding.runId, snapshotVersion: 1,
    disposition: "recorded", serverAccepted: false, grantsExecutionAuthority: false });
  assert.deepEqual(x.published, [{ body: x.body(), recordedAt: new Date(base.now).toISOString() }]);
  assert.deepEqual({ delivery: x.calls.delivery, run: x.calls.run, publish: x.calls.publish },
    { delivery: 1, run: 1, publish: 1 });
  assert.ok(x.calls.available >= 3);
});

test("missing or tampered delivery, receipt, snapshot, pins and input fail closed", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const wrongSpki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const cases: { name: string; alter(x: ReturnType<typeof harness>): NativeObservationReporter | void }[] = [
    { name: "missing delivery", alter: x => x.setDelivery(undefined) },
    { name: "forged saved frame", alter: x => {
      const saved = structuredClone(base.saved); saved.frame.signature = Buffer.alloc(64).toString("base64url"); x.setDelivery(saved);
    } },
    { name: "mismatched receipt", alter: x => {
      const saved = structuredClone(base.saved); saved.receipt.dispatchMessageId = "message:other"; x.setDelivery(saved);
    } },
    { name: "future receipt", alter: x => {
      const saved = structuredClone(base.saved); saved.receipt.recordedAt = new Date(base.now + 1).toISOString(); x.setDelivery(saved);
    } },
    { name: "missing snapshot", alter: x => x.setRun(undefined) },
    { name: "foreign snapshot binding", alter: x => x.setRun(snapshot(base,
      { binding: { ...base.binding, jobId: "job:other" } })) },
    { name: "queue pin", alter: x => {
      x.config.queueId = "native-queue:other"; return new NativeObservationReporter(x.config, x.dependencies);
    } },
    { name: "enrollment pin", alter: x => {
      x.config.enrollment.tenantId = "tenant:other"; return new NativeObservationReporter(x.config, x.dependencies);
    } },
    { name: "server actor pin", alter: x => {
      x.config.serverId = "server:other"; return new NativeObservationReporter(x.config, x.dependencies);
    } },
    { name: "server key pin", alter: x => {
      x.config.serverKeyId = "key:other"; return new NativeObservationReporter(x.config, x.dependencies);
    } },
    { name: "server public key pin", alter: x => {
      x.config.serverPublicKeySpki = wrongSpki; return new NativeObservationReporter(x.config, x.dependencies);
    } },
    { name: "saved input", alter: x => {
      const saved = structuredClone(base.saved); saved.frame.body.inputDigest = sha256Digest("different input"); x.setDelivery(saved);
    } },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const x = harness(base), reporter = entry.alter(x) ?? x.reporter;
    await assert.rejects(reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
    assert.equal(x.calls.publish, 0);
    await assert.rejects(reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
  });
});

test("saved delivery identity cannot change after a successful report", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const x = harness(base); await x.reporter.report(currentSignal());
  const changed = structuredClone(base.saved);
  changed.receipt.recordedAt = new Date(base.now + 1).toISOString();
  x.setNow(base.now + 1); x.setDelivery(changed);
  x.setRun(snapshot(base, { version: 2, state: "running", observedAt: base.now + 1 }));
  await assert.rejects(x.reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
  assert.equal(x.calls.publish, 1);
});

test("snapshot versions and terminal state remain monotonic", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  await t.test("version regression", async () => {
    const x = harness(base, snapshot(base, { version: 2 })); await x.reporter.report(currentSignal());
    x.setRun(snapshot(base, { version: 1 }));
    await assert.rejects(x.reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
    assert.equal(x.calls.publish, 1);
  });
  await t.test("terminal conflict", async () => {
    const x = harness(base, snapshot(base, { state: "completed", resultText: "Saved result" }));
    await x.reporter.report(currentSignal()); x.setNow(base.now + 1);
    x.setRun(snapshot(base, { version: 2, state: "running", observedAt: base.now + 1 }));
    await assert.rejects(x.reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
    assert.equal(x.calls.publish, 1);
  });
  await t.test("valid skipped version", async () => {
    const x = harness(base); await x.reporter.report(currentSignal()); x.setNow(base.now + 1);
    x.setRun(snapshot(base, { version: 3, state: "completed", observedAt: base.now + 1, resultText: "Saved result" }));
    assert.equal((await x.reporter.report(currentSignal())).snapshotVersion, 3);
    assert.equal(x.calls.publish, 2);
  });
});

test("future observations and clock rollback close the reporter", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  await t.test("future observation", async () => {
    const x = harness(base, snapshot(base, { observedAt: base.now + 1 }));
    await assert.rejects(x.reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
    assert.equal(x.calls.publish, 0);
  });
  await t.test("clock rollback", async () => {
    const x = harness(base); await x.reporter.report(currentSignal()); x.setNow(base.now - 1);
    await assert.rejects(x.reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
    assert.equal(x.calls.publish, 1);
  });
});

test("availability, cancellation and close deny reporting", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  for (const mode of ["unavailable", "cancelled", "closed"] as const) await t.test(mode, async () => {
    const x = harness(base), controller = new AbortController();
    if (mode === "unavailable") x.setAvailable(false);
    else if (mode === "cancelled") controller.abort();
    else x.reporter.close();
    await assert.rejects(x.reporter.report(controller.signal), { message: "native_observation_reporter_unavailable" });
    assert.equal(x.calls.publish, 0);
  });
});

test("configuration and callbacks are captured at construction", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const x = harness(base);
  x.config.queueId = "native-queue:mutated";
  x.config.enrollment.tenantId = "tenant:mutated";
  x.dependencies.deliveries.acceptedNativeDelivery = () => undefined;
  x.dependencies.runs.load = () => undefined;
  x.dependencies.bridge.publishNativeSnapshot = async () => { throw new Error("mutated callback"); };
  x.dependencies.clock = () => -1;
  x.dependencies.assertAvailable = () => { throw new Error("mutated callback"); };
  assert.equal((await x.reporter.report(currentSignal())).snapshotVersion, 1);
  assert.equal(x.published.length, 1);
});

test("publisher mutation cannot alter validated reporter progress", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const x = harness(base);
  x.dependencies.bridge.publishNativeSnapshot = async (body, recordedAt) => {
    x.calls.publish++; x.published.push({ body: structuredClone(body), recordedAt });
    body.snapshotVersion = 999;
    return "recorded";
  };
  const reporter = new NativeObservationReporter(x.config, x.dependencies);
  assert.equal((await reporter.report(currentSignal())).snapshotVersion, 1);
  x.setNow(base.now + 1);
  x.setRun(snapshot(base, { version: 2, state: "running", observedAt: base.now + 1 }));
  assert.equal((await reporter.report(currentSignal())).snapshotVersion, 2);
  assert.deepEqual(x.published.map(value => value.body.snapshotVersion), [1, 2]);
});

test("an invalid publisher disposition closes the reporter", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const x = harness(base);
  x.dependencies.bridge.publishNativeSnapshot = async () => "invalid" as "recorded";
  const reporter = new NativeObservationReporter(x.config, x.dependencies);
  await assert.rejects(reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
  await assert.rejects(reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
});

test("readResult returns only bytes for the exact latest completed observation", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const text = "Node-private synthetic result";
  const x = harness(base, snapshot(base, { version: 4, state: "completed", resultText: text }));
  const exact = x.body();
  assert.deepEqual(x.reporter.readResult(exact, currentSignal()), new TextEncoder().encode(text));
  x.setNow(base.now + 1);
  x.setRun(snapshot(base, { version: 5, state: "completed", observedAt: base.now + 1, resultText: text }));
  assert.throws(() => x.reporter.readResult(exact, currentSignal()), { message: "native_observation_reporter_unavailable" });
  assert.throws(() => x.reporter.readResult(x.body(), currentSignal()), { message: "native_observation_reporter_unavailable" });
  assert.equal(x.calls.publish, 0);
});

test("publication response loss preserves the durable outbox and never claims server acknowledgement", async t => {
  const base = await recordedDeliveryFixture(); t.after(base.close);
  const x = harness(base);
  x.dependencies.bridge.publishNativeSnapshot = async (body, recordedAt) => {
    base.session.journal.appendNativeSnapshot(body, recordedAt);
    throw new Error("synthetic publication response lost");
  };
  // Construct a new reporter so the deliberately failing callback is the captured dependency.
  const reporter = new NativeObservationReporter(x.config, x.dependencies);
  await assert.rejects(reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
  assert.deepEqual(base.session.journal.pendingNativeSnapshots(), [x.body()]);
  await assert.rejects(reporter.report(currentSignal()), { message: "native_observation_reporter_unavailable" });
  assert.deepEqual(base.session.journal.pendingNativeSnapshots(), [x.body()]);
});
