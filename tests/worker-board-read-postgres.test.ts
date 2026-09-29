// Real PostgreSQL proof for the worker-board read.  This deliberately uses the
// production web role: a fake database client cannot demonstrate that the
// browser-facing read has only the permissions it needs.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { DatabaseWorkerBoardReadSourceV1 } from "../src/web/v1/worker-board-read";

// Reserved disposable-cluster lane for this job: 58910-58911.
const PORT = Number(process.env.WORKER_BOARD_PG_PORT ?? 58910);
const PORTS = [58910, 58911];
const PG = requiresRealPostgres();

test("worker-board attribution runs as the production web role and remains bounded on an empty fleet", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const client = new Client(postgres.connection("web")); await client.connect();
    try {
      // The source is a read-only query port; bind only that port from the
      // production-role client rather than granting this test a transaction or
      // mutation capability it does not exercise.
      const view = await new DatabaseWorkerBoardReadSourceV1({ query: client.query.bind(client) } as never)
        .read({ tenantId: "tenant:worker-board", now: "2026-09-29T12:00:00.000Z" });
      assert.deepEqual(view.workers, []);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 60_000 });
});

const AUTHORITY_DIGEST = `sha256:${"a".repeat(64)}`;
const CONTRACT = "control-room-domain/v1";
const TENANT = "tenant:worker-board-fixture";
const NODE = "node:worker-board-fixture";

/** A minimal `jobRecordSchema`-valid payload, following the same shape the unit
 * test's `validJob` fixture uses. */
function jobPayload(id: string, workflowId: string, state: string, at: string) {
  return {
    id, kind: "job", tenantId: TENANT, contractVersion: CONTRACT, workflowId, projectId: "project:worker-board-fixture",
    jobType: `fixture.${id}`, specVersion: "1.0.0", inputDigest: `sha256:${"a".repeat(64)}`,
    state, version: 1, createdAt: at, updatedAt: at, priority: 1, requiredCapability: "fixture", dependsOnJobIds: [],
    authority: { projectId: "project:worker-board-fixture", allowedExecutor: "adapter:worker-board-fixture",
      allowedOperations: ["execute"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none",
      allowedNetworkDestinations: [], effectPolicy: "preauthorized", maxRisk: "low", maxDurationSeconds: 60,
      maxConcurrentEffects: 1, expiresAt: "2026-12-31T00:00:00.000Z", digest: AUTHORITY_DIGEST },
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" },
  };
}

/** Seeds one request/workflow/job/attempt quadruple as the cluster admin — the
 * fixture writer, never the role under test. `jobState` and `attemptState` are
 * set together, matching how the coordinator would leave a job whose only
 * attempt is in that state. */
async function seedJobAttempt(admin: Client, suffix: string,
  input: { jobState: string; attemptState: string; at: string }) {
  const ids = { request: `request:wb-${suffix}`, workflow: `workflow:wb-${suffix}`, job: `job:wb-${suffix}`, attempt: `attempt:wb-${suffix}` };
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,'project:worker-board-fixture','accepted',0,$1,jsonb_build_object('id',$1::text,'kind','request',
      'tenantId',$2::text,'projectId','project:worker-board-fixture','contractVersion',$3::text,'title','Fixture',
      'objective','Fixture.','state','accepted','version',0,'priority',50,
      'requestedBy',jsonb_build_object('actorId','identity:wb-fixture','actorType','human'),
      'idempotencyKey',$1::text,'createdAt',$4::text,'updatedAt',$4::text),$4::timestamptz,$4::timestamptz)`,
  [ids.request, TENANT, CONTRACT, input.at]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,'project:worker-board-fixture',$4,'active',1,jsonb_build_object('id',$1::text,'kind','workflow',
      'tenantId',$2::text,'requestId',$3::text,'projectId','project:worker-board-fixture','contractVersion',$5::text,
      'definitionVersion','1.0.0','definitionDigest',$4::text,'authorityMode','control_room_native','state','active',
      'version',1,'jobIds',jsonb_build_array($6::text),'createdAt',$7::text,'updatedAt',$7::text),$7::timestamptz,$7::timestamptz)`,
  [ids.workflow, TENANT, ids.request, AUTHORITY_DIGEST, CONTRACT, ids.job, input.at]);
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,'project:worker-board-fixture',$4,1,1,'fixture',$5,$6::jsonb,$7::timestamptz,$7::timestamptz)`,
  [ids.job, TENANT, ids.workflow, input.jobState, AUTHORITY_DIGEST, JSON.stringify(jobPayload(ids.job, ids.workflow, input.jobState, input.at)), input.at]);
  await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,$4,1,$5,1,jsonb_build_object('id',$1::text,'kind','attempt','tenantId',$2::text,
      'contractVersion',$6::text,'jobId',$3::text,'state',$4::text,'version',1,'nodeId',$5::text,
      'attemptNumber',1,'leaseEpoch',1,'createdAt',$7::text,'updatedAt',$7::text),$7::timestamptz,$7::timestamptz)`,
  [ids.attempt, TENANT, ids.job, input.attemptState, NODE, CONTRACT, input.at]);
  return ids;
}

