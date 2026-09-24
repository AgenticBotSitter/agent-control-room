import assert from "node:assert/strict";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { createRemoteWorkerEnrollmentV1 } from "../src/harness/v1/remote-worker-delivery";
import { advanceRemoteWorkerEnrollmentInStoreV1, createRemoteWorkerEnrollmentInStoreV1,
  readCurrentRemoteWorkerEnrollmentV1 } from "../src/harness/v1/remote-worker-enrollment-store";
import { nativeTaskFixture } from "./native-task-fixture";

const key = new Uint8Array(32).fill(85);
const at = (seconds: number) => new Date(1_800_000_000_000 + seconds * 1000).toISOString();
const digest = (value: string) => sha256Digest(value);

function enrollment(workerId = "worker:remote-canonical") {
  return createRemoteWorkerEnrollmentV1({ workerId, adapterId: "connector:remote-reviewed",
    adapterRevision: "revision:remote-reviewed", enrollmentId: `enrollment:${workerId}`, state: "enrolled",
    enrolledAt: at(0), revokedAt: null });
}

function createInput(workerId = "worker:remote-canonical") {
  return { tenantId: "tenant:test", nodeId: "node:test", nodeKeyId: "key:test", enrollment: enrollment(workerId),
    capabilityDigest: digest("capabilities"), releaseBindingDigest: digest("release"), now: at(1) };
}

function currentInput(record: Awaited<ReturnType<typeof createRemoteWorkerEnrollmentInStoreV1>>["record"]) {
  return { tenantId: record.tenantId, workerId: record.workerId, nodeId: record.nodeId, nodeKeyId: record.nodeKeyId,
    adapterId: record.adapterId, adapterRevision: record.adapterRevision, capabilityDigest: record.capabilityDigest,
    enrollmentId: record.enrollmentId, enrollmentDigest: record.enrollmentDigest,
    releaseBindingDigest: record.releaseBindingDigest, now: at(2) };
}

test("canonical enrollment store exact-replays and rejects changed authority material", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const first = await f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, key, createInput()));
  assert.equal(first.replayed, false);
  assert.equal(first.startsWork, false);
  assert.equal(first.grantsExecutionAuthority, false);
  assert.equal(first.auditReceipt.recordDigest, first.record.recordDigest);
  assert.equal((await f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, key, createInput()))).replayed, true);
  await assert.rejects(f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, key,
    { ...createInput(), releaseBindingDigest: digest("changed-release") })), /remote_worker_enrollment_unavailable/);

  assert.equal((await f.db.transaction(tx => readCurrentRemoteWorkerEnrollmentV1(tx, key,
    currentInput(first.record)))).recordDigest, first.record.recordDigest);
  for (const patch of [
    { nodeId: "node:substitute" }, { nodeKeyId: "key:substitute" }, { workerId: "worker:substitute" },
    { adapterRevision: "revision:substitute" }, { capabilityDigest: digest("substitute") },
    { enrollmentDigest: digest("substitute") }, { releaseBindingDigest: digest("substitute") },
  ]) await assert.rejects(f.db.transaction(tx => readCurrentRemoteWorkerEnrollmentV1(tx, key,
    { ...currentInput(first.record), ...patch })), /remote_worker_enrollment_unavailable/);
});

test("lifecycle revisions are append-only, replayable, and immediately fence current authority", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const created = await f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, key, createInput()));
  const drainingInput = { tenantId: created.record.tenantId, workerId: created.record.workerId, expectedRevision: 0,
    state: "draining", evidenceDigest: digest("draining"), now: at(3) };
  const draining = await f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key, drainingInput));
  assert.equal(draining.replayed, false);
  assert.equal(draining.record.state, "draining");
  assert.equal((await f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key, drainingInput))).replayed, true);
  await assert.rejects(f.db.transaction(tx => readCurrentRemoteWorkerEnrollmentV1(tx, key,
    currentInput(created.record))), /remote_worker_enrollment_unavailable/);
  await assert.rejects(f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key,
    { ...drainingInput, evidenceDigest: digest("changed") })), /remote_worker_enrollment_unavailable/);

  const quarantined = await f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key,
    { tenantId: created.record.tenantId, workerId: created.record.workerId, expectedRevision: 1,
      state: "quarantined", evidenceDigest: digest("quarantined"), now: at(4) }));
  const revoked = await f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key,
    { tenantId: created.record.tenantId, workerId: created.record.workerId, expectedRevision: 2,
      state: "revoked", evidenceDigest: digest("revoked"), now: at(5) }));
  assert.equal(quarantined.record.previousRecordDigest, draining.record.recordDigest);
  assert.equal(revoked.record.previousRecordDigest, quarantined.record.recordDigest);
  await assert.rejects(f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key,
    { tenantId: created.record.tenantId, workerId: created.record.workerId, expectedRevision: 1,
      state: "revoked", evidenceDigest: digest("stale"), now: at(6) })), /remote_worker_enrollment_unavailable/);
  await assert.rejects(f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key,
    { tenantId: created.record.tenantId, workerId: created.record.workerId, expectedRevision: 9,
      state: "revoked", evidenceDigest: digest("missing"), now: at(6) })), /remote_worker_enrollment_conflict/);
});

test("restart rereads the same database and key rotation refuses the old binding", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const created = await f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, key, createInput()));
  const restarted = adaptPglite(f.raw as PGlite);
  assert.equal((await restarted.transaction(tx => readCurrentRemoteWorkerEnrollmentV1(tx, key,
    currentInput(created.record)))).recordDigest, created.record.recordDigest);

  await f.raw.query("UPDATE control_node_keys SET state='retired' WHERE tenant_id=$1 AND node_id=$2 AND id=$3",
    [created.record.tenantId, created.record.nodeId, created.record.nodeKeyId]);
  await f.raw.query(`INSERT INTO control_node_keys
    (id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at)
    VALUES($1,$2,$3,'ed25519',$4,$5,'active',$6,$6)`,
  ["key:rotated", created.record.tenantId, created.record.nodeId, "c3BraQ", digest("rotated-key"), at(2)]);
  await f.raw.query(`UPDATE control_nodes SET identity_key_id=$1,
    payload=jsonb_set(payload,'{identityKeyId}',to_jsonb($1::text)),updated_at=$2 WHERE tenant_id=$3 AND id=$4`,
  ["key:rotated", at(2), created.record.tenantId, created.record.nodeId]);
  await assert.rejects(restarted.transaction(tx => readCurrentRemoteWorkerEnrollmentV1(tx, key,
    currentInput(created.record))), /remote_worker_enrollment_unavailable/);
  const revoked = await restarted.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, key,
    { tenantId: created.record.tenantId, workerId: created.record.workerId, expectedRevision: 0,
      state: "revoked", evidenceDigest: digest("rotated-revocation"), now: at(3) }));
  assert.equal(revoked.record.state, "revoked", "rotation fences use but does not prevent recording revocation");
});

test("concurrent exact enrollment attempts produce one append and one replay", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const results = await Promise.all([
    f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, key, createInput("worker:concurrent"))),
    f.db.transaction(tx => createRemoteWorkerEnrollmentInStoreV1(tx, key, createInput("worker:concurrent"))),
  ]);
  assert.deepEqual(results.map(value => value.replayed).sort(), [false, true]);
  assert.equal((await f.raw.query<{ count: number }>(`SELECT count(*)::int AS count
    FROM control_remote_worker_enrollment_revisions WHERE worker_id='worker:concurrent'`)).rows[0]!.count, 1);
});
