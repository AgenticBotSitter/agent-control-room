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

const PORT = 58350, PG = requiresRealPostgres(), KEY = new Uint8Array(32).fill(65);
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };
const scope = { tenantId: "tenant:improve-pg", workspaceId: "workspace:improve-pg" };
const ids = { adapter: "adapter:improve-pg", project: "project:improve-pg", identity: "identity:improve-pg",
  grant: "grant:improve-pg", token: sha256Digest({ session: "improve-pg" }) };
const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const identity: VerifiedWebIdentity = { provider: "test", subject: ids.identity, tokenDigest: ids.token,
  issuedAt, expiresAt, verificationExpiresAt: expiresAt };
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
  const config = { host: login.host, port: postgres.port, database: postgres.database, username: login.user,
    password: login.password, majorVersion: 17 as const };
  return bindPrivatePgPool(new Pool(privatePgOptions(config)));
}

test("production web and coordinator roles complete the inert desk lifecycle", async t => {
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
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)`,
      [ids.identity, scope.tenantId, sha256Digest({ provider: "test", subject: ids.identity }), issuedAt]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`, [ids.grant, scope.tenantId, ids.identity, issuedAt]);
      await admin.query("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
        [scope.tenantId, ids.token, ids.identity, issuedAt, expiresAt]);
    } finally { await admin.end(); }

    const web = pool(postgres, "web");
    let request!: Awaited<ReturnType<ImproveControlRoomDeskServiceV1["create"]>>["request"];
    try {
      const pipelines = new LinearPipelineServiceV1(web.client, scope, KEY,
        { assertCurrent: () => true, isAcceptedResultCurrent: () => false });
      const saved = await pipelines.createTemplate(identity, ids.project, template);
      const desk = new ImproveControlRoomDeskServiceV1(web.client, scope, KEY, pipelines);
      request = (await desk.create(identity, ids.project, { description: "Exercise the production-role desk path.",
        pipelineTemplateId: saved.templateId, selectedWorkerIds: ["worker:build", "worker:check"],
        leadWorkerId: "worker:lead" }, "improve-postgres-request-0001")).request;
      assert.equal(request.startsWork, false);
    } finally { await web.close(); }

    const admin2 = new Client(postgres.admin({ database: postgres.database })); await admin2.connect();
    try {
      await admin2.query("UPDATE pipeline_runs SET state='succeeded' WHERE id=$1", [request.pipelineRunId]);
      await admin2.query("UPDATE pipeline_stage_runs SET state='succeeded' WHERE pipeline_run_id=$1 AND stage_kind='signoff'",
        [request.pipelineRunId]);
    } finally { await admin2.end(); }

    const coordinator = pool(postgres, "coordinator");
    let candidate!: Awaited<ReturnType<ImproveControlRoomDeskServiceV1["recordCandidate"]>>["candidate"];
    try {
      const publisher = new ImproveControlRoomDeskServiceV1(coordinator.client, scope, KEY,
        { instantiate: async () => { throw new Error("not_used"); } } as never);
      candidate = (await publisher.recordCandidate({ projectId: ids.project, improvementRequestId: request.requestId,
        pipelineRunId: request.pipelineRunId, baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40),
        summary: "Production-role candidate.", changedAreas: ["desk"], testResults: [{ profile: "db", status: "passed",
          summary: "Real PostgreSQL role path passed.", evidenceDigest: `sha256:${"c".repeat(64)}` }],
        databaseChanges: { kind: "migrations", migrationIds: ["0160_improve_control_room_desk"], summary: "Desk records." },
        leadWorkerId: "worker:lead" })).candidate;
    } finally { await coordinator.close(); }

    const webDecision = pool(postgres, "web");
    try {
      const desk = new ImproveControlRoomDeskServiceV1(webDecision.client, scope, KEY,
        { instantiate: async () => { throw new Error("not_used"); } } as never);
      assert.equal((await desk.ready(identity)).candidates.length, 1);
      const receipt = await desk.decide(identity, { candidateId: candidate.candidateId, expectedVersion: 1,
        candidateRecordDigest: candidate.recordDigest, decision: "accept" }, "improve-postgres-decision-0001");
      assert.equal(receipt.startsDeploy, false); assert.equal(receipt.signedDeployApprovalCreated, false);
    } finally { await webDecision.close(); }

    for (const role of ["app", "scheduler", "intake", "news", "results", "publisher", "queueWorker"]) {
      await assert.rejects(postgres.query(role, "SELECT 1 FROM control_update_candidates LIMIT 1"), /permission denied/u);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 150_000 });
});

test("the desk real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1); assert.equal(ran, required);
});
