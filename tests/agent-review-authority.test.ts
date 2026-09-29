import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DatabaseClient } from "../src/persistence/database";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1";
import { AgentReviewServiceV1, CompletionGateStoreV1, type CompletionAcceptanceProfileV1,
  type CompletionReviewTargetV1 } from "../src/completion-gate/v1";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";

const at = new Date(now).toISOString(), key = new Uint8Array(32).fill(52);
const template = { name: "Agent review authority", description: "Build, check and validate one bounded result.", stages: [
  { ordinal: 0, stageKind: "build", role: "builder", description: "Build it.", requiredCapability: "code.change",
    allowedPaths: ["src/**"], maximumChangedFiles: 20, maximumChangedBytes: 262144,
    workerId: "worker:codex:one", workerKind: "codex", nodeId: "node:codex:one", selectionKey: "codex.standard",
    model: "gpt-test", effort: "medium", maxLoops: 3 },
  { ordinal: 1, stageKind: "check", role: "checker", description: "Check it.", requiredCapability: "code.review",
    workerId: "worker:claude:one", workerKind: "claude-code", nodeId: "node:claude:one", selectionKey: "claude.standard",
    model: "claude-test", effort: "high", maxLoops: 3 },
  { ordinal: 2, stageKind: "signoff", role: "validator", description: "Validate it.", requiredCapability: "code.validate",
    workerId: "worker:hermes:one", workerKind: "hermes", nodeId: "node:hermes:one", selectionKey: "hermes.standard",
    model: "hermes-test", effort: "default", provider: "openai", profile: "profile:openai", maxLoops: 0 },
], maxTotalLoops: 6, maxDurationSeconds: 3600 } as const;

