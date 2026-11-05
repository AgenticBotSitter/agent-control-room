import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, type LoopRecoveryChildV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomLoopRecoveryV1 } from "../src/web/v1/improve-control-room-loop-recovery";
import { createPipelineAdvanceCycleV1 } from "../src/web/v1/private-task-startup";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { monitoringEngine } from "./helpers/improve-control-room-loop-monitoring";
import { syntheticRecoveryEngine, seedRecoveryRun, recoveryKey, exclusiveSyntheticRecoveryCapability } from "./helpers/improve-control-room-loop-recovery";
import { taskFixture } from "./helpers/web-task";
import { now as initialNow } from "./helpers/web-foundation";
import { sha256Digest } from "../src/security";

// Bound fixture I/O settlement independently of the simulated product clock.
async function settled(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.fail("long-gate fixture did not settle");
}
const iso = (ms: number) => new Date(ms).toISOString();

// This is the production cycle primitive with only its interval scheduler replaced.
function cycleClock() {
  let pulse: (() => void) | undefined, cleared = false;
  return {
    create: (input: Parameters<typeof createPipelineAdvanceCycleV1>[0]) => createPipelineAdvanceCycleV1(input, {
      schedule: (run, ms) => { assert.equal(ms, 5000); pulse = run; return run; },
      clear: () => { cleared = true; pulse = undefined; },
    }),
    pulse: () => { assert.ok(pulse); pulse(); },
    cleared: () => cleared,
  };
}

test("B5 long gate refresh reaches real adapter admission and fails closed on stale collection", async t => {
  const e = await monitoringEngine(t);
  let wall = initialNow, mono = 0;
  const clock = cycleClock();
  const adapter = createImproveControlRoomLoopAdapterV1({ ...e.configuration,
    monitoringClock: { wallNow: () => wall, monotonicNow: () => mono, setTimeout, clearTimeout },
    contract: { ...e.configuration.contract,
      recovery: { enabled: () => true, inspect: async () => { throw Error("no run in collector test"); },
        claimDriver: async () => ({ kind: "busy", evidenceDigest: sha256Digest("SYNTHETIC unused") }) },
      monitoring: { enabled: () => true, decodeStatus: () => ({ reasonCode: null, deadline: null, workerState: "none" }) },
    } });
  const worker = createImproveControlRoomLoopRecoveryV1({ enabled: () => true, createCycle: clock.create,
    onTick: adapter.monitoringTick, port: { scan: async () => ({ targets: [], nextCursor: null }),
      reconcile: async () => ({ state: "idle" }) } });
  t.after(async () => { await worker.close(); await adapter.close(); });
  const file = e.configuration.availabilityFile;
  const schedule = async () => JSON.parse(await readFile(file + ".schedule.json", "utf8"));
  const advance = (ms: number) => { wall += ms; mono += ms; };
  async function collect(fail = false) {
    const count = (await e.healthTraces()).length;
    await e.behavior({ checkedAt: iso(wall), malformed: fail });
    clock.pulse(); await new Promise<void>(resolve => setImmediate(resolve));
    await settled(async () => (await e.healthTraces()).length === count + 1
      && !existsSync(file + ".monitor.lock") && (await schedule()).lastAttemptAt === iso(wall));
  }
  await e.behavior({ checkedAt: iso(wall) });
  worker.start();
  await settled(async () => (await e.healthTraces()).length === 1 && !existsSync(file + ".monitor.lock"));
  assert.equal(adapter.available("start"), true);
  // The foreground owner remains absent for four hours; recovery still ticks.
  for (let refresh = 0; refresh < 4; refresh++) {
    advance(50 * 60_000 - 1);
    clock.pulse(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await e.healthTraces()).length, refresh + 1, "no early refresh");
    assert.equal(adapter.available("start"), true, "the previous sample is still admissible");
    advance(1); await collect();
    assert.equal(adapter.available("start"), true);
    assert.equal(Date.parse((await schedule()).nextAttemptAt) - wall, 50 * 60_000);
  }
  advance(40 * 60_000);
  assert.equal(adapter.available("start"), true, "admission on return from a four-hour gate uses refreshed bytes");
  advance(10 * 60_000); const freshBytes = await readFile(file); await collect(true);
  assert.deepEqual(await readFile(file), freshBytes, "collector failure cannot fabricate a new qualification");
  assert.equal(adapter.available("start"), true, "the previous sample still has its freshness margin");
  advance(5 * 60_000); await collect(true);
  assert.equal(adapter.available("start"), true);
  advance(5 * 60_000);
  assert.equal(adapter.available("start"), true, "exactly one hour is allowed");
  advance(1);
  assert.equal(adapter.available("start"), false, "an hour-old sample is refused after both attempts fail");
  assert.equal(adapter.available("stop"), true, "stale health cannot prevent Stop");
  // A due later normal collection restores admission without resetting the run.
  advance(45 * 60_000 - 1); await collect();
  assert.equal(adapter.available("start"), true);
  const traces = await e.healthTraces();
  assert.ok(traces.every(v => JSON.stringify(v.argv) === JSON.stringify(["logins", "--json"])));
  await worker.close(); await adapter.close(); assert.equal(clock.cleared(), true);
  console.log("RESULT: PASS B5 4h gate: real 5s recovery cycle -> collector CLI -> 50m refresh -> adapter admission; failed retries preserve bytes; >1h stale refuses; Stop remains available");
});

