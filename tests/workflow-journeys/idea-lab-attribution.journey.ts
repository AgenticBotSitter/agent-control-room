/**
 * Issue #208 journey: a bounded, attributed Idea Lab panel.
 *
 * One panel runs to completion with retained, attributed contributions; a second
 * saved run loses one participant's provider outcome and must retain what landed
 * and show the partial failure instead of retrying; a promoted panel must create
 * exactly one project and start no work. Driven through the real coordinator,
 * registry, synthesis engine and owner-decision service (the same services the
 * private shell calls), never through a re-implementation.
 */
import assert from "node:assert/strict";
import { fixture, now, trust } from "../helpers/web-foundation";
import { buildIdeaLabSessionV1 } from "../../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../../src/idea-lab/v1/store";
import { IdeaLabBotRunStoreV1 } from "../../src/idea-lab/v1/coordinator-store";
import { IdeaLabBotCoordinatorV1, DeterministicIdeaLabFakeDriverV1, buildRepositoryFakeProviderEvidenceV1,
  IDEA_LAB_BOT_RUNTIME_DISABLED_V1 } from "../../src/idea-lab/v1/coordinator";
import { DeterministicIdeaLabSynthesisEngineV1 } from "../../src/idea-lab/v1/synthesis-engine";
import { IdeaLabOwnerDecisionServiceV1 } from "../../src/idea-lab/v1/owner-decision-service";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../src/idea-lab/v1/schemas";
import { sha256Digest } from "../../src/security";
import { ATTRIBUTED_IDEA_PANEL_V1, type JourneyOutcomeV1 } from "./attributed-cases";

