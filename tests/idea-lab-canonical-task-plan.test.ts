import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabOwnerPromptV1 } from "../src/idea-lab/v1/discussion-prompt";
import { buildIdeaLabCanonicalTaskPlanV1, parseIdeaLabCanonicalTaskPlanV1 } from "../src/idea-lab/v1/canonical-task-plan";
import { IdeaLabErrorV1 } from "../src/idea-lab/v1/errors";

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
