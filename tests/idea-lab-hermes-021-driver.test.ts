import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest } from "../src/security/index.ts";
import {
  Hermes021IdeaLabFilteredDriverV1,
  IdeaLabErrorV1,
  buildHermes021IdeaLabQualificationSimulationV1,
  buildIdeaLabFixtureV1,
  buildIdeaLabHermes021RuntimeCandidateV1,
  buildIdeaLabLivePanelAdmissionCandidateV1,
  buildRepositoryFakeProviderEvidenceV1,
  hermes021IdeaLabNativeQualificationPlanV1,
  parseHermes021IdeaLabNativeQualificationPlanV1,
  parseHermes021IdeaLabQualificationSimulationV1,
  type Hermes021IdeaLabGatewayPortV1,
  type IdeaLabProviderSessionEvidenceV1,
} from "../src/idea-lab/v1/index.ts";

const now = "2026-08-31T21:00:00.000Z", expires = "2026-08-31T21:10:00.000Z";
const digest = (label: string) => sha256Digest({ label });
const markerDigest = digest("provider-marker"), sessionIdentityDigest = digest("native-session");

function setup() {
  const fixture = buildIdeaLabFixtureV1(), participant = fixture.session.participants[0]!;
  const fake = buildRepositoryFakeProviderEvidenceV1(fixture.session, participant, {
    evidenceId: "evidence.idea:hermes-driver", capturedAt: now, expiresAt: expires,
  });
  const { evidenceDigest: _ignored, ...base } = fake;
  void _ignored;
  const evidenceMaterial = { ...base, mode: "hermes_bot_mode_filtered" as const,
    harnessPackage: "hermes_agent" as const, harnessVersion: "0.21.0",
    sourceRevision: "29112bef099274229cadff79cdff7bf7b99c4b77", liveProviderAuthorized: true, providerContacted: true };
  const evidence: IdeaLabProviderSessionEvidenceV1 = { ...evidenceMaterial, evidenceDigest: sha256Digest(evidenceMaterial) };
  const runtimeIdentityDigest = digest("runtime-identity");
  const admission = buildIdeaLabLivePanelAdmissionCandidateV1({ admissionId: "admission.idea:hermes-driver",
    runId: "idea-run:hermes-driver", session: fixture.session, evidence: [evidence,
      ...fixture.session.participants.slice(1).map((item, index) => {
        const candidate = buildRepositoryFakeProviderEvidenceV1(fixture.session, item, {
          evidenceId: `evidence.idea:hermes-other:${index}`, capturedAt: now, expiresAt: expires,
        });
        const { evidenceDigest: _candidateDigest, ...candidateBase } = candidate;
        void _candidateDigest;
        const material = { ...candidateBase, mode: "hermes_bot_mode_filtered" as const,
          harnessPackage: "hermes_agent" as const, harnessVersion: "0.21.0",
          sourceRevision: "29112bef099274229cadff79cdff7bf7b99c4b77", liveProviderAuthorized: true, providerContacted: true };
        return { ...material, evidenceDigest: sha256Digest(material) };
      })],
    runtime: buildIdeaLabHermes021RuntimeCandidateV1({ compatibilityEvidenceDigest: digest("compatibility"),
      nativeQualificationReceiptDigest: digest("native-receipt"), runtimeManifestDigest: digest("manifest"),
      protectedValueCustodyEvidenceDigest: digest("custody") }),
    runtimeIdentityDigests: Object.fromEntries(fixture.session.participants.map((item) => [item.participantId,
      item.participantId === participant.participantId ? runtimeIdentityDigest : digest(`runtime:${item.participantId}`)])),
    ownerWindow: { windowId: "owner-window:hermes-driver", decisionDigest: digest("owner-decision"),
      strongFactorEvidenceDigest: digest("strong-factor"), authorizedAction: "idea_lab_live_panel", singleUse: true,
      ownerAttended: true, openedAt: now, expiresAt: expires },
    issuedAt: now, expiresAt: "2026-08-31T21:05:00.000Z",
  });
  return { fixture, participant, evidence, admission, runtimeIdentityDigest,
    input: { session: fixture.session, participant, round: 1, safePrompt: "Evaluate this exact bounded idea.",
      evidence, markerDigest, liveAdmission: admission } };
}

