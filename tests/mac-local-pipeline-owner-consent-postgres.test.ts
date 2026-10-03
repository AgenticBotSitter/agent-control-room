// R6P-06: the Mac-local website must serve the linear pipeline owner
// consent/history surface.
//
// The finding was a composition defect, not a service defect. The handler's
// optional `advance` port was never supplied on the Mac-local wrapper, so a
// signed-in owner's linear-run history GET was 404 and a VALID unattended
// consent POST was 400, while the owner page still offered both controls.
//
// What this proves, on real PostgreSQL 17, through the REAL Mac-local web
// process and the PRODUCTION logins that execute it:
//   - history answers 200 with the owner's own chain-verified lineage;
//   - a valid consent POST is recorded (201), and an exact replay is 200;
//   - the consent is genuinely in the production table;
//   - the run's own activation reflects the owner's consent;
//   - another project's run is REFUSED through the same signed-in route;
//   - and execution stayed refused: nothing here can start a stage.
//
// The `advance` port is built BY the composition from the same web connection
// and the same installation key, so this exercises the DEFAULT path: no
// injected port, tool, runner or fake for either service. The queue selection
// authority IS passed in, because the Mac-local host supplies it from the
// protected enablement -- but it is built here by the real
// `createWorkBatchQueueSelectionAuthorityV1` over a real catalog, not a stub
// that returns true.
//
// Lane:  pnpm run test:mac-local-pipeline-consent-postgres
// Ports: CONTROL_ROOM_PG_TEST_PORT_BASE (59360 by default, this brief's block).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client, Pool } from "pg";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createWorkBatchQueueSelectionAuthorityV1 } from "../src/work-intake/v1/queue-catalog";
import { sha256Digest } from "../src/security";
import { LinearPipelineServiceV1, PipelineAdvanceServiceV1 } from "../src/pipelines/v1";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59360);
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const KEY = new Uint8Array(32).fill(63);
const PROVIDER = "mac-local-consent-test";
const OWNER_SUBJECT = "subject:mac-local-consent-owner";
const OWNER_CODE = "mac-local-consent-owner-code-long-enough";
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const OWN_PROJECT = "project:consent-own";
const OTHER_PROJECT = "project:consent-other";

/** The protected enablement the Mac-local host derives its queue catalog from.
 * Real worker identities and a real model policy, so the selection authority
 * resolves them by the same rules a real installation uses. */
const ENABLEMENT = { schema: "control-room.owner-trusted-local-enablement/v1", mode: "mac-local",
  nodeId: "mac-1", workers: [
    { workerId: "worker:codex:consent", kind: "codex", executablePath: "/fixture/codex", recordedVersion: "test",
      modelPolicy: { models: ["consent-model"], defaultModel: "consent-model",
        efforts: ["medium", "high"], defaultEffort: "medium" } },
    { workerId: "worker:claude:consent", kind: "claude-code", executablePath: "/fixture/claude",
      recordedVersion: "test", modelPolicy: { models: ["consent-claude"], defaultModel: "consent-claude",
        efforts: ["high"], defaultEffort: "high" } },
    { workerId: "worker:hermes:consent", kind: "hermes", executablePath: "/fixture/hermes",
      recordedVersion: "test", modelPolicy: { profiles: [{ name: "consent-profile", provider: "provider:test",
        model: "consent-hermes" }], defaultProfile: "consent-profile", efforts: ["default"], defaultEffort: "default" } },
  ] } as const;

const TEMPLATE = { name: "Build, check, signoff", description: "Complete one bounded change and review it.",
  stages: [
    { ordinal: 0, stageKind: "build", role: "builder", description: "Build the bounded change.",
      requiredCapability: "code.change", workerId: "worker:codex:consent", workerKind: "codex",
      nodeId: "mac-1.codex", selectionKey: "consent-model", model: "consent-model", effort: "medium", maxLoops: 3,
      allowedPaths: ["src/**"], maximumChangedFiles: 10, maximumChangedBytes: 100_000 },
    { ordinal: 1, stageKind: "check", role: "checker", description: "Check the bounded change.",
      requiredCapability: "code.review", workerId: "worker:claude:consent", workerKind: "claude-code",
      nodeId: "mac-1.claude", selectionKey: "consent-claude", model: "consent-claude", effort: "high", maxLoops: 3 },
    { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate the accepted result.",
      requiredCapability: "code.validate", workerId: "worker:hermes:consent", workerKind: "hermes",
      nodeId: "mac-1.hermes", selectionKey: "consent-profile", model: "consent-hermes", effort: "default",
      provider: "provider:test", profile: "consent-profile", maxLoops: 0 },
  ], maxTotalLoops: 6, maxDurationSeconds: 3600 } as const;

