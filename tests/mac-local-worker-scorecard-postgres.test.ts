// Real-PostgreSQL proof that the Workers page's "Bot & model scorecard" is
// actually connected on a Mac, driven through the production Mac-local web
// process as the production web login.
//
// The defect this exists for was a composition one: `/api/v1/workers-scorecard`
// existed in the hosted route table and nothing passed it a reader, so the panel
// said "could not be read" on every host while every read-level test passed. A
// test that builds `DatabaseWorkerScorecardReadSourceV1` directly cannot see
// that, so every assertion here goes through
// `createMacLocalWebProcessV1`'s own route table, and the identity/scope come
// from the real local-owner session and the real session-authority grants.
//
// Scoped to the reserved disposable-cluster lane 59240-59259.
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import test from "node:test";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createPostgresLocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import { LOCAL_OWNER_SESSION_PROFILE_V1, type LocalOwnerSessionProfileV1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { workerScorecardReadSchemaV1 } from "../src/web/v1/worker-scorecard-browser-client";

const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) =>
  Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59240) + index));
const PORT = PORTS[5];
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PG = requiresRealPostgres();

const TENANT = "tenant:scorecard-host";
const WORKSPACE = "workspace:scorecard-host";
/** A second workspace inside the SAME tenant. Its build stages must never
 * appear in the first workspace's board. */
const OTHER_WORKSPACE = "workspace:scorecard-other";
const OTHER_PROJECT = "project:scorecard-other";
const PROJECT = "project:scorecard";
const ADAPTER = "adapter:scorecard-host";
const PROVIDER = "test";
const OWNER = "identity:scorecard-owner";
/** A second live identity whose grant allows `projects.read` but is not an
 * owner. It exists so the owner check has something to refuse: a missing or
 * revoked session is already stopped by the local session reader, upstream. */
const OPERATOR = "identity:scorecard-operator";
const OPERATOR_TOKEN = "w".repeat(43);
const OWNER_CODE = "scorecard-host-owner-code-0000000001";
const TOKEN = "q".repeat(43);
const COOKIE = `control_room_local_owner=${TOKEN}`;
const PROFILE: LocalOwnerSessionProfileV1 = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN,
  tenantId: TENANT, provider: PROVIDER, subject: OWNER, ownerCodeDigest: sha256Digest({ ownerCode: OWNER_CODE }),
  sessionSeconds: 3600 };

/** The digest the local owner session derives for this profile's own origin. */
const LOCAL_TOKEN_DIGEST = sha256Digest({ token: TOKEN, installationBindingDigest: sha256Digest({
  schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN, tenantId: TENANT, provider: PROVIDER,
  subject: OWNER, ownerCodeDigest: PROFILE.ownerCodeDigest }) });

const DIGEST = `sha256:${"a".repeat(64)}`;
const TAG = `hmac-sha256:${"b".repeat(64)}`;
/** One session window for the whole file. The local owner session and the
 * `control_web_sessions` row must agree on `issued_at` to the millisecond:
 * `WebSessionAuthority` compares the row's instant against the verified
 * identity's, so two separately-computed `Date.now()` readings differ and the
 * owner is refused for a session that is in fact live. */
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();

function webClient(postgres: { port: number; database: string; connection(role: "web"): { user: string; password: string; host: string } }) {
  const login = postgres.connection("web");
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
    host: login.host }));
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(tx)),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(tx), check) };
  return { client, close: () => bound.close() };
}

async function seedWorkspace(admin: Client, workspaceId: string, projectId: string) {
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [workspaceId, TENANT]);
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
  [projectId, TENANT, workspaceId, ADAPTER]);
}

