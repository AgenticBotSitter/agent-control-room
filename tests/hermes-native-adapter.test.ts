import assert from "node:assert/strict";
import test from "node:test";
import { HermesNativeRunAdapter } from "../src/harness/hermes-native-v1/adapter.ts";
import { SqliteNativeRunJournal } from "../src/harness/hermes-native-v1/run-journal.ts";
import type { NativeAuthority, NativeOperation, NativeRunJournal, NativeRunTransport, NativeWireRequest } from "../src/harness/hermes-native-v1/contracts.ts";
import { binding, capabilityBody, enrollment, input, instant, nativeRunId, response, statusBody } from "./hermes-native-fixture.ts";

function fixture() {
  const journal = new SqliteNativeRunJournal(":memory:", { testOnlyAllowEphemeral: true });
  const calls: NativeWireRequest[] = [], checks: NativeOperation[] = [], marks: string[] = [];
  let at = instant, deny: NativeOperation | undefined, uncertainStart = false, uncertainMarker = false, unavailableStatus = false, uncertainStop = false;
  let capability = response(capabilityBody), status = response(statusBody()), stopResponse = response({ run_id: nativeRunId, status: "stopping" });
  const authority: NativeAuthority = { async check(operation, current) {
    checks.push(operation); assert.deepEqual(current, binding); if (operation === deny) throw new Error("private authority detail");
  }, async markStart(current) { marks.push(current.effectClaimKey); assert.equal(journal.load(current.runId)?.state, "dispatching");
    if (uncertainMarker) throw new Error("private marker detail"); } };
  const transport: NativeRunTransport = { async json(request) {
    await request.authorize(); calls.push(request);
    if (request.operation === "capabilities") return capability;
    if (request.operation === "start") {
      assert.equal(marks.length, 1); assert.equal(request.body?.session_id, binding.sessionId);
      if (uncertainStart) throw new Error("private provider response");
      return response({ run_id: nativeRunId, status: "started", replayed: false }, 202);
    }
    if (request.operation === "stop") { if (uncertainStop) throw new Error("private stop detail"); return stopResponse; }
    if (unavailableStatus) throw new Error("private connection detail"); return status;
  }, async events(request, receive) {
    await request.authorize(); calls.push(request);
    receive(Buffer.from(`data: ${JSON.stringify({ event: "tool.started", run_id: nativeRunId, arguments: "private arguments" })}\n\n`));
    receive(Buffer.from(`data: ${JSON.stringify({ event: "run.completed", run_id: nativeRunId, output: "not authoritative" })}\n\n`));
  } };
  const adapter = new HermesNativeRunAdapter(enrollment, journal, authority, transport, () => at);
  return { adapter, journal, authority, transport, calls, checks, marks,
    configure(change: { at?: number; deny?: NativeOperation; uncertainStart?: boolean; uncertainMarker?: boolean; unavailableStatus?: boolean;
      uncertainStop?: boolean; status?: ReturnType<typeof response>; capability?: ReturnType<typeof response>; stopResponse?: ReturnType<typeof response> }) {
      if (change.at !== undefined) at = change.at; deny = change.deny;
      uncertainStart = change.uncertainStart ?? uncertainStart; uncertainMarker = change.uncertainMarker ?? uncertainMarker;
      unavailableStatus = change.unavailableStatus ?? unavailableStatus; uncertainStop = change.uncertainStop ?? uncertainStop;
      status = change.status ?? status; capability = change.capability ?? capability; stopResponse = change.stopResponse ?? stopResponse;
    } };
}