function restricted(db: DatabaseClient, login: string): DatabaseClient {
  const client: DatabaseClient = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    // PGlite keeps a SET LOCAL SESSION AUTHORIZATION past the transaction end
    // and ignores RESET, so restore the fixture superuser explicitly: later
    // fixture writes must not run as the restricted login.
    transactionWithPreCommitCheck: async (work, check) => {
      try {
        return await db.transactionWithPreCommitCheck(async tx => {
          await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`); return work(tx);
        }, check);
      } finally { await db.query("SET SESSION AUTHORIZATION postgres"); }
    },
  };
  return client;
}

async function fixture(minimumRisk: CompletionAcceptanceProfileV1["minimumRisk"] = "low") {
  const f = await taskFixture(), checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const pipelines = new LinearPipelineServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => false }, () => now);
  const saved = await pipelines.createTemplate(f.identity, f.project.projectId, template);
  const pipeline = await pipelines.instantiate(f.identity, f.project.projectId,
    { templateId: saved.templateId, title: "Review the bounded result" }, "agent-review-pipeline-0001");
  for (const jobId of pipeline.jobIds.slice(0, 2)) {
    await f.db.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
      VALUES('tenant:web',$1,$2,$2,'{}'::jsonb,$3)`, [f.project.projectId, jobId, `hmac-sha256:${"9".repeat(64)}`]);
  }
  const gate = new CompletionGateStoreV1(f.client, key, checkpoints, () => at);
  await gate.provisionTenant("tenant:web");
  const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: "profile:agent-review", tenantId: "tenant:web", projectId: f.project.projectId, name: "Agent review",
    targetKind: "document", requiredVerificationScenarioIds: ["scenario:agent-review"], minimumIndependentReviews: 1,
    reviewerSeparation: { actor: true, worker: true, agentProfile: true, harness: true, modelFamily: true },
    verificationRequiresProducerSeparation: true, minimumRisk, maximumRevisionRounds: 3,
    automaticLowRiskDisposition: false, createdBy: { actorId: "identity:web", actorType: "human" }, createdAt: at };
  await gate.registerProfile(profile);
  const target: CompletionReviewTargetV1 = { schemaVersion: "control-room-completion-gate/v1", id: "target:agent-review",
    tenantId: "tenant:web", projectId: f.project.projectId, kind: "document", subjectId: pipeline.jobIds[0]!,
    subjectDigest: sha256Digest("retained build result"), acceptanceProfileId: profile.id,
    acceptanceProfileDigest: sha256Digest(profile), producer: { actorId: "node:codex:one", actorType: "agent",
      workerId: "worker:codex:one", agentProfileId: "agent-profile:codex.standard", harness: "codex",
      adapterId: "connector:codex-owner-trusted-local-v1", modelFamily: "model-family:openai" },
    rootTargetId: "target:agent-review", revisionNumber: 0, submittedAt: at };
  await gate.registerTarget(target);
  await f.db.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES('node:claude:one','tenant:web','active',1,'key:claude',$1::jsonb,$2,$2)`,
  [JSON.stringify({ id: "node:claude:one", tenantId: "tenant:web", state: "active", version: 1,
    identityKeyId: "key:claude" }), at]);
  await f.db.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,
    lease_epoch,payload,created_at,updated_at) VALUES('attempt:agent-review','tenant:web',$1,1,'succeeded',1,
    'worker:claude:one','node:claude:one',1,$2::jsonb,$3,$3)`, [pipeline.jobIds[1], JSON.stringify({
      id: "attempt:agent-review", tenantId: "tenant:web", state: "succeeded", version: 1,
      jobId: pipeline.jobIds[1], attemptNumber: 1, workerId: "worker:claude:one", nodeId: "node:claude:one",
      leaseEpoch: 1,
    }), at]);
  await f.db.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,
    native_session_key_digest,parent_run_id,revision_of_run_id,state,last_sequence,run_digest,run_auth_tag,payload,
    created_at,updated_at,last_observed_at) VALUES('run:agent-review','tenant:web',$1,$2,'attempt:agent-review',
    'node:claude:one','connector:claude-code-local-v1','claude',$3,NULL,NULL,'succeeded',1,$4,$5,'{}'::jsonb,$6,$6,$6)`,
  [f.project.projectId, pipeline.jobIds[1], `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`,
    `hmac-sha256:${"3".repeat(64)}`, at]);
  const routes = [{ nodeId: "node:claude:one", executorId: "worker:claude:one",
    capabilityProbeId: "harness.claude-code.local.v1" as const, maxConcurrentTasks: 1,
    requiredScratchBytes: 0, leaseSeconds: 60 }];
  const planner = new AgentReviewServiceV1(f.client, "tenant:web", key, checkpoints, routes, () => at);
  const plan = await planner.createPlan({ projectId: f.project.projectId, pipelineRunId: pipeline.runId,
    producerJobId: pipeline.jobIds[0], reviewerJobId: pipeline.jobIds[1], reviewerRunId: "run:agent-review",
    targetId: target.id });
  await f.db.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:web')");
  await f.db.exec(await readFile("db/roles/agent_reviewer_roles.sql", "utf8"));
  await f.db.exec(`CREATE ROLE agent_reviewer_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_agent_reviewer TO agent_reviewer_test;`);
  return { ...f, checkpoints, routes, pipeline, profile, target, plan, gate,
    reviewer: restricted(f.client, "agent_reviewer_test") };
}

test("only the exact server-created agent review plan can append a review", async t => {
  const f = await fixture("critical"); t.after(() => void f.db.close());
  const bound = (await f.db.query<Record<string, unknown>>(
    "SELECT * FROM control_agent_review_plans WHERE id=$1", [f.plan.planId])).rows[0]!;
  // A plan cannot move the review off the check stage: not onto the producer's
  // own build job, and not forward onto the signoff stage's job.
  for (const [column, value] of [["reviewer_job_id", f.pipeline.jobIds[0]], ["reviewer_job_id", f.pipeline.jobIds[2]],
    ["producer_job_id", f.pipeline.jobIds[1]], ["reviewer_run_id", "run:wrong"], ["project_id", "project:wrong"]] as const) {
    const changed = { ...bound, id: `agent-review-plan:wrong-${column}-${value}`, review_id: `review:wrong-${column}-${value}`,
      finding_id: `finding:wrong-${column}-${value}`, [column]: value };
    await assert.rejects(f.db.query(`INSERT INTO control_agent_review_plans(id,tenant_id,project_id,pipeline_run_id,
      producer_job_id,reviewer_job_id,reviewer_run_id,target_id,target_digest,acceptance_profile_id,
      acceptance_profile_digest,review_id,finding_id,reviewer,plan_digest,auth_tag,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)`,
    [changed.id, changed.tenant_id, changed.project_id, changed.pipeline_run_id, changed.producer_job_id,
      changed.reviewer_job_id, changed.reviewer_run_id, changed.target_id, changed.target_digest,
      changed.acceptance_profile_id, changed.acceptance_profile_digest, changed.review_id, changed.finding_id,
      JSON.stringify(changed.reviewer), changed.plan_digest, changed.auth_tag, changed.created_at]),
    /agent review plan binding rejected|foreign key constraint/u, column);
  }
  await assert.rejects(f.reviewer.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,
    subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at) VALUES('review:unbound','tenant:web',$1,'review',
    $2,$3,$3,$4,$5,$6::jsonb,$7)`, [f.project.projectId, sha256Digest("unbound key"), f.target.id,
    sha256Digest("unbound record"), `hmac-sha256:${"4".repeat(64)}`, JSON.stringify({ schemaVersion: "control-room-completion-gate/v1",
      id: "review:unbound", tenantId: "tenant:web", projectId: f.project.projectId, targetId: f.target.id,
      targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
      acceptanceProfileDigest: sha256Digest(f.profile), reviewer: f.plan.reviewer, authority: "completion_gate",
      decision: "accepted", assessedRisk: "low", effectiveRisk: "low", evidenceDigests: [sha256Digest("check")],
      findingIds: [], reviewedAt: at, grantsApproval: false, grantsExecutionAuthority: false }), at]),
  /permission denied/u);

  const state = async () => (await f.db.query("SELECT revision,record_count,state_digest,state_auth_tag FROM control_completion_gate_integrity WHERE tenant_id='tenant:web'")).rows[0];
  const before = await state();
  await assert.rejects(f.reviewer.query(`UPDATE control_completion_gate_integrity
    SET revision=revision+1,record_count=record_count+99 WHERE tenant_id='tenant:web'`), /permission denied/u);
  assert.deepEqual(await state(), before, "raw integrity rewrite is refused without state drift");
  const payload = { schemaVersion: "control-room-completion-gate/v1", id: f.plan.reviewId,
    tenantId: "tenant:web", projectId: f.project.projectId, targetId: f.target.id,
    targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile), reviewer: f.plan.reviewer, authority: "completion_gate",
    decision: "accepted", assessedRisk: "low", effectiveRisk: "low", evidenceDigests: [sha256Digest("check")],
    findingIds: [], reviewedAt: at, grantsApproval: false, grantsExecutionAuthority: false };
  const raw = (value: typeof payload, tag: string) => f.reviewer.query(`INSERT INTO control_completion_gate_records(
    id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at)
    VALUES($1,'tenant:web',$2,'review',$3,$4,$4,$5,$6,$7::jsonb,$8)`, [value.id,f.project.projectId,
    sha256Digest({ kind: "review", targetId: f.target.id, authority: "completion_gate", reviewerActorId: f.plan.reviewer.actorId }),
    f.target.id,sha256Digest(value),tag,JSON.stringify(value),at]);
  await assert.rejects(raw(payload, `hmac-sha256:${"5".repeat(64)}`), /permission denied/u);
  assert.deepEqual(await state(), before, "below-floor raw insert is refused without state drift");
  const floored = { ...payload, effectiveRisk: "critical" as const };
  await assert.rejects(raw(floored, `hmac-sha256:${"a".repeat(64)}`), /permission denied/u);
  assert.deepEqual(await state(), before, "fabricated-tag raw insert is refused without state drift");
  // The raw-insert trigger is an independent layer: a rogue INSERT grant on the
  // reviewer group still leaves both inserts refused by the trigger itself.
  await f.db.exec("GRANT INSERT ON control_completion_gate_records TO control_room_agent_reviewer");
  await assert.rejects(raw(payload, `hmac-sha256:${"5".repeat(64)}`), /agent reviewer raw insert rejected/u);
  await assert.rejects(raw(floored, `hmac-sha256:${"a".repeat(64)}`), /agent reviewer raw insert rejected/u);
  await f.db.exec("REVOKE INSERT ON control_completion_gate_records FROM control_room_agent_reviewer");
  assert.deepEqual(await state(), before, "rogue-grant raw inserts are refused without state drift");
  await assert.rejects(f.reviewer.query("SELECT * FROM commit_agent_review($1,$2::jsonb,NULL,$3::bytea)",
    [f.plan.planId,JSON.stringify(floored),new Uint8Array(32).fill(99)]), /integrity key rejected/u);
  assert.deepEqual(await state(), before, "wrong-key function call is refused without state drift");

  const service = new AgentReviewServiceV1(f.reviewer, "tenant:web", key, f.checkpoints, f.routes, () => at);
  const saved = await service.record({ planId: f.plan.planId, decision: "accepted", assessedRisk: "low",
    evidenceDigests: [sha256Digest("retained checker result")] });
  assert.equal(saved.review.id, f.plan.reviewId);
  assert.deepEqual(saved.review.reviewer, f.plan.reviewer);
  assert.equal(saved.grantsApproval, false);
  assert.equal(saved.grantsExecutionAuthority, false);
  assert.equal(saved.review.effectiveRisk, "critical", "the database boundary agrees with the service risk floor");
  const replay = await service.record({ planId: f.plan.planId, decision: "accepted", assessedRisk: "low",
    evidenceDigests: [sha256Digest("retained checker result")] });
  assert.equal(replay.replayed, true, "an exact accepted review retry remains idempotent");
  await f.gate.verifyProvisionedTenantV1("tenant:web");
  await assert.rejects(f.reviewer.query("DELETE FROM control_completion_gate_records WHERE id=$1", [f.plan.reviewId]));
  await assert.rejects(f.reviewer.query("INSERT INTO control_jobs(id) VALUES('job:forged')"));
});