test("B5 long gate reclaims an exited one-hour driver through durable scan without duplicate Start", async t => {
  let wall = initialNow;
  const f = await taskFixture(() => wall); t.after(() => f.db.close());
  const e = await syntheticRecoveryEngine(t), scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
  const saved = await seedRecoveryRun({ ...f, db: f.client, scope }, e, f.project.projectId, () => wall, "b5-long-gate");
  // Only the external engine is synthetic. This wait really spawns, is reaped,
  // and returns the documented --hours timeout exit 4 when the fake hour ends.
  const source = await readFile(e.configuration.entrypoint, "utf8");
  assert.ok(source.includes("while True: time.sleep(1)"));
  await writeFile(e.configuration.entrypoint, source.replace("    while True: time.sleep(1)", [
    "    while not os.path.exists(os.path.join(root,'wait-release')):",
    "        if os.path.exists(os.path.join(root,'owner-answer-accepted')):",
    "            with open(file) as f: current=json.load(f)",
    "            if current['question'] is None and current['progress']['step']=='spec':",
    "                current['revision']+=1;current['progress']['step']='implementation';current['progress']['completed']=1",
    "                with open(file+'.driver.tmp','w') as f: json.dump(current,f)",
    "                os.replace(file+'.driver.tmp',file)",
    "        time.sleep(.01)",
    "    sys.exit(4)",
  ].join("\n"))
    .replace("if op=='answer': s['question']=None;s['revision']+=1",
      "if op=='answer': s['question']=None;s['revision']+=1;s['state']='running';s['progress']['step']='spec'"));
  const configuration = { ...e.configuration, entrypointSha256: loopByteHashV1(await readFile(e.configuration.entrypoint)) };
  const observer = createImproveControlRoomLoopAdapterV1(configuration); t.after(() => observer.close());
  const capability = await exclusiveSyntheticRecoveryCapability(t, { ...e, raw: observer });
  const adapter = createImproveControlRoomLoopAdapterV1({ ...configuration, contract: { ...configuration.contract, recovery: capability.capability } });
  // The fixture engine supplies durable command receipts, as in the existing
  // recovery suite. Service admission, binding, spawn and journal are real.
  const service = new ImproveControlRoomLoopServiceV1(f.client, scope, { integrityKey: recoveryKey,
    adapter: { ...adapter, answer: async (id, binding, text, fence) => {
      const status = await adapter.answer(id, binding, text, fence);
      status.receipts.push({ commandId: id, bindingDigest: sha256Digest(binding), state: "accepted", error: null,
        evidenceDigest: sha256Digest({ id, fixture: "SYNTHETIC owner answer" }) });
      await e.edit(saved.run, status); return status;
    } } }, () => wall);
  const port = service.recoveryPort(), clock = cycleClock(), children: LoopRecoveryChildV1[] = [];
  let scans = 0;
  const worker = createImproveControlRoomLoopRecoveryV1({ enabled: () => true, createCycle: clock.create,
    port: { scan: async (cursor, limit) => { const result = await port.scan(cursor, limit); scans++; return result; }, reconcile: async (target, signal) => {
      const result = await port.reconcile(target, signal);
      if (result.state === "started") children.push(result.child);
      return result;
    } } });
  t.after(async () => { await worker.close(); await adapter.close(); });
  async function pulse() {
    const before = scans; clock.pulse();
    await settled(async () => scans === before + 1);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  worker.start();
  await settled(async () => children.length === 1 && (await e.traces()).filter(v => v.op === "wait").length === 1);
  await pulse();
  assert.equal(children.length, 1, "a live driver retains its slot");
  wall += 3600_000; await writeFile(join(e.root, "wait-release"), "SYNTHETIC elapsed hour");
  assert.deepEqual(await children[0]!.done, { code: 4, signal: null });
  const ledger = join(e.root, saved.run + ".driver.json");
  await settled(async () => JSON.parse(await readFile(ledger, "utf8")).phase === "ended");
  // Keep its replacement alive until the owner's return.
  const { unlink } = await import("node:fs/promises"); await unlink(join(e.root, "wait-release"));
  const firstGeneration = JSON.parse(await readFile(ledger, "utf8")).generation;
  wall += 5000; await pulse();
  await settled(async () => children.length === 2 && (await e.traces()).filter(v => v.op === "wait").length === 2);
  assert.notEqual(JSON.parse(await readFile(ledger, "utf8")).generation, firstGeneration);
  assert.notEqual(children[1]!.pid, children[0]!.pid);
  for (let scan = 0; scan < 3; scan++) { wall += 3600_000; await pulse(); }
  assert.equal(children.length, 2, "no duplicate child while its replacement is live across the long gate");
  // Publish a synthetic engine question. The returning owner answers through
  // actual service admission and adapter execution; progress is read from disk.
  const question = { questionId: "question:long-gate", inputVersion: 1, reportSha256: "c".repeat(64), owner: true, changesInput: false };
  await e.edit(saved.run, { state: "waiting", question });
  const returningIdentity = { ...f.identity, tokenDigest: sha256Digest("SYNTHETIC returning owner session"),
    issuedAt: iso(wall), expiresAt: iso(wall + 300_000), verificationExpiresAt: iso(wall + 300_000) };
  const receipt = await service.mutate(returningIdentity, f.project.projectId, saved.id, "answer", {
    expectedVersion: 1, expectedRevision: 3, questionId: question.questionId, inputVersion: 1,
    questionReportSha256: question.reportSha256, text: "Keep the approved scope after this long gate.",
  }, "b5-long-gate-owner-answer-0001");
  assert.equal(receipt.state, "accepted");
  await writeFile(join(e.root, "owner-answer-accepted"), "SYNTHETIC answer receipt committed");
  await settled(async () => (await adapter.status(saved.run)).progress.step === "implementation");
  const observed = await adapter.status(saved.run);
  assert.equal(observed.revision, 5); assert.equal(observed.progress.step, "implementation");
  assert.equal(observed.progress.completed, 1, "the replacement driver advances after the saved owner answer");
  assert.equal(observed.run.loopRunId, saved.run);
  const starts = (await e.traces()).filter(v => v.op === "start");
  assert.equal(starts.length, 1, "recovery cannot redispatch Start");
  assert.equal((await e.traces()).filter(v => v.op === "answer").length, 1);
  const waits = (await e.traces()).filter(v => v.op === "wait");
  assert.ok(waits.every(v => v.run === saved.run && JSON.stringify(v.args) === JSON.stringify(["--chain", "--hours", "1"])));
  const claims = await f.client.query<{ count: number }>("SELECT count(*)::int AS count FROM control_loop_improvement_commands WHERE request_id=$1 AND operation='start' AND entry_kind='claim'", [saved.id]);
  assert.equal(claims.rows[0]!.count, 1);
  await worker.close(); await adapter.close(); assert.equal(clock.cleared(), true);
  await settled(async () => capability.hosts.size === 0);
  for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  console.log("RESULT: PASS B5 durable scan reclaims exit=4 wait --chain --hours 1 at next 5s tick; same run; new generation; Start claims=1; post-gate progress observed; children reaped");
});
