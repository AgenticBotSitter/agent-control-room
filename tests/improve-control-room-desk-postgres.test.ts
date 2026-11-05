// Real-PostgreSQL proof for migration 0160 and its production-role boundaries.
// The owner-facing web operations run as control_room_private_web; candidate
// publication runs as control_room_task_coordinator. Neither login owns schema
// objects or receives deployment/service/database effect authority.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import { readDesiredMacGrantsV1, desiredMacGrantsV1, readMacGrantCatalogV1,
  diffMacGrantsV1, applyMacGrantDiffV1 } from "../scripts/mac-local/database-upgrade-grants.mjs";
import { digestReleaseSchemaRowsV1 } from "../src/updater/v1/pg/release-schema-digest.mjs";
import { createInjectedPrivateFixturePreparation, fixtureMigratorScopeDigest } from "../src/web/v1/private-fixture-preparation";
import { rehearsalScopeDigest } from "../src/web/v1/private-database-rehearsal";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1,
  type LoopImprovementContractV1 } from "../src/improve-control-room/v1/schemas";
import { Client, Pool } from "pg";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { readPrivateWebSchemaDigest, privateWebSchemaDigest, verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

// CONTROL_ROOM_PG_TEST_PORT_BASE moves the disposable cluster, as in linear-pipeline-postgres.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58350), PG = requiresRealPostgres(), KEY = new Uint8Array(32).fill(65);
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };
const scope = { tenantId: "tenant:improve-pg", workspaceId: "workspace:improve-pg" };
const ids = { adapter: "adapter:improve-pg", project: "project:improve-pg", identity: "identity:improve-pg",
  grant: "grant:improve-pg", token: sha256Digest({ session: "improve-pg" }),
  operator: "identity:improve-pg-operator", operatorGrant: "grant:improve-pg-operator",
  operatorToken: sha256Digest({ session: "improve-pg-operator" }) };
const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const identity: VerifiedWebIdentity = { provider: "test", subject: ids.identity, tokenDigest: ids.token,
  issuedAt, expiresAt, verificationExpiresAt: expiresAt };
const operator: VerifiedWebIdentity = { provider: "test", subject: ids.operator, tokenDigest: ids.operatorToken,
  issuedAt, expiresAt, verificationExpiresAt: expiresAt };
const DIGEST = `sha256:${"f".repeat(64)}`, TAG = `hmac-sha256:${"f".repeat(64)}`;
const CANDIDATE_REVISION = "b".repeat(40);
const PASSED_RESULT = { profile: "db" as const, profileVersion: 1, profileDigest: `sha256:${"1".repeat(64)}`,
  commandIds: ["test.postgres"], candidateRevision: CANDIDATE_REVISION, status: "passed" as const,
  summary: "Real PostgreSQL role path passed.", evidenceDigest: `sha256:${"c".repeat(64)}`, testCount: 2,
  durationMs: 100, workerId: "service:test-runner", runner: { kind: "local_test_runner" as const,
    serviceId: "runner:local-postgres" }, observedAt: new Date().toISOString() };
const notUsed = { instantiate: async () => { throw new Error("not_used"); } } as never;
const candidateInput = (request: { requestId: string; pipelineRunId: string }) => ({ projectId: ids.project,
  improvementRequestId: request.requestId, pipelineRunId: request.pipelineRunId, baseRevision: "a".repeat(40),
  candidateRevision: CANDIDATE_REVISION, summary: "Production-role candidate.", changedAreas: ["desk"],
  testResults: [PASSED_RESULT],
  databaseChanges: { kind: "migrations" as const, migrationIds: ["0160_improve_control_room_desk"], summary: "Desk records.",
    compatibilityNotes: "Run the ledger.", rollbackNotes: "Use the reviewed restore plan." },
  riskFlags: [{ kind: "database" as const, summary: "database changed", needsIndependentReview: true as const }],
  independentReviews: [{ reviewId: "review:postgres", reviewDigest: `sha256:${"2".repeat(64)}`,
    reviewerWorkerId: "worker:check" }],
  leadWorkerId: "worker:lead" });
/** A direct candidate INSERT, bypassing the service, as a given login. */
const forgeCandidate = (request: { requestId: string; pipelineRunId: string }, id: string, state: string, decidedAt: string | null,
  testResults: unknown = [PASSED_RESULT], riskFlags: unknown = [], independentReviews: unknown = []) => [
  `INSERT INTO control_update_candidates(tenant_id,id,project_id,improvement_request_id,pipeline_run_id,base_revision,
    candidate_revision,summary,changed_areas,test_results,database_changes,risk_flags,independent_reviews,lead_worker_id,state,
    version,record_digest,auth_tag,created_at,decided_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'forged','["x"]',$8::jsonb,'{"kind":"none"}',$9::jsonb,$10::jsonb,
      'worker:lead',$11,1,$12,$13,now(),$14)`,
  [scope.tenantId, id, ids.project, request.requestId, request.pipelineRunId, "a".repeat(40), "b".repeat(40),
    JSON.stringify(testResults), JSON.stringify(riskFlags), JSON.stringify(independentReviews), state, DIGEST, TAG, decidedAt]] as [string, unknown[]];
const forgeDecision = (candidateId: string, version: number, recordDigest: string, owner: string, key: string) => [
  `INSERT INTO control_update_candidate_decisions(tenant_id,id,candidate_id,project_id,candidate_version,
    candidate_record_digest,decision,owner_identity_id,idempotency_key,decision_digest,auth_tag,decided_at)
    VALUES($1,$2,$3,$4,$5,$6,'accept',$7,$8,$9,$10,now())`,
  [scope.tenantId, `update-decision:${key}`, candidateId, ids.project, version, recordDigest, owner, key, DIGEST, TAG]] as [string, unknown[]];
const template = { name: "Improve and check", description: "Build, independently check and sign off.", stages: [
  { ordinal: 0, stageKind: "build", role: "builder", description: "Build.", requiredCapability: "code.change",
    workerId: "worker:build", workerKind: "codex", nodeId: "node:build", selectionKey: "build.standard",
    model: "build-model", effort: "high", maxLoops: 2, allowedPaths: ["src/**"], maximumChangedFiles: 20,
    maximumChangedBytes: 200000 },
  { ordinal: 1, stageKind: "check", role: "checker", description: "Check.", requiredCapability: "code.review",
    workerId: "worker:check", workerKind: "claude-code", nodeId: "node:check", selectionKey: "check.standard",
    model: "check-model", effort: "high", maxLoops: 2 },
  { ordinal: 2, stageKind: "signoff", role: "validator", description: "Sign off.", requiredCapability: "code.validate",
    workerId: "worker:lead", workerKind: "hermes", nodeId: "node:lead", selectionKey: "lead.standard",
    model: "lead-model", effort: "high", provider: "provider:test", profile: "profile:test", maxLoops: 0 },
], maxTotalLoops: 4, maxDurationSeconds: 3600 } as const;

function pool(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0], role: "web" | "coordinator") {
  const login = postgres.connection(role);
  // The endpoint policy admits only the canonical loopback literal; the pool then
  // dials the harness's private socket, as linear-pipeline-postgres does.
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: login.user,
    password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  // Record the statement a refusal came from, so a failure names it.
  const traced = (session: DatabaseSession): DatabaseSession => ({ query: async (sql, params) => {
    await barrier?.arrive(sql);
    try { return await session.query(sql, params); }
    catch (error) { refused.push(`${String((error as { sqlState?: unknown }).sqlState)} ${sql.replace(/\s+/g, " ").trim()}`); throw error; }
  } });
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  return { client, config, close: () => bound.close() };
}
const refused: string[] = [];
/** Holds two callers at the same INSERT so both have already missed the replay read:
 * the race a double-click or a double publication really produces. */
let barrier: { arrive(sql: string): Promise<void> } | undefined;
function holdTwoAt(statement: RegExp) {
  let waiting = 0, open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  barrier = { async arrive(sql) {
    if (!statement.test(sql)) return;
    if (++waiting >= 2) { barrier = undefined; open(); }
    await Promise.race([opened, new Promise(resolve => setTimeout(resolve, 5_000))]);
  } };
}

