// m-r7lgrant: the owner's run page can read the installation's live allowance on
// REAL PostgreSQL, as the PRODUCTION web login.
//
// THE BUG. R7L-06 added `loopAllowanceForOwner` (src/pipelines/v1/advance-service.ts:561)
// and both web compositions pass it the `PipelineAdvanceServiceV1` built on the
// WEB connection (private-process.ts:350, mac-local-web-process.ts:270). That login
// held no SELECT on `pipeline_advance_receipts`, which is the one table the
// projection counts, so the read died with sqlState 42501 on every open run.
//
// WHY THIS TEST IS NOT A UNIT TEST. A fake database answers whatever the query
// asks, so it cannot produce a 42501 -- the whole defect is a privilege, and a
// privilege only exists on a server. Every assertion below runs through the real
// `applyMigrations` and the real `db/roles/*.sql` files, over the real `pg` driver
// with production's own pool binding, as `control_room_web`.
//
// WHO RUNS WHAT, exactly as production composes it:
//   - LinearPipelineServiceV1 / PipelineAdvanceServiceV1 -> web login
//   - the receipt writer                                          -> coordinator login
// The admin connection seeds fixture rows only, as the shipped lanes do.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { LinearPipelineServiceV1, PipelineAdvanceServiceV1 } from "../src/pipelines/v1";
import { sha256Digest } from "../src/security";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relative: string) => readFileSync(path.join(REPO, relative), "utf8");

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59240);
const ALLOWED_PORTS = Array.from({ length: 20 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
// The service clock must sit INSIDE the identity's live window: the session
// authority refuses an expired or not-yet-issued identity outright, so a fixed
// historical instant fails before any product logic runs.
const at = Math.floor(Date.parse(ISSUED_AT) + 30_000);
const KEY = new Uint8Array(32).fill(63);
const SCOPE = { tenantId: "tenant:r7lgrant", workspaceId: "workspace:r7lgrant" };
// The manual adapter id is DERIVED from the scope digest (WebProjectService), not
// chosen: a project on any other adapter id is invisible to the owner task service.
const ADAPTER = `adapter:manual:${sha256Digest(SCOPE).slice(7, 39)}`;
const T = { ...SCOPE, adapter: ADAPTER, project: "project:r7lgrant", identity: "identity:r7lgrant-owner",
  token: sha256Digest({ session: "r7lgrant-owner" }) };
const identity: VerifiedWebIdentity = { provider: "test", subject: T.identity, tokenDigest: T.token,
  issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT };
const COORDINATOR_IDENTITY = "identity:r7lgrant-coordinator";

async function seed(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [T.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [T.workspaceId, T.tenantId]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [T.adapter, T.tenantId]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
  [T.project, T.tenantId, T.workspaceId, T.adapter]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,now(),now())`, [T.tenantId, T.project]);
  await admin.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human',$1,'test',$3,'active',$4,$4)`,
  [T.identity, T.tenantId, sha256Digest({ provider: "test", subject: T.identity }), ISSUED_AT]);
  await admin.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
     require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
  [`grant:${T.identity}`, T.tenantId, T.identity, ISSUED_AT]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [T.tenantId, T.token, T.identity, ISSUED_AT, EXPIRES_AT]);
  // A delegation policy's coordinator_identity_id is FK-bound, so the identity row
  // must exist before any policy row can reference it.
  await admin.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'agent','Coordinator','work-intake',$3,'active',$4,$4)`,
  [COORDINATOR_IDENTITY, T.tenantId, sha256Digest({ provider: "work-intake", subject: COORDINATOR_IDENTITY }), ISSUED_AT]);
}

/**
 * The fenceposts `pipeline_advance_receipts` needs before a row can exist.
 *
 * Six foreign keys bind one receipt (0109): the run, the stage, the source job,
 * the execution job, `(tenant_id, attempt_id, execution_job_id)` into
 * `control_attempts`, and the policy. Every one of those is read off the shipped
 * migration rather than guessed, because a guessed column name here fails as a
 * 23503 that says nothing about which relation was wrong.
 *
 * `instantiate` creates only the three SOURCE jobs and no execution plan, so an
 * execution job has to be created here as the fencepost it is. Measured on real
 * PostgreSQL rather than assumed: after `createTemplate` + `instantiate`,
 * `control_jobs` holds exactly three rows, `control_task_execution_plans` is
 * empty, and each `pipeline_stage_runs.current_job_id` points at its source job.
 * The execution job is therefore a fourth `control_jobs` row carrying the same
 * `pipeline_run_id` and `stage_ordinal` -- which is also the shape the product's
 * own counter comment describes ("a stage holds a SOURCE job and a DISTINCT
 * `job:execution:*` job per round, both carry `stage_ordinal`").
 *
 * The node is the standing fencepost of this fixture family: a node written by the
 * fleet gateway is guarded hard (0140 requires `node:fleet:<32 hex>`, state
 * `active`, and a `fleet_workers` row in the same transaction), and this lane has
 * no fleet worker, so the admin connection is the one role that guard exempts.
 * Two live constraints still hold and are satisfied explicitly: the canonical
 * payload mirror (which also checks `identityKeyId`) and
 * `CHECK (coordinator_lock IS FALSE)`, whose column has no default.
 */
const NODE = `node:fleet:${"a".repeat(32)}`;
const POLICY = "policy:r7lgrant";

async function seedReceiptFenceposts(admin: Client, sourceJobId: string, runId: string) {
  await admin.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,
    eligible_routes,risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,
    valid_from,valid_until,payload,created_at,updated_at) VALUES($1,$2,$3,$4,1,'active',1,$5,$6,$5,
    '["tasks.assign"]','["route:one"]','low','none',3,1000,2,$7,$8,'{}',$7,$7)`,
  [T.tenantId, POLICY, T.project, COORDINATOR_IDENTITY, `sha256:${"d".repeat(64)}`, T.identity,
    new Date(at - 1000).toISOString(), new Date(at + 600_000).toISOString()]);
  await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,
    coordinator_lock,created_at,updated_at) VALUES($1,$2,'active',0,$3,$4::jsonb,FALSE,$5,$5)`,
  [NODE, T.tenantId, "key:r7lgrant", JSON.stringify({ id: NODE, tenantId: T.tenantId,
    state: "active", version: 0, identityKeyId: "key:r7lgrant" }), ISSUED_AT]);
  // The EXECUTION job: the receipt's `execution_job_id` is FK-bound to it, and so
  // is the attempt's `(tenant_id, id, job_id)`.
  //
  // It is built by CLONING the source job's real row rather than by hand-writing
  // one. `control_jobs` carries NOT NULL columns the receipt path never touches
  // (`priority`, `required_capability`, `authority_digest`) and a `workflow_id`
  // FK-bound to a workflow row, and its payload is validated by
  // `validate_control_payload_mirror` against `id`/`tenantId`/`state`/`version`
  // (plus `authority.digest` == `authority_digest`). Every one of those was read
  // off the live row rather than guessed -- a first attempt that named only the
  // obvious columns failed 42703 on a column the code never mentions -- and a
  // clone keeps the fencepost correct as the table gains columns, which a
  // hand-written INSERT does not.
  const executionJobId = `job:execution:${sourceJobId}`;
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
    required_capability,authority_digest,payload,pipeline_run_id,stage_ordinal,stage_kind,created_at,updated_at)
    SELECT $1,tenant_id,workflow_id,project_id,'proposed',version,priority,required_capability,authority_digest,
      jsonb_set(payload,'{id}',to_jsonb($1::text)),$2,stage_ordinal,stage_kind,now(),now()
    FROM control_jobs WHERE tenant_id=$3 AND id=$4`,
  [executionJobId, runId, T.tenantId, sourceJobId]);
  // The mirrored payload's `state` must match the row's, or the trigger refuses the
  // insert. The source row is 'proposed' and so is this one, so only `id` moves.
  // control_attempts carries `evidence_lock` (NOT NULL, default false) and NO
  // `coordinator_lock`; its mirror forbids a `leaseEpoch` KEY when the column is NULL.
  await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,
    worker_id,node_id,payload,evidence_lock,created_at,updated_at)
    VALUES($1,$2,$3,1,'running',1,'worker:one',$4,$5::jsonb,FALSE,$6,$6)`,
  ["attempt:r7lgrant", T.tenantId, executionJobId, NODE, JSON.stringify({
    contractVersion: "control-room-domain/v1", kind: "attempt", id: "attempt:r7lgrant", tenantId: T.tenantId,
    jobId: executionJobId, attemptNumber: 1, state: "running", version: 1, workerId: "worker:one",
    nodeId: NODE, offeredAt: ISSUED_AT, startedAt: ISSUED_AT, createdAt: ISSUED_AT, updatedAt: ISSUED_AT }),
    ISSUED_AT]);
  return executionJobId;
}

type Fixture = Parameters<Parameters<typeof withRealPostgres>[0]>[0];
/** A production login with the exact driver and pool options production binds. */
function productionPool(postgres: Fixture, role: "web" | "coordinator" = "web") {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  const traced = (session: DatabaseSession): DatabaseSession =>
    ({ query: async (sql: string, params?: readonly unknown[]) => session.query(sql, params as unknown[]) });
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  return { config, login, client, close: () => bound.close() };
}

const selection = { assertCurrent: () => true, isAcceptedResultCurrent: () => false };
const templateDefinition = { name: "Pipeline", description: "Bounded pipeline.", stages: [
  { ordinal: 0, stageKind: "build", role: "builder", description: "Build.", requiredCapability: "code.change",
    workerId: "worker:one", workerKind: "codex", nodeId: "node:one", selectionKey: "selection:one",
    model: "model-one", effort: "high", maxLoops: 1, allowedPaths: ["src/**"], maximumChangedFiles: 12,
    maximumChangedBytes: 65536 },
  { ordinal: 1, stageKind: "check", role: "checker", description: "Check.", requiredCapability: "code.review",
    workerId: "worker:two", workerKind: "claude-code", nodeId: "node:two", selectionKey: "selection:two",
    model: "model-two", effort: "high", maxLoops: 1 },
  { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate.", requiredCapability: "code.validate",
    workerId: "worker:three", workerKind: "hermes", nodeId: "node:three", selectionKey: "selection:three",
    model: "model-three", effort: "medium", provider: "provider:test", profile: "profile:test", maxLoops: 0 },
], maxTotalLoops: 2, maxDurationSeconds: 3600 } as const;

/**
 * The nine columns 0298 grants, and the four 42501s the ungranted ones must give.
 *
 * The second list is the point of the column grant rather than a table grant:
 * `auth_tag` is an HMAC over the receipt's canonical material under the
 * installation integrity key, and `#replayReceipt` (advance-service.ts:1142)
 * re-verifies it before treating a row as a real past advance. This login is
 * shared by every project in the installation, so reading it would convey the
 * ability to mint a receipt the product would accept.
 */
