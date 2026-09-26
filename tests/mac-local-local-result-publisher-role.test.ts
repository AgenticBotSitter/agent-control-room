// Fifth Mac-local login (owner decision 2026-09-25,
// docs/claude/MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md section 15). Proves the
// real PostgreSQL grants in db/roles/local_result_publisher_roles.sql are
// exactly enough for createOwnerTrustedLocalCliPublishV1 (run registration +
// workflowIdForJob) and publishDurableResultV1 (with the durable reservation
// Postgres port) to complete their one transaction, and that the role cannot
// write jobs, attempts, the completion gate, or the native task queue.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { publishDurableResultV1, type DurableResultBindingV1 } from "../src/artifacts/v1/durable-result-publication";
import { createDurableReservationPostgresPortV1 } from "../src/artifacts/v1/neutral-reservation-postgres";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import { binding } from "./hermes-native-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

// Matches webNativeResultFixture's own internal digest helper (real SHA-256,
// not hermes-native-fixture's naive `digit.repeat(64)`), so values here agree
// with what `provisionRun` already stored on the harness run's payload.
const digest = (seed = "a") => `sha256:${createHash("sha256").update(`durable-test:${seed}`).digest("hex")}`;

/** Same shape as the vps-built-native-evidence.test.mjs restricted pool: every
 * statement runs on the real PGlite connection, but only after
 * `SET LOCAL SESSION AUTHORIZATION`, so PostgreSQL's own privilege checks
 * apply exactly as they would for the real fifth login. */
function restrictedClient(db: DatabaseClient, login: string): DatabaseClient {
  const client: DatabaseClient = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(async tx => {
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
      return work(tx);
    }, check),
  };
  return client;
}

