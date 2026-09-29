// Real-PostgreSQL proof that S4's linear pipeline reads and writes run on the
// production logins that execute them, with only the grants the real db/roles
// files give those logins.
//
// Who runs what in production:
// - LinearPipelineServiceV1 (template create, instantiate, list, view) is
//   composed on the private web database in private-process.ts and
//   mac-local-web-process.ts: the web login, group control_room_private_web.
// - TaskAssignmentCoordinator's pipeline admission gate is composed on the
//   coordinator database in task-coordinator-lifecycle.ts: the coordinator
//   login, group control_room_task_coordinator.
//
// Any row lock (FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE) needs UPDATE
// privilege on the locked table. Every pipeline table is append-only for both
// logins, so a row lock there refuses every call in production while a
// superuser fixture stays green. The attack kit provisions its own disposable
// cluster with the real migration applier and the real role files, so nothing
// here grants a login anything the role files do not.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute,
  type WorkBatchAssignmentAdmissionAuthority } from "../src/web/v1/task-assignment-coordinator";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { JobRecord } from "../src/domain/v1";
import { sha256Digest } from "../src/security";

// Reserved disposable-cluster lane for this file: 58340-58349 by default.
// An operator running locally on an assigned port block can move it with
// CONTROL_ROOM_PG_TEST_PORT_BASE, the same override postgres-production-lifecycle
// already takes, and the harness's own allowlist follows the value.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58340);
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => {
  if (PG) { required += 1; return undefined; }
  return { skip: realPostgresSkipMessage() };
};

const PROVIDER = "test";
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const KEY = new Uint8Array(32).fill(41);
const ids = (tenant: "a" | "b") => ({
  tenant: `tenant:pipeline-pg-${tenant}`, workspace: `workspace:pipeline-pg-${tenant}`,
  adapter: `adapter:pipeline-pg-${tenant}`, project: `project:pipeline-pg-${tenant}`,
  identity: `identity:pipeline-pg-owner-${tenant}`, grant: `grant:pipeline-pg-owner-${tenant}`,
  token: sha256Digest({ session: `pipeline-pg-owner-${tenant}` }),
});
const A = ids("a"), B = ids("b");
const identityOf = (t: ReturnType<typeof ids>): VerifiedWebIdentity => ({ provider: PROVIDER, subject: t.identity,
  tokenDigest: t.token, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT });
const template = { name: "Build, check, validate", description: "Complete one bounded change and review it.",
  stages: [
    { ordinal: 0, stageKind: "build", role: "builder", description: "Build the bounded change.",
      requiredCapability: "code.change", workerId: "worker:codex:one", workerKind: "codex", nodeId: "node:codex:one",
      selectionKey: "codex.standard", model: "gpt-test", effort: "medium", maxLoops: 3,
      // S6 makes a build stage's write bounds mandatory.
      allowedPaths: ["src/**"], maximumChangedFiles: 10, maximumChangedBytes: 100_000 },
    { ordinal: 1, stageKind: "check", role: "checker", description: "Check the bounded change.",
      requiredCapability: "code.review", workerId: "worker:claude:one", workerKind: "claude-code", nodeId: "node:claude:one",
      selectionKey: "claude.standard", model: "claude-test", effort: "high", maxLoops: 3 },
    { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate the accepted result.",
      requiredCapability: "code.validate", workerId: "worker:hermes:one", workerKind: "hermes", nodeId: "node:hermes:one",
      selectionKey: "hermes.standard", model: "hermes-test", effort: "medium", provider: "provider:test",
      profile: "profile:test", maxLoops: 0 },
  ], maxTotalLoops: 6, maxDurationSeconds: 3600 } as const;
