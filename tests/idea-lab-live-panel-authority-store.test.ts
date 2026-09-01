import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database.ts";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security/index.ts";
import {
  IdeaLabErrorV1,
  IdeaLabBotCoordinatorV1,
  IdeaLabBotRunStoreV1,
  IdeaLabLivePanelAuthorityStoreV1,
  IdeaLabProjectRegistryStoreV1,
  buildIdeaLabFixtureV1,
  buildIdeaLabHermes021RuntimeCandidateV1,
  buildIdeaLabLiveAdmissionDecisionV1,
  buildIdeaLabLivePanelAdmissionCandidateV1,
  buildIdeaLabNativeReceiptDecisionV1,
  buildRepositoryFakeProviderEvidenceV1,
  type IdeaLabLivePanelAdmissionV1,
  type IdeaLabNativeReceiptDecisionV1,
  type IdeaLabProviderSessionEvidenceV1,
} from "../src/idea-lab/v1/index.ts";

const keys = {
  stateKey: new Uint8Array(32).fill(0x31),
  checkpointKey: new Uint8Array(32).fill(0x32),
  architectKey: new Uint8Array(32).fill(0x33),
  admissionKey: new Uint8Array(32).fill(0x34),
};
const now = "2026-08-31T22:00:30.000Z", expires = "2026-08-31T22:10:00.000Z";
const digest = (label: string) => sha256Digest({ label });

async function setup() {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:owner','Owner')`);
  await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:control-room','tenant:owner','Control Room')`);
  const fixture = buildIdeaLabFixtureV1();
  const fake = fixture.session.participants.map((participant, index) => buildRepositoryFakeProviderEvidenceV1(
    fixture.session, participant, { evidenceId: `evidence.idea.authority:${index}`,
      capturedAt: "2026-08-31T22:00:00.000Z", expiresAt: expires }));
  const evidence: IdeaLabProviderSessionEvidenceV1[] = fake.map((item) => {
    const { evidenceDigest: _ignored, ...base } = item; void _ignored;
    const material = { ...base, mode: "hermes_bot_mode_filtered" as const,
      harnessPackage: "hermes_agent" as const, harnessVersion: "0.21.0",
      sourceRevision: "a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b", liveProviderAuthorized: true,
      providerContacted: true };
    return { ...material, evidenceDigest: sha256Digest(material) };
  });
  const runtime = buildIdeaLabHermes021RuntimeCandidateV1({
    compatibilityEvidenceDigest: digest("compatibility"),
    nativeQualificationReceiptDigest: digest("native-receipt"),
    runtimeManifestDigest: digest("runtime-manifest"),
    protectedValueCustodyEvidenceDigest: digest("custody"),
  });
  const admission = (runId = "idea-run:authority", windowId = "owner-window:authority",
    admissionId = `admission.idea:${runId.split(":").at(-1)}`) =>
    buildIdeaLabLivePanelAdmissionCandidateV1({ admissionId,
      runId, session: fixture.session, evidence, runtime,
      runtimeIdentityDigests: Object.fromEntries(fixture.session.participants.map((participant) =>
        [participant.participantId, digest(`runtime:${participant.participantId}`)])),
      ownerWindow: { windowId, decisionDigest: digest(`owner:${windowId}`),
        strongFactorEvidenceDigest: digest(`factor:${windowId}`), authorizedAction: "idea_lab_live_panel",
        singleUse: true, ownerAttended: true, openedAt: "2026-08-31T22:00:00.000Z", expiresAt: expires },
      issuedAt: "2026-08-31T22:00:10.000Z", expiresAt: "2026-08-31T22:05:00.000Z" });
  const checkpoint = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new IdeaLabLivePanelAuthorityStoreV1(adaptPglite(raw), keys, checkpoint);
  return { raw, fixture, evidence, runtime, admission, checkpoint, store };
}

