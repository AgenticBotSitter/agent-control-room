import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSession } from "../src/persistence/database";
import { nativeTaskSubmissionId, preparePgBossNativeTaskSubmission, PG_BOSS_NATIVE_SUBMISSION as spec,
  type PgBossSubmissionConstructor } from "../src/persistence/pg-boss-native-task-submission";
import type { NativeTaskSubmissionReference } from "../src/persistence/native-task-submission";
import { sha256Digest } from "../src/security";

function reference(jobId = "job:submission", attemptId = "attempt:submission"): NativeTaskSubmissionReference {
  const scope = { tenantId: "tenant:submission", jobId, attemptId };
  return { schema: "control-room.native-task-submission/v1", ...scope, projectId: "project:submission",
    queueId: `native-queue:${sha256Digest(scope).slice(7)}`, inputDigest: sha256Digest("input"), packetDigest: sha256Digest("packet") };
}

function fake() {
  const calls: { session: string; sql: string }[] = [];
  const options: ConstructorParameters<PgBossSubmissionConstructor>[0][] = [];
  let stopped = 0, sent = 0, failStart = false, returnId = true;
  let onError: (error: unknown) => void = () => {};
  let afterSend: (() => Promise<void>) | undefined;
  const queue: Record<string, unknown> = { name: spec.name, table: spec.table, policy: "standard", partition: false,
    retryLimit: 0, deadLetter: null, notify: false };
  const session = (name: string): DatabaseSession => ({ async query<T>(sql: string) {
    calls.push({ session: name, sql });
    await Promise.resolve();
    return { rows: [{ name: spec.name }] as T[] };
  } });
  class Client {
    constructor(readonly config: ConstructorParameters<PgBossSubmissionConstructor>[0]) { options.push(config); }
    async start() { if (failStart) throw new Error("synthetic-start"); await this.config.db.executeSql("startup-read"); }
    async stop() { stopped++; }
    on(_event: "error", listener: (error: unknown) => void) { onError = listener; }
    async getQueue() { await this.config.db.executeSql("queue-metadata-read"); return { ...queue }; }
    async send(_name: string, data: NativeTaskSubmissionReference, supplied: Parameters<InstanceType<PgBossSubmissionConstructor>["send"]>[2]) {
      sent++;
      await this.config.db.executeSql(`cold-cache:${data.jobId}`);
      await supplied.db.executeSql(`insert:${data.jobId}`);
      await afterSend?.();
      return returnId ? supplied.id : null;
    }
  }
  return { Client, calls, options, queue, session, error: () => onError(new Error("synthetic-engine-error")),
    failStart: () => { failStart = true; }, collision: () => { returnId = false; },
    afterSend: (fn: () => Promise<void>) => { afterSend = fn; }, stopped: () => stopped, sent: () => sent };
}

test("preparation is read-only and disables engine migrations, scheduling, supervision and notifications", async () => {
  const f = fake(), adapter = await preparePgBossNativeTaskSubmission(f.Client, f.session("base"));
  assert.deepEqual({ ...f.options[0], db: undefined }, { db: undefined, schema: spec.schema, backend: "postgres",
    migrate: false, createSchema: false, supervise: false, schedule: false, useListenNotify: false });
  assert.equal(f.sent(), 0);
  assert.deepEqual(Object.keys(adapter).sort(), ["close", "enqueueInSession"]);
  await adapter.close(); await adapter.close(); assert.equal(f.stopped(), 1);
  await assert.rejects(adapter.enqueueInSession(f.session("tx"), reference()), /native_task_submission_unavailable/);
});

