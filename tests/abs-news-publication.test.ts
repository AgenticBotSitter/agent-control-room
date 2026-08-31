import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { COMPLETION_GATE_SCHEMA_VERSION_V1, type ConsequentialApprovalDecisionV1 } from "../src/completion-gate/v1";
import {
  AbsNewsInjectedPublicationDestinationV1,
  AbsNewsPublicationSimulationCoordinatorV1,
  buildAbsNewsPublicationApprovalRequestV1,
  buildAbsNewsPublicationAuthorizationV1,
  buildAbsNewsPublicationClaimV1,
  buildAbsNewsPublicationDestinationResultV1,
  buildAbsNewsPublicationDestinationV1,
  buildAbsNewsPublicationMarkerV1,
  buildAbsNewsPublicationPackageV1,
  buildAbsNewsPublicationRequestV1,
  parseAbsNewsPublicationPackageV1,
  parseAbsNewsPublicationRequestV1,
  SqliteAbsNewsPublicationStoreV1,
  type AbsNewsPublicationDestinationResultV1,
  type AbsNewsPublicationDestinationV1,
  type AbsNewsPublicationPackageV1,
  type AbsNewsPublicationRequestV1,
} from "../src/project-adapters/abs-news/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { createHostResultCollectorV1 } from "../src/security/host-value";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const scope = { tenantId: "tenant:abs", workspaceId: "workspace:abs:news", projectId: "project:abs:news" };
const key = new Uint8Array(32).fill(71);
const t0 = "2026-08-29T14:00:00.000Z", t1 = "2026-08-29T14:01:00.000Z", t2 = "2026-08-29T14:02:00.000Z";
const t3 = "2026-08-29T14:03:00.000Z", t4 = "2026-08-29T14:04:00.000Z", t5 = "2026-08-29T14:05:00.000Z";
const expiry = "2026-08-29T14:10:00.000Z";

function publicationPackage(revision = 3): AbsNewsPublicationPackageV1 {
  return buildAbsNewsPublicationPackageV1({ packageId: `package:abs:article:r${revision}`, ...scope, storyId: "story:abs:ai-release",
    storyDigest: sha256Digest({ story: "ai-release" }), sourceEvidenceDigests: [sha256Digest({ source: "direct" })],
    draftArtifactId: `artifact:abs:article:r${revision}`, draftArtifactDigest: sha256Digest({ artifact: revision }), contentRevision: revision,
    contentDigest: sha256Digest({ content: revision }), title: "A verified AI release explained", slug: "verified-ai-release-explained",
    excerpt: "A bounded editorial summary prepared for the public ABS website.", completionTargetId: `target:abs:article:r${revision}`,
    completionTargetDigest: sha256Digest({ target: revision }), acceptedCompletionReviewDigest: sha256Digest({ review: revision }),
    verificationDigests: [sha256Digest({ verification: revision })], preparedAt: t0 });
}

function destination(environment: "simulation" | "configured_live" = "simulation"): AbsNewsPublicationDestinationV1 {
  return buildAbsNewsPublicationDestinationV1({ destinationId: "destination:abs:public-articles", ...scope,
    destinationKind: "abs_public_site_article", environment, publicOrigin: "https://abs.example.com",
    adapterId: "adapter:abs:publication:v1", adapterReleaseDigest: sha256Digest({ adapter: "publication-v1" }),
    credentialsReferenceDigests: [], networkConfigured: environment === "configured_live" });
}

function request(overrides: { requestId?: string; publicationPackage?: AbsNewsPublicationPackageV1;
  destination?: AbsNewsPublicationDestinationV1 } = {}): AbsNewsPublicationRequestV1 {
  return buildAbsNewsPublicationRequestV1({ package: overrides.publicationPackage ?? publicationPackage(),
    destination: overrides.destination ?? destination(), requestId: overrides.requestId ?? "request:abs:publish:r3",
    jobId: "job:abs:publish", attemptId: "attempt:abs:publish:1", effectIntentId: "effect:abs:publish:article",
    requestedAt: t0, expiresAt: expiry });
}

