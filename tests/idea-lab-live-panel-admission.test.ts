import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database.ts";
import { sha256Digest } from "../src/security/index.ts";
import {
  IdeaLabBotCoordinatorV1,
  IdeaLabBotRunStoreV1,
  IdeaLabErrorV1,
  IdeaLabProjectRegistryStoreV1,
  buildIdeaLabFixtureV1,
  buildIdeaLabHermes021RuntimeCandidateV1,
  buildIdeaLabLivePanelAdmissionCandidateV1,
  buildRepositoryFakeProviderEvidenceV1,
  ideaLabHermes021PanelPacketV1,
  parseIdeaLabHermes021PanelPacketV1,
  parseIdeaLabLivePanelAdmissionV1,
  type IdeaLabProviderSessionEvidenceV1,
} from "../src/idea-lab/v1/index.ts";

const key = new Uint8Array(32).fill(0x70);
const now = "2026-08-31T20:00:30.000Z";
const expires = "2026-08-31T20:10:00.000Z";
const digest = (label: string) => sha256Digest({ label });

async function setup() {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:owner','Owner')`);
  await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:control-room','tenant:owner','Control Room')`);
  const db = adaptPglite(raw);
  const registry = new IdeaLabProjectRegistryStoreV1(db, key);
  const ledger = new IdeaLabBotRunStoreV1(db, key);
  const fixture = buildIdeaLabFixtureV1();
  await registry.registerSession(fixture.session);
  const fakeEvidence = fixture.session.participants.map((participant, index) =>
    buildRepositoryFakeProviderEvidenceV1(fixture.session, participant, {
      evidenceId: `evidence.idea.live:${index}`, capturedAt: "2026-08-31T20:00:00.000Z", expiresAt: expires,
    }));
  const evidence: IdeaLabProviderSessionEvidenceV1[] = fakeEvidence.map((item) => {
    const { evidenceDigest: _ignored, ...base } = item;
    void _ignored;
    const material = {
      ...base,
      mode: "hermes_bot_mode_filtered" as const,
      harnessPackage: "hermes_agent" as const,
      harnessVersion: "0.21.0",
      sourceRevision: "a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b",
      adapterDigest: digest("adapter.hermes.gateway.v2"),
      liveProviderAuthorized: true,
      providerContacted: true,
    };
    return { ...material, evidenceDigest: sha256Digest(material) };
  });
  const runtime = buildIdeaLabHermes021RuntimeCandidateV1({
    compatibilityEvidenceDigest: digest("hermes-source-compatibility"),
    nativeQualificationReceiptDigest: digest("native-qualification-receipt"),
    runtimeManifestDigest: digest("runtime-manifest"),
    protectedValueCustodyEvidenceDigest: digest("protected-value-custody"),
  });
  const runtimeIdentityDigests = Object.fromEntries(fixture.session.participants.map((participant) =>
    [participant.participantId, digest(`runtime:${participant.participantId}`)]));
  const admission = buildIdeaLabLivePanelAdmissionCandidateV1({
    admissionId: "admission.idea:hermes-021",
    runId: "idea-run:admitted-live",
    session: fixture.session,
    evidence,
    runtime,
    runtimeIdentityDigests,
    ownerWindow: {
      windowId: "owner-window:idea-live-panel",
      decisionDigest: digest("owner-window-decision"),
      strongFactorEvidenceDigest: digest("owner-strong-factor"),
      authorizedAction: "idea_lab_live_panel",
      singleUse: true,
      ownerAttended: true,
      openedAt: "2026-08-31T20:00:00.000Z",
      expiresAt: expires,
    },
    issuedAt: "2026-08-31T20:00:10.000Z",
    expiresAt: "2026-08-31T20:05:00.000Z",
  });
  return { raw, registry, ledger, fixture, evidence, admission };
}

function completedResult(markerDigest: string) {
  return {
    outcome: "completed" as const,
    safeOpinion: "A filtered opinion containing no raw provider transcript.",
    opportunityCode: "bounded_opportunity",
    primaryRiskCode: "bounded_risk",
    suggestedExperiment: "Run one bounded experiment.",
    confidencePercent: 65,
    costUsd: 0.01,
    providerReceiptDigest: sha256Digest({ markerDigest, outcome: "completed" }),
    providerContacted: true,
  };
}

