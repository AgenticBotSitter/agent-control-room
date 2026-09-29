import assert from "node:assert/strict";
import test from "node:test";
import { fixture, now, trust } from "./helpers/web-foundation";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IdeaLabBotRunStoreV1 } from "../src/idea-lab/v1/coordinator-store";
import { IdeaLabBotCoordinatorV1, DeterministicIdeaLabFakeDriverV1, buildIdeaLabBotRunV1, buildRepositoryFakeProviderEvidenceV1 } from "../src/idea-lab/v1/coordinator";
import { DeterministicIdeaLabSynthesisEngineV1 } from "../src/idea-lab/v1/synthesis-engine";
import { IdeaLabOwnerDecisionServiceV1 } from "../src/idea-lab/v1/owner-decision-service";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../src/idea-lab/v1/schemas";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { WebAccessError, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security/digest";
import type { DatabaseClient } from "../src/persistence/database";

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

// Coverage for the production-wired IdeaSessionCreationService
// (src/web/v1/idea-create-operation.ts), the session creation/stop operation
// that src/web/v1/private-idea-authoring-startup.ts mounts for the real VPS
// server entrypoint. The deliberately-unmounted WebIdeaStartOperation /
// WebIdeaSynthesisOperation / WebIdeaDecisionOperation classes are out of scope.

const ideaScope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const ideaKey = () => new Uint8Array(32).fill(0x42);

/** The owner the web-foundation fixture bootstraps, as a verified web identity. */
function ideaIdentity(): VerifiedWebIdentity {
  return {
    provider: trust.issuer,
    subject: "test-owner",
    tokenDigest: sha256Digest({ token: "idea-panel-workflow-test-token" }),
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
    verificationExpiresAt: new Date(now + 300_000).toISOString(),
  };
}

function creationService(client: DatabaseClient, scope = ideaScope) {
  const source = buildIdeaLabFixtureV1();
  return {
    source,
    service: new IdeaSessionCreationService(client, scope, ideaKey(), source.session.participants, () => now),
  };
}

function creationInput(source: ReturnType<typeof buildIdeaLabFixtureV1>) {
  return {
    title: source.session.title,
    ideaSummary: source.session.ideaSummary,
    targetCustomer: source.session.targetCustomer,
    maxRounds: 2,
    maxDurationSeconds: 600,
    maxCostUsd: 4,
  };
}

const isWebAccessErrorWithCode = (code: "conflict" | "not_found") => (err: unknown) =>
  err instanceof WebAccessError && err.code === code;

async function sessionRowCount(client: DatabaseClient, sessionId: string): Promise<string | undefined> {
  const rows = (await client.query<{ c: string }>(
    "SELECT count(*)::text AS c FROM control_idea_sessions WHERE tenant_id=$1 AND session_id=$2",
    [ideaScope.tenantId, sessionId])).rows;
  return rows[0]?.c;
}

test("idea session creation: options lists the configured roster and create persists a retrievable session", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const { source, service } = creationService(f.client);
  const identity = ideaIdentity();

  const opts = await service.options(identity);
  assert.equal(opts.startsWork, false);
  assert.equal(opts.participants.length, source.session.participants.length);
  assert.ok(opts.participants.some(p => p.perspective === "skeptic"));
  for (const expected of source.session.participants) {
    const listed = opts.participants.find(p => p.participantId === expected.participantId);
    assert.ok(listed, `roster is missing ${expected.participantId}`);
    assert.equal(listed.participantDigest, sha256Digest(expected));
    assert.equal(listed.displayName, expected.displayName);
    assert.equal(listed.perspective, expected.perspective);
    assert.equal(listed.harness, expected.harness);
  }

  const input = creationInput(source);
  const receipt = await service.create(identity, input, "test-key-0001");
  assert.equal(receipt.replayed, false);
  assert.match(receipt.sessionId, /^idea:/);
  assert.equal(receipt.idempotencyKey, "test-key-0001");
  assert.match(receipt.sessionDigest, /^sha256:[a-f0-9]{64}$/);

  // A second store instance proves the session is really persisted in the
  // database, not held in memory by the service.
  const reread = new IdeaLabProjectRegistryStoreV1(f.client, ideaKey());
  const saved = await reread.getSession(ideaScope.tenantId, receipt.sessionId);
  assert.ok(saved, "created session must be retrievable from the registry");
  assert.equal(saved.sessionId, receipt.sessionId);
  assert.equal(saved.sessionDigest, receipt.sessionDigest);
  assert.equal(saved.tenantId, ideaScope.tenantId);
  assert.equal(saved.workspaceId, ideaScope.workspaceId);
  assert.equal(saved.title, input.title);
  assert.equal(saved.ideaSummary, input.ideaSummary);
  assert.equal(saved.participants.length, source.session.participants.length);
});

