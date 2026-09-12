import assert from "node:assert/strict";
import test from "node:test";
import { stageCompletionCheckpoint } from "../src/completion-gate/v1/staged-checkpoint";
import { stageAsyncCompletionCheckpoint } from "../src/completion-gate/v1/async-staged-checkpoint";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";
import { boundPrivateDatabase } from "../src/web/v1/bounded-database";
import { InMemoryRollbackCheckpointStoreV1, ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1 } from "../src/security/rollback-checkpoint";
const initial = { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: "completion-gate:tenant:test", revision: 1,
  recordCount: 0, stateDigest: `sha256:${"a".repeat(64)}`, stateAuthTag: `hmac-sha256:${"b".repeat(64)}` };
function fixture() { const store = new InMemoryRollbackCheckpointStoreV1({ testOnly: true }); store.initialize(initial); return store; }

test("direct Completion Gate reads and initialization receive database cancellation", async () => {
  for (const stalled of ["read", "initialize"] as const) {
    let entered!: () => void, release!: () => void, captured!: AbortSignal, initializes = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const statements: string[] = [];
    const database = boundPrivateDatabase({ async acquire() { return {
      async query<T>(statement: string) { statements.push(statement); return {
        rows: (statement.startsWith("SELECT id FROM tenants") ? [{ id: "tenant:test" }] : []) as T[],
      }; }, release() {},
    }; }, async terminate() {} }, { connections: 1, checkoutMs: 100, statementMs: 100, transactionMs: 30, closeMs: 100 });
    const gate = new CompletionGateStoreV1(database.client, new Uint8Array(32).fill(42), {
      async read(_scope, signal) {
        assert.ok(signal); captured = signal;
        if (stalled === "read") { entered(); await wait; }
        return undefined;
      },
      async initialize(_checkpoint, signal) {
        initializes++; assert.equal(signal, captured); entered(); await wait;
      }, advance() { throw new Error("unexpected_advance"); },
    });
    const result = assert.rejects(gate.provisionTenant("tenant:test"), /database_outcome_uncertain/);
    await started; await result; assert.equal(captured.aborted, true);
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(initializes, stalled === "read" ? 0 : 1);
    assert.equal(statements.includes("COMMIT"), false); await database.close();
  }
});

test("database timeout cancels checkpoint transport and fences a late reply before the next CAS", async () => {
  const store = fixture(); let entered!: () => void, release!: () => void, calls = 0, captured!: AbortSignal;
  const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const stage = stageAsyncCompletionCheckpoint({ async read(scope, signal) {
    assert.ok(signal); assert.equal(signal.aborted, false); return store.read(scope);
  }, initialize() {}, async advance(expected, next, signal) {
    calls++; captured = signal!; entered(); await wait;
    // Deliberately ignores cancellation: a remote write might already have happened.
    store.advance(expected, next);
  } }, "tenant:test");
  const statements: string[] = [];
  const database = boundPrivateDatabase({ async acquire() { return {
    async query(statement: string) { statements.push(statement); return { rows: [] }; }, release() {},
  }; }, async terminate() {} }, { connections: 1, checkoutMs: 100, statementMs: 100, transactionMs: 30, closeMs: 100 });
  const running = database.client.transactionWithPreCommitCheck(async () => {
    for (const revision of [2, 3]) {
      const current = (await stage.checkpoints.read(initial.scope))!;
      await stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision });
    }
  }, () => stage.flush());
  const observed = assert.rejects(running, /database_outcome_uncertain/);
  await started; await observed; assert.equal(captured.aborted, true);
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(store.read(initial.scope)!.revision, 2);
  assert.deepEqual(statements, ["BEGIN"]); await assert.rejects(stage.flush()); await database.close();
});

test("awaitable stage reads lazily once and flushes the existing exact CAS sequence", async () => {
  const store = fixture(); let reads = 0, writes = 0;
  const stage = stageAsyncCompletionCheckpoint({ async read(scope) { reads++; return store.read(scope); }, initialize() {},
    async advance(expected, next) { await Promise.resolve(); writes++; store.advance(expected, next); } }, "tenant:test");
  assert.equal(reads, 0);
  const first = await stage.checkpoints.read(initial.scope); assert.deepEqual(first, initial);
  await stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), { ...initial, revision: 2 });
  const next = (await stage.checkpoints.read(initial.scope))!;
  await stage.checkpoints.advance(rollbackCheckpointDigestV1(next), { ...next, revision: 3 });
  assert.equal(reads, 1); assert.equal(writes, 0); assert.deepEqual(store.read(initial.scope), initial);
  await stage.flush(); assert.equal(writes, 2); assert.equal(store.read(initial.scope)!.revision, 3);
  await assert.rejects(stage.flush()); await assert.rejects(stage.checkpoints.read(initial.scope));
});

test("awaitable stage rejects partial failure without retry or further writes", async () => {
  const store = fixture(); let calls = 0;
  const stage = stageAsyncCompletionCheckpoint({ async read(scope) { return store.read(scope); }, initialize() {},
    async advance(expected, next) { calls++; if (calls === 2) throw new Error("synthetic_lost_reply"); store.advance(expected, next); } }, "tenant:test", 3);
  for (let revision = 2; revision <= 4; revision++) {
    const prior = (await stage.checkpoints.read(initial.scope))!;
    await stage.checkpoints.advance(rollbackCheckpointDigestV1(prior), { ...prior, revision });
  }
  await assert.rejects(stage.flush(), /review_checkpoint_unavailable/);
  assert.equal(calls, 2); assert.equal(store.read(initial.scope)!.revision, 2);
  await assert.rejects(stage.flush()); assert.equal(calls, 2);
});

test("awaitable stage cannot flush an unawaited read as an empty successful transaction", async () => {
  let release!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stage = stageAsyncCompletionCheckpoint({ async read() { await gate; return initial; }, initialize() {},
    async advance() { writes++; } }, "tenant:test");
  const reading = assert.rejects(stage.checkpoints.read(initial.scope), /review_checkpoint_unavailable/);
  await assert.rejects(stage.flush(), /review_checkpoint_unavailable/); release(); await reading;
  assert.equal(writes, 0); await assert.rejects(stage.flush());
});

test("awaitable stage refuses wrong-scope storage and leaves unused stages effect-free", async () => {
  let reads = 0, writes = 0;
  const port = { async read() { reads++; return { ...initial, scope: "completion-gate:other" }; }, initialize() {}, async advance() { writes++; } };
  const unused = stageAsyncCompletionCheckpoint(port, "tenant:test"); await unused.flush();
  assert.equal(reads, 0); assert.equal(writes, 0);
  const stage = stageAsyncCompletionCheckpoint(port, "tenant:test");
  await assert.rejects(stage.checkpoints.read(initial.scope)); await assert.rejects(stage.flush());
  assert.equal(reads, 1); assert.equal(writes, 0);
});

test("staged review checkpoints keep the durable anchor unchanged until one-use flush", () => {
  const store = fixture(), stage = stageCompletionCheckpoint(store, "tenant:test");
  const next = { ...initial, revision: 2, recordCount: 1 }, final = { ...initial, revision: 3, recordCount: 2 };
  stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), next);
  stage.checkpoints.advance(rollbackCheckpointDigestV1(next), final);
  assert.deepEqual(store.read(initial.scope), initial); assert.deepEqual(stage.checkpoints.read(initial.scope), final);
  stage.flush(); assert.deepEqual(store.read(initial.scope), final);
  assert.throws(() => stage.flush()); assert.throws(() => stage.checkpoints.read(initial.scope));
  assert.deepEqual(store.read(initial.scope), final);
});

test("abandonment, input mutation, wrong scope, provisioning and excess writes cannot change the anchor", () => {
  const store = fixture(), stage = stageCompletionCheckpoint(store, "tenant:test");
  const copy = stage.checkpoints.read(initial.scope)!; copy.revision = 999;
  assert.equal(stage.checkpoints.read(initial.scope)!.revision, 1);
  assert.throws(() => stage.checkpoints.read("completion-gate:tenant:other"));
  assert.throws(() => stage.checkpoints.initialize(initial));
  assert.throws(() => stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), { ...initial, revision: 3 }));
  for (const n of [2, 3]) {
    const current = stage.checkpoints.read(initial.scope)!;
    stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: n });
  }
  const current = stage.checkpoints.read(initial.scope)!;
  assert.throws(() => stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: 4 }));
  assert.deepEqual(store.read(initial.scope), initial); // Discarding the stage cannot commit it.
});

test("external conflict and partial flush are terminal for that stage, with no rollback or implicit retry", () => {
  const store = fixture(); let calls = 0;
  const stage = stageCompletionCheckpoint({ read: store.read.bind(store), initialize: () => { throw new Error(); },
    advance(expected, next) { calls++; if (calls === 2) throw new Error("synthetic_cas_uncertain"); store.advance(expected, next); } }, "tenant:test");
  const next = { ...initial, revision: 2 }, final = { ...initial, revision: 3 };
  stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), next); stage.checkpoints.advance(rollbackCheckpointDigestV1(next), final);
  assert.throws(() => stage.flush()); assert.equal(store.read(initial.scope)!.revision, 2);
  assert.throws(() => stage.flush()); assert.equal(calls, 2);
});

test("an empty stage never initializes or advances durable storage", () => {
  let writes = 0;
  const stage = stageCompletionCheckpoint({ read: () => undefined, initialize() { writes++; }, advance() { writes++; } }, "tenant:test");
  assert.equal(stage.checkpoints.read(initial.scope), undefined); stage.flush(); assert.equal(writes, 0);
});

test("an asynchronous checkpoint never permits SQL commit or a second advance, even after late settlement", async () => {
  for (const settlement of ["resolve", "reject"] as const) {
    const store = fixture(); let calls = 0, release!: () => void, reject!: (error: Error) => void;
    const pending = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    const stage = stageCompletionCheckpoint({ read: store.read.bind(store), initialize() {},
      async advance() { calls++; await pending; } }, "tenant:test");
    const next = { ...initial, revision: 2 };
    stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), next);
    stage.checkpoints.advance(rollbackCheckpointDigestV1(next), { ...next, revision: 3 });
    const statements: string[] = []; let releases = 0;
    const database = boundPrivateDatabase({
      async acquire() { return { async query(statement: string) { statements.push(statement); return { rows: [] }; },
        release() { releases++; } }; }, async terminate() {},
    });
    try {
      await assert.rejects(database.client.transactionWithPreCommitCheck(async () => "not committed", () => stage.flush()),
        /review_checkpoint_unavailable/);
      assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]); assert.equal(releases, 1); assert.equal(calls, 1);
      if (settlement === "resolve") release(); else reject(new Error("synthetic_late_failure"));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.throws(() => stage.flush(), /review_checkpoint_unavailable/);
      assert.throws(() => stage.checkpoints.read(initial.scope), /review_checkpoint_unavailable/);
      assert.equal(calls, 1); assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]);
    } finally { release(); await database.close(); }
  }
});

test("non-void synchronous adapter output cannot be mistaken for CAS acceptance", () => {
  const store = fixture(); let calls = 0;
  const stage = stageCompletionCheckpoint({ read: store.read.bind(store), initialize() {},
    advance() { calls++; return false; } }, "tenant:test");
  stage.checkpoints.advance(rollbackCheckpointDigestV1(initial), { ...initial, revision: 2 });
  assert.throws(() => stage.flush(), /review_checkpoint_unavailable/);
  assert.throws(() => stage.flush(), /review_checkpoint_unavailable/); assert.equal(calls, 1);
});

test("explicit automated batches permit fifty sequential advances but never widen the default bound", () => {
  const store = fixture(), stage = stageCompletionCheckpoint(store, "tenant:test", 50);
  for (let n = 0; n < 50; n++) {
    const current = stage.checkpoints.read(initial.scope)!;
    stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: current.revision + 1, recordCount: current.recordCount + 1 });
  }
  const current = stage.checkpoints.read(initial.scope)!;
  assert.equal(current.revision, 51); assert.deepEqual(store.read(initial.scope), initial);
  assert.throws(() => stage.checkpoints.advance(rollbackCheckpointDigestV1(current), { ...current, revision: 52 }));
  stage.flush(); assert.deepEqual(store.read(initial.scope), current);
  for (const value of [0, -1, 51, 1.5, NaN, Infinity]) assert.throws(() => stageCompletionCheckpoint(store, "tenant:test", value));
});