function decision(req: AbsNewsPublicationRequestV1, mode: "simulation" | "owner_live" = "simulation"): ConsequentialApprovalDecisionV1 {
  const approval = buildAbsNewsPublicationApprovalRequestV1(req);
  return { schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1, id: `decision:abs:publish:${mode}`, tenantId: req.tenantId,
    projectId: req.projectId, requestId: approval.id, requestDigest: sha256Digest(approval), operationDigest: req.operationDigest,
    policyDecisionId: mode === "simulation" ? "policy:synthetic:abs-publish" : "policy:owner:abs-publish",
    decision: "approved", decidedBy: { actorId: "identity:owner", actorType: "human" }, factor: "strong",
    authenticationEventDigest: sha256Digest({ authentication: mode }), decidedAt: t1, expiresAt: expiry,
    safeReasonCode: "owner_approved_exact_publication", grantsExecutionAuthority: false, requiresSeparateNodeAttestation: true };
}

function bundle(mode: "simulation" | "owner_live" = "simulation", req = request()) {
  const approvalRequest = buildAbsNewsPublicationApprovalRequestV1(req), approvalDecision = decision(req, mode),
    authorization = buildAbsNewsPublicationAuthorizationV1({ request: req, approvalRequest, approvalDecision, authorizationMode: mode });
  return { publicationPackage: publicationPackage(req.contentRevision), destination: destination(mode === "simulation" ? "simulation" : "configured_live"),
    request: req, approvalRequest, approvalDecision, authorization };
}

function success(req: AbsNewsPublicationRequestV1, overrides: Record<string, unknown> = {}): AbsNewsPublicationDestinationResultV1 {
  return buildAbsNewsPublicationDestinationResultV1({ status: "succeeded", destinationId: req.destinationId,
    destinationIdentityDigest: req.destinationIdentityDigest, destinationIdempotencyKey: req.destinationIdempotencyKey,
    packageDigest: req.packageDigest, contentRevision: req.contentRevision, contentDigest: req.contentDigest,
    destinationPath: req.destinationPath, receiptId: "receipt:abs:synthetic:r3",
    destinationRevisionDigest: sha256Digest({ destinationRevision: 3 }), observedAt: t3, synthetic: true, networkUsed: false,
    publicMutationObserved: false, credentialsResolved: false, rawDraftBodyUsed: false, ...overrides });
}

async function location() {
  const directory = await mkdtemp(join(tmpdir(), "abs-publication-"));
  return { directory, path: join(directory, "ledger.sqlite") };
}

test("CR9D-ABS-070 freezes exact revision and destination identity while keeping editorial acceptance separate from publication authority", () => {
  const pack = publicationPackage(), target = destination(), req = request(), simulation = bundle("simulation", req).authorization;
  assert.deepEqual({ body: pack.containsDraftBody, credentials: pack.containsCredentials, editorial: pack.editoriallyAccepted,
    packageAuthorized: pack.publicationAuthorized, destinationAuthorized: target.publicationAuthorized, requestAuthorized: req.publicationAuthorized,
    risk: req.risk, factor: req.requiredFactor, network: req.allowsNetwork }, { body: false, credentials: false, editorial: true,
    packageAuthorized: false, destinationAuthorized: false, requestAuthorized: false, risk: "high", factor: "strong", network: false });
  assert.equal(simulation.destinationWriteAuthorized, false);
  const liveReq = request({ destination: destination("configured_live") }), owner = bundle("owner_live", liveReq).authorization;
  assert.equal(owner.destinationWriteAuthorized, true); assert.equal(owner.grantsExecutionAuthority, false);
  assert.notEqual(request({ publicationPackage: publicationPackage(4) }).destinationIdempotencyKey, req.destinationIdempotencyKey);
  const { contractVersion: _contractVersion, containsDraftBody: _body, containsCredentials: _credentials,
    editoriallyAccepted: _editorial, requiresAuthoritativeCompletionResolution: _completion, publicationAuthorized: _authorized,
    grantsApproval: _approval, grantsExecutionAuthority: _execution, packageDigest: _packageDigest, ...packageInput } = publicationPackage();
  void [_contractVersion, _body, _credentials, _editorial, _completion, _authorized, _approval, _execution, _packageDigest];
  assert.throws(() => buildAbsNewsPublicationPackageV1({ ...packageInput,
    excerpt: "api_key=sk_test_12345678901234567890" }), ProjectWorkspaceContractErrorV1);
  for (const publicOrigin of ["http://abs.example.com", "https://localhost", "https://127.0.0.1", "https://abs.example.com/path", "https://user@abs.example.com"]) {
    assert.throws(() => buildAbsNewsPublicationDestinationV1({ destinationId: "destination:bad", ...scope,
      destinationKind: "abs_public_site_article", environment: "simulation", publicOrigin, adapterId: "adapter:bad",
      adapterReleaseDigest: sha256Digest({ bad: publicOrigin }), credentialsReferenceDigests: [], networkConfigured: false }),
    ProjectWorkspaceContractErrorV1);
  }
});

