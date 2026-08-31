import assert from "node:assert/strict";
import test from "node:test";
import {
  IdeaLabErrorV1,
  assertProjectLifecycleTransitionV1,
  buildIdeaLabContributionV1,
  buildIdeaLabDecisionV1,
  buildIdeaLabFixtureV1,
  buildIdeaLabSessionV1,
  buildIdeaLabSynthesisV1,
  parseIdeaLabSessionV1,
  parseProjectRegistryProjectionV1,
} from "../src/idea-lab/v1/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

function expectCode(operation: () => unknown, code: IdeaLabErrorV1["safeCode"]): void {
  assert.throws(operation, (error: unknown) => error instanceof IdeaLabErrorV1 && error.safeCode === code);
}

test("CR12B-IDEA-000 builds a bounded diverse panel, derived synthesis, owner decision, and monitored project", () => {
  const fixture = buildIdeaLabFixtureV1();
  assert.deepEqual(fixture.session.participants.map((item) => item.perspective), ["customer", "market", "skeptic", "operations"]);
  assert.equal(fixture.session.maxMessages, fixture.session.participants.length * fixture.session.maxRounds);
  assert.equal(fixture.synthesis.overallScore, 75);
  assert.equal(fixture.synthesis.recommendation, "promote");
  assert.equal(fixture.synthesis.ownerDecisionRequired, true);
  assert.equal(fixture.decision.automaticDecision, false);
  assert.equal(fixture.decision.decision, "create_project");
  assert.equal(fixture.promotedProject.lifecycleState, "active");
  assert.equal(fixture.promotedProject.monitoringPagePath, "/projects/project%3Alocal-trades-ai-desk");
  assert.deepEqual(parseProjectRegistryProjectionV1(fixture.promotedProject), fixture.promotedProject);
  for (const value of [fixture.session, ...fixture.contributions, fixture.synthesis]) {
    assert.equal(value.liveBotContactAuthorized, false);
    assert.equal(value.providerContacted, false);
    assert.equal(value.grantsExecutionAuthority, false);
  }
});
test("CR12B-IDEA-000 requires distinct identities, distinct perspectives, and a skeptic", () => {
  const fixture = buildIdeaLabFixtureV1();
  const base = { sessionId: "idea-session:bad", tenantId: fixture.session.tenantId, workspaceId: fixture.session.workspaceId,
    title: fixture.session.title, ideaSummary: fixture.session.ideaSummary, targetCustomer: fixture.session.targetCustomer,
    participants: fixture.session.participants, maxRounds: 1, maxDurationSeconds: 60, maxCostUsd: 0,
    createdByIdentityDigest: fixture.session.createdByIdentityDigest, createdAt: fixture.session.createdAt };
  expectCode(() => buildIdeaLabSessionV1({ ...base, participants: base.participants.map((item) => item.perspective === "skeptic" ? { ...item, perspective: "risk" } : item) }), "invalid_input");
  expectCode(() => buildIdeaLabSessionV1({ ...base, participants: base.participants.map((item, index) => index === 1 ? { ...item, identityDigest: base.participants[0]!.identityDigest } : item) }), "invalid_input");
  expectCode(() => buildIdeaLabSessionV1({ ...base, participants: base.participants.map((item, index) => index === 1 ? { ...item, perspective: base.participants[0]!.perspective } : item) }), "invalid_input");
});

test("CR12B-IDEA-000 refuses incomplete panels and derives recommendation instead of trusting a caller", () => {
  const fixture = buildIdeaLabFixtureV1();
  expectCode(() => buildIdeaLabSynthesisV1(fixture.session, fixture.contributions.slice(0, 3), {
    marketDemand: 99, feasibility: 99, differentiation: 99, durability: 99, ownerFit: 99, riskPercent: 1,
    executiveSummary: "Caller cannot omit the skeptic or another required panel member.", nextExperiment: "Do not run.",
    dissentingPerspectiveCodes: [], synthesizedAt: fixture.synthesis.synthesizedAt }), "panel_incomplete");
  const lower = buildIdeaLabSynthesisV1(fixture.session, fixture.contributions, {
    marketDemand: 20, feasibility: 20, differentiation: 20, durability: 20, ownerFit: 20, riskPercent: 80,
    executiveSummary: "The measured case is weak.", nextExperiment: "Save the notes and stop.", dissentingPerspectiveCodes: ["weak_case"],
    synthesizedAt: fixture.synthesis.synthesizedAt });
  assert.equal(lower.overallScore, 20); assert.equal(lower.recommendation, "reject");
});

test("CR12B-IDEA-000 only creates a project after an explicit, chronological owner decision", () => {
  const fixture = buildIdeaLabFixtureV1();
  expectCode(() => buildIdeaLabDecisionV1(fixture.session, fixture.synthesis, fixture.contributions, {
    decision: "create_project", safeReasonCode: "missing_project", ownerIdentityDigest: fixture.decision.ownerIdentityDigest,
    decidedAt: fixture.decision.decidedAt }), "invalid_input");
  expectCode(() => buildIdeaLabDecisionV1(fixture.session, fixture.synthesis, fixture.contributions, {
    decision: "save", safeReasonCode: "save_for_later", ownerIdentityDigest: fixture.decision.ownerIdentityDigest,
    project: fixture.decision.project, decidedAt: fixture.decision.decidedAt }), "invalid_input");
  expectCode(() => buildIdeaLabDecisionV1(fixture.session, fixture.synthesis, fixture.contributions, {
    decision: "reject", safeReasonCode: "owner_rejected", ownerIdentityDigest: fixture.decision.ownerIdentityDigest,
    decidedAt: "2026-08-31T16:05:00.000Z" }), "invalid_input");
});

test("CR12B-IDEA-000 enforces the reversible project lifecycle", () => {
  assert.doesNotThrow(() => assertProjectLifecycleTransitionV1("active", "paused"));
  assert.doesNotThrow(() => assertProjectLifecycleTransitionV1("paused", "active"));
  assert.doesNotThrow(() => assertProjectLifecycleTransitionV1("active", "completed"));
  assert.doesNotThrow(() => assertProjectLifecycleTransitionV1("completed", "archived"));
  assert.doesNotThrow(() => assertProjectLifecycleTransitionV1("archived", "active"));
  expectCode(() => assertProjectLifecycleTransitionV1("active", "archived"), "state_conflict");
  expectCode(() => assertProjectLifecycleTransitionV1("completed", "active"), "state_conflict");
});

test("CR12B-IDEA-000 exact boundaries reject tampering, secrets, accessors, and Proxies without invoking traps", () => {
  const fixture = buildIdeaLabFixtureV1();
  expectCode(() => parseIdeaLabSessionV1({ ...fixture.session, title: "Changed after digest" }), "integrity_failed");
  expectCode(() => buildIdeaLabContributionV1(fixture.session, { participantId: "bot:customer", round: 1,
    safeOpinion: "api_key=unsafe-secret-value", opportunityCode: "unsafe", primaryRiskCode: "secret",
    suggestedExperiment: "Do not retain this.", confidencePercent: 1, contributedAt: fixture.contributions[0]!.contributedAt }), "redaction_rejected");
  let getters = 0; const accessor = { ...fixture.session };
  Object.defineProperty(accessor, "title", { enumerable: true, get() { getters += 1; return fixture.session.title; } });
  expectCode(() => parseIdeaLabSessionV1(accessor), "invalid_input"); assert.equal(getters, 0);
  const proxy = observedProxy({ ...fixture.session }, "transparent");
  expectCode(() => parseIdeaLabSessionV1(proxy.value), "invalid_input"); assert.equal(proxy.trapCount(), 0);
});