test("production web and coordinator roles complete the inert desk lifecycle and refuse every forged path", async t => {
  const skip = needsPg(); if (skip) { t.skip(skip.skip); return; } ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
      await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
        redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,
      [ids.adapter, scope.tenantId]);
      await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
        normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        VALUES($1,$2,$3,$4,$1,'1','Control Room','planned','manual_project_active','healthy','control_room_native',now(),
        '{"presentation":{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}}',now())`,
      [ids.project, scope.tenantId, scope.workspaceId, ids.adapter]);
      await admin.query("INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())",
        [scope.tenantId, ids.project]);
      for (const [identityId, grantId, token, role, name] of [[ids.identity, ids.grant, ids.token, "owner", "Owner"],
        [ids.operator, ids.operatorGrant, ids.operatorToken, "operator", "Operator"]] as const) {
        await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
          auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human',$3,'test',$4,'active',$5,$5)`,
        [identityId, scope.tenantId, name, sha256Digest({ provider: "test", subject: identityId }), issuedAt]);
        await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
          risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
          VALUES($1,$2,$3,$4,'["*"]','["*"]','critical',true,false,$5,$5)`, [grantId, scope.tenantId, identityId, role, issuedAt]);
        await admin.query("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
          [scope.tenantId, token, identityId, issuedAt, expiresAt]);
      }
    } finally { await admin.end(); }

    const web = pool(postgres, "web");
    let request!: Awaited<ReturnType<ImproveControlRoomDeskServiceV1["create"]>>["request"];
    let unsigned!: typeof request;
    try {
      // The web startup preflight checks the live grant inventory and schema digest, 0160 included.
      await verifyPrivateDatabase(web.client, web.config, { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        ownerIdentityId: ids.identity, issuer: "test" }, Date.now(), { nativeQueue: true });
      const pipelines = new LinearPipelineServiceV1(web.client, scope, KEY,
        { assertCurrent: () => true, isAcceptedResultCurrent: () => false });
      const saved = await pipelines.createTemplate(identity, ids.project, template);
      const desk = new ImproveControlRoomDeskServiceV1(web.client, scope, KEY, pipelines);
      const draft = { description: "Exercise the production-role desk path.", pipelineTemplateId: saved.templateId,
        selectedWorkerIds: ["worker:build", "worker:check"], leadWorkerId: "worker:lead" };
      // A double-submitted form: one request, one pipeline run, the second caller replays the first.
      // (Web writes lock the owner's identity row, so these two serialize; no barrier here.)
      const [first, second] = await Promise.all([desk.create(identity, ids.project, draft, "improve-postgres-request-0001"),
        desk.create(identity, ids.project, draft, "improve-postgres-request-0001")]);
      request = first.request;
      assert.equal(second.request.requestId, first.request.requestId);
      assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
      assert.equal(request.startsWork, false);
      unsigned = (await desk.create(identity, ids.project, { ...draft, description: "Never signed off." },
        "improve-postgres-request-0002")).request;
    } finally { await web.close(); }
    const asAdmin = async (sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.admin({ database: postgres.database })); await client.connect();
      try { return await client.query(sql, params); } finally { await client.end(); }
    };
    const count = async (table: string) => Number((await asAdmin(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
    assert.equal(await count("control_improvement_requests"), 2);
    assert.equal(await count("pipeline_runs"), 2);

    const coordinator = pool(postgres, "coordinator");
    let candidate!: Awaited<ReturnType<ImproveControlRoomDeskServiceV1["recordCandidate"]>>["candidate"];
    try {
      const publisher = new ImproveControlRoomDeskServiceV1(coordinator.client, scope, KEY, notUsed);
      await assert.rejects(publisher.recordCandidate(candidateInput(request)), /update_candidate_not_ready/u,
        "no candidate before the pipeline and its sign-off succeed");
      await asAdmin("UPDATE pipeline_runs SET state='succeeded' WHERE id=$1", [request.pipelineRunId]);
      await asAdmin("UPDATE pipeline_stage_runs SET state='succeeded' WHERE pipeline_run_id=$1 AND stage_kind='signoff'",
        [request.pipelineRunId]);
      await assert.rejects(postgres.query("coordinator", ...forgeCandidate(request, "update-candidate:failed-tests", "ready", null,
        [{ ...PASSED_RESULT, status: "failed" }])), /tests have not passed/u,
      "the database refuses a ready candidate whose recorded profile failed");
      await assert.rejects(postgres.query("coordinator", ...forgeCandidate(request, "update-candidate:missing-test-evidence", "ready", null,
        [{}])), /tests have not passed/u, "SQL NULLs cannot bypass the required test evidence");
      await assert.rejects(postgres.query("coordinator", ...forgeCandidate(request, "update-candidate:missing-review", "ready", null,
        [PASSED_RESULT], [{ kind: "security", summary: "security changed", needsIndependentReview: true }], [])),
      /needs independent review/u, "the database refuses a risk flag without review evidence");
      // A double publication: one candidate, the loser replays it.
      holdTwoAt(/INSERT INTO control_update_candidates/u);
      const [a, b] = await Promise.all([publisher.recordCandidate(candidateInput(request)),
        publisher.recordCandidate(candidateInput(request))]);
      assert.equal(a.candidate.candidateId, b.candidate.candidateId);
      assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
      candidate = a.candidate;
    } finally { await coordinator.close(); }
    assert.equal(await count("control_update_candidates"), 1);

    // The coordinator (the only candidate publisher) cannot mint an accepted update, cannot
    // publish for a run that was never signed off, and cannot decide or change a candidate.
    await assert.rejects(postgres.query("coordinator", ...forgeCandidate(unsigned, "update-candidate:forged-accepted", "accepted",
      new Date().toISOString())), /must be published ready/u);
    await assert.rejects(postgres.query("coordinator", ...forgeCandidate(unsigned, "update-candidate:forged-unsigned", "ready", null)),
      /no signed-off pipeline/u);
    await assert.rejects(postgres.query("coordinator", ...forgeDecision(candidate.candidateId, 1, candidate.recordDigest,
      ids.identity, "forged-coordinator-decision")), /permission denied/u);
    await assert.rejects(postgres.query("coordinator",
      "UPDATE control_update_candidates SET state='accepted',version=2,decided_at=now()"), /permission denied/u);
    // The web login cannot publish, cannot skip the decision row, cannot edit evidence,
    // and cannot record a decision for a non-owner or for a stale candidate version.
    await assert.rejects(postgres.query("web", ...forgeCandidate(unsigned, "update-candidate:forged-web", "ready", null)),
      /permission denied/u);
    await assert.rejects(postgres.query("web", "UPDATE control_update_candidates SET state='accepted',version=version+1,decided_at=now()"),
      /no owner decision/u);
    await assert.rejects(postgres.query("web", "UPDATE control_update_candidates SET summary='edited'"), /permission denied/u);
    await assert.rejects(postgres.query("web", ...forgeDecision(candidate.candidateId, 1, candidate.recordDigest,
      ids.operator, "forged-operator-decision")), /needs the owner/u);
    await assert.rejects(postgres.query("web", ...forgeDecision(candidate.candidateId, 2, candidate.recordDigest,
      ids.identity, "forged-stale-decision")), /is stale/u);
    assert.equal(await count("control_update_candidate_decisions"), 0);
    assert.equal((await asAdmin("SELECT state FROM control_update_candidates")).rows[0]!.state, "ready");

    const webDecision = pool(postgres, "web");
    try {
      const desk = new ImproveControlRoomDeskServiceV1(webDecision.client, scope, KEY, notUsed);
      assert.equal((await desk.ready(identity)).candidates.length, 1);
      const decision = (value: "accept" | "decline") => ({ candidateId: candidate.candidateId, expectedVersion: 1,
        candidateRecordDigest: candidate.recordDigest, decision: value });
      await assert.rejects(desk.decide(operator, decision("accept"), "improve-postgres-operator-0001"), /access_denied/u,
        "an operator grant, even with every action, is not the owner");
      await assert.rejects(desk.decide(identity, { ...decision("accept"), expectedVersion: 2 }, "improve-postgres-stale-0001"),
        /conflict/u, "a decision for a version the owner never saw is refused");
      await assert.rejects(desk.decide(identity, { ...decision("accept"), candidateRecordDigest: DIGEST },
        "improve-postgres-stale-0002"), /conflict/u, "a decision for evidence the owner never saw is refused");
      // Accept and Decline pressed in two tabs: exactly one owner decision lands.
      const raced = await Promise.allSettled([desk.decide(identity, decision("accept"), "improve-postgres-decision-0001"),
        desk.decide(identity, decision("decline"), "improve-postgres-decision-0002")]);
      const won = raced.filter(value => value.status === "fulfilled");
      assert.equal(won.length, 1, JSON.stringify(raced.map(value => value.status === "rejected" ? String(value.reason) : "ok")));
      const receipt = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof desk.decide>>>).value;
      assert.equal(receipt.startsDeploy, false); assert.equal(receipt.signedDeployApprovalCreated, false);
      assert.equal(receipt.grantsDeployAuthority, false);
      const row = (await asAdmin("SELECT state,version FROM control_update_candidates")).rows[0]!;
      assert.deepEqual({ state: row.state, version: Number(row.version) },
        { state: receipt.decision === "accept" ? "accepted" : "declined", version: 2 });
      assert.equal((await desk.ready(identity)).candidates.length, 0);
      // A retry of the winning request replays; a fresh request on the decided candidate is refused.
      const winnerKey = receipt.decision === "accept" ? "improve-postgres-decision-0001" : "improve-postgres-decision-0002";
      assert.equal((await desk.decide(identity, decision(receipt.decision), winnerKey)).replayed, true);
      await assert.rejects(desk.decide(identity, decision("accept"), "improve-postgres-decision-0003"), /conflict/u);
    } finally { await webDecision.close(); }
    assert.equal(await count("control_update_candidate_decisions"), 1);
    // Owner decisions and requests are append only, even to the login that writes them.
    await assert.rejects(postgres.query("web", "DELETE FROM control_update_candidate_decisions"), /permission denied/u);
    await assert.rejects(postgres.query("web", "UPDATE control_improvement_requests SET description='edited'"), /permission denied/u);
    await assert.rejects(asAdmin("UPDATE control_update_candidate_decisions SET decision='decline'"), /append/u);
    await assert.rejects(asAdmin("UPDATE control_update_candidates SET state='ready',version=3,decided_at=NULL"),
      /transition rejected/u);

    for (const role of ["app", "scheduler", "intake", "news", "results", "publisher", "queueWorker"]) {
      for (const table of ["control_update_candidates", "control_update_candidate_decisions", "control_improvement_requests"]) {
        await assert.rejects(postgres.query(role, `SELECT 1 FROM ${table} LIMIT 1`), /permission denied/u, `${role} reads ${table}`);
      }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 150_000 }).catch(error => {
    throw new Error(`${String(error)} refused: ${refused.at(-1) ?? "none"}`, { cause: error });
  });
});

test("the desk real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1); assert.equal(ran, required);
});

// B1a uses only explicit SYNTHETIC A2 observations until reviewed A2 captures land.
const LOOP_TABLES = ["control_loop_improvement_requests", "control_loop_improvement_inputs",
  "control_loop_improvement_run_links", "control_loop_improvement_authorizations"] as const;
const LOOP_PIN = `sha256:${"7".repeat(64)}`;
const rawHash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const LOOP_CONTRACT: LoopImprovementContractV1 = {
  toolingRevision: LOOP_PIN,
  decodeRunIdentity: input => { const run = loopImprovementRunIdentitySchemaV1.parse(input);
    assert.match(run.loopRunId, /^synthetic-run-[0-9]+$/u); assert.equal(run.adapterId, "synthetic-adapter"); return run; },
  decodeObservation: input => { const observed = loopImprovementObservationSchemaV1.parse(input);
    assert.equal(typeof observed.inputVersion, "string"); assert.match(String(observed.inputVersion), /^SYNTHETIC:[0-9]+$/u);
    assert.equal(typeof observed.confirmation.input_version, "string"); return observed; },
  matchesSavedInput: (run, observation, input) => observation.settingsDigest === `synthetic-sha256:${rawHash(input.settingsText)}`
    && observation.confirmation.path === `work/docs/${run.loopRunId}.md`
    && observation.confirmation.sha256 === rawHash(input.description),
};
const LOOP_DRAFT = { description: "  Retain exact request.\n", settingsText: '{ "fixture": "SYNTHETIC" }\n' };
const loopRun = (number = 1) => ({ adapterId: "synthetic-adapter", loopRunId: `synthetic-run-${number}`,
  toolingRevision: LOOP_PIN, a2SchemaVersion: 1 as const });
const loopObservation = (draft = LOOP_DRAFT) => ({ inputVersion: "SYNTHETIC:9", revision: 12,
  settingsDigest: `synthetic-sha256:${rawHash(draft.settingsText)}`,
  confirmation: { path: "work/docs/synthetic-run-1.md", sha256: rawHash(draft.description),
    at: new Date().toISOString(), who: "owner" as const, input_version: "SYNTHETIC:9" } });
type Pg = Parameters<Parameters<typeof withRealPostgres>[0]>[0];
async function b1aSql(pg: Pg, sql: string, params: unknown[] = [], database = pg.database, role = "admin") {
  const client = new Client(role === "admin" ? pg.admin({ database }) : pg.connection(role, { database })); await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}
async function b1aSeed(pg: Pg, database = pg.database) {
  const client = new Client(pg.admin({ database })); await client.connect();
  try {
    await client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Fixture tenant')", [scope.tenantId]);
    await client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Fixture workspace')", [scope.workspaceId, scope.tenantId]);
    await client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
      redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,
    [ids.adapter, scope.tenantId]);
    await client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,$4,$1,'1','Control Room','planned','manual_project_active','healthy','control_room_native',now(),
      '{"presentation":{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}}',now())`,
    [ids.project, scope.tenantId, scope.workspaceId, ids.adapter]);
    await client.query("INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES($1,$2,'active',1,now(),now())",
      [scope.tenantId, ids.project]);
    for (const [id, grant, token, role] of [[ids.identity, ids.grant, ids.token, "owner"],
      [ids.operator, ids.operatorGrant, ids.operatorToken, "operator"]]) {
      await client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Fixture identity','test',$3,'active',$4,$4)`,
      [id, scope.tenantId, sha256Digest({ provider: "test", subject: id }), issuedAt]);
      await client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES($1,$2,$3,$4,'["*"]','["*"]','critical',true,false,$5,$5)`, [grant, scope.tenantId, id, role, issuedAt]);
      await client.query("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
        [scope.tenantId, token, id, issuedAt, expiresAt]);
    }
  } finally { await client.end(); }
}
function b1aWeb(pg: Pg, database = pg.database, trace?: (sql: string) => Promise<void>) {
  const login = pg.connection("web", { database });
  const config = { host: "127.0.0.1", port: pg.port, database, username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host, max: 1 }));
  const errors: Array<{ sql: string; sqlState: unknown }> = [];
  const traced = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    await trace?.(sql);
    try { return await tx.query<T>(sql, params); }
    catch (error) { errors.push({ sql, sqlState: (error as { sqlState?: string }).sqlState }); throw error; }
  } });
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  const desk = new ImproveControlRoomDeskServiceV1(client, scope, KEY, notUsed, Date.now, LOOP_CONTRACT);
  return { ...bound, client, config, desk, errors };
}
async function b1aLinked(pg: Pg) {
  await b1aSeed(pg); const web = b1aWeb(pg);
  try {
    const saved = await web.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-save-fixture-0001");
    const linked = await web.desk.recordLoopRunLink({ projectId: ids.project, requestId: saved.request.requestId,
      initialInputVersion: 1, run: loopRun() });
    return { saved, linked, start: { requestId: saved.request.requestId, expectedVersion: 1,
      runLinkId: linked.runLink.runLinkId, requestSha256: rawHash(LOOP_DRAFT.description), settingsSha256: rawHash(LOOP_DRAFT.settingsText) } };
  } finally { await web.close(); }
}
async function b1aSnapshot(pg: Pg, database = pg.database) {
  const rows: Record<string, unknown> = {};
  for (const table of LOOP_TABLES) rows[table] = (await b1aSql(pg, `SELECT * FROM ${table} ORDER BY created_at,record_digest`, [], database)).rows;
  return JSON.stringify(rows);
}
async function b1aRun(work: (pg: Pg) => Promise<void>, database = "b1a_lineage") {
  assert.ok(PG, "B1a deciding PostgreSQL cases require PostgreSQL17; never skip");
  const result = await withRealPostgres(work, { port: PORT, allowedPorts: Array.from({ length: 10 }, (_, i) => PORT + i), database, boundMs: 500_000 });
  assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []);
  console.log("B1a teardown cleanedUp=true leftovers=0");
}

test("B1a fresh: shipped migrations, exact production preflight and inert signed operations", async () => b1aRun(async pg => {
  const f = await b1aLinked(pg), web = b1aWeb(pg);
  try {
    assert.deepEqual((await web.client.query("SELECT current_user,session_user")).rows,
      [{ current_user: "control_room_web", session_user: "control_room_web" }]);
    const roles = await b1aSql(pg, "SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY 1,2");
    await verifyPrivateDatabase(web.client, web.config, { ...scope, ownerIdentityId: ids.identity, issuer: "test" }, Date.now(), { nativeQueue: true });
    const digest = await readPrivateWebSchemaDigest(web.client);
    assert.equal(digest, privateWebSchemaDigest, "restricted web schema digest pin");
    const updaterSql = await readFile("src/updater/v1/pg/release-schema-digest.sql", "utf8");
    assert.equal(digestReleaseSchemaRowsV1((await web.client.query(updaterSql)).rows), digest, "shipped updater digest equality");
    assert.equal(JSON.parse(await readFile("src/updater/v1/policy/release-schema-digest.json", "utf8")).digest, digest);
    const schemaVersion = (await web.client.query("SELECT a2_schema_version, pg_typeof(a2_schema_version)::text AS type FROM control_loop_improvement_run_links")).rows[0];
    assert.deepEqual(schemaVersion, { a2_schema_version: "1", type: "bigint" }, "native PostgreSQL bigint representation");
    assert.equal((await web.desk.viewLoopDesk(identity, ids.project)).loopRequests[0]!.runLink!.a2SchemaVersion, 1,
      "B1a bigint schema version projects as a number");
    assert.deepEqual(await web.desk.recordLoopRunLink({ projectId: ids.project, requestId: f.saved.request.requestId,
      initialInputVersion: 1, run: loopRun() }), { runLink: f.linked.runLink, replayed: true }, "bigint run link exact replay");
    assert.equal((await b1aSql(pg, "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].n, 254);
    const observed = loopObservation();
    await web.desk.authorizeLoopStart(identity, ids.project, f.start, "b1a-fresh-start-0001", observed);
    assert.equal((await web.desk.authorizeLoopStart(identity, ids.project, f.start, "b1a-fresh-start-0001", observed)).replayed, true);
    const view = await web.desk.viewLoopDesk(identity, ids.project);
    assert.equal(view.loopRequests[0]!.savedAuthorization, true); assert.equal(view.loopRequests[0]!.startsWork, false);
    assert.equal(view.loopRequests[0]!.requestSha256, rawHash(LOOP_DRAFT.description));
    for (const table of ["pipeline_runs", "work_items", "control_native_task_queue"])
      assert.equal((await b1aSql(pg, `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    assert.deepEqual((await b1aSql(pg, "SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY 1,2")).rows, roles.rows);
    console.log(`B1a fresh web_digest=${digest} updater_equal=true public_count=254`);
  } finally { await web.close(); }
}));