/** One finished build stage. `workspaceId` decides whose board it belongs to. */
async function seedBuildStage(admin: Client, suffix: string, input: {
  workspaceId: string; projectId: string; model: string;
  finishedAt: string; outcome: "succeeded" | "failed";
}) {
  const ids = { request: `request:sc-${suffix}`, workflow: `workflow:sc-${suffix}`, pipelineRun: `pipeline-run:sc-${suffix}`,
    template: `pipeline-template:sc-${suffix}`, job: `job:sc-${suffix}`, attempt: `attempt:sc-${suffix}`,
    stage: `pipeline-stage-run:sc-${suffix}` };
  const at = input.finishedAt;
  // An attempt's node must exist: `control_attempts` carries an FK onto
  // `control_nodes`, so the node row is seeded once per stage here rather than
  // by a shared fixture the workspace scope would then have to reach through.
  await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES($1,$2,'active',0,$3,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',0,
      'identityKeyId',$3::text),$4::timestamptz,$4::timestamptz)`,
  [`node:scorecard-${suffix}`, TENANT, `key:scorecard-${suffix}`, at]);
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',0,$1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','accepted','version',0,
      'projectId',$3::text,'idempotencyKey',$1::text),$4::timestamptz,$4::timestamptz)`,
  [ids.request, TENANT, input.projectId, at]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',1,
      'requestId',$3::text,'projectId',$4::text,'definitionDigest',$5::text),$6::timestamptz,$6::timestamptz)`,
  [ids.workflow, TENANT, ids.request, input.projectId, DIGEST, at]);
  await admin.query(`INSERT INTO pipeline_templates(id,tenant_id,project_id,name,description,stages,max_stages,
      max_total_loops,may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at)
    VALUES($1,$2,$3,'Fixture template','Fixture template.','[{"ordinal":0}]'::jsonb,1,1,false,3600,$4,$5,1,$6::timestamptz,$6::timestamptz)`,
  [ids.template, TENANT, input.projectId, DIGEST, TAG, at]);
  await admin.query(`INSERT INTO pipeline_runs(id,tenant_id,project_id,request_id,template_id,template_version,
      template_digest,workflow_id,title,state,updated_at,current_stage_ordinal,unattended,record_digest,auth_tag,version)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,'Fixture run',$8,$9::timestamptz,0,false,$6,$10,1)`,
  [ids.pipelineRun, TENANT, input.projectId, ids.request, ids.template, DIGEST, ids.workflow,
    input.outcome === "succeeded" ? "succeeded" : "failed", at, TAG]);
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at,stage_kind,stage_ordinal,pipeline_run_id)
    VALUES($1,$2,$3,$4,$5,1,50,'code.change',$6,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$5::text,'version',1,
      'priority',50,'workflowId',$3::text,'projectId',$4::text,'requiredCapability','code.change',
      'authority',jsonb_build_object('digest',$6::text)),
      $7::timestamptz,$7::timestamptz,'build',0,$8)`,
  [ids.job, TENANT, ids.workflow, input.projectId, input.outcome, DIGEST, at, ids.pipelineRun]);
  await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,$4,1,$5,1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$4::text,'version',1,
      'jobId',$3::text,'attemptNumber',1,'nodeId',$5::text,'leaseEpoch',1),$6::timestamptz,$6::timestamptz)`,
  [ids.attempt, TENANT, ids.job, input.outcome, `node:scorecard-${suffix}`, at]);
  await admin.query(`INSERT INTO pipeline_stage_runs(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,stage_kind,role,
      worker_id,worker_kind,node_id,selection_key,model,effort,current_job_id,current_attempt_id,state,max_loops,
      started_at,finished_at,record_digest,auth_tag,version)
    VALUES($1,$2,$3,$4,0,'build','builder',$5,'codex',$6,$7,$8,'high',$9,$10,$11,3,$12::timestamptz,$12::timestamptz,$13,$14,1)`,
  [ids.stage, TENANT, input.projectId, ids.pipelineRun, `worker:${suffix}`, `node:scorecard-${suffix}`, `${suffix}.selection`,
    input.model, ids.job, ids.attempt, input.outcome, at, DIGEST, TAG]);
  if (input.outcome !== "succeeded") return ids;
  // A succeeded build stage carries a completion-gate target. revisionNumber 0
  // is a first-time pass; the fixture's stages are all first-time passes, which
  // is enough to prove the route reaches the aggregate query at all.
  //
  // r7tfix (R7-01): the target's subject is the EXECUTION job the harness ran,
  // reached from the stage's job through its execution plan -- never the stage's
  // own job. The fixture writes that shape, as the product does.
  const execution = `${ids.job}-exec`;
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,'succeeded',1,50,'code.change',$5,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','succeeded','version',1,
      'priority',50,'workflowId',$3::text,'projectId',$4::text,'requiredCapability','code.change',
      'authority',jsonb_build_object('digest',$5::text)),$6::timestamptz,$6::timestamptz)`,
  [execution, TENANT, ids.workflow, input.projectId, DIGEST, at]);
  await admin.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [TENANT, input.projectId, ids.job, execution,
    JSON.stringify({ schema: "control-room.task-execution-plan/v1", tenantId: TENANT, projectId: input.projectId,
      sourceJobId: ids.job, jobId: execution, job: { id: execution } }), TAG]);
  await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
      parent_id,record_digest,record_auth_tag,payload,occurred_at)
    VALUES($1,$2,$3,'target',$1,$4,NULL,$5,$6,jsonb_build_object('id',$1::text,'rootTargetId',$1::text,
      'revisionNumber',0,'subjectId',$4::text),$7::timestamptz)`,
  [`target:sc-${suffix}`, TENANT, input.projectId, execution, DIGEST, TAG, at]);
  return ids;
}

/** The Mac-local web process, exactly as the host composes it, minus the socket. */
function host(client: DatabaseClient) {
  return { app: createMacLocalWebProcessV1({ origin: ORIGIN, workspaceId: WORKSPACE, localOwnerSession: PROFILE,
    localOwnerSessionStore: createPostgresLocalOwnerSessionStoreV1(client, PROFILE),
    initialLocalOwnerSessions: [{ tokenDigest: LOCAL_TOKEN_DIGEST, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT }],
    database: { client, close: async () => {}, isAvailable: () => true }, clock: Date.now,
    workerReadiness: { read: () => [] }, taskWorkersStarted: true }) };
}

const render = () => { throw new Error("an API route fell through to the page renderer") };
const call = (path: string, cookie = COOKIE) => new Request(`${ORIGIN}${path}`,
  { method: "GET", headers: { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", accept: "application/json" } });

async function seedOwnerSessions(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Scorecard tenant')", [TENANT]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control-room-manual','1.0.0',
    'control_room_native','disabled','v1',30)`, [ADAPTER, TENANT]);
  await seedWorkspace(admin, WORKSPACE, PROJECT);
  await seedWorkspace(admin, OTHER_WORKSPACE, OTHER_PROJECT);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,
    state,created_at,updated_at) VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
  [OWNER, TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: OWNER }), ISSUED_AT]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
    allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`, [`grant:scorecard-owner`, TENANT, OWNER, ISSUED_AT]);
  // Both digests are seeded: the local-session token, and the digest the
  // WebSessionAuthority reads for a session row keyed by anything else.
  for (const digest of [LOCAL_TOKEN_DIGEST, sha256Digest({ session: "scorecard-owner" })])
    await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [TENANT, digest, OWNER, ISSUED_AT, EXPIRES_AT]);
}

test("the Mac-local host serves the worker scorecard with real data, scoped to its own workspace", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedOwnerSessions(admin);
      // The current user's login is the real restricted web role, not a
      // superuser, so a missing grant fails here rather than in a mock.
      const role = await client.query<{ current_user: string; rolsuper: boolean }>(
        "SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user");
      assert.equal(role.rows[0]?.rolsuper, false, "the read must not run as a superuser");
      assert.equal(role.rows[0]?.current_user, "control_room_web");
      const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
      await seedBuildStage(admin, "ownpass", { workspaceId: WORKSPACE, projectId: PROJECT,
        model: "own-model", finishedAt: at(-3_600), outcome: "succeeded" });
      await seedBuildStage(admin, "ownfail", { workspaceId: WORKSPACE, projectId: PROJECT,
        model: "own-model", finishedAt: at(-1_800), outcome: "failed" });
      // A stage in another workspace of the SAME tenant, with a model name the
      // owner must never see on this board.
      await seedBuildStage(admin, "otherws", { workspaceId: OTHER_WORKSPACE, projectId: OTHER_PROJECT,
        model: "other-workspace-model", finishedAt: at(-900), outcome: "succeeded" });

      const { app } = host(client);
      t.after(async () => { await app.close(); });
      const response = await app.handle(call("/api/v1/workers-scorecard"), render);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const view = workerScorecardReadSchemaV1.parse(JSON.parse(text));
      assert.deepEqual(view.groups.map(group => group.model), ["own-model"]);
      const group = view.groups[0]!;
      assert.equal(group.workerKind, "codex");
      assert.equal(group.effort, "high");
      assert.equal(group.last30Days.finished, 2);
      assert.equal(group.last30Days.passedFirstTime, 1);
      assert.equal(group.last30Days.failedOrBlocked, 1);
      // The other workspace's stage is absent from the JSON entirely, not
      // merely unmentioned in prose.
      assert.doesNotMatch(text, /other-workspace-model/u);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[0], allowedPorts: PORTS, boundMs: 300_000 });
});

test("a live non-owner identity cannot reach the scorecard at all", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedOwnerSessions(admin);
      // A live operator identity whose grant DOES allow projects.read, with a
      // live session row. This is the caller that WOULD pass if the route read
      // its scope without the owner check -- and it is refused twice over:
      //
      //  1. `LocalOwnerSessionServiceV1.verifyLive` binds every cookie to the
      //     installation profile's own subject, so no other identity can hold a
      //     session on this host at all; and
      //  2. `require("projects.read", undefined, true)` inside the service
      //     selects owner grants only.
      //
      // Both are asserted by their observable answer rather than assumed from
      // the code: the route must refuse, and the owner's own cookie must still
      // answer 200 on the same process, so the refusal is about the caller.
      const digest = sha256Digest({ token: OPERATOR_TOKEN, installationBindingDigest: sha256Digest({
        schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN, tenantId: TENANT, provider: PROVIDER,
        subject: OPERATOR, ownerCodeDigest: PROFILE.ownerCodeDigest }) });
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,
        state,created_at,updated_at) VALUES($1,$2,'human','Operator',$3,$4,'active',$5,$5)`,
      [OPERATOR, TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: OPERATOR }), ISSUED_AT]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES($1,$2,$3,'operator','["projects.read"]','["*"]','critical',false,false,$4,$4)`,
      [`grant:scorecard-operator`, TENANT, OPERATOR, ISSUED_AT]);
      await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5)`, [TENANT, digest, OPERATOR, ISSUED_AT, EXPIRES_AT]);

      const app = host(client).app;
      t.after(async () => { await app.close(); });
      const operatorCookie = `control_room_local_owner=${OPERATOR_TOKEN}`;
      const refused = await app.handle(call("/api/v1/workers-scorecard", operatorCookie), render);
      assert.equal(refused.status, 401, `a live non-owner session must be refused, got ${await refused.text()}`);
      // The owner check inside the service, tested directly against the SAME
      // database and the SAME service object, so it is not resting on the
      // session reader alone: with the operator's own verified identity the
      // owner check refuses even though that identity's session and grant are
      // both live.
      const { MacLocalWorkerScorecardServiceV1 } = await import("../src/web/v1/mac-local-worker-scorecard-service");
      const service = new MacLocalWorkerScorecardServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE });
      await assert.rejects(service.read({ provider: PROVIDER, subject: OPERATOR, tokenDigest: digest,
        issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT }),
      (error: { code?: string }) => error.code === "access_denied",
      "a live operator holding projects.read must still be refused the owner-only scorecard");
      // The owner's own cookie still answers 200 on the same process.
      assert.equal((await app.handle(call("/api/v1/workers-scorecard"), render)).status, 200);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[2], allowedPorts: PORTS, boundMs: 300_000 });
});

