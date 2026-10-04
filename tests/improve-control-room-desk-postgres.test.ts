// Real-PostgreSQL proof for migration 0160 and its production-role boundaries.
// The owner-facing web operations run as control_room_private_web; candidate
// publication runs as control_room_task_coordinator. Neither login owns schema
// objects or receives deployment/service/database effect authority.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
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
