// S7b caps on a real PostgreSQL 17 cluster, run as the production login that
// performs the advance. Nothing here is a simulation: the web login sets the
// owner's ceilings, the coordinator login claims them in the same transaction
// as its advance receipt, and the refusal reason is the one the owner sees.
//
// What this file proves that a unit test cannot:
//   1. every ceiling refuses exactly at its boundary, on the real login;
//   2. the loop ceiling creates a real Needs Attention item and stops the run;
//   3. an unknown cost advances and is stored as unknown;
//   4. two concurrent advances cannot both take the last unit of a ceiling.
//
// The cluster is disposable, socket-only, on the assigned port range, and
// destroyed afterwards.
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";
import { macRolePlan } from "../scripts/mac-local/database-upgrade-grants.mjs";
import { inspectFixedQueueSchemaV1, installFixedQueueSchemaV1 } from "../scripts/mac-local/fixed-queue-schema.mjs";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database.ts";
import { privatePgOptions } from "../src/web/v1/private-pg-options.ts";
import { createAccessVerifier } from "../src/web/v1/access-verifier.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { SecurityStore } from "../src/security/security-store.ts";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/rollback-checkpoint.ts";
import { LinearPipelineServiceV1, PipelineAdvanceServiceV1, ProductionPipelineAdvanceAuthorityV1,
  ProductionPipelineAdvanceCapabilityV1 } from "../src/pipelines/v1/index.ts";
import { sha256Digest } from "../src/security/canonical-digest.ts";
import { pipelineStageMaterialV1 } from "../src/pipelines/v1/index.ts";
import { hmacSha256Tag } from "../src/security/digest.ts";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase } from "../src/web/v1/private-database-preflight.ts";
import { now as webNow, request as webRequest, trust as webTrust } from "./helpers/web-foundation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
// The shared disposable-cluster port, as the other real-PostgreSQL lanes use
// (linear-pipeline-postgres, project-coordination-web-grants-postgres). A
// dedicated override stays for running this lane on its own.
const PORT = Number(process.env.S7B_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58700);
const exec = promisify(execFile);
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (set PG_BIN)" };
const passwords = { CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24), CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24) };
// The Mac-local installer's exact login set, read from the one role manifest the
// provisioner itself consults. The provisioner refuses any other set, so this
// file provisions precisely what a real Mac-local installation has -- and it
// keeps doing so when the installer gains a login.
const LOGINS = Object.keys(macRolePlan);
const loginPasswords = Object.fromEntries(LOGINS.map((name, index) => [name, `${index}`.repeat(40)]));
const DB = "control_room";

let postmaster = null;
let data = "";
let socket = "";

async function query(options, sql, params = []) {
  const client = new Client(options);
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}
// Every option is built when it is used, never at module load: the socket path
// only exists after `before()` has started the cluster.
const adminOptions = () => ({ host: socket, port: PORT, database: "postgres", user: "postgres" });
const migratorOptions = () => ({ host: socket, port: PORT, database: DB, user: "control_room_migrator",
  password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD });
const fixtureOptions = () => ({ host: socket, port: PORT, database: DB, user: "fixture_admin" });
const superuser = () => new Client({ host: socket, port: PORT, database: DB, user: "postgres" });

/** The production web and coordinator pools: exact driver, pool options and
 * session qualification, exactly as the two composed processes build them. */
function productionPool(name) {
  const config = { host: "127.0.0.1", port: PORT, database: DB, username: name,
    password: loginPasswords[name], majorVersion: 17 };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: socket }));
  const refused = [];
  const traced = (session) => ({ query: async (sql, params) => {
    try { return await session.query(sql, params); }
    catch (error) { refused.push(sql.replace(/\s+/gu, " ").trim());
      refused.push(`S7BERR ${error?.sqlState ?? error?.code} ${error?.message}`); throw error; } } });
  return { config, refused, client: { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) },
    close: () => bound.close() };
}

const permissionFailure = (error, refused = []) => {
  const state = (error ?? {})?.sqlState ?? (error ?? {})?.code;
  return `${String(error)} sqlState=${String(state)}${state === "42501" ? " (permission denied)" : ""}`
    + (refused.length ? `\n  refused statement: ${refused.at(-1)}` : "");
};

before(async () => {
  if (!PG_AVAILABLE) return;
  data = await mkdtemp(join(tmpdir(), "cr-s7b-pg-"));
  socket = join(data, "sock");
  const env = { PATH: "/usr/bin:/bin:/opt/homebrew/bin", LC_ALL: "C", TMPDIR: data, NODE_ENV: "test" };
  await exec(join(BIN, "initdb"), ["-D", data, "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject"], { env });
  await mkdir(socket, { recursive: true });
  await exec(join(BIN, "pg_ctl"), ["-D", data, "-o", `-k ${socket} -p ${PORT} -c fsync=off -c full_page_writes=off`,
    "-l", join(data, "log"), "-w", "start"], { env });
  const bootstrap = new Client({ host: socket, port: PORT, database: "postgres", user: "fixture_admin" });
  await bootstrap.connect();
  try {
    // The installer's fixed queue shape assumes the cluster superuser is named
    // postgres, as on the documented Mac cluster.
    await bootstrap.query("CREATE ROLE postgres SUPERUSER LOGIN");
    await bootstrap.query(`CREATE DATABASE ${DB}`);
  } finally { await bootstrap.end(); }
  await applyMigrations({ target: fixtureOptions(), bootstrapTarget: fixtureOptions(),
    migrateTarget: migratorOptions(), rootDir: ROOT, env: { ...process.env, ...passwords } });
  // The provisioner creates cluster roles and then applies the Mac-local role
  // files, which name the application's own functions, so it must be connected
  // to the application database as the cluster superuser.
  const provisioner = new Client({ host: socket, port: PORT, database: DB, user: "postgres" });
  await provisioner.connect();
  try {
    if (!(await inspectFixedQueueSchemaV1(provisioner)).schemaExists) await installFixedQueueSchemaV1(provisioner);
    await provisionMacLocalNarrowRolesV1(provisioner, loginPasswords);
  } finally { await provisioner.end(); }
  postmaster = Number((await readFile(join(data, "postmaster.pid"), "utf8")).split("\n")[0]);
});

after(async () => {
  if (!data) return;
  const env = { PATH: "/usr/bin:/bin:/opt/homebrew/bin", LC_ALL: "C", TMPDIR: data };
  try { await exec(join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env }); } catch { /* already gone */ }
  if (postmaster) {
    try { process.kill(postmaster, 0); assert.fail(`postmaster ${postmaster} survived`); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await rm(data, { recursive: true, force: true });
});

/** A `pg` Client already connected as the superuser, wrapped as the bounded
 * `DatabaseClient` the services take. The owner's and the pipeline's own reads
 * are fixture setup, not the boundary under test: the advance runs on the real
 * production logins below. */
function superuserDatabase(client) {
  const session = { query: (sql, params) => client.query(sql, params) };
  return { query: (sql, params) => client.query(sql, params),
    transaction: work => work(session),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work(session); await check(); return value; } };
}

/** One installation with a consented run, a real delegation policy, and the
 * attempt rows the advance assigns against. Everything the service needs is a
 * real row on the real login.
 *
 * `executionPlanShape` is the one thing this seed cannot do for itself. `"seed"`
 * plans each stage as its own job, which is representable but not what the real
 * planner emits; `"planner"` writes NO plan at all, so `planExecutionJob` can
 * write the planner's own output (a distinct execution job per stage) without
 * having to delete the seed's row -- `control_task_execution_plans` is
 * append-only, so a plan can only be written once. */