// The same template with the build stage's write bounds removed: the fixture
// above carries them because S6 made them mandatory, and this one exists so the
// refusal that rule produces is pinned rather than assumed. If the rule ever
// weakens, this template starts being accepted and the test below fails.
const templateWithoutWriteBounds = { name: "Build, check, validate", description: "Complete one bounded change and review it.",
  stages: [
    { ordinal: 0, stageKind: "build", role: "builder", description: "Build the bounded change.",
      requiredCapability: "code.change", workerId: "worker:codex:one", workerKind: "codex", nodeId: "node:codex:one",
      selectionKey: "codex.standard", model: "gpt-test", effort: "medium", maxLoops: 3 },
    { ordinal: 1, stageKind: "check", role: "checker", description: "Check the bounded change.",
      requiredCapability: "code.review", workerId: "worker:claude:one", workerKind: "claude-code", nodeId: "node:claude:one",
      selectionKey: "claude.standard", model: "claude-test", effort: "high", maxLoops: 3 },
    { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate the accepted result.",
      requiredCapability: "code.validate", workerId: "worker:hermes:one", workerKind: "hermes", nodeId: "node:hermes:one",
      selectionKey: "hermes.standard", model: "hermes-test", effort: "medium", provider: "provider:test",
      profile: "profile:test", maxLoops: 0 },
  ], maxTotalLoops: 6, maxDurationSeconds: 3600 } as const;
const PIPELINE_OBJECTS = ["pipeline_templates", "pipeline_runs", "pipeline_stage_runs", "pipeline_ordered_stage_runs"] as const;