test("the scorecard route survives a burst of concurrent owner reads without a 5xx or a leak", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedOwnerSessions(admin);
      const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
      for (let index = 0; index < 12; index += 1)
        await seedBuildStage(admin, `load${index}`, { workspaceId: WORKSPACE, projectId: PROJECT,
          model: `load-model-${String(index).padStart(2, "0")}`, finishedAt: at(-3_600 - index * 60),
          outcome: index % 3 === 0 ? "failed" : "succeeded" });
      const { app } = host(client);
      t.after(async () => { await app.close(); });
      // The CONTROL arm: an existing owner read, on the same process and the same
      // 8-connection pool. Whatever this answers under the same burst is the
      // pool's own capacity, not something the scorecard route introduces.
      const control = await Promise.all(Array.from({ length: 50 }, () =>
        app.handle(call("/api/v1/needs-me/tasks"), render)));
      const controlStatuses = [...new Set(control.map(r => r.status))].sort();
      // 50 concurrent owner reads against one 8-connection pool. Whatever the
      // existing read answers, the scorecard must answer identically: it holds a
      // web transaction only for its own authorization, then releases it before
      // the grouped query, so it must not pool-starve itself beyond the host's
      // documented capacity or deadlock against the completion gate.
      const burst = await Promise.all(Array.from({ length: 50 }, () =>
        app.handle(call("/api/v1/workers-scorecard"), render)));
      const statuses = [...new Set(burst.map(r => r.status))].sort();
      assert.deepEqual(statuses, controlStatuses,
        `the scorecard's burst statuses must match an existing owner read's (control ${controlStatuses.join(",")})`);
      console.log(`burst 50 concurrent reads: control ${controlStatuses.join(",")}, scorecard ${statuses.join(",")}`);
      assert.ok(statuses.every(status => status === 200 || status === 503),
        `unexpected status in the burst: ${statuses.join(",")}`);
      const ok = burst.filter(response => response.status === 200);
      const bodies = await Promise.all(ok.map(response => response.json()));
      if (!ok.length) return;
      // observedAt is each read's own authorization instant (actor.now). Fifty reads
      // dispatched together need not all start in the same millisecond (on the merged
      // int9 web host they span two), so the board is compared without it, and every
      // instant must still fall inside the burst.
      const board = (body: { observedAt?: unknown }) => JSON.stringify({ ...body, observedAt: undefined });
      const first = board(bodies[0]);
      assert.ok(bodies.every(body => board(body) === first),
        "concurrent reads of one instant must describe the same board");
      const instants = bodies.map(body => Date.parse(body.observedAt));
      assert.ok(Math.max(...instants) - Math.min(...instants) < 60_000, "every read is observed within the burst");
      const view = workerScorecardReadSchemaV1.parse(bodies[0]);
      assert.equal(view.groups.length, 12, "a concurrent burst must not silently drop groups");
      // The pool is still usable afterwards: 8 max connections, 50 in flight.
      assert.equal((await app.handle(call("/api/v1/workers-scorecard"), render)).status, 200);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[3], allowedPorts: PORTS, boundMs: 300_000 });
});