test("a plan-bound changes request appends its server-preallocated finding", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const service = new AgentReviewServiceV1(f.reviewer, "tenant:web", key, f.checkpoints, f.routes, () => at);
  const statementDigest = sha256Digest("bounded reviewer finding");
  const saved = await service.record({ planId: f.plan.planId, decision: "changes_requested", assessedRisk: "medium",
    evidenceDigests: [sha256Digest("retained checker result")], findingStatementDigest: statementDigest });
  assert.deepEqual(saved.review.findingIds, [f.plan.findingId]);
  const replayed = await service.record({ planId: f.plan.planId, decision: "changes_requested", assessedRisk: "medium",
    evidenceDigests: [sha256Digest("retained checker result")], findingStatementDigest: statementDigest });
  assert.equal(replayed.replayed, true, "an exact changes-requested retry remains idempotent");
  await f.gate.verifyProvisionedTenantV1("tenant:web");
  const finding = (await f.db.query<{ payload: { statementDigest: string; reviewId: string } }>(
    "SELECT payload FROM control_completion_gate_records WHERE tenant_id='tenant:web' AND id=$1", [f.plan.findingId])).rows[0];
  assert.equal(finding?.payload.statementDigest, statementDigest);
  assert.equal(finding?.payload.reviewId, f.plan.reviewId);
});

