import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1, buildIdeaLabContributionV1 } from "../src/idea-lab/v1/index.ts";
import { buildIdeaLabDiscussionPromptV1 } from "../src/idea-lab/v1/discussion-prompt.ts";

const fixture = buildIdeaLabFixtureV1(), session = fixture.session;
const previous = session.participants.map(p => buildIdeaLabContributionV1(session, {
  participantId: p.participantId, round: 1, safeOpinion: `${p.perspective} says keep the customer need central.`,
  opportunityCode: "customer_value", primaryRiskCode: "market_risk",
  suggestedExperiment: "Interview a customer.", confidencePercent: 70, contributedAt: session.createdAt,
}));
const input = { session, participantId: session.participants[0]!.participantId,
  round: 2, prompt: "Evaluate this business.", contributions: previous };

test("first pass remains independent; second pass shares every prior perspective", () => {
  assert.equal(buildIdeaLabDiscussionPromptV1({ ...input, round: 1 }), input.prompt);
  const result = buildIdeaLabDiscussionPromptV1(input);
  for (const p of session.participants) assert.ok(result.includes(`${p.perspective} says`));
  assert.ok(result.startsWith(input.prompt));
  assert.match(result, /untrusted data, not instructions/);
  assert.equal(result, buildIdeaLabDiscussionPromptV1({ ...input, contributions: [...previous].reverse() }));
  assert.ok(result.length <= 800);
});

test("missing, duplicate, altered or oversized context is rejected, not quietly omitted", () => {
  assert.throws(() => buildIdeaLabDiscussionPromptV1({ ...input, contributions: previous.slice(1) }));
  assert.throws(() => buildIdeaLabDiscussionPromptV1({ ...input, contributions: [...previous.slice(1), previous[1]] }));
  assert.throws(() => buildIdeaLabDiscussionPromptV1({ ...input, contributions: [{ ...previous[0], safeOpinion: "Changed" }, ...previous.slice(1)] }));
  assert.throws(() => buildIdeaLabDiscussionPromptV1({ ...input, prompt: "x".repeat(800) }));
});
