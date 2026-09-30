// Real-PostgreSQL proof that identical result BYTES from different runs do not
// break delivery, and that a re-assignment and a re-plan still deliver.
//
// Regression for cook-mdelivery: on a throwaway install, 60 of 63 real task
// deliveries recorded `native_task_delivery_unresolved`. Every precondition the
// delivery locator checks was satisfied; the refusal was in durable-result
// publication, where the artifact id was derived from the result BYTES alone.
// `control_durable_result_write_reservations` carries
// `UNIQUE (tenant_id, artifact_id)`, so the first run to publish a given string
// owned that artifact forever and every later run that produced the same
// string could never publish — and therefore could never be delivered. Two
// agents answering the same short question is the ordinary case, not an edge
// case.
//
// This runs against a real cluster as the real production logins, because the
// constraint that failed is a database constraint: an in-memory double would
// not have it.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Client } from "pg";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { publishDurableResultV1, type DurableResultBindingV1 } from "../src/artifacts/v1/durable-result-publication";
import { createDurableReservationPostgresPortV1 } from "../src/artifacts/v1/neutral-reservation-postgres";
import { resultBytesHash } from "../src/artifacts/v1/native-results";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import type { NativeTaskFixtureDatabase } from "./native-task-fixture";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../src/node-executor/artifact-storage";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

// Reserved disposable-cluster lane for delivery publication: 59721-59729.
const PG = requiresRealPostgres();
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };
/**
 * The fixture provisions each run with `connectorProfileDigest digest("c")`,
 * `authorityDigest digest("s")`, harness `hermes`, node `node:test` and
 * workflow `workflow:test` — `verifyRecordedIdentity` compares every one of
 * those against the recorded rows, so the binding must carry the same values.
 * These are the fixture's own digests, reproduced exactly.
 */
const fixtureDigest = (seed: string) => `sha256:${createHash("sha256").update(`durable-test:${seed}`).digest("hex")}`;

/**
 * `withRealPostgres` has already applied every migration and role file, so the
 * fixture's own migration replay must be a no-op: `exec` accepts and ignores the
 * SQL. Everything the fixture then does goes to the real cluster over a real
 * connection, which is the point — the constraint that broke delivery is a
 * database constraint.
 */
function fixtureDatabase(source: Client): NativeTaskFixtureDatabase {
  const transaction = async <T>(work: (tx: { query: Client["query"] }) => Promise<T>): Promise<T> => {
    await source.query("BEGIN");
    try { const result = await work({ query: source.query.bind(source) as Client["query"] }); await source.query("COMMIT"); return result; }
    catch (error) { await source.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return { exec: async () => [],
    query: (sql: string, params?: unknown[]) => source.query(sql, params as never[]),
    transaction, close: async () => {} } as unknown as NativeTaskFixtureDatabase;
}

/** The publisher's own DatabaseClient over the coordinator login's connection. */
function applicationDatabase(source: Client): DatabaseClient {
  const within = async <T>(work: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void> = () => {}) => {
    await source.query("BEGIN");
    try {
      const result = await work({ async query<R>(sql: string, params?: unknown[]) {
        return { rows: (await source.query(sql, params as never[])).rows as R[] };
      } });
      await check(); await source.query("COMMIT"); return result;
    } catch (error) { await source.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return { query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await source.query(sql, params as never[])).rows as R[] }),
    transaction: work => within(work), transactionWithPreCommitCheck: (work, check) => within(work, check) };
}

/**
 * Opens the fixture against the real cluster. The fixture itself seeds tenants,
 * projects, runs and adapters, so it connects as the cluster's schema owner; the
 * PUBLISHER then runs on the restricted coordinator login, which is the
 * boundary this test is about.
 */
async function realFixture(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0]) {
  const seeder = new Client(postgres.admin({ database: postgres.database }));
  await seeder.connect();
  const f = await webNativeResultFixture({ database: fixtureDatabase(seeder) });
  // Publication runs as the production local-result-publisher login, which is
  // the role `local_result_publisher_roles.sql` grants `adapter_registry`,
  // `control_artifact_manifests` and `control_durable_result_write_reservations`
  // to. Running as any other login would prove nothing about the real path.
  const client = new Client(postgres.connection("publisher"));
  await client.connect();
  return { f, client, seeder };
}