/** INSERT a structural but unsigned row: SQL guards are independent of service HMAC. */
async function directLoopInsert(pg: Pg, table: typeof LOOP_TABLES[number], row: Record<string, unknown>, role = "web") {
  const columns = Object.keys(row), values = Object.entries(row).map(([name, value]) =>
    ["a2_input_version", "confirmation"].includes(name) ? JSON.stringify(value) : value);
  return b1aSql(pg, `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map((name, i) =>
    `$${i + 1}${["a2_input_version", "confirmation"].includes(name) ? "::jsonb" : ""}`).join(",")})`, values, pg.database, role);
}
function forgedAuthorization(f: Awaited<ReturnType<typeof b1aLinked>>) {
  const observation = loopObservation();
  return { tenant_id: scope.tenantId, id: "loop-authorization:forged", request_id: f.start.requestId, input_version: 1,
    project_id: ids.project, owner_identity_id: ids.identity, run_link_id: f.start.runLinkId, start_key: "b1a-forged-start-0001",
    request_sha256: f.start.requestSha256, settings_sha256: f.start.settingsSha256, a2_input_version: observation.inputVersion,
    a2_settings_digest: observation.settingsDigest, observed_revision: observation.revision, confirmation: observation.confirmation,
    created_at: issuedAt, record_digest: DIGEST, auth_tag: TAG };
}

test("B1a SQL authorization current guard", async () => b1aRun(async pg => {
  const f = await b1aLinked(pg), web = b1aWeb(pg);
  try { await web.desk.reviseLoopDraft(identity, ids.project, { requestId: f.start.requestId, expectedVersion: 1,
    ...LOOP_DRAFT, description: "New current bytes." }, "b1a-sql-current-edit-0001"); } finally { await web.close(); }
  await assert.rejects(directLoopInsert(pg, LOOP_TABLES[3], forgedAuthorization(f)), /loop authorization current binding rejected/u,
    "B1a SQL stale authorization refusal");
  assert.equal((await b1aSql(pg, "SELECT count(*)::int AS n FROM control_loop_improvement_authorizations")).rows[0].n, 0);
}));

test("B1a SQL authorization hash guard", async () => b1aRun(async pg => {
  const f = await b1aLinked(pg);
  await assert.rejects(directLoopInsert(pg, LOOP_TABLES[3], { ...forgedAuthorization(f), settings_sha256: "0".repeat(64) }),
    /loop authorization current binding rejected/u, "B1a SQL authorization hash refusal");
}));

test("B1a SQL authorization confirmation guard", async () => b1aRun(async pg => {
  const f = await b1aLinked(pg);
  await assert.rejects(directLoopInsert(pg, LOOP_TABLES[3], { ...forgedAuthorization(f), a2_input_version: 9 }),
    /loop authorization current binding rejected/u, "B1a SQL authorization confirmation scalar refusal");
}));

test("B1a SQL owner grant guard", async () => b1aRun(async pg => {
  const f = await b1aLinked(pg);
  // Backdating created_at cannot resurrect a grant expired at statement time.
  await b1aSql(pg, "UPDATE control_role_grants SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1", [ids.grant]);
  await assert.rejects(directLoopInsert(pg, LOOP_TABLES[3], forgedAuthorization(f)), /loop authorization needs current owner grant/u,
    "B1a SQL current owner grant refusal");
}));

test("B1a run exclusivity guard", async () => b1aRun(async pg => {
  await b1aLinked(pg); const web = b1aWeb(pg);
  try {
    const other = await web.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-other-root-0001");
    await assert.rejects(web.desk.recordLoopRunLink({ projectId: ids.project, requestId: other.request.requestId,
      initialInputVersion: 1, run: loopRun() }), { sqlState: "23505" }, "B1a unique external run refusal");
    assert.equal((await b1aSql(pg, "SELECT count(*)::int AS n FROM control_loop_improvement_run_links")).rows[0].n, 1);
  } finally { await web.close(); }
}));

