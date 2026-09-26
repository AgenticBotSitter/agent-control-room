// Fifth Mac-local login (owner decision 2026-09-25,
// docs/claude/MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md section 15). Proves the
// real PostgreSQL grants in db/roles/local_result_publisher_roles.sql are
// exactly enough for the production publish path to complete, and that the role
// cannot write jobs, attempts, the completion gate, or the native task queue.
//
// This file calls the real code. It never re-implements a statement that
// production also runs: the run registration goes through the reviewed
// `hermesLocalRunRegistrationV1` and `HarnessRunStoreV1.create`, and the
// workflow-id read through the publish composition's own `workflowIdForJob`, all
// by way of `createOwnerTrustedLocalCliPublishV1`. A previous version pasted
// those two statements by hand, so a change to production SQL could leave the
// test still green while the real path broke.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createOwnerTrustedLocalCliPublishV1 } from "../src/harness/v1/owner-trusted-local-cli-publish";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { hermesLocalRunRegistrationV1 } from "../src/harness/hermes-local-v1/local-run-registration";
import { HERMES_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-local-v1/task-planning-contract";
import { DurableResultReviewSubmissionServiceV1 } from "../src/completion-gate/v1/durable-result-review-submission";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1 } from "../src/completion-gate/v1";
import { createDurableReservationPostgresPortV1 } from "../src/artifacts/v1/neutral-reservation-postgres";
import { seedMacLocalAdapterRegistryV1 } from "../src/web/v1/mac-local-owner-bootstrap";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import { sha256Digest } from "../src/security";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

const HARNESS_VERSION = "2026.9.25";

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