function nativeDecision(admission: IdeaLabLivePanelAdmissionV1, input: {
  action?: "accept" | "revoke";
  prior?: IdeaLabNativeReceiptDecisionV1;
  key?: Uint8Array;
} = {}) {
  const action = input.action ?? "accept";
  return buildIdeaLabNativeReceiptDecisionV1({
    decisionId: `native-decision:${action}:${input.prior ? "2" : "1"}`,
    tenantId: admission.tenantId,
    action,
    nativeReceiptDigest: admission.runtime.nativeQualificationReceiptDigest,
    runtimeVersion: admission.runtime.runtimeVersion,
    runtimeRevision: admission.runtime.runtimeRevision,
    adapterId: admission.runtime.adapterId,
    adapterVersion: admission.runtime.adapterVersion,
    compatibilityEvidenceDigest: admission.runtime.compatibilityEvidenceDigest,
    runtimeManifestDigest: admission.runtime.runtimeManifestDigest,
    protectedValueCustodyMode: admission.runtime.protectedValueCustodyMode,
    protectedValueCustodyEvidenceDigest: admission.runtime.protectedValueCustodyEvidenceDigest,
    architectIdentityDigest: digest("architect"),
    independentReviewDigest: digest("independent-review"),
    strongFactorEvidenceDigest: digest("architect-factor"),
    previousDecisionDigest: input.prior?.decisionDigest ?? null,
    decidedAt: action === "accept" ? "2026-08-31T22:00:01.000Z" : "2026-08-31T22:00:40.000Z",
  }, input.key ?? keys.architectKey);
}

async function prepare(target: Awaited<ReturnType<typeof setup>>, admission = target.admission()) {
  const receipt = nativeDecision(admission);
  await target.store.recordNativeReceiptDecision(receipt);
  const seal = buildIdeaLabLiveAdmissionDecisionV1({ decisionId: `admission-decision:seal:${admission.runId}`,
    action: "seal", admission, previousDecisionDigest: null, decidedAt: "2026-08-31T22:00:20.000Z" }, keys.admissionKey);
  await target.store.recordAdmissionDecision(seal);
  return { admission, receipt, seal };
}