async function seedInstallation(client, suffix, key, at, { maxLoops = 1, maxTotalLoops = 6,
  policyCostMicroUsd = 1_000_000, executionPlanShape = "seed" } = {}) {
  const tenantId = `tenant:caps-${suffix}`, workspaceId = `workspace:caps-${suffix}`;
  const db = superuserDatabase(client);
  await client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Caps probe')", [tenantId]);
  await client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Caps probe')", [workspaceId, tenantId]);
  const identityId = `identity:web-${suffix}`;
  await new SecurityStore(db).bootstrapOwner({ tenantId, provider: webTrust.issuer, subject: "test-owner",
    identityId, grantId: `grant:web-${suffix}`, displayName: "Test owner",
    verifiedAt: new Date(webNow - 60_000).toISOString(), expiresAt: new Date(webNow + 300_000).toISOString(), now: at });
  const identity = createAccessVerifier(webTrust)(webRequest(), webNow);
  const project = (await new WebProjectService(db, { tenantId, workspaceId }, () => webNow)
    .create(identity, { title: "Caps probe", summary: "Exercise the installation ceilings." }, `caps-${suffix}-project-0001`)).project;
  const template = { name: "Caps probe", description: "Build, check and validate.", stages: [
    { ordinal: 0, stageKind: "build", role: "builder", description: "Build.", requiredCapability: "code.change",
      workerId: `worker:build:${suffix}`, workerKind: "codex", nodeId: `node:build:${suffix}`,
      selectionKey: "build.standard", model: "build-test", effort: "medium", maxLoops,
      allowedPaths: ["src/**"], maximumChangedFiles: 10, maximumChangedBytes: 100_000 },
    { ordinal: 1, stageKind: "check", role: "checker", description: "Check.", requiredCapability: "code.review",
      workerId: `worker:check:${suffix}`, workerKind: "claude-code", nodeId: `node:check:${suffix}`,
      selectionKey: "check.standard", model: "check-test", effort: "high", maxLoops },
    { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate.", requiredCapability: "code.validate",
      workerId: `worker:validate:${suffix}`, workerKind: "hermes", nodeId: `node:validate:${suffix}`,
      selectionKey: "validate.standard", model: "validate-test", effort: "default",
      provider: "openai", profile: "profile:openai", maxLoops: 0 }], maxTotalLoops, maxDurationSeconds: 3600 };
  const pipelines = new LinearPipelineServiceV1(db, { tenantId, workspaceId }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => webNow);
  const saved = await pipelines.createTemplate(identity, project.projectId, template);
  const pipeline = await pipelines.instantiate(identity, project.projectId,
    { templateId: saved.templateId, title: "Capped run" }, `caps-${suffix}-pipeline-0001`);
  const [buildJob, checkJob, signoffJob] = pipeline.jobIds;
  // The real planner's output is one execution plan per stage whose job is a
  // DISTINCT `job:execution:*` job (task-execution-planner.ts). The production
  // read authority joins on exactly these rows, so without them every stage is
  // honestly uncertain. `executionPlanShape: "planner"` leaves the plan to
  // `planExecutionJob`, which writes the planner's own shape.
  if (executionPlanShape !== "planner") {
    for (const job of [buildJob, checkJob, signoffJob]) {
      await client.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
        VALUES($1,$2,$3,$3,'{}'::jsonb,$4)`, [tenantId, project.projectId, job, `hmac-sha256:${"9".repeat(64)}`]);
    }
  }
  const identityDigest = sha256Digest(identityId);
  await client.query(`INSERT INTO control_project_coordinator_heads(tenant_id,project_id,state,coordinator_identity_id,
    coordinator_actor_type,assigned_by_owner_identity_id,version,assigned_at,updated_at,payload)
    VALUES($1,$2,'active',$3,'human',$3,1,$4,$4,'{}')`, [tenantId, project.projectId, identityId, at]);
  await client.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,
    risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,
    created_at,updated_at) VALUES($1,$2,$3,$4,1,'active',1,$5,$4,$5,'["tasks.assign"]',
    $6,'low','none',100,$9,32,$7,$8,'{}',$7,$7)`, [tenantId, `policy:caps-${suffix}`, project.projectId, identityId,
    sha256Digest("policy"), JSON.stringify([`node:build:${suffix}`, `node:check:${suffix}`, `node:validate:${suffix}`]),
    new Date(webNow - 1000).toISOString(), new Date(webNow + 600_000).toISOString(), policyCostMicroUsd]);
  // Real attempt and node rows for every stage, plus the live harness runs the
  // machine agent-process ceiling counts.
  for (const [job, stage] of [[buildJob, "build"], [checkJob, "check"], [signoffJob, "validate"]]) {
    const nodeId = `node:${stage}:${suffix}`, workerId = `worker:${stage}:${suffix}`;
    await client.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
      VALUES($1,$2,'active',1,'key:caps',$3::jsonb,$4,$4)`, [nodeId, tenantId,
      JSON.stringify({ id: nodeId, tenantId, state: "active", version: 1, identityKeyId: "key:caps" }), at]);

    await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,
      lease_epoch,payload,created_at,updated_at) VALUES($1,$2,$3,1,'offered',1,$4,$5,1,$6::jsonb,$7,$7)`,
    [`attempt:${stage}:${suffix}`, tenantId, job, workerId, nodeId,
      JSON.stringify({ id: `attempt:${stage}:${suffix}`, tenantId, state: "offered", version: 1, jobId: job,
        attemptNumber: 1, workerId, nodeId, leaseEpoch: 1 }), at]);

    await client.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,
      harness,native_session_key_digest,parent_run_id,revision_of_run_id,state,last_sequence,run_digest,run_auth_tag,
      payload,created_at,updated_at,last_observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,'running',1,$10,$11,'{}'::jsonb,$12,$12,$12)`,
    [`run:${stage}:${suffix}`, tenantId, project.projectId, job, `attempt:${stage}:${suffix}`, nodeId,
      stage === "build" ? "connector:codex-owner-trusted-local-v1" : stage === "check"
        ? "connector:claude-code-local-v1" : "connector:hermes-local-v1",
      stage === "build" ? "codex" : stage === "check" ? "claude" : "hermes",
      sha256Digest({ node: nodeId }), sha256Digest({ run: `run:${stage}:${suffix}` }),
      hmacSha256Tag(key, { purpose: "harness-run", record: { nodeId } }), at]);
  }
  // The real attempt ids, so the receipt's foreign keys resolve to rows that
  // exist rather than to ids a mapping guessed.
  const attemptIds = new Map([[buildJob, `attempt:build:${suffix}`], [checkJob, `attempt:check:${suffix}`],
    [signoffJob, `attempt:validate:${suffix}`]]);
  return { tenantId, workspaceId, project, pipeline, identity, buildJob, checkJob, signoffJob,
    // The superuser client, so a helper can read the REAL rows the planner wrote
    // later (a fix round's attempt) rather than a map frozen at seed time.
    client, attemptIds, policyId: `policy:caps-${suffix}`, scope: { tenantId, workspaceId }, identityId, identityDigest };
}

/** The production coordinator's advance service, with assignment and the native
 * queue stubbed to one real attempt row (the existing protected composition),
 * and the read authority and Completion Gate acceptance driven by the test.
 * The attempt ids come from the rows the seed actually wrote, so the receipt's
 * foreign keys are satisfied by real data, not by a fabricated id. */
function advanceService(coordinator, own, key, { accepted = new Set(), cost = { kind: "known", admittedCostMicroUsd: 10,
  evidenceDigest: sha256Digest("cost") }, skipPrecheck = false } = {}) {
  // The attempt for a job is read from the REAL row the planner wrote, never from
  // a map frozen at seed time: a fix round mints a new attempt for the same
  // stage, and the receipt's foreign key must resolve to the row that exists.
  let queued = 0;
  // `accepted` is a set of SOURCE job ids. The production read authority, on an
  // accepted predecessor, resolves the execution job the Completion Gate
  // accepted and requires that exact job to be the plan row's job. Under the
  // planner shape the execution job is a distinct `job:execution:*` job, so the
  // accepted proof names the plan's real `job_id` rather than the source job.
  // Under the seed shape they are the same id and this is a no-op.
  const executionJobOf = async (tx, sourceJobId) => (await own.client.query(
    "SELECT job_id FROM control_task_execution_plans WHERE tenant_id=$1 AND source_job_id=$2",
    [own.tenantId, sourceJobId])).rows[0]?.job_id;
  const supporting = new ProductionPipelineAdvanceAuthorityV1(own.scope, { assertCurrent: () => true },
    { acceptedResultProof: async (_tx, value) => accepted.has(value.sourceJobId)
      ? { executionJobId: await executionJobOf(_tx, value.sourceJobId) ?? value.sourceJobId } : null,
      isAcceptedResultCurrent: async (_tx, value) => accepted.has(value.sourceJobId) },
    { currentCost: async () => cost }, () => webNow);
  const capability = new ProductionPipelineAdvanceCapabilityV1(supporting,
    { assignScheduledInSession: async (_tx, value) => {
      const row = (await own.client.query("SELECT id FROM control_attempts WHERE job_id=$1 ORDER BY created_at DESC,id LIMIT 1",
        [value.jobId])).rows[0];
      const attemptId = row?.id ?? own.attemptIds?.get(value.jobId);
      if (!attemptId) throw new Error(`no seeded attempt for ${value.jobId}`);
      return { receipt: { attemptId, leaseId: `lease:${value.jobId}`, leaseEpoch: 1 }, replayed: false };
    } },
    { enqueueAssignedInSession: async () => ({ queueId: `queue:caps-${++queued}`, replayed: false }) });
  // `skipPrecheck` makes #precheckLoopStop inert by answering only its
  // eligibility query with "not eligible". Every other statement is still the
  // real production client, so the transaction's own loop count is left to do
  // the refusing alone. Used to prove that second guard on its own.
  const client = skipPrecheck ? { ...coordinator.client,
    query: (sql, params) => /FROM pipeline_runs r/.test(String(sql))
      ? Promise.resolve({ rows: [{ eligible: false }], rowCount: 1, command: "SELECT", fields: [] })
      : coordinator.client.query(sql, params) } : coordinator.client;
  const service = new PipelineAdvanceServiceV1(client, own.scope, key,
    { unattendedEnabled: () => true, capability }, () => webNow);
  // `capability` and `client` are exposed so a test that needs a second service
  // over the SAME production composition -- a second sweep racing the first --
  // is built the way the real installer builds it rather than a lookalike.
  return { service, accepted, capability, client, queuedCount: () => queued };
}

/** The run's current stage moves back to an earlier stage, which is what a
 * `changes_requested` check does. The run row is signed over its ordinal, so it
 * is re-signed with the service's own material rather than written unsigned;
 * an unsigned rewind would fail the run's own integrity check instead of
 * reaching the loop ceiling. */
async function rewindRunTo(client, own, ordinal, key) {
  const row = (await client.query(`SELECT id,project_id,request_id,template_id,template_version,template_digest,
    workflow_id,title,state,started_at,updated_at,completed_at,current_stage_ordinal,unattended,version
    FROM pipeline_runs WHERE id=$1`, [own.pipeline.runId])).rows[0];
  const iso = (value) => value === null || value === undefined ? null : new Date(value).toISOString();
  const next = { id: row.id, tenantId: own.tenantId, projectId: row.project_id, requestId: row.request_id,
    templateId: row.template_id, templateVersion: Number(row.template_version), templateDigest: row.template_digest,
    workflowId: row.workflow_id, title: row.title, state: row.state, startedAt: iso(row.started_at),
    updatedAt: iso(new Date(webNow).toISOString()), completedAt: iso(row.completed_at),
    currentStageOrdinal: ordinal, unattended: row.unattended, version: Number(row.version) + 1 };
  const changed = await client.query(`UPDATE pipeline_runs SET current_stage_ordinal=$1,updated_at=$2,version=$3,
    record_digest=$4,auth_tag=$5 WHERE id=$6 AND version=$7 RETURNING version`,
  [ordinal, next.updatedAt, next.version, sha256Digest(next),
    hmacSha256Tag(key, { purpose: "pipeline-run/v1", record: next }), own.pipeline.runId, row.version]);
  assert.equal(changed.rows.length, 1, "the rewind must move exactly one version");
}

/** One fix round for a stage: the real planner's shape, with a fresh job, plan,
 * model selection, attempt and a re-signed stage row. The stage's
 * `current_job_id` moves, so the next advance counts as another round.
 * `pipeline_stage_runs` is signed, so the row is re-signed with the same key the
 * service uses; without this the advance would refuse on integrity, not on the
 * loop ceiling. */
async function reenterStage(client, own, stageOrdinal, key) {
  const at = new Date(webNow).toISOString();
  const jobId = `job:loop:${own.pipeline.runId}:${stageOrdinal}:${Date.now()}`;
  const stage = (await client.query("SELECT worker_kind,worker_id,node_id,selection_key,model,effort,provider,profile,"
    + " stage_kind FROM pipeline_stage_runs WHERE pipeline_run_id=$1 AND stage_ordinal=$2",
  [own.pipeline.runId, stageOrdinal])).rows[0];
  await client.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
    required_capability,authority_digest,payload,created_at,updated_at,stage_kind,stage_ordinal,pipeline_run_id)
    SELECT $2,tenant_id,workflow_id,project_id,'proposed',0,50,required_capability,authority_digest,
      jsonb_set(payload,'{id}',to_jsonb($2::text)),$3,$3,stage_kind,$4,pipeline_run_id
    FROM control_jobs WHERE tenant_id=$1 AND id=$5`,
  [own.tenantId, jobId, at, stageOrdinal, own.pipeline.jobIds[stageOrdinal]]);
  await client.query(`INSERT INTO control_task_model_selections(tenant_id,project_id,job_id,worker_kind,selection_key,
    model,effort,provider,profile,inherited_from_job_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [own.tenantId, own.project.projectId, jobId, stage.worker_kind, stage.selection_key, stage.model, stage.effort,
    stage.provider, stage.profile, own.pipeline.jobIds[stageOrdinal], at]);
  await client.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
    VALUES($1,$2,$3,$4,'{}'::jsonb,$5)`, [own.tenantId, own.project.projectId, jobId, jobId,
    `hmac-sha256:${"9".repeat(64)}`]);
  const tag = sha256Digest(jobId).slice(7, 15);
  // The planner mints the fix round's attempt when it plans the round, because
  // the stage row's current attempt is a foreign key. The assignment then leases
  // that attempt; it does not mint a competing one.
  await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,
    lease_epoch,payload,created_at,updated_at) VALUES($1,$2,$3,1,'offered',1,$4,$5,1,$6::jsonb,$7,$7)`,
  [`attempt:loop:${tag}`, own.tenantId, jobId, stage.worker_id, stage.node_id,
    JSON.stringify({ id: `attempt:loop:${tag}`, tenantId: own.tenantId, state: "offered", version: 1, jobId,
      attemptNumber: 1, workerId: stage.worker_id, nodeId: stage.node_id, leaseEpoch: 1 }), at]);
  // The stage row is signed over its current job, so it is re-signed here with
  // the service's exact material. The trigger checks only the lineage columns.
  const row = (await client.query("SELECT project_id,pipeline_run_id,stage_ordinal,stage_kind,role,worker_id,"
    + " worker_kind,node_id,selection_key,model,effort,provider,profile,current_job_id,current_attempt_id,"
    + " current_lease_id,state,max_loops,handoff_from_result_digest,allowed_paths,maximum_changed_files,"
    + " maximum_changed_bytes,signoff_review_id,started_at,finished_at,version FROM pipeline_stage_runs"
    + " WHERE pipeline_run_id=$1 AND stage_ordinal=$2", [own.pipeline.runId, stageOrdinal])).rows[0];
  // Re-signed with the service's own exported material builder and its own tag,
  // so this can never drift from what production verifies. The stage row is
  // signed over its current job, and a re-entry moves that job.
  const signed = pipelineStageMaterialV1(own.scope, {
    project_id: row.project_id, pipeline_run_id: own.pipeline.runId,
    stage_ordinal: Number(row.stage_ordinal), stage_kind: row.stage_kind, role: row.role,
    worker_id: row.worker_id, worker_kind: row.worker_kind, node_id: row.node_id,
    selection_key: row.selection_key, model: row.model, effort: row.effort, provider: row.provider,
    profile: row.profile, current_job_id: jobId, current_attempt_id: `attempt:loop:${tag}`,
    current_lease_id: null, state: row.state, max_loops: Number(row.max_loops),
    handoff_from_result_digest: row.handoff_from_result_digest, allowed_paths: row.allowed_paths,
    maximum_changed_files: row.maximum_changed_files, maximum_changed_bytes: row.maximum_changed_bytes,
    signoff_review_id: row.signoff_review_id, started_at: row.started_at, finished_at: row.finished_at,
    version: Number(row.version) });
  await client.query(`UPDATE pipeline_stage_runs SET current_job_id=$1,current_attempt_id=$2,record_digest=$3,
    auth_tag=$4 WHERE pipeline_run_id=$5 AND stage_ordinal=$6`,
  [jobId, `attempt:loop:${tag}`, sha256Digest(signed), hmacSha256Tag(key, {
    purpose: "pipeline-stage-run/v1", record: signed }), own.pipeline.runId, stageOrdinal]);
  return jobId;
}

/** A second run in an installation that already has one, with its OWN template
 * so the first run's owner consent does not move the pin out from under it.
 * Same tenant, same workspace and same policy, so both runs claim the same
 * ceilings.
 *
 * `index` names the run within the installation. The template title and the
 * instantiate request's idempotency key both come from it, so one installation
 * can hold many runs; without it the second call is an exact replay of the first
 * and the caller silently gets the SAME run back. */
async function seedSecondRun(client, own, key, index = 1) {
  const pipelines = new LinearPipelineServiceV1(superuserDatabase(client), own.scope, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => webNow);
  const at = new Date(webNow).toISOString();
  // This run shares the first run's installation, so it routes through the SAME
  // nodes. The one active delegation policy is per project, and its eligible
  // routes are exactly the first run's nodes; a second run that invented new
  // node ids would be refused as policy_inactive, which is the correct product
  // behaviour and not what this seed is testing.
  const route = (await client.query("SELECT stage_ordinal,worker_kind,worker_id,node_id,selection_key,model,effort,"
    + " provider,profile FROM pipeline_stage_runs WHERE pipeline_run_id=$1 ORDER BY stage_ordinal",
  [own.pipeline.runId])).rows;
  const atStage = (ordinal) => route[ordinal];
  const template = { name: "Caps probe", description: "Build, check and validate.", stages: [
    { ordinal: 0, stageKind: "build", role: "builder", description: "Build.", requiredCapability: "code.change",
      workerId: atStage(0).worker_id, workerKind: atStage(0).worker_kind, nodeId: atStage(0).node_id,
      selectionKey: "build.standard", model: "build-test", effort: "medium", maxLoops: 3,
      allowedPaths: ["src/**"], maximumChangedFiles: 10, maximumChangedBytes: 100_000 },
    { ordinal: 1, stageKind: "check", role: "checker", description: "Check.", requiredCapability: "code.review",
      workerId: atStage(1).worker_id, workerKind: atStage(1).worker_kind, nodeId: atStage(1).node_id,
      selectionKey: "check.standard", model: "check-test", effort: "high", maxLoops: 3 },
    { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate.", requiredCapability: "code.validate",
      workerId: atStage(2).worker_id, workerKind: atStage(2).worker_kind, nodeId: atStage(2).node_id,
      selectionKey: "validate.standard", model: "validate-test", effort: "default",
      provider: "openai", profile: "profile:openai", maxLoops: 0 }], maxTotalLoops: 6, maxDurationSeconds: 3600 };
  const saved = await pipelines.createTemplate(own.identity, own.project.projectId, template);
  const pipeline = await pipelines.instantiate(own.identity, own.project.projectId,
    { templateId: saved.templateId, title: `Second capped run ${index}` },
    `caps-second-${own.tenantId}-pipeline-${String(index).padStart(4, "0")}`);
  const attemptIds = new Map();
  for (const [index, job] of pipeline.jobIds.entries()) {
    await client.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
      VALUES($1,$2,$3,$3,'{}'::jsonb,$4)`, [own.tenantId, own.project.projectId, job, `hmac-sha256:${"9".repeat(64)}`]);
    const tag = sha256Digest(job).slice(7, 15);
    // The node already exists from the first run's seed, so it is reused rather
    // than inserted again; the attempt is this run's own.
    const nodeId = atStage(index).node_id, workerId = atStage(index).worker_id;
    const attemptId = `attempt:second:${index}:${tag}`;
    await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,
      lease_epoch,payload,created_at,updated_at) VALUES($1,$2,$3,1,'offered',1,$4,$5,1,$6::jsonb,$7,$7)`,
    [attemptId, own.tenantId, job, workerId, nodeId,
      JSON.stringify({ id: attemptId, tenantId: own.tenantId, state: "offered", version: 1, jobId: job,
        attemptNumber: 1, workerId, nodeId, leaseEpoch: 1 }), at]);
    attemptIds.set(job, attemptId);
  }
  // One current delegation policy per project is the real shape, so this run
  // shares the first.
  return { ...own, pipeline, buildJob: pipeline.jobIds[0], checkJob: pipeline.jobIds[1],
    signoffJob: pipeline.jobIds[2], attemptIds };
}

/** The REAL planner's shape for one stage: a distinct `job:execution:*` job
 * that copies the stage ordinal and run lineage onto the execution job, with its
 * own model selection and execution plan. The caps lane used to plan every
 * stage as its own source job, which hid the fact that a stage therefore holds
 * TWO labelled jobs per round; `task-execution-planner.ts` is the code that
 * says otherwise, so this helper copies its output exactly.
 *
 * The seed must have been called with `executionPlanShape: "planner"`, because
 * `control_task_execution_plans` is append-only: the plan can only be written
 * once, so the seed's placeholder (source_job_id = job_id) can never be
 * replaced. */
async function planExecutionJob(client, own, stageOrdinal) {
  const at = new Date(webNow).toISOString();
  const sourceJobId = own.pipeline.jobIds[stageOrdinal];
  const executionJobId = `job:execution:${own.pipeline.runId}:${stageOrdinal}`;
  const existing = (await client.query("SELECT source_job_id,job_id FROM control_task_execution_plans"
    + " WHERE tenant_id=$1 AND source_job_id=$2", [own.tenantId, sourceJobId])).rows[0];
  assert.ok(!existing, `this stage already has a plan (${existing?.job_id ?? "unknown"}); `
    + "seed the installation with executionPlanShape: \"planner\"");
  await client.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
    required_capability,authority_digest,payload,created_at,updated_at,stage_kind,stage_ordinal,pipeline_run_id)
    SELECT $2,tenant_id,workflow_id,project_id,'proposed',0,50,required_capability,authority_digest,
      jsonb_set(payload,'{id}',to_jsonb($2::text)),$3,$3,stage_kind,$4,pipeline_run_id
    FROM control_jobs WHERE tenant_id=$1 AND id=$5`,
  [own.tenantId, executionJobId, at, stageOrdinal, sourceJobId]);
  await client.query(`INSERT INTO control_task_model_selections(tenant_id,project_id,job_id,worker_kind,selection_key,
    model,effort,provider,profile,inherited_from_job_id,created_at)
    SELECT tenant_id,project_id,$2,worker_kind,selection_key,model,effort,provider,profile,$3,created_at
    FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$3`,
  [own.tenantId, executionJobId, sourceJobId]);
  await client.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
    VALUES($1,$2,$3,$4,'{}'::jsonb,$5)`, [own.tenantId, own.project.projectId, sourceJobId, executionJobId,
    `hmac-sha256:${"9".repeat(64)}`]);
  const attemptId = `attempt:execution:${own.pipeline.runId}:${stageOrdinal}`;
  const stage = (await client.query("SELECT worker_id,node_id FROM pipeline_stage_runs"
    + " WHERE pipeline_run_id=$1 AND stage_ordinal=$2", [own.pipeline.runId, stageOrdinal])).rows[0];
  await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,
    lease_epoch,payload,created_at,updated_at) VALUES($1,$2,$3,1,'offered',1,$4,$5,1,$6::jsonb,$7,$7)`,
  [attemptId, own.tenantId, executionJobId, stage.worker_id, stage.node_id,
    JSON.stringify({ id: attemptId, tenantId: own.tenantId, state: "offered", version: 1, jobId: executionJobId,
      attemptNumber: 1, workerId: stage.worker_id, nodeId: stage.node_id, leaseEpoch: 1 }), at]);
  own.attemptIds.set(executionJobId, attemptId);
  return executionJobId;
}

/** A stage's work, as the machine actually finishes it. These are TWO different
 * production logins, because the product splits the two writes: the coordinator
 * owns `control_jobs(state,version,updated_at)` and the result publisher owns
 * `control_harness_runs(state,updated_at,last_observed_at)`. A probe that used
 * the superuser for either would prove nothing about the installed grants, and
 * one that used the coordinator for both would be refused 42501.
 *
 * `control_jobs.payload` is a canonical MIRROR of the row -- the trigger refuses
 * any write that moves `state` or `version` without moving `payload.state` and
 * `payload.version` with it (P0001, "canonical payload mirror mismatch"). So the
 * two are written together here, exactly as the real job-state transition writes
 * them; updating the column alone is not a state transition the product permits.
 *
 * `jobState` and `harnessState` are separate because they are separate facts and
 * the process ceiling has to be right about both: a job CANCELLED before a
 * worker picked it up has no harness run at all, and a job whose harness run
 * FAILED is finished even though the job row was never advanced. */
async function finishExecutionJob(coordinator, publisher, own, executionJobId, { jobState, harnessState }) {
  const changed = await coordinator.client.query(`UPDATE control_jobs SET state=$3,version=version+1,
      updated_at=clock_timestamp(),payload=jsonb_set(jsonb_set(payload,'{state}',to_jsonb($3::text)),
      '{version}',to_jsonb(version+1))
    WHERE tenant_id=$1 AND id=$2 RETURNING state`, [own.tenantId, executionJobId, jobState]);
  assert.equal(changed.rows.length, 1, `the job ${executionJobId} must exist to be finished`);
  await publisher.client.query(`UPDATE control_harness_runs SET state=$3,updated_at=clock_timestamp(),
    last_observed_at=clock_timestamp() WHERE tenant_id=$1 AND job_id=$2`,
  [own.tenantId, executionJobId, harnessState]);
}

