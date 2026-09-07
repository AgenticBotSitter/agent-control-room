import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1, buildIdeaLabContributionV1 } from "../src/idea-lab/v1";
import { DeterministicIdeaLabSynthesisEngineV1 } from "../src/idea-lab/v1/synthesis-engine";

test("recap uses every final perspective, exact repeated experiments and stable input ordering", () => {
  const f = buildIdeaLabFixtureV1(), engine = new DeterministicIdeaLabSynthesisEngineV1();
  const contributions = [1, 2].flatMap(round => f.session.participants.map((p, i) => buildIdeaLabContributionV1(f.session,
    { participantId: p.participantId, round, safeOpinion: round === 1 ? "Old opinion" : `Final ${p.perspective} ${"x".repeat(700)}`,
      opportunityCode: "test", primaryRiskCode: "untested_demand", suggestedExperiment: i < 3 ? "Interview two owners" : "Build a prototype",
      confidencePercent: i < 3 ? 10 : 100, contributedAt: f.synthesis.synthesizedAt })));
  const recap = engine.build(f.session, contributions, f.synthesis.synthesizedAt);
  assert.equal(recap.executiveSummary.includes("Old opinion"), false);
  for (const p of f.session.participants) assert.ok(recap.executiveSummary.includes(`Final ${p.perspective}`));
  assert.ok(recap.executiveSummary.length <= 800); assert.ok(recap.executiveSummary.includes("not an AI consensus"));
  assert.equal(recap.nextExperiment, "Interview two owners");
  assert.equal(engine.build(f.session, [...contributions].reverse(), f.synthesis.synthesizedAt).synthesisDigest, recap.synthesisDigest);
  assert.throws(() => engine.build(f.session, contributions.slice(1), f.synthesis.synthesizedAt), /panel_incomplete/);
  assert.throws(() => engine.build(f.session, [...contributions.slice(1), contributions[1]!], f.synthesis.synthesizedAt), /panel_incomplete/);
  assert.equal(recap.grantsExecutionAuthority, false); assert.equal(recap.automaticProjectCreationAllowed, false);
});