test("the reviewer commit refuses to authenticate pre-existing record drift", async t => {
  const f = await fixture("critical"); t.after(() => void f.db.close());
  const integrity = async () => (await f.db.query(
    "SELECT revision,record_count,state_digest,state_auth_tag FROM control_completion_gate_integrity WHERE tenant_id='tenant:web'"
  )).rows[0];
  const checkpoint = await f.checkpoints.read("completion-gate:tenant:web"), before = await integrity();
  const rogue = { schemaVersion: "control-room-completion-gate/v1", id: "review:rogue-drift",
    tenantId: "tenant:web", projectId: f.project.projectId, targetId: f.target.id,
    targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile), reviewer: f.plan.reviewer, authority: "completion_gate",
    decision: "accepted", assessedRisk: "critical", effectiveRisk: "critical",
    evidenceDigests: [sha256Digest("rogue drift")], findingIds: [], reviewedAt: at,
    grantsApproval: false, grantsExecutionAuthority: false };
  await f.db.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
    parent_id,record_digest,record_auth_tag,payload,occurred_at) VALUES($1,'tenant:web',$2,'review',$3,$4,$4,$5,$6,$7::jsonb,$8)`,
  [rogue.id,f.project.projectId,sha256Digest({ kind: "review", targetId: f.target.id, authority: "completion_gate",
    reviewerActorId: f.plan.reviewer.actorId }),f.target.id,sha256Digest(rogue),`hmac-sha256:${"b".repeat(64)}`,
    JSON.stringify(rogue),at]);
  const service = new AgentReviewServiceV1(f.reviewer, "tenant:web", key, f.checkpoints, f.routes, () => at);
  await assert.rejects(service.record({ planId: f.plan.planId, decision: "accepted", assessedRisk: "low",
    evidenceDigests: [sha256Digest("retained checker result")] }), /integrity_failed|existing record integrity rejected/u);
  assert.deepEqual(await integrity(), before, "the integrity row is not advanced over rogue data");
  assert.deepEqual(await f.checkpoints.read("completion-gate:tenant:web"), checkpoint,
    "the external checkpoint is not advanced over rogue data");
});

test("the reviewer commit preserves pairwise reviewer separation after planning", async t => {
  const f = await fixture(); t.after(() => void f.db.close());
  const prior = { schemaVersion: "control-room-completion-gate/v1" as const, id: "review:prior-independent-actor",
    tenantId: "tenant:web", projectId: f.project.projectId, targetId: f.target.id,
    targetDigest: sha256Digest(f.target), acceptanceProfileId: f.profile.id,
    acceptanceProfileDigest: sha256Digest(f.profile), reviewer: { ...f.plan.reviewer, actorId: "node:prior-reviewer" },
    authority: "completion_gate" as const, decision: "accepted" as const, assessedRisk: "low" as const,
    effectiveRisk: "low" as const, evidenceDigests: [sha256Digest("prior review")], findingIds: [], reviewedAt: at,
    grantsApproval: false as const, grantsExecutionAuthority: false as const };
  await f.gate.recordReview(prior);
  const service = new AgentReviewServiceV1(f.reviewer, "tenant:web", key, f.checkpoints, f.routes, () => at);
  await assert.rejects(service.record({ planId: f.plan.planId, decision: "accepted", assessedRisk: "low",
    evidenceDigests: [sha256Digest("retained checker result")] }), /integrity_failed|current state rejected/u);
  assert.equal((await f.db.query<{count:string}>("SELECT count(*)::text AS count FROM control_completion_gate_records WHERE id=$1",
    [f.plan.reviewId])).rows[0]?.count, "0");
});