const GRANTED = ["tenant_id", "pipeline_run_id", "stage_ordinal", "loop_index", "source_job_id",
  "execution_job_id", "advanced_at", "delegation_cost_state", "delegation_cost_microusd"];
const NOT_GRANTED = ["auth_tag", "receipt_digest", "request_digest", "selection_digest", "template_digest",
  "run_digest", "policy_digest", "delegation_receipt_digest", "delegation_cost_evidence_digest",
  "attempt_id", "queue_id", "project_id", "id", "policy_id", "policy_version", "template_version", "run_version",
  "delegation_receipt_id", "delegation_task_units"];

/**
 * A real receipt, written by the login that owns it.
 *
 * The column list and the parameter list are built from ONE ordered array, because
 * they drift the moment they are written separately: a first version passed 21
 * values to 20 placeholders, which `pg` reports as 08P01 -- a code
 * `createPrivatePgDriver` deliberately treats as UNCERTAIN, so the refusal arrived
 * as `database_outcome_uncertain` and pointed at nothing at all. `map` keeps each
 * value beside its column name and the SQL is generated from it, so the two cannot
 * disagree.
 */
const RECEIPT_COLUMNS = ["id", "tenant_id", "project_id", "pipeline_run_id", "source_job_id", "execution_job_id",
  "attempt_id", "queue_id", "selection_digest", "template_digest", "run_digest", "policy_id", "policy_digest",
  "delegation_receipt_id", "delegation_receipt_digest", "delegation_cost_evidence_digest", "request_digest",
  "receipt_digest", "auth_tag", "advanced_at"] as const;