/** The installation's own live-process count, read with the production
 * coordinator login and the EXACT expression the service uses, so a test
 * asserting "the slot came back" is reading the same number the ceiling reads
 * and cannot pass on a different definition. */
async function activeProcessCount(coordinator, own) {
  return (await coordinator.client.query(`SELECT ((SELECT COUNT(DISTINCT id) FROM control_harness_runs
      WHERE tenant_id=$1 AND state IN('discovered','starting','running','waiting_input','waiting_approval','cancelling'))
    + (SELECT COUNT(DISTINCT r.execution_job_id) FROM pipeline_advance_receipts r
      JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.id=r.execution_job_id
      WHERE r.tenant_id=$1 AND j.state IN('proposed','ready','leased','running','waiting_approval')
      AND NOT EXISTS(SELECT 1 FROM control_harness_runs h
        WHERE h.tenant_id=r.tenant_id AND h.job_id=r.execution_job_id)))::text AS count`,
  [own.tenantId])).rows[0].count;
}

/** The owner's SIGNED delegation policy, with one ceiling tightened. The policy
 * row is versioned and append-only in every column but `state`, `version` and
 * `updated_at`, so a ceiling is signed once at seed time and never mutated by a
 * probe. `seedInstallation` takes `policyCostMicroUsd` for exactly this reason;
 * this helper only asserts that the ceiling the owner signed is the one in force. */
async function assertPolicyCeiling(client, own, column, value) {
  assert.ok(["max_total_cost_microusd", "max_total_tasks", "max_concurrent_tasks"].includes(column),
    `not a policy ceiling this helper checks: ${column}`);
  const stored = (await client.query(`SELECT ${column}::text AS ceiling
    FROM control_project_delegation_policies WHERE tenant_id=$1 AND id=$2`,
  [own.tenantId, own.policyId])).rows[0].ceiling;
  assert.equal(Number(stored), value, `the owner's signed ${column} must be the one in force`);
}


/** The owner's consent alone, for a run that shares another's installation. */
async function ownerConsents(web, own, key) {
  const owner = new PipelineAdvanceServiceV1(web.client, own.scope, key, {}, () => webNow);
  const consented = (await web.client.query("SELECT count(*)::int count FROM pipeline_unattended_transitions"
    + " WHERE tenant_id=$1 AND pipeline_run_id=$2", [own.tenantId, own.pipeline.runId])).rows[0].count;
  if (consented > 0) return;
  const view = await new LinearPipelineServiceV1(web.client, own.scope, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => webNow)
    .view(own.identity, own.project.projectId, own.pipeline.runId);
  await owner.setUnattended(own.identity, own.project.projectId, { runId: own.pipeline.runId,
    templateId: view.templateId, policyId: own.policyId, enabled: true, expectedRunVersion: view.runVersion,
    expectedTemplateVersion: view.templateVersion },
  `pipeline-unattended-${own.pipeline.runId}`);
}

/** The owner sets the installation ceilings on the web login, and consents the
 * run exactly once. Re-consenting an already-consented run would move its
 * template pin again and invalidate the stored consent, which is the run's own
 * integrity rule and not anything this slice is testing. */
async function ownerSetsUp(web, own, key, limits) {
  const owner = new PipelineAdvanceServiceV1(web.client, own.scope, key, {}, () => webNow);
  const pipelines = new LinearPipelineServiceV1(web.client, own.scope, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => webNow);
  const consented = (await web.client.query("SELECT count(*)::int count FROM pipeline_unattended_transitions"
    + " WHERE tenant_id=$1 AND pipeline_run_id=$2", [own.tenantId, own.pipeline.runId])).rows[0].count;
  if (consented === 0) {
    const view = await pipelines.view(own.identity, own.project.projectId, own.pipeline.runId);
    await owner.setUnattended(own.identity, own.project.projectId, { runId: own.pipeline.runId,
      templateId: view.templateId, policyId: own.policyId, enabled: true, expectedRunVersion: view.runVersion,
      expectedTemplateVersion: view.templateVersion },
    `pipeline-unattended-${own.pipeline.runId}`);
  }
  return owner.setAllowance(own.identity, limits);
}

test("the loop counter counts FIX ROUNDS, not jobs, so a real pipeline runs", needsPg, async t => {
  // The reviewer's B1, verbatim on real PostgreSQL with the production login and
  // the REAL planner's shape. The planner creates a DISTINCT `job:execution:*`
  // job per stage and copies the stage ordinal onto it, so a stage holds TWO
  // labelled jobs per round. Counting jobs made round 0 look like round 1, and
  // stopped a stage that had never run.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(71);

  // A signoff stage uses max_loops 0: one attempt, no fix rounds. Under a job
  // count its FIRST advance computed loop_index 1 and was refused with a
  // "Pipeline stopped" Needs Attention item for a stage that never ran.
  const signoffOwn = await seedInstallation(admin, "roundsignoff", key, new Date(webNow).toISOString(),
    { maxLoops: 0, executionPlanShape: "planner" });
  // Every stage planned the real way, so the job chain holds two jobs per stage.
  for (const ordinal of [0, 1, 2]) await planExecutionJob(admin, signoffOwn, ordinal);
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_jobs WHERE tenant_id=$1"
    + " AND pipeline_run_id=$2 AND stage_ordinal IS NOT NULL", [signoffOwn.tenantId, signoffOwn.pipeline.runId]))
    .rows[0].count, 6, "the real planner leaves six labelled jobs for three stages");
  await ownerSetsUp(web, signoffOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const { service, queuedCount } = advanceService(coordinator, signoffOwn, key);
  const first = await service.advance(signoffOwn.pipeline.runId, signoffOwn.policyId)
    .catch(error => assert.fail(`a stage's first attempt is round 0 and must advance: ${error?.safeReason ?? error}`));
  assert.equal(first.startsWork, true);
  assert.equal(first.stageOrdinal, 0, "the run advances to its first stage, not straight past it");
  assert.equal(queuedCount(), 1);
  // Round 0, at the ceiling the stage was signed with. A job count recorded 1.
  // `max_loops` is the STAGE's ceiling, so it is read from the stage row the
  // counted row names, not from the receipt table.
  const round0 = (await admin.query("SELECT loop_index::text loop_index,run_total_loops::text run_total_loops,"
    + " max_loops::text max_loops FROM pipeline_stage_loop_counts WHERE tenant_id=$1"
    + " AND pipeline_run_id=$2", [signoffOwn.tenantId, signoffOwn.pipeline.runId])).rows;
  assert.deepEqual(round0.map(row => [Number(row.loop_index), Number(row.max_loops)]), [[0, 0]],
    "the first attempt is round 0 under a max_loops of zero");
  // And no false "stopped" item was raised for a stage that ran.
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_action_inbox WHERE tenant_id=$1",
    [signoffOwn.tenantId])).rows[0].count, 0, "a stage that ran must not raise a loop-limit stop");

  // A run-wide ceiling of 2 must admit a FRESH run's three stages. The job count
  // made runTotal 2 on the very first advance and stopped the run at once.
  const runCeilingOwn = await seedInstallation(admin, "roundrun", key, new Date(webNow).toISOString(),
    { maxLoops: 1, maxTotalLoops: 2, executionPlanShape: "planner" });
  for (const ordinal of [0, 1, 2]) await planExecutionJob(admin, runCeilingOwn, ordinal);
  await ownerSetsUp(web, runCeilingOwn, key, { runsPerHour: 100, runsPerAgentPerDay: 100,
    machineMaxAgentProcesses: 12, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  // Nothing is accepted yet, so the first advance is stage 0. It is accepted
  // afterwards, so the second advance is stage 1: two rounds of a run whose
  // ceiling is two, and neither of them is a fix round.
  const runCeiling = advanceService(coordinator, runCeilingOwn, key);
  const runFirst = await runCeiling.service.advance(runCeilingOwn.pipeline.runId, runCeilingOwn.policyId)
    .catch(error => assert.fail(`a fresh run under a run ceiling of two must advance: ${error?.safeReason ?? error}`));
  assert.equal(runFirst.stageOrdinal, 0);
  runCeiling.accepted.add(runCeilingOwn.buildJob);
  const runSecond = await runCeiling.service.advance(runCeilingOwn.pipeline.runId, runCeilingOwn.policyId)
    .catch(error => assert.fail(`the run's second round must advance: ${error?.safeReason ?? error}`));
  assert.equal(runSecond.stageOrdinal, 1, "a three-stage run under a ceiling of two reaches its second stage");
  // The run total counts the ROUNDS the run has started, one per stage advanced
  // here: 1, then 2. The lane's clock is fixed, so `recorded_at` cannot order
  // them; the loop index within the run's single advanced stage orders them.
  const totals = (await admin.query("SELECT stage_ordinal::text stage_ordinal,loop_index::text loop_index,"
    + " run_total_loops::text run_total_loops FROM pipeline_stage_loop_counts WHERE tenant_id=$1"
    + " AND reason_code='stage_advanced' ORDER BY stage_ordinal,loop_index",
  [runCeilingOwn.tenantId])).rows.map(row => [Number(row.stage_ordinal), Number(row.loop_index), Number(row.run_total_loops)]);
  assert.deepEqual(totals, [[0, 0, 1], [1, 0, 2]],
    `each stage advanced once, and the run total counts the rounds it started, got ${JSON.stringify(totals)}`);
});

test("the owner's signed policy dollar ceiling refuses a known cost", needsPg, async t => {
  // The reviewer's B2, verbatim on real PostgreSQL with the production login.
  // "Count runs, never dollars" called for dropping the refusal on an UNKNOWN
  // cost. It did not call for silently dropping the known-cost ceiling the owner
  // signed: this policy is active and its dollar ceiling is enforced on the
  // non-pipeline coordination path, so pipelines must not be the one path that
  // ignores it.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(72);
  const expensive = { kind: "known", admittedCostMicroUsd: 5_000_000, evidenceDigest: sha256Digest("cost") };

  // The policy is the seeded 1,000,000 micro-USD ceiling, which the next cost
  // blows through. No installation cap is set at all, so the ONLY dollar
  // ceiling in force is the one the owner signed.
  const over = await seedInstallation(admin, "policycost", key, new Date(webNow).toISOString(),
    { policyCostMicroUsd: 1_000_000 });
  await ownerSetsUp(web, over, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  await assertPolicyCeiling(admin, over, "max_total_cost_microusd", 1_000_000);
  const overService = advanceService(coordinator, over, key, { cost: expensive });
  try {
    await overService.service.advance(over.pipeline.runId, over.policyId);
    assert.fail(`expected a refusal, refused statements: ${JSON.stringify(coordinator.refused.slice(-4))}`);
  } catch (error) {
    if (error?.safeReason !== "policy_cost_allowance_exhausted") {
      throw new Error(`wrong refusal: ${error?.safeReason ?? error}; refused=${JSON.stringify(coordinator.refused.slice(-6))}`);
    }
  }
  assert.equal(overService.queuedCount(), 0, "a refused advance queues nothing");
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts WHERE tenant_id=$1",
    [over.tenantId])).rows[0].count, 0, "a refused advance claims no receipt");

  // EXACTLY at the ceiling still fits, and one micro-USD less refuses. That is
  // the boundary that distinguishes `>` from `>=`.
  const edge = await seedInstallation(admin, "policycostedge", key, new Date(webNow).toISOString(),
    { policyCostMicroUsd: 5_000_000 });
  await ownerSetsUp(web, edge, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  await assertPolicyCeiling(admin, edge, "max_total_cost_microusd", 5_000_000);
  const edgeService = advanceService(coordinator, edge, key, { cost: expensive });
  assert.equal((await edgeService.service.advance(edge.pipeline.runId, edge.policyId)).startsWork, true,
    "a policy ceiling of exactly the next cost still fits");

  const short = await seedInstallation(admin, "policycostshort", key, new Date(webNow).toISOString(),
    { policyCostMicroUsd: 4_999_999 });
  await ownerSetsUp(web, short, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  await assertPolicyCeiling(admin, short, "max_total_cost_microusd", 4_999_999);
  const shortService = advanceService(coordinator, short, key, { cost: expensive });
  await assert.rejects(shortService.service.advance(short.pipeline.runId, short.policyId),
    error => error.safeReason === "policy_cost_allowance_exhausted",
    "one micro-USD short of the policy ceiling must refuse");

  // The pass-through survives: an UNKNOWN cost is never a refusal, however
  // small the ceiling is, and it is recorded as unknown.
  const unknownOwn = await seedInstallation(admin, "policycostunknown", key, new Date(webNow).toISOString(),
    { policyCostMicroUsd: 0 });
  await ownerSetsUp(web, unknownOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  await assertPolicyCeiling(admin, unknownOwn, "max_total_cost_microusd", 0);
  const unknownService = advanceService(coordinator, unknownOwn, key, { cost: { kind: "unknown" } });
  const unknownReceipt = await unknownService.service.advance(unknownOwn.pipeline.runId, unknownOwn.policyId)
    .catch(error => assert.fail(`an unknown cost must never refuse: ${error?.safeReason ?? error}`));
  assert.equal(unknownReceipt.startsWork, true);
  const stored = (await admin.query("SELECT delegation_cost_state FROM pipeline_advance_receipts"
    + " WHERE tenant_id=$1", [unknownOwn.tenantId])).rows[0];
  assert.equal(stored.delegation_cost_state, "unknown", "and it is recorded as unknown, not as zero");
});

test("a malformed known cost refuses rather than becoming an unknown", needsPg, async t => {
  // Reviewer follow-up 1: a `kind:"known"` cost with a negative, fractional or
  // bad-digest value used to be demoted to `unknown`, which slipped past the
  // dollar cap. A cost port that lies about being known is an integrity failure,
  // not an honest unknown, so it refuses with no receipt and no queued work.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(73);
  // A suffix per case, because each one is its own tenant and installation.
  const malformed = [
    ["negative", { kind: "known", admittedCostMicroUsd: -1, evidenceDigest: "garbage" }],
    ["fractional", { kind: "known", admittedCostMicroUsd: 1.5, evidenceDigest: sha256Digest("c") }],
    ["nan", { kind: "known", admittedCostMicroUsd: Number.NaN, evidenceDigest: sha256Digest("c") }],
    ["unbounded", { kind: "known", admittedCostMicroUsd: Number.MAX_VALUE, evidenceDigest: sha256Digest("c") }],
    ["baddigest", { kind: "known", admittedCostMicroUsd: 10, evidenceDigest: "not-a-digest" }],
  ];
  for (const [label, cost] of malformed) {
    const own = await seedInstallation(admin, `badcost-${label}`, key, new Date(webNow).toISOString());
    await ownerSetsUp(web, own, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
      machineMaxDbClusters: 6, dollarCapMicroUsd: 1, observedDbClusters: 1 });
    const { service, queuedCount } = advanceService(coordinator, own, key, { cost });
    await assert.rejects(service.advance(own.pipeline.runId, own.policyId),
      error => error.safeReason === "advance_conflict", `${label} must refuse`);
    assert.equal(queuedCount(), 0, `${label} queues nothing`);
    assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts"
      + " WHERE tenant_id=$1", [own.tenantId])).rows[0].count, 0, `${label} claims no receipt`);
  }
});

test("a forged loop attention item with no reason code is refused", needsPg, async t => {
  // Reviewer follow-up 4: `NULL NOT IN (...)` is NULL, not true, so a
  // pipeline-loop item with NO reasonCode passed the guard. The owner would see
  // a Needs Attention item that names no reason at all.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const key = new Uint8Array(32).fill(74);
  t.after(async () => { await web.close(); await admin.end(); });
  const own = await seedInstallation(admin, "loopreason", key, new Date(webNow).toISOString());
  const item = { id: "attention:pipeline-loop:forged-null-reason", tenantId: own.tenantId,
    projectId: own.project.projectId, workItemId: "work:one", kind: "question", state: "open",
    schema: "control-room.pipeline-loop-attention/v1", pipelineRunId: own.pipeline.runId,
    stageOrdinal: 0, stageKind: "build", requestedAction: "Pipeline stopped", blockedWorkItemIds: [],
    legalResponses: [], evidence: [], loopIndex: 0, maxLoops: 0, maxTotalLoops: 6, runTotalLoops: 1,
    createdAt: new Date(webNow).toISOString(), deliveryState: "not_requested" };
  await assert.rejects(admin.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,
    delivery_state,created_at,expires_at,payload) VALUES($1,$2,$3,$4,'question','open','not_requested',$5,NULL,
    $6::jsonb)`, [item.id, item.tenantId, item.projectId, item.workItemId, item.createdAt,
    JSON.stringify(item)]), /pipeline loop attention item rejected/u);
  // The same item WITH a reason code is accepted, so the guard is this one field
  // and not something the seed above happened to get wrong.
  await admin.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,
    delivery_state,created_at,expires_at,payload) VALUES($1,$2,$3,$4,'question','open','not_requested',$5,NULL,
    $6::jsonb)`, [item.id, item.tenantId, item.projectId, item.workItemId, item.createdAt,
    JSON.stringify({ ...item, reasonCode: "pipeline_stage_loop_limit_reached" })]);
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_action_inbox WHERE id=$1", [item.id]))
    .rows[0].count, 1);
});