test("the Mac-local scorecard refuses a signed-out caller and reports an empty board honestly", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedOwnerSessions(admin);
      const { app } = host(client);
      t.after(async () => { await app.close(); });
      // No cookie at all.
      assert.equal((await app.handle(call("/api/v1/workers-scorecard", ""), render)).status, 401);
      // A well-formed cookie this installation never issued.
      const forged = `control_room_local_owner=${"z".repeat(43)}`;
      assert.equal((await app.handle(call("/api/v1/workers-scorecard", forged), render)).status, 401);
      // Two owner cookies in one request is not one session, and the session
      // reader refuses it rather than picking one.
      assert.equal((await app.handle(new Request(`${ORIGIN}/api/v1/workers-scorecard`, { headers: {
        cookie: `${COOKIE}; ${COOKIE}`, origin: ORIGIN, "sec-fetch-site": "same-origin" } }), render)).status, 401);
      // With nothing recorded, the board is EMPTY, not unreadable. This is the
      // sentence the owner reads instead of "could not be read".
      const empty = await app.handle(call("/api/v1/workers-scorecard"), render);
      assert.equal(empty.status, 200);
      const view = workerScorecardReadSchemaV1.parse(await empty.json());
      assert.deepEqual(view.groups, []);
      // A non-GET and a query string are refused, so this route stays the
      // bounded read it is.
      assert.equal((await app.handle(new Request(`${ORIGIN}/api/v1/workers-scorecard?limit=5`,
        { headers: { cookie: COOKIE, origin: ORIGIN, "sec-fetch-site": "same-origin" } }), render)).status, 400);
      assert.equal((await app.handle(new Request(`${ORIGIN}/api/v1/workers-scorecard`, { method: "POST",
        headers: { cookie: COOKIE, origin: ORIGIN, "sec-fetch-site": "same-origin",
          "content-type": "application/json" }, body: "{}" }), render)).status, 400);
      // A session revoked DURABLY by another process -- a second device signing
      // out, or the updater -- must stop working on this running host without a
      // restart. `verifyLive` re-reads the store's rows; the in-process `verify`
      // answers from the startup map and would keep serving a revoked cookie
      // for the life of the process, which is exactly R4C-10's defect.
      await client.query(`UPDATE control_web_sessions SET revoked_at=$1
        WHERE tenant_id=$2 AND token_digest=$3`, [new Date().toISOString(), TENANT, LOCAL_TOKEN_DIGEST]);
      const burst = await Promise.all(Array.from({ length: 20 }, () =>
        app.handle(call("/api/v1/workers-scorecard"), render)));
      assert.ok(burst.every(response => response.status === 401),
        `a durably revoked cookie must be refused on every request, saw ${burst.map(r => r.status).join(",")}`);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[1], allowedPorts: PORTS, boundMs: 300_000 });
});