test("CR12B-IDEA-090 atomically consumes one authenticated receipt, admission, window, and run", async () => {
  const target = await setup();
  try {
    const value = await prepare(target);
    assert.equal(await target.store.consume({ admission: value.admission, session: target.fixture.session,
      evidence: target.evidence, now }), true);
    assert.deepEqual(await target.store.verify("tenant:owner"), {
      revision: 3, acceptedNativeReceiptCount: 1, activeAdmissionCount: 1,
      consumedAdmissionCount: 1, stateDigest: (await target.store.verify("tenant:owner")).stateDigest,
    });
    const count = await target.raw.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_idea_live_authority_events`);
    assert.equal(count.rows[0]!.count, "3");
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 exact replay is inert and never creates a second consumption", async () => {
  const target = await setup();
  try {
    const value = await prepare(target), input = { admission: value.admission, session: target.fixture.session,
      evidence: target.evidence, now };
    assert.equal(await target.store.consume(input), true);
    assert.equal(await target.store.consume(input), true);
    const rows = await target.raw.query<{ event_kind: string }>(`SELECT event_kind FROM control_idea_live_authority_events`);
    assert.equal(rows.rows.filter((row) => row.event_kind === "admission_consumed").length, 1);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 composes with the protected coordinator and replay makes no second panel call", async () => {
  const target = await setup();
  try {
    const value = await prepare(target), db = adaptPglite(target.raw), registry = new IdeaLabProjectRegistryStoreV1(db, keys.stateKey);
    await registry.registerSession(target.fixture.session);
    let calls = 0;
    const coordinator = new IdeaLabBotCoordinatorV1(new IdeaLabBotRunStoreV1(db, keys.stateKey), registry, {
      mode: "hermes_bot_mode_filtered",
      async invoke(input) {
        calls += 1;
        return { outcome: "completed", safeOpinion: "A bounded filtered opinion.", opportunityCode: "bounded_opportunity",
          primaryRiskCode: "bounded_risk", suggestedExperiment: "Run one bounded experiment.", confidencePercent: 70,
          costUsd: 0.01, providerReceiptDigest: digest(`receipt:${input.markerDigest}`), providerContacted: true };
      },
    }, () => now, { async verify() { return true; } }, target.store);
    const input = { runId: value.admission.runId, session: target.fixture.session, evidence: target.evidence,
      safePrompt: "Evaluate this bounded idea.", liveAdmission: value.admission };
    const first = await coordinator.execute(input), replay = await coordinator.execute(input);
    assert.deepEqual([first.state, replay.runDigest, calls], ["completed", first.runDigest, 8]);
    assert.equal((await target.store.verify("tenant:owner")).consumedAdmissionCount, 1);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 concurrent exact consumption creates one row and never broadens authority", async () => {
  const target = await setup();
  try {
    const value = await prepare(target), input = { admission: value.admission, session: target.fixture.session,
      evidence: target.evidence, now };
    const outcomes = await Promise.all([target.store.consume(input), target.store.consume(input)]);
    assert.ok(outcomes.some(Boolean));
    const rows = await target.raw.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM control_idea_live_authority_events WHERE event_kind='admission_consumed'`);
    assert.equal(rows.rows[0]!.count, "1");
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 a consumed owner window cannot authorize a different run", async () => {
  const target = await setup();
  try {
    const first = await prepare(target), secondAdmission = target.admission("idea-run:other", first.admission.ownerWindow.windowId);
    const secondSeal = buildIdeaLabLiveAdmissionDecisionV1({ decisionId: "admission-decision:seal:other",
      action: "seal", admission: secondAdmission, previousDecisionDigest: null,
      decidedAt: "2026-08-31T22:00:21.000Z" }, keys.admissionKey);
    await target.store.recordAdmissionDecision(secondSeal);
    assert.equal(await target.store.consume({ admission: first.admission, session: target.fixture.session,
      evidence: target.evidence, now }), true);
    assert.equal(await target.store.consume({ admission: secondAdmission, session: target.fixture.session,
      evidence: target.evidence, now }), false);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 admission IDs and runs cannot be resealed under different bindings", async () => {
  const target = await setup();
  try {
    const first = await prepare(target);
    for (const admission of [
      target.admission("idea-run:id-other", "owner-window:id-other", first.admission.admissionId),
      target.admission(first.admission.runId, "owner-window:run-other", "admission.idea:run-other"),
    ]) {
      const seal = buildIdeaLabLiveAdmissionDecisionV1({ decisionId: `decision:${admission.admissionId}`,
        action: "seal", admission, previousDecisionDigest: null, decidedAt: "2026-08-31T22:00:21.000Z" }, keys.admissionKey);
      await assert.rejects(target.store.recordAdmissionDecision(seal),
        (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "state_conflict");
    }
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 receipt and admission revocation are terminal", async () => {
  const receiptTarget = await setup();
  try {
    const admission = receiptTarget.admission(), accepted = nativeDecision(admission);
    await receiptTarget.store.recordNativeReceiptDecision(accepted);
    const revoked = nativeDecision(admission, { action: "revoke", prior: accepted });
    await receiptTarget.store.recordNativeReceiptDecision(revoked);
    await assert.rejects(receiptTarget.store.recordNativeReceiptDecision(accepted),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "state_conflict");
    const seal = buildIdeaLabLiveAdmissionDecisionV1({ decisionId: "admission-decision:blocked",
      action: "seal", admission, previousDecisionDigest: null, decidedAt: "2026-08-31T22:00:20.000Z" }, keys.admissionKey);
    await assert.rejects(receiptTarget.store.recordAdmissionDecision(seal),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "state_conflict");
  } finally { await receiptTarget.raw.close(); }
  const admissionTarget = await setup();
  try {
    const value = await prepare(admissionTarget);
    const revoke = buildIdeaLabLiveAdmissionDecisionV1({ decisionId: "admission-decision:revoke",
      action: "revoke", admission: value.admission, previousDecisionDigest: value.seal.decisionDigest,
      decidedAt: "2026-08-31T22:00:40.000Z" }, keys.admissionKey);
    await admissionTarget.store.recordAdmissionDecision(revoke);
    assert.equal(await admissionTarget.store.consume({ admission: value.admission, session: admissionTarget.fixture.session,
      evidence: admissionTarget.evidence, now }), false);
    await assert.rejects(admissionTarget.store.recordAdmissionDecision(value.seal),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "state_conflict");
  } finally { await admissionTarget.raw.close(); }
});

test("CR12B-IDEA-090 rejects forged architect and admission authority records before state changes", async () => {
  const target = await setup();
  try {
    const admission = target.admission(), forgedReceipt = nativeDecision(admission, { key: new Uint8Array(32).fill(0x99) });
    await assert.rejects(target.store.recordNativeReceiptDecision(forgedReceipt),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "integrity_failed");
    const accepted = nativeDecision(admission); await target.store.recordNativeReceiptDecision(accepted);
    const forgedSeal = buildIdeaLabLiveAdmissionDecisionV1({ decisionId: "admission-decision:forged",
      action: "seal", admission, previousDecisionDigest: null, decidedAt: "2026-08-31T22:00:20.000Z" },
    new Uint8Array(32).fill(0x98));
    await assert.rejects(target.store.recordAdmissionDecision(forgedSeal),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "integrity_failed");
    assert.equal((await target.store.verify("tenant:owner")).revision, 1);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 detects privileged database rollback through the independent high-water", async () => {
  const target = await setup();
  try {
    await prepare(target);
    await target.raw.exec(`DROP TRIGGER control_idea_live_authority_events_append_only ON control_idea_live_authority_events`);
    await target.raw.exec(`DELETE FROM control_idea_live_authority_events WHERE revision=2`);
    await assert.rejects(target.store.verify("tenant:owner"),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "integrity_failed");
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 append-only SQL guards and authenticated payloads reject mutation", async () => {
  const target = await setup();
  try {
    await prepare(target);
    await assert.rejects(target.raw.exec(`UPDATE control_idea_live_authority_events SET subject_id='changed'`), /append-only/i);
    await assert.rejects(target.raw.exec(`DELETE FROM control_idea_live_authority_events`), /append-only/i);
    await assert.rejects(target.raw.exec(`TRUNCATE control_idea_live_authority_events`), /append-only/i);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 restart preserves exact authority state without provider contact", async () => {
  const target = await setup();
  try {
    const value = await prepare(target);
    await target.store.consume({ admission: value.admission, session: target.fixture.session, evidence: target.evidence, now });
    const restarted = new IdeaLabLivePanelAuthorityStoreV1(adaptPglite(target.raw), keys, target.checkpoint);
    assert.deepEqual(await restarted.verify("tenant:owner"), await target.store.verify("tenant:owner"));
    assert.equal(await restarted.consume({ admission: value.admission, session: target.fixture.session,
      evidence: target.evidence, now }), true);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-090 rejects Proxy stores and exposes no native/provider composition", async () => {
  const target = await setup();
  try {
    let traps = 0;
    assert.throws(() => new IdeaLabLivePanelAuthorityStoreV1(new Proxy(adaptPglite(target.raw), {}), keys, target.checkpoint),
      (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "invalid_input");
    assert.throws(() => new IdeaLabLivePanelAuthorityStoreV1(adaptPglite(target.raw), new Proxy(keys, {
      ownKeys() { traps += 1; return []; },
    }), target.checkpoint), (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "invalid_input");
    const admission = target.admission(), accepted = nativeDecision(admission);
    const { contractVersion: _contract, nativeQualified: _qualified, grantsExecutionAuthority: _authority,
      decisionDigest: _decisionDigest, decisionAuthTag: _decisionAuthTag, ...nativeInput } = accepted;
    void _contract; void _qualified; void _authority; void _decisionDigest; void _decisionAuthTag;
    assert.throws(() => buildIdeaLabNativeReceiptDecisionV1(new Proxy(nativeInput, {
      ownKeys() { traps += 1; return []; },
    }), keys.architectKey), (error) => error instanceof IdeaLabErrorV1);
    assert.throws(() => buildIdeaLabLiveAdmissionDecisionV1(new Proxy({ decisionId: "decision:proxy", action: "seal",
      admission, previousDecisionDigest: null, decidedAt: now }, { ownKeys() { traps += 1; return []; } }),
    keys.admissionKey), (error) => error instanceof IdeaLabErrorV1);
    assert.equal(await target.store.consume(new Proxy({ admission, session: target.fixture.session,
      evidence: target.evidence, now }, { ownKeys() { traps += 1; return []; } })), false);
    assert.equal(traps, 0);
    const source = await readFile("src/idea-lab/v1/live-panel-authority-store.ts", "utf8");
    for (const forbidden of ['from "node:child_process"', 'from "node:fs"', "fetch(", "spawn(", "execFile("]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  } finally { await target.raw.close(); }
});