test("concurrent callers keep metadata and INSERT on their own transaction, never the outer database", async () => {
  const f = fake(), adapter = await preparePgBossNativeTaskSubmission(f.Client, f.session("base"));
  try {
    f.calls.length = 0;
    await Promise.all([adapter.enqueueInSession(f.session("left"), reference("job:left")),
      adapter.enqueueInSession(f.session("right"), reference("job:right"))]);
    assert.equal(f.calls.some(call => call.session === "base"), false);
    for (const side of ["left", "right"]) {
      assert.ok(f.calls.some(call => call.session === side && call.sql === `insert:job:${side}`));
      assert.ok(f.calls.some(call => call.session === side && call.sql === `cold-cache:job:${side}`));
      assert.ok(f.calls.some(call => call.session === side && call.sql.includes("FOR SHARE")));
    }
  } finally { await adapter.close(); }
});

test("failed preparation closes its client and never submits", async () => {
  const f = fake(); f.failStart();
  await assert.rejects(preparePgBossNativeTaskSubmission(f.Client, f.session("base")), /native_task_submission_unavailable/);
  assert.equal(f.stopped(), 1); assert.equal(f.sent(), 0);
});

test("queue topology, automatic retry, dead-letter and notification drift deny preparation", async t => {
  for (const patch of [{ table: "other" }, { partition: true }, { policy: "singleton" },
    { retryLimit: 1 }, { deadLetter: "automatic-reissue" }, { notify: true }]) await t.test(JSON.stringify(patch), async () => {
    const f = fake(); Object.assign(f.queue, patch);
    await assert.rejects(preparePgBossNativeTaskSubmission(f.Client, f.session("base")), /native_task_submission_unavailable/);
    assert.equal(f.stopped(), 1); assert.equal(f.sent(), 0);
  });
});

test("reconfiguration and engine faults deny submission", async () => {
  const f = fake(), adapter = await preparePgBossNativeTaskSubmission(f.Client, f.session("base"));
  try {
    f.queue.retryLimit = 1;
    await assert.rejects(adapter.enqueueInSession(f.session("tx"), reference()), /native_task_submission_unavailable/);
    assert.equal(f.sent(), 0);
    f.queue.retryLimit = 0; f.error();
    await assert.rejects(adapter.enqueueInSession(f.session("tx"), reference()), /native_task_submission_unavailable/);
    assert.equal(f.sent(), 0);
  } finally { await adapter.close(); }
});

test("operational collision is an error, not a successful fresh submission", async () => {
  const f = fake(), adapter = await preparePgBossNativeTaskSubmission(f.Client, f.session("base"));
  try { f.collision(); await assert.rejects(adapter.enqueueInSession(f.session("tx"), reference()), /native_task_submission_unavailable/); }
  finally { await adapter.close(); }
});

test("same operation has stable UUID; changed attempt is distinct; mismatched or expanded reference is denied", () => {
  assert.match(nativeTaskSubmissionId(reference()), /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(nativeTaskSubmissionId(reference()), nativeTaskSubmissionId(reference()));
  assert.notEqual(nativeTaskSubmissionId(reference()), nativeTaskSubmissionId(reference("job:other")));
  assert.notEqual(nativeTaskSubmissionId(reference()), nativeTaskSubmissionId(reference("job:submission", "attempt:other")));
  assert.throws(() => nativeTaskSubmissionId({ ...reference(), attemptId: "attempt:other" }));
  assert.throws(() => nativeTaskSubmissionId({ ...reference(), prompt: "must-not-be-in-queue" } as NativeTaskSubmissionReference));
});

test("async callbacks outliving submission cannot reuse its released transaction", async () => {
  const f = fake(), adapter = await preparePgBossNativeTaskSubmission(f.Client, f.session("base"));
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let late: Promise<unknown> = Promise.resolve();
  f.afterSend(async () => { late = (async () => { await gate; return f.options[0].db.executeSql("late-read"); })(); });
  try {
    await adapter.enqueueInSession(f.session("tx"), reference());
    const rejected = assert.rejects(late, /native_task_submission_unavailable/);
    release(); await rejected;
    assert.equal(f.calls.some(call => call.sql === "late-read"), false);
  } finally { release(); await adapter.close(); }
});