export async function runIdeaLabAttributionJourney(): Promise<JourneyOutcomeV1> {
  const steps: JourneyOutcomeV1["steps"] = [], findings: string[] = [];
  const record = (step: string, detail: string) => { steps.push({ step, detail }); };
  const panel = ATTRIBUTED_IDEA_PANEL_V1;
  const f = await fixture();
  try {
    const key = new Uint8Array(32).fill(0x42), at = new Date(now).toISOString();
    const registry = new IdeaLabProjectRegistryStoreV1(f.client, key);
    const ledger = new IdeaLabBotRunStoreV1(f.client, key);
    const tenantId = "tenant:web", workspaceId = "workspace:web";
    const participants = panel.session.participants.map(item => ({ ...item,
      identityDigest: sha256Digest({ attributedCase: panel.caseId, participantId: item.participantId }),
      sourceMode: "injected_only" as const, liveConnected: false, canDispatch: false }));
    const session = buildIdeaLabSessionV1({ sessionId: panel.session.sessionId, tenantId, workspaceId,
      title: panel.session.title, ideaSummary: panel.session.ideaSummary, targetCustomer: panel.session.targetCustomer,
      participants, maxRounds: panel.session.maxRounds, maxDurationSeconds: panel.session.maxDurationSeconds,
      maxCostUsd: panel.session.maxCostUsd, createdByIdentityDigest: sha256Digest({ attributedCase: panel.caseId, role: "owner" }),
      createdAt: at });
    await registry.registerSession(session);
    await f.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'control_room_native_ideas','1.0.0','control_room_native','fixture','v1',30)`, [CONTROL_ROOM_IDEA_ADAPTER_V1, tenantId]);
    const evidence = session.participants.map((participant, index) => buildRepositoryFakeProviderEvidenceV1(session, participant, {
      evidenceId: `evidence:${panel.caseId}:${index}`, capturedAt: at, expiresAt: new Date(now + 120000).toISOString() }));
    record("panel registered", `${session.participants.length} attributed participants, maxRounds=${session.maxRounds}, bounded by ${session.maxDurationSeconds}s / $${session.maxCostUsd}`);

    const input = { runId: "run:attributed-complete", session, evidence,
      safePrompt: "Compare this idea from every assigned perspective and name one bounded experiment." };
    const completed = await new IdeaLabBotCoordinatorV1(ledger, registry,
      new DeterministicIdeaLabFakeDriverV1(), () => at).execute(input);
    const expectedTurns = session.participants.length * session.maxRounds;
    assert.equal(completed.state, "completed");
    assert.equal(completed.messagesUsed, expectedTurns);
    assert.equal(completed.providerContacted, false, "a synthetic panel must not claim provider contact");
    assert.equal(completed.retryPermitted, false, "automatic retry must stay disabled");
    const landed = await registry.listContributions(tenantId, session.sessionId);
    assert.equal(landed.length, expectedTurns);
    for (const round of [1, 2]) for (const participant of session.participants) {
      const contribution = landed.find(item => item.round === round && item.participantId === participant.participantId);
      assert.ok(contribution, `missing retained contribution: round ${round} / ${participant.participantId}`);
      assert.equal(contribution.sourceMode, "injected_only");
    }
    record("panel completed with retained attribution", `${landed.length}/${expectedTurns} contributions retained, each bound to its participant and round, providerContacted=${completed.providerContacted}`);

    const interrupted = panel.session.interruptedParticipantId;
    const interruptedIndex = session.participants.findIndex(item => item.participantId === interrupted);
    assert.ok(interruptedIndex >= 1, "the interrupted participant must not be the first in the round");
    const interruptedSession = buildIdeaLabSessionV1({ sessionId: panel.session.sessionId + "-interrupted", tenantId, workspaceId,
      title: panel.session.title, ideaSummary: panel.session.ideaSummary, targetCustomer: panel.session.targetCustomer,
      participants, maxRounds: panel.session.maxRounds, maxDurationSeconds: panel.session.maxDurationSeconds,
      maxCostUsd: panel.session.maxCostUsd, createdByIdentityDigest: sha256Digest({ attributedCase: panel.caseId, role: "owner" }),
      createdAt: at });
    await registry.registerSession(interruptedSession);
    const interruptedEvidence = interruptedSession.participants.map((participant, index) => buildRepositoryFakeProviderEvidenceV1(interruptedSession, participant, {
      evidenceId: `evidence:${panel.caseId}:interrupted:${index}`, capturedAt: at, expiresAt: new Date(now + 120000).toISOString() }));
    const partial = await new IdeaLabBotCoordinatorV1(ledger, registry,
      new DeterministicIdeaLabFakeDriverV1({ [`${interrupted}:2`]: "throw" }), () => at)
      .execute({ ...input, runId: "run:attributed-interrupted", session: interruptedSession, evidence: interruptedEvidence });
    assert.equal(partial.state, "ambiguous", "a lost provider outcome must leave the run uncertain, not completed");
    assert.equal(partial.retryPermitted, false);
    assert.equal(partial.safeCode, "provider_outcome_unknown");
    assert.ok(partial.attempts.some(attempt => attempt.participantId === interrupted && attempt.round === 2 && attempt.state === "ambiguous"),
      "the lost turn must stay visible as an ambiguous attempt");
    const expectedRetained = interruptedSession.participants.length + interruptedIndex;
    const retained = await registry.listContributions(tenantId, interruptedSession.sessionId);
    assert.equal(retained.length, expectedRetained,
      "every turn that landed before the loss must stay retained, and none after it");
    assert.equal(retained.some(item => item.round === 2 && item.participantId === interrupted), false);
    const interruptedRetained = retained.filter(item => item.participantId === interrupted);
    assert.equal(interruptedRetained.length, 1, "the interrupted participant must keep exactly the turn that actually landed");
    assert.equal(interruptedRetained[0].round, 1, "the interrupted participant must have no round-2 contribution at all");
    assert.equal(retained.filter(item => item.round === 1).length, interruptedSession.participants.length,
      "round 1 must be complete for every participant");
    assert.equal((await registry.listProjects(tenantId)).length, 0, "an uncertain panel must never promote itself");
    record("partial failure stayed visible", `panel ${interruptedSession.sessionId}: ${retained.length} contributions retained (round 1 complete, round 2 stopped at ${interrupted}), state=${partial.state}, attempt state=ambiguous, no project created`);

    const replay = new IdeaLabBotCoordinatorV1(new IdeaLabBotRunStoreV1(f.client, key), registry,
      new DeterministicIdeaLabFakeDriverV1(), () => at);
    assert.deepEqual(await replay.execute(input), completed, "reconstructing the runtime must not re-invoke or re-synthesize");
    assert.equal((await registry.listContributions(tenantId, session.sessionId)).length, expectedTurns,
      "replaying a completed panel must not inflate retained evidence");
    record("reconstruction is inert", `the saved completed run replays identically and retention stays at ${expectedTurns} contributions (no re-invocation, no duplicate evidence)`);

    const synthesis = new DeterministicIdeaLabSynthesisEngineV1().build(session, landed, at);
    await registry.recordSynthesis(synthesis);
    assert.equal((await registry.listProjects(tenantId)).length, 0, "a synthesis must not create a project by itself");
    record("recap recorded", `synthesis saved for the completed panel; projects still ${(await registry.listProjects(tenantId)).length} (no automatic promotion)`);

    const decisions = new IdeaLabOwnerDecisionServiceV1(f.client, key);
    const decisionInput = { sessionId: session.sessionId,
      intent: { decision: "create_project", safeReasonCode: "owner_promoted_for_validation",
        project: { projectId: "project:attributed-maintenance", workspaceName: "Maintenance Scheduling Validation",
          title: "Validate predictive maintenance scheduling for small machine shops",
          summary: "Prove demand and telemetry availability before any live scheduling assistance is enabled.",
          projectKind: "business_validation", priority: 70 } },
      authentication: { tenantId, provider: trust.issuer, subject: "test-owner",
        verifiedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 300000).toISOString() }, now: at };
    // Two honest refusals, driven through the real authorization store:
    //  - a subject that resolves to no active identity cannot be evaluated at all,
    //    so the service reports the boundary as unavailable rather than a denial;
    //  - an active, authenticated human holding only a non-owner grant is evaluated
    //    and denied.
    const nonOwnerSubject = "test-operator", seededAt = new Date(now - 60_000).toISOString();
    await f.client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human','Non-owner operator',$3,$4,'active',$5,$5)`,
      ["identity:non-owner", tenantId, trust.issuer, sha256Digest({ provider: trust.issuer, subject: nonOwnerSubject }), seededAt]);
    await f.client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,'identity:non-owner','operator','["*"]'::jsonb,'["*"]'::jsonb,'critical',false,false,$3,$3)`,
      ["grant:non-owner", tenantId, seededAt]);
    const refusalCode = (call: Promise<unknown>) => call.then(() => "accepted",
      (error: { safeCode?: string }) => error.safeCode ?? "rejected");
    const unknownOwner = await refusalCode(decisions.apply({ ...decisionInput,
      authentication: { ...decisionInput.authentication, subject: "unknown-owner" } }));
    assert.equal(unknownOwner, "owner_boundary_unavailable",
      "a subject that resolves to no active identity must not promote a panel");
    const nonOwner = await refusalCode(decisions.apply({ ...decisionInput,
      authentication: { ...decisionInput.authentication, subject: nonOwnerSubject } }));
    assert.equal(nonOwner, "owner_forbidden",
      "an authenticated non-owner must not promote a panel");
    assert.equal((await registry.listProjects(tenantId)).length, 0, "a refused decision must create no project");
    assert.equal((await registry.listContributions(tenantId, session.sessionId)).length, expectedTurns,
      "a refused decision must not start or restart panel work");
    record("owner boundary refused both unauthorised principals",
      `unknown subject -> ${unknownOwner}; authenticated non-owner (operator grant only) -> ${nonOwner}; projects still ${(await registry.listProjects(tenantId)).length}, panel contributions unchanged`);

    const promoted = await decisions.apply(decisionInput);
    assert.equal(promoted.project?.sourceIdeaSessionId, session.sessionId, "the project must stay attributed to its panel");
    assert.equal(promoted.decision.automaticDecision, false, "promotion is an owner action, not an automatic one");
    assert.equal(promoted.decision.providerContacted, false);
    assert.equal(promoted.decision.liveBotContactAuthorized, false);
    const projects = await registry.listProjects(tenantId);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].lifecycleState, "active");
    const replayed = await decisions.apply(decisionInput);
    assert.equal(replayed.replayed, true, "an owner decision must be idempotent");
    assert.equal((await registry.listProjects(tenantId)).length, 1);
    const afterPromotion = await registry.listContributions(tenantId, session.sessionId);
    assert.equal(afterPromotion.length, expectedTurns, "promotion must not start new panel work");
    assert.equal(IDEA_LAB_BOT_RUNTIME_DISABLED_V1.automaticProjectCreationAllowed, false);
    assert.equal(IDEA_LAB_BOT_RUNTIME_DISABLED_V1.providerContacted, false);
    record("owner decision created the project", `1 project attributed to ${session.sessionId}; replay idempotent; contributions unchanged (${afterPromotion.length}); no dispatch, no bot started`);

    findings.push("A bounded panel retains every contribution that landed and shows a lost provider outcome as an ambiguous attempt with automatic retry disabled.");
    findings.push("Only a verified owner promotes a panel; promotion creates exactly one project attributed to the source session and starts no work.");
    findings.push("Not driven here: the private shell rendering of these states at 360px/1280px, keyboard operation, and back/forward/reload — that needs the browser lane (see the integration doc).");
    return { journey: "attributed idea panel -> owner decision -> project", steps, findings };
  } finally {
    f.db.close();
  }
}