/** The protected queue catalog the Mac-local host derives from its
 * enablement, in the catalog's own shape. Real worker identities, node ids and
 * model policies, so the selection authority resolves them by the same rules a
 * real installation uses -- a stub that returned true would prove nothing about
 * template creation, only about the two routes under test. */
const CATALOG = Object.freeze(ENABLEMENT.workers.map(worker => ({ workerId: worker.workerId,
  workerKind: worker.kind, nodeId: `mac-1.${worker.kind === "codex" ? "codex"
    : worker.kind === "claude-code" ? "claude" : "hermes"}`,
  ...(worker.modelPolicy ? { modelPolicy: worker.modelPolicy } : {}) })));
/** The presentation-only form the Mac-local web process actually receives: the
 * selection half of the coordinator's snapshot port. Nothing on the consent or
 * history path consults the accepted-result half. */
const SELECTION = Object.freeze({
  binding: "coordinator_snapshot" as const,
  assertCurrent: createWorkBatchQueueSelectionAuthorityV1(CATALOG, { isReady: () => true }).assertCurrent,
  isAcceptedResultCurrent: async () => false,
  acceptedResultProof: async () => null,
});

async function freePort() {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

/** The PRODUCTION web login: exact driver, pool options, session qualification. */
function productionWebPool(postgres: RealPostgres) {
  const login = postgres.connection("web");
  const configuration = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(configuration), host: login.host }));
  const refused: string[] = [];
  const traced = (session: DatabaseSession): DatabaseSession => ({ query: async (sql, params) => {
    try { return await session.query(sql, params); }
    catch (error) { refused.push(sql.replace(/\s+/g, " ").trim()); throw error; }
  } });
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  return { configuration, refused, pool: { client, close: () => bound.close() } };
}

const permissionFailure = (error: unknown, refused: readonly string[] = []) => {
  const sqlState = (error as { sqlState?: unknown; code?: unknown } | null)?.sqlState
    ?? (error as { code?: unknown } | null)?.code;
  return `${String(error)} sqlState=${String(sqlState)}${sqlState === "42501" ? " (permission denied)" : ""}`
    + (refused.length ? ` refused statement: ${refused.at(-1)}` : "");
};

/** One tenant, TWO projects and one live owner identity, seeded as schema owner
 *  so the proof can only fail on the web login's own grants. */