for (const table of LOOP_TABLES) for (const operation of ["UPDATE", "DELETE", "TRUNCATE"] as const) {
  test(`B1a SQL append-only ${table} ${operation}`, async () => b1aRun(async pg => {
    await b1aSeed(pg); const web = b1aWeb(pg);
    try {
      const saved = await web.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-append-save-0001");
      if (table === LOOP_TABLES[0] && operation === "DELETE")
        await b1aSql(pg, "ALTER TABLE control_loop_improvement_inputs DISABLE TRIGGER USER; DELETE FROM control_loop_improvement_inputs; ALTER TABLE control_loop_improvement_inputs ENABLE TRIGGER USER");
      if (table === LOOP_TABLES[2] || table === LOOP_TABLES[3]) {
        const linked = await web.desk.recordLoopRunLink({ projectId: ids.project, requestId: saved.request.requestId,
          initialInputVersion: 1, run: loopRun() });
        if (table === LOOP_TABLES[3]) await web.desk.authorizeLoopStart(identity, ids.project,
          { requestId: saved.request.requestId, expectedVersion: 1, runLinkId: linked.runLink.runLinkId,
            requestSha256: rawHash(LOOP_DRAFT.description), settingsSha256: rawHash(LOOP_DRAFT.settingsText) },
          "b1a-append-start-0001", loopObservation());
      }
    } finally { await web.close(); }
    const before = await b1aSnapshot(pg);
    // TRUNCATE includes FK children; disable only the other tables' truncate
    // triggers, so no second trigger can mask the target's refusal.
    const companions = ["control_loop_update_candidates", "control_loop_update_candidate_decisions"];
    const others = [...LOOP_TABLES.filter(name => name !== table), "control_loop_improvement_commands", ...companions];
    const truncateTrigger = (name: string) => name === "control_loop_improvement_commands" ? "control_loop_commands_append_only"
      : companions.includes(name) ? `${name}_append_only` : `${name}_no_truncate`;
    if (operation === "TRUNCATE") for (const name of others)
      await b1aSql(pg, `ALTER TABLE ${name} DISABLE TRIGGER ${truncateTrigger(name)}`);
    try {
      const sql = operation === "UPDATE" ? `UPDATE ${table} SET created_at=created_at+interval '1 second'`
        : operation === "DELETE" ? `DELETE FROM ${table}` : `TRUNCATE ${[table, ...others].join(",")}`;
      await assert.rejects(b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${sql}; COMMIT;`, [], pg.database, "migrator"), /append.only/iu,
        `B1a append-only ${table} ${operation} refusal`);
      assert.equal(await b1aSnapshot(pg), before);
    } finally {
      if (operation === "TRUNCATE") for (const name of others)
        await b1aSql(pg, `ALTER TABLE ${name} ENABLE TRIGGER ${truncateTrigger(name)}`);
    }
  }));
}

test("B1a grants: exact direct and inherited rights, missing INSERT and unrelated logins", async () => b1aRun(async pg => {
  await b1aSeed(pg); const web = b1aWeb(pg);
  await b1aSql(pg, await readFile("db/roles/agent_reviewer_roles.sql", "utf8"));
  try {
    await assert.rejects(pg.query("web", "CREATE TABLE b1a_forbidden_ddl(id text)"), /permission denied/u);
    for (const table of LOOP_TABLES) {
      for (const right of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const allowed = right === "SELECT" || right === "INSERT";
        assert.equal((await b1aSql(pg, "SELECT has_table_privilege('control_room_web',$1,$2) AS yes", [table, right])).rows[0].yes, allowed,
          `B1a effective web ${right} ${table}`);
      }
      for (const role of ["app", "scheduler", "intake", "news", "coordinator", "results", "publisher", "queueWorker", "fleet"]) {
        await assert.rejects(pg.query(role, `SELECT 1 FROM ${table} LIMIT 1`), /permission denied/u,
          `B1a unrelated ${role} read refusal ${table}`);
        await assert.rejects(pg.query(role, `INSERT INTO ${table} SELECT * FROM ${table} WHERE false`), /permission denied/u);
      }
      const direct = (await b1aSql(pg, `SELECT r.rolname AS role,a.privilege_type AS privilege,a.is_grantable AS grantable
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
        WHERE c.oid=$1::regclass AND a.grantee<>c.relowner ORDER BY 1,2`, [table])).rows;
      assert.deepEqual(direct, [{ role: "control_room_private_web", privilege: "INSERT", grantable: false },
        { role: "control_room_private_web", privilege: "SELECT", grantable: false }], `B1a exact direct ACL ${table}`);
      assert.equal((await b1aSql(pg, "SELECT has_table_privilege('control_room_agent_reviewer',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS yes", [table])).rows[0].yes, false);
      const publicAcl = await b1aSql(pg, `SELECT privilege_type FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE c.oid=$1::regclass AND a.grantee=0`, [table]);
      assert.equal(publicAcl.rows.length, 0);
      assert.equal((await b1aSql(pg, "SELECT has_table_privilege('control_room_backup',$1,'SELECT') AS yes", [table])).rows[0].yes, false,
        "B1a backup read refusal");
      for (const operation of [`UPDATE ${table} SET created_at=now()`, `DELETE FROM ${table}`, `TRUNCATE ${table}`])
        await assert.rejects(pg.query("web", operation), /permission denied/u);
    }
    await b1aSql(pg, "REVOKE INSERT ON control_loop_improvement_inputs FROM control_room_private_web");
    await assert.rejects(web.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-missing-insert-0001"),
      { sqlState: "42501" }, "B1a required INSERT refusal");
    assert.match(web.errors.at(-1)!.sql, /INSERT INTO control_loop_improvement_inputs/u);
    for (const table of LOOP_TABLES) assert.equal((await b1aSql(pg, `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    await b1aSql(pg, "GRANT INSERT ON control_loop_improvement_inputs TO control_room_private_web");
    await web.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-missing-insert-0001");
  } finally { await web.close(); }
}));

const catalogSql = `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE "C"`;
async function fixtureAuthoritySnapshot(pg: Pg, database: string) {
  const roles = (await b1aSql(pg, `SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
    FROM pg_roles ORDER BY rolname COLLATE "C"`, [], database)).rows;
  const members = (await b1aSql(pg, "SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY 1,2", [], database)).rows;
  const grants = (await b1aSql(pg, `SELECT r.rolname,c.relname,p.privilege,has_table_privilege(r.rolname,c.oid,p.privilege) AS allowed
    FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname<>'control_room_schema_migrations'
      AND r.rolname LIKE 'control_room_%' AND r.rolname NOT IN ('control_room_migrator','control_room_schema_owner')
    ORDER BY r.rolname COLLATE "C",c.relname COLLATE "C",p.privilege COLLATE "C"`, [], database)).rows;
  return JSON.stringify({ roles, members, grants });
}
test("B1a role-file failure rolls back companion grants with earlier grants", async () => b1aRun(async pg => {
  const sql = (await readFile("db/roles/private_web_roles.sql", "utf8"))
    .replace(/CREATE ROLE control_room_private_web[\s\S]*?;/u, "");
  for (const table of LOOP_TABLES) await b1aSql(pg, `REVOKE ALL ON ${table} FROM control_room_private_web`);
  const fault = "REVOKE CREATE ON SCHEMA public FROM PUBLIC;";
  assert.equal(sql.split(fault).length, 2);
  const admin = pg.admin();
  // psql continues after an error by default. Grants must share the failed
  // transaction even when the role-file client continues through COMMIT.
  const output = execFileSync(join(process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin", "psql"),
    ["-X", "--no-password", "--set", "ON_ERROR_STOP=off"], {
      input: sql.replace(fault, "SELECT 1 / 0;"), encoding: "utf8", timeout: 30000,
      env: { ...process.env, PGHOST: admin.host, PGPORT: String(admin.port), PGDATABASE: admin.database,
        PGUSER: admin.user, PGPASSWORD: admin.password }, stdio: ["pipe", "pipe", "pipe"],
    });
  assert.match(output, /ROLLBACK/u);
  for (const table of LOOP_TABLES) {
    assert.equal((await b1aSql(pg, "SELECT has_table_privilege('control_room_web',$1,'SELECT,INSERT') AS yes", [table])).rows[0].yes,
      false, `B1a failed role file leaves no companion grant on ${table}`);
  }
  await b1aSql(pg, sql);
  for (const table of LOOP_TABLES) for (const right of ["SELECT", "INSERT"]) {
    assert.equal((await b1aSql(pg, "SELECT has_table_privilege('control_room_web',$1,$2) AS yes", [table, right])).rows[0].yes, true);
  }
  console.log("B1a role-file failure_atomic=true companion_grants=0 restored_grants=SELECT,INSERT");
}));

async function prepareB1aFixture(pg: Pg, database: string) {
  const login = pg.connection("migrator", { database });
  const config = { host: "127.0.0.1", port: pg.port, database, username: login.user, password: login.password, majorVersion: 17 as const };
  const web = { host: "127.0.0.1", port: pg.port, database, username: "control_room_web", majorVersion: 17 as const };
  const statements: string[] = []; let closed = false, metadata: unknown, catalogCount: number | undefined, empty: boolean | undefined;
  let digestReads = 0;
  const current = Date.now(), hash = "a".repeat(64), manifest = { commit: "b".repeat(40), tree: "c".repeat(40), artifactDigest: hash };
  const version = Number((await b1aSql(pg, "SHOW server_version_num", [], database)).rows[0].server_version_num);
  const prep = createInjectedPrivateFixturePreparation({ clock: () => current, monotonic: () => 0, openDatabase: () => {
    const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host, max: 1 }));
    const traced = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
      statements.push(sql); const result = await tx.query<T>(sql, params);
      if (sql.includes("SELECT current_user=session_user")) metadata = (result.rows[0] as { valid: boolean }).valid;
      if (sql.includes("SELECT c.relname AS name")) catalogCount = result.rows.length;
      if (sql.includes("SELECT NOT bool_or(present)")) empty = (result.rows[0] as { empty: boolean }).empty;
      if (sql.includes("WITH ledger AS")) digestReads += 1;
      return result;
    } });
    return { ...bound, client: { query: bound.client.query,
      transaction: work => bound.client.transaction(tx => work(traced(tx))),
      transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) },
    close: async () => { await bound.close(); closed = true; } };
  } });
  const result = await prep.prepare({ manifest, migrator: config, webDatabase: web, packet: { manifest,
    migratorScopeDigest: fixtureMigratorScopeDigest(config), webScopeDigest: rehearsalScopeDigest({ ...web, password: "synthetic" }),
    ownerApprovalDigest: hash, cleanupPlanDigest: hash, pgPackageDigest: hash, pgVersionNumber: version,
    expiresAt: current + 120000, durationMs: 60000, dedicatedEmptyDatabase: true, migrationsApplied: "0001-0054", setupRolesAccepted: true,
    maximumConnections: 1, maximumTransactions: 1, maximumStatements: 256, installOrProvision: false, automaticRetry: false,
    cleanup: "close_owned_client_then_operator_database_cleanup" } });
  assert.equal(closed, true, "fixture owns and closes its client");
  assert.equal(result.evidence.execution, "injected_test");
  assert.equal(result.evidence.databaseProvisioned, false); assert.equal(result.evidence.schemaMigrated, false);
  assert.equal(result.evidence.rolesModified, false); assert.equal(result.evidence.realPostgresAccepted, false);
  console.log(`B1a fixture trace metadata=${metadata} catalog=${catalogCount ?? "not-reached"} digests=${digestReads} empty=${empty ?? "not-reached"} disposition=${result.evidence.disposition} closed=${closed}`);
  return { result, statements, metadata, catalogCount, digestReads, empty };
}
async function transformB1aFixture(pg: Pg, database: string) {
  assert.match(database, /^cr14b_rehearsal_[a-z0-9_]{1,40}$/u);
  const beforeCatalog = (await b1aSql(pg, catalogSql, [], database)).rows as Array<{ name: string }>;
  assert.equal(beforeCatalog.length, 254);
  const beforeLedger = (await b1aSql(pg, "SELECT * FROM control_room_schema_migrations ORDER BY ledger_order", [], database)).rows;
  const ledgerOwner = (await b1aSql(pg, "SELECT pg_get_userbyid(relowner) AS owner,relacl::text AS acl FROM pg_class WHERE oid='public.control_room_schema_migrations'::regclass", [], database)).rows;
  const beforeAuthority = await fixtureAuthoritySnapshot(pg, database);
  const web = new Client(pg.connection("web", { database })); await web.connect();
  try { assert.equal(await readPrivateWebSchemaDigest(web), privateWebSchemaDigest); } finally { await web.end(); }
  const names = beforeCatalog.map(row => row.name).filter(name => name !== "control_room_schema_migrations");
  assert.ok(names.every(name => /^[a-z][a-z0-9_]{0,62}$/u.test(name)));
  const admin = new Client(pg.admin({ database })); await admin.connect();
  try {
    await admin.query("BEGIN");
    await admin.query("CREATE SCHEMA b1a_fixture_ledger AUTHORIZATION control_room_schema_owner");
    await admin.query("REVOKE ALL ON SCHEMA b1a_fixture_ledger FROM PUBLIC");
    await admin.query("ALTER TABLE public.control_room_schema_migrations SET SCHEMA b1a_fixture_ledger");
    for (const name of names) await admin.query(`ALTER TABLE public."${name}" OWNER TO control_room_migrator`);
    await admin.query("COMMIT");
  } catch (error) { await admin.query("ROLLBACK"); throw error; } finally { await admin.end(); }
  assert.deepEqual((await b1aSql(pg, "SELECT * FROM b1a_fixture_ledger.control_room_schema_migrations ORDER BY ledger_order", [], database)).rows, beforeLedger);
  assert.deepEqual((await b1aSql(pg, "SELECT pg_get_userbyid(relowner) AS owner,relacl::text AS acl FROM pg_class WHERE oid='b1a_fixture_ledger.control_room_schema_migrations'::regclass", [], database)).rows, ledgerOwner);
  assert.deepEqual((await b1aSql(pg, catalogSql, [], database)).rows.map(row => row.name), names);
  assert.equal((await b1aSql(pg, `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner)<>'control_room_migrator'`, [], database)).rows[0].n, 0);
  for (const name of names) assert.equal((await b1aSql(pg, `SELECT count(*)::int AS n FROM public."${name}"`, [], database)).rows[0].n, 0);
  assert.equal(await fixtureAuthoritySnapshot(pg, database), beforeAuthority);
  const afterWeb = new Client(pg.connection("web", { database })); await afterWeb.connect();
  try { assert.equal(await readPrivateWebSchemaDigest(afterWeb), privateWebSchemaDigest); } finally { await afterWeb.end(); }
  return { beforeAuthority, names };
}