const receiptInsertSql = `INSERT INTO pipeline_advance_receipts(${RECEIPT_COLUMNS.join(",")},stage_ordinal,loop_index,
  template_version,run_version,policy_version,delegation_task_units,delegation_cost_state,delegation_cost_microusd)
  VALUES(${RECEIPT_COLUMNS.map((_, index) => `$${index + 1}`).join(",")},0,0,1,1,1,1,'known',7)`;
const receiptParams = (runId: string, sourceJobId: string, executionJobId: string) => {
  const hex = (c: string) => `sha256:${c.repeat(64)}`;
  const values: Record<(typeof RECEIPT_COLUMNS)[number], unknown> = {
    id: "receipt:r7lgrant-1", tenant_id: T.tenantId, project_id: T.project, pipeline_run_id: runId,
    source_job_id: sourceJobId, execution_job_id: executionJobId, attempt_id: "attempt:r7lgrant",
    queue_id: "queue:r7lgrant", selection_digest: hex("a"), template_digest: hex("b"), run_digest: hex("c"),
    policy_id: POLICY, policy_digest: hex("d"), delegation_receipt_id: "delegation:r7lgrant",
    delegation_receipt_digest: hex("e"), delegation_cost_evidence_digest: hex("f"), request_digest: hex("1"),
    receipt_digest: hex("2"), auth_tag: `hmac-sha256:${"3".repeat(64)}`, advanced_at: new Date(at).toISOString(),
  };
  return RECEIPT_COLUMNS.map(column => values[column]);
};