async function seedOwnerWithTwoProjects(admin: Client, tenant: { tenantId: string; workspaceId: string }) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Consent tenant')", [tenant.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Consent workspace')",
    [tenant.workspaceId, tenant.tenantId]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:consent',$1,'control-room-manual','1.0.0',
    'control_room_native','disabled','v1',30)`, [tenant.tenantId]);
  for (const project of [OWN_PROJECT, OTHER_PROJECT]) {
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,'adapter:consent',$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
    [project, tenant.tenantId, tenant.workspaceId]);
    await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,'active',1,now(),now())`, [tenant.tenantId, project]);
  }
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,
    state,created_at,updated_at) VALUES('identity:consent-owner',$1,'human','Owner',$2,$3,'active',$4,$4)`,
  [tenant.tenantId, PROVIDER, sha256Digest({ provider: PROVIDER, subject: OWNER_SUBJECT }), ISSUED_AT]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:consent-owner',$1,'identity:consent-owner','owner','["*"]','["*"]','critical',true,false,$2,$2)`,
  [tenant.tenantId, ISSUED_AT]);
  await admin.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,
    eligible_routes,risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,
    valid_from,valid_until,payload,created_at,updated_at)
    VALUES($1,'policy:consent',$2,'identity:consent-owner',1,'active',1,$3,'identity:consent-owner',$3,
    '["tasks.assign"]','["mac-1.codex","mac-1.claude","mac-1.hermes"]','low','none',3,1000,2,
    $4,$5,'{}',$4,$4)`,
  [tenant.tenantId, OWN_PROJECT, sha256Digest({ policy: "consent" }),
    new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 600_000).toISOString()]);
}

test("the real Mac-local process serves pipeline history and unattended consent on the production web login",
  async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  required += 1;
  await withRealPostgres(async postgres => {
    const adminLogin = postgres.admin({ database: postgres.database });
    const admin = new Client(adminLogin);
    await admin.connect();
    const tenant = { tenantId: "tenant:consent-mac", workspaceId: "workspace:consent-mac" };
    try { await seedOwnerWithTwoProjects(admin, tenant); } finally { await admin.end(); }

    const web = productionWebPool(postgres);
    const scope = { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId };
    const origin = `http://127.0.0.1:${await freePort()}`;
    // The REAL Mac-local composition, with only the installation key and the
    // host-owned queue selection port supplied -- exactly what
    // createMacLocalWebServiceFromConfigurationV1 forwards.
    const app = createMacLocalWebProcessV1({
      origin, workspaceId: tenant.workspaceId,
      localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: tenant.tenantId,
        provider: PROVIDER, subject: OWNER_SUBJECT,
        ownerCodeDigest: sha256Digest({ ownerCode: OWNER_CODE }), sessionSeconds: 900 },
      database: { client: web.pool.client, close: async () => {}, isAvailable: () => true },
      workBatchIntegrityKey: KEY, workBatchQueueAdmissionAuthority: SELECTION, clock: () => Date.now(),
    });
    let cookie = "";

    const render = () => new Response("page", { status: 200 });
    const call = (path: string, init: RequestInit = {}) =>
      app.handle(new Request(`${origin}${path}`, init), render);
    const authed = (path: string, init: RequestInit = {}) =>
      call(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), origin,
        cookie, "sec-fetch-site": "same-origin" } });

    try {
      // The startup preflight on the very login the site uses: if this
      // composition needed a grant the web role does not hold, it says so here
      // rather than as a permission error inside an owner action.
      await verifyPrivateDatabase(web.pool.client, web.configuration,
        { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId,
          ownerIdentityId: "identity:consent-owner", issuer: PROVIDER }, Date.now(), { nativeQueue: true });

      const signedIn = await call("/api/v1/local-owner-session", { method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ ownerCode: OWNER_CODE }) });
      assert.equal(signedIn.status, 201, await signedIn.clone().text());
      cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;

      // The identity the session store now holds, for the service-level seeding
      // below. This is the same identity the routes will resolve.
      const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: OWNER_SUBJECT,
        tokenDigest: sha256Digest({ ownerCode: OWNER_CODE }), issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT };
      const pipelines = new LinearPipelineServiceV1(web.pool.client, scope, KEY, SELECTION, () => Date.now());
      const template = await pipelines.createTemplate(identity, OWN_PROJECT, TEMPLATE);
      const ownRun = await pipelines.instantiate(identity, OWN_PROJECT,
        { templateId: template.templateId, title: "Owner project run" }, "consent-run-own-0001");
      // A template belongs to its project, so the second project gets its own.
      // The run id is then a genuinely foreign id inside the first project's
      // route, which is what the cross-project refusal below depends on.
      const otherTemplate = await pipelines.createTemplate(identity, OTHER_PROJECT,
        { ...TEMPLATE, name: "Other project build" });
      const otherRun = await pipelines.instantiate(identity, OTHER_PROJECT,
        { templateId: otherTemplate.templateId, title: "Other project run" }, "consent-run-other-0001")
        .catch((error: unknown) => assert.fail(`a second project's run must be creatable: ${permissionFailure(error, web.refused)}`));
      const view = await pipelines.view(identity, OWN_PROJECT, ownRun.runId);

      // ---- THE FINDING: history was 404 through exactly this route. ----
      const history = await authed(`/api/v1/projects/${encodeURIComponent(OWN_PROJECT)}`
        + `/pipeline-runs/${encodeURIComponent(ownRun.runId)}/history`);
      assert.equal(history.status, 200, `Mac-local linear-run history must answer 200: ${await history.clone().text()}`);
      const body = await history.json() as { runId: string; projectId: string; chainVerified: boolean; startsWork: boolean };
      assert.equal(body.runId, ownRun.runId);
      assert.equal(body.projectId, OWN_PROJECT);
      assert.equal(body.chainVerified, true, "the projection is only served chain-verified");
      assert.equal(body.startsWork, false, "reading history never starts work");
      assert.deepEqual(web.refused, [], "history answers with no privilege refusal on the web login");

      // ---- THE FINDING: a VALID consent POST was 400 through this route. ----
      const command = { runId: view.runId, templateId: view.templateId, policyId: "policy:consent",
        enabled: true, expectedRunVersion: view.runVersion, expectedTemplateVersion: view.templateVersion };
      const save = (key: string, payload: unknown = command, projectId = OWN_PROJECT, runId = view.runId) =>
        authed(`/api/v1/projects/${encodeURIComponent(projectId)}`
          + `/pipeline-runs/${encodeURIComponent(runId)}/unattended`,
        { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify(payload) });
      const consent = await save("mac-local-consent-0001");
      assert.equal(consent.status, 201, `Mac-local unattended consent must be accepted: ${await consent.clone().text()}`);
      const receipt = await consent.json() as { runId: string; enabled: boolean; replayed: boolean; startsWork: boolean };
      assert.deepEqual([receipt.runId, receipt.enabled, receipt.replayed, receipt.startsWork],
        [view.runId, true, false, false]);
      // The exact replay, through the same route, is ONE recorded transition.
      const replay = await save("mac-local-consent-0001");
      assert.equal(replay.status, 200, await replay.clone().text());

      // The consent is REAL: one row, in the production table, on the web login.
      const after = new Client(adminLogin); await after.connect();
      try {
        const rows = (await after.query<{ enabled: boolean; policy_id: string; owner_identity_id: string }>(
          `SELECT enabled,policy_id,owner_identity_id FROM pipeline_unattended_transitions
           WHERE tenant_id=$1 AND pipeline_run_id=$2`, [tenant.tenantId, view.runId])).rows;
        assert.equal(rows.length, 1, "one consent row, however many exact replays were sent");
        assert.deepEqual([rows[0]!.enabled, rows[0]!.policy_id, rows[0]!.owner_identity_id],
          [true, "policy:consent", "identity:consent-owner"]);
        const receipts = (await after.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pipeline_advance_receipts WHERE pipeline_run_id=$1", [view.runId])).rows;
        assert.equal(receipts[0]!.count, "0", "consent is not execution: no advance receipt exists");
      } finally { await after.end(); }

      // The run's own activation reflects the owner's consent.
      const activated = await pipelines.view(identity, OWN_PROJECT, view.runId);
      assert.equal(activated.unattended, true);
      assert.equal(activated.state, "active");

      // ---- A DIFFERENT project's run is REFUSED through the same session. ----
      // Both routes are project-scoped, so the other project's run id does not
      // resolve inside this project's route. The refusal is honest about
      // nothing being readable, but its STATUS is the service-level
      // `unattended_disabled`-family answer the history reader raises for a
      // run it cannot find (`advance_conflict` -> service_unavailable), not a
      // 404. That is pre-existing, shared verbatim with the hosted site, and is
      // recorded as a follow-up rather than changed here: making the Mac route
      // answer differently from the hosted route for one request would be two
      // answers to one question. What matters here is that the refusal leaks
      // nothing about the other project's run, which is asserted directly.
      const crossed = await authed(`/api/v1/projects/${encodeURIComponent(OWN_PROJECT)}`
        + `/pipeline-runs/${encodeURIComponent(otherRun.runId)}/history`);
      assert.ok(crossed.status >= 400, `another project's run must be refused, got ${crossed.status}`);
      assert.doesNotMatch(JSON.stringify(await crossed.clone().json()), /consent-other/,
        "a refused cross-project history read returns nothing about the other project's run");
      const crossConsent = await save("mac-local-consent-cross-0001", { ...command, runId: otherRun.runId });
      assert.ok(crossConsent.status === 404 || crossConsent.status === 400,
        `a consent for another project's run must be refused, got ${crossConsent.status}`);
      // Nothing was written on either run by the refused consent.
      const otherView = await pipelines.view(identity, OTHER_PROJECT, otherRun.runId);
      assert.equal(otherView.unattended, false, "the other project's run stays without consent");
      const stillOwn = await pipelines.view(identity, OWN_PROJECT, view.runId);
      assert.equal(stillOwn.runVersion, activated.runVersion, "a refused consent writes nothing");

      // ---- Execution stayed refused. Consent cannot start a stage. ----
      // The composed port is private to the handler closure, so this cannot call
      // its `advance()` directly. An earlier version of this test built its OWN
      // `PipelineAdvanceServiceV1(…, {}, …)` and asserted it refused -- which is
      // a tautology: `advance()` checks the capability before any database work,
      // so a test-owned capability-free service refuses for its own reasons and
      // passes even when the COMPOSITION mounts a capable one. It is replaced
      // below by a structural guard that bites on exactly that edit.
      //
      // What IS observable end to end is that no execution happened. These two
      // tables are written only by the coordinator login on a real advance, so
      // an empty pair after a recorded consent is durable evidence that consent
      // did not become work -- and it would NOT be empty if a capable port had
      // dispatched.
      const final = new Client(adminLogin); await final.connect();
      try {
        const advance = (await final.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pipeline_advance_receipts WHERE pipeline_run_id=$1",
          [view.runId])).rows;
        assert.equal(advance[0]!.count, "0",
          "consent is not execution: no advance receipt exists on the production table");
        const loopCounts = (await final.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pipeline_stage_loop_counts WHERE pipeline_run_id=$1",
          [view.runId])).rows;
        assert.equal(loopCounts[0]!.count, "0", "no loop was counted, so nothing was dispatched");
      } finally { await final.end(); }
    } finally {
      await app.close();
      await web.pool.close();
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
  ran += 1;
});