test("CR9D-ABS-070 fake publication is durable, cleanup-bound, and exact replay makes no second destination call", async () => {
  const target = await location();
  try {
    let store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    const registered = store.register(bundle()), fake = new AbsNewsInjectedPublicationDestinationV1([success(registered.bundle.request)]),
      first = await new AbsNewsPublicationSimulationCoordinatorV1(store, fake).run({ requestId: registered.bundle.request.requestId,
        claimedAt: t2, markedAt: t3, settledAt: t4 });
    assert.deepEqual({ disposition: first.outcome.disposition, invoked: first.destinationInvoked, calls: fake.callCount,
      fakePublications: fake.publicationCount, publicMutation: first.outcome.publicMutationObserved,
      externalEffect: first.outcome.externalEffectOccurred }, { disposition: "succeeded", invoked: true, calls: 1,
      fakePublications: 1, publicMutation: false, externalEffect: false });
    const before = store.verifyIntegrity(); store.close();
    store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "open" });
    const replayFake = new AbsNewsInjectedPublicationDestinationV1([]), replay = await new AbsNewsPublicationSimulationCoordinatorV1(store, replayFake)
      .run({ requestId: registered.bundle.request.requestId, claimedAt: "2026-08-29T14:11:00.000Z", markedAt: t3, settledAt: t4 });
    assert.equal(replay.replayed, true); assert.equal(replayFake.callCount, 0); assert.deepEqual(store.verifyIntegrity(), before);
    store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9D-ABS-070 fake destination independently absorbs a duplicate idempotency key", async () => {
  const req = request(), result = success(req), fake = new AbsNewsInjectedPublicationDestinationV1([result]);
  for (let index = 0; index < 2; index += 1) {
    const handoff = createHostResultCollectorV1();
    await fake.publish({ request: req, publicationPackage: publicationPackage(), destination: destination() }, handoff.collector);
    assert.deepEqual(handoff.take(), result);
  }
  assert.equal(fake.callCount, 2); assert.equal(fake.publicationCount, 1);
});

test("CR9D-ABS-070 definite pre-mutation rejection is terminal", async () => {
  const target = await location();
  try {
    const store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "create" }),
      registered = store.register(bundle()), req = registered.bundle.request,
      failure = buildAbsNewsPublicationDestinationResultV1({ status: "definite_failure", destinationId: req.destinationId,
        destinationIdentityDigest: req.destinationIdentityDigest, destinationIdempotencyKey: req.destinationIdempotencyKey,
        packageDigest: req.packageDigest, contentRevision: req.contentRevision, contentDigest: req.contentDigest,
        destinationPath: req.destinationPath, safeFailureCode: "rejected_before_mutation", observedAt: t3, synthetic: true,
        networkUsed: false, publicMutationObserved: false, credentialsResolved: false, rawDraftBodyUsed: false }),
      fake = new AbsNewsInjectedPublicationDestinationV1([failure]), result = await new AbsNewsPublicationSimulationCoordinatorV1(store, fake)
        .run({ requestId: req.requestId, claimedAt: t2, markedAt: t3, settledAt: t4 });
    assert.equal(result.outcome.disposition, "definite_failure"); assert.equal(fake.publicationCount, 0);
    const replay = await new AbsNewsPublicationSimulationCoordinatorV1(store, new AbsNewsInjectedPublicationDestinationV1([]))
      .run({ requestId: req.requestId, claimedAt: t2, markedAt: t3, settledAt: t4 });
    assert.equal(replay.replayed, true); store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9D-ABS-070 malformed, mismatched, thrown, and Proxy handoffs become terminal ambiguity", async () => {
  for (const variant of ["mismatch", "throw", "proxy"] as const) {
    const target = await location();
    try {
      const store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "create" }),
        registered = store.register(bundle()), ordinary = success(registered.bundle.request,
          variant === "mismatch" ? { contentRevision: 999 } : {});
      let traps = 0;
      const adapter = { async publish(_input: unknown, collector: { submit(value: unknown): void }) {
        if (variant === "throw") throw new Error("uncertain_after_marker");
        if (variant === "proxy") { const proxied = observedProxy(ordinary, "transparent"); traps = proxied.trapCount();
          assert.throws(() => collector.submit(proxied.value)); traps = proxied.trapCount(); return; }
        collector.submit(ordinary);
      } };
      const result = await new AbsNewsPublicationSimulationCoordinatorV1(store, adapter)
        .run({ requestId: registered.bundle.request.requestId, claimedAt: t2, markedAt: t3, settledAt: t4 });
      assert.equal(result.outcome.disposition, "ambiguous"); assert.equal(result.outcome.safeReasonCode, "post_marker_outcome_unknown");
      assert.equal(traps, 0); store.close();
    } finally { await rm(target.directory, { recursive: true, force: true }); }
  }
});

