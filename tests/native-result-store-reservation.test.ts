import assert from "node:assert/strict";
import test from "node:test";
import { NativeResultStore, resultBytesHash } from "../src/artifacts/v1/native-results";
import { reserveNativeResultWriteV1 } from "../src/artifacts/v1/native-result-reservation";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { ArtifactStoragePortV1, ArtifactReadPortV1 } from "../src/node-executor/artifact-storage";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { hmacSha256Tag } from "../src/security";

class ControlledStorage implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  readonly artifacts = new Map<string, Uint8Array>();
  putCalls = 0;
  readCalls = 0;
  waitForRelease = false;
  throwAfterPut = false;
  missingReadback = false;
  timeoutPut = false;
  private enteredResolve!: () => void;
  private releaseResolve!: () => void;
  readonly entered = new Promise<void>(resolve => { this.enteredResolve = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releaseResolve = resolve; });

  release(): void { this.releaseResolve(); }

  async put(input: { artifactId: string; bytes: Uint8Array; signal?: AbortSignal }) {
    this.putCalls++;
    this.enteredResolve();
    if (this.timeoutPut) {
      await new Promise<never>((_resolve, reject) => input.signal?.addEventListener("abort",
        () => reject(new Error("synthetic_aborted_put")), { once: true }));
    }
    if (this.waitForRelease) await this.released;
    const bytes = Uint8Array.from(input.bytes);
    this.artifacts.set(input.artifactId, bytes);
    if (this.throwAfterPut) throw new Error("synthetic_ambiguous_put");
    return { artifactId: input.artifactId, opaqueLocator: `memory://artifact/${encodeURIComponent(input.artifactId)}`,
      contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength };
  }

  async read(artifactId: string, signal?: AbortSignal) {
    this.readCalls++;
    signal?.throwIfAborted();
    if (this.missingReadback) return undefined;
    const bytes = this.artifacts.get(artifactId);
    return bytes ? Uint8Array.from(bytes) : undefined;
  }
}

async function prepared(text: string, storage = new ControlledStorage(), storageIoMs = 2000) {
  const f = await webNativeResultFixture();
  const input = f.complete(text);
  await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, input.body);
  const store = new NativeResultStore(f.db, f.harnessKey,
    { integrityKey: f.resultKey, storageClass: "local", storage, storageIoMs });
  return { f, input, storage, store, receivedAt: at(2000) };
}

