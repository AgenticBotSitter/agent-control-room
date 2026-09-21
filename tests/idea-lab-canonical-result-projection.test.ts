import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { CanonicalIdeaTaskResultProjectionServiceV1 } from "../src/idea-lab/v1/canonical-result-projection";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { buildIdeaLabCanonicalTaskPlanV1 } from "../src/idea-lab/v1/canonical-task-plan";
import { buildIdeaLabOwnerPromptV1 } from "../src/idea-lab/v1/discussion-prompt";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { at } from "./native-task-fixture";
import { binding } from "./hermes-native-fixture";

const structured = JSON.stringify({ safeOpinion: "Start with a small owner-reviewed trial before a broad release.",
  opportunityCode: "small_trial", primaryRiskCode: "weak_signal",
  suggestedExperiment: "Interview ten prospective owners with the same questionnaire.", confidencePercent: 68 });

async function fixture() {
  const f = await ownerReviewFixture(undefined, structured);
  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:reviewed-task-result", tenantId: f.scope.tenantId,
    workspaceId: f.scope.workspaceId, title: source.session.title, ideaSummary: source.session.ideaSummary,
    targetCustomer: source.session.targetCustomer, participants: source.session.participants,
    maxRounds: source.session.maxRounds, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest,
    createdAt: source.session.createdAt });
  const key = new Uint8Array(32).fill(0x4d);
  const registry = new IdeaLabProjectRegistryStoreV1(f.db, key), links = new IdeaLabCanonicalTaskLinkStoreV1(f.db, key);
  await registry.registerSession(session);
  const plan = buildIdeaLabCanonicalTaskPlanV1({ session, projectId: binding.projectId,
    participantId: session.participants[0]!.participantId, round: 1,
    ownerPrompt: buildIdeaLabOwnerPromptV1(session), contributions: [] });
  await links.record(plan, { jobId: binding.jobId, projectId: binding.projectId, requestId: "request:idea-projection",
    createdAt: at(1000), submission: "proposed", startsWork: false });
  const service = new CanonicalIdeaTaskResultProjectionServiceV1(f.db, registry, links, f.results, f.reviewStore,
    f.reviewKey, () => at(7000));
  return { f, session, plan, registry, service };
}

async function accept(f: Awaited<ReturnType<typeof fixture>>["f"]) {
  const saved = await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, "idea-projection-owner-review");
  await f.reviewStore.recordVerification({ schemaVersion: "control-room-completion-gate/v1", id: "verification:idea-projection",
    tenantId: f.scope.tenantId, projectId: binding.projectId, targetId: f.target.id, targetDigest: sha256Digest(f.target),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile), scenarioId: "scenario:content",
    outcome: "passed", verifier: { actorId: "service:idea-projection-verifier", actorType: "service" },
    evidenceDigests: [f.artifact.contentHash], verifiedAt: at(6500), grantsApproval: false, grantsExecutionAuthority: false });
  return saved;
}

test("only one accepted ordinary task result becomes canonical Idea Lab evidence", async t => {
  const x = await fixture(); t.after(x.f.close);
  await assert.rejects(x.service.project({ tenantId: x.session.tenantId, sessionId: x.session.sessionId, taskKey: x.plan.taskKey }));
  const review = await accept(x.f);
  const saved = await x.service.project({ tenantId: x.session.tenantId, sessionId: x.session.sessionId, taskKey: x.plan.taskKey });
  assert.equal(saved.replayed, false);
  assert.equal(saved.contribution.sourceMode, "canonical_task_result");
  assert.equal(saved.contribution.canonicalTaskEvidence?.artifactId, x.f.artifact.artifactId);
  assert.deepEqual(saved.contribution.canonicalTaskEvidence?.acceptedReviewIds, [review.receipt.reviewId]);
  const replay = await x.service.project({ tenantId: x.session.tenantId, sessionId: x.session.sessionId, taskKey: x.plan.taskKey });
  assert.equal(replay.replayed, true);
  assert.equal((await x.registry.listContributions(x.session.tenantId, x.session.sessionId)).length, 1);
});

test("malformed ordinary task output and a wrong task key fail closed", async t => {
  const x = await fixture(); t.after(x.f.close); await accept(x.f);
  await assert.rejects(x.service.project({ tenantId: x.session.tenantId, sessionId: x.session.sessionId, taskKey: "idea-task:missing" }));
  const bad = await ownerReviewFixture(undefined, "not a structured result"); t.after(bad.close);
  const source = buildIdeaLabFixtureV1(), session = buildIdeaLabSessionV1({ sessionId: "idea:bad-task-result", tenantId: bad.scope.tenantId,
    workspaceId: bad.scope.workspaceId, title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: source.session.maxRounds, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: source.session.createdAt });
  const key = new Uint8Array(32).fill(0x5d), registry = new IdeaLabProjectRegistryStoreV1(bad.db, key), links = new IdeaLabCanonicalTaskLinkStoreV1(bad.db, key);
  await registry.registerSession(session);
  const plan = buildIdeaLabCanonicalTaskPlanV1({ session, projectId: binding.projectId, participantId: session.participants[0]!.participantId,
    round: 1, ownerPrompt: buildIdeaLabOwnerPromptV1(session), contributions: [] });
  await links.record(plan, { jobId: binding.jobId, projectId: binding.projectId, requestId: "request:bad-idea-projection", createdAt: at(1000), submission: "proposed", startsWork: false });
  await accept(bad);
  const service = new CanonicalIdeaTaskResultProjectionServiceV1(bad.db, registry, links, bad.results, bad.reviewStore, bad.reviewKey, () => at(7000));
  await assert.rejects(service.project({ tenantId: session.tenantId, sessionId: session.sessionId, taskKey: plan.taskKey }));
});