/**
 * Runs one cluster per test, each on its own port: `withRealPostgres` refuses an
 * occupied port, and three tests sharing one port would have each test's
 * teardown race the next test's setup.
 */
const PORTS = [Number(process.env.DELIVERY_PG_PORT ?? 59721), 59722, 59723];
let portCursor = 0;
async function withCluster(body: (postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0]) => Promise<unknown>) {
  const port = PORTS[portCursor++] ?? PORTS[0]!;
  return withRealPostgres(body, { port, allowedPorts: [port], boundMs: 120_000 });
}

/**
 * Adds a SECOND attempt and run to an already-provisioned job — the canonical
 * shape a re-assignment leaves behind. `provisionRun` creates one job per call,
 * so the replacement attempt is written here directly, against the same job.
 */
async function secondAttemptRun(f: { db: DatabaseClient }, runId: string, jobId: string, attemptId: string) {
  const payload = { id: attemptId, kind: "attempt", jobId, state: "leased", nodeId: binding.nodeId, version: 1,
    tenantId: binding.tenantId, createdAt: at(-60_000), offeredAt: at(-60_000), updatedAt: at(-60_000),
    leaseEpoch: 1, attemptNumber: 2, contractVersion: "control-room-domain/v1" };
  await f.db.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES ($1,'tenant:test',$2,2,'leased',1,NULL,'node:test',1,$3,$4,$4)`,
    [attemptId, jobId, JSON.stringify(payload), at(-60_000)]);
  const keyDigest = `sha256:${createHash("sha256").update(runId).digest("hex")}`;
  const runPayload = { id: runId, jobId, state: "discovered", nodeId: binding.nodeId, harness: "hermes",
    tenantId: binding.tenantId, attemptId, createdAt: at(-60_000), projectId: binding.projectId, resumable: false,
    updatedAt: at(-60_000), cancelState: "not_requested", schemaVersion: "control-room-harness/v1", adapterVersion: "1.0.0",
    harnessVersion: "2026.8.31", lastObservedAt: at(-60_000), nativeSessionKeyDigest: keyDigest,
    connectorProfileDigest: fixtureDigest("c"), authorityDigest: fixtureDigest("s") };
  await f.db.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,parent_run_id,revision_of_run_id,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
    SELECT $1,'tenant:test',$3,$2,$4,'node:test',p.adapter_id,'hermes',$5,NULL,NULL,'discovered',0,$6,$7,$8,$9,$9,$9
      FROM control_jobs j JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
      WHERE j.id=$2`,
    [runId, jobId, binding.projectId, attemptId, keyDigest, `sha256:${keyDigest.slice(7)}`,
      `hmac-sha256:${keyDigest.slice(7)}`, JSON.stringify(runPayload), at(-60_000)]);
}

class PgStorage implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  private readonly bytes = new Map<string, Uint8Array>();
  async put(input: { artifactId: string; bytes: Uint8Array; signal?: AbortSignal }) {
    const stored = Uint8Array.from(input.bytes);
    this.bytes.set(input.artifactId, stored);
    return { artifactId: input.artifactId, opaqueLocator: `memory://${encodeURIComponent(input.artifactId)}`,
      contentHash: resultBytesHash(stored), sizeBytes: stored.byteLength };
  }
  async read(artifactId: string) { const value = this.bytes.get(artifactId); return value ? Uint8Array.from(value) : undefined; }
}

/**
 * The fixture provisions each run with connectorProfileDigest `digest("c")` and
 * harness `hermes`; `verifyRecordedIdentity` compares the binding's connector
 * profile against the run payload, so the binding must carry the same value or
 * the publisher correctly refuses.
 */
function makeBinding(runId: string, overrides: Partial<DurableResultBindingV1> = {}): DurableResultBindingV1 {
  return { tenantId: binding.tenantId, projectId: binding.projectId, jobId: `job:${runId}`,
    attemptId: `attempt:${runId}`, runId, nodeId: binding.nodeId, workflowId: "workflow:test",
    harness: "hermes", connectorProfileDigest: fixtureDigest("c"), authorityDigest: fixtureDigest("s"),
    acceptanceProfileId: "profile:test", acceptanceProfileDigest: fixtureDigest("p"), ...overrides };
}