async function installPublisherRole(raw: PGlite, login: string) {
  await raw.exec(await readFile("db/roles/local_result_publisher_roles.sql", "utf8"));
  await raw.exec(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_local_result_publisher TO ${login};`);
}

/** Denied-write probe: PostgreSQL's own SQLSTATE for a missing privilege. */
async function deniedInSession(session: DatabaseSession, sql: string, params: readonly unknown[] = []) {
  try {
    await session.query(sql, params as unknown[]);
    return false;
  } catch (error) {
    return (error as { cause?: { code?: unknown } })?.cause?.code === "42501"
      || (error as { code?: unknown })?.code === "42501";
  }
}

test("the local result publisher role can publish a durable result end to end and nothing else", async t => {
  const f = await webNativeResultFixture();
  t.after(f.close);
  const runId = "run:publisher-role-a", jobId = `job:${runId}`, attemptId = `attempt:${runId}`;
  await f.provisionRun(runId, jobId, attemptId, digest("5"));
  await installPublisherRole(f.raw, "publisher_login_test_a");
  const restricted = restrictedClient(f.db, "publisher_login_test_a");

  // workflowIdForJob's exact statement.
  const jobRow = await restricted.query<{ workflow_id: string }>(
    "SELECT workflow_id FROM control_jobs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, jobId]);
  assert.equal(jobRow.rows[0]?.workflow_id, "workflow:test");

  const storage = new InMemoryArtifactStorage();
  const config = { db: restricted, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage,
    storageClass: "local" as const, reservations: createDurableReservationPostgresPortV1() };
  const publishBinding: DurableResultBindingV1 = { tenantId: binding.tenantId, projectId: binding.projectId,
    jobId, attemptId, runId, nodeId: binding.nodeId, workflowId: "workflow:test", harness: "hermes",
    connectorProfileDigest: digest("c"), acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("9") };
  const receivedAt = new Date(1_800_100_000_000).toISOString();
  const first = await publishDurableResultV1(config,
    { binding: publishBinding, bytes: new TextEncoder().encode("Published entirely as the publisher role."),
      receivedAt, assertAuthority: () => {} });
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.runId, runId);

  // Exact replay, still entirely under the publisher role (exercises every
  // FOR UPDATE lock and the review-plan SELECT/INSERT a second time).
  const replay = await publishDurableResultV1(config,
    { binding: publishBinding, bytes: new TextEncoder().encode("Published entirely as the publisher role."),
      receivedAt, assertAuthority: () => {} });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);

  // Recorded outside the restricted session, proving the writes really landed.
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_durable_result_write_reservations WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, runId])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, runId])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_native_artifact_receipts WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, runId])).rows.length, 1);

  // Negative probes: none of these belong to the publisher role. Each runs in
  // its own transaction — a denied statement aborts the whole transaction, so
  // reusing one across probes would make every probe after the first report
  // "transaction aborted" (25P02) instead of the privilege denial itself.
  const probe = (sql: string, params: readonly unknown[] = []) =>
    restricted.transaction(tx => deniedInSession(tx, sql, params));
  assert.equal(await probe("UPDATE control_jobs SET state=state WHERE tenant_id=$1 AND id=$2", [binding.tenantId, jobId]), true);
  assert.equal(await probe("UPDATE control_attempts SET state=state WHERE tenant_id=$1 AND id=$2", [binding.tenantId, attemptId]), true);
  assert.equal(await probe("UPDATE control_harness_runs SET state=state WHERE tenant_id=$1 AND id=$2", [binding.tenantId, runId]), true);
  assert.equal(await probe("INSERT INTO control_native_task_queue DEFAULT VALUES"), true);
  assert.equal(await probe(
    "INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,record_digest,record_auth_tag,payload,occurred_at) " +
    "VALUES('target:x',$1,$2,'target','key:x','subject:x',$3,$4,'{}'::jsonb,now())",
    [binding.tenantId, binding.projectId, digest("e"), `hmac-sha256:${"e".repeat(64)}`]), true);
  assert.equal(await probe("DELETE FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2", [binding.tenantId, runId]), true);
});

test("the local result publisher role's FOR UPDATE lock on a fresh run permits its own registration insert", async t => {
  const f = await webNativeResultFixture();
  t.after(f.close);
  const runId = "run:publisher-role-b", jobId = `job:${runId}`, attemptId = `attempt:${runId}`;
  const now = new Date(1_800_200_000_000).toISOString();
  const authorityDigest = digest("5");
  const adapterId = (await f.db.query<{ id: string }>("SELECT id FROM adapter_registry LIMIT 1")).rows[0]!.id;
  // A leased job/attempt with no pre-existing harness run — matches exactly
  // what HarnessRunStoreV1.create() requires before it inserts one. Same
  // shape webNativeResultFixture's own provisionRun() uses (it always also
  // inserts the harness run itself; here that row is deliberately left for
  // the publisher role to insert).
  await f.db.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    VALUES ($1,$2,'workflow:test',$3,'leased',2,50,'capability:fixture',$4,$5,$6,$6)`,
    [jobId, binding.tenantId, binding.projectId, authorityDigest, JSON.stringify({
      id: jobId, kind: "job", state: "leased", jobType: "publisher-role-fixture", version: 2,
      priority: 50, tenantId: binding.tenantId, authority: { digest: authorityDigest, maxRisk: "low",
        expiresAt: new Date(Date.parse(now) + 600_000).toISOString(), projectId: binding.projectId, effectPolicy: "none",
        networkPolicy: "none", credentialRefs: [], allowedExecutor: "executor:fixture", filesystemRoots: [],
        allowedOperations: ["operation:fixture"], maxDurationSeconds: 600, maxConcurrentEffects: 0, allowedNetworkDestinations: [] },
      createdAt: now, projectId: binding.projectId, updatedAt: now, workflowId: "workflow:test",
      inputDigest: digest("1"), retryPolicy: { maxAttempts: 1, backoffSeconds: 1, retryAfterOrphan: false,
        ambiguousEffectPolicy: "attention", retryableFailureCodes: [] }, specVersion: "1.0.0",
      contractVersion: "control-room-domain/v1", dependsOnJobIds: [], requiredCapability: "capability:fixture",
    }), now]);
  await f.db.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES ($1,$2,$3,1,'leased',1,NULL,$4,1,$5,$6,$6)`,
    [attemptId, binding.tenantId, jobId, binding.nodeId, JSON.stringify({
      id: attemptId, kind: "attempt", jobId, state: "leased", nodeId: binding.nodeId, version: 1,
      tenantId: binding.tenantId, createdAt: now, offeredAt: now, updatedAt: now,
      leaseEpoch: 1, attemptNumber: 1, contractVersion: "control-room-domain/v1",
    }), now]);
  await installPublisherRole(f.raw, "publisher_login_test_b");
  const restricted = restrictedClient(f.db, "publisher_login_test_b");

  await restricted.transaction(async tx => {
    const existing = await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [binding.tenantId, runId]);
    assert.equal(existing.rows.length, 0);
    await tx.query(`INSERT INTO control_harness_runs (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,parent_run_id,revision_of_run_id,state,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'hermes',$8,NULL,NULL,'discovered',$9,$10,$11::jsonb,$12,$12,$12)`,
      [runId, binding.tenantId, binding.projectId, jobId, attemptId, binding.nodeId, adapterId,
        digest("2"), digest("3"), `hmac-sha256:${"e".repeat(64)}`, JSON.stringify({
          id: runId, jobId, state: "discovered", nodeId: binding.nodeId, harness: "hermes",
          tenantId: binding.tenantId, adapterId, attemptId, createdAt: now, projectId: binding.projectId,
          resumable: false, updatedAt: now, cancelState: "not_requested", schemaVersion: "control-room-harness/v1",
          adapterVersion: "1.0.0", harnessVersion: "2026.9.25", lastObservedAt: now,
          nativeSessionKeyDigest: digest("2"), connectorProfileDigest: digest("c"), authorityDigest,
        }), now]);
  });
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, runId])).rows.length, 1);
});