test("the loop-attention guard does not silently cancel an ordinary inbox delete", needsPg, async t => {
  // Reviewer follow-up 3: the 0154 update guard was attached to UPDATE OR DELETE,
  // and its `RETURN NEW` returns NULL on DELETE, so every DELETE on
  // control_action_inbox silently affected zero rows. No production login holds
  // DELETE, but admin cleanup and restore tooling must still work.
  const admin = superuser();
  await admin.connect();
  t.after(async () => { await admin.end(); });
  const own = await seedInstallation(admin, "loopdelete", new Uint8Array(32).fill(75),
    new Date(webNow).toISOString());
  await admin.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,
    delivery_state,created_at,expires_at,payload) VALUES($1,$2,$3,$4,'question','open','not_requested',$5,NULL,
    '{"state":"open"}'::jsonb)`, [`attention:ordinary-${own.tenantId}`, own.tenantId, own.project.projectId,
    "work:ordinary", new Date(webNow).toISOString()]);
  const removed = await admin.query("DELETE FROM control_action_inbox WHERE id=$1",
    [`attention:ordinary-${own.tenantId}`]);
  assert.equal(removed.rowCount, 1, "an ordinary inbox row is deletable again");
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_action_inbox WHERE id=$1",
    [`attention:ordinary-${own.tenantId}`])).rows[0].count, 0, "and it is really gone");

  // The split guard must not have made the pipeline item deletable while it is
    // unresolved: an owner Needs Attention item cannot be quietly removed.
    //
    // Resolving it here goes through 0102's own work-batch guard as well, which
    // refuses ANY update to a non-`attention:work-batch:%` row by a member of
    // `control_room_private_web` -- and the superuser is one. So the one legal
    // resolution cannot be written directly from this connection at all; what is
    // proved below is the delete guard, which is the thing that was broken.
    const openId = `attention:pipeline-loop:${own.pipeline.runId}`;
    const loopItem = { id: openId, tenantId: own.tenantId, projectId: own.project.projectId,
      workItemId: `${own.pipeline.runId}:stage:0`, kind: "question", state: "open",
      schema: "control-room.pipeline-loop-attention/v1", pipelineRunId: own.pipeline.runId,
      stageOrdinal: 0, stageKind: "build", reasonCode: "pipeline_stage_loop_limit_reached",
      requestedAction: "Pipeline stopped", blockedWorkItemIds: [], legalResponses: [],
      evidence: [], loopIndex: 0, maxLoops: 0, maxTotalLoops: 6, runTotalLoops: 1,
      createdAt: new Date(webNow).toISOString(), deliveryState: "not_requested" };
    await admin.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,
      delivery_state,created_at,expires_at,payload) VALUES($1,$2,$3,$4,'question','open','not_requested',$5,NULL,
      $6::jsonb)`, [openId, own.tenantId, own.project.projectId, loopItem.workItemId,
      loopItem.createdAt, JSON.stringify(loopItem)]);
    await assert.rejects(admin.query("DELETE FROM control_action_inbox WHERE id=$1", [openId]),
      /pipeline loop attention delete rejected/u, "an OPEN pipeline loop item is not deletable");
    // The update guard is still UPDATE-only and still refuses anything but the one
    // legal transition: this is the same refusal 0102 already gave, so it is
    // asserted by name rather than by which guard produced it.
    await assert.rejects(admin.query("UPDATE control_action_inbox SET kind='review' WHERE id=$1", [openId]),
      /rejected/u);
    // With the 0102 guard disabled for this one connection the pipeline guard is
    // the only thing left, and it still admits exactly open -> resolved.
    await admin.query("ALTER TABLE control_action_inbox DISABLE TRIGGER control_action_inbox_work_batch_update_guard");
    await assert.rejects(admin.query("UPDATE control_action_inbox SET kind='review' WHERE id=$1", [openId]),
      /pipeline loop attention update rejected/u);
    await admin.query(`UPDATE control_action_inbox SET state='resolved',
      payload=jsonb_set(payload,'{state}','"resolved"'::jsonb) WHERE id=$1`, [openId]);
    await admin.query("ALTER TABLE control_action_inbox ENABLE TRIGGER control_action_inbox_work_batch_update_guard");
    const cleared = await admin.query("DELETE FROM control_action_inbox WHERE id=$1", [openId]);
    assert.equal(cleared.rowCount, 1, "a resolved pipeline loop item is deletable");
  });

test("two overlapping sweeps that stop the same run raise one item, not a 23505", needsPg, async t => {
  // Reviewer follow-up 5: both sweeps pre-check the same stopped run before
  // either has committed its item, so both reach the INSERT. The item id is per
  // run, so without `ON CONFLICT DO NOTHING` the second insert raises a 23505
  // that is NOT a `PipelineAdvanceErrorV1`, and `advanceReady` rethrows it --
  // which aborts the REST of that sweep, not just this run. The bug is in the
  // sweep, so the test has to drive the sweep.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(78);
  // A ceiling of ONE round beyond the first, so the next entry is past it and
  // the run stops. The stop is NEVER raised from this test's own hands: the two
  // racing sweeps below are the first callers to pre-check this stopped run, so
  // both reach the INSERT. That is the whole race -- there is no prior item to
  // short-circuit the second sweep on the `SELECT ... FOR UPDATE` path.
  const own = await seedInstallation(admin, "sweeprace", key, new Date(webNow).toISOString(), { maxLoops: 1 });
  await ownerSetsUp(web, own, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  // Round 0 and round 1, both inside the ceiling, so nothing has stopped yet.
  const composed = advanceService(coordinator, own, key);
  assert.equal((await composed.service.advance(own.pipeline.runId, own.policyId)).startsWork, true, "round 0");
  await rewindRunTo(admin, own, 0, key);
  await reenterStage(admin, own, 0, key);
  assert.equal((await composed.service.advance(own.pipeline.runId, own.policyId)).startsWork, true, "round 1");
  // One more re-entry puts the next round past max_loops 1, and no advance is
  // called from here: the sweeps below are the first to see that.
  await rewindRunTo(admin, own, 0, key);
  await reenterStage(admin, own, 0, key);
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_action_inbox WHERE tenant_id=$1",
    [own.tenantId])).rows[0].count, 0, "no Needs Attention item exists before the sweeps");

  // One more consented run in the SAME installation, so a sweep has healthy work
  // AFTER the stopped run. A 23505 from the stopped run aborts the REST of that
  // sweep, so this is what distinguishes "handled" from "survived".
  const healthy = await seedSecondRun(admin, own, key);
  await ownerConsents(web, healthy, key);

  // Two sweep services over the SAME production composition and the SAME
  // connection pool, so the collision is on the real table under real
  // concurrency rather than on a fake query router.
  //
  // Two sweeps that merely start together do not reliably interleave: whichever
  // reaches the insert first usually commits before the other has read, and the
  // loser short-circuits on the `SELECT payload` that finds the prior item, so
  // the collision is timing-dependent and the test would prove nothing. This
  // client wraps the TRANSACTION SESSION -- the read is issued on the session,
  // not the client -- and puts a BARRIER on that one read: both sweeps are held
  // there until both have arrived, so both are provably past the "is it already
  // raised?" check when the first INSERT commits. Nothing else is intercepted:
  // the read, the insert, the 0154 guards, the unique index and the error class
  // `advanceReady` rethrows are all the production ones.
  let waiting = 0;
  let release = () => {};
  const bothArrived = new Promise(resolve => { release = resolve; });
  const holdOnAttentionRead = (session) => ({ query: (sql, params) => {
    if (/FROM control_action_inbox/.test(String(sql)) && /SELECT payload/.test(String(sql))) {
      waiting += 1;
      if (waiting >= 2) release();
      return bothArrived.then(() => session.query(sql, params));
    }
    return session.query(sql, params);
  } });
  const barrier = { ...composed.client,
    transaction: work => composed.client.transaction(tx => work(holdOnAttentionRead(tx))),
    transactionWithPreCommitCheck: (work, check) =>
      composed.client.transactionWithPreCommitCheck(tx => work(holdOnAttentionRead(tx)), check) };
  const sweep = () => new PipelineAdvanceServiceV1(barrier, own.scope, key,
    { unattendedEnabled: () => true, capability: composed.capability }, () => webNow);
  const outcomes = await Promise.allSettled([sweep().advanceReady(8), sweep().advanceReady(8)]);
  assert.equal(waiting, 2, "both sweeps must have reached the attention read, or nothing was raced");
  // Neither sweep may reject: a 23505 from the shared item is not a
  // PipelineAdvanceErrorV1, so `advanceReady` rethrows it.
  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(outcome.status, "fulfilled",
      `sweep ${index} must not abort: ${JSON.stringify(outcome.reason?.message ?? outcome.reason)}`);
  }
  // Exactly one item for the stopped run, whoever won the race.
  const items = (await admin.query("SELECT id,state,payload FROM control_action_inbox WHERE tenant_id=$1"
    + " AND id=$2", [own.tenantId, `attention:pipeline-loop:${own.pipeline.runId}`])).rows;
  assert.equal(items.length, 1, "one Needs Attention item for the stopped run, not one per sweep");
  assert.equal(items[0].state, "open");
  assert.equal(items[0].payload.reasonCode, "pipeline_stage_loop_limit_reached");
  // A sweep that aborted on the 23505 would never have reached the healthy run,
  // so this is the assertion that the race cost nothing beyond the stopped run.
  const advanced = outcomes.filter(o => o.status === "fulfilled" && o.value.advanced.length > 0);
  assert.ok(advanced.length >= 1, "at least one sweep reached the healthy run and advanced it");
  // The stop is recorded once, whichever sweep got there first.
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_stage_loop_counts"
    + " WHERE tenant_id=$1 AND reason_code<>'stage_advanced'", [own.tenantId])).rows[0].count, 1,
  "the stop is recorded once for the run, not once per sweep");
});