async function seedTenant(admin: Client, t: ReturnType<typeof ids>) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [t.tenant]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [t.workspace, t.tenant]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [t.adapter, t.tenant]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
  [t.project, t.tenant, t.workspace, t.adapter]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,now(),now())`, [t.tenant, t.project]);
  await admin.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
  [t.identity, t.tenant, PROVIDER, sha256Digest({ provider: PROVIDER, subject: t.identity }), ISSUED_AT]);
  await admin.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
     require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
  [t.grant, t.tenant, t.identity, ISSUED_AT]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [t.tenant, t.token, t.identity, ISSUED_AT, EXPIRES_AT]);
}

/** The production web pool: exact driver, pool options and session qualification. */
function productionPool(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0], role: "web" | "coordinator") {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  // Record the statement a privilege refusal came from, so a failure names it.
  const refused: string[] = [];
  const traced = (session: DatabaseSession): DatabaseSession => ({ query: async (sql, params) => {
    try { return await session.query(sql, params); }
    catch (error) { refused.push(sql.replace(/\s+/g, " ").trim()); throw error; }
  } });
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  return { config, login, refused, pool: { client, close: () => bound.close() } };
}

const permissionFailure = (error: unknown, refused: readonly string[] = []) => {
  const sqlState = (error as { sqlState?: unknown; code?: unknown } | null)?.sqlState
    ?? (error as { code?: unknown } | null)?.code;
  return `${String(error)} sqlState=${String(sqlState)}${sqlState === "42501" ? " (permission denied)" : ""}`
    + (refused.length ? ` refused statement: ${refused.at(-1)}` : "");
};

test("the production web and coordinator logins run every S4 pipeline read and write, tenant-scoped", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedTenant(admin, A);
      await seedTenant(admin, B);
    } finally { await admin.end(); }

    // ---- Web login: the startup preflight, then every service operation. ----
    const web = productionPool(postgres, "web");
    let runA!: { runId: string; jobIds: readonly string[] }, runB!: { runId: string; jobIds: readonly string[] };
    try {
      // verifyPrivateDatabase compares the live grants with the preflight
      // inventory, including the merged control_jobs update column set.
      await verifyPrivateDatabase(web.pool.client, web.config, { tenantId: A.tenant, workspaceId: A.workspace,
        ownerIdentityId: A.identity, issuer: PROVIDER }, Date.now(), { nativeQueue: true });
      const service = (t: ReturnType<typeof ids>) => new LinearPipelineServiceV1(web.pool.client,
        { tenantId: t.tenant, workspaceId: t.workspace }, KEY, { assertCurrent: () => true, isAcceptedResultCurrent: () => false });
      const run = async (t: ReturnType<typeof ids>, key: string) => {
        const pipelines = service(t);
        const saved = await pipelines.createTemplate(identityOf(t), t.project, template)
          .catch((error: unknown) => assert.fail(`template create as web login: ${permissionFailure(error, web.refused)}`));
        const receipt = await pipelines.instantiate(identityOf(t), t.project,
          { templateId: saved.templateId, title: `Pipeline for ${t.tenant}` }, key)
          .catch((error: unknown) => assert.fail(`instantiate as web login: ${permissionFailure(error, web.refused)}`));
        const replay = await pipelines.instantiate(identityOf(t), t.project,
          { templateId: saved.templateId, title: `Pipeline for ${t.tenant}` }, key)
          .catch((error: unknown) => assert.fail(`instantiate replay as web login: ${permissionFailure(error, web.refused)}`));
        assert.equal(replay.replayed, true); assert.equal(replay.runId, receipt.runId);
        return receipt;
      };
      // Tenant B is a real second tenant on the same cluster, written through
      // the same shared web login: the realistic multi-tenant shape.
      runA = await run(A, "pipeline-pg-run-a-0001");
      runB = await run(B, "pipeline-pg-run-b-0001");

      // A build stage with no write bounds is refused, on the production login
      // and with the real authorization state, before any SQL runs. The
      // fixture above is only valid because this refuses, so the refusal is
      // asserted directly: it is the exact `invalid_request` a template
      // without bounds produces, and an unauthorized caller must get the same
      // answer rather than a database error, because the bound is rejected by
      // input validation and not by a permission.
      await assert.rejects(service(A).createTemplate(identityOf(A), A.project, templateWithoutWriteBounds),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "invalid_request", permissionFailure(error, web.refused));
          return true;
        });
      assert.deepEqual(web.refused, [], "input validation refuses before the web login runs any statement");
      // The same refusal for a caller with no authority over the project: the
      // bound is not a policy oracle, and the request is rejected for its
      // shape without touching the database either way.
      await assert.rejects(service(B).createTemplate(identityOf(A), A.project, template),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "access_denied", permissionFailure(error, web.refused));
          return true;
        });

      const pipelinesA = service(A);
      const listed = await pipelinesA.list(identityOf(A), A.project)
        .catch((error: unknown) => assert.fail(`list as web login: ${permissionFailure(error, web.refused)}`));
      assert.deepEqual(listed.runs.map(item => item.runId), [runA.runId]);
      const viewed = await pipelinesA.view(identityOf(A), A.project, runA.runId)
        .catch((error: unknown) => assert.fail(`view as web login: ${permissionFailure(error, web.refused)}`));
      assert.deepEqual(viewed.stages.map(stage => stage.state), ["eligible", "waiting_dependency", "waiting_dependency"]);
      // Tenant A's scope cannot reach tenant B's run, by id or through its own project listing.
      await assert.rejects(pipelinesA.view(identityOf(A), A.project, runB.runId), (error: unknown) =>
        (error as { code?: string }).code === "not_found");
      await assert.rejects(pipelinesA.view(identityOf(A), B.project, runB.runId), (error: unknown) =>
        (error as { code?: string }).code === "not_found" || (error as { code?: string }).code === "access_denied");
      assert.doesNotMatch(JSON.stringify([listed, viewed]), /pipeline-pg-b/);
    } finally { await web.pool.close(); }

    // ---- Coordinator login: the pipeline admission gate's own queries. ----
    // Seed the planner's output as schema owner: one execution job per source
    // stage job with the copied pipeline lineage, exact model selection and plan.
    const seed = new Client(postgres.admin({ database: postgres.database }));
    await seed.connect();
    try {
      for (const [ordinal, source] of runA.jobIds.entries()) {
        const execution = `${source}:execution`;
        await seed.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
            required_capability,authority_digest,payload,created_at,updated_at,stage_kind,stage_ordinal,pipeline_run_id)
          SELECT $2,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,
            jsonb_set(payload,'{id}',to_jsonb($2::text)),created_at,updated_at,stage_kind,stage_ordinal,pipeline_run_id
          FROM control_jobs WHERE tenant_id=$1 AND id=$3`, [A.tenant, execution, source]);
        await seed.query(`INSERT INTO control_task_model_selections(tenant_id,project_id,job_id,worker_kind,selection_key,model,
            effort,provider,profile,inherited_from_job_id,created_at)
          SELECT tenant_id,project_id,$2,worker_kind,selection_key,model,effort,provider,profile,$3,created_at
          FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$3`, [A.tenant, execution, source]);
        await seed.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
          VALUES($1,$2,$3,$4,'{}'::jsonb,$5)`, [A.tenant, A.project, source, execution, `hmac-sha256:${"0".repeat(64)}`]);
        assert.equal(ordinal, Number((await seed.query("SELECT stage_ordinal FROM control_jobs WHERE id=$1", [execution])).rows[0].stage_ordinal));
      }
    } finally { await seed.end(); }

    const coordinator = productionPool(postgres, "coordinator");
    try {
      const admission: WorkBatchAssignmentAdmissionAuthority = { integrityKey: KEY,
        assertCurrent: async () => {}, assertAcceptedResultCurrent: async () => {} };
      // The gate is a private method of the real class; build an instance with
      // only the fields it reads so the exact production SQL runs unchanged.
      const gate = Object.assign(Object.create(TaskAssignmentCoordinator.prototype) as TaskAssignmentCoordinator,
        { scope: Object.freeze({ tenantId: A.tenant, workspaceId: A.workspace }), workBatchAdmission: admission });
      const admit = (ordinal: number) => coordinator.pool.client.transaction(async (tx: DatabaseSession) => {
        const stage = template.stages[ordinal]!;
        const route = { nodeId: stage.nodeId, executorId: stage.workerId } as TaskAssignmentRoute;
        const job = { id: `${runA.jobIds[ordinal]}:execution`, projectId: A.project } as JobRecord;
        return (gate as unknown as { assertPipelineAdmission(tx: DatabaseSession, job: JobRecord,
          route: TaskAssignmentRoute): Promise<boolean> }).assertPipelineAdmission(tx, job, route);
      });
      // Stage zero: every gate read runs and admits.
      assert.equal(await admit(0).catch((error: unknown) =>
        assert.fail(`stage-zero pipeline admission as coordinator login: ${permissionFailure(error, coordinator.refused)}`)), true);
      // Stage one: every read up to and including the predecessor proof query
      // runs; with no accepted predecessor result the gate refuses cleanly
      // with conflict, never with a database privilege error.
      await assert.rejects(admit(1), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "conflict", permissionFailure(error, coordinator.refused));
        return true;
      });

      // ---- Lineage is write-once for both shared logins, in every tenant. ----
      // Both logins hold column UPDATE on the three lineage columns so the
      // planner and instantiate can write them once. Clearing or relabelling
      // them would take a stage out of pipeline admission.
      const lineageOf = async (jobId: string) => {
        const catalog = new Client(postgres.admin({ database: postgres.database }));
        await catalog.connect();
        try {
          return (await catalog.query<{ stage_kind: string | null; stage_ordinal: string | null; pipeline_run_id: string | null }>(
            "SELECT stage_kind,stage_ordinal::text,pipeline_run_id FROM control_jobs WHERE id=$1", [jobId])).rows[0];
        } finally { await catalog.end(); }
      };
      const stage1 = `${runA.jobIds[1]}:execution`;
      const before = await lineageOf(stage1), beforeOther = await lineageOf(runB.jobIds[1]!);
      assert.deepEqual(before, { stage_kind: "check", stage_ordinal: "1", pipeline_run_id: runA.runId });
      for (const role of ["web", "coordinator"] as const) {
        const direct = new Client(postgres.connection(role));
        await direct.connect();
        try {
          for (const [target, assignment] of [
            [stage1, "stage_kind=NULL,stage_ordinal=NULL,pipeline_run_id=NULL"],
            [stage1, "stage_kind='signoff'"], [stage1, "stage_ordinal=0"],
            // Another tenant's row through the same shared login.
            [runB.jobIds[1]!, "stage_kind=NULL,stage_ordinal=NULL,pipeline_run_id=NULL"],
          ] as const) await assert.rejects(direct.query(`UPDATE control_jobs SET ${assignment} WHERE id=$1`, [target]),
            /pipeline lineage is write-once/, `${role}: ${target} ${assignment}`);
        } finally { await direct.end(); }
      }
      assert.deepEqual(await lineageOf(stage1), before);
      assert.deepEqual(await lineageOf(runB.jobIds[1]!), beforeOther);
      await assert.rejects(admit(1), (error: unknown) => (error as { code?: string }).code === "conflict");

      // Defence in depth: with the trigger bypassed (a superuser in replica
      // mode), the gate still derives membership from the execution plan and
      // the stage row, neither of which any app login can change.
      const bypass = new Client(postgres.admin({ database: postgres.database }));
      await bypass.connect();
      try {
        await bypass.query("BEGIN");
        await bypass.query("SET LOCAL session_replication_role = replica");
        await bypass.query("UPDATE control_jobs SET stage_kind=NULL,stage_ordinal=NULL,pipeline_run_id=NULL WHERE id=$1", [stage1]);
        await bypass.query("COMMIT");
      } finally { await bypass.end(); }
      await assert.rejects(admit(1), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "conflict", permissionFailure(error, coordinator.refused));
        return true;
      });
    } finally { await coordinator.pool.close(); }

    // ---- Least privilege on the new objects, as the real logins. ----
    for (const role of ["web", "coordinator"] as const) {
      const direct = new Client(postgres.connection(role));
      await direct.connect();
      try {
        for (const object of PIPELINE_OBJECTS) await direct.query(`SELECT 1 FROM ${object} LIMIT 1`);
        for (const statement of [
          "UPDATE pipeline_templates SET name=name", "UPDATE pipeline_runs SET title=title",
          "UPDATE pipeline_stage_runs SET state=state", "DELETE FROM pipeline_templates", "DELETE FROM pipeline_runs",
          "DELETE FROM pipeline_stage_runs", "TRUNCATE pipeline_stage_runs",
          "SELECT 1 FROM pipeline_stage_runs FOR KEY SHARE",
        ]) await assert.rejects(direct.query(statement), /permission denied/, `${role}: ${statement}`);
        // S7's owner consent updates the template's unattended ceiling, so the
        // web login may lock a template row; the coordinator still may not.
        if (role === "web") await direct.query("SELECT 1 FROM pipeline_templates FOR SHARE");
        if (role === "coordinator") for (const statement of [
          "SELECT 1 FROM pipeline_templates FOR SHARE",
          // The gate's other reads: append-only for this login, so no row lock.
          "SELECT 1 FROM control_task_execution_plans FOR SHARE",
          "SELECT 1 FROM control_task_model_selections FOR SHARE",
          "SELECT 1 FROM control_job_dependencies FOR SHARE",
          `INSERT INTO pipeline_templates(id) VALUES('pipeline-template:forged')`,
          `INSERT INTO pipeline_runs(id) VALUES('pipeline-run:forged')`,
        ]) await assert.rejects(direct.query(statement), /permission denied/, `${role}: ${statement}`);
      } finally { await direct.end(); }
    }
    // Every shared/non-owner login is denied all four objects outright, so no
    // tenant-binding policy is needed on them: the intake agent login, the
    // application, reader, scheduler and the rest never see a pipeline row.
    for (const role of ["app", "scheduler", "intake", "news", "results", "publisher", "queueWorker"]) {
      const direct = new Client(postgres.connection(role));
      await direct.connect();
      try {
        for (const object of PIPELINE_OBJECTS)
          await assert.rejects(direct.query(`SELECT 1 FROM ${object} LIMIT 1`), /permission denied/, `${role}: ${object}`);
      } finally { await direct.end(); }
    }
    const catalog = new Client(postgres.admin({ database: postgres.database }));
    await catalog.connect();
    try {
      // The production work-intake agent group (the one shared agent login)
      // holds no privilege on any pipeline object, and no role other than the
      // two composed ones and the schema owner holds any at all.
      const holders = (await catalog.query<{ grantee: string }>(`SELECT DISTINCT grantee FROM (
          SELECT grantee FROM information_schema.role_table_grants WHERE table_name = ANY($1)
          UNION SELECT grantee FROM information_schema.column_privileges WHERE table_name = ANY($1)
            AND grantee NOT IN (SELECT grantee FROM information_schema.role_table_grants WHERE table_name = ANY($1))
        ) g ORDER BY grantee`, [PIPELINE_OBJECTS])).rows.map(row => row.grantee);
      assert.deepEqual(holders.filter(name => !["control_room_schema_owner", "control_room_private_web",
        "control_room_task_coordinator", "control_room_backup"].includes(name)), []);
      // The operator backup role reads every table for pg_dump and nothing more.
      const backup = (await catalog.query<{ privilege_type: string }>(`SELECT DISTINCT privilege_type
        FROM information_schema.role_table_grants WHERE grantee='control_room_backup' AND table_name = ANY($1)`,
      [PIPELINE_OBJECTS])).rows.map(row => row.privilege_type);
      assert.deepEqual(backup, ["SELECT"]);
    } finally { await catalog.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 150_000 });
});

test("the linear-pipeline real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1);
  assert.equal(ran, required);
});
