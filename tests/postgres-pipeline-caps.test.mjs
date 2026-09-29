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
const PORT = Number(process.env.S7B_PG_PORT ?? 58700);
const exec = promisify(execFile);
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (set PG_BIN)" };
const passwords = { CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24), CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24) };
// The Mac-local installer's exact login set. The provisioner refuses any other
// set, so this file provisions precisely what a real Mac-local installation has.
const LOGINS = ["control_room_web", "control_room_coordinator", "control_room_results", "control_room_publisher",
  "control_room_agent_reviewer_login", "control_room_queue_worker"];
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
 * real row on the real login. */
async function seedInstallation(client, suffix, key, at, { maxLoops = 1, maxTotalLoops = 6 } = {}) {
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
  // The real planner's output: one execution plan per stage, whose job is the
  // stage's own job. The production read authority joins on exactly these rows,
  // so without them every stage is honestly uncertain.
  for (const job of [buildJob, checkJob, signoffJob]) {
    await client.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
      VALUES($1,$2,$3,$3,'{}'::jsonb,$4)`, [tenantId, project.projectId, job, `hmac-sha256:${"9".repeat(64)}`]);
  }
  const identityDigest = sha256Digest(identityId);
  await client.query(`INSERT INTO control_project_coordinator_heads(tenant_id,project_id,state,coordinator_identity_id,
    coordinator_actor_type,assigned_by_owner_identity_id,version,assigned_at,updated_at,payload)
    VALUES($1,$2,'active',$3,'human',$3,1,$4,$4,'{}')`, [tenantId, project.projectId, identityId, at]);
  await client.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,
    risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,
    created_at,updated_at) VALUES($1,$2,$3,$4,1,'active',1,$5,$4,$5,'["tasks.assign"]',
    $6,'low','none',100,1000000,32,$7,$8,'{}',$7,$7)`, [tenantId, `policy:caps-${suffix}`, project.projectId, identityId,
    sha256Digest("policy"), JSON.stringify([`node:build:${suffix}`, `node:check:${suffix}`, `node:validate:${suffix}`]),
    new Date(webNow - 1000).toISOString(), new Date(webNow + 600_000).toISOString()]);
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
  evidenceDigest: sha256Digest("cost") } } = {}) {
  // The attempt for a job is read from the REAL row the planner wrote, never from
  // a map frozen at seed time: a fix round mints a new attempt for the same
  // stage, and the receipt's foreign key must resolve to the row that exists.
  let queued = 0;
  const supporting = new ProductionPipelineAdvanceAuthorityV1(own.scope, { assertCurrent: () => true },
    { acceptedResultProof: async (_tx, value) => accepted.has(value.sourceJobId) ? { executionJobId: value.sourceJobId } : null,
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
  const service = new PipelineAdvanceServiceV1(coordinator.client, own.scope, key,
    { unattendedEnabled: () => true, capability }, () => webNow);
  return { service, accepted, queuedCount: () => queued };
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
 * ceilings. */
async function seedSecondRun(client, own, key) {
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
    { templateId: saved.templateId, title: "Second capped run" }, `caps-second-${own.tenantId}-pipeline-0001`);
  const attemptIds = new Map();
  for (const [index, job] of pipeline.jobIds.entries()) {
    await client.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
      VALUES($1,$2,$3,$3,'{}'::jsonb,$4)`, [own.tenantId, own.project.projectId, job, `hmac-sha256:${"9".repeat(64)}`]);
    const tag = sha256Digest(job).slice(7, 15);
    // The node already exists from the first run's seed, so it is reused rather
    // than inserted again; the attempt is this run's own.
    const nodeId = atStage(index).node_id, workerId = atStage(index).worker_id;
    const attemptId = `attempt:second:${tag}`;
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
    [[0, 1, 2]], "the counted round is the stage's, and the run total is the run's own job chain");
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
  assert.deepEqual((await counted(0)).map(row => [Number(row.loop_index), Number(row.run_total_loops)]), [[0, 2], [1, 3]],
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
    Number(row.run_total_loops), row.reason_code]), [[1, 1, 2, "stage_loop_limit_reached"]],
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