async function installRole(raw: PGlite, file: string, role: string, login: string) {
  await raw.exec(await readFile(`db/roles/${file}`, "utf8"));
  await raw.exec(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT ${role} TO ${login};`);
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

/** The exact packet the real bridge hands the publish closure. */
function delivery(runId: string, jobId: string, attemptId: string, workerId: string,
  authorityDigest: string, profile: CompletionAcceptanceProfileV1, reviewKey: Uint8Array) {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId, attemptId, runId, nodeId: binding.nodeId },
    worker: { workerId, adapterId: HERMES_LOCAL_ADAPTER_V1, adapterRevision: "source-123" },
    input: { prompt: "Reply with exactly the single word: ok", instructions: "Return plain text only." },
    authorityDigest, connectorProfileDigest: sha256Digest("publisher-role-connector"),
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    issuedAt: at(0), expiresAt: at(120_000),
  });
}

function accepted(packet: ControllerWorkerDeliveryV1, receivedAt: string) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: packet.deliveryId, deliveryDigest: packet.deliveryDigest, workerId: packet.worker.workerId,
    route: { kind: "local" as const, workerId: packet.worker.workerId }, receivedAt,
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
}

/** The reviewed per-agent run registration, exactly as the real compositions
 * pass it: it derives every run field from the delivery packet. */
const registerRun = (packet: unknown, createdAt: string) =>
  hermesLocalRunRegistrationV1(packet, createdAt, HARNESS_VERSION);

/** Mirrors the reviewed owner-trusted-local-cli-publish.test.ts setup: the
 * fixture's own harness row describes a synthetic manual adapter, so it is
 * removed and the Mac-local adapter registry seeded instead, letting the
 * publisher login register the real owner-trusted local run. */
async function setup(t: { after(fn: () => unknown): void }, runId: string) {
  const f = await webNativeResultFixture();
  t.after(f.close);
  const jobId = `job:${runId}`, attemptId = `attempt:${runId}`;
  const authorityDigest = sha256Digest("publisher-role-authority");
  await f.provisionRun(runId, jobId, attemptId, authorityDigest);
  await f.db.query("DELETE FROM control_harness_runs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, runId]);
  await f.db.transaction(tx => seedMacLocalAdapterRegistryV1(tx, binding.tenantId));

  const profile: CompletionAcceptanceProfileV1 = {
    schemaVersion: "control-room-completion-gate/v1", id: `profile:${runId}`,
    tenantId: binding.tenantId, projectId: binding.projectId, name: "Publisher role result quality",
    targetKind: "document", requiredVerificationScenarioIds: ["scenario:content"], minimumIndependentReviews: 1,
    reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
    verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2,
    automaticLowRiskDisposition: false, createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at() };
  await f.reviewStore.registerProfile(profile);
  return { f, jobId, attemptId, profile, authorityDigest };
}


test("the publisher role registers the run and publishes a durable result through the real path", async t => {
  const { f, jobId, attemptId, profile, authorityDigest } = await setup(t, "run:publisher-role-a");
  await installRole(f.raw, "local_result_publisher_roles.sql", "control_room_local_result_publisher", "publisher_login_test_a");
  const restricted = restrictedClient(f.db, "publisher_login_test_a");
  const storage = new InMemoryArtifactStorage();
  const publish = createOwnerTrustedLocalCliPublishV1({
    db: restricted, runIntegrityKey: f.harnessKey, registerRun,
    publication: { db: restricted, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage,
      storageClass: "local" as const, reservations: createDurableReservationPostgresPortV1() },
  });
  const packet = delivery("run:publisher-role-a", jobId, attemptId, "worker:publisher:mac-1",
    authorityDigest, profile, f.reviewKey);
  const signal = new AbortController().signal;
  await publish({ delivery: packet, receipt: accepted(packet, at(2_000)),
    text: "Published entirely as the publisher role.", signal });

  // Recorded outside the restricted session, proving the real path's writes landed.
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, "run:publisher-role-a"])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_durable_result_write_reservations WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, "run:publisher-role-a"])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, "run:publisher-role-a"])).rows.length, 1);
  assert.equal((await f.db.query("SELECT 1 AS present FROM control_native_artifact_receipts WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, "run:publisher-role-a"])).rows.length, 1);

  // Replaying the same delivery stays idempotent through the real path.
  await publish({ delivery: packet, receipt: accepted(packet, at(2_000)),
    text: "Published entirely as the publisher role.", signal });
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM control_native_artifact_receipts WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, "run:publisher-role-a"])).rows[0]?.n, 1);

  // Negative probes: none of these belong to the publisher role. Each runs in
  // its own transaction — a denied statement aborts the whole transaction, so
  // reusing one across probes would make every probe after the first report
  // "transaction aborted" (25P02) instead of the privilege denial itself.
  const probe = (sql: string, params: readonly unknown[] = []) =>
    restricted.transaction(tx => deniedInSession(tx, sql, params));
  assert.equal(await probe("UPDATE control_jobs SET state=state WHERE tenant_id=$1 AND id=$2", [binding.tenantId, jobId]), true);
  assert.equal(await probe("UPDATE control_attempts SET state=state WHERE tenant_id=$1 AND id=$2", [binding.tenantId, attemptId]), true);
  assert.equal(await probe("UPDATE control_harness_runs SET state=state WHERE tenant_id=$1 AND id=$2", [binding.tenantId, "run:publisher-role-a"]), true);
  assert.equal(await probe("INSERT INTO control_native_task_queue DEFAULT VALUES"), true);
  assert.equal(await probe(
    "INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,record_digest,record_auth_tag,payload,occurred_at) " +
    "VALUES('target:x',$1,$2,'target','key:x','subject:x',$3,$4,'{}'::jsonb,now())",
    [binding.tenantId, binding.projectId, sha256Digest("e"), `hmac-sha256:${"e".repeat(64)}`]), true);
  assert.equal(await probe("DELETE FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2", [binding.tenantId, "run:publisher-role-a"]), true);
});

test("the publisher role's own run registration is idempotent, not a second row", async t => {
  const { f, jobId, attemptId, profile, authorityDigest } = await setup(t, "run:publisher-role-b");
  await installRole(f.raw, "local_result_publisher_roles.sql", "control_room_local_result_publisher", "publisher_login_test_b");
  const restricted = restrictedClient(f.db, "publisher_login_test_b");
  const publish = createOwnerTrustedLocalCliPublishV1({
    db: restricted, runIntegrityKey: f.harnessKey, registerRun,
    publication: { db: restricted, integrityKey: f.resultKey, reviewKey: f.reviewKey,
      storage: new InMemoryArtifactStorage(), storageClass: "local" as const,
      reservations: createDurableReservationPostgresPortV1() },
  });
  const packet = delivery("run:publisher-role-b", jobId, attemptId, "worker:publisher:mac-2",
    authorityDigest, profile, f.reviewKey);
  const signal = new AbortController().signal;
  await publish({ delivery: packet, receipt: accepted(packet, at(2_000)), text: "First registration.", signal });
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, "run:publisher-role-b"])).rows[0]?.n, 1);
  // A second publish of the same delivery replays instead of inserting again.
  await publish({ delivery: packet, receipt: accepted(packet, at(2_000)), text: "First registration.", signal });
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, "run:publisher-role-b"])).rows[0]?.n, 1);
});

test("the native results role submits a published result for review through the real service", async t => {
  const { f, jobId, attemptId, profile, authorityDigest } = await setup(t, "run:publisher-role-c");
  await installRole(f.raw, "local_result_publisher_roles.sql", "control_room_local_result_publisher", "publisher_login_test_c");
  await installRole(f.raw, "native_results_roles.sql", "control_room_native_results", "results_login_test_c");
  const asPublisher = restrictedClient(f.db, "publisher_login_test_c");
  const asResults = restrictedClient(f.db, "results_login_test_c");
  const storage = new InMemoryArtifactStorage();

  // Publish as the publisher login first: the review submission reads the
  // receipt back rather than trusting anything the publisher returned.
  const publish = createOwnerTrustedLocalCliPublishV1({
    db: asPublisher, runIntegrityKey: f.harnessKey, registerRun,
    publication: { db: asPublisher, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage,
      storageClass: "local" as const, reservations: createDurableReservationPostgresPortV1() },
  });
  const packet = delivery("run:publisher-role-c", jobId, attemptId, "worker:publisher:mac-3",
    authorityDigest, profile, f.reviewKey);
  await publish({ delivery: packet, receipt: accepted(packet, at(2_000)),
    text: "Ready for review.", signal: new AbortController().signal });

  // Now the native-results login registers the pending review target.
  const service = new DurableResultReviewSubmissionServiceV1(asResults, { integrityKey: f.resultKey,
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints, storageClass: "local", storage });
  const submitted = await service.submit(binding.tenantId, "run:publisher-role-c");
  assert.equal(submitted.replayed, false);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM control_completion_gate_records WHERE tenant_id=$1 AND kind='target'",
    [binding.tenantId])).rows[0]?.n, 1);
  const replay = await service.submit(binding.tenantId, "run:publisher-role-c");
  assert.equal(replay.replayed, true);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM control_completion_gate_records WHERE tenant_id=$1 AND kind='target'",
    [binding.tenantId])).rows[0]?.n, 1);
});