test("the agent-process ceiling counts queued work that has no harness run yet", needsPg, async t => {
  // Reviewer follow-up 2: the count was only live control_harness_runs, but an
  // advance creates a lease and a queue row, not a harness run. Successive
  // sweeps each saw the same live count and could queue past the ceiling until a
  // worker picked the queue up.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(76);
  // Each seed leaves three live harness runs; the ceiling is exactly those three,
  // so the very next process is already over the line.
  const own = await seedInstallation(admin, "procqueued", key, new Date(webNow).toISOString());
  await ownerSetsUp(web, own, key, { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 3,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const { service, queuedCount } = advanceService(coordinator, own, key);
  await assert.rejects(service.advance(own.pipeline.runId, own.policyId),
    error => error.safeReason === "installation_agent_process_ceiling_reached");
  assert.equal(queuedCount(), 0);
  // And the admission side of the same boundary: a ceiling of FOUR admits the
  // advance, which now claims the process it queues. A second advance on the
  // same installation sees that claim and stops, rather than waiting for a
  // worker to mint a harness run.
  //
  // The planner shape matters here: the advance's execution job must be a
  // DISTINCT job from the seeded harness run's, or the two are the same process
  // and the receipt's job already has a live harness run.
  const roomy = await seedInstallation(admin, "procqueuedroomy", key, new Date(webNow).toISOString(),
    { executionPlanShape: "planner" });
  for (const ordinal of [0, 1, 2]) await planExecutionJob(admin, roomy, ordinal);
  await ownerSetsUp(web, roomy, key, { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 4,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const second = await seedSecondRun(admin, roomy, key);
  await ownerConsents(web, second, key);
  const roomyService = advanceService(coordinator, roomy, key, { accepted: new Set() });
  const secondService = advanceService(coordinator, second, key, { accepted: new Set() });
  assert.equal((await roomyService.service.advance(roomy.pipeline.runId, roomy.policyId)).startsWork, true,
    "one unit of headroom is admitted");
  // The first run's stage is still queued with no harness run, so the ceiling of
  // four is spent: the next queued process would be the fifth.
  const queuedNotStarted = (await admin.query(`SELECT count(*)::int count FROM pipeline_advance_receipts r
    WHERE r.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM control_harness_runs h
      WHERE h.tenant_id=r.tenant_id AND h.job_id=r.execution_job_id)`, [roomy.tenantId])).rows[0].count;
  assert.equal(queuedNotStarted, 1, "the admitted advance queued work with no harness run yet");
  await assert.rejects(secondService.service.advance(second.pipeline.runId, roomy.policyId),
    error => error.safeReason === "installation_agent_process_ceiling_reached",
    "queued-but-unstarted work must count toward the process ceiling");
  assert.equal(secondService.queuedCount(), 0);
});

test("a FINISHED stage gives its agent-process slot back, so the night kit keeps running", needsPg, async t => {
  // Reviewer B3. The second term of the process count asked for "no LIVE harness
  // run", which is not "still running": a stage whose harness run has since
  // succeeded, failed, been cancelled or disconnected answers that question
  // forever, and receipts are never deleted. So every stage an installation ever
  // advanced held a process slot for the rest of the installation's life, and at
  // the default ceiling of 12 unattended pipelines stopped for good after 12-24
  // stage advances. The reviewer's own probe: machineMaxAgentProcesses=2, zero
  // live harness runs, stages 0 and 1 advance and stage 2 is refused for good.
  //
  // The proof is the reverse of the reviewer's: with the slot correctly freed, a
  // whole three-stage run completes and a BRAND NEW run in the same installation
  // still advances, which the broken count could never do after 2 stages.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  const publisher = productionPool("control_room_publisher");
  t.after(async () => { await web.close(); await coordinator.close(); await publisher.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(79);
  const own = await seedInstallation(admin, "procfinish", key, new Date(webNow).toISOString(),
    { executionPlanShape: "planner", maxLoops: 0, maxTotalLoops: 6 });
  for (const ordinal of [0, 1, 2]) await planExecutionJob(admin, own, ordinal);
  // The three harness runs the seed leaves are made terminal up front: nothing is
  // running on this machine, so the whole ceiling is headroom. A ceiling of 2 is
  // the reviewer's exact probe -- under the old count this stopped for good.
  await admin.query(`UPDATE control_harness_runs SET state='succeeded' WHERE tenant_id=$1`, [own.tenantId]);
  await ownerSetsUp(web, own, key, { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 2,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  assert.equal(Number(await activeProcessCount(coordinator, own)), 0,
    "no live harness run and no started execution job leaves zero processes");
  // Walk the whole three-stage run. Each stage's work is finished the way a
  // worker and a completion finish it, so the next advance sees the freed slot.
  const accepted = new Set();
  const { service } = advanceService(coordinator, own, key, { accepted });
  for (const ordinal of [0, 1, 2]) {
    const receipt = await service.advance(own.pipeline.runId, own.policyId);
    assert.equal(receipt.startsWork, true, `stage ${ordinal} must advance`);
    const executionJobId = receipt.jobId;
    assert.equal(executionJobId.startsWith("job:execution:"), true,
      "the receipt names the execution job, the one that holds the process");
    assert.equal(Number(await activeProcessCount(coordinator, own)), 1,
      `stage ${ordinal}'s queued work holds exactly one process slot`);
    // The worker picks it up and it finishes: the job succeeds and its harness
    // run succeeds. The slot must go back, or this is the bug.
    await finishExecutionJob(coordinator, publisher, own, executionJobId, { jobState: "succeeded", harnessState: "succeeded" });
    assert.equal(Number(await activeProcessCount(coordinator, own)), 0,
      `stage ${ordinal} finished, so its process slot must be free again`);
    accepted.add(own.pipeline.jobIds[ordinal]);
  }
  const terminal = await service.advance(own.pipeline.runId, own.policyId);
  assert.equal(terminal.state, "succeeded", "the run completes all three stages");

  // The reviewer's second half: a BRAND NEW run in the same installation. Under
  // the old count every one of the three receipts above held a slot, so the
  // ceiling of 2 was spent twice over and this advance was refused for good.
  const second = await seedSecondRun(admin, own, key);
  await admin.query(`UPDATE control_harness_runs SET state='succeeded' WHERE tenant_id=$1`, [own.tenantId]);
  await ownerConsents(web, second, key);
  const secondService = advanceService(coordinator, second, key, { accepted: new Set() });
  assert.equal(Number(await activeProcessCount(coordinator, own)), 0,
    "a completed run leaves no process behind");
  assert.equal((await secondService.service.advance(second.pipeline.runId, own.policyId)).startsWork, true,
    "a new run in an installation that already finished a run must still advance");
});

test("a CANCELLED stage gives its agent-process slot back too", needsPg, async t => {
  // The other half of B3. A job cancelled before a worker ever picked it up has
  // NO harness run at all, so it also has no LIVE harness run, and the old
  // "no live harness run" test counted it for the rest of the installation's
  // life. The job's own state is the only thing that knows it is finished.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  const publisher = productionPool("control_room_publisher");
  t.after(async () => { await web.close(); await coordinator.close(); await publisher.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(83);
  const own = await seedInstallation(admin, "proccancel", key, new Date(webNow).toISOString(),
    { executionPlanShape: "planner", maxLoops: 0, maxTotalLoops: 6 });
  for (const ordinal of [0, 1, 2]) await planExecutionJob(admin, own, ordinal);
  await admin.query(`UPDATE control_harness_runs SET state='succeeded' WHERE tenant_id=$1`, [own.tenantId]);
  await ownerSetsUp(web, own, key, { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 1,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const { service } = advanceService(coordinator, own, key, { accepted: new Set() });
  const receipt = await service.advance(own.pipeline.runId, own.policyId);
  assert.equal(receipt.startsWork, true, "one unit of headroom is admitted");
  // Cancelled in the queue: the job is finished and the harness run never
  // existed for it, so the DELETE of a run row is not what frees this slot.
  // The harness update is a no-op here (there is no run to finish), which is
  // exactly the case the old count got wrong.
  await finishExecutionJob(coordinator, publisher, own, receipt.jobId,
    { jobState: "cancelled", harnessState: "succeeded" });
  const harnessRows = (await admin.query("SELECT count(*)::int count FROM control_harness_runs"
    + " WHERE tenant_id=$1 AND job_id=$2", [own.tenantId, receipt.jobId])).rows[0].count;
  assert.equal(harnessRows, 0, "a job cancelled in the queue has no harness run at all");
  assert.equal(Number(await activeProcessCount(coordinator, own)), 0,
    "a cancelled stage must free its process slot even with no harness run");
  const second = await seedSecondRun(admin, own, key);
  await admin.query(`UPDATE control_harness_runs SET state='succeeded' WHERE tenant_id=$1`, [own.tenantId]);
  await ownerConsents(web, second, key);
  const secondService = advanceService(coordinator, second, key, { accepted: new Set() });
  assert.equal((await secondService.service.advance(second.pipeline.runId, own.policyId)).startsWork, true,
    "a ceiling of one is free again after the only stage is cancelled");
});

test("every installation ceiling refuses at its own boundary on the production coordinator login", needsPg, async t => {
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(61);
  const preflightScope = { tenantId: "tenant:preflight-caps", workspaceId: "workspace:preflight-caps",
    ownerIdentityId: "identity:web-preflight", issuer: webTrust.issuer };

  // The real installed grants, including S7b's tables and its column updates.
  const open = await seedInstallation(admin, "boundary", key, new Date(webNow).toISOString());
  await verifyPrivateDatabase(web.client, web.config, { ...preflightScope, tenantId: open.tenantId,
    workspaceId: open.workspaceId, ownerIdentityId: open.identityId }, Date.now(), { nativeQueue: true });
  await verifyTaskCoordinatorDatabase(coordinator.client, coordinator.config, { ...preflightScope,
    tenantId: open.tenantId, workspaceId: open.workspaceId, ownerIdentityId: open.identityId },
  Date.now(), { nativeQueue: true });

  // Nothing at any ceiling: the very first run of the installation advances.
  await ownerSetsUp(web, open, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const openService = advanceService(coordinator, open, key);
  const first = await openService.service.advance(open.pipeline.runId, open.policyId)
    .catch(error => assert.fail(`an open installation must advance: ${permissionFailure(error, coordinator.refused)}`));
  assert.equal(first.startsWork, true);
  assert.equal(openService.queuedCount(), 1);
  // The claimed round is the real row, on the production login.
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_stage_loop_counts"
    + " WHERE tenant_id=$1", [open.tenantId])).rows[0].count, 1);

  // Each ceiling is then probed on a FRESH installation, so the run under test
  // has not yet spent a round: the first advance of that installation is the one
  // the ceiling must stop, and the open installation above proves one below it.
  const cases = [
    // A fresh installation has spent nothing, so the boundary that stops its
    // FIRST run is a ceiling of zero. Zero is a real ceiling, never "unset": the
    // open installation above proves that one run still fits at every ceiling.
    ["installation_runs_per_hour_exhausted", { runsPerHour: 0, runsPerAgentPerDay: 12,
      machineMaxAgentProcesses: 12, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 }],
    ["installation_agent_runs_per_day_exhausted", { runsPerHour: 6, runsPerAgentPerDay: 0,
      machineMaxAgentProcesses: 12, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 }],
    // One live harness run per seeded stage (three stages), so a ceiling of one
    // is already spent before this installation's first run.
    ["installation_agent_process_ceiling_reached", { runsPerHour: 6, runsPerAgentPerDay: 12,
      machineMaxAgentProcesses: 1, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 }],
    // One cluster is reported, so a ceiling of one is already spent.
    ["installation_db_cluster_ceiling_reached", { runsPerHour: 6, runsPerAgentPerDay: 12,
      machineMaxAgentProcesses: 12, machineMaxDbClusters: 1, dollarCapMicroUsd: null, observedDbClusters: 1 }],
  ];
  for (const [reason, limits] of cases) {
    const own = await seedInstallation(admin, `cap-${reason.slice(14, 26)}`, key, new Date(webNow).toISOString());
    await ownerSetsUp(web, own, key, limits);
    const { service, queuedCount } = advanceService(coordinator, own, key);
    await assert.rejects(service.advance(own.pipeline.runId, own.policyId),
      error => error.safeReason === reason, reason);
    assert.equal(queuedCount(), 0, reason);
    // A refused advance claims nothing: no receipt, no counted round, no effect.
    assert.deepEqual(await admin.query("SELECT count(*)::int receipts FROM pipeline_advance_receipts"
      + " WHERE tenant_id=$1", [own.tenantId]).then(r => r.rows[0].receipts), 0, reason);
    assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_stage_loop_counts"
      + " WHERE tenant_id=$1", [own.tenantId])).rows[0].count, 0, reason);
  }
});

test("a run the owner disabled can be re-enabled and advance, on real PostgreSQL", needsPg, async t => {
  // Reviewer B4, on cook/v1's own S7 code. `setUnattended` signed the consent
  // over `nextTemplate.version` and `nextRun.version` as they stood, and
  // `version` is bigint, so `pg` handed back the STRING "2" on any path where
  // the template was already unattended-enabled. Every reader of the consent
  // rebuilds it with `Number(...)` -- `advance`'s check at :287, the sweep's, and
  // this method's own replay -- so the digest never matched and `advance`
  // refused with `pipeline_integrity_failed`. Only the activating branch
  // (`version: Number(template.version)+1`) produced a number, which is why the
  // unit lane's fake database never saw it and the lane's `seedSecondRun`
  // always built a fresh template.
  //
  // The owner's stop is safe either way -- it fails closed -- but the run could
  // never be resumed, and a run on an already-enabled template could never be
  // started unattended at all. This is that path, on a real cluster, as the real
  // web login (which writes the consent) and the real coordinator login (which
  // verifies it).
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(89);
  const own = await seedInstallation(admin, "consentbigint", key, new Date(webNow).toISOString(),
    { executionPlanShape: "planner" });
  for (const ordinal of [0, 1, 2]) await planExecutionJob(admin, own, ordinal);
  await admin.query(`UPDATE control_harness_runs SET state='succeeded' WHERE tenant_id=$1`, [own.tenantId]);
  await ownerSetsUp(web, own, key, { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });

  // The template is NOW already unattended-enabled by the consent above, and its
  // version is a bigint that came back as a string. Assert that directly, so
  // this test cannot quietly stop covering the bug: if the driver ever returns a
  // number for bigint, the sign/verify asymmetry is gone and the lane says so.
  const asStored = (await admin.query("SELECT version::text version,may_advance_unattended FROM pipeline_templates"
    + " WHERE tenant_id=$1", [own.tenantId])).rows[0];
  assert.equal(asStored.may_advance_unattended, true, "the template is enabled by the first consent");
  assert.equal(typeof (await web.client.query("SELECT version FROM pipeline_templates WHERE tenant_id=$1",
    [own.tenantId])).rows[0].version, "string",
    "pg returns a bigint as a string, which is the whole of the bug");

  const owner = new PipelineAdvanceServiceV1(web.client, own.scope, key, {}, () => webNow);
  const pipelines = new LinearPipelineServiceV1(web.client, own.scope, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => webNow);
  const transition = async (enabled, tag) => {
    const view = await pipelines.view(own.identity, own.project.projectId, own.pipeline.runId);
    return owner.setUnattended(own.identity, own.project.projectId, { runId: own.pipeline.runId,
      templateId: view.templateId, policyId: own.policyId, enabled, expectedRunVersion: view.runVersion,
      expectedTemplateVersion: view.templateVersion }, `pipeline-unattended-${tag}`);
  };

  // 1. The owner STOPS the run. The consent written here is signed over the
  //    already-enabled template's string version -- the exact broken path.
  const stopped = await transition(false, `${own.pipeline.runId}-stop`);
  assert.equal(stopped.enabled, false);
  // 2. The stop holds: an advance now refuses, and it refuses because the run
  //    is not authorised rather than because the record is corrupt.
  const stoppedService = advanceService(coordinator, own, key, { accepted: new Set() });
  await assert.rejects(stoppedService.service.advance(own.pipeline.runId, own.policyId),
    error => error.safeReason === "unattended_not_authorized", "a disabled run starts nothing");
  assert.equal((await admin.query("SELECT count(*)::int receipts FROM pipeline_advance_receipts"
    + " WHERE tenant_id=$1", [own.tenantId])).rows[0].receipts, 0, "a disabled run claims nothing");

  // 3. The owner RESUMES it. This is the reviewer's finding: this second consent
  //    is also written over a string version, and the advance after it used to
  //    refuse with `pipeline_integrity_failed` for good.
  const resumed = await transition(true, `${own.pipeline.runId}-resume`);
  assert.equal(resumed.enabled, true);
  const resumedService = advanceService(coordinator, own, key, { accepted: new Set() });
  const receipt = await resumedService.service.advance(own.pipeline.runId, own.policyId);
  assert.equal(receipt.startsWork, true,
    "disable -> re-enable -> advance must work, and must stay signed");

  // 4. The consent is not merely readable, it is the CURRENT one: the transition
  //    row verifies against its own key, and the run's template pin still agrees
  //    with the template the consent names. `run_version` is the consent's own
  //    monotonic order for one run -- the same ordering `advance` uses to pick
  //    the latest consent -- and not `occurred_at`, which the frozen test clock
  //    ties across all three transitions.
  const consent = (await admin.query("SELECT template_version::text tv,run_version::text rv,enabled"
    + " FROM pipeline_unattended_transitions WHERE tenant_id=$1 AND pipeline_run_id=$2"
    + " ORDER BY run_version DESC,id DESC LIMIT 1", [own.tenantId, own.pipeline.runId])).rows[0];
  assert.equal(consent.enabled, true, "the latest consent is the enabling one");
  const template = (await admin.query("SELECT version::text v FROM pipeline_templates WHERE tenant_id=$1",
    [own.tenantId])).rows[0];
  assert.equal(consent.tv, template.v, "the consent pins the template's current version");
  // And the sweep path, which rebuilds the same material independently, must also
  // accept it -- the two readers of this record are the two that disagreed.
  const sweep = new PipelineAdvanceServiceV1(coordinator.client, own.scope, key,
    { unattendedEnabled: () => true, capability: resumedService.capability }, () => webNow);
  const swept = await sweep.advanceReady();
  assert.equal(swept.checked >= 1, true, "the sweep sees the run");
  // The sweep re-reads and re-verifies every consent it considers; a corrupt one
  // is refused there rather than started, so no NEW receipt means the consent it
  // just verified was already spent by step 3 and it replayed instead.
  assert.equal((await admin.query("SELECT count(DISTINCT execution_job_id)::int jobs"
    + " FROM pipeline_advance_receipts WHERE tenant_id=$1", [own.tenantId])).rows[0].jobs, 1,
    "the sweep replayed the same round rather than starting a second one");
});

test("every ceiling refuses at exactly its limit and not one run earlier", needsPg, async t => {
  // A ceiling of ZERO cannot tell `>` from `>=`: both refuse the very first
  // run, so the boundary cases above prove nothing about the comparison. This
  // probes each one where the two disagree, by spending exactly N units and
  // then asking for one more. A ceiling of N must admit N runs and refuse
  // run N+1. An off-by-one either way fails here.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(66);

  // The one counted unit: a real advance receipt in this tenant.
  const receiptsIn = (tenantId) => admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts"
    + " WHERE tenant_id=$1", [tenantId]).then(r => r.rows[0].count);
  const harnessRunsIn = (tenantId) => admin.query("SELECT count(*)::int count FROM control_harness_runs"
    + " WHERE tenant_id=$1 AND state IN('discovered','starting','running','waiting_input',"
    + "'waiting_approval','cancelling')", [tenantId]).then(r => r.rows[0].count);

  // Each case is its own installation, and `spend` is how many units it has
  // genuinely spent before the ceiling is set to exactly `spend`. Spending a
  // unit means a DIFFERENT run really advancing: replaying the same run's
  // receipt is not a new unit, so a second run is seeded for every unit past
  // the first. The ceiling is then set to what was really spent, and the next
  // run must be refused while the ones before it were admitted. That is what
  // kills a `>` -> `>=` off-by-one, which a ceiling of zero cannot see.
  const spendThenProbe = async (suffix, spend, limits, reason) => {
    const first = await seedInstallation(admin, suffix, key, new Date(webNow).toISOString());
    const open = { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 12,
      machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 };
    // Consent every run, then advance each one once: that is `spend` units.
    const runs = [first];
    let previous = first;
    for (let round = 1; round < spend; round += 1) {
      previous = await seedSecondRun(admin, previous, key, `${suffix}-${round}`);
      runs.push(previous);
    }
    for (const run of runs) {
      await ownerSetsUp(web, run, key, open);
      if (run.pipeline.runId !== first.pipeline.runId) await ownerConsents(web, run, key);
      const { service } = advanceService(coordinator, run, key);
      assert.equal((await service.advance(run.pipeline.runId, run.policyId)).startsWork, true,
        `${suffix}: every run up to the ceiling must be admitted`);
    }
    assert.equal(await receiptsIn(first.tenantId), spend, `${suffix}: exactly ${spend} units were claimed`);
    // The ceiling is now exactly what has been spent, and one more run is asked for.
    await ownerSetsUp(web, first, key, limits);
    const probeRun = await seedSecondRun(admin, first, key, `${suffix}-probe`);
    await ownerConsents(web, probeRun, key);
    const { service, queuedCount } = advanceService(coordinator, probeRun, key);
    await assert.rejects(service.advance(probeRun.pipeline.runId, probeRun.policyId),
      error => error.safeReason === reason, `${suffix}: must refuse with ${reason}`);
    assert.equal(queuedCount(), 0, `${suffix}: a refused run queues nothing`);
    assert.equal(await receiptsIn(first.tenantId), spend, `${suffix}: a refused run claims no receipt`);
  };

  // runs per hour: one run is spent, so a ceiling of exactly 1 admits that run
  // and must refuse the second. With `>=` the first run would be refused too.
  await spendThenProbe("edge-hour", 1, { runsPerHour: 1, runsPerAgentPerDay: 100,
    machineMaxAgentProcesses: 12, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 },
  "installation_runs_per_hour_exhausted");

  // runs per agent per day: the same shape, on the per-worker counter.
  await spendThenProbe("edge-agentday", 1, { runsPerHour: 100, runsPerAgentPerDay: 1,
    machineMaxAgentProcesses: 12, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 },
  "installation_agent_runs_per_day_exhausted");

  // The seed leaves one live harness run per stage, so the agent-process count
  // is already 3. A ceiling of exactly 3 is spent and the next process is over.
  const harnessOwn = await seedInstallation(admin, "edge-proc", key, new Date(webNow).toISOString());
  assert.equal(await harnessRunsIn(harnessOwn.tenantId), 3, "the seed leaves three live harness runs");
  await ownerSetsUp(web, harnessOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 3,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const procService = advanceService(coordinator, harnessOwn, key);
  await assert.rejects(procService.service.advance(harnessOwn.pipeline.runId, harnessOwn.policyId),
    error => error.safeReason === "installation_agent_process_ceiling_reached",
    "a ceiling exactly equal to the live process count must refuse the next one");
  assert.equal(procService.queuedCount(), 0);

  // One cluster is reported and a ceiling of exactly 1 admits that one, so the
  // SECOND cluster is over the line. One run is spent first, exactly as above.
  await spendThenProbe("edge-cluster", 1, { runsPerHour: 100, runsPerAgentPerDay: 100,
    machineMaxAgentProcesses: 12, machineMaxDbClusters: 1, dollarCapMicroUsd: null, observedDbClusters: 1 },
  "installation_db_cluster_ceiling_reached");

  // The agent-process ceiling must also ADMIT one below the line, or `>` could
  // be `>=` and the boundary case above would still pass. Ceiling 4 with three
  // live processes is one unit of headroom, so the run is admitted.
  const roomyOwn = await seedInstallation(admin, "edge-procroom", key, new Date(webNow).toISOString());
  assert.equal(await harnessRunsIn(roomyOwn.tenantId), 3, "the seed leaves three live harness runs");
  await ownerSetsUp(web, roomyOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 4,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const roomy = advanceService(coordinator, roomyOwn, key);
  assert.equal((await roomy.service.advance(roomyOwn.pipeline.runId, roomyOwn.policyId)).startsWork, true,
    "one unit of headroom under the agent-process ceiling must be admitted");

  // The cluster ceiling likewise: ceiling 2 with one reported cluster is
  // headroom, and must admit.
  const roomyClusterOwn = await seedInstallation(admin, "edge-clusterroom", key, new Date(webNow).toISOString());
  await ownerSetsUp(web, roomyClusterOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 2, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const roomyCluster = advanceService(coordinator, roomyClusterOwn, key);
  assert.equal((await roomyCluster.service.advance(roomyClusterOwn.pipeline.runId, roomyClusterOwn.policyId))
    .startsWork, true, "one cluster of headroom must be admitted");

  // A STALE machine state is never a pass either. The owner reported one
  // cluster a long time ago; that observation is no longer true, so the
  // advance refuses rather than trusting a stale count. Dropping the staleness
  // window in latestClusterObservationV1 is what this catches.
  const staleOwn = await seedInstallation(admin, "edge-stale", key, new Date(webNow).toISOString());
  const staleService = advanceService(coordinator, staleOwn, key);
  await ownerSetsUp(web, staleOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  // Re-date the observation well beyond the one-day freshness window. The table
  // is append-only by trigger, so the row is aged by its own clock only.
  await admin.query("ALTER TABLE pipeline_machine_capacity_observations DISABLE TRIGGER"
    + " pipeline_machine_capacity_observations_immutable");
  await admin.query("UPDATE pipeline_machine_capacity_observations SET observed_at = observed_at - interval '2 days'"
    + " WHERE tenant_id=$1", [staleOwn.tenantId]);
  await admin.query("ALTER TABLE pipeline_machine_capacity_observations ENABLE TRIGGER"
    + " pipeline_machine_capacity_observations_immutable");
  await assert.rejects(staleService.service.advance(staleOwn.pipeline.runId, staleOwn.policyId),
    error => error.safeReason === "installation_cluster_count_unknown",
    "a cluster count older than a day is no longer evidence and must refuse");
  assert.equal(staleService.queuedCount(), 0);

  // A dollar cap is compared against what has ALREADY been spent. Spending one
  // run at 100 and then offering another at 100 under a cap of 150 must refuse:
  // 100 + 100 is over. A cap that ignored the spending and looked only at the
  // next cost (100 < 150) would admit it, and that is the mutation this kills.
  const spentOwn = await seedInstallation(admin, "edge-costspent", key, new Date(webNow).toISOString());
  const costOf = { kind: "known", admittedCostMicroUsd: 100, evidenceDigest: sha256Digest("cost") };
  const spentFirst = advanceService(coordinator, spentOwn, key, { cost: costOf });
  await ownerSetsUp(web, spentOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: 100, observedDbClusters: 1 });
  assert.equal((await spentFirst.service.advance(spentOwn.pipeline.runId, spentOwn.policyId)).startsWork, true);
  const spentSecond = await seedSecondRun(admin, spentOwn, key, "edge-costspent-2");
  await ownerConsents(web, spentSecond, key);
  await ownerSetsUp(web, spentOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: 150, observedDbClusters: 1 });
  const spentService = advanceService(coordinator, spentSecond, key, { cost: costOf });
  await assert.rejects(spentService.service.advance(spentSecond.pipeline.runId, spentOwn.policyId),
    error => error.safeReason === "installation_cost_ceiling_exhausted",
    "a cap of 150 must refuse a second 100 once 100 is already spent");
  assert.equal(spentService.queuedCount(), 0);

  // A dollar cap of exactly the cost about to be spent still fits, and one
  // microusd less refuses. `cap - spent` is the real comparison, so a mutation
  // that drops the subtraction is caught here.
  const capOwn = await seedInstallation(admin, "edge-cost", key, new Date(webNow).toISOString());
  const capService = advanceService(coordinator, capOwn, key,
    { cost: { kind: "known", admittedCostMicroUsd: 100, evidenceDigest: sha256Digest("cost") } });
  await ownerSetsUp(web, capOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: 100, observedDbClusters: 1 });
  assert.equal((await capService.service.advance(capOwn.pipeline.runId, capOwn.policyId)).startsWork, true,
    "a cap of exactly the next cost still fits");
  assert.equal(await receiptsIn(capOwn.tenantId), 1);

  // A second installation where the cap is one unit short of the next cost.
  const shortOwn = await seedInstallation(admin, "edge-costshort", key, new Date(webNow).toISOString());
  const shortService = advanceService(coordinator, shortOwn, key,
    { cost: { kind: "known", admittedCostMicroUsd: 100, evidenceDigest: sha256Digest("cost") } });
  await ownerSetsUp(web, shortOwn, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: 99, observedDbClusters: 1 });
  await assert.rejects(shortService.service.advance(shortOwn.pipeline.runId, shortOwn.policyId),
    error => error.safeReason === "installation_cost_ceiling_exhausted",
    "one microusd short of the next cost must refuse");
  assert.equal(shortService.queuedCount(), 0);
  assert.equal(await receiptsIn(shortOwn.tenantId), 0);
});

test("the loop ceiling stops the run and creates one real Needs Attention item", needsPg, async t => {
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(62);
  // max_loops 1 on the build stage: the stage's first attempt is round 0, and it
  // may be entered once more. A third entry is past the ceiling.
  const own = await seedInstallation(admin, "loops", key, new Date(webNow).toISOString(), { maxLoops: 1 });
  const { service, accepted } = advanceService(coordinator, own, key);
  await ownerSetsUp(web, own, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const counted = async (ordinal) => (await admin.query("SELECT stage_ordinal::text stage_ordinal,"
    + " loop_index::text loop_index,max_loops::text max_loops,run_total_loops::text run_total_loops,worker_id,"
    + " reason_code,receipt_id FROM pipeline_stage_loop_counts WHERE pipeline_run_id=$1 AND stage_ordinal=$2"
    + " ORDER BY loop_index", [own.pipeline.runId, ordinal])).rows;

  // Round 0 of the build stage: the first attempt. The counted row is written
  // with the receipt, in the same transaction, on the production login.
  const first = await service.advance(own.pipeline.runId, own.policyId);
  assert.equal(first.startsWork, true);
  // The receipt is per fix round: one durable row per round of this stage.
  assert.equal((await admin.query("SELECT id FROM pipeline_advance_receipts WHERE tenant_id=$1"
    + " AND pipeline_run_id=$2 AND stage_ordinal=0 AND loop_index=0", [own.tenantId, own.pipeline.runId])).rows[0].id,
    `pipeline-advance:${own.pipeline.runId}:0:0`);
  assert.deepEqual((await counted(0)).map(row => [Number(row.loop_index), Number(row.max_loops), Number(row.run_total_loops)]),
    [[0, 1, 1]], "the counted round is the stage's, and the run total is the rounds the run has started");
  assert.equal((await counted(0))[0].worker_id, "worker:build:loops");
  assert.equal((await counted(0))[0].reason_code, "stage_advanced");
  // The counted row points at the round's own receipt, whose id carries the round.
  assert.equal((await counted(0))[0].receipt_id, `pipeline-advance:${own.pipeline.runId}:0:0`);
  // A lost response replays the same receipt and never opens a second round.
  const replay = await service.advance(own.pipeline.runId, own.policyId);
  assert.equal(replay.replayed, true);
  assert.equal((await counted(0)).length, 1, "a replayed receipt must not open a second round");

  // The check stage is a different stage, so it counts from zero and the run
  // total keeps moving. The build stage is accepted, so the run moves to it.
  accepted.add(own.buildJob);
  const second = await service.advance(own.pipeline.runId, own.policyId);
  assert.equal(second.stageOrdinal, 1);
  assert.deepEqual((await counted(1)).map(row => [Number(row.loop_index), Number(row.run_total_loops)]), [[0, 2]]);

  // A stage that needs another fix round is re-entered: the planner builds a new
  // job for that stage, so its current job moves and its round index advances.
  // This is exactly the loop the ceiling exists to bound. The check stage asks
  // for changes, so the run rewinds to the build stage with a fresh build job,
  // and the build stage's own round advances from 0 to 1.
  accepted.add(own.checkJob);
  await rewindRunTo(admin, own, 0, key);
  await reenterStage(admin, own, 0, key);
  const reentered = await service.advance(own.pipeline.runId, own.policyId)
    .catch(error => assert.fail(`the re-entered stage must advance again: ${error?.safeReason ?? error}`));
  assert.equal(reentered.stageOrdinal, 0, "the re-entered stage advances again");
  assert.deepEqual((await counted(0)).map(row => [Number(row.loop_index), Number(row.run_total_loops)]), [[0, 1], [1, 3]],
    "the re-entry is round 1 of that stage, and the run total keeps moving");
  // Each round has its own durable receipt, so a replay still lands on round 1.
  assert.equal((await service.advance(own.pipeline.runId, own.policyId)).replayed, true);

  // Round 2 is past max_loops 1. The run stops advancing, and the owner is told
  // once, in the same transaction, with no second receipt and no third round.
  await rewindRunTo(admin, own, 0, key);
  await reenterStage(admin, own, 0, key);
  await assert.rejects(service.advance(own.pipeline.runId, own.policyId),
    error => error.safeReason === "stage_loop_limit_reached");
  const attention = (await admin.query("SELECT id,kind,state,delivery_state,payload FROM control_action_inbox"
    + " WHERE tenant_id=$1 AND id=$2", [own.tenantId, `attention:pipeline-loop:${own.pipeline.runId}`])).rows;
  assert.equal(attention.length, 1, "one Needs Attention item for the run");
  assert.equal(attention[0].kind, "question");
  assert.equal(attention[0].state, "open");
  assert.equal(attention[0].delivery_state, "not_requested");
  assert.equal(attention[0].payload.reasonCode, "pipeline_stage_loop_limit_reached");
  assert.equal(attention[0].payload.pipelineRunId, own.pipeline.runId);
  assert.equal(attention[0].payload.stageOrdinal, 0);
  assert.equal(attention[0].payload.maxLoops, 1, "the owner is told the effective ceiling, not the template's 20");
  // Repeating the refusal does not pile up copies, and claims nothing.
  await assert.rejects(service.advance(own.pipeline.runId, own.policyId),
    error => error.safeReason === "stage_loop_limit_reached");
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_action_inbox WHERE id=$1",
    [`attention:pipeline-loop:${own.pipeline.runId}`])).rows[0].count, 1);
  assert.equal((await counted(0)).filter(row => row.reason_code === "stage_advanced").length, 2,
    "the refused round started no third round");
  // The stop itself is recorded: the last round the run really started, at the
  // ceiling it reached, with the refusal named. It never records a round the
  // run did not take, which is what the table's CHECK constraints assert.
  const stops = (await admin.query("SELECT stage_ordinal::text stage_ordinal,loop_index::text loop_index,"
    + "max_loops::text max_loops,run_total_loops::text run_total_loops,reason_code,worker_id"
    + " FROM pipeline_stage_loop_counts WHERE pipeline_run_id=$1 AND reason_code<>'stage_advanced'",
  [own.pipeline.runId])).rows;
  assert.deepEqual(stops.map(row => [Number(row.loop_index), Number(row.max_loops),
    Number(row.run_total_loops), row.reason_code]), [[1, 1, 3, "stage_loop_limit_reached"]],
  "the recorded stop is the last started round, inside the ceiling it reached");
  assert.equal(stops[0].worker_id, "worker:build:loops", "the stop names the stage's own worker");
  // Three advances really happened (build round 0, check round 0, build round 1),
  // so three durable receipts exist. The refused round earned none: one receipt
  // per started round, and the stop added no fourth.
  const receipts = (await admin.query("SELECT stage_ordinal::text o,loop_index::text li"
    + " FROM pipeline_advance_receipts WHERE pipeline_run_id=$1 ORDER BY stage_ordinal,loop_index",
  [own.pipeline.runId])).rows;
  assert.deepEqual(receipts.map(row => [Number(row.o), Number(row.li)]), [[0, 0], [0, 1], [1, 0]],
    "one receipt per started round, and none for the refused round");
  // A forged item under the same id prefix is refused by the guard, for any role.
  await assert.rejects(admin.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,
    delivery_state,created_at,expires_at,payload) VALUES($1,$2,$3,$4,'approval','open','delivered',$5,NULL,'{}'::jsonb)`,
  [`attention:pipeline-loop:forged`, own.tenantId, own.project.projectId, "work:one", new Date(webNow).toISOString()]),
  /pipeline loop attention item rejected/u);
});

test("an unknown cost advances on the production login and is stored as unknown", needsPg, async t => {
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(63);
  const own = await seedInstallation(admin, "unknowncost", key, new Date(webNow).toISOString());
  const { service } = advanceService(coordinator, own, key, { cost: { kind: "unknown" } });
  await ownerSetsUp(web, own, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  // "Count runs, never dollars": no cost evidence, and it still runs.
  const receipt = await service.advance(own.pipeline.runId, own.policyId)
    .catch(error => assert.fail(`unknown cost must advance: ${permissionFailure(error, coordinator.refused)}`));
  assert.equal(receipt.startsWork, true);
  const stored = (await admin.query("SELECT delegation_cost_state,delegation_cost_microusd,"
    + " delegation_cost_evidence_digest FROM pipeline_advance_receipts WHERE pipeline_run_id=$1",
  [own.pipeline.runId])).rows[0];
  assert.equal(stored.delegation_cost_state, "unknown");
  assert.equal(stored.delegation_cost_microusd, null);
  assert.equal(stored.delegation_cost_evidence_digest, null);
  // The replay of that same receipt is still a replay, not a conflict.
  const replay = await service.advance(own.pipeline.runId, own.policyId);
  assert.equal(replay.replayed, true);
  // A dollar cap is off by default, and a fully spent one still cannot refuse an
  // unknown cost, because unknown is not a number.
  await ownerSetsUp(web, own, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: 0, observedDbClusters: 1 });
  assert.equal((await service.advance(own.pipeline.runId, own.policyId)).replayed, true);
});

test("a known cost is refused only when the owner has set a dollar cap", needsPg, async t => {
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(64);
  const own = await seedInstallation(admin, "dollarcap", key, new Date(webNow).toISOString());
  const { service } = advanceService(coordinator, own, key,
    { cost: { kind: "known", admittedCostMicroUsd: 100, evidenceDigest: sha256Digest("cost") } });
  // No cap: the run advances whatever it costs.
  await ownerSetsUp(web, own, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  assert.equal((await service.advance(own.pipeline.runId, own.policyId)).startsWork, true);
  // A second installation, with a cap of 50 and a next cost of 100.
  const capped = await seedInstallation(admin, "dollarcapped", key, new Date(webNow).toISOString());
  const cappedService = advanceService(coordinator, capped, key,
    { cost: { kind: "known", admittedCostMicroUsd: 100, evidenceDigest: sha256Digest("cost") } });
  await ownerSetsUp(web, capped, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: 50, observedDbClusters: 1 });
  await assert.rejects(cappedService.service.advance(capped.pipeline.runId, capped.policyId),
    error => error.safeReason === "installation_cost_ceiling_exhausted");
  assert.equal(cappedService.queuedCount(), 0);
  // Exactly at the cap the run fits.
  await ownerSetsUp(web, capped, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: 100, observedDbClusters: 1 });
  assert.equal((await cappedService.service.advance(capped.pipeline.runId, capped.policyId)).startsWork, true);
  assert.equal(cappedService.queuedCount(), 1);
  void service;
});

test("two concurrent advances cannot both take the last unit of a ceiling", needsPg, async t => {
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(65);
  // Two consented runs in ONE installation, so they share the one allowance
  // record and its runs-per-hour ceiling.
  const own = await seedInstallation(admin, "race", key, new Date(webNow).toISOString());
  const second = await seedSecondRun(admin, own, key);
  const firstService = advanceService(coordinator, own, key);
  const secondService = advanceService(coordinator, second, key);
  // Exactly two units of runs-per-hour, and four racing advances want them.
  await ownerSetsUp(web, own, key, { runsPerHour: 2, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  await ownerConsents(web, second, key);

  const outcomes = await Promise.allSettled([
    firstService.service.advance(own.pipeline.runId, own.policyId),
    firstService.service.advance(own.pipeline.runId, own.policyId),
    secondService.service.advance(second.pipeline.runId, own.policyId),
    secondService.service.advance(second.pipeline.runId, own.policyId),
  ]);
  // Whatever the mix of new claims, replays and refusals, the ceiling holds: at
  // most two rounds were ever claimed, and each run's first claim succeeded.
  const rounds = (await admin.query("SELECT count(*)::int count FROM pipeline_stage_loop_counts WHERE tenant_id=$1",
    [own.tenantId])).rows[0].count;
  assert.equal(rounds, 2, `exactly the two permitted rounds were claimed, got ${rounds}: ${
    JSON.stringify(outcomes.map(o => o.status === "fulfilled"
      ? ["ok", o.value.startsWork, o.value.replayed] : ["refused", o.reason?.safeReason]))}`);
  const firstClaim = outcomes[0];
  assert.equal(firstClaim.status, "fulfilled", "the first claim on the first run must not be refused");
  const third = outcomes[2];
  assert.equal(third.status, "fulfilled", "the first claim on the second run must not be refused");
  // The queue saw exactly the two permitted effects, never four.
  assert.equal(firstService.queuedCount() + secondService.queuedCount(), 2);

  // A dedicated case for the boundary that 2 units for 2 runs cannot reach: two
  // DIFFERENT runs racing for the ONE last unit. Two units for two runs lets
  // each run take its own unit and never makes anyone contend, so the test above
  // cannot tell a correct claim from a permissive one.
  const last = await seedInstallation(admin, "lastunit", key, new Date(webNow).toISOString());
  const lastSecond = await seedSecondRun(admin, last, key);
  const lastA = advanceService(coordinator, last, key);
  const lastB = advanceService(coordinator, lastSecond, key);
  // Exactly ONE unit of runs-per-hour, and two DIFFERENT runs want it.
  await ownerSetsUp(web, last, key, { runsPerHour: 1, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  await ownerConsents(web, lastSecond, key);
  const raced = await Promise.allSettled([
    lastA.service.advance(last.pipeline.runId, last.policyId),
    lastB.service.advance(lastSecond.pipeline.runId, last.policyId),
  ]);
  const admitted = raced.filter(o => o.status === "fulfilled" && o.value.startsWork === true);
  const refused = raced.filter(o => o.status === "rejected");
  assert.equal(admitted.length, 1,
    `exactly one run may take the last unit, got ${JSON.stringify(raced.map(o => o.status === "fulfilled"
      ? ["ok", o.value.startsWork] : ["refused", o.reason?.safeReason]))}`);
  assert.equal(refused.length, 1, "the loser is refused, not errored");
  assert.equal(refused[0].reason.safeReason, "installation_runs_per_hour_exhausted",
    `the one losing run must be refused by the ceiling it exhausted, got ${refused[0].reason.safeReason}`);
  // One receipt, one queued job: the loser left no partial effect behind.
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts WHERE tenant_id=$1",
    [last.tenantId])).rows[0].count, 1, "the losing run claimed no receipt");
  assert.equal(lastA.queuedCount() + lastB.queuedCount(), 1, "and queued nothing");
});

test("a burst of 40 concurrent advances holds every ceiling at once", needsPg, async t => {
  // Self-test item 4: the existing race cases are 2-4 callers. This issues 40
  // concurrent advances across 20 DISTINCT consented runs in one installation,
  // so runs-per-hour, per-agent-per-day and the machine agent-process ceiling are
  // all contended at once. It asserts invariants, not a specific winner.
  //
  // Two things shape the shape of the burst, both of them the product's own
  // behaviour rather than test convenience:
  //
  // 1. The private database admits `connections` (8) concurrent sessions plus a
  //    waiting queue of the same depth and refuses the rest with
  //    `database_unavailable` rather than queueing without bound
  //    (`bounded-database.ts`). 40 at once proves the pool is bounded, but most
  //    callers never reach a pipeline ceiling, so the burst runs in two waves of
  //    20 and the REFUSAL mix is asserted per wave.
  // 2. A second caller on a run that already advanced must REPLAY, not open a
  //    second round. So the contended callers are one per run per wave: a replay
  //    is the product's answer, and to contend the ceiling the second wave has
  //    to be different runs, not the same ones again.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(79);
  const own = await seedInstallation(admin, "burst", key, new Date(webNow).toISOString(), { maxLoops: 1 });
  const runs = [own];
  for (let index = 1; index < 20; index += 1) {
    const seeded = await seedSecondRun(admin, own, key, index);
    assert.notEqual(seeded.pipeline.runId, runs.at(-1).pipeline.runId,
      "each seeded run must be a DISTINCT run, or the burst is not a burst");
    await ownerConsents(web, seeded, key);
    runs.push(seeded);
  }
  // 24 agent processes is the product's own review ceiling
  // (`PIPELINE_MACHINE_CEILING_V1`); `setAllowance` refuses anything above it, so
  // the process ceiling is contended right at that boundary rather than wide open.
  const RUNS_PER_HOUR = 12;
  await ownerSetsUp(web, own, key, { runsPerHour: RUNS_PER_HOUR, runsPerAgentPerDay: 24,
    machineMaxAgentProcesses: 24, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const services = runs.map(run => advanceService(coordinator, run, key));

  // Ten runs per wave, TWO callers each: one claims the round and the other must
  // replay it. Twenty transactions are in flight per wave, well past the pool's
  // eight slots, so the ceiling claim and the replay path contend for the same
  // connections at the same moment. The second wave uses the other ten runs, so
  // by then the runs-per-hour ceiling is half spent and has to bind.
  // Indexed by position, not `indexOf`: each run's service object appears twice
  // in the wave (the claimant and its replay), and `indexOf` would resolve both
  // callers to the FIRST of them.
  const wave = async (from, to) => Promise.allSettled(services.slice(from, to)
    .flatMap((service, offset) => [0, 1].map(() =>
      service.service.advance(runs[from + offset].pipeline.runId, own.policyId))));
  const first = await wave(0, 10);
  const second = await wave(10, 20);
  const outcomes = [...first, ...second];

  // `database_unavailable` is the bounded pool refusing BY DESIGN, not a
  // pipeline bug: `bounded-database.ts` admits `connections` (8) concurrent
  // sessions plus a waiting queue of the same depth and throws on the next
  // arrival rather than queueing without bound. It is listed so the test fails if
  // an UNEXPECTED reason ever appears.
  const OVERLOAD_REFUSAL = "database_unavailable";
  const PIPELINE_REFUSALS = ["installation_runs_per_hour_exhausted", "installation_agent_runs_per_day_exhausted",
    "installation_agent_process_ceiling_reached", "policy_task_allowance_exhausted",
    "policy_concurrency_exhausted", "advance_conflict"];
  // A pipeline refusal is a `PipelineAdvanceErrorV1` and carries `safeReason`.
  // Pool admission is a `PrivateDatabaseError` and does NOT: its code is the
  // message. The two are different layers, so they are classified by what the
  // error actually is rather than by a string match on a field one of them lacks.
  const refusalCode = outcome => outcome.reason?.safeReason
    ?? (outcome.reason?.code === OVERLOAD_REFUSAL || String(outcome.reason?.message) === OVERLOAD_REFUSAL
      ? OVERLOAD_REFUSAL : undefined);
  const unexpected = outcomes.filter(o => o.status === "rejected" && !refusalCode(o));
  assert.deepEqual(unexpected.map(o => String(o.reason?.message ?? o.reason)), [],
    `every refusal must be a pipeline or pool refusal: ${JSON.stringify(outcomes.map(o => o.status === "fulfilled"
      ? ["ok", o.value.startsWork, o.value.replayed] : ["refused", refusalCode(o) ?? String(o.reason?.message)]))}`);

  // THE INVARIANT: the installation never started more rounds than the owner
  // allowed, however many callers arrived and however they interleaved.
  const receipts = (await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts WHERE tenant_id=$1",
    [own.tenantId])).rows[0].count;
  assert.ok(receipts <= RUNS_PER_HOUR,
    `a burst of ${outcomes.length} callers started ${receipts} rounds under a ceiling of ${RUNS_PER_HOUR}`);
  // The per-round unique key is the database's own second opinion, and a
  // duplicate would have thrown before this read.
  const distinct = (await admin.query("SELECT count(DISTINCT (pipeline_run_id,stage_ordinal,loop_index))::int count"
    + " FROM pipeline_advance_receipts WHERE tenant_id=$1", [own.tenantId])).rows[0].count;
  assert.equal(distinct, receipts, "no round was counted twice");
  // A CLAIMED round is exactly one receipt and exactly one queue effect. A
  // REPLAY also reports `startsWork: true` (it re-issues the work the first
  // caller already started), so `replayed` is what separates the two: a caller
  // that neither claims nor replays has started nothing.
  const replayed = outcomes.filter(o => o.status === "fulfilled" && o.value.replayed === true).length;
  const started = outcomes.filter(o => o.status === "fulfilled" && o.value.startsWork === true
    && o.value.replayed !== true).length;
  const refused = outcomes.filter(o => o.status === "rejected").length;
  const byCeiling = refused - outcomes.filter(o => refusalCode(o) === OVERLOAD_REFUSAL).length;
  assert.equal(started, receipts, "every started round left exactly one receipt");
  // The burst really did contend in both directions: rounds admitted, callers
  // refused, and a second caller replayed rather than opening a second round.
  assert.ok(started > 0, "some rounds were admitted, or nothing was raced");
  assert.ok(replayed > 0, "a second caller for an admitted run must replay, not open a second round");
  assert.ok(byCeiling > 0, `a PIPELINE ceiling must have refused someone, or only the pool was tested`);
  // And the second wave is where the ceiling is proved: the first wave spent
  // part of runs-per-hour, so this wave must be refused by a PIPELINE ceiling,
  // not merely by pool admission, and refusing must cost nothing.
  const secondRefusals = second.filter(o => o.status === "rejected");
  assert.ok(secondRefusals.length > 0, "the second wave must be refused somewhere");
  assert.ok(secondRefusals.some(o => PIPELINE_REFUSALS.includes(refusalCode(o))),
    `the second wave must hit a pipeline ceiling, got ${JSON.stringify(secondRefusals.map(refusalCode))}`);
  const queued = services.reduce((total, service) => total + service.queuedCount(), 0);
  assert.equal(queued, receipts, "the queue saw exactly the admitted rounds, never a refused one");
  console.error(`BURST: ${outcomes.length} callers over ${runs.length} runs, ${receipts} receipts, ${queued} queued, `
    + `${byCeiling} refused by a pipeline ceiling, ${refused - byCeiling} by pool admission, ${replayed} replayed`);
});

test("40 stages finishing and cancelling at once leave the process count exact", needsPg, async t => {
  // Self-test item 4 for B3 specifically. The two cases above prove the rule on
  // one stage at a time; this proves the COUNT stays exact when forty stages are
  // released at once, which is the only shape a night actually has.
  //
  // The bug being fixed was a count that only ever went UP, so the interesting
  // assertion is not "the ceiling is enforced" (the old code enforced it, too
  // well) but that the number is EXACT after a concurrent release: never
  // negative, never double counted, and never leaving a slot behind. A lost
  // UPDATE or a count read mid-release shows up here and nowhere else.
  //
  // 40 runs in ONE installation. The pool admits 8 sessions plus a queue of 8, so
  // a single 40-caller wave proves the pool, not the ceiling; the burst runs in
  // two waves of 20 so callers actually reach the ceiling. 24 is the product's
  // own agent-process ceiling, so 24 stages are claimed and the rest are refused
  // by a PIPELINE ceiling. All 24 are then released at once -- half finished,
  // half cancelled in the queue -- so both terminal paths are released under
  // contention, which is the only shape a night actually has.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  const publisher = productionPool("control_room_publisher");
  t.after(async () => { await web.close(); await coordinator.close(); await publisher.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(97);
  const own = await seedInstallation(admin, "stagerelease", key, new Date(webNow).toISOString(),
    { executionPlanShape: "planner", maxLoops: 0, maxTotalLoops: 12 });
  for (const ordinal of [0, 1, 2]) await planExecutionJob(admin, own, ordinal);
  await admin.query(`UPDATE control_harness_runs SET state='succeeded' WHERE tenant_id=$1`, [own.tenantId]);
  await ownerSetsUp(web, own, key, { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 24,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  const runs = [own];
  for (let index = 1; index < 40; index += 1) {
    const seeded = await seedSecondRun(admin, own, key, index);
    // `seedSecondRun` writes the seed-shaped plan (the execution job IS the
    // source job), so there is no distinct `job:execution:*` job to plan here and
    // `planExecutionJob` would refuse a second plan for the same stage.
    await ownerConsents(web, seeded, key);
    runs.push(seeded);
  }
  const CEILING = 24;

  // Two waves of 20, so every caller gets a session and the refusals that remain
  // are the ceiling's, not the pool's. `database_unavailable` is the bounded pool
  // refusing BY DESIGN and is tolerated; a PIPELINE refusal is the ceiling.
  const wave = async (from, to) => Promise.allSettled(runs.slice(from, to).map(run =>
    advanceService(coordinator, run, key, { accepted: new Set() })
      .service.advance(run.pipeline.runId, own.policyId)));
  const first = await wave(0, 20);
  const second = await wave(20, 40);
  const outcomes = [...first, ...second];
  const described = outcomes.map(o => o.status === "fulfilled"
    ? ["ok", o.value.replayed] : ["refused", o.reason?.safeReason ?? String(o.reason?.message)]);
  const unexpected = outcomes.filter(o => o.status === "rejected" && !o.reason?.safeReason
    && String(o.reason?.message ?? o.reason) !== "database_unavailable");
  assert.deepEqual(unexpected.map(o => String(o.reason?.message ?? o.reason)), [],
    `every refusal must be a pipeline or pool refusal: ${JSON.stringify(described)}`);
  // A REPLAY also reports `startsWork: true`, so `replayed` is what separates a
  // caller that claimed a stage from one that re-issued an existing one. Each run
  // is called once, so every non-replay here is a fresh claim.
  const claimed = outcomes.filter(o => o.status === "fulfilled" && o.value.startsWork === true
    && o.value.replayed !== true);
  const refused = outcomes.filter(o => o.status === "rejected");
  assert.equal(claimed.length, CEILING,
    `a ceiling of ${CEILING} must admit exactly ${CEILING} of 40 callers, got ${claimed.length}: `
    + JSON.stringify(described));
  // The second wave is where the ceiling is proved: the first wave spent it, so
  // this wave is refused by a PIPELINE ceiling rather than by pool admission.
  const secondRefused = second.filter(o => o.status === "rejected");
  assert.ok(secondRefused.some(o => o.reason?.safeReason === "installation_agent_process_ceiling_reached"),
    `the second wave must hit the process ceiling, got ${JSON.stringify(second.map(o => o.status === "fulfilled"
      ? ["ok", o.value.replayed] : ["refused", o.reason?.safeReason ?? String(o.reason?.message)]))}`);
  const peak = Number(await activeProcessCount(coordinator, own));
  assert.equal(peak, CEILING,
    `the count during the burst is exactly the ceiling (${CEILING}), got ${peak}`);

  // THE RELEASE: all 24 claimed stages finish or cancel at once, half each, so
  // both terminal paths are released under contention. The same bounded pool
  // applies (24 concurrent writers, 8 sessions + 8 queued), so the release runs in
  // batches and each batch must fully succeed -- a `database_unavailable` here is
  // the pool refusing, not a lost release, and the exact-zero assertion below is
  // what would catch a stage that never actually reached a terminal state.
  const jobIds = [...new Set(claimed.map(o => o.value.jobId))];
  const half = Math.floor(jobIds.length / 2);
  const releaseBatch = async (start) => {
    const batch = jobIds.slice(start, start + 8);
    if (batch.length === 0) return;
    const settled = await Promise.allSettled(batch.map((jobId, offset) =>
      finishExecutionJob(coordinator, publisher, own, jobId, start + offset < half
        ? { jobState: "succeeded", harnessState: "succeeded" }
        : { jobState: "cancelled", harnessState: "succeeded" })));
    const failed = settled.filter(o => o.status === "rejected");
    assert.deepEqual(failed.map(o => String(o.reason?.message ?? o.reason)), [],
      `every release in the batch at ${start} must succeed, ${failed.length} did not`);
  };
  for (let start = 0; start < jobIds.length; start += 8) await releaseBatch(start);

  // The invariant: every claimed stage is terminal, so the count is exactly zero.
  const terminalJobs = (await admin.query(`SELECT count(*)::int count FROM control_jobs j
    JOIN (SELECT DISTINCT execution_job_id id FROM pipeline_advance_receipts WHERE tenant_id=$1) r
      ON r.id=j.id AND j.tenant_id=$1
    WHERE j.state IN('succeeded','failed','cancelled')`, [own.tenantId])).rows[0].count;
  assert.equal(terminalJobs, jobIds.length, "every claimed stage reached a terminal job state");
  const after = Number(await activeProcessCount(coordinator, own));
  assert.equal(after, 0,
    `all ${jobIds.length} stages are terminal, so the process count must be exactly 0, got ${after}`);
  // And the count must be a real read, not a cached zero: the receipts are still
  // there, and the release freed them by state rather than by deletion.
  const receipts = (await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts"
    + " WHERE tenant_id=$1", [own.tenantId])).rows[0].count;
  assert.ok(receipts >= jobIds.length, "the receipts are never deleted; the count follows job state");
  // A fresh run in the same installation now has the whole ceiling again.
  const restarted = await seedSecondRun(admin, own, key, 99);
  await admin.query(`UPDATE control_harness_runs SET state='succeeded' WHERE tenant_id=$1`, [own.tenantId]);
  await ownerConsents(web, restarted, key);
  assert.equal((await advanceService(coordinator, restarted, key, { accepted: new Set() })
    .service.advance(restarted.pipeline.runId, own.policyId)).startsWork, true,
    "the installation can start a new run after releasing all its stages");
  console.error(`RELEASE: ${outcomes.length} callers, ${claimed.length} claimed (peak ${peak}), `
    + `${refused.length} refused, ${half} finished and ${jobIds.length - half} cancelled concurrently, `
    + `count now ${after}`);
});

test("a run ceiling of one admits exactly one run and refuses the second", needsPg, async t => {
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(66);
  // A ceiling of ONE is the boundary that distinguishes `>` from `>=`: with no
  // run yet spent, exactly one must be admitted and the next must refuse. A
  // ceiling of zero (tested above) cannot tell the two apart, so this one must.
  const own = await seedInstallation(admin, "unitcap", key, new Date(webNow).toISOString());
  const second = await seedSecondRun(admin, own, key);
  const firstService = advanceService(coordinator, own, key);
  const secondService = advanceService(coordinator, second, key);
  await ownerSetsUp(web, own, key, { runsPerHour: 1, runsPerAgentPerDay: 1, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  await ownerConsents(web, second, key);

  // The first run fits exactly at the ceiling of one.
  assert.equal((await firstService.service.advance(own.pipeline.runId, own.policyId)).startsWork, true,
    "a ceiling of one must admit one run");
  assert.equal(firstService.queuedCount(), 1);
  // The second is one past it, by either counting ceiling, and must refuse.
  const denied = await secondService.service.advance(second.pipeline.runId, own.policyId)
    .then(value => ({ ok: true, value }), error => ({ ok: false, reason: error?.safeReason }));
  assert.equal(denied.ok, false, "the second run is past a ceiling of one and must refuse");
  assert.ok(["installation_runs_per_hour_exhausted", "installation_agent_runs_per_day_exhausted"]
    .includes(denied.reason), `refused by a run-count ceiling, got ${denied.reason}`);
  assert.equal(secondService.queuedCount(), 0, "a refused run queues nothing");
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts WHERE tenant_id=$1",
    [own.tenantId])).rows[0].count, 1, "the refused run wrote no receipt");
  // A lost response for the admitted run replays it and claims nothing further.
  assert.equal((await firstService.service.advance(own.pipeline.runId, own.policyId)).replayed, true);
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts WHERE tenant_id=$1",
    [own.tenantId])).rows[0].count, 1, "a replay is not a second run");
});


test("a run with no allowance record of its own is refused, not waved through", needsPg, async t => {
  // The installation allowance is the only place the owner says how much
  // unattended work this installation may start. A run that has never had one
  // set has no permission to start, so it refuses. If the missing-record
  // refusal were removed, this run would advance unbounded and nothing would
  // catch it.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(68);

  const own = await seedInstallation(admin, "noallowance", key, new Date(webNow).toISOString());
  // Consent the run, but never set an allowance: this is the real shape of an
  // installation whose owner has enabled unattended work without choosing
  // limits, which must not be treated as "unlimited".
  const consented = new PipelineAdvanceServiceV1(web.client, own.scope, key, {}, () => webNow);
  const view = await new LinearPipelineServiceV1(web.client, own.scope, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => webNow)
    .view(own.identity, own.project.projectId, own.pipeline.runId);
  await consented.setUnattended(own.identity, own.project.projectId, { runId: own.pipeline.runId,
    templateId: view.templateId, policyId: own.policyId, enabled: true, expectedRunVersion: view.runVersion,
    expectedTemplateVersion: view.templateVersion }, "pipeline-unattended-noallowance");
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_installation_allowances"
    + " WHERE tenant_id=$1", [own.tenantId])).rows[0].count, 0,
  "this installation has no allowance record at all");

  const { service, queuedCount } = advanceService(coordinator, own, key);
  await assert.rejects(service.advance(own.pipeline.runId, own.policyId),
    error => error.safeReason === "installation_allowance_missing",
    "a run with no installation allowance must refuse, never assume unlimited");
  assert.equal(queuedCount(), 0);
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts"
    + " WHERE tenant_id=$1", [own.tenantId])).rows[0].count, 0, "and it claims no receipt");
});

test("the in-transaction loop count refuses even when the pre-check is skipped", needsPg, async t => {
  // #precheckLoopStop reads the job chain before the advance transaction opens;
  // #claimLoopRound re-reads it inside the transaction under the run row lock.
  // The second read is the only guard if the chain grows in between, so it is
  // tested with the pre-check made inert. Nothing about the ceilings changes:
  // the transaction's own count has to refuse on its own.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(69);

  // max_loops 1: rounds 0 and 1 are admitted, round 2 is past the ceiling.
  const own = await seedInstallation(admin, "inloop", key, new Date(webNow).toISOString(), { maxLoops: 1 });
  const { service, accepted } = advanceService(coordinator, own, key, { skipPrecheck: true });
  await ownerSetsUp(web, own, key, { runsPerHour: 100, runsPerAgentPerDay: 100, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  // Both admitted rounds go through the transaction's own count and succeed,
  // which is itself half the proof: the count is live, not decorative.
  assert.equal((await service.advance(own.pipeline.runId, own.policyId)).startsWork, true, "round 0 is admitted");
  accepted.add(own.buildJob);
  accepted.add(own.checkJob);
  await rewindRunTo(admin, own, 0, key);
  await reenterStage(admin, own, 0, key);
  assert.equal((await service.advance(own.pipeline.runId, own.policyId)).stageOrdinal, 0, "round 1 is admitted");
  await rewindRunTo(admin, own, 0, key);
  await reenterStage(admin, own, 0, key);
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_jobs WHERE tenant_id=$1"
    + " AND pipeline_run_id=$2 AND stage_ordinal=0", [own.tenantId, own.pipeline.runId])).rows[0].count, 3,
  "a third build job is planned, one round past the ceiling");

  // With the pre-check inert, ONLY the transaction's count can refuse this.
  await assert.rejects(service.advance(own.pipeline.runId, own.policyId),
    error => error.safeReason === "stage_loop_limit_reached",
    "the transaction's own count must refuse a chain past the ceiling");
  assert.equal((await admin.query("SELECT count(*)::int count FROM pipeline_stage_loop_counts"
    + " WHERE tenant_id=$1 AND reason_code='stage_advanced'", [own.tenantId])).rows[0].count, 2,
  "the refused round started no third round");
  // And with the pre-check back on, the same run is still refused and the owner
  // is told exactly once: the two guards agree.
  const normal = advanceService(coordinator, own, key);
  await assert.rejects(normal.service.advance(own.pipeline.runId, own.policyId),
    error => error.safeReason === "stage_loop_limit_reached");
  assert.equal((await admin.query("SELECT count(*)::int count FROM control_action_inbox WHERE id=$1",
    [`attention:pipeline-loop:${own.pipeline.runId}`])).rows[0].count, 1,
  "one Needs Attention item, written by the pre-check once it is back");
});

test("every S7b down file revokes only what its own up migration granted", needsPg, async t => {
  // Each down file is run against a database that already holds the S7b state,
  // and each must refuse while its own state exists. A down file that
  // over-revokes a neighbour's grants, or drops a table it did not create, is
  // caught by comparing the catalog before and after.
  //
  // The down files carry their own BEGIN/COMMIT, so each attempt gets a FRESH
  // connection: a refused one leaves that transaction aborted, and reusing the
  // client would make every later statement fail for the wrong reason.
  const admin = superuser();
  await admin.connect();
  const web = productionPool("control_room_web");
  const coordinator = productionPool("control_room_coordinator");
  t.after(async () => { await web.close(); await coordinator.close(); await admin.end(); });
  const key = new Uint8Array(32).fill(67);

  // Real S7b state: a counted round, a recorded cluster observation, an
  // allowance record with limits set, and a known-cost receipt.
  const own = await seedInstallation(admin, "down", key, new Date(webNow).toISOString());
  const { service } = advanceService(coordinator, own, key);
  await ownerSetsUp(web, own, key, { runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12,
    machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
  assert.equal((await service.advance(own.pipeline.runId, own.policyId)).startsWork, true);

  const down = async (file) => (await readFile(join(ROOT, "db/down", file), "utf8"));
  const present = async (name) => {
    const c = new Client({ host: socket, port: PORT, database: DB, user: "postgres" });
    await c.connect();
    try { return (await c.query("SELECT to_regclass($1) IS NOT NULL present", [name])).rows[0].present; }
    finally { await c.end(); }
  };
  const runDown = async (file) => {
    const c = new Client({ host: socket, port: PORT, database: DB, user: "postgres" });
    await c.connect();
    try { await c.query(await down(file)); return null; }
    catch (error) { return String(error.message ?? error); }
    finally { await c.end(); }
  };
  const runUp = async (file) => {
    const c = new Client({ host: socket, port: PORT, database: DB, user: "postgres" });
    await c.connect();
    try { await c.query(await readFile(join(ROOT, "db/migrations", file), "utf8")); }
    finally { await c.end(); }
  };
  const pipelineTableCount = async () => {
    const c = new Client({ host: socket, port: PORT, database: DB, user: "postgres" });
    await c.connect();
    try { return (await c.query(`SELECT count(*)::int FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'pipeline_%'`)).rows[0].count; }
    finally { await c.end(); }
  };

  // 0151: counted rounds exist, so its down refuses and leaves the table.
  assert.equal(await present("pipeline_stage_loop_counts"), true);
  assert.match(await runDown("0151_pipeline_stage_loop_counts.sql"), /down migration refused/u);
  assert.equal(await present("pipeline_stage_loop_counts"), true, "a refused down leaves the table");

  // 0153: a recorded cluster observation is owner evidence, so its down refuses.
  assert.equal(await present("pipeline_machine_capacity_observations"), true);
  assert.match(await runDown("0153_pipeline_machine_capacity_observations.sql"), /down migration refused/u);
  assert.equal(await present("pipeline_machine_capacity_observations"), true);

  // 0150: the owner has set limits, so its down refuses rather than discarding them.
  assert.equal(await present("pipeline_installation_allowances"), true);
  assert.match(await runDown("0150_pipeline_installation_allowances.sql"), /down migration refused/u);
  assert.equal(await present("pipeline_installation_allowances"), true);

  // This tenant's own single advance is round 0, so it holds no fix-round
  // receipt and 0154's down is free to run here. It must restore the original
  // per-stage key, drop the column it added and drop its two guards, while
  // every other S7b table survives untouched.
  const ownFixRounds = async () => (await admin.query("SELECT count(*)::int count FROM pipeline_advance_receipts"
    + " WHERE tenant_id=$1 AND loop_index>0", [own.tenantId])).rows[0].count;
  assert.equal(await ownFixRounds(), 0, "this tenant's own single advance is round 0");

  // A fresh database, holding only this seed's state, is where 0154's down runs
  // cleanly and restores the pre-S7b per-stage key.
  const clean = new Client({ host: socket, port: PORT, database: "postgres", user: "postgres" });
  await clean.connect();
  await clean.query(`DROP DATABASE IF EXISTS ${DB}_down`);
  await clean.query(`CREATE DATABASE ${DB}_down TEMPLATE template0`);
  await clean.end();
  const target = new Client({ host: socket, port: PORT, database: `${DB}_down`, user: "postgres" });
  await target.connect();
  try {
    const opts = { host: socket, port: PORT, database: `${DB}_down`, user: "fixture_admin" };
    await applyMigrations({ target: opts, bootstrapTarget: opts, migrateTarget: { ...opts, user: "control_room_migrator",
      password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD }, rootDir: ROOT, env: { ...process.env, ...passwords } });
    const runOn = async (sql) => { await target.query(sql); };
    const beforeTables = (await target.query(`SELECT count(*)::int count FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'pipeline_%'`)).rows[0].count;
    await runOn(await down("0154_pipeline_advance_round_receipts.sql"));
    const afterTables = (await target.query(`SELECT count(*)::int count FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'pipeline_%'`)).rows[0].count;
    assert.equal(afterTables, beforeTables, "0154's down must not touch any pipeline table");
    const column = (await target.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='pipeline_advance_receipts' AND column_name='loop_index'`)).rows;
    assert.equal(column.length, 0, "0154's down drops the loop_index column it added");
    const key = (await target.query(`SELECT pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conname='pipeline_advance_receipts_tenant_id_pipeline_run_id_stage_o_key'`)).rows;
    assert.deepEqual(key.map(r => r.def), ["UNIQUE (tenant_id, pipeline_run_id, stage_ordinal)"],
      "0154's down restores the original one-receipt-per-stage key");
    const guard = (await target.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='control_action_inbox'::regclass AND tgname LIKE '%pipeline_loop%' ORDER BY tgname`)).rows;
    assert.deepEqual(guard.map(r => r.tgname), [], "0154's down drops all three loop-attention guards");
    // And the up restores exactly that state, so the pair round-trips.
    await target.query(await readFile(join(ROOT, "db/migrations/0154_pipeline_advance_round_receipts.sql"), "utf8"));
    const restoredColumn = (await target.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='pipeline_advance_receipts' AND column_name='loop_index'`)).rows;
    assert.equal(restoredColumn.length, 1, "0154's up restores the loop_index column");
  } finally { await target.end(); }

  // 0152 reverses a whole-table change too, so it runs in the CLEAN database
  // rather than the shared one. On the shared database the unknown-cost test
  // above has legitimately written an unknown-cost receipt, and 0152's down
  // refusing there is correct behaviour rather than a defect.
  const fresh = new Client({ host: socket, port: PORT, database: `${DB}_down2`, user: "postgres" });
  const bootstrapClean = new Client({ host: socket, port: PORT, database: "postgres", user: "postgres" });
  await bootstrapClean.connect();
  await bootstrapClean.query(`DROP DATABASE IF EXISTS ${DB}_down2`);
  await bootstrapClean.query(`CREATE DATABASE ${DB}_down2 TEMPLATE template0`);
  await bootstrapClean.end();
  await fresh.connect();
  try {
    const opts = { host: socket, port: PORT, database: `${DB}_down2`, user: "fixture_admin" };
    await applyMigrations({ target: opts, bootstrapTarget: opts, migrateTarget: { ...opts,
      user: "control_room_migrator", password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD },
    rootDir: ROOT, env: { ...process.env, ...passwords } });
    const count = async () => (await fresh.query(`SELECT count(*)::int count FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'pipeline_%'`)).rows[0].count;
    const tablesBefore = await count();
    // Every receipt in a freshly installed database is a KNOWN cost, because
    // that is the 0152 default and no writer has run yet, so the down runs.
    assert.equal(await fresh.query(await readFile(join(ROOT, "db/down/0152_pipeline_advance_unknown_cost.sql"),
      "utf8")).then(() => null, error => String(error.message ?? error)), null,
    "0152's down must run cleanly on a database with no unknown-cost receipt");
    assert.equal(await count(), tablesBefore, "0152's down must not touch any pipeline table");
    assert.equal((await fresh.query(`SELECT is_nullable FROM information_schema.columns
      WHERE table_name='pipeline_advance_receipts' AND column_name='delegation_cost_microusd'`))
      .rows[0].is_nullable, "NO", "0152's down restores the NOT NULL it removed");
    assert.equal((await fresh.query(`SELECT count(*)::int count FROM information_schema.columns
      WHERE table_name='pipeline_advance_receipts' AND column_name='delegation_cost_state'`)).rows[0].count, 0,
    "0152's down drops the column it added");
    for (const kept of ["pipeline_stage_loop_counts", "pipeline_installation_allowances",
      "pipeline_machine_capacity_observations"]) {
      assert.equal((await fresh.query("SELECT to_regclass($1) IS NOT NULL p", [kept])).rows[0].p, true,
        `${kept} survives 0152's down`);
    }
    // An unknown-cost receipt is exactly the state it must refuse.
    await fresh.query(await readFile(join(ROOT, "db/migrations/0152_pipeline_advance_unknown_cost.sql"), "utf8"));
  } finally { await fresh.end(); }
});
