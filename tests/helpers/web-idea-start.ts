import assert from "node:assert/strict";
import { taskFixture } from "./web-task";
import { now } from "./web-foundation";
import { IdeaSessionCreationService } from "../../src/web/v1/idea-create-operation";
import { type IdeaStartRuntime } from "../../src/web/v1/idea-start-operation";
import { IdeaLabProjectRegistryStoreV1 } from "../../src/idea-lab/v1/store";
import { buildIdeaLabFixtureV1, buildRepositoryFakeProviderEvidenceV1, buildIdeaLabHermes021RuntimeCandidateV1, buildIdeaLabLivePanelAdmissionCandidateV1 } from "../../src/idea-lab/v1";
import { sha256Digest } from "../../src/security";
import type { DatabaseClient } from "../../src/persistence/database";
import { taskAssignmentFixture } from "./task-assignment";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" }, key = new Uint8Array(32).fill(71);

const at = (offset = 0) => new Date(now + offset).toISOString();

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture() {
  const f = await taskFixture();
  const saved = await new IdeaSessionCreationService(f.client, scope, key, buildIdeaLabFixtureV1().session.participants, () => now)
    .create(f.identity, { title: "Test idea", ideaSummary: "Help local shops", targetCustomer: "Shop owners", maxRounds: 1,
      maxDurationSeconds: 300, maxCostUsd: 2 }, "idea-start-test01");
  const session = (await new IdeaLabProjectRegistryStoreV1(f.client, key).getSession(scope.tenantId, saved.sessionId))!;
  // Synthetic evidence and injected driver only. No native qualification/contact.
  const evidence = session.participants.map((p, i) => {
    const { evidenceDigest: ignored, ...base } = buildRepositoryFakeProviderEvidenceV1(session, p,
      { evidenceId: `evidence:start:${i}`, capturedAt: at(), expiresAt: at(240000) }); void ignored;
    const material = { ...base, mode: "hermes_bot_mode_filtered" as const, harnessPackage: "hermes_agent" as const,
      harnessVersion: "0.21.0", sourceRevision: "a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b",
      adapterDigest: sha256Digest("adapter.hermes.gateway.v2"), liveProviderAuthorized: true, providerContacted: true };
    return { ...material, evidenceDigest: sha256Digest(material) };
  });
  let calls = 0, resolutions = 0;
  const runtime: IdeaStartRuntime = {
    async resolve(selected, ownerId, runId) {
      resolutions++; assert.equal(ownerId, "identity:web"); assert.equal(selected.sessionDigest, saved.sessionDigest);
      return { evidence, admission: buildIdeaLabLivePanelAdmissionCandidateV1({ admissionId: "admission:start", runId, session, evidence,
        runtime: buildIdeaLabHermes021RuntimeCandidateV1({ compatibilityEvidenceDigest: sha256Digest("compat"),
          nativeQualificationReceiptDigest: sha256Digest("synthetic-receipt"), runtimeManifestDigest: sha256Digest("manifest"),
          protectedValueCustodyEvidenceDigest: sha256Digest("custody") }),
        runtimeIdentityDigests: Object.fromEntries(session.participants.map(p => [p.participantId, sha256Digest(p.participantId)])),
        ownerWindow: { windowId: "window:start", decisionDigest: sha256Digest("decision"), strongFactorEvidenceDigest: sha256Digest("factor"),
          authorizedAction: "idea_lab_live_panel", singleUse: true, ownerAttended: true, openedAt: at(), expiresAt: at(240000) },
        issuedAt: at(), expiresAt: at(240000) }) };
    },
    driver: { mode: "hermes_bot_mode_filtered", async invoke(input) {
      calls++; return { outcome: "completed", safeOpinion: "Test opinion", opportunityCode: "opportunity", primaryRiskCode: "risk",
        suggestedExperiment: "Ask one shop owner", confidencePercent: 70, costUsd: 0.01,
        providerReceiptDigest: sha256Digest(input.markerDigest), providerContacted: true };
    } }, evidenceAuthority: { async verify() { return true; } }, admissionAuthority: { async consume() { return true; } },
  };
  // Distinct wrappers over one serialized test engine are not independent SQL pools.
  const runtimeDb: DatabaseClient = { query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) };
  return { ...f, saved, runtime, runtimeDb, counts: () => ({ calls, resolutions }) };
}

async function managedFixture() {
  const f = await fixture(), planner = await taskAssignmentFixture();
  const closed: string[] = [];
  const wrap = (): DatabaseClient => ({ query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: f.client.transactionWithPreCommitCheck.bind(f.client) });
  const resource = (name: string, client: DatabaseClient) => ({ client, isAvailable: () => true, close: async () => { closed.push(name); } });
  const config = { scope, planning: planner.plannerConfig, routes: [planner.route], clock: () => now,
    database: resource("task", wrap()), ideaCreation: { database: resource("idea", f.client), integrityKey: key,
      participants: buildIdeaLabFixtureV1().session.participants },
    ideaRuntime: { database: resource("runtime-db", f.runtimeDb), runtime: f.runtime, close: async () => { closed.push("runtime"); } } };
  return { ...f, config, closed, cleanup: async () => { await planner.close(); await f.db.close(); } };
}

export { fixture, managedFixture, scope, key, at, deferred };