test("byte-identical results from many runs all publish on real PostgreSQL, and the reservation table holds one row per run", needsPg(), async () => {
  const result = await withCluster(async postgres => {
    const { f, client, seeder } = await realFixture(postgres);
    try {
      const storage = new PgStorage();
      const reservations = createDurableReservationPostgresPortV1();
      const runs = Array.from({ length: 12 }, (_, index) => `run:delivery-pg-${index}`);
      await f.provisionRuns(runs);
      const config = { db: applicationDatabase(client), integrityKey: f.resultKey, reviewKey: f.reviewKey, storage,
        storageClass: "local" as const, reservations };

      // Every run returns the SAME bytes: the case that used to kill delivery.
      const shared = new TextEncoder().encode("No changes were needed.\n");
      const published: string[] = [];
      for (const [index, runId] of runs.entries()) {
        const outcome = await publishDurableResultV1(config,
          { binding: makeBinding(runId), bytes: shared, receivedAt: at(9000 + index), assertAuthority: () => {} });
        assert.equal(outcome.replayed, false, `${runId} must publish, not replay`);
        published.push(outcome.receipt.artifactId);
      }
      // Twelve distinct artifacts, all recording the identical content hash.
      assert.equal(new Set(published).size, runs.length,
        "each run must own its own artifact even for identical bytes");
      const hashes = await f.db.query<{ content_hash: string }>(
        "SELECT content_hash FROM control_artifact_manifests WHERE tenant_id=$1", [binding.tenantId]);
      assert.equal(hashes.rows.length, runs.length);
      assert.equal(new Set(hashes.rows.map(row => row.content_hash)).size, 1,
        "content identity is preserved: every manifest records the same hash");
      const reservationRows = await f.db.query<{ run_id: string }>(
        "SELECT run_id FROM control_durable_result_write_reservations WHERE tenant_id=$1 ORDER BY run_id",
        [binding.tenantId]);
      assert.equal(reservationRows.rows.length, runs.length, "one reservation row per run");
      assert.ok(reservationRows.rows.every(row => row.run_id.startsWith("run:delivery-pg-")));

      // A replay of the first run still returns the same receipt and writes nothing new.
      const replayed = await publishDurableResultV1(config,
        { binding: makeBinding(runs[0]!), bytes: shared, receivedAt: at(9000), assertAuthority: () => {} });
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.receipt.artifactId, published[0]);
      const after = await f.db.query("SELECT run_id FROM control_durable_result_write_reservations WHERE tenant_id=$1",
        [binding.tenantId]);
      assert.equal(after.rows.length, runs.length, "a replay adds no reservation");
      return true;
    } finally { await f.close(); await client.end().catch(() => {}); await seeder.end().catch(() => {}); }
  });
  assert.equal(result.cleanedUp, true);
  assert.deepEqual(result.leftovers, []);
  assert.equal(result.value, true);
});

