import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabContributionV1, buildIdeaLabDecisionV1, buildIdeaLabSessionV1,
  buildIdeaLabSynthesisV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IDEA_LAB_PROMOTION_TASK_LINK_V1, IdeaLabPromotionTaskLinkStoreV1 } from "../src/idea-lab/v1/promotion-task-link-store";
import { WebTaskService } from "../src/web/v1/task-service";
import { ideaDecisionDraftSchema, ideaDecisionReceiptSchema } from "../src/web/v1/idea-wire";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";

test("promotion wire contracts require one non-running first-task proposal", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const intent = { decision: "create_project" as const, safeReasonCode: "owner_selected",
    project: { projectId: "project:promotion-wire", workspaceName: "Promotion", title: "Promotion",
      summary: "A bounded promoted project.", projectKind: "business_validation", priority: 50 } };
  assert.equal(ideaDecisionDraftSchema.safeParse({ sessionDigest: digest, synthesisDigest: digest, intent }).success, false);
  assert.equal(ideaDecisionDraftSchema.safeParse({ sessionDigest: digest, synthesisDigest: digest, intent,
    promotionTask: { title: "First task", instructions: "Run a bounded validation." } }).success, true);
  const receipt = { sessionId: "idea:promotion-wire", sessionDigest: digest, synthesisDigest: digest,
    decisionDigest: digest, decision: "create_project" as const, projectId: "project:promotion-wire",
    firstTask: { receipt: { jobId: "job:promotion-wire", projectId: "project:promotion-wire",
      requestId: "request:promotion-wire", createdAt: "2026-09-29T00:00:00.000Z", submission: "proposed" as const,
      startsWork: false as const }, replayed: false }, replayed: false, startsWork: false as const };
  assert.equal(ideaDecisionReceiptSchema.safeParse(receipt).success, true);
  assert.equal(ideaDecisionReceiptSchema.safeParse({ ...receipt,
    firstTask: { ...receipt.firstTask, receipt: { ...receipt.firstTask.receipt, startsWork: true } } }).success, false);
});

test("an Idea promotion links exactly one ordinary proposed first task without execution authority", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const source = buildIdeaLabFixtureV1(), key = new Uint8Array(32).fill(0x61);
  const session = buildIdeaLabSessionV1({ sessionId: "idea:promotion-task-link",
    tenantId: "tenant:web", workspaceId: "workspace:web", title: source.session.title,
    ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: source.session.maxRounds,
    maxDurationSeconds: source.session.maxDurationSeconds, maxCostUsd: source.session.maxCostUsd,
    createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: source.session.createdAt });
  const contributions = source.contributions.map(contribution => buildIdeaLabContributionV1(session, {
    participantId: contribution.participantId, round: contribution.round, safeOpinion: contribution.safeOpinion,
    opportunityCode: contribution.opportunityCode, primaryRiskCode: contribution.primaryRiskCode,
    suggestedExperiment: contribution.suggestedExperiment, confidencePercent: contribution.confidencePercent,
    contributedAt: contribution.contributedAt,
  }));
  const synthesis = buildIdeaLabSynthesisV1(session, contributions, {
    marketDemand: source.synthesis.marketDemand, feasibility: source.synthesis.feasibility,
    differentiation: source.synthesis.differentiation, durability: source.synthesis.durability,
    ownerFit: source.synthesis.ownerFit, riskPercent: source.synthesis.riskPercent,
    executiveSummary: source.synthesis.executiveSummary, nextExperiment: source.synthesis.nextExperiment,
    dissentingPerspectiveCodes: source.synthesis.dissentingPerspectiveCodes, synthesizedAt: source.synthesis.synthesizedAt,
  });
  const decision = buildIdeaLabDecisionV1(session, synthesis, contributions, {
    decision: "create_project", safeReasonCode: "owner_promoted_for_validation",
    ownerIdentityDigest: source.decision.ownerIdentityDigest,
    project: { projectId: "project:promoted-idea", workspaceName: "Promoted idea", title: "Promoted idea",
      summary: "Validate the smallest useful experiment before any execution.", projectKind: "business_validation", priority: 50 },
    decidedAt: source.decision.decidedAt,
  });
  const registry = new IdeaLabProjectRegistryStoreV1(f.client, key);
  await f.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter.control-room-native-ideas','tenant:web','control_room_native_ideas','1.0.0','control_room_native',
      'online','["business_validation"]'::jsonb,'["read_project"]'::jsonb,'[]'::jsonb,'v1',30)`);
  await registry.registerSession(session);
  for (const contribution of contributions) await registry.recordContribution(contribution);
  await registry.recordSynthesis(synthesis);
  await registry.recordDecision(decision);

  const tasks = new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now,
    { ideaIntegrityKey: key });
  const proposed = await tasks.propose(f.identity, decision.project!.projectId,
    { title: "Run the first validation", instructions: synthesis.nextExperiment }, `idea-promotion:${decision.decisionDigest.slice(7)}`);
  assert.equal(proposed.receipt.submission, "proposed");
  assert.equal(proposed.receipt.startsWork, false);
  assert.equal((await f.client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
    [session.tenantId, proposed.receipt.jobId])).rows[0]?.count, "0");
  assert.equal((await f.client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1 AND job_id=$2",
    [session.tenantId, proposed.receipt.jobId])).rows[0]?.count, "0");
  assert.equal((await f.client.query<{ state: string }>(
    "SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2",
    [session.tenantId, proposed.receipt.jobId])).rows[0]?.state, "proposed");

  const links = new IdeaLabPromotionTaskLinkStoreV1(f.client, key);
  const input = { contractVersion: IDEA_LAB_PROMOTION_TASK_LINK_V1, tenantId: session.tenantId,
    sessionId: session.sessionId, decisionDigest: decision.decisionDigest, projectId: decision.project!.projectId,
    jobId: proposed.receipt.jobId, requestId: proposed.receipt.requestId, createdAt: proposed.receipt.createdAt,
    startsWork: false as const, grantsAssignmentAuthority: false as const, grantsApproval: false as const,
    grantsExecutionAuthority: false as const };
  const saved = await links.record(input);
  assert.equal(saved.replayed, false);
  assert.equal(saved.link.jobId, proposed.receipt.jobId);
  assert.equal(saved.link.grantsExecutionAuthority, false);
  assert.deepEqual(await links.get(session.tenantId, session.sessionId), saved.link);
  assert.equal((await links.record(input)).replayed, true);
  await assert.rejects(links.record({ ...input, jobId: "job:changed" }));
});