test("construction is inert; approved start records the marker before one exact submission", async t => {
  const f = fixture(); t.after(() => f.journal.close()); assert.equal(f.calls.length, 0); assert.equal(f.marks.length, 0);
  const snapshot = await f.adapter.start(input);
  assert.equal(snapshot.state, "queued"); assert.equal(snapshot.nativeRunId, nativeRunId);
  assert.deepEqual(f.calls.map(call => call.operation), ["capabilities", "start"]);
  assert.equal(f.calls[1].idempotencyKey, binding.effectClaimKey); assert.equal(f.calls[1].sessionKey, binding.sessionId);
  assert.equal(f.calls[1].deadline, instant + 10_000);
  assert.equal(f.checks.filter(value => value === "start").length, 3);
  await f.adapter.start(input); assert.equal(f.calls.length, 2); assert.equal(f.marks.length, 1);
});
test("missing authority/capabilities fail before the pre-effect marker and are never silently retried", async t => {
  for (const mode of ["denied", "unsupported"] as const) {
    const f = fixture(); t.after(() => f.journal.close());
    if (mode === "denied") f.configure({ deny: "capabilities" }); else f.configure({ capability: response({}) });
    const snapshot = await f.adapter.start(input); assert.equal(snapshot.state, "failed"); assert.equal(f.marks.length, 0);
    const count = f.calls.length; await f.adapter.start(input); assert.equal(f.calls.length, count);
    assert.doesNotMatch(JSON.stringify(snapshot), /private authority detail/);
  }
});
test("expired launch cannot reach capabilities or reserve a native attempt", async t => {
  const f = fixture(); t.after(() => f.journal.close()); f.configure({ at: input.deadline });
  assert.equal((await f.adapter.start(input)).state, "failed"); assert.equal(f.calls.length, 0); assert.equal(f.marks.length, 0);
});
test("uncertain dispatch never sends the request a second time, including from a replacement adapter", async t => {
  const f = fixture(); t.after(() => f.journal.close()); f.configure({ uncertainStart: true });
  const result = await f.adapter.start(input); assert.equal(result.state, "ambiguous"); assert.equal(result.nativeRunId, null);
  assert.doesNotMatch(JSON.stringify(result), /private provider response/);
  const restarted = new HermesNativeRunAdapter(enrollment, f.journal, f.authority, f.transport, () => instant);
  await restarted.start(input); await restarted.poll(input.runId); await restarted.stop(input.runId);
  assert.equal(f.calls.filter(value => value.operation === "start").length, 1); assert.equal(f.marks.length, 1);
});
test("a prepared crash record or uncertain marker is not permission to submit", async t => {
  const f = fixture(); t.after(() => f.journal.close()); f.journal.reserve(binding, instant);
  assert.equal((await f.adapter.start(input)).state, "prepared"); assert.equal(f.calls.length, 0);
  const g = fixture(); t.after(() => g.journal.close()); g.configure({ uncertainMarker: true });
  assert.equal((await g.adapter.start(input)).state, "ambiguous");
  assert.equal(g.calls.filter(value => value.operation === "start").length, 0);
});
test("status reconnect reconciles an exact run, preserves outage state and never starts another run", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input);
  assert.equal((await f.adapter.poll(input.runId)).state, "running");
  f.configure({ unavailableStatus: true }); const offline = await f.adapter.poll(input.runId);
  assert.equal(offline.state, "running"); assert.equal(offline.availability, "offline");
  f.configure({ unavailableStatus: false, status: response(statusBody("completed", { output: "Synthetic complete", usage: { total_tokens: 8 } })) });
  const final = await f.adapter.poll(input.runId); assert.equal(final.state, "completed"); assert.equal(final.resultText, "Synthetic complete");
  assert.equal(final.usage?.costUsd, null); assert.equal(final.usage?.totalTokens, 8);
  const count = f.calls.length; await f.adapter.poll(input.runId); assert.equal(f.calls.length, count);
  assert.equal(f.calls.filter(value => value.operation === "start").length, 1);
});
test("an unavailable native handle remains ambiguous until exact-ID status returns", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input);
  f.configure({ status: response({}, 404) }); assert.equal((await f.adapter.poll(input.runId)).state, "ambiguous");
  f.configure({ status: response(statusBody("interrupted")) });
  const observed = await f.adapter.poll(input.runId); assert.equal(observed.state, "interrupted"); assert.equal(observed.safeReason, "gateway_interrupted");
  assert.equal(f.calls.filter(value => value.operation === "start").length, 1);
});
test("status with different identity or regressing time cannot replace accepted state", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input); await f.adapter.poll(input.runId);
  f.configure({ status: response(statusBody("completed", { session_id: "other" })) });
  assert.equal((await f.adapter.poll(input.runId)).safeReason, "protocol_mismatch");
  f.configure({ status: response(statusBody("completed", { updated_at: instant / 1000 })) });
  const snapshot = await f.adapter.poll(input.runId); assert.equal(snapshot.state, "running"); assert.equal(snapshot.resultText, null);
});
test("events are consumed at most once and completion always comes from a status resnapshot", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input);
  const first = await f.adapter.observe(input.runId); assert.equal(first.state, "running"); assert.equal(first.resultText, null);
  assert.equal(first.streamAttempted, true);
  await f.adapter.observe(input.runId); await f.adapter.observe(input.runId);
  assert.equal(f.calls.filter(value => value.operation === "events").length, 1);
  assert.equal(f.calls.filter(value => value.operation === "status").length, 3);
});
test("a stop acknowledgement stays stopping until status reports a terminal outcome", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input);
  const stopping = await f.adapter.stop(input.runId); assert.equal(stopping.state, "stopping"); assert.equal(stopping.stopAttempted, true);
  assert.equal((await f.adapter.stop(input.runId)).state, "stopping");
  f.configure({ status: response(statusBody("cancelled", { updated_at: instant / 1000 + 2 })) });
  assert.equal((await f.adapter.poll(input.runId)).state, "cancelled");
  assert.equal(f.calls.filter(value => value.operation === "stop").length, 1);
});
test("completion racing a stop preserves the completed result rather than inventing cancellation", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input);
  f.configure({ stopResponse: response(statusBody("completed", { output: "Finished first" })) });
  const final = await f.adapter.stop(input.runId); assert.equal(final.state, "completed"); assert.equal(final.resultText, "Finished first");
});
test("unknown stop response is consumed once and reconciled through status", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input); f.configure({ uncertainStop: true });
  assert.equal((await f.adapter.stop(input.runId)).state, "ambiguous");
  assert.equal((await f.adapter.stop(input.runId)).state, "running");
  assert.equal(f.calls.filter(value => value.operation === "stop").length, 1);
});
test("deadline does not grant execution grace; separately authorized observation/cleanup remains possible", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input); f.configure({ at: input.deadline + 1 });
  await f.adapter.observe(input.runId); assert.equal(f.calls.filter(value => value.operation === "events").length, 0);
  assert.equal((await f.adapter.stop(input.runId)).state, "stopping");
  assert.ok(f.checks.includes("stop")); f.configure({ at: enrollment.validUntil });
  const count = f.calls.length; assert.equal((await f.adapter.poll(input.runId)).availability, "expired"); assert.equal(f.calls.length, count);
});
test("rejected cleanup authority cannot reach stop and does not reveal its raw error", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input); f.configure({ deny: "stop" });
  const result = await f.adapter.stop(input.runId); assert.equal(result.state, "ambiguous");
  assert.equal(f.calls.filter(value => value.operation === "stop").length, 0); assert.doesNotMatch(JSON.stringify(result), /private authority detail/);
});
test("different connection registration cannot read or operate another registration's native handle", async t => {
  const f = fixture(); t.after(() => f.journal.close()); await f.adapter.start(input);
  const other = new HermesNativeRunAdapter({ ...enrollment, connectionId: "connection:other" }, f.journal, f.authority, f.transport, () => instant);
  assert.throws(() => other.snapshot(input.runId), /not_available/); await assert.rejects(other.poll(input.runId), /not_available/);
});
test("concurrent adapter instances share the durable reservation, not duplicate submissions", async t => {
  const f = fixture(); t.after(() => f.journal.close());
  let release: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const transport: NativeRunTransport = { ...f.transport, async json(request) {
    if (request.operation === "capabilities") await ready; return f.transport.json(request);
  } };
  const first = new HermesNativeRunAdapter(enrollment, f.journal, f.authority, transport, () => instant);
  const started = first.start(input);
  await assert.rejects(first.start(input), /busy/);
  assert.equal((await f.adapter.start(input)).state, "prepared"); release();
  assert.equal((await started).state, "queued"); assert.equal(f.calls.filter(value => value.operation === "start").length, 1);
});
test("a quarantined save after submission never manufactures success or retries the POST", async t => {
  const f = fixture(); t.after(() => f.journal.close()); let quarantined = false;
  const journal: NativeRunJournal = {
    reserve: (...args) => { if (quarantined) throw new Error("native_journal_unavailable"); return f.journal.reserve(...args); },
    load: id => { if (quarantined) throw new Error("native_journal_unavailable"); return f.journal.load(id); },
    update: (id, version, patch) => {
      if (patch.state === "queued") quarantined = true;
      if (quarantined) throw new Error("native_journal_unavailable"); return f.journal.update(id, version, patch);
    },
  };
  const adapter = new HermesNativeRunAdapter(enrollment, journal, f.authority, f.transport, () => instant);
  await assert.rejects(adapter.start(input), /native_journal_unavailable/);
  await assert.rejects(adapter.start(input), /native_journal_unavailable/);
  assert.equal(f.calls.filter(value => value.operation === "start").length, 1);
});
test("a hung preflight is bounded and its late resolution cannot advance to submission", async t => {
  const journal = new SqliteNativeRunJournal(":memory:", { testOnlyAllowEphemeral: true }); t.after(() => journal.close());
  let release: (value: ReturnType<typeof response>) => void = () => undefined, posts = 0, marked = 0;
  const pending = new Promise<ReturnType<typeof response>>(resolve => { release = resolve; });
  const transport: NativeRunTransport = { async json(request) { if (request.operation === "start") posts++; return pending; }, async events() {} };
  const adapter = new HermesNativeRunAdapter(enrollment, journal, { async check() {}, async markStart() { marked++; } }, transport, () => instant);
  const result = await adapter.start({ ...input, deadline: instant + 15 }); assert.equal(result.state, "failed");
  release(response(capabilityBody)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts, 0); assert.equal(marked, 0);
});