function cleanupReceipt(marker: string, sessionDigest?: string) {
  const material = { contractVersion: "control-room-hermes-021-panel-cleanup/v1" as const, markerDigest: marker,
    ...(sessionDigest ? { sessionIdentityDigest: sessionDigest } : {}), outcome: "completed" as const,
    processStopped: true as const, disposableProfileRemoved: true as const, disposableWorkspaceRemoved: true as const,
    retainedNativeReferenceCount: 0 as const };
  return { ...material, cleanupDigest: sha256Digest(material) };
}

function completedFrames(input: Parameters<Hermes021IdeaLabGatewayPortV1["execute"]>[0], deltaPayload: unknown = { content: "discarded" }) {
  const base = { markerDigest: input.markerDigest, sessionIdentityDigest };
  return [
    { ...base, sequence: 1, type: "session.ready", payload: { participantId: input.participantId,
      participantIdentityDigest: setup().participant.identityDigest, runtimeIdentityDigest: input.runtimeIdentityDigest,
      profileIdentityDigest: input.profileIdentityDigest, conversationIdentityDigest: input.conversationIdentityDigest,
      toolsDisabled: true, mcpDisabled: true } },
    { ...base, sequence: 2, type: "message.delta", payload: deltaPayload },
    { ...base, sequence: 3, type: "panel.result", payload: { safeOpinion: "A bounded filtered opinion.",
      opportunityCode: "market_opening", primaryRiskCode: "demand_uncertain",
      suggestedExperiment: "Interview five target customers.", confidencePercent: 72 } },
    { ...base, sequence: 4, type: "session.usage", payload: { inputUnits: 20, outputUnits: 10,
      reasoningUnits: 5, totalUnits: 35, calls: 1, costUsd: 0.02 } },
    { ...base, sequence: 5, type: "session.complete", payload: { status: "settled" } },
  ];
}

function port(execute: Hermes021IdeaLabGatewayPortV1["execute"], onCleanup?: (input: Parameters<Hermes021IdeaLabGatewayPortV1["cleanup"]>[0]) => unknown): Hermes021IdeaLabGatewayPortV1 {
  return { execute, async cleanup(input, collector) { collector.submit(onCleanup?.(input)
    ?? cleanupReceipt(input.markerDigest, input.sessionIdentityDigest)); } };
}

test("CR12B-IDEA-080 translates one exact filtered sequence and discards streaming content without touching it", async () => {
  const target = setup(); let traps = 0, cleanupCalls = 0;
  const hostileDelta = new Proxy({ content: "provider_key=must-not-cross" }, { get() { traps += 1; throw new Error("trap"); } });
  const driver = new Hermes021IdeaLabFilteredDriverV1(port(async (input, collector) => {
    collector.submit({ frames: completedFrames(input, hostileDelta) });
  }, (input) => { cleanupCalls += 1; return cleanupReceipt(input.markerDigest, input.sessionIdentityDigest); }));
  const result = await driver.invoke(target.input) as Record<string, unknown>;
  assert.deepEqual({ outcome: result.outcome, costUsd: result.costUsd, contacted: result.providerContacted },
    { outcome: "completed", costUsd: 0.02, contacted: true });
  assert.match(String(result.providerReceiptDigest), /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("must-not-cross"), false);
  assert.deepEqual([traps, cleanupCalls], [0, 1]);
});