async function reservationState(db: DatabaseClient) {
  return (await db.query<{ state: string; reservation: unknown; auth_tag: string }>(
    "SELECT state,reservation,auth_tag FROM control_native_result_write_reservations WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, binding.runId])).rows[0];
}

test("durably reserves before one write, blocks a racing replay, and replays only the committed receipt", async t => {
  const storage = new ControlledStorage(); storage.waitForRelease = true;
  const x = await prepared("Durably reserved native result.", storage); t.after(x.f.close);
  const first = x.store.capture(binding.tenantId, binding.nodeId, x.input.body, x.input.bytes, x.receivedAt);
  await storage.entered;
  assert.equal((await reservationState(x.f.db)).state, "reserved");
  await assert.rejects(() => x.store.capture(binding.tenantId, binding.nodeId, x.input.body, x.input.bytes, x.receivedAt),
    /result_manual_reconciliation_required/);
  assert.equal(storage.putCalls, 1);
  storage.release();
  const captured = await first;
  assert.equal(captured.replayed, false);
  assert.equal((await reservationState(x.f.db)).state, "metadata_committed");

  const restarted = new NativeResultStore(x.f.db, x.f.harnessKey,
    { integrityKey: x.f.resultKey, storageClass: "local", storage });
  const replay = await restarted.capture(binding.tenantId, binding.nodeId, x.input.body, x.input.bytes, x.receivedAt);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, captured.receipt);
  assert.equal(storage.putCalls, 1);
});

test("an ambiguous write is durably terminal and never retried", async t => {
  const storage = new ControlledStorage(); storage.throwAfterPut = true;
  const x = await prepared("Ambiguous storage write.", storage); t.after(x.f.close);
  await assert.rejects(() => x.store.capture(binding.tenantId, binding.nodeId, x.input.body, x.input.bytes, x.receivedAt),
    /result_storage_uncertain/);
  const row = await reservationState(x.f.db);
  assert.equal(row.state, "storage_uncertain");
  assert.equal(storage.putCalls, 1);
  const restarted = new NativeResultStore(x.f.db, x.f.harnessKey,
    { integrityKey: x.f.resultKey, storageClass: "local", storage });
  await assert.rejects(() => restarted.capture(binding.tenantId, binding.nodeId, x.input.body, x.input.bytes, x.receivedAt),
    /result_manual_reconciliation_required/);
  assert.equal(storage.putCalls, 1);
});

test("a timed-out write and missing exact readback both persist storage uncertainty", async t => {
  const timed = new ControlledStorage(); timed.timeoutPut = true;
  const first = await prepared("Timed storage write.", timed, 5); t.after(first.f.close);
  await assert.rejects(() => first.store.capture(binding.tenantId, binding.nodeId,
    first.input.body, first.input.bytes, first.receivedAt), /result_storage_uncertain/);
  assert.equal((await reservationState(first.f.db)).state, "storage_uncertain");
  assert.equal(timed.putCalls, 1);

  const missing = new ControlledStorage(); missing.missingReadback = true;
  const second = await prepared("Missing storage readback.", missing); t.after(second.f.close);
  await assert.rejects(() => second.store.capture(binding.tenantId, binding.nodeId,
    second.input.body, second.input.bytes, second.receivedAt), /result_storage_uncertain/);
  assert.equal((await reservationState(second.f.db)).state, "storage_uncertain");
  assert.equal(missing.putCalls, 1);
});

function failingMetadataDatabase(base: DatabaseClient): DatabaseClient {
  let fail = true;
  const intercepted = (tx: DatabaseSession): DatabaseSession => ({
    query<T>(sql: string, params?: unknown[]) {
      if (fail && sql.includes("INSERT INTO control_artifact_manifests")) {
        fail = false; throw new Error("synthetic_metadata_crash");
      }
      return tx.query<T>(sql, params);
    },
  });
  return {
    query: base.query.bind(base),
    transaction: work => base.transaction(tx => work(intercepted(tx))),
    transactionWithPreCommitCheck: (work, check) =>
      base.transactionWithPreCommitCheck(tx => work(intercepted(tx)), check),
  };
}

test("a crash after verified bytes leaves manual reconciliation and never writes again", async t => {
  const x = await prepared("Verified before metadata crash."); t.after(x.f.close);
  const crashing = new NativeResultStore(failingMetadataDatabase(x.f.db), x.f.harnessKey,
    { integrityKey: x.f.resultKey, storageClass: "local", storage: x.storage });
  await assert.rejects(() => crashing.capture(binding.tenantId, binding.nodeId,
    x.input.body, x.input.bytes, x.receivedAt), /synthetic_metadata_crash/);
  assert.equal((await reservationState(x.f.db)).state, "bytes_verified");
  assert.equal(x.storage.putCalls, 1);
  const restarted = new NativeResultStore(x.f.db, x.f.harnessKey,
    { integrityKey: x.f.resultKey, storageClass: "local", storage: x.storage });
  await assert.rejects(() => restarted.capture(binding.tenantId, binding.nodeId,
    x.input.body, x.input.bytes, x.receivedAt), /result_manual_reconciliation_required/);
  assert.equal(x.storage.putCalls, 1);
});

test("persisted reservation authentication rejects database tampering before storage", async t => {
  const x = await prepared("Authenticated reservation state."); t.after(x.f.close);
  await x.store.capture(binding.tenantId, binding.nodeId, x.input.body, x.input.bytes, x.receivedAt);
  assert.equal(x.storage.putCalls, 1);
  await x.f.raw.exec(`ALTER TABLE control_native_result_write_reservations DISABLE TRIGGER control_native_result_write_reservations_guard;
    UPDATE control_native_result_write_reservations SET auth_tag='hmac-sha256:${"0".repeat(64)}';
    ALTER TABLE control_native_result_write_reservations ENABLE TRIGGER control_native_result_write_reservations_guard;`);
  const restarted = new NativeResultStore(x.f.db, x.f.harnessKey,
    { integrityKey: x.f.resultKey, storageClass: "local", storage: x.storage });
  await assert.rejects(() => restarted.capture(binding.tenantId, binding.nodeId,
    x.input.body, x.input.bytes, x.receivedAt), /result_reservation_integrity_failed/);
  assert.equal(x.storage.putCalls, 1);
});

test("a valid authenticated reservation for a conflicting identity refuses without writing", async t => {
  const x = await prepared("Conflicting reservation identity."); t.after(x.f.close);
  const reservation = reserveNativeResultWriteV1({ tenantId: binding.tenantId,
    nodeId: "node:other", snapshot: x.input.body });
  await x.f.db.query(`INSERT INTO control_native_result_write_reservations
    (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`,
  [reservation.identity.tenantId, reservation.identity.projectId, reservation.identity.jobId,
    reservation.identity.attemptId, reservation.identity.runId, reservation.identity.artifactId,
    reservation.identityDigest, reservation.state, reservation.contractDigest, JSON.stringify(reservation),
    hmacSha256Tag(x.f.resultKey, { purpose: "native-result-write-reservation/v1", reservation }), x.receivedAt]);
  await assert.rejects(() => x.store.capture(binding.tenantId, binding.nodeId,
    x.input.body, x.input.bytes, x.receivedAt), /native_result_reservation_conflict/);
  assert.equal(x.storage.putCalls, 0);
});

test("the neutral reservation table rejects missing JSON mirrors and cross-run lineage", async t => {
  const x = await prepared("Neutral reservation constraints."); t.after(x.f.close);
  const atValue = x.receivedAt;
  const scalar = [binding.tenantId, binding.projectId, binding.jobId, binding.attemptId,
    binding.runId, "artifact:durable:missing", `sha256:${"1".repeat(64)}`, "reserved",
    `sha256:${"2".repeat(64)}`, `hmac-sha256:${"3".repeat(64)}`, atValue];
  await assert.rejects(() => x.f.db.query(`INSERT INTO control_durable_result_write_reservations
    (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,$10,$11,$11)`, scalar),
  /ck_durable_result_reservation_mirrors/);

  const otherRun = "run:durable:other";
  await x.f.provisionRun(otherRun, "job:durable:other", "attempt:durable:other");
  const identityDigest = `sha256:${"4".repeat(64)}`, contractDigest = `sha256:${"5".repeat(64)}`;
  const reservation = { schema: "control-room.durable-result-write-reservation/v1",
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
      attemptId: binding.attemptId, runId: otherRun, artifactId: "artifact:durable:cross" },
    identityDigest, state: "reserved", contractDigest };
  await assert.rejects(() => x.f.db.query(`INSERT INTO control_durable_result_write_reservations
    (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`,
  [binding.tenantId, binding.projectId, binding.jobId, binding.attemptId, otherRun,
    "artifact:durable:cross", identityDigest, "reserved", contractDigest, JSON.stringify(reservation),
    `hmac-sha256:${"6".repeat(64)}`, atValue]), /foreign key constraint/);
});