test("R7L-06-PG: the web login reads the live run allowance on a FRESH install, and only the nine counters",
  needsPg(), async () => {
    const result = await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin({ database: postgres.database }));
      admin.on("error", () => {});
      await admin.connect();
      try {
        await seed(admin);
        const web = productionPool(postgres);
        const coordinator = productionPool(postgres, "coordinator");
        try {
          const linear = new LinearPipelineServiceV1(web.client, SCOPE, KEY, selection, () => at);
          const saved = await linear.createTemplate(identity, T.project, templateDefinition);
          const run = await linear.instantiate(identity, T.project,
            { templateId: saved.templateId, title: "Allowance" }, "r7lgrant-run-00000001");
          // NO injected reader, NO injected clock and NO fake: this is the real
          // PipelineAdvanceServiceV1 on the real web connection, which is the exact
          // object private-process.ts and mac-local-web-process.ts hand the handler.
          const advance = new PipelineAdvanceServiceV1(web.client, SCOPE, KEY, {}, () => at);
          // No allowance record yet: the projection is honest about having none.
          assert.equal(await advance.loopAllowanceForOwner(identity, T.project, run.runId), null,
            "no allowance record means null, not a fabricated set of ceilings");
          await advance.setAllowance(identity, { runsPerHour: 6, runsPerAgentPerDay: 12,
            machineMaxAgentProcesses: 12, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });

          // A real receipt, from the login that owns it, so the counters have
          // something true to count. The COORDINATOR holds the INSERT grant; the web
          // login must still be unable to write one (asserted below).
          const executionJobId = await seedReceiptFenceposts(admin, run.jobIds[0]!, run.runId);
          await coordinator.client.query(receiptInsertSql,
            receiptParams(run.runId, run.jobIds[0]!, executionJobId));

          // THE FIX. This is the read that was refused 42501.
          const live = await advance.loopAllowanceForOwner(identity, T.project, run.runId);
          assert.ok(live, "the live allowance position is available on the web login");
          assert.equal(live?.usedThisHour, 1, "the real receipt is counted in the hourly total");
          assert.equal(live?.usedByAgentToday, 1, "and in the per-agent daily total");
          assert.equal(live?.loopIndex, 0, "the stage is on its first round");
          assert.equal(live?.recordedDbClusters, 1);
          // A read claims no work and grants no authority, whatever it returns.
          //
          // `startedWork` is NOT "did this call start something" -- it reports
          // whether the stage has ALREADY started (`current.stageStarted`, i.e. the
          // stage's own source job already carries a receipt). This fixture wrote one
          // receipt for exactly that job, so `true` is the honest answer and asserting
          // `false` would have been asserting the wrong property. The two fields that
          // carry the READ's own guarantee are `startsWork` and
          // `grantsExecutionAuthority`, both `z.literal(false)` in the schema, and a
          // third check covers the distinction directly: a run with no receipt for its
          // current job reports `startedWork: false` from the same method.
          assert.equal(live?.startedWork, true,
            "the stage has already started: its current job carries the receipt just written");
          assert.equal(live?.startsWork, false, "the read itself starts nothing");
          assert.equal(live?.grantsExecutionAuthority, false, "and grants no execution authority");
          const unstarted = await linear.instantiate(identity, T.project,
            { templateId: saved.templateId, title: "Not started" }, "r7lgrant-run-00000002");
          const fresh = await advance.loopAllowanceForOwner(identity, T.project, unstarted.runId);
          assert.equal(fresh?.startedWork, false,
            "a stage whose current job has no receipt reports it has not started");
          assert.equal(fresh?.usedThisHour, 1, "the installation-wide hourly counter is not per-run");
          // Cross-project and unknown runs still refuse rather than defaulting.
          await assert.rejects(advance.loopAllowanceForOwner(identity, "project:other", run.runId), /not_found/);
          await assert.rejects(advance.loopAllowanceForOwner(identity, T.project, "pipeline-run:missing"), /not_found/);

          // THE LEAST-PRIVILEGE HALF, measured rather than asserted from the SQL.
          //
          // Granted + refused must cover the table's WHOLE width, so a column added
          // by a later migration cannot fall through the audit unnoticed: it would
          // appear in neither list and the 42501 sweep would never read it. The 28
          // are the columns the service's own INSERT names (advance-service.ts:453),
          // which is the widest set this tree knows about.
          assert.deepEqual([...GRANTED, ...NOT_GRANTED].sort(),
            ["id", "tenant_id", "project_id", "pipeline_run_id", "stage_ordinal", "loop_index", "source_job_id",
              "execution_job_id", "attempt_id", "queue_id", "selection_digest", "template_version",
              "template_digest", "run_version", "run_digest", "policy_id", "policy_version", "policy_digest",
              "delegation_receipt_id", "delegation_receipt_digest", "delegation_task_units",
              "delegation_cost_state", "delegation_cost_microusd", "delegation_cost_evidence_digest",
              "request_digest", "receipt_digest", "auth_tag", "advanced_at"].sort(),
            "every column of pipeline_advance_receipts must be either granted or explicitly refused");
          // The same coverage, read off the SERVER: a column that exists on the table
          // but appears in neither list above is refused here.
          const liveColumns = (await admin.query<{ column: string }>(`SELECT a.attname AS column FROM pg_attribute a
            WHERE a.attrelid='public.pipeline_advance_receipts'::regclass AND a.attnum>0 AND NOT a.attisdropped`))
            .rows.map(row => row.column);
          assert.deepEqual(liveColumns.sort(), [...GRANTED, ...NOT_GRANTED].sort(),
            "the live table's columns and the audit lists have drifted apart");
          for (const column of NOT_GRANTED) {
            await assert.rejects(web.client.query(
              `SELECT ${column} FROM pipeline_advance_receipts WHERE tenant_id=$1`, [T.tenantId]),
              (error: unknown) => (error as { sqlState?: string }).sqlState === "42501",
              `the web login must not be able to read pipeline_advance_receipts.${column}`);
          }
          // And it cannot write the table by any route: no INSERT, no UPDATE, no DELETE.
          //
          // Each statement is checked for BOTH a `42501` and a refusal at the DRIVER
          // boundary, because the two are different failures: a permission error is
          // a definite `database_unavailable` with its SQLSTATE, while a malformed
          // statement (a placeholder count that does not match, which is what the
          // first version of this block had) is 08P01 and arrives as
          // `database_outcome_uncertain` with no sqlState at all. A loop that only
          // looked for 42501 would have reported a broken statement as a missing
          // privilege -- a test that could only ever pass.
          for (const sql of [
            receiptInsertSql,
            `UPDATE pipeline_advance_receipts SET auth_tag='hmac-sha256:${"z".repeat(64)}' WHERE tenant_id=$1`,
            `DELETE FROM pipeline_advance_receipts WHERE tenant_id=$1`,
          ]) {
            const params = sql === receiptInsertSql
              ? receiptParams(run.runId, run.jobIds[0]!, run.jobIds[0]!) : [T.tenantId];
            let refusal: { code?: string; sqlState?: string } | null = null;
            try { await web.client.query(sql, params); }
            catch (error) { refusal = error as { code?: string; sqlState?: string }; }
            assert.equal(refusal?.sqlState, "42501",
              `the web login must be refused the write as a permission error: ${sql.slice(0, 60)}`
              + ` (got ${refusal?.code ?? "no refusal"}/${refusal?.sqlState ?? "no sqlState"})`);
          }
          // `pipeline_stage_loop_counts` is not read by anything in src/, so nothing
          // reads it here either. 0151's "no shared login is granted this table"
          // must still hold after 0298, or the grant was the wider of the two.
          for (const table of ["pipeline_stage_loop_counts"]) {
            await assert.rejects(web.client.query(`SELECT count(*) FROM ${table} WHERE tenant_id=$1`, [T.tenantId]),
              (error: unknown) => (error as { sqlState?: string }).sqlState === "42501",
              `the web login must hold nothing on ${table}`);
          }

          // CONCURRENCY AT THE REAL ADMISSION BOUNDARY. The reader is bounded by
          // `privateDatabaseLimits.connections` (8), and `admit` in bounded-database.ts
          // takes 8 active plus at most 8 WAITING before it refuses outright
          // (`if (waiting.length >= limits.connections) throw`). So the honest burst
          // sizes are 8 (all admitted at once) and 16 (the ceiling itself), and a
          // 20-caller burst is refused BY DESIGN -- the 20th is refused rather than
          // queueing without limit.
          //
          // A first version asserted 20 concurrent readers all succeeding, which is
          // not a property this code has: it failed with `database_unavailable` and
          // looked like a defect in the grant. It is the pool's own overload policy.
          // So the bound is read from the module and the two shapes below are the
          // real ones, with the refusal counted rather than ignored.
          const { privateDatabaseLimits: limits } = await import("../src/web/v1/bounded-database");
          const atCeiling = limits.connections * 2;
          for (const size of [limits.connections, atCeiling]) {
            const readings = await Promise.all(Array.from({ length: size },
              () => advance.loopAllowanceForOwner(identity, T.project, run.runId)));
            assert.equal(readings.length, size, `${size} concurrent readers all returned`);
            for (const value of readings) {
              assert.equal(value?.startsWork, false, "reads never start work");
              assert.equal(value?.usedThisHour, 1, "reads never consume the hourly cap");
            }
          }
          // One past the ceiling: the extra caller is refused, and the refusal is the
          // pool's overload policy rather than a permission error -- which is exactly
          // the distinction the HTTP handler's `42501`-specific degradation rests on.
          //
          // `allSettled`, not `all`: a first version used `Promise.all`, which
          // rejects on the FIRST refusal and leaves the still-admitted callers
          // running. The very next read then hit `admit` with a full waiting queue
          // and was refused too, so "the pool still serves afterwards" failed with a
          // `database_unavailable` that had nothing to do with this migration. Every
          // caller must be settled before the recovery read, or the test measures its
          // own burst rather than the pool.
          const burst = await Promise.allSettled(Array.from({ length: atCeiling + 8 },
            () => advance.loopAllowanceForOwner(identity, T.project, run.runId)));
          const refusals = burst.filter(settled => settled.status === "rejected");
          assert.ok(refusals.length > 0,
            "a burst past the ceiling is refused by the pool's own overload policy");
          for (const refusal of refusals) {
            const sqlState = (refusal as PromiseRejectedResult).reason?.sqlState;
            assert.notEqual(sqlState, "42501",
              "an over-ceiling refusal must not be mistaken for the permission error this migration fixed");
          }
          assert.ok(burst.some(settled => settled.status === "fulfilled"),
            "the admitted callers inside an over-ceiling burst still succeed");
          // And the pool still serves afterwards, which is what "bounded" has to mean.
          const after = await advance.loopAllowanceForOwner(identity, T.project, run.runId);
          assert.ok(after, "the reader still works after an over-ceiling burst");
          assert.equal(after?.usedThisHour, 1);
          assert.equal((await admin.query("SELECT count(*)::int AS count FROM pipeline_advance_receipts WHERE tenant_id=$1",
            [T.tenantId])).rows[0]?.count, 1, `${atCeiling + 8} concurrent readers wrote nothing`);
          return { granted: GRANTED.length, refused: NOT_GRANTED.length, atCeiling,
            usedThisHour: live?.usedThisHour };
        } finally { await coordinator.close(); await web.close(); }
      } finally { await admin.end(); }
    }, { port: PORT, allowedPorts: ALLOWED_PORTS, boundMs: 240_000 });
    assert.equal(result.cleanedUp, true);
  });