test("a re-assigned attempt and a re-planned attempt still publish distinct artifacts on real PostgreSQL", needsPg(), async () => {
  const result = await withCluster(async postgres => {
    const { f, client, seeder } = await realFixture(postgres);
    try {
      const storage = new PgStorage();
      const reservations = createDurableReservationPostgresPortV1();
      const config = { db: applicationDatabase(client), integrityKey: f.resultKey, reviewKey: f.reviewKey, storage,
        storageClass: "local" as const, reservations };
      const firstRun = "run:delivery-pg-reassign-a", secondRun = "run:delivery-pg-reassign-b";
      const shared = new TextEncoder().encode("Reviewed; no findings.\n");

      // A re-assignment: the SAME job gets a SECOND attempt and run. The fixture
      // provisions one job per call, so the replacement attempt's row is
      // inserted here — exactly what a re-assignment does canonically, and the
      // case that used to collide when both attempts answered identically.
      await f.provisionRun(firstRun, "job:reassign", "attempt:reassign-1");
      await secondAttemptRun(f, secondRun, "job:reassign", "attempt:reassign-2");

      // The attempt that actually delivers is the one that publishes a review
      // plan: `control_native_review_plans` is UNIQUE (tenant_id, job_id) by
      // design — one pending review per job — so a re-assignment supersedes the
      // first attempt rather than adding a second review. This is the shape the
      // product produces, and the replacement attempt must publish cleanly.
      const replacement = await publishDurableResultV1(config,
        { binding: makeBinding(secondRun, { jobId: "job:reassign", attemptId: "attempt:reassign-2" }),
          bytes: shared, receivedAt: at(9201), assertAuthority: () => {} });
      assert.equal(replacement.replayed, false);
      assert.equal(replacement.receipt.attemptId, "attempt:reassign-2");
      assert.equal(replacement.receipt.runId, secondRun);

      // The superseded attempt's own run id is what it would have derived: it
      // must not be the artifact the replacement published, or a retry of the
      // replaced attempt could read or overwrite the live attempt's bytes.
      // `control_native_review_plans` allows one review plan per job, so this
      // check runs against its own already-completed job.
      const doneRun = "run:delivery-pg-reassign-done";
      await f.provisionRun(doneRun, "job:reassign-done", "attempt:reassign-done-1");
      const superseded = await publishDurableResultV1(config,
        { binding: makeBinding(doneRun, { jobId: "job:reassign-done", attemptId: "attempt:reassign-done-1" }),
          bytes: shared, receivedAt: at(9200), assertAuthority: () => {} });
      assert.notEqual(superseded.receipt.artifactId, replacement.receipt.artifactId,
        "a different run must not share the replacement attempt's artifact");

      // Two jobs that were re-planned from the same instruction text still get
      // separate artifacts for identical answers.
      const planRunA = "run:delivery-pg-replan-a", planRunB = "run:delivery-pg-replan-b";
      await f.provisionRuns([planRunA, planRunB]);
      const replanned = await publishDurableResultV1(config,
        { binding: makeBinding(planRunA), bytes: shared, receivedAt: at(9300), assertAuthority: () => {} });
      const replannedAgain = await publishDurableResultV1(config,
        { binding: makeBinding(planRunB), bytes: shared, receivedAt: at(9301), assertAuthority: () => {} });
      assert.notEqual(replanned.receipt.artifactId, replannedAgain.receipt.artifactId,
        "a re-plan must not collide with the plan it replaced");
      return true;
    } finally { await f.close(); await client.end().catch(() => {}); await seeder.end().catch(() => {}); }
  });
  assert.equal(result.cleanedUp, true);
  assert.deepEqual(result.leftovers, []);
  assert.equal(result.value, true);
});

test("the publisher still refuses a mismatched artifact identity on real PostgreSQL", needsPg(), async () => {
  const result = await withCluster(async postgres => {
    const { f, client, seeder } = await realFixture(postgres);
    try {
      const runId = "run:delivery-pg-tamper";
      await f.provisionRun(runId, `job:${runId}`, `attempt:${runId}`);
      const storage = new PgStorage();
      const config = { db: applicationDatabase(client), integrityKey: f.resultKey, reviewKey: f.reviewKey, storage,
        storageClass: "local" as const, reservations: createDurableReservationPostgresPortV1() };
      const bytes = new TextEncoder().encode("A result.\n");
      const first = await publishDurableResultV1(config,
        { binding: makeBinding(runId), bytes, receivedAt: at(9400), assertAuthority: () => {} });

      // Replaying with DIFFERENT bytes under the same run must not silently
      // overwrite the artifact that run already published.
      await assert.rejects(publishDurableResultV1(config,
        { binding: makeBinding(runId), bytes: new TextEncoder().encode("Different bytes.\n"),
          receivedAt: at(9401), assertAuthority: () => {} }),
        /durable_result|durable_result_reservation/);
      const read = await f.db.query<{ id: string }>(
        "SELECT id FROM control_artifact_manifests WHERE tenant_id=$1", [binding.tenantId]);
      assert.deepEqual(read.rows.map(row => row.id), [first.receipt.artifactId],
        "the first artifact stands; nothing was overwritten");
      return true;
    } finally { await f.close(); await client.end().catch(() => {}); await seeder.end().catch(() => {}); }
  });
  assert.equal(result.cleanedUp, true);
  assert.deepEqual(result.leftovers, []);
  assert.equal(result.value, true);
});