test("CR9D-ABS-070 restart after marker is terminal ambiguity and authenticated deletion is detected", async () => {
  const target = await location();
  try {
    let store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    const registered = store.register(bundle()), claim = buildAbsNewsPublicationClaimV1({ request: registered.bundle.request,
      authorization: registered.bundle.authorization, claimedAt: t2 });
    assert.equal(store.claim({ request: registered.bundle.request, authorization: registered.bundle.authorization, claimedAt: t2 }).disposition,
      "run_permitted");
    store.mark(claim, t3); store.close();
    store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "open" });
    assert.equal(store.recoverUnsettled(t4)[0]?.safeReasonCode, "restart_after_marker");
    assert.equal(store.recoverUnsettled(t5).length, 0); store.close();
    const attacker = new DatabaseSync(target.path);
    attacker.exec("DELETE FROM abs_news_publication_records WHERE kind='outcome'"); attacker.close();
    assert.throws(() => new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "open" }),
      (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9D-ABS-070 exact boundaries reject request aliasing, digest drift, accessors, and Proxies without traps", async () => {
  const target = await location();
  try {
    const store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "create" }), original = bundle();
    store.register(original);
    const changedRequest = request({ requestId: "request:abs:publish:alias" }), changed = bundle("simulation", changedRequest);
    assert.equal(changedRequest.destinationIdempotencyKey, original.request.destinationIdempotencyKey);
    assert.throws(() => store.register(changed), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1
      && error.safeCode === "replay_drift");
    const pack = publicationPackage();
    assert.throws(() => parseAbsNewsPublicationPackageV1({ ...pack, contentRevision: pack.contentRevision + 1 }),
      (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "digest_mismatch");
    const { requestDigest: _requestDigest, ...requestMaterial } = original.request; void _requestDigest;
    const forgedMaterial = { ...requestMaterial, operationDigest: sha256Digest({ forged: "operation" }) };
    assert.throws(() => parseAbsNewsPublicationRequestV1({ ...forgedMaterial, requestDigest: sha256Digest(forgedMaterial) }),
      (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "digest_mismatch");
    let calls = 0; const accessor = { ...original.request };
    Object.defineProperty(accessor, "requestId", { enumerable: true, get() { calls += 1; return original.request.requestId; } });
    assert.throws(() => parseAbsNewsPublicationRequestV1(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
    const proxied = observedProxy(original.request, "transparent");
    assert.throws(() => parseAbsNewsPublicationRequestV1(proxied.value), ProjectWorkspaceContractErrorV1);
    assert.equal(proxied.trapCount(), 0); store.close();
    const attacker = new DatabaseSync(target.path);
    attacker.exec("CREATE TRIGGER publication_injected AFTER INSERT ON abs_news_publication_records BEGIN SELECT 1; END"); attacker.close();
    assert.throws(() => new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "open" }),
      (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9D-ABS-070 owner-live and configured destinations cannot enter the fake coordinator", async () => {
  const target = await location();
  try {
    const liveDestination = destination("configured_live"), liveRequest = request({ destination: liveDestination }), liveBundle = bundle("owner_live", liveRequest),
      corrected = { ...liveBundle, destination: liveDestination, publicationPackage: publicationPackage() },
      store = new SqliteAbsNewsPublicationStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    store.register(corrected);
    await assert.rejects(() => new AbsNewsPublicationSimulationCoordinatorV1(store, new AbsNewsInjectedPublicationDestinationV1([]))
      .run({ requestId: liveRequest.requestId, claimedAt: t2, markedAt: t3, settledAt: t4 }),
    (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "unsupported_action");
    store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9D-ABS-070 marker remains bound to the stable destination idempotency identity", () => {
  const value = bundle(), claim = buildAbsNewsPublicationClaimV1({ request: value.request, authorization: value.authorization, claimedAt: t2 }),
    marker = buildAbsNewsPublicationMarkerV1({ claim, markedAt: t3 });
  assert.equal(marker.destinationIdempotencyKey, value.request.destinationIdempotencyKey);
  assert.equal(marker.operationDigest, value.request.operationDigest);
  assert.equal(marker.externalEffectOccurred, false);
});