test("CR12B-IDEA-080 returns only a proven definite provider failure", async () => {
  const target = setup();
  const driver = new Hermes021IdeaLabFilteredDriverV1(port(async (input, collector) => {
    const base = { markerDigest: input.markerDigest, sessionIdentityDigest };
    collector.submit({ frames: [
      { ...base, sequence: 1, type: "session.ready", payload: { participantId: input.participantId,
        participantIdentityDigest: target.participant.identityDigest, runtimeIdentityDigest: input.runtimeIdentityDigest,
        profileIdentityDigest: input.profileIdentityDigest, conversationIdentityDigest: input.conversationIdentityDigest,
        toolsDisabled: true, mcpDisabled: true } },
      { ...base, sequence: 2, type: "panel.failed_definite", payload: { safeCode: "provider_access_blocked" } },
      { ...base, sequence: 3, type: "session.usage", payload: { inputUnits: 0, outputUnits: 0, reasoningUnits: 0,
        totalUnits: 0, calls: 1, costUsd: 0 } },
      { ...base, sequence: 4, type: "session.complete", payload: { status: "settled" } },
    ] });
  }));
  const result = await driver.invoke(target.input) as Record<string, unknown>;
  assert.deepEqual([result.outcome, result.safeCode, result.providerContacted],
    ["failed_definite", "provider_access_blocked", true]);
});

test("CR12B-IDEA-080 rejects runtime and participant drift before gateway contact", async () => {
  const target = setup(); let calls = 0;
  const driver = new Hermes021IdeaLabFilteredDriverV1(port(async () => { calls += 1; }));
  const changed = { ...target.evidence, sourceRevision: "f".repeat(40) };
  await assert.rejects(driver.invoke({ ...target.input, evidence: changed }),
    (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "authorization_denied");
  const participant = { ...target.participant, identityDigest: digest("different-participant") };
  await assert.rejects(driver.invoke({ ...target.input, participant }),
    (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "authorization_denied");
  assert.equal(calls, 0);
});

test("CR12B-IDEA-080 timeout aborts the port, requires cleanup, and never returns a contribution", async () => {
  const target = setup(); let executionAborted = false, cleanupCalls = 0;
  const driver = new Hermes021IdeaLabFilteredDriverV1(port(async (input) => {
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => {
      executionAborted = true; resolve();
    }, { once: true }));
  }, (input) => { cleanupCalls += 1; return cleanupReceipt(input.markerDigest, input.sessionIdentityDigest); }), 5);
  await assert.rejects(driver.invoke(target.input), (error) => error instanceof IdeaLabErrorV1);
  assert.deepEqual([executionAborted, cleanupCalls], [true, 1]);
});