test("CR12B-IDEA-070 pins a disabled Hermes 0.21 owner packet with no live authority", () => {
  const packet = parseIdeaLabHermes021PanelPacketV1(ideaLabHermes021PanelPacketV1);
  assert.deepEqual({ version: packet.runtimeVersion, revision: packet.runtimeRevision, eligible: packet.livePanelEligible,
    receipts: packet.acceptedNativeQualificationReceiptDigests.length, windows: packet.ownerEffectWindowPresent,
    calls: packet.nativeCallsMade, protectedValues: packet.protectedValuesAccessed }, {
    version: "0.21.0", revision: "a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b", eligible: false,
    receipts: 0, windows: false, calls: 0, protectedValues: false,
  });
  assert.equal(packet.blockerCodes.length, 5);
  assert.deepEqual([packet.releaseRevision, packet.reviewedCommitCount, packet.sourcePreflightStatus,
    packet.sourcePreflightNativeAttemptStarted, packet.sourcePreflightProviderCallsMade],
  ["29112bef099274229cadff79cdff7bf7b99c4b77", 60, "ready_for_owner_attended_native_attempt", false, 0]);
});

test("CR12B-IDEA-070 binds exact provider, participants, budgets, custody, output, and owner window", async () => {
  const target = await setup();
  try {
    const parsed = parseIdeaLabLivePanelAdmissionV1(target.admission, target.fixture.session, target.evidence,
      "idea-run:admitted-live", now);
    assert.equal(parsed.participantBindings.length, target.fixture.session.participants.length);
    assert.equal(parsed.ceilings.maxProviderCalls, target.fixture.session.maxMessages);
    assert.deepEqual(parsed.callPolicy, {
      concurrency: 1, durablePreCallMarkerRequired: true, automaticRetryAllowed: false,
      unknownPostMarkerOutcome: "terminal_ambiguity", cancelPolicy: "between_calls_only",
      steerPolicy: "disabled_for_panel", resumePolicy: "reconcile_only_never_resubmit",
    });
    assert.equal(parsed.runtime.controlRoomCanReadProtectedValue, false);
    assert.equal(parsed.retainedOutput.rawConversationRetained, false);
    assert.equal(parsed.grantsProjectCreationAuthority, false);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-070 refuses a live panel unless both independent server authorities accept", async () => {
  const target = await setup();
  try {
    let calls = 0;
    const driver = { mode: "hermes_bot_mode_filtered" as const, async invoke() { calls += 1; return {}; } };
    const noAuthorities = new IdeaLabBotCoordinatorV1(target.ledger, target.registry, driver, () => now);
    await assert.rejects(noAuthorities.execute({ runId: "idea-run:no-authorities", session: target.fixture.session,
      evidence: target.evidence, liveAdmission: target.admission, safePrompt: "Evaluate safely." }),
    (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "authorization_denied");
    const providerOnly = new IdeaLabBotCoordinatorV1(target.ledger, target.registry, driver, () => now, { async verify() { return true; } });
    await assert.rejects(providerOnly.execute({ runId: "idea-run:no-admission-authority", session: target.fixture.session,
      evidence: target.evidence, liveAdmission: target.admission, safePrompt: "Evaluate safely." }),
    (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "authorization_denied");
    assert.equal(calls, 0);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-070 admits only an exact verified synthetic live seam and retains filtered contributions", async () => {
  const target = await setup();
  try {
    let calls = 0, providerChecks = 0, admissionChecks = 0;
    const coordinator = new IdeaLabBotCoordinatorV1(target.ledger, target.registry, {
      mode: "hermes_bot_mode_filtered",
      async invoke(input) { calls += 1; return completedResult(input.markerDigest); },
    }, () => now, { async verify() { providerChecks += 1; return true; } }, {
      async consume(input) {
        admissionChecks += 1;
        return input.admission.admissionDigest === target.admission.admissionDigest
          && input.admission.ownerWindow.decisionDigest === target.admission.ownerWindow.decisionDigest;
      },
    });
    const run = await coordinator.execute({ runId: "idea-run:admitted-live", session: target.fixture.session,
      evidence: target.evidence, liveAdmission: target.admission, safePrompt: "Evaluate safely." });
    assert.equal(run.state, "completed");
    assert.equal(calls, 8);
    assert.equal(providerChecks, target.fixture.session.participants.length);
    assert.equal(admissionChecks, 1);
    const contributions = await target.registry.listContributions(target.fixture.session.tenantId, target.fixture.session.sessionId);
    assert.equal(contributions.length, 8);
    assert.ok(contributions.every((item) => item.sourceMode === "provider_filtered" && item.providerContacted));
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-070 rejects scope, budget, time, identity, digest, accessor, and credential-material drift before contact", async () => {
  const target = await setup();
  try {
    const cases: unknown[] = [];
    cases.push({ ...target.admission, sessionId: "idea-session:other" });
    cases.push({ ...target.admission, ceilings: { ...target.admission.ceilings, maxCostUsd: target.admission.ceilings.maxCostUsd + 1 } });
    cases.push({ ...target.admission, expiresAt: "2026-08-31T20:00:20.000Z" });
    cases.push({ ...target.admission, participantBindings: target.admission.participantBindings.slice(1) });
    cases.push({ ...target.admission, runtime: { ...target.admission.runtime, protectedValueMaterialPresent: true } });
    cases.push({ ...target.admission, admissionDigest: digest("tampered") });
    for (const candidate of cases) assert.throws(
      () => parseIdeaLabLivePanelAdmissionV1(candidate, target.fixture.session, target.evidence,
        "idea-run:admitted-live", now),
      (error) => error instanceof IdeaLabErrorV1,
    );
    let accessorTouched = false;
    const accessor = { ...target.admission };
    Object.defineProperty(accessor, "runtime", { enumerable: true, get() { accessorTouched = true; return target.admission.runtime; } });
    assert.throws(() => parseIdeaLabLivePanelAdmissionV1(accessor, target.fixture.session, target.evidence,
      "idea-run:admitted-live", now),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "invalid_input");
    assert.equal(accessorTouched, false);
    assert.throws(() => parseIdeaLabLivePanelAdmissionV1(new Proxy(target.admission, {}), target.fixture.session,
      target.evidence, "idea-run:admitted-live", now),
      (error) => error instanceof IdeaLabErrorV1);
    assert.throws(() => parseIdeaLabLivePanelAdmissionV1(target.admission, target.fixture.session,
      target.evidence, "idea-run:different", now), (error) => error instanceof IdeaLabErrorV1);
    const { evidenceDigest: _evidenceDigest, ...evidenceBase } = target.evidence[0]!;
    void _evidenceDigest;
    const changedEvidenceMaterial = { ...evidenceBase, harnessVersion: "0.21.1" };
    const changedEvidence = { ...changedEvidenceMaterial, evidenceDigest: sha256Digest(changedEvidenceMaterial) };
    const evidence = [changedEvidence, ...target.evidence.slice(1)];
    const { admissionDigest: _admissionDigest, ...admissionBase } = target.admission;
    void _admissionDigest;
    const participantBindings = admissionBase.participantBindings.map((binding) => binding.participantId === changedEvidence.participantId
      ? { ...binding, providerEvidenceDigest: changedEvidence.evidenceDigest } : binding);
    const changedAdmissionMaterial = { ...admissionBase, participantBindings };
    const changedAdmission = { ...changedAdmissionMaterial, admissionDigest: sha256Digest(changedAdmissionMaterial) };
    assert.throws(() => parseIdeaLabLivePanelAdmissionV1(changedAdmission, target.fixture.session,
      evidence, "idea-run:admitted-live", now), (error) => error instanceof IdeaLabErrorV1);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-070 converts an unknown admitted call to terminal ambiguity and never retries", async () => {
  const target = await setup();
  try {
    let calls = 0;
    const coordinator = new IdeaLabBotCoordinatorV1(target.ledger, target.registry, {
      mode: "hermes_bot_mode_filtered",
      async invoke() { calls += 1; throw new Error("synthetic transport loss"); },
    }, () => now, { async verify() { return true; } }, { async consume() { return true; } });
    const input = { runId: "idea-run:admitted-live", session: target.fixture.session, evidence: target.evidence,
      liveAdmission: target.admission, safePrompt: "Evaluate safely." };
    const first = await coordinator.execute(input);
    const replay = await coordinator.execute(input);
    assert.deepEqual([first.state, first.safeCode, first.retryPermitted, calls],
      ["ambiguous", "provider_outcome_unknown", false, 1]);
    assert.equal(replay.runDigest, first.runDigest);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-070 refuses live admission material on the repository-fake path", async () => {
  const target = await setup();
  try {
    let calls = 0;
    const coordinator = new IdeaLabBotCoordinatorV1(target.ledger, target.registry, {
      mode: "repository_fake", async invoke() { calls += 1; return {}; },
    }, () => now);
    const fakeEvidence = target.fixture.session.participants.map((participant, index) =>
      buildRepositoryFakeProviderEvidenceV1(target.fixture.session, participant, {
        evidenceId: `evidence.idea.fake:${index}`, capturedAt: "2026-08-31T20:00:00.000Z", expiresAt: expires,
      }));
    await assert.rejects(coordinator.execute({ runId: "idea-run:fake-with-live-admission", session: target.fixture.session,
      evidence: fakeEvidence, liveAdmission: target.admission, safePrompt: "Evaluate safely." }),
    (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "authorization_denied");
    assert.equal(calls, 0);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-070 rejects a re-digested caller-shaped packet", () => {
  const { packetDigest: _ignored, ...base } = ideaLabHermes021PanelPacketV1;
  void _ignored;
  const forgedMaterial = { ...base, nativeQualified: true, acceptedNativeQualificationReceiptDigests: [digest("caller")],
    ownerEffectWindowPresent: true, acceptedAdmissionDigests: [digest("caller-admission")], livePanelEligible: true };
  const forged = { ...forgedMaterial, packetDigest: sha256Digest(forgedMaterial) };
  assert.throws(() => parseIdeaLabHermes021PanelPacketV1(forged),
    (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "invalid_input");
});