test("the Mac-local pipeline consent real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1);
  assert.equal(ran, required);
});

// The owner surface is a request-serving port, so it gets the load and the
// unhappy paths rather than a single happy call. Everything below runs on the
// SAME production web login and through the SAME composed handler.
test("the Mac-local pipeline consent port survives concurrent callers, bursts and retries",
  async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  required += 1;
  await withRealPostgres(async postgres => {
    const adminLogin = postgres.admin({ database: postgres.database });
    const admin = new Client(adminLogin);
    await admin.connect();
    const tenant = { tenantId: "tenant:consent-load", workspaceId: "workspace:consent-load" };
    try { await seedOwnerWithTwoProjects(admin, tenant); } finally { await admin.end(); }

    const web = productionWebPool(postgres);
    const scope = { tenantId: tenant.tenantId, workspaceId: tenant.workspaceId };
    const origin = `http://127.0.0.1:${await freePort()}`;
    const app = createMacLocalWebProcessV1({
      origin, workspaceId: tenant.workspaceId,
      localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: tenant.tenantId,
        provider: PROVIDER, subject: OWNER_SUBJECT,
        ownerCodeDigest: sha256Digest({ ownerCode: OWNER_CODE }), sessionSeconds: 900 },
      database: { client: web.pool.client, close: async () => {}, isAvailable: () => true },
      workBatchIntegrityKey: KEY, workBatchQueueAdmissionAuthority: SELECTION, clock: () => Date.now(),
    });
    let cookie = "";
    const call = (path: string, init: RequestInit = {}) =>
      app.handle(new Request(`${origin}${path}`, init), () => new Response("page", { status: 200 }));
    const authed = (path: string, init: RequestInit = {}) =>
      call(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), origin,
        cookie, "sec-fetch-site": "same-origin" } });

    try {
      const signedIn = await call("/api/v1/local-owner-session", { method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ ownerCode: OWNER_CODE }) });
      assert.equal(signedIn.status, 201, await signedIn.clone().text());
      cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
      const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: OWNER_SUBJECT,
        tokenDigest: sha256Digest({ ownerCode: OWNER_CODE }), issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT };
      const pipelines = new LinearPipelineServiceV1(web.pool.client, scope, KEY, SELECTION, () => Date.now());
      const template = await pipelines.createTemplate(identity, OWN_PROJECT, TEMPLATE);
      // A burst of runs, so the load below reads real distinct lineages rather
      // than the same row fifty times.
      const runs = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        pipelines.instantiate(identity, OWN_PROJECT,
          { templateId: template.templateId, title: `Load run ${index}` }, `consent-load-run-${index}`)));

      // ---- Concurrent history reads on the PRODUCTION pool.
      //
      // This is a bound, not a wish. The production web pool is `max: 8` with
      // `statement_timeout: 5000` and `transaction_timeout: 10000`
      // (private-pg-options.ts). A history read verifies the whole audit chain
      // for every partition it touches, so the wider the burst, the longer the
      // queue behind eight connections and the more likely a reader is cut off
      // by the pool's own timeout -- which reaches the owner as a 503, not as a
      // wrong answer. That is the honest shape of this port under load, and it
      // is unchanged by R6P-06 (before the fix every one of these was a 404).
      //
      // What is asserted is therefore: within the pool's designed concurrency
      // every read answers 200 with its OWN run id; beyond it, a caller is
      // refused (4xx/5xx) rather than served a wrong project's lineage, and no
      // statement is refused for a missing grant.
      const read = (runId: string) => authed(`/api/v1/projects/${encodeURIComponent(OWN_PROJECT)}`
        + `/pipeline-runs/${encodeURIComponent(runId)}/history`);
      const withinPool = await Promise.all(runs.map(run => read(run.runId)));
      const withinBodies = await Promise.all(withinPool.map(async response => {
        assert.equal(response.status, 200, await response.clone().text());
        return await response.json() as { runId: string };
      }));
      assert.deepEqual(withinBodies.map(body => body.runId), runs.map(run => run.runId),
        "eight concurrent reads each answer with their own run, never a neighbour's");

      const burst = await Promise.all(runs.flatMap(run =>
        Array.from({ length: 7 }, () => read(run.runId))));
      assert.equal(burst.length, 56, "the burst is the size it claims to be");
      const burstResults = await Promise.all(burst.map(async response => ({
        status: response.status,
        runId: (await response.clone().json() as { runId?: string }).runId })));
      const served = burstResults.filter(result => result.status === 200);
      assert.ok(served.length > 0, "the burst serves at least its first wave");
      assert.ok(served.length >= 8,
        `at least one full pool wave of ${served.length} is served, so the port does not simply fail under load`);
      // A 200 never carries the wrong run's lineage.
      for (const result of served)
        assert.ok(runs.some(run => run.runId === result.runId),
          `a served history read returned ${String(result.runId)}, which is not a run in this request`);
      // Everything refused is a refusal, never a wrong answer. The owner page
      // already states an unavailable history rather than inventing one.
      for (const result of burstResults.filter(result => result.status !== 200))
        assert.equal(result.runId, undefined,
          `a refused history read (${result.status}) must not carry any lineage at all`);

      // ---- A concurrent burst of the SAME idempotency key: one consent row.
      // This is the exact race an owner double-click or a retried POST makes,
      // and it must not produce a second transition or a 500.
      const consentPath = `/api/v1/projects/${encodeURIComponent(OWN_PROJECT)}`
        + `/pipeline-runs/${encodeURIComponent(runs[0]!.runId)}/unattended`;
      const burstKey = "consent-load-burst-0001";
      const consentCommand = () => {
        const view = pipelines.view(identity, OWN_PROJECT, runs[0]!.runId);
        return view.then(current => authed(consentPath, { method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": burstKey },
          body: JSON.stringify({ runId: current.runId, templateId: current.templateId,
            policyId: "policy:consent", enabled: true, expectedRunVersion: current.runVersion,
            expectedTemplateVersion: current.templateVersion }) }));
      };
      const consentBurst = await Promise.all(Array.from({ length: 10 }, consentCommand));
      const burstStatuses = consentBurst.map(response => response.status).sort((a, b) => a - b);
      // Exactly one created it; every other caller either replayed the same
      // receipt or was refused a conflict because the run moved on under it.
      // None may be a 5xx, and none may be a 400 (a 400 is the pre-fix defect).
      assert.equal(burstStatuses.filter(status => status === 201).length, 1,
        `exactly one caller creates the consent: ${JSON.stringify(burstStatuses)}`);
      assert.equal(burstStatuses.filter(status => status >= 500).length, 0,
        "a concurrent consent burst never reports a service failure");
      assert.equal(burstStatuses.filter(status => status === 400).length, 0,
        "a concurrent consent burst never reports the pre-fix invalid_request");

      const after = new Client(adminLogin); await after.connect();
      try {
        const rows = (await after.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pipeline_unattended_transitions
           WHERE tenant_id=$1 AND pipeline_run_id=$2`, [tenant.tenantId, runs[0]!.runId])).rows;
        assert.equal(rows[0]!.count, "1", "ten concurrent identical consents are ONE durable transition");
      } finally { await after.end(); }

      // ---- A retry after a refused consent. A stale expectedRunVersion is a
      // 409, and retrying it with the CURRENT version succeeds: the refusal
      // left no state that would poison the retry.
      const fresh = await pipelines.view(identity, OWN_PROJECT, runs[1]!.runId);
      const path = `/api/v1/projects/${encodeURIComponent(OWN_PROJECT)}`
        + `/pipeline-runs/${encodeURIComponent(fresh.runId)}/unattended`;
      const stale = await authed(path, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "consent-load-stale-0001" },
        body: JSON.stringify({ runId: fresh.runId, templateId: fresh.templateId, policyId: "policy:consent",
          enabled: true, expectedRunVersion: fresh.runVersion + 5, expectedTemplateVersion: fresh.templateVersion }) });
      assert.equal(stale.status, 409, `a stale version is a conflict, not a service failure: ${await stale.clone().text()}`);
      const retried = await authed(path, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "consent-load-retry-0001" },
        body: JSON.stringify({ runId: fresh.runId, templateId: fresh.templateId, policyId: "policy:consent",
          enabled: true, expectedRunVersion: fresh.runVersion, expectedTemplateVersion: fresh.templateVersion }) });
      assert.equal(retried.status, 201, `the retry with the current version is accepted: ${await retried.clone().text()}`);

      // ---- Bad input, refused before the database. Malformed JSON, a missing
      // policy, a short idempotency key, and a body that names a different run
      // than the route.
      const malformed = await authed(consentPath, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "consent-load-bad-0001" },
        body: "{not json" });
      assert.equal(malformed.status, 400);
      const shortKey = await authed(consentPath, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "short" },
        body: JSON.stringify({ runId: runs[0]!.runId, templateId: template.templateId, policyId: "policy:consent",
          enabled: true, expectedRunVersion: 1, expectedTemplateVersion: 1 }) });
      assert.equal(shortKey.status, 400, "a short idempotency key is refused");
      const mismatched = await authed(consentPath, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "consent-load-mismatch-0001" },
        body: JSON.stringify({ runId: runs[7]!.runId, templateId: template.templateId, policyId: "policy:consent",
          enabled: true, expectedRunVersion: 1, expectedTemplateVersion: 1 }) });
      assert.ok(mismatched.status === 400 || mismatched.status === 404,
        `a body naming another run than the route is refused, got ${mismatched.status}`);
      const noPolicy = await authed(path, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "consent-load-nopolicy-0001" },
        body: JSON.stringify({ runId: runs[1]!.runId, templateId: fresh.templateId, policyId: "policy:absent",
          enabled: false, expectedRunVersion: fresh.runVersion + 1, expectedTemplateVersion: fresh.templateVersion }) });
      // A missing policy is refused by the service's own `policy_inactive`
      // refusal, which is NOT a WebAccessError, so `webFailure` reports it as
      // `service_unavailable`. That is pre-existing and identical on the hosted
      // site, and this change did not touch it: it is asserted as a refusal
      // that writes nothing rather than as a specific status, and the status is
      // pinned so a future change to it is a deliberate one.
      assert.equal(noPolicy.status, 503,
        "an absent delegation policy is the service's own refusal, not a validation error");
      const afterNoPolicy = await pipelines.view(identity, OWN_PROJECT, runs[1]!.runId);
      assert.equal(afterNoPolicy.unattended, true,
        "the refusal above was for the OTHER run's route; this one already holds its own consent");
      const unwritten = (await (async () => {
        const check = new Client(adminLogin); await check.connect();
        try {
          return (await check.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pipeline_unattended_transitions
             WHERE tenant_id=$1 AND idempotency_key=$2`,
            [tenant.tenantId, "consent-load-nopolicy-0001"])).rows[0]!.count;
        } finally { await check.end(); }
      })());
      assert.equal(unwritten, "0", "a refused consent writes no transition row");

      // An UNAUTHENTICATED caller, and one carrying a foreign session.
      const anonymous = await call(`/api/v1/projects/${encodeURIComponent(OWN_PROJECT)}`
        + `/pipeline-runs/${encodeURIComponent(runs[0]!.runId)}/history`, { headers: { origin } });
      assert.equal(anonymous.status, 401, "history requires the owner session");
      const forged = await call(`/api/v1/projects/${encodeURIComponent(OWN_PROJECT)}`
        + `/pipeline-runs/${encodeURIComponent(runs[0]!.runId)}/history`,
      { headers: { origin, cookie: "control_room_local_owner=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
      assert.equal(forged.status, 401, "a forged local cookie is refused");

      assert.deepEqual(web.refused, [],
        "not one statement in the load run was refused for a missing grant");
    } finally {
      await app.close();
      await web.pool.close();
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });
  ran += 1;
});

test("both Mac-local pipeline consent real-PostgreSQL proofs ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 2);
  assert.equal(ran, required);
});