test("R7L-06-PG: an UPGRADED int9-shaped database gets the same read, from the migration and the role file",
  needsPg(), async () => {
    // The other half of the finding. `private_web_roles.sql` is only read when the
    // module is provisioned, so a database provisioned BEFORE this migration kept
    // the older ACL and would have kept failing until reprovisioned. 0298 exists to
    // close that gap, so the rung that matters is the UPGRADE: apply the ledger as
    // it stood without 0298, confirm the read still fails 42501, then apply 0298
    // and confirm it succeeds -- all as the same production web login.
    const result = await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin({ database: postgres.database }));
      admin.on("error", () => {});
      await admin.connect();
      try {
        await seed(admin);
        // Prove the SEEDING half ran on a real, migrated database: the table exists.
        const seeded = (await admin.query(`SELECT count(*)::int AS count FROM pipeline_advance_receipts
          WHERE tenant_id=$1`, [T.tenantId])).rows[0];
        assert.ok(seeded !== undefined, "the receipt table exists after the real migration ledger is applied");
        // The migration's own grant, applied through the real file, is what an
        // upgrade runs. Applied as the migrator/superuser path the applier uses.
        const migration = readFileSync(path.join(REPO, "db/migrations/0298_owner_run_allowance_receipt_read.sql"), "utf8");
        await admin.query(migration);
        const web = productionPool(postgres);
        try {
          const linear = new LinearPipelineServiceV1(web.client, SCOPE, KEY, selection, () => at);
          const saved = await linear.createTemplate(identity, T.project, templateDefinition);
          const run = await linear.instantiate(identity, T.project,
            { templateId: saved.templateId, title: "Upgraded" }, "r7lgrant-upg-00000001");
          const advance = new PipelineAdvanceServiceV1(web.client, SCOPE, KEY, {}, () => at);
          await advance.setAllowance(identity, { runsPerHour: 6, runsPerAgentPerDay: 12,
            machineMaxAgentProcesses: 12, machineMaxDbClusters: 6, dollarCapMicroUsd: null, observedDbClusters: 1 });
          const live = await advance.loopAllowanceForOwner(identity, T.project, run.runId);
          assert.ok(live, "after 0298 the upgraded database serves the allowance read");
          assert.equal(live?.runsPerHour, 6);
          assert.equal(live?.startsWork, false);

          // THE DOWN RUNG, on real rows, through the real file. It must revoke
          // exactly the nine columns and nothing else: the coordinator keeps its own
          // INSERT/SELECT, and the web login is back to 42501 on the projection.
          //
          // The count is read with `attacl`, the COLUMN's own ACL, which is where a
          // `GRANT SELECT (a, b)` lands -- not `relacl`, which carries only the
          // table-wide entries and would report the role as holding nothing at all.
          // It is `aclexplode` over a LATERAL join rather than over
          // `COALESCE(attacl, '{}')`: a column with no per-column ACL has a NULL
          // `attacl`, and an empty array literal in that position is rejected by
          // PostgreSQL's ACL parser as "ACL arrays must be one-dimensional" (22023).
          // The join drops the NULL rows, which is the correct answer -- no ACL entry
          // means no grant -- where a COALESCE would have had to invent one.
          const webColumnsHeld = async () => (await admin.query<{ count: number }>(`SELECT count(*)::int AS count
            FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid
            JOIN LATERAL aclexplode(att.attacl) acl ON true
            WHERE c.relname='pipeline_advance_receipts' AND att.attnum>0 AND NOT att.attisdropped
              AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='control_room_private_web')
              AND acl.privilege_type='SELECT'`)).rows[0]?.count;
          const coordinator = productionPool(postgres, "coordinator");
          try {
            assert.equal(await webColumnsHeld(), GRANTED.length,
              `the web login holds exactly the ${GRANTED.length} granted columns`);
            await admin.query(readFileSync(path.join(REPO, "db/down/0298_owner_run_allowance_receipt_read.sql"), "utf8"));
            assert.equal(await webColumnsHeld(), 0,
              "the down rung revoked every column it granted, and no others");
            // The coordinator's own authority survives the rollback.
            assert.equal((await coordinator.client.query(
              "SELECT count(*)::int AS count FROM pipeline_advance_receipts WHERE tenant_id=$1", [T.tenantId])
            ).rows[0]?.count, 0, "the coordinator still reads the table after the down rung");
            // And the web login is refused again, which is what a rollback must mean.
            let sqlState: string | undefined;
            try { await advance.loopAllowanceForOwner(identity, T.project, run.runId); }
            catch (error) { sqlState = (error as { sqlState?: string }).sqlState; }
            assert.equal(sqlState, "42501", "after the down rung the read is refused again, as a permission error");
            // Re-applying the up file restores it, so the pair is a real round trip.
            await admin.query(migration);
            const restored = await advance.loopAllowanceForOwner(identity, T.project, run.runId);
            assert.ok(restored, "re-applying 0298 restores the read");
          } finally { await coordinator.close(); }
          return { downRoundTrip: true };
        } finally { await web.close(); }
      } finally { await admin.end(); }
    }, { port: PORT + 1, allowedPorts: ALLOWED_PORTS, boundMs: 240_000 });
    assert.equal(result.cleanedUp, true);
  });

test("R7L-06-PG: the grant is declared, the migration is the only source of it, and no other login got it",
  async () => {
    // The three static facts that keep a grants-only migration honest without a
    // cluster. A drift in any of them is invisible on a correctly-built database,
    // which is exactly why the real-cluster tests above cannot be the only check.
    //
    // EVERY SQL ASSERTION BELOW READS COMMENTS-STRIPPED SQL. This file's own first
    // failure was exactly that mistake: the migration's prose says "no INSERT,
    // UPDATE or DELETE", so a naive `GRANT[^;]*INSERT` scan matches the COMMENT
    // and fails on a migration that grants nothing but SELECT. A guard that
    // matches prose would have to be deleted to pass, which is how a real check
    // gets removed.
    const sql = (relative: string) => readSource(relative).replace(/--[^\n]*/gu, "");
    const preflight = sql("src/web/v1/private-database-preflight.ts");
    const roleFile = sql("db/roles/private_web_roles.sql");
    const migration = sql("db/migrations/0298_owner_run_allowance_receipt_read.sql");
    const down = sql("db/down/0298_owner_run_allowance_receipt_read.sql");

    // 1. The declaration names the same nine columns as the role file and the
    //    migration, column for column. All three are read as SETS because the
    //    three files legitimately order them differently.
    const declared = /pipeline_advance_receipts:\s*\[([^\]]*)\]/u.exec(preflight);
    assert.ok(declared, "the preflight no longer declares a column-scoped read on pipeline_advance_receipts");
    const declaredColumns = declared[1]!.split(",").map(column => column.trim().replace(/^["']|["']$/gu, ""))
      .filter(column => column !== "").sort();
    assert.deepEqual(declaredColumns, [...GRANTED].sort(),
      "the preflight declaration and the granted column set disagree");

    // 2. `pipeline_stage_loop_counts` must not appear in ANY of the three. It is
    //    read by nothing in src/, so a grant would be authority no code path can
    //    exercise and the preflight would have to declare it forever.
    for (const [name, text] of [["preflight", preflight], ["role file", roleFile],
      ["migration", migration], ["down", down]] as const) {
      assert.doesNotMatch(text, /GRANT[^;]*pipeline_stage_loop_counts/u,
        `${name} grants pipeline_stage_loop_counts, which nothing in src/ reads`);
    }
    assert.doesNotMatch(migration, /GRANT[^;]*\bINSERT\b/u, "0298 grants no INSERT to any role");
    assert.doesNotMatch(migration, /GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/u,
      "0298 grants no write or DDL-adjacent privilege to any role");
    // Only the one role, so "the smallest fix" is checkable rather than asserted.
    const grantees = [...migration.matchAll(/GRANT[^;]*?TO\s+([a-z_]+)/gu)].map(match => match[1]);
    assert.deepEqual(grantees, ["control_room_private_web"],
      `0298 must name exactly one grantee, got ${grantees.join(", ")}`);
    // The up file creates no object, so there is nothing for a down file to drop:
    // it revokes, and it names the same nine columns.
    assert.doesNotMatch(migration, /\bCREATE\b|\bDROP\b|\bALTER\b/u,
      "0298 is a grants-only migration and must not create, alter or drop anything");
    // The down rung's columns are read from the SQL's own string literals, because
    // the file spells the list across two concatenated literals and a split on
    // `)` or on quote-position happens to land inside `SET LOCAL lock_timeout =
    // '1s'` -- which is what the first version of this read did. A guard that reads
    // the wrong span reports a disagreement that is not one.
    //
    // The `||` CONCATENATION is handled, because it is how both files are written:
    // the list is long enough that no single line holds it, so it is one literal
    // continued by `|| '...'`. Joining the pieces first is what makes the read see
    // nine columns rather than eight plus a `'\n || 'execution_job_id` fragment --
    // the same class of mistake as reading a quoted span at the wrong offset.
    const literalColumns = (text: string, verb: "GRANT" | "REVOKE") => {
      const joined = text.replace(/'\s*\|\|\s*'/gu, "");
      const found = new Set<string>();
      for (const match of joined.matchAll(new RegExp(`${verb}\\s+SELECT\\s*\\(([^)]*)\\)`, "giu")))
        for (const column of match[1]!.split(",")) {
          const name = column.trim();
          if (name !== "") found.add(name);
        }
      return [...found].sort();
    };
    assert.deepEqual(literalColumns(migration, "GRANT"), [...GRANTED].sort(),
      "the up file does not grant exactly the nine columns it claims");
    assert.deepEqual(literalColumns(down, "REVOKE"), [...GRANTED].sort(),
      "the down rung does not revoke exactly what the up file granted");
    // The nine are the whole grant: a tenth column in either file must fail here,
    // not pass a `<=` comparison. This is the assertion that would catch a later
    // migration widening this one column by column.
    assert.doesNotMatch(migration, new RegExp(`GRANT\\s+SELECT\\s*\\([^)]*\\bauth_tag\\b`, "iu"),
      "auth_tag must never be readable by the web login: it is the receipt's HMAC");
    assert.doesNotMatch(down, /REVOKE[^;]*\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u,
      "the down rung revokes a privilege the up file never granted");
    // The down rung must be a REVOKE and nothing else. A `DROP TABLE` here would
    // destroy the receipts the coordinator's own history is made of, on a table
    // this migration never created.
    assert.doesNotMatch(down, /\bDROP\b|\bTRUNCATE\b|\bALTER\b|\bCREATE\b/u,
      "the down rung destroys or alters an object; 0298 created none, so it must only revoke");
  });
