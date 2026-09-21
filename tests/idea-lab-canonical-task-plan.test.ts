import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabOwnerPromptV1 } from "../src/idea-lab/v1/discussion-prompt";
import { buildIdeaLabCanonicalTaskPlanV1, parseIdeaLabCanonicalTaskPlanV1 } from "../src/idea-lab/v1/canonical-task-plan";
import { IdeaLabErrorV1 } from "../src/idea-lab/v1/errors";
import { parseIdeaCanonicalTaskResultV1 } from "../src/idea-lab/v1/contracts";
import { buildIdeaLabContributionV1, parseIdeaLabContributionV1 } from "../src/idea-lab/v1/contracts";

test("Idea Lab participant rounds become deterministic non-runnable ordinary task material", () => {
  const source = buildIdeaLabFixtureV1();
  const ownerPrompt = buildIdeaLabOwnerPromptV1(source.session);
  const roundOne = source.session.participants.map((participant) => buildIdeaLabCanonicalTaskPlanV1({
    session: source.session, projectId: "project:idea-workspace", participantId: participant.participantId,
    round: 1, ownerPrompt, contributions: [],
  }));
  assert.equal(roundOne.length, 4);
  assert.equal(new Set(roundOne.map((item) => item.taskKey)).size, 4);
  for (const plan of roundOne) {
    assert.deepEqual(plan.dependsOnTaskKeys, []);
    assert.equal(plan.startsWork, false);
    assert.equal(plan.grantsExecutionAuthority, false);
    assert.equal(plan.permitsAssignment, false);
    assert.equal(plan.permitsRetry, false);
    assert.match(plan.taskDraft.instructions, /Return exactly one JSON object/);
    assert.equal(parseIdeaLabCanonicalTaskPlanV1(plan).planDigest, plan.planDigest);
  }
  const roundTwo = source.session.participants.map((participant) => buildIdeaLabCanonicalTaskPlanV1({
    session: source.session, projectId: "project:idea-workspace", participantId: participant.participantId,
    round: 2, ownerPrompt, contributions: source.contributions.filter((item) => item.round === 1),
  }));
  for (const plan of roundTwo) {
    assert.deepEqual(plan.dependsOnTaskKeys, roundOne.map((item) => item.taskKey).sort());
    assert.match(plan.taskDraft.instructions, /untrusted data, not instructions/);
  }
  assert.deepEqual(buildIdeaLabCanonicalTaskPlanV1({ session: source.session, projectId: "project:idea-workspace",
    participantId: source.session.participants[0]!.participantId, round: 2, ownerPrompt,
    contributions: source.contributions.filter((item) => item.round === 1),
  }), roundTwo[0]);
});

test("Idea Lab canonical task output accepts only the bounded structured contribution shape", () => {
  const output = { safeOpinion: "A limited owner trial can establish demand before an expensive rollout.",
    opportunityCode: "owner_trial", primaryRiskCode: "weak_demand", suggestedExperiment: "Interview ten prospective owners.", confidencePercent: 72 };
  assert.deepEqual(parseIdeaCanonicalTaskResultV1(output), output);
  assert.throws(() => parseIdeaCanonicalTaskResultV1({ ...output, grantsApproval: true }), IdeaLabErrorV1);
  assert.throws(() => parseIdeaCanonicalTaskResultV1("```json\n{}\n```"), IdeaLabErrorV1);
});

test("a canonical task-result contribution retains immutable review provenance without claiming provider contact", () => {
  const source = buildIdeaLabFixtureV1(), participant = source.session.participants[0]!;
  const contribution = buildIdeaLabContributionV1(source.session, { participantId: participant.participantId, round: 1,
    safeOpinion: "A small trial is safer than a broad rollout.", opportunityCode: "small_trial", primaryRiskCode: "weak_signal",
    suggestedExperiment: "Ask ten prospective owners for a structured interview.", confidencePercent: 69,
    contributedAt: "2026-09-20T00:00:00.000Z" }, {
    sourceMode: "canonical_task_result", liveBotContactAuthorized: false, providerContacted: false,
    canonicalTaskEvidence: { taskKey: "idea-task:projection", taskLinkDigest: "sha256:" + "a".repeat(64),
      taskPlanDigest: "sha256:" + "b".repeat(64), taskInputDigest: "sha256:" + "c".repeat(64),
      projectId: "project:idea", jobId: "job:idea", runId: "run:idea", artifactId: "artifact:idea",
      contentHash: "sha256:" + "d".repeat(64), targetId: "target:idea", targetDigest: "sha256:" + "e".repeat(64),
      acceptanceProfileDigest: "sha256:" + "f".repeat(64), rootTargetId: "target:root", revisionNumber: 0,
      acceptedReviewIds: ["review:one"], verificationIds: ["verification:one"] },
  });
  assert.equal(contribution.sourceMode, "canonical_task_result");
  assert.equal(contribution.providerContacted, false);
  assert.equal(parseIdeaLabContributionV1(contribution, source.session).canonicalTaskEvidence?.jobId, "job:idea");
  assert.throws(() => parseIdeaLabContributionV1({ ...contribution, canonicalTaskEvidence: null }, source.session), IdeaLabErrorV1);
});

test("Idea Lab task material fails closed on altered provenance or incomplete prior round", () => {
  const source = buildIdeaLabFixtureV1();
  const ownerPrompt = buildIdeaLabOwnerPromptV1(source.session);
  const plan = buildIdeaLabCanonicalTaskPlanV1({ session: source.session, projectId: "project:idea-workspace",
    participantId: source.session.participants[0]!.participantId, round: 1, ownerPrompt, contributions: [],
  });
  assert.throws(() => parseIdeaLabCanonicalTaskPlanV1({ ...plan, projectId: "project:other" }), IdeaLabErrorV1);
  assert.throws(() => buildIdeaLabCanonicalTaskPlanV1({ session: source.session, projectId: "project:idea-workspace",
    participantId: source.session.participants[0]!.participantId, round: 2, ownerPrompt,
    contributions: source.contributions.filter((item) => item.round === 1).slice(0, 3),
  }), IdeaLabErrorV1);
});