for (const mode of ["shipped ownership", "prepared", "wrong owner", "nonempty"] as const) {
  test(`B1a fixture preparation ${mode}`, async () => b1aRun(async pg => {
    const database = pg.database;
    if (mode === "shipped ownership") {
      const before = await fixtureAuthoritySnapshot(pg, database);
      const f = await prepareB1aFixture(pg, database);
      assert.equal(f.metadata, false); assert.equal(f.catalogCount, undefined);
      assert.equal(f.result.evidence.disposition, "stopped");
      assert.ok(!f.statements.some(sql => /INSERT INTO/u.test(sql))); assert.equal(await fixtureAuthoritySnapshot(pg, database), before);
      return;
    }
    const { beforeAuthority } = await transformB1aFixture(pg, database);
    if (mode === "wrong owner") await b1aSql(pg, "ALTER TABLE public.tenants OWNER TO control_room_schema_owner", [], database);
    if (mode === "nonempty") await b1aSql(pg, "INSERT INTO tenants(id,display_name) VALUES('tenant:retained','Fixture retained')", [], database);
    const f = await prepareB1aFixture(pg, database);
    if (mode === "prepared") {
      assert.equal(f.metadata, true); assert.equal(f.catalogCount, 253);
      assert.equal(f.result.evidence.disposition, "fixture_prepared", "B1a fixture_prepared after measured catalog count");
      assert.equal(f.digestReads, 2); assert.equal(f.empty, true);
      assert.deepEqual(f.result.evidence.fixtureCounts, { tenant: 1, owner: 1, workspace: 1, idea: 1, enrollment: 1, signal: 1 });
      for (const table of LOOP_TABLES) assert.equal((await b1aSql(pg, `SELECT count(*)::int AS n FROM ${table}`, [], database)).rows[0].n, 0);
      assert.equal(await fixtureAuthoritySnapshot(pg, database), beforeAuthority);
    } else {
      assert.equal(f.result.evidence.disposition, "stopped"); assert.ok(!f.statements.some(sql => /INSERT INTO/u.test(sql)));
      if (mode === "wrong owner") { assert.equal(f.metadata, false); assert.equal(f.catalogCount, undefined); }
      else { assert.equal(f.metadata, true); assert.equal(f.digestReads, 2); assert.equal(f.empty, false);
        assert.deepEqual((await b1aSql(pg, "SELECT id,display_name FROM tenants", [], database)).rows,
          [{ id: "tenant:retained", display_name: "Fixture retained" }]); }
    }
  }, `cr14b_rehearsal_b1a_${mode.replaceAll(" ", "_")}`));
}

