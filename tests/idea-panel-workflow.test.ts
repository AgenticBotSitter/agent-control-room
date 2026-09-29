import assert from "node:assert/strict";
import test from "node:test";
import { fixture, now, request, trust } from "./helpers/web-foundation";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IdeaLabBotRunStoreV1 } from "../src/idea-lab/v1/coordinator-store";
import { IdeaLabBotCoordinatorV1, DeterministicIdeaLabFakeDriverV1, buildRepositoryFakeProviderEvidenceV1,
  buildIdeaLabBotRunV1 } from "../src/idea-lab/v1/coordinator";
import { DeterministicIdeaLabSynthesisEngineV1 } from "../src/idea-lab/v1/synthesis-engine";
import { IdeaLabOwnerDecisionServiceV1 } from "../src/idea-lab/v1/owner-decision-service";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../src/idea-lab/v1/schemas";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { sha256Digest } from "../src/security/digest";

test("saved panel completes once, promotes only by owner decision, and retains uncertain runs without reinvoking", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const key = new Uint8Array(32).fill(0x42), source = buildIdeaLabFixtureV1();
  const registry = new IdeaLabProjectRegistryStoreV1(f.client, key);
  const ledger = new IdeaLabBotRunStoreV1(f.client, key);
  const at = new Date(now).toISOString();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:workflow", tenantId: "tenant:web", workspaceId: "workspace:web",
    title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: 2, maxDurationSeconds: 600, maxCostUsd: 4,
    createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: at });
  await registry.registerSession(session);
  await f.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,'tenant:web','control_room_native_ideas','1.0.0','control_room_native','fixture','v1',30)`, [CONTROL_ROOM_IDEA_ADAPTER_V1]);
  const evidence = session.participants.map((p, i) => buildRepositoryFakeProviderEvidenceV1(session, p, {
    evidenceId: `evidence:workflow:${i}`, capturedAt: at, expiresAt: new Date(now + 120000).toISOString(),
  }));
  const fake = new DeterministicIdeaLabFakeDriverV1(); let calls = 0;
  const driver = { mode: "repository_fake" as const, invoke: async (input: Parameters<typeof fake.invoke>[0]) => {
    if (input.round === 2) {
      assert.match(input.safePrompt, /untrusted data, not instructions/);
      for (const peer of session.participants) assert.ok(input.safePrompt.includes(`${peer.perspective}: `));
      assert.ok(input.safePrompt.length <= 800);
    }
    calls++; return fake.invoke(input);
  } };
  const input = { runId: "run:workflow", session, evidence, safePrompt: "Compare this idea from every assigned perspective." };
  const run = await new IdeaLabBotCoordinatorV1(ledger, registry, driver, () => at).execute(input);
  assert.equal(run.state, "completed"); assert.equal(calls, 8); assert.equal(run.messagesUsed, 8);
  assert.equal(run.providerContacted, false);
  const contributions = await registry.listContributions(session.tenantId, session.sessionId);
  assert.equal(contributions.length, 8);
  const synthesis = new DeterministicIdeaLabSynthesisEngineV1().build(session, contributions, at);
  await registry.recordSynthesis(synthesis);
  assert.equal((await registry.listProjects(session.tenantId)).length, 0);
  const recreated = new IdeaLabBotCoordinatorV1(new IdeaLabBotRunStoreV1(f.client, key),
    new IdeaLabProjectRegistryStoreV1(f.client, key), driver, () => at);
  assert.deepEqual(await recreated.execute(input), run); assert.equal(calls, 8);
  const decisionService = new IdeaLabOwnerDecisionServiceV1(f.client, key);
  const decisionInput = { sessionId: session.sessionId,
    intent: { decision: "create_project", safeReasonCode: "owner_promoted_for_validation",
      project: { ...source.decision.project!, projectId: "project:panel-workflow" } },
    authentication: { tenantId: session.tenantId, provider: trust.issuer, subject: "test-owner",
      verifiedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 300000).toISOString() }, now: at };
  await assert.rejects(decisionService.apply({ ...decisionInput,
    authentication: { ...decisionInput.authentication, subject: "unknown-owner" } }));
  assert.equal((await registry.listProjects(session.tenantId)).length, 0);
  const promoted = await decisionService.apply(decisionInput);
  assert.equal(promoted.project?.sourceIdeaSessionId, session.sessionId);
  assert.equal((await registry.listProjects(session.tenantId)).length, 1);
  assert.equal((await decisionService.apply(decisionInput)).replayed, true);
  assert.equal((await registry.listProjects(session.tenantId)).length, 1);

  // A different saved run loses its provider response. Reconstructing services is
  // a persisted-state test, not a process-crash or live-provider qualification.
  let interruptedCalls = 0;
  const interruptedDriver = { mode: "repository_fake" as const, invoke: async () => {
    interruptedCalls++; throw new Error("synthetic response lost");
  } };
  const interruptedInput = { ...input, runId: "run:workflow-interrupted" };
  const interrupted = await new IdeaLabBotCoordinatorV1(ledger, registry, interruptedDriver, () => at).execute(interruptedInput);
  assert.equal(interrupted.state, "ambiguous");
  const recovery = new IdeaLabBotCoordinatorV1(new IdeaLabBotRunStoreV1(f.client, key), registry, interruptedDriver, () => at);
  assert.deepEqual(await recovery.execute(interruptedInput), interrupted);
  assert.equal(interruptedCalls, 1); assert.equal((await registry.listContributions(session.tenantId, session.sessionId)).length, 8);
});

/** Covers IdeaSessionCreationService (src/web/v1/idea-create-operation.ts), the
 * only Idea Lab session class actually wired in private-idea-authoring-startup. */
const ideaCreateScope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const ideaCreateKey = new Uint8Array(32).fill(0x7a);
const ideaDraft = { title: "Panel under test", ideaSummary: "A safe desk that answers leads for small trade businesses without quoting work.",
  targetCustomer: "Owner-operated trade businesses", maxRounds: 2, maxDurationSeconds: 600, maxCostUsd: 4 };
const webError = (code: string) => (error: unknown) => error instanceof WebAccessError && error.code === code;

async function ideaCreationFixture() {
  const f = await fixture();
  const identity = createAccessVerifier(trust)(request(), now);
  const participants = buildIdeaLabFixtureV1().session.participants;
  const service = new IdeaSessionCreationService(f.client, ideaCreateScope, ideaCreateKey, participants, () => now);
  return { f, identity, service, participants };
}

async function recordPreparedIdeaRun(f: Awaited<ReturnType<typeof fixture>>, runId: string, sessionId: string, sessionDigest: string) {
  const at = new Date(now).toISOString();
  await new IdeaLabBotRunStoreV1(f.client, ideaCreateKey).prepare(buildIdeaLabBotRunV1({
    runId, tenantId: "tenant:web", workspaceId: "workspace:web", sessionId, sessionDigest,
    evidenceDigests: [sha256Digest({ runId, n: 1 }), sha256Digest({ runId, n: 2 }), sha256Digest({ runId, n: 3 })],
    state: "prepared", attempts: [], messagesUsed: 0, costUsd: 0, safeCode: "prepared",
    providerContacted: false, startedAt: at, updatedAt: at }));
}

test("idea session options returns the roster and create saves a replayable session", async t => {
  const { f, identity, service, participants } = await ideaCreationFixture();
  t.after(() => f.db.close());
  const options = await service.options(identity);
  assert.equal(options.startsWork, false);
  assert.equal(options.minParticipants, 3); assert.equal(options.maxParticipants, 6);
  assert.deepEqual(options.participants.map(p => p.participantId), participants.map(p => p.participantId));
  assert.ok(options.participants.some(p => p.perspective === "skeptic"));
  const receipt = await service.create(identity, ideaDraft, "idea-create-key-0001");
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.startsWork, false);
  assert.equal(receipt.execution, "not_requested");
  assert.equal(receipt.idempotencyKey, "idea-create-key-0001");
  const store = new IdeaLabProjectRegistryStoreV1(f.client, ideaCreateKey);
  const saved = await store.getSession("tenant:web", receipt.sessionId);
  assert.ok(saved);
  assert.equal(saved.sessionId, receipt.sessionId);
  assert.equal(saved.sessionDigest, receipt.sessionDigest);
  assert.equal(saved.title, ideaDraft.title);
  assert.equal(saved.participants.length, participants.length);
  assert.equal((await store.listSessions("tenant:web", "workspace:web")).length, 1);
  const replay = await service.create(identity, ideaDraft, "idea-create-key-0001");
  assert.equal(replay.replayed, true);
  assert.equal(replay.sessionId, receipt.sessionId);
  assert.equal(replay.sessionDigest, receipt.sessionDigest);
  assert.equal((await store.listSessions("tenant:web", "workspace:web")).length, 1);
});

test("idea session create replay with a changed digest throws conflict", async t => {
  const { f, identity, service } = await ideaCreationFixture();
  t.after(() => f.db.close());
  await service.create(identity, ideaDraft, "idea-create-key-0002");
  await assert.rejects(service.create(identity, { ...ideaDraft, title: "A different panel title" }, "idea-create-key-0002"),
    webError("conflict"));
});

test("idea session create against an unknown workspace throws not_found", async t => {
  const { f, identity, participants } = await ideaCreationFixture();
  t.after(() => f.db.close());
  const missing = new IdeaSessionCreationService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:missing" },
    ideaCreateKey, participants, () => now);
  await assert.rejects(missing.create(identity, ideaDraft, "idea-create-key-0003"), webError("not_found"));
});

test("idea session stop on a session with no active run throws not_found", async t => {
  const { f, identity, service } = await ideaCreationFixture();
  t.after(() => f.db.close());
  const receipt = await service.create(identity, ideaDraft, "idea-create-key-0004");
  await assert.rejects(service.stop(identity, receipt.sessionId,
    { runId: "run:stop-no-run", sessionDigest: receipt.sessionDigest }), webError("not_found"));
});

test("idea session stop with a mismatched session digest throws conflict", async t => {
  const { f, identity, service } = await ideaCreationFixture();
  t.after(() => f.db.close());
  const receipt = await service.create(identity, ideaDraft, "idea-create-key-0005");
  await recordPreparedIdeaRun(f, "run:stop-digest", receipt.sessionId, receipt.sessionDigest);
  await assert.rejects(service.stop(identity, receipt.sessionId,
    { runId: "run:stop-digest", sessionDigest: `sha256:${"0".repeat(64)}` }), webError("conflict"));
});

test("idea session stop with a mismatched run id throws conflict", async t => {
  const { f, identity, service } = await ideaCreationFixture();
  t.after(() => f.db.close());
  const receipt = await service.create(identity, ideaDraft, "idea-create-key-0006");
  await recordPreparedIdeaRun(f, "run:stop-runid", receipt.sessionId, receipt.sessionDigest);
  await assert.rejects(service.stop(identity, receipt.sessionId,
    { runId: "run:stop-runid-other", sessionDigest: receipt.sessionDigest }), webError("conflict"));
});