test("CR12B-IDEA-080 synchronous gateway failure still requires cleanup and stays terminally unknown", async () => {
  const target = setup(); let cleanupCalls = 0;
  const driver = new Hermes021IdeaLabFilteredDriverV1(port(() => {
    throw new Error("untrusted gateway detail");
  }, (input) => { cleanupCalls += 1; return cleanupReceipt(input.markerDigest, input.sessionIdentityDigest); }));
  await assert.rejects(driver.invoke(target.input),
    (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "integrity_failed");
  assert.equal(cleanupCalls, 1);
});

test("CR12B-IDEA-080 malformed sequence, binding drift, and cleanup uncertainty fail closed", async () => {
  const target = setup();
  for (const mutation of [
    (frames: unknown[]) => { (frames[2] as { sequence: number }).sequence = 7; },
    (frames: unknown[]) => { ((frames[0] as { payload: { runtimeIdentityDigest: string } }).payload).runtimeIdentityDigest = digest("other"); },
  ]) {
    const driver = new Hermes021IdeaLabFilteredDriverV1(port(async (input, collector) => {
      const frames = completedFrames(input); mutation(frames); collector.submit({ frames });
    }));
    await assert.rejects(driver.invoke(target.input), (error) => error instanceof IdeaLabErrorV1);
  }
  const cleanupUnknown = new Hermes021IdeaLabFilteredDriverV1(port(async (input, collector) => {
    collector.submit({ frames: completedFrames(input) });
  }, (input) => ({ ...cleanupReceipt(input.markerDigest, input.sessionIdentityDigest), processStopped: false })));
  await assert.rejects(cleanupUnknown.invoke(target.input), (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-080 rejects Proxy handoffs and retained accessors without executing behavior", async () => {
  const target = setup(); let traps = 0, getterCalls = 0;
  const proxyDriver = new Hermes021IdeaLabFilteredDriverV1(port(async (_input, collector) => {
    collector.submit(new Proxy({ frames: [] }, { get() { traps += 1; return undefined; } }));
  }));
  await assert.rejects(proxyDriver.invoke(target.input), (error) => error instanceof IdeaLabErrorV1);
  const accessorDriver = new Hermes021IdeaLabFilteredDriverV1(port(async (input, collector) => {
    const frames = completedFrames(input), result = frames[2] as { payload: object };
    Object.defineProperty(result, "payload", { enumerable: true, get() { getterCalls += 1; return {}; } });
    collector.submit({ frames });
  }));
  await assert.rejects(accessorDriver.invoke(target.input), (error) => error instanceof IdeaLabErrorV1);
  assert.deepEqual([traps, getterCalls], [0, 0]);
});

test("CR12B-IDEA-080 frozen native plan remains blocked and injected simulation can never qualify it", () => {
  const plan = parseHermes021IdeaLabNativeQualificationPlanV1(hermes021IdeaLabNativeQualificationPlanV1);
  assert.deepEqual([plan.status, plan.nativePortConfigured, plan.ownerWindowPresent, plan.nativeCallsMade,
    plan.acceptedNativeReceiptDigests.length], ["blocked_before_native_attempt", false, false, 0, 0]);
  const scenarios = { exactCompletionTranslated: true, streamingContentDiscarded: true, timeoutAborted: true,
    malformedSequenceRejected: true, bindingDriftRejected: true, cleanupRequiredAndVerified: true,
    providerFailureDefiniteOnlyWhenProved: true, replayNeverResubmits: true };
  const simulation = parseHermes021IdeaLabQualificationSimulationV1(
    buildHermes021IdeaLabQualificationSimulationV1({ fixtureDigest: digest("driver-fixtures"), scenarios }));
  assert.deepEqual([simulation.simulationPassed, simulation.nativeQualified, simulation.livePanelEligible,
    simulation.nativeCallsMade, simulation.providerCallsMade], [true, false, false, 0, 0]);
});

test("CR12B-IDEA-080 re-digested native readiness claims and scenario drift fail closed", () => {
  const { planDigest: _ignored, ...base } = hermes021IdeaLabNativeQualificationPlanV1;
  void _ignored;
  const forgedMaterial = { ...base, nativePortConfigured: true, ownerWindowPresent: true,
    acceptedNativeReceiptDigests: [digest("caller")], status: "ready", nativeCallsMade: 1, providerCallsMade: 1 };
  const forged = { ...forgedMaterial, planDigest: sha256Digest(forgedMaterial) };
  assert.throws(() => parseHermes021IdeaLabNativeQualificationPlanV1(forged),
    (error) => error instanceof IdeaLabErrorV1);
  const scenarios = { exactCompletionTranslated: true, streamingContentDiscarded: true, timeoutAborted: false,
    malformedSequenceRejected: true, bindingDriftRejected: true, cleanupRequiredAndVerified: true,
    providerFailureDefiniteOnlyWhenProved: true, replayNeverResubmits: true };
  const receipt = buildHermes021IdeaLabQualificationSimulationV1({ fixtureDigest: digest("partial"), scenarios });
  assert.deepEqual([receipt.passedScenarioCount, receipt.simulationPassed, receipt.nativeQualified], [7, false, false]);
  let traps = 0;
  assert.throws(() => buildHermes021IdeaLabQualificationSimulationV1(new Proxy({ fixtureDigest: digest("proxy"), scenarios }, {
    ownKeys() { traps += 1; return []; },
  })), (error) => error instanceof IdeaLabErrorV1);
  assert.equal(traps, 0);
});

test("CR12B-IDEA-080 ships no native port, process, filesystem, network, or provider composition", async () => {
  const sources = await Promise.all([
    readFile("src/idea-lab/v1/hermes-021-filtered-driver.ts", "utf8"),
    readFile("src/idea-lab/v1/hermes-021-native-qualification.ts", "utf8"),
  ]);
  for (const source of sources) for (const forbidden of [
    'from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(", "execFile(",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