const GROUNDING = "c38cb199c7fd845091ad5ff624e79ac5143170ac";
const INSTALLED_RELEASE = "2e5c622aa240eb06787764b7b2f3a9129e17f9cf";
async function extractBaseline(commit: string) {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const directory = await mkdtemp(resolve(".test-tmp/b1a-baseline-"));
  try {
    // Exact release bytes captured once from git archive, including the two
    // pre-B1a baselines. Runtime tests also work in CI's depth-1 checkout.
    const bytes = await readFile("tests/fixtures/improve-control-room-release-baselines.json.gz");
    assert.equal(rawHash(bytes), "939b639c4f6d9f85923157b9ff3e4473f05b519d702a8e555fbaa65eca87f18d");
    const fixture = JSON.parse(gunzipSync(bytes).toString("utf8")) as {
      version: number; releases: Record<string, Record<string, string>>; blobs: Record<string, string> };
    assert.equal(fixture.version, 1);
    const files = fixture.releases[commit]; assert.ok(files, `committed release fixture for ${commit}`);
    for (const [file, digest] of Object.entries(files)) {
      const content = fixture.blobs[digest]!;
      assert.equal(rawHash(content), digest, `exact baseline bytes: ${commit}:${file}`);
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(join(directory, file), content);
    }
    const ledger = JSON.parse(await readFile(join(directory, "deploy/postgres/migration-ledger.json"), "utf8"));
    assert.equal(ledgerDigest(ledger.entries), ledger.digest);
    if (commit === INSTALLED_RELEASE) assert.equal(ledger.digest, "c5b27220129a5201f7baeadf48f00d3134726ebe056cb456095b7a88ad4cca03");
    for (const entry of ledger.entries) assert.equal(rawHash(await readFile(join(directory, entry.file), "utf8")), entry.sha256);
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
async function applyB1aRelease(pg: Pg, rootDir: string, database: string) {
  return applyMigrations({ target: undefined, rootDir, ledgerPath: join(rootDir, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: pg.admin({ database }), migrateTarget: pg.connection("migrator", { database }),
    env: { NODE_ENV: "test", CONTROL_ROOM_MIGRATOR_PASSWORD: pg.connection("migrator").password,
      CONTROL_ROOM_APP_PASSWORD: pg.connection("app").password, CONTROL_ROOM_SCHEDULER_PASSWORD: pg.connection("scheduler").password,
      CONTROL_ROOM_WORK_INTAKE_PASSWORD: pg.connection("control_room_work_intake_agent").password } });
}
async function applyB1aRoles(pg: Pg, rootDir: string, database: string, buildQueue = false) {
  const admin = new Client(pg.admin({ database })); await admin.connect();
  try {
    if (buildQueue) {
      await admin.query(getConstructionPlans("control_room_queue"));
      const boss = new PgBoss({ db: { executeSql: (sql: string, values: unknown[]) => admin.query(sql, values) },
        schema: "control_room_queue", backend: "postgres", migrate: false, createSchema: false,
        supervise: false, schedule: false, useListenNotify: false });
      await boss.start();
      try { for (const queue of ["native-task-delivery", "news-feed-collection"]) await boss.createQueue(queue, { retryLimit: 0 }); }
      finally { await boss.stop({ graceful: false }); }
    }
    // Roles are cluster-wide and already provisioned by withRealPostgres. The
    // shipped upgrade parser/converger applies their exact database-local ACLs;
    // fresh-only role SQL must not be replayed against existing identities.
    await admin.query(await readFile(join(rootDir, "db/roles/private_web_database.sql"), "utf8"));
    await admin.query(await readFile(join(rootDir, "db/roles/queue_backup_read_roles.sql"), "utf8"));
    // The constructor's PUBLIC function defaults are revoked by the shipped
    // queue setup SQL, independently of the service-group ACL converger.
    await admin.query(await readFile(join(rootDir, "db/roles/native_queue_producer_roles.sql"), "utf8"));
    await admin.query(await readFile(join(rootDir, "db/roles/agent_reviewer_roles.sql"), "utf8"));
    const grantFiles = ["private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
      "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql", "agent_reviewer_roles.sql", "fleet_gateway_roles.sql"];
    const sources = Object.fromEntries(await Promise.all(grantFiles.map(async name => [name, await readFile(join(rootDir, "db/roles", name), "utf8")])));
    await admin.query("BEGIN");
    try { await applyMacGrantDiffV1(admin, diffMacGrantsV1(await readMacGrantCatalogV1(admin), desiredMacGrantsV1(sources))); await admin.query("COMMIT"); }
    catch (error) { await admin.query("ROLLBACK"); throw error; }
  } finally { await admin.end(); }
}
async function legacySnapshot(pg: Pg, database: string) {
  const data: Record<string, unknown> = {};
  for (const table of ["control_improvement_requests", "control_update_candidates", "control_update_candidate_decisions"])
    data[table] = (await b1aSql(pg, `SELECT * FROM ${table} ORDER BY id`, [], database)).rows;
  return JSON.stringify(data);
}
async function seedB1aLegacy(pg: Pg, database: string) {
  await b1aSeed(pg, database); const web = b1aWeb(pg, database);
  const coordinatorLogin = pg.connection("coordinator", { database });
  const publisherConfig = { host: "127.0.0.1", port: pg.port, database, username: coordinatorLogin.user,
    password: coordinatorLogin.password, majorVersion: 17 as const };
  const publisherDb = bindPrivatePgPool(new Pool({ ...privatePgOptions(publisherConfig), host: coordinatorLogin.host, max: 1 }));
  const publisher = new ImproveControlRoomDeskServiceV1(publisherDb.client, scope, KEY, notUsed);
  const decisions: Array<{ draft: { candidateId: string; expectedVersion: number; candidateRecordDigest: string; decision: "accept" | "decline" }; key: string }> = [];
  try {
    const pipelines = new LinearPipelineServiceV1(web.client, scope, KEY, { assertCurrent: () => true, isAcceptedResultCurrent: () => false });
    const desk = new ImproveControlRoomDeskServiceV1(web.client, scope, KEY, pipelines);
    const saved = await pipelines.createTemplate(identity, ids.project, template);
    for (const state of ["ready", "accepted", "declined"] as const) {
      const request = (await desk.create(identity, ids.project, { description: `Retained legacy ${state}.`, pipelineTemplateId: saved.templateId,
        selectedWorkerIds: ["worker:build", "worker:check"], leadWorkerId: "worker:lead" }, `b1a-legacy-${state}-0001`)).request;
      await b1aSql(pg, "UPDATE pipeline_runs SET state='succeeded' WHERE id=$1", [request.pipelineRunId], database);
      await b1aSql(pg, "UPDATE pipeline_stage_runs SET state='succeeded' WHERE pipeline_run_id=$1 AND stage_kind='signoff'", [request.pipelineRunId], database);
      const candidate = (await publisher.recordCandidate(candidateInput(request))).candidate;
      if (state !== "ready") {
        const draft = { candidateId: candidate.candidateId, expectedVersion: 1, candidateRecordDigest: candidate.recordDigest,
          decision: state === "accepted" ? "accept" as const : "decline" as const };
        const key = `b1a-legacy-decision-${state}`;
        await desk.decide(identity, draft, key); decisions.push({ draft, key });
      }
    }
    const reads = { view: await desk.view(identity, ids.project), ready: await desk.ready(identity),
      replays: await Promise.all(decisions.map(value => desk.decide(identity, value.draft, value.key))) };
    assert.equal(reads.view.requests.length, 3); assert.equal(reads.ready.candidates.length, 1);
    return { reads, decisions, rows: await legacySnapshot(pg, database) };
  } finally { await publisherDb.close(); await web.close(); }
}

for (const baseline of [GROUNDING, INSTALLED_RELEASE]) {
  test(`B1a upgrade ${baseline}`, async () => b1aRun(async pg => {
    const root = await extractBaseline(baseline), database = "b1a_old_release";
    try {
      await b1aSql(pg, `CREATE DATABASE ${database}`);
      await applyB1aRelease(pg, root, database); await applyB1aRoles(pg, root, database, true);
      const before = await seedB1aLegacy(pg, database);
      const upgraded = await applyB1aRelease(pg, resolve("."), database); await applyB1aRoles(pg, resolve("."), database);
      assert.ok(upgraded.applied!.some(entry => entry.file.endsWith("0301_control_loop_improvement_lineage.sql")));
      const replayed = await applyB1aRelease(pg, resolve("."), database); await applyB1aRoles(pg, resolve("."), database);
      assert.equal(replayed.applied!.length, 0);
      assert.equal(await legacySnapshot(pg, database), before.rows, "legacy rows/digests/tags remain byte-identical");
      for (const table of LOOP_TABLES) assert.equal((await b1aSql(pg, `SELECT count(*)::int AS n FROM ${table}`, [], database)).rows[0].n, 0);
      const web = b1aWeb(pg, database);
      try {
        assert.deepEqual({ view: await web.desk.view(identity, ids.project), ready: await web.desk.ready(identity),
          replays: await Promise.all(before.decisions.map(value => web.desk.decide(identity, value.draft, value.key))) }, before.reads);
        await verifyPrivateDatabase(web.client, web.config, { ...scope, ownerIdentityId: ids.identity, issuer: "test" }, Date.now(), { nativeQueue: true });
        assert.equal(await readPrivateWebSchemaDigest(web.client), privateWebSchemaDigest);
        console.log(`B1a upgrade baseline=${baseline} legacy_requests=3 legacy_candidates=3 decisions=2 companions=0 no_op=true digest_equal=true`);
      } finally { await web.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }));
}

test("B1a upgrade failed 0301 rolls back objects and ledger then restored migration succeeds", async () => b1aRun(async pg => {
  const baseline = await extractBaseline(GROUNDING), staged = await mkdtemp(resolve(".test-tmp/b1a-failed-migration-")), database = "b1a_failed_upgrade";
  try {
    await b1aSql(pg, `CREATE DATABASE ${database}`); await applyB1aRelease(pg, baseline, database); await applyB1aRoles(pg, baseline, database, true);
    const before = await seedB1aLegacy(pg, database);
    const ledgerBefore = (await b1aSql(pg, "SELECT * FROM control_room_schema_migrations ORDER BY ledger_order", [], database)).rows;
    const client = new Client(pg.connection("web", { database })); await client.connect();
    let digest: string; try { digest = await readPrivateWebSchemaDigest(client); } finally { await client.end(); }
    await cp("db", join(staged, "db"), { recursive: true }); await mkdir(join(staged, "deploy/postgres"), { recursive: true });
    const migrationPath = join(staged, "db/migrations/0301_control_loop_improvement_lineage.sql"), original = await readFile(migrationPath, "utf8");
    assert.ok(original.includes("\n);\n"));
    await writeFile(migrationPath, original.replace("\n);\n", "\n);\nSELECT 1/0; -- injected failure after the first CREATE\n"));
    const entries = await collectLedgerEntries(staged);
    await writeFile(join(staged, "deploy/postgres/migration-ledger.json"), JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
    await assert.rejects(applyB1aRelease(pg, staged, database), /migration_failed:db\/migrations\/0301_control_loop_improvement_lineage.sql:division by zero/u);
    assert.equal(await legacySnapshot(pg, database), before.rows);
    assert.deepEqual((await b1aSql(pg, "SELECT * FROM control_room_schema_migrations ORDER BY ledger_order", [], database)).rows, ledgerBefore);
    assert.equal((await b1aSql(pg, "SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 'control_loop_improvement_%'", [], database)).rows[0].n, 0);
    const afterClient = new Client(pg.connection("web", { database })); await afterClient.connect();
    try { assert.equal(await readPrivateWebSchemaDigest(afterClient), digest); } finally { await afterClient.end(); }
    await applyB1aRelease(pg, resolve("."), database); await applyB1aRoles(pg, resolve("."), database);
    assert.equal(await legacySnapshot(pg, database), before.rows);
    console.log("B1a failed migration objects=0 ledger_unchanged=true signed_legacy_unchanged=true restored_up=true");
  } finally { await rm(staged, { recursive: true, force: true }); await rm(baseline, { recursive: true, force: true }); }
}));

test("B1a rollback empty round-trip and retained-row refusal", async () => b1aRun(async pg => {
  const baseline = await extractBaseline(GROUNDING), baselineDatabase = "b1a_rollback_baseline";
  try {
    await b1aSql(pg, `CREATE DATABASE ${baselineDatabase}`); await applyB1aRelease(pg, baseline, baselineDatabase);
    await applyB1aRoles(pg, baseline, baselineDatabase, true);
    const reference = new Client(pg.admin({ database: baselineDatabase })); await reference.connect();
    let baselineDigest: string, baselineGrants: string[];
    try { baselineDigest = await readPrivateWebSchemaDigest(reference); baselineGrants = [...await readMacGrantCatalogV1(reference)].sort(); }
    finally { await reference.end(); }
    // Remove empty dependents in reverse ledger order before proving the older down.
    await b1aSql(pg, await readFile("db/down/0307_control_loop_candidate_review_identity.sql", "utf8"), [], pg.database, "migrator");
    await b1aSql(pg, await readFile("db/down/0305_control_loop_candidate_unavailable_sections.sql", "utf8"), [], pg.database, "migrator");
    await b1aSql(pg, await readFile("db/down/0304_control_loop_candidate_start_authorization.sql", "utf8"), [], pg.database, "migrator");
    await b1aSql(pg, await readFile("db/down/0303_control_loop_update_candidates.sql", "utf8"), [], pg.database, "migrator");
    await b1aSql(pg, await readFile("db/down/0302_control_loop_improvement_commands.sql", "utf8"), [], pg.database, "migrator");
    const down = await readFile("db/down/0301_control_loop_improvement_lineage.sql", "utf8");
    await b1aSql(pg, down, [], pg.database, "migrator"); await applyB1aRoles(pg, baseline, pg.database);
    const downgraded = new Client(pg.connection("web")); await downgraded.connect();
    try { assert.equal(await readPrivateWebSchemaDigest(downgraded), baselineDigest);
      assert.deepEqual([...await readMacGrantCatalogV1(downgraded)].sort(), baselineGrants); }
    finally { await downgraded.end(); }
    const up = await readFile("db/migrations/0301_control_loop_improvement_lineage.sql", "utf8");
    await b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${up}\nCOMMIT;`, [], pg.database, "migrator");
    await b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${await readFile("db/migrations/0302_control_loop_improvement_commands.sql", "utf8")}\nCOMMIT;`, [], pg.database, "migrator");
    await b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${await readFile("db/migrations/0303_control_loop_update_candidates.sql", "utf8")}\nCOMMIT;`, [], pg.database, "migrator");
    await b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${await readFile("db/migrations/0304_control_loop_candidate_start_authorization.sql", "utf8")}\nCOMMIT;`, [], pg.database, "migrator");
    await b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${await readFile("db/migrations/0305_control_loop_candidate_unavailable_sections.sql", "utf8")}\nCOMMIT;`, [], pg.database, "migrator");
    await b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${await readFile("db/migrations/0307_control_loop_candidate_review_identity.sql", "utf8")}\nCOMMIT;`, [], pg.database, "migrator");
    await b1aSql(pg, `BEGIN; SET LOCAL ROLE control_room_schema_owner; ${await readFile("db/migrations/0308_validate_control_loop_update_candidates_check.sql", "utf8")}\nCOMMIT;`, [], pg.database, "migrator");
    await b1aSql(pg, await readFile("db/roles/production_table_grants.sql", "utf8"), [], pg.database, "migrator");
    await applyB1aRoles(pg, resolve("."), pg.database);
    const f = await b1aLinked(pg), web = b1aWeb(pg);
    try { await web.desk.authorizeLoopStart(identity, ids.project, f.start, "b1a-rollback-start-0001", loopObservation());
      assert.equal(await readPrivateWebSchemaDigest(web.client), privateWebSchemaDigest); }
    finally { await web.close(); }
    const retained = await b1aSnapshot(pg), ledger = (await b1aSql(pg, "SELECT * FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    await assert.rejects(b1aSql(pg, down, [], pg.database, "migrator"), /loop improvement lineage retained/u);
    assert.equal(await b1aSnapshot(pg), retained);
    assert.deepEqual((await b1aSql(pg, "SELECT * FROM control_room_schema_migrations ORDER BY ledger_order")).rows, ledger);
    const after = new Client(pg.connection("web")); await after.connect();
    try { assert.equal(await readPrivateWebSchemaDigest(after), privateWebSchemaDigest); } finally { await after.end(); }
    console.log(`B1a rollback empty_digest=${baselineDigest} grants_equal=true retained_refusal=true signed_rows_unchanged=true`);
  } finally { await rm(baseline, { recursive: true, force: true }); }
}));

test("B1a contention: twenty separate web connections, duplicates, conflicts, dropped caller and retry", async () => b1aRun(async pg => {
  await b1aSeed(pg);
  let gate: { arrived: number; wait: () => Promise<void> } | undefined;
  const connections = Array.from({ length: 20 }, () => {
    let seen: object | undefined;
    return b1aWeb(pg, pg.database, async sql => {
      if (gate && seen !== gate && /SELECT id FROM control_identities/u.test(sql)) {
        seen = gate; gate.arrived += 1; await gate.wait();
      }
    });
  });
  const atBarrier = async <T>(operation: (web: ReturnType<typeof b1aWeb>, index: number) => Promise<T>) => {
    let release!: () => void, timeout: ReturnType<typeof setTimeout> | undefined;
    const opened = new Promise<void>(resolve => { release = resolve; });
    gate = { arrived: 0, wait: async () => { if (gate!.arrived === 20) release(); await opened; } };
    timeout = setTimeout(release, 5000);
    const batch = gate;
    try { const results = await Promise.allSettled(connections.map(operation));
      assert.equal(batch.arrived, 20, "all twenty connections reached the pre-lock barrier"); return results; }
    finally { clearTimeout(timeout); gate = undefined; }
  };
  try {
    const logins = await Promise.all(connections.map(web => web.client.query("SELECT pg_backend_pid() AS pid,current_user,session_user")));
    assert.equal(new Set(logins.map(value => (value.rows[0] as { pid: number }).pid)).size, 20);
    const saves = await atBarrier(web => web.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-contention-save-0001"));
    const saved = saves.map(value => { assert.equal(value.status, "fulfilled"); return (value as PromiseFulfilledResult<Awaited<ReturnType<ImproveControlRoomDeskServiceV1["saveLoopDraft"]>>>).value; });
    assert.equal(saved.filter(value => !value.replayed).length, 1); assert.equal(saved.filter(value => value.replayed).length, 19);
    assert.equal(new Set(saved.map(value => value.request.requestId)).size, 1);
    const root = saved[0]!.request.requestId;
    const links = await atBarrier(web => web.desk.recordLoopRunLink({ projectId: ids.project, requestId: root, initialInputVersion: 1, run: loopRun() }));
    const linked = links.map(value => { assert.equal(value.status, "fulfilled"); return (value as PromiseFulfilledResult<Awaited<ReturnType<ImproveControlRoomDeskServiceV1["recordLoopRunLink"]>>>).value; });
    assert.equal(linked.filter(value => !value.replayed).length, 1); assert.equal(linked.filter(value => value.replayed).length, 19);
    const start = { requestId: root, expectedVersion: 1, runLinkId: linked[0]!.runLink.runLinkId,
      requestSha256: rawHash(LOOP_DRAFT.description), settingsSha256: rawHash(LOOP_DRAFT.settingsText) };
    const observation = loopObservation();
    const starts = await atBarrier(web => web.desk.authorizeLoopStart(identity, ids.project, start, "b1a-contention-start-0001", observation));
    const authorized = starts.map(value => { assert.equal(value.status, "fulfilled"); return (value as PromiseFulfilledResult<Awaited<ReturnType<ImproveControlRoomDeskServiceV1["authorizeLoopStart"]>>>).value; });
    assert.equal(authorized.filter(value => !value.replayed).length, 1); assert.equal(authorized.filter(value => value.replayed).length, 19);
    assert.equal(new Set(authorized.map(value => value.authorizationId)).size, 1);
    const conflicting = await atBarrier((web, i) => web.desk.saveLoopDraft(identity, ids.project,
      { ...LOOP_DRAFT, description: i % 2 === 0 ? "first proposal" : "second proposal" }, "b1a-contention-conflict-0001"));
    assert.equal(conflicting.filter(value => value.status === "fulfilled").length, 10);
    const losers = conflicting.filter(value => value.status === "rejected") as PromiseRejectedResult[];
    assert.equal(losers.length, 10); for (const loser of losers) assert.match(String(loser.reason), /conflict/u);
    assert.equal((await b1aSql(pg, "SELECT count(*)::int AS n FROM control_loop_improvement_requests")).rows[0].n, 2);
    assert.equal((await b1aSql(pg, "SELECT count(*)::int AS n FROM control_loop_improvement_inputs")).rows[0].n, 2);
    // A third caller disappears while its transaction holds a newly inserted root.
    // Terminate precisely its backend (not any unrelated process); its retry keeps the key.
    let backend = 0, rootInserted!: () => void, continueWrite!: () => void;
    const reached = new Promise<void>(resolve => { rootInserted = resolve; });
    const resume = new Promise<void>(resolve => { continueWrite = resolve; });
    const slow = b1aWeb(pg, pg.database, async sql => {
      if (/INSERT INTO control_loop_improvement_inputs/u.test(sql)) { rootInserted(); await resume; }
    });
    try {
      backend = Number((await slow.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      const dropped = slow.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-contention-dropped-0001").then(
        () => ({ refused: false }), () => ({ refused: true }));
      await reached;
      const retry = connections[0]!.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-contention-dropped-0001");
      // Ensure the follower actually waits on the stopped transaction's identity lock.
      let waiting = 0;
      for (let i = 0; i < 50 && waiting === 0; i += 1) {
        waiting = Number((await b1aSql(pg, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [backend])).rows[0].n);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting > 0, "the slow/dropped caller had a real contending follower");
      assert.equal((await b1aSql(pg, "SELECT pg_terminate_backend($1) AS stopped", [backend])).rows[0].stopped, true);
      continueWrite(); assert.equal((await dropped).refused, true);
      const retried = await retry;
      assert.equal(retried.replayed, false);
      const again = await connections[0]!.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-contention-dropped-0001");
      assert.equal(again.request.requestId, retried.request.requestId); assert.equal(again.replayed, true);
    } finally { continueWrite(); await slow.close(); }
    console.log("B1a contention connections=20 barrier=20 save=1+19 link=1+19 authorization=1+19 conflicts=10+10 slow_waiter=true dropped_retry=true");
  } finally { await Promise.all(connections.map(web => web.close())); }
}));

test("B1a SQL structural bindings, active owner grants and append sequence", async () => b1aRun(async pg => {
  const f = await b1aLinked(pg), before = await b1aSnapshot(pg);
  for (const confirmation of [{ ...loopObservation().confirmation, who: null }, { ...loopObservation().confirmation, who: "worker" },
    { ...loopObservation().confirmation, path: "../private.md" }, { ...loopObservation().confirmation, sha256: "0".repeat(64) },
    { ...loopObservation().confirmation, extra: true }])
    await assert.rejects(directLoopInsert(pg, LOOP_TABLES[3], { ...forgedAuthorization(f), confirmation }), /constraint|binding rejected/u);
  for (const change of ["role_key='operator'", "revoked_at=statement_timestamp()", "risk_ceiling='low'",
    "allowed_actions='[\"projects.read\"]'", "project_ids='[\"project:other\"]'"]) {
    await b1aSql(pg, `UPDATE control_role_grants SET ${change} WHERE id=$1`, [ids.grant]);
    await assert.rejects(directLoopInsert(pg, LOOP_TABLES[3], forgedAuthorization(f)), /loop authorization needs current owner grant/u);
    await b1aSql(pg, `UPDATE control_role_grants SET role_key='owner',revoked_at=NULL,risk_ceiling='critical',
      allowed_actions='["*"]',project_ids='["*"]' WHERE id=$1`, [ids.grant]);
  }
  const input = (await b1aSql(pg, "SELECT * FROM control_loop_improvement_inputs")).rows[0];
  for (const patch of [{ version: 3 }, { version: 2, project_id: "project:other" }, { version: 2, owner_identity_id: ids.operator },
    { version: 2, tenant_id: "tenant:other" }])
    await assert.rejects(directLoopInsert(pg, LOOP_TABLES[1], { ...input, ...patch, idempotency_key: "b1a-bad-sequence-0001" }),
      /loop input version or binding rejected/u);
  assert.equal(await b1aSnapshot(pg), before);
}));


test("B1b upgrade from reviewed B1a preserves signed legacy and lineage bytes", async () => b1aRun(async pg => {
  const base = "344bc3ab32601c76faa25ca977dc3eb335411a96", root = await extractBaseline(base), database = "b1b_from_base";
  try {
    await b1aSql(pg, `CREATE DATABASE ${database}`);
    await applyB1aRelease(pg, root, database); await applyB1aRoles(pg, root, database, true);
    const legacy = await seedB1aLegacy(pg, database), beforeWeb = b1aWeb(pg, database);
    try {
      const draft = await beforeWeb.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1b-retained-draft-0001");
      const linked = await beforeWeb.desk.recordLoopRunLink({ projectId: ids.project, requestId: draft.request.requestId, initialInputVersion: 1, run: loopRun() });
      await beforeWeb.desk.authorizeLoopStart(identity, ids.project, { requestId: draft.request.requestId, expectedVersion: 1,
        runLinkId: linked.runLink.runLinkId, requestSha256: rawHash(LOOP_DRAFT.description), settingsSha256: rawHash(LOOP_DRAFT.settingsText) }, "b1b-retained-auth-0001", loopObservation());
    } finally { await beforeWeb.close(); }
    const retained: Record<string, unknown> = {};
    for (const table of LOOP_TABLES) retained[table] = (await b1aSql(pg, `SELECT * FROM ${table} ORDER BY record_digest`, [], database)).rows;
    const staged = await mkdtemp(resolve(".test-tmp/b1b-failed-upgrade-"));
    try {
      await cp(resolve("db"), join(staged, "db"), { recursive: true });
      await mkdir(join(staged, "deploy/postgres"), { recursive: true });
      const migration = join(staged, "db/migrations/0302_control_loop_improvement_commands.sql");
      await writeFile(migration, (await readFile(migration, "utf8")) + "\nSELECT 1/0;\n");
      const entries = await collectLedgerEntries(staged);
      await writeFile(join(staged, "deploy/postgres/migration-ledger.json"), JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
      const beforeLedger = JSON.stringify((await b1aSql(pg, "SELECT * FROM control_room_schema_migrations ORDER BY ledger_order", [], database)).rows);
      await assert.rejects(applyB1aRelease(pg, staged, database), /migration_failed:db\/migrations\/0302_control_loop_improvement_commands.sql:division by zero/u);
      assert.equal((await b1aSql(pg, "SELECT to_regclass('control_loop_improvement_commands') AS journal", [], database)).rows[0].journal, null);
      assert.equal(JSON.stringify((await b1aSql(pg, "SELECT * FROM control_room_schema_migrations ORDER BY ledger_order", [], database)).rows), beforeLedger);
      assert.equal(await legacySnapshot(pg, database), legacy.rows);
    } finally { await rm(staged, { recursive: true, force: true }); }
    const upgraded = await applyB1aRelease(pg, resolve("."), database); await applyB1aRoles(pg, resolve("."), database);
    assert.ok(upgraded.applied!.some(entry => entry.file.endsWith("0302_control_loop_improvement_commands.sql")));
    for (const table of LOOP_TABLES) assert.deepEqual((await b1aSql(pg, `SELECT * FROM ${table} ORDER BY record_digest`, [], database)).rows, retained[table]);
    assert.equal(await legacySnapshot(pg, database), legacy.rows);
    assert.equal((await b1aSql(pg, "SELECT count(*)::int n FROM control_loop_improvement_commands", [], database)).rows[0].n, 0);
    const after = b1aWeb(pg, database);
    try { assert.equal(await readPrivateWebSchemaDigest(after.client), privateWebSchemaDigest); }
    finally { await after.close(); }
    assert.equal((await applyB1aRelease(pg, resolve("."), database)).applied!.length, 0);
    console.log("B1b upgrade BASE retained_legacy=3 retained_lineage=4 bytes_equal=true journal=0 no_op=true");
  } finally { await rm(root, { recursive: true, force: true }); }
}));

test("B1a loop desk returns only the authenticated creator in the same project", async () => b1aRun(async pg => {
  await b1aSeed(pg);
  // Both active identities are owners of this project; authority alone does not confer creator visibility.
  await b1aSql(pg, "UPDATE control_role_grants SET role_key='owner' WHERE id=$1", [ids.operatorGrant]);
  const web = b1aWeb(pg);
  try {
    const own = await web.desk.saveLoopDraft(identity, ids.project, LOOP_DRAFT, "b1a-creator-own-0001");
    const other = await web.desk.saveLoopDraft(operator, ids.project,
      { ...LOOP_DRAFT, description: "Another creator's saved request." }, "b1a-creator-other-0001");
    assert.equal((await web.client.query("SELECT current_user")).rows[0].current_user, "control_room_web");
    assert.equal((await b1aSql(pg, "SELECT count(*)::int n FROM control_loop_improvement_requests WHERE project_id=$1", [ids.project])).rows[0].n, 2);
    const before = await b1aSnapshot(pg);
    const ownView = await web.desk.viewLoopDesk(identity, ids.project);
    assert.deepEqual(ownView.loopRequests.map(row => row.requestId), [own.request.requestId], "same-project requests from another creator are excluded");
    const otherView = await web.desk.viewLoopDesk(operator, ids.project);
    assert.deepEqual(otherView.loopRequests.map(row => row.requestId), [other.request.requestId]);
    assert.deepEqual(ownView.legacy, await web.desk.view(identity, ids.project));
    assert.equal(await b1aSnapshot(pg), before, "signed lineage bytes remain unchanged by creator-filtered reads");
    console.log("B1a creator isolation same_project=2 visible_per_creator=1 signed_bytes_unchanged=true production_login=control_room_web");
  } finally { await web.close(); }
}));

test("B2a desk owner isolation", async () => b1aRun(async pg => {
  const { ImproveControlRoomLoopServiceV1 } = await import("../src/web/v1/improve-control-room-loop-service");
  const { createImproveControlRoomHttpHandlerV1 } = await import("../src/web/v1/improve-control-room-http");
  const f = await b1aLinked(pg), web = b1aWeb(pg);
  let adapterCalls = 0;
  const adapter = { contract: LOOP_CONTRACT, close: async () => {}, status: () => { adapterCalls++; throw new Error("unexpected_adapter_read"); } } as never;
  const bridge = new ImproveControlRoomLoopServiceV1(web.client, scope, { integrityKey: KEY, adapter });
  let caller = identity;
  // Authentication fixture supplies a previously verified identity; the real
  // session/grant/creator checks below run against production-role SQL.
  const localOwnerSession = { assertLocalRequest: (request: Request) => assert.equal(new URL(request.url).origin, "https://product.invalid"),
    verify: () => caller } as never;
  const handler = createImproveControlRoomHttpHandlerV1({ origin: "https://product.invalid", loopBridge: bridge, localOwnerSession });
  const get = (projectId = ids.project) => handler(new Request(`https://product.invalid/api/v1/projects/${encodeURIComponent(projectId)}/improvements/loop/desk`));
  try {
    assert.equal((await web.client.query("SELECT current_user")).rows[0].current_user, "control_room_web");
    const pipelines = new LinearPipelineServiceV1(web.client, scope, KEY, { assertCurrent: () => true, isAcceptedResultCurrent: () => false });
    const savedTemplate = await pipelines.createTemplate(identity, ids.project, template);
    const legacyDesk = new ImproveControlRoomDeskServiceV1(web.client, scope, KEY, pipelines);
    const old = await legacyDesk.create(identity, ids.project, { description: "Retained signed legacy request.", pipelineTemplateId: savedTemplate.templateId,
      selectedWorkerIds: ["worker:build", "worker:check"], leadWorkerId: "worker:lead" }, "b2a-pg-legacy-0001");
    await b1aSql(pg, "UPDATE control_role_grants SET role_key='owner' WHERE id=$1", [ids.operatorGrant]);
    const foreign = await web.desk.saveLoopDraft(operator, ids.project, { ...LOOP_DRAFT, description: "Other creator's request." }, "b2a-pg-other-owner-0001");
    await web.desk.authorizeLoopStart(identity, ids.project, f.start, "b2a-pg-current-auth-0001", loopObservation());
    const before = await b1aSnapshot(pg), digest = await readPrivateWebSchemaDigest(web.client);
    const grants = JSON.stringify(await readMacGrantCatalogV1(web.client));
    for (let i = 0; i < 3; i++) {
      const response = await get(); assert.equal(response.status, 200); const value = await response.json();
      assert.deepEqual(value.loopRequests.map((row: { requestId: string }) => row.requestId), [f.saved.request.requestId]);
      assert.equal(value.loopRequests[0].runLink.initialInputVersion, 1);
      assert.equal(value.loopRequests[0].savedAuthorization, true);
      assert.equal(value.loopRequests[0].startsWork, false); assert.equal(value.loopRequests[0].grantsDeployAuthority, false);
      assert.equal(value.legacy.requests[0].requestId, old.request.requestId);
    }
    caller = operator; const other = await get(); assert.equal(other.status, 200);
    assert.deepEqual((await other.json()).loopRequests.map((row: { requestId: string }) => row.requestId), [foreign.request.requestId]);
    caller = identity;
    assert.equal((await get("project:foreign")).status, 404);
    assert.equal(await b1aSnapshot(pg), before); assert.equal(await readPrivateWebSchemaDigest(web.client), digest);
    assert.equal(JSON.stringify(await readMacGrantCatalogV1(web.client)), grants); assert.equal(adapterCalls, 0);
    // A populated list must prove the bound and tie-breaking order, rather than
    // merely checking that a one-row desk happens to be below the limit.
    for (let i = 0; i < 101; i++) await web.desk.saveLoopDraft(identity, ids.project,
      { ...LOOP_DRAFT, description: `Bounded saved request ${i}.` }, `b2a-pg-bounded-${String(i).padStart(5, "0")}`);
    const expected = (await b1aSql(pg, `SELECT id FROM control_loop_improvement_requests
      WHERE tenant_id=$1 AND project_id=$2 AND owner_identity_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [scope.tenantId, ids.project, ids.identity])).rows.map(row => row.id);
    const populated = await b1aSnapshot(pg);
    const bounded = await get(); assert.equal(bounded.status, 200);
    const boundedView = await bounded.json(); assert.equal(boundedView.loopRequests.length, 100);
    assert.deepEqual(boundedView.loopRequests.map((row: { requestId: string }) => row.requestId), expected);
    assert.equal(await b1aSnapshot(pg), populated); assert.equal(adapterCalls, 0);
    await b1aSql(pg, "ALTER TABLE control_loop_improvement_inputs DISABLE TRIGGER USER");
    try { await b1aSql(pg, "UPDATE control_loop_improvement_inputs SET auth_tag=$1 WHERE request_id=$2", [TAG, expected[0]]); }
    finally { await b1aSql(pg, "ALTER TABLE control_loop_improvement_inputs ENABLE TRIGGER USER"); }
    assert.equal((await get()).status, 503, "tampered signed inputs refuse at HTTP boundary");
    console.log("B2a desk owner isolation production_login=control_room_web legacy_preserved=true signed_bytes_unchanged=true grants_unchanged=true adapter_calls=0");
  } finally { await bridge.close(); await web.close(); }
}));

test("B5 retained website lineage uses the web login", async () => b1aRun(async pg => {
  const { syntheticFirstWebsiteEngineV1, driveSyntheticFirstWebsiteV1 } = await import("./helpers/improve-control-room-first-website");
  await b1aSeed(pg); const web = b1aWeb(pg);
  const e = await syntheticFirstWebsiteEngineV1({ client: web.client, scope, projectId: ids.project, clock: Date.now });
  const bridge = e.openBridge();
  try {
    assert.deepEqual((await web.client.query("SELECT current_user,session_user")).rows,
      [{ current_user: "control_room_web", session_user: "control_room_web" }]);
    // A retained signed legacy request and its pipeline run must be untouched by the loop journey.
    // One installation has one integrity key: sign the legacy rows with the key the website desk verifies.
    const pipelines = new LinearPipelineServiceV1(web.client, scope, e.KEY, { assertCurrent: () => true, isAcceptedResultCurrent: () => false });
    const savedTemplate = await pipelines.createTemplate(identity, ids.project, template);
    await new ImproveControlRoomDeskServiceV1(web.client, scope, e.KEY, pipelines).create(identity, ids.project, { description: "Retained signed legacy request.",
      pipelineTemplateId: savedTemplate.templateId, selectedWorkerIds: ["worker:build", "worker:check"], leadWorkerId: "worker:lead" }, "b5-pg-legacy-0001");
    const legacyRows = async () => JSON.stringify(await Promise.all(["control_improvement_requests", "control_update_candidates", "control_update_candidate_decisions",
      "pipeline_runs", "work_items", "control_native_task_queue"].map(async table => (await b1aSql(pg, `SELECT * FROM ${table} ORDER BY 1,2`)).rows)));
    const legacy = await legacyRows(), grants = JSON.stringify(await readMacGrantCatalogV1(web.client)), digest = await readPrivateWebSchemaDigest(web.client);
    // Website commands through the real bridge, SYNTHETIC workers only.
    const { requestId, runLinkId } = await driveSyntheticFirstWebsiteV1(e, bridge, identity, ids.project, "b5-pg");
    assert.equal(e.phase(), "finished");
    const commands = await b1aSql(pg, "SELECT operation,entry_kind FROM control_loop_improvement_commands WHERE request_id=$1 ORDER BY operation,entry_kind", [requestId]);
    assert.deepEqual(commands.rows.map(r => `${r.operation}:${r.entry_kind}`), ["answer:claim", "answer:result", "approve:claim", "approve:claim", "approve:result", "approve:result",
      "confirm:claim", "confirm:result", "intake:claim", "intake:result", "start:claim", "start:result"], "B5 one signed claim/result per website command");
    for (const table of LOOP_TABLES) assert.equal((await b1aSql(pg, `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1, `B5 one ${table} row`);
    const view = await e.desk.viewLoopDesk(identity, ids.project);
    assert.equal(view.loopRequests[0]!.requestId, requestId); assert.equal(view.loopRequests[0]!.runLink!.runLinkId, runLinkId);
    assert.equal(view.loopRequests[0]!.savedAuthorization, true); assert.equal(view.loopRequests[0]!.startsWork, false);
    assert.deepEqual(view.legacy.templates.map(choice => choice.templateId), [savedTemplate.templateId], "B5 retained legacy template verifies");
    assert.equal(view.legacy.requests.length, 1, "B5 retained legacy request verifies");
    // The website Start claim binds the Confirm-recorded authorization, so B4 publishes on PostgreSQL
    // through the 0304 SQL guard, and the retained card replays exactly.
    const before = await b1aSnapshot(pg);
    const recorded = await e.publish();
    assert.equal(recorded.state, "recorded", "B5 website-started run records its B4 finish card on PostgreSQL");
    assert.equal(recorded.candidate.candidateRevision, e.heads.final);
    assert.equal((await b1aSql(pg, "SELECT count(*)::int AS n FROM control_loop_update_candidates")).rows[0].n, 1);
    assert.equal(await b1aSnapshot(pg), before, "B5 publication leaves the signed lineage bytes unchanged");
    const replayed = await e.publish();
    assert.equal(replayed.state, "replayed"); assert.deepEqual(replayed.candidate, recorded.candidate, "B5 retained publication replays the same candidate");
    assert.equal(await legacyRows(), legacy, "B5 legacy signed rows, decisions and pipeline/task rows are unchanged");
    assert.equal(JSON.stringify(await readMacGrantCatalogV1(web.client)), grants); assert.equal(await readPrivateWebSchemaDigest(web.client), digest);
    assert.deepEqual(web.errors.filter(error => error.sqlState === "42501"), [], "B5 web login needs no privilege it lacks");
    console.log("B5 retained website lineage production_login=control_room_web commands=12 legacy_unchanged=true grants_unchanged=true publication=recorded");
    // Projection hashes do not authenticate rows. Mutate through the isolated
    // test administrator, then rehash only the permitted web-role projection.
    const projection = async () => {
      const rows = (await web.client.query("SELECT id,request_id,run_link_id,candidate_revision,record_digest FROM control_loop_update_candidates")).rows;
      return rows.map(row => ({row,sha256:sha256Digest(row)}));
    };
    const original = (await b1aSql(pg,"SELECT record_digest,auth_tag FROM control_loop_update_candidates WHERE request_id=$1",[requestId])).rows[0];
    for (const column of ["record_digest","auth_tag"] as const) {
      await b1aSql(pg,"ALTER TABLE control_loop_update_candidates DISABLE TRIGGER USER");
      try { await b1aSql(pg,`UPDATE control_loop_update_candidates SET ${column}=$1 WHERE request_id=$2`,[column === "record_digest" ? sha256Digest({tampered:"candidate"}) : TAG,requestId]); }
      finally { await b1aSql(pg,"ALTER TABLE control_loop_update_candidates ENABLE TRIGGER USER"); }
      const rehashed = await projection();
      assert.ok(rehashed.every(e => e.sha256 === sha256Digest(e.row)),"F04b unauthenticated projection can be rehashed after tamper");
      await assert.rejects(e.desk.readLoopCandidate(identity,ids.project,requestId),"F04b cold signed service refuses tamper despite fresh projection hashes");
      await b1aSql(pg,"ALTER TABLE control_loop_update_candidates DISABLE TRIGGER USER");
      try { await b1aSql(pg,`UPDATE control_loop_update_candidates SET ${column}=$1 WHERE request_id=$2`,[original[column],requestId]); }
      finally { await b1aSql(pg,"ALTER TABLE control_loop_update_candidates ENABLE TRIGGER USER"); }
    }
    assert.equal((await e.desk.readLoopCandidate(identity,ids.project,requestId)).candidate?.recordDigest,recorded.candidate.recordDigest);
    console.log("RESULT: PASS F04b cold service rejects candidate/tag tamper with recomputed projection hashes production_login=control_room_web");
  } finally { await bridge.close(); await web.close(); }
}));
