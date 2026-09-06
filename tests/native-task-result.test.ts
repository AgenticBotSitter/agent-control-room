import assert from "node:assert/strict";
import test from "node:test";
import { NativeResultStore, checkedResultBytes, resultBytesHash } from "../src/artifacts/v1/native-results";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { at } from "./native-task-fixture";
import { binding } from "./hermes-native-fixture";
import type { ArtifactStorageWriteV1, StoredArtifactV1 } from "../src/node-executor/artifact-storage";

test("authenticated native result persists exact artifact bytes and receipt without completing canonical work", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Synthetic result\nA useful next step.");
  const first = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  assert.equal(first.replayed, false); assert.equal(first.receipt.qualityAccepted, false); assert.equal(f.storage.count(), 1);
  const again = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  assert.equal(again.replayed, true); assert.deepEqual(again.receipt, first.receipt);
  const read = await f.db.transaction(tx => f.results.read(tx, binding.tenantId, binding.projectId, binding.jobId, first.receipt.artifactId));
  assert.equal(read?.text, "Synthetic result\nA useful next step.");
  assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_jobs WHERE id='job:test'")).rows[0].state, "leased");
  assert.equal((await f.db.query<{ state: string }>("SELECT state FROM control_attempts WHERE id='attempt:test'")).rows[0].state, "leased");
  for (const table of ["control_native_artifact_receipts", "control_artifact_manifests", "audit_events"])
    assert.equal(JSON.stringify((await f.db.query(`SELECT * FROM ${table}`)).rows).includes("A useful next step"), false);
});

test("concurrent delivery and a newly constructed reader retain one native artifact identity", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Concurrent result");
  await f.service.ingest(input.raw, f.options(at(2000)));
  const results = await Promise.all(Array.from({ length: 3 }, () => f.results.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000))));
  assert.equal(results.filter(item => !item.replayed).length, 1); assert.equal(new Set(results.map(item => item.receipt.artifactId)).size, 1);
  const reader = new NativeResultStore(f.db, f.harnessKey, f.config);
  assert.equal((await f.db.transaction(tx => reader.read(tx, binding.tenantId, binding.projectId, binding.jobId, results[0].receipt.artifactId)))?.text, "Concurrent result");
});

test("unrecorded or differently scoped result claims cannot write artifact storage", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Scope result");
  await assert.rejects(f.results.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000)));
  await f.service.ingest(input.raw, f.options(at(2000)));
  await assert.rejects(f.results.capture(binding.tenantId, "node:other", input.body, input.bytes, at(2000)));
  await assert.rejects(f.results.capture("tenant:other", binding.nodeId, input.body, input.bytes, at(2000)));
  assert.equal(f.storage.count(), 0);
});

test("wrong bytes, incomplete output and wrong transport do not become a received artifact", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Exact result");
  await assert.rejects(f.resultService.ingest(input.raw, new TextEncoder().encode("Changed bytes"), f.options(at(2000))), /native_result_rejected/);
  await assert.rejects(f.resultService.ingest(input.raw, input.bytes, { ...f.options(at(2000)), expectedConnectionId: "connection:other" }));
  assert.equal(f.storage.count(), 0);
  assert.equal((await f.db.query("SELECT * FROM control_native_artifact_receipts")).rows.length, 0);
});

test("failed readback leaves no accepted metadata and exact reconciliation can recover the retained artifact", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Recover a file");
  await f.service.ingest(input.raw, f.options(at(2000)));
  let available = false;
  const store = new NativeResultStore(f.db, f.harnessKey, { ...f.config, storage: { put: f.storage.put.bind(f.storage),
    read: async id => available ? f.storage.read(id) : undefined } });
  await assert.rejects(store.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000)));
  assert.equal(f.storage.count(), 1); assert.equal((await f.db.query("SELECT * FROM control_native_artifact_receipts")).rows.length, 0);
  available = true; assert.equal((await store.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000))).replayed, false);
  assert.equal(f.storage.count(), 1);
});

test("lost SQL acknowledgement recovers the original result receipt without duplicate metadata or native work", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Lost acknowledgement");
  await f.service.ingest(input.raw, f.options(at(2000))); let lose = true;
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: async (work, check) => {
    let wrote = false;
    const result = await f.db.transactionWithPreCommitCheck(tx => work({ query: async (sql, params) => {
      if (sql.includes("INSERT INTO control_native_artifact_receipts")) wrote = true;
      return tx.query(sql, params);
    } }), check);
    if (wrote && lose) { lose = false; throw new Error("synthetic lost response"); }
    return result;
  } };
  const store = new NativeResultStore(db, f.harnessKey, f.config);
  await assert.rejects(store.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000)));
  const recovered = await store.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(3000));
  assert.equal(recovered.replayed, true); assert.equal(recovered.receipt.receivedAt, at(2000));
  assert.equal((await f.db.query("SELECT * FROM control_native_artifact_receipts")).rows.length, 1);
});

test("audit failure rolls back artifact metadata together while retaining the exact file for reconciliation", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Atomic metadata");
  await f.service.ingest(input.raw, f.options(at(2000)));
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => {
    const guarded: DatabaseSession = { query: async (sql, params) => { if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic failure"); return tx.query(sql, params); } };
    return work(guarded);
  }, check) };
  await assert.rejects(new NativeResultStore(db, f.harnessKey, f.config).capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000)));
  assert.equal((await f.db.query("SELECT * FROM control_native_artifact_receipts")).rows.length, 0);
  assert.equal((await f.db.query("SELECT * FROM control_artifact_manifests")).rows.length, 0); assert.equal(f.storage.count(), 1);
});

test("invalidated capture at metadata precommit retains bytes but rolls back artifact metadata", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Expired capture fence");
  await f.service.ingest(input.raw, f.options(at(2000)));
  let current = true, reached = false;
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => {
    let wrote = false;
    return f.db.transactionWithPreCommitCheck(tx => work({ query: async <T>(sql: string, params?: unknown[]) => {
      const value = await tx.query<T>(sql, params);
      if (sql.includes("INSERT INTO control_native_artifact_receipts")) wrote = true;
      return value;
    } }), () => {
      if (wrote) { reached = true; current = false; }
      return check();
    });
  } };
  await assert.rejects(new NativeResultStore(db, f.harnessKey, f.config).capture(
    binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000),
    () => { if (!current) throw new Error("synthetic_capture_invalidated"); }),
  /synthetic_capture_invalidated/);
  assert.equal(reached, true); assert.equal(f.storage.count(), 1);
  assert.equal((await f.db.query("SELECT * FROM control_native_artifact_receipts")).rows.length, 0);
  assert.equal((await f.db.query("SELECT * FROM control_artifact_manifests")).rows.length, 0);
});

test("wrong integrity material and inconsistent manifest read metadata make existing content unavailable", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Protected metadata");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const wrong = new NativeResultStore(f.db, f.harnessKey, { ...f.config, integrityKey: new Uint8Array(32).fill(34) });
  await assert.rejects(f.db.transaction(tx => wrong.read(tx, binding.tenantId, binding.projectId, binding.jobId, receipt.artifactId)));
  await assert.rejects(f.db.query("UPDATE control_artifact_manifests SET state='verified' WHERE id=$1", [receipt.artifactId]));
  await assert.rejects(f.db.transaction(tx => f.results.read({ query: async (sql, params) => {
    const result = await tx.query(sql, params); return { ...result, rows: result.rows.map(row => ({ ...row, state: "verified" })) } as never;
  } }, binding.tenantId, binding.projectId, binding.jobId, receipt.artifactId)));
});

test("missing or changed stored bytes never pass a protected content read", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Immutable bytes");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  for (const bytes of [undefined, new TextEncoder().encode("Different bytes")]) {
    const store = new NativeResultStore(f.db, f.harnessKey, { ...f.config, storage: { put: f.storage.put.bind(f.storage), read: async () => bytes } });
    await assert.rejects(f.db.transaction(tx => store.read(tx, binding.tenantId, binding.projectId, binding.jobId, receipt.artifactId)));
  }
});

test("native artifact receipts reject update, deletion and truncation", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000))); assert.equal(receipt.sizeBytes, 0);
  for (const sql of ["UPDATE control_native_artifact_receipts SET auth_tag='changed'", "DELETE FROM control_native_artifact_receipts", "TRUNCATE control_native_artifact_receipts"])
    await assert.rejects(f.db.query(sql));
});

test("result text validates exact UTF-8 bytes including empty and full-size content", () => {
  for (const text of ["", "Result café ☀\n", "\ufeffWith BOM", "x".repeat(65_536)]) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(checkedResultBytes(bytes, { contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength }).text, text);
  }
  for (const bytes of [new Uint8Array([255]), new Uint8Array(65_537), new TextEncoder().encode("Bearer synthetic_token_value_123456789012345678901234")])
    assert.throws(() => checkedResultBytes(bytes, { contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength }));
});

test("a pending storage operation times out, receives cancellation and cannot be retried by the same result store", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Late artifact write");
  await f.service.ingest(input.raw, f.options(at(2000)));
  let calls = 0, supplied: ArtifactStorageWriteV1 | undefined, finish!: (value: StoredArtifactV1) => void;
  const late = new Promise<StoredArtifactV1>(resolve => { finish = resolve; });
  const store = new NativeResultStore(f.db, f.harnessKey, { ...f.config, storageIoMs: 25,
    storage: { read: f.storage.read.bind(f.storage), put: async value => { calls++; supplied = value; return late; } } });
  await assert.rejects(store.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000)), /result_storage_uncertain/);
  assert.equal(supplied?.signal?.aborted, true); assert.equal(calls, 1);
  await assert.rejects(store.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000)), /result_write_unavailable/);
  assert.equal(calls, 1);
  // The injected store intentionally ignores cancellation: a timer is not evidence of physical cessation.
  finish(await f.storage.put({ artifactId: supplied!.artifactId, bytes: supplied!.bytes })); await late;
  assert.equal(f.storage.count(), 1); assert.equal((await f.db.query("SELECT * FROM control_native_artifact_receipts")).rows.length, 0);
});

test("an artifact reader without a write capability can read receipts but cannot capture results", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Read-only artifact capability");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const reader = new NativeResultStore(f.db, f.harnessKey, { ...f.config, storage: { read: f.storage.read.bind(f.storage) } });
  assert.equal((await f.db.transaction(tx => reader.read(tx, binding.tenantId, binding.projectId, binding.jobId, receipt.artifactId)))?.text,
    "Read-only artifact capability");
  await assert.rejects(reader.capture(binding.tenantId, binding.nodeId, input.body, input.bytes, at(2000)), /result_write_unavailable/);
});