test("idea session creation: replaying create with the same key returns the original session without a second write", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const { source, service } = creationService(f.client);
  const identity = ideaIdentity();
  const input = creationInput(source);

  const first = await service.create(identity, input, "test-key-0002");
  assert.equal(first.replayed, false);
  assert.equal(await sessionRowCount(f.client, first.sessionId), "1");

  const second = await service.create(identity, input, "test-key-0002");
  assert.equal(second.replayed, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.sessionDigest, first.sessionDigest);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(await sessionRowCount(f.client, first.sessionId), "1");
});

test("idea session creation: replaying with changed input throws a conflict error", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const { source, service } = creationService(f.client);
  const identity = ideaIdentity();
  const input = creationInput(source);

  const first = await service.create(identity, input, "test-key-0003");
  assert.equal(first.replayed, false);

  await assert.rejects(
    service.create(identity, { ...input, title: `${input.title} (revised)` }, "test-key-0003"),
    isWebAccessErrorWithCode("conflict"));
  // The conflicting retry must not have replaced the original session.
  const saved = await new IdeaLabProjectRegistryStoreV1(f.client, ideaKey())
    .getSession(ideaScope.tenantId, first.sessionId);
  assert.equal(saved?.title, input.title);
});

test("idea session creation: create against an unknown workspace throws not_found", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const { source, service: ghost } = creationService(f.client,
    { tenantId: "tenant:web", workspaceId: "workspace:ghost" });
  await assert.rejects(
    ghost.create(ideaIdentity(), creationInput(source), "test-key-0004"),
    isWebAccessErrorWithCode("not_found"));
});

test("idea session stop: stop on a session with no active run throws not_found", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const { source, service } = creationService(f.client);
  const identity = ideaIdentity();

  const receipt = await service.create(identity, creationInput(source), "test-key-0005");
  assert.equal(receipt.replayed, false);

  await assert.rejects(
    service.stop(identity, receipt.sessionId, { runId: "run:ghost", sessionDigest: receipt.sessionDigest }),
    isWebAccessErrorWithCode("not_found"));
});

test("idea session stop: stop with a mismatched session digest or run id throws conflict", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const key = ideaKey(), { source, service } = creationService(f.client);
  const identity = ideaIdentity();

  const receipt = await service.create(identity, creationInput(source), "test-key-0006");
  assert.equal(receipt.replayed, false);

  const at = new Date(now).toISOString();
  const ledger = new IdeaLabBotRunStoreV1(f.client, key);
  await ledger.prepare(buildIdeaLabBotRunV1({
    runId: "run:stop-conflict", tenantId: ideaScope.tenantId, workspaceId: ideaScope.workspaceId,
    sessionId: receipt.sessionId, sessionDigest: receipt.sessionDigest,
    evidenceDigests: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`],
    state: "prepared", attempts: [], messagesUsed: 0, costUsd: 0, safeCode: "test_prepared",
    providerContacted: false, startedAt: at, updatedAt: at,
  }));

  // A digest that does not match the retained session is a conflicting retry.
  await assert.rejects(
    service.stop(identity, receipt.sessionId,
      { runId: "run:stop-conflict", sessionDigest: `sha256:${"f".repeat(64)}` }),
    isWebAccessErrorWithCode("conflict"));
  // A run id that does not match the retained run is a conflicting retry.
  await assert.rejects(
    service.stop(identity, receipt.sessionId,
      { runId: "run:other", sessionDigest: receipt.sessionDigest }),
    isWebAccessErrorWithCode("conflict"));

  // Neither rejected stop disturbed the retained run.
  const retained = await ledger.getForSession({ tenantId: ideaScope.tenantId,
    workspaceId: ideaScope.workspaceId, sessionId: receipt.sessionId, sessionDigest: receipt.sessionDigest });
  assert.equal(retained?.runId, "run:stop-conflict");
  assert.equal(retained?.state, "prepared");
});