test("worker-board attribution reports a real worker's current task and its three most recent results, bounded to the production web role", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const now = new Date();
    const at = (offsetSeconds: number) => new Date(now.getTime() + offsetSeconds * 1000).toISOString();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
      await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
        VALUES($1,$2,'active',0,$3,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',0,
          'identityKeyId',$3::text),$4::timestamptz,$4::timestamptz)`,
      [NODE, TENANT, "key:worker-board-fixture", at(-3_600)]);

      // The current, non-terminal attempt: running, with an active lease so
      // `current_since` proves the lease-preferred COALESCE branch.
      const current = await seedJobAttempt(admin, "current", { jobState: "running", attemptState: "running", at: at(-300) });
      const leaseAcquiredAt = at(-120);
      await admin.query(`INSERT INTO control_leases(id,tenant_id,job_id,attempt_id,node_id,epoch,state,version,acquired_at,expires_at,payload,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,1,'active',0,$6::timestamptz,$7::timestamptz,jsonb_build_object('id',$1::text,
          'kind','lease','tenantId',$2::text,'contractVersion',$8::text,'jobId',$3::text,'attemptId',$4::text,
          'nodeId',$5::text,'epoch',1,'state','active','version',0,'acquiredAt',$6::text,'expiresAt',$7::text),
          $6::timestamptz,$6::timestamptz)`,
      ["lease:wb-current", TENANT, current.job, current.attempt, NODE, leaseAcquiredAt, at(3_600), CONTRACT]);

      // Three terminal attempts, oldest to newest, so DESC ordering is provable.
      const succeeded = await seedJobAttempt(admin, "succeeded", { jobState: "succeeded", attemptState: "succeeded", at: at(-900) });
      const failed = await seedJobAttempt(admin, "failed", { jobState: "failed", attemptState: "failed", at: at(-600) });
      const orphaned = await seedJobAttempt(admin, "orphaned", { jobState: "orphaned", attemptState: "orphaned", at: at(-450) });
      // A fourth, older-still terminal attempt proves the LIMIT 3 cap, not just
      // that three happen to be present.
      await seedJobAttempt(admin, "cancelled", { jobState: "cancelled", attemptState: "cancelled", at: at(-1_200) });

      const direct = new Client(postgres.connection("web"));
      await direct.connect();
      try {
        const roles = await direct.query<{ current_user: string; rolsuper: boolean }>(
          "SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user");
        assert.equal(roles.rows[0]!.current_user, "control_room_web");
        assert.equal(roles.rows[0]!.rolsuper, false, "the read must not run as a superuser");

        const view = await new DatabaseWorkerBoardReadSourceV1({ query: direct.query.bind(direct) } as never)
          .read({ tenantId: TENANT, now: now.toISOString() });

        assert.equal(view.workers.length, 1, `expected exactly one worker, got ${JSON.stringify(view.workers)}`);
        const worker = view.workers[0]!;
        assert.equal(worker.workerId, NODE);
        assert.deepEqual(worker.currentTask, { projectId: "project:worker-board-fixture", jobId: current.job,
          title: `fixture.${current.job}`, since: new Date(leaseAcquiredAt).toISOString() });
        assert.equal(worker.recentResults.length, 3, "the read must cap terminal history at three");
        assert.deepEqual(worker.recentResults.map(item => item.jobId), [orphaned.job, failed.job, succeeded.job],
          "results must be newest first and exclude the fourth, older terminal attempt");
        assert.deepEqual(worker.recentResults.map(item => item.status), ["orphaned", "failed", "succeeded"]);
      } finally { await direct.end(); }
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 60_000 });
});
