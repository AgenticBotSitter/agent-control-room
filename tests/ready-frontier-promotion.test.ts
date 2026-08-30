import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database.ts";
import { DeliveryStore } from "../src/persistence/delivery-store.ts";
import {
  ReadyFrontierContractErrorV1,
  ReadyFrontierMaterializationServiceV1,
  ReadyFrontierPromotionServiceV1,
  ReadyFrontierReadyPolicyStoreV1,
  ReadyFrontierSimulationStoreV1,
  ReadyFrontierStandingPolicyStoreV1,
  buildReadyFrontierMaterializationRequestFixtureV1,
  buildReadyFrontierPromotionEnvelopeFixtureV1,
  buildReadyFrontierPromotionV1,
  buildReadyFrontierReadyPolicyFixtureV1,
  buildReadyFrontierReadyPolicyV1,
  buildReadyFrontierRepositoryFixtureEvaluationV1,
  buildReadyFrontierStandingPolicyFixtureV1,
  parseReadyFrontierPromotionV1,
  parseReadyFrontierReadyPolicyV1,
  projectReadyFrontierPromotionV1,
  readyFrontierRepositoryFixtureEvaluationKeyV1,
  readyFrontierRepositoryFixtureReadyPolicyKeyV1,
  readyFrontierRepositoryFixtureStandingPolicyKeyV1,
  type ReadyFrontierReadyPolicyV1,
  type ReadyFrontierStandingPolicyV1,
} from "../src/ready-frontier/v1/index.ts";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const code = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function resources() {
  const directory = mkdtempSync(join(tmpdir(), "cr11b-auto-030-")); chmodSync(directory, 0o700);
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1();
  const standingKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  const readyKey = readyFrontierRepositoryFixtureReadyPolicyKeyV1();
  const evaluationCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const standingCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const readyCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const evaluations = new ReadyFrontierSimulationStoreV1(join(directory, "evaluations.sqlite"),
    "tenant.owner", evaluationKey, evaluationCheckpoints);
  const standingPolicies = new ReadyFrontierStandingPolicyStoreV1(join(directory, "standing.sqlite"),
    "tenant.owner", "workspace.control-room", standingKey, standingCheckpoints);
  const readyPolicies = new ReadyFrontierReadyPolicyStoreV1(join(directory, "ready.sqlite"),
    "tenant.owner", "workspace.control-room", readyKey, readyCheckpoints);
  return { directory, evaluationKey, standingKey, readyKey, evaluationCheckpoints, standingCheckpoints,
    readyCheckpoints, evaluations, standingPolicies, readyPolicies };
}
async function database() {
  const db = new PGlite();
  for (const file of readdirSync(resolve("db/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(resolve("db/migrations", file), "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", ["tenant.owner", "Owner"]); return db;
}
function close(resource: ReturnType<typeof resources>): void {
  try { resource.evaluations.closeDatabase(); } catch { /* already closed */ }
  try { resource.standingPolicies.closeDatabase(); } catch { /* already closed */ }
  try { resource.readyPolicies.closeDatabase(); } catch { /* already closed */ }
  resource.evaluationKey.fill(0); resource.standingKey.fill(0); resource.readyKey.fill(0);
  rmSync(resource.directory, { recursive: true, force: true });
}
async function materialize(resource: ReturnType<typeof resources>, canonical: CanonicalStore, proposalIndex = 0) {
  const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(); resource.evaluations.recordEvaluation(evaluation);
  const standing = buildReadyFrontierStandingPolicyFixtureV1(resource.standingKey); resource.standingPolicies.recordPolicy(standing);
  const materializer = new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.standingPolicies,
    canonical, resource.evaluationKey, resource.standingKey);
  const result = await materializer.materialize(buildReadyFrontierMaterializationRequestFixtureV1(evaluation, standing, proposalIndex));
  materializer.close(); return { evaluation, standing, materialization: result.receipt };
}
function readyLifecycle(evaluation: ReturnType<typeof buildReadyFrontierRepositoryFixtureEvaluationV1>,
  standing: ReadyFrontierStandingPolicyV1, prior: ReadyFrontierReadyPolicyV1,
  input: { action: "revise" | "suspend" | "revoke"; state: "active" | "suspended" | "revoked";
    revision: number; recordedAt: string }, key: Uint8Array) {
  return buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, key, { revision: input.revision,
    previousPolicyDigest: prior.policyDigest, action: input.action, state: input.state,
    recordedAt: input.recordedAt, effectiveAt: input.recordedAt, expiresAt: "2026-08-30T20:00:00.000Z" });
}
function promoter(resource: ReturnType<typeof resources>, canonical: CanonicalStore,
  now = "2026-08-30T18:04:00.000Z") {
  return new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
    resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
    { now: () => now });
}

test("CR11B-AUTO-030 ready policy is exact, authenticated, repository-only, and non-dispatching", () => {
  const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1();
  const standingKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  const readyKey = readyFrontierRepositoryFixtureReadyPolicyKeyV1();
  try {
    const standing = buildReadyFrontierStandingPolicyFixtureV1(standingKey);
    const policy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, readyKey);
    assert.deepEqual({ state: policy.state, scope: policy.activationScope, ready: policy.permitsAutomaticReadyTransition,
      reserve: policy.permitsDatabaseSchedulerReservation, handoff: policy.permitsInternalJobberHandoff,
      transport: policy.handoffTransport, productionOwner: policy.productionOwnerAuthenticationVerified,
      productionReview: policy.productionIndependentReviewVerified, approval: policy.permitsAutomaticApproval,
      schedule: policy.permitsScheduleCreation, lease: policy.permitsClaimOrLease,
      dispatch: policy.permitsDispatchOrExecution, agent: policy.permitsAgentMessage,
      github: policy.permitsGitHubMutation, effect: policy.permitsExternalEffects },
    { state: "active", scope: "repository_simulation", ready: true, reserve: true, handoff: true,
      transport: "canonical_internal_table", productionOwner: false, productionReview: false, approval: false,
      schedule: false, lease: false, dispatch: false, agent: false, github: false, effect: false });
    assert.deepEqual(parseReadyFrontierReadyPolicyV1(policy, readyKey), policy);
    assert.throws(() => parseReadyFrontierReadyPolicyV1(policy, new Uint8Array(32).fill(0x31)), code("digest_mismatch"));
    const changed = clone(policy); changed.maximumActiveReadyGlobal += 1;
    assert.throws(() => parseReadyFrontierReadyPolicyV1(changed, readyKey), code("digest_mismatch"));
  } finally { standingKey.fill(0); readyKey.fill(0); }
});

test("CR11B-AUTO-030 ready policy lifecycle is restart-safe, suspendable, terminally revocable, and rollback-detecting", () => {
  const resource = resources(), path = join(resource.directory, "ready.sqlite"), backup = join(resource.directory, "ready-backup.sqlite");
  try {
    const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1();
    const standing = buildReadyFrontierStandingPolicyFixtureV1(resource.standingKey);
    copyFileSync(path, backup); chmodSync(backup, 0o600);
    const active = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    assert.equal(resource.readyPolicies.recordPolicy(active).replayed, false);
    assert.equal(resource.readyPolicies.recordPolicy(active).replayed, true);
    const suspended = readyLifecycle(evaluation, standing, active,
      { action: "suspend", state: "suspended", revision: 2, recordedAt: "2026-08-30T18:10:00.000Z" }, resource.readyKey);
    resource.readyPolicies.recordPolicy(suspended);
    const revoked = readyLifecycle(evaluation, standing, suspended,
      { action: "revoke", state: "revoked", revision: 3, recordedAt: "2026-08-30T18:11:00.000Z" }, resource.readyKey);
    resource.readyPolicies.recordPolicy(revoked);
    assert.equal(resource.readyPolicies.latestPolicy(active.policyId)?.state, "revoked");
    const illegal = readyLifecycle(evaluation, standing, revoked,
      { action: "revise", state: "active", revision: 4, recordedAt: "2026-08-30T18:12:00.000Z" }, resource.readyKey);
    assert.throws(() => resource.readyPolicies.recordPolicy(illegal), code("replay_drift"));
    resource.readyPolicies.closeDatabase();
    const restarted = new ReadyFrontierReadyPolicyStoreV1(path, "tenant.owner", "workspace.control-room",
      resource.readyKey, resource.readyCheckpoints);
    assert.deepEqual(restarted.listPolicies(), [active, suspended, revoked]); restarted.closeDatabase();
    copyFileSync(backup, path); chmodSync(path, 0o600);
    assert.throws(() => new ReadyFrontierReadyPolicyStoreV1(path, "tenant.owner", "workspace.control-room",
      resource.readyKey, resource.readyCheckpoints), code("integrity_failed"));
  } finally {
    try { resource.evaluations.closeDatabase(); } catch { /* closed */ }
    try { resource.standingPolicies.closeDatabase(); } catch { /* closed */ }
    resource.evaluationKey.fill(0); resource.standingKey.fill(0); resource.readyKey.fill(0);
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

test("CR11B-AUTO-030 active policy guards cannot be rolled back by reentrant policy writes", async () => {
  const resource = resources();
  try {
    const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1();
    const standing = buildReadyFrontierStandingPolicyFixtureV1(resource.standingKey);
    const ready = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    resource.standingPolicies.recordPolicy(standing); resource.readyPolicies.recordPolicy(ready);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const guarded = resource.readyPolicies.withCurrentPolicy(ready.policyId, ready.revision, ready.policyDigest,
      async () => { entered(); await held; return "committed"; });
    await inside;
    const suspended = readyLifecycle(evaluation, standing, ready,
      { action: "suspend", state: "suspended", revision: 2, recordedAt: "2026-08-30T18:10:00.000Z" }, resource.readyKey);
    assert.throws(() => resource.readyPolicies.recordPolicy(suspended), code("policy_inactive"));
    assert.throws(() => resource.readyPolicies.closeDatabase(), code("policy_inactive"));
    release(); assert.equal(await guarded, "committed");
    assert.equal(resource.readyPolicies.latestPolicy(ready.policyId)?.state, "active");
    assert.equal(resource.readyPolicies.recordPolicy(suspended).replayed, false);
  } finally { close(resource); }
});

test("CR11B-AUTO-030 generic transition cannot ready a frontier job without the complete protected bundle", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const { materialization } = await materialize(resource, canonical);
    await assert.rejects(() => canonical.transition({ tenantId: materialization.tenantId, kind: "job",
      entityId: materialization.job.id, expectedVersion: 0, toState: "ready", transitionId: "transition:bypass",
      idempotencyKey: "frontier-ready-bypass", actor: { actorId: "service:bypass", actorType: "service" },
      occurredAt: "2026-08-30T18:04:00.000Z" }), /policy-bound promotion operation/);
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='proposed')::text proposed,
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_transition_events)::text transitions,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
      (SELECT count(*) FROM control_outbox)::text outbox`);
    assert.deepEqual(counts.rows[0], { proposed: "1", ready: "0", reservations: "0",
      transitions: "0", handoffs: "0", outbox: "0" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 captured policy guards cannot mint the exact-operation canonical authorization", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
    const receipt = buildReadyFrontierPromotionV1(envelope, resource.evaluationKey, resource.standingKey,
      resource.readyKey, evaluation, standing, readyPolicy);
    let standingGuard!: object, readyGuard!: object;
    await resource.standingPolicies.withCurrentPolicy(standing.policyId, standing.revision, standing.policyDigest,
      (_currentStanding, activeStandingGuard) => resource.readyPolicies.withCurrentPolicy(readyPolicy.policyId,
        readyPolicy.revision, readyPolicy.policyDigest, async (_currentReady, activeReadyGuard) => {
          standingGuard = activeStandingGuard; readyGuard = activeReadyGuard;
        }));
    const revoked = readyLifecycle(evaluation, standing, readyPolicy,
      { action: "revoke", state: "revoked", revision: 2, recordedAt: "2026-08-30T18:10:00.000Z" }, resource.readyKey);
    resource.readyPolicies.recordPolicy(revoked);
    assert.ok(standingGuard); assert.ok(readyGuard);
    await assert.rejects(() => canonical.promoteReadyFrontierJobWithInternalHandoff({
      tenantId: receipt.tenantId, projectId: receipt.readyJob.projectId, jobId: receipt.readyJob.id,
      requestId: receipt.requestId, requestDigest: receipt.promotionRequestDigest, receiptDigest: receipt.receiptDigest,
      readyJobDigest: sha256Digest(receipt.readyJob), expectedJobVersion: 0, expectedJobDigest: receipt.proposedJobDigest,
      standingPolicy: { policyId: receipt.standingPolicyId, revision: receipt.standingPolicyRevision,
        policyDigest: receipt.standingPolicyDigest },
      readyPolicy: { policyId: receipt.readyPolicyId, revision: receipt.readyPolicyRevision,
        policyDigest: receipt.readyPolicyDigest },
      operationAuthorization: Object.freeze(Object.create(null)) as object,
      maximumActiveReadyGlobal: readyPolicy.maximumActiveReadyGlobal,
      maximumActiveReadyProject: readyPolicy.projectPolicies.find((item) => item.projectId === receipt.readyJob.projectId)!.maximumActiveReady,
      transitionId: `transition:frontier-ready:${sha256Digest({ receiptId: receipt.receiptId }).slice(7, 39)}`,
      transitionIdempotencyKey: `frontier-ready-${receipt.receiptDigest.slice(7)}`,
      actor: { actorId: "service:ready-frontier-promoter", actorType: "service" }, occurredAt: receipt.promotedAt,
      reservation: { id: receipt.reservation.reservationId, routeId: receipt.reservation.routeId,
        resourceKey: receipt.reservation.resourceKey, units: receipt.reservation.units,
        capacityUnits: receipt.reservation.capacityUnits, decisionDigest: receipt.reservation.decisionDigest,
        acquiredAt: receipt.reservation.acquiredAt, expiresAt: receipt.reservation.expiresAt },
      handoff: { id: receipt.handoff.handoffId, payloadDigest: sha256Digest(receipt.handoff),
        availableAt: receipt.handoff.createdAt, expiresAt: receipt.handoff.expiresAt,
        payload: clone(receipt.handoff) as unknown as Record<string, unknown> },
    }), /active exact-operation authorization/);
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs`);
    assert.deepEqual(counts.rows[0], { ready: "0", reservations: "0", handoffs: "0" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 exact-operation authorization rejects caller-expanded policy, resource, receipt, and handoff facts", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
    type PromotionInput = Parameters<CanonicalStore["promoteReadyFrontierJobWithInternalHandoff"]>[0];
    const original = canonical.promoteReadyFrontierJobWithInternalHandoff.bind(canonical);
    const attacks: Array<(input: PromotionInput) => PromotionInput> = [
      (input) => ({ ...input, maximumActiveReadyGlobal: input.maximumActiveReadyGlobal + 1 }),
      (input) => ({ ...input, maximumActiveReadyProject: input.maximumActiveReadyProject + 1 }),
      (input) => ({ ...input, reservation: { ...input.reservation, resourceKey: "resource:expanded" } }),
      (input) => ({ ...input, reservation: { ...input.reservation,
        units: input.reservation.units + 1, capacityUnits: input.reservation.capacityUnits + 1 } }),
      (input) => ({ ...input, requestDigest: sha256Digest({ substituted: "request" }) }),
      (input) => ({ ...input, receiptDigest: sha256Digest({ substituted: "receipt" }) }),
      (input) => ({ ...input, handoff: { ...input.handoff,
        payload: { ...input.handoff.payload, permitsClaimOrLease: true } } }),
    ];
    for (const attack of attacks) {
      canonical.promoteReadyFrontierJobWithInternalHandoff = (input) => original(attack(input));
      const service = promoter(resource, canonical);
      await assert.rejects(() => service.promote(envelope), /authorization mismatch/);
      service.close();
    }
    canonical.promoteReadyFrontierJobWithInternalHandoff = original;
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_transition_events)::text transitions,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
      (SELECT count(*) FROM control_idempotency WHERE operation_scope='ready-frontier-promotion')::text requests`);
    assert.deepEqual(counts.rows[0], { ready: "0", reservations: "0", transitions: "0", handoffs: "0", requests: "0" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 an unawaited canonical call cannot escape authorization lifetime or be overtaken by revocation", async () => {
  const resource = resources(), db = await database();
  try {
    const base = adaptPglite(db);
    let delayPromotion = false, entered!: () => void, release!: () => void;
    const transactionEntered = new Promise<void>((resolve) => { entered = resolve; });
    const transactionHeld = new Promise<void>((resolve) => { release = resolve; });
    const delayed: DatabaseClient = {
      query: base.query,
      transaction: async <T>(operation: Parameters<DatabaseClient["transaction"]>[0]) => {
        if (delayPromotion) { entered(); await transactionHeld; }
        return base.transaction(operation) as Promise<T>;
      },
    };
    const canonical = new CanonicalStore(delayed);
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
    const original = canonical.promoteReadyFrontierJobWithInternalHandoff.bind(canonical);
    let escaped!: ReturnType<typeof original>;
    canonical.promoteReadyFrontierJobWithInternalHandoff = (input) => {
      escaped = original(input);
      return Promise.resolve({ job: materialization.job, replayed: false });
    };
    delayPromotion = true;
    const service = promoter(resource, canonical);
    const pending = service.promote(envelope);
    await transactionEntered;
    const revoked = readyLifecycle(evaluation, standing, readyPolicy,
      { action: "revoke", state: "revoked", revision: 2, recordedAt: "2026-08-30T18:10:00.000Z" }, resource.readyKey);
    assert.throws(() => resource.readyPolicies.recordPolicy(revoked), code("policy_inactive"));
    release();
    const result = await pending; await escaped;
    assert.equal(result.receipt.state, "ready_handoff_pending");
    assert.equal(resource.readyPolicies.latestPolicy(readyPolicy.policyId)?.state, "active");
    assert.equal(resource.readyPolicies.recordPolicy(revoked).replayed, false);
    service.close();
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 trusted time is sampled after policy queues and again at the database write boundary", async () => {
  const resource = resources(), db = await database();
  try {
    const base = adaptPglite(db);
    let delayPromotion = false, transactionEntered!: () => void, releaseTransaction!: () => void;
    const enteredTransaction = new Promise<void>((resolve) => { transactionEntered = resolve; });
    const heldTransaction = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const delayed: DatabaseClient = {
      query: base.query,
      transaction: async <T>(operation: Parameters<DatabaseClient["transaction"]>[0]) => {
        if (delayPromotion) { transactionEntered(); await heldTransaction; }
        return base.transaction(operation) as Promise<T>;
      },
    };
    const canonical = new CanonicalStore(delayed);
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey,
      { expiresAt: "2026-08-30T18:10:00.000Z" });
    resource.readyPolicies.recordPolicy(readyPolicy);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
    let now = envelope.request.promotedAt, clockCalls = 0;
    const service = new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
      resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
      { now: () => { clockCalls += 1; return now; } });

    let guardEntered!: () => void, releaseGuard!: () => void;
    const enteredGuard = new Promise<void>((resolve) => { guardEntered = resolve; });
    const heldGuard = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const blocker = resource.standingPolicies.withCurrentPolicy(standing.policyId, standing.revision,
      standing.policyDigest, async () => { guardEntered(); await heldGuard; });
    await enteredGuard;
    const queued = assert.rejects(service.promote(envelope), code("stale_proposal"));
    await Promise.resolve();
    assert.equal(clockCalls, 0);
    now = "2026-08-30T18:20:00.000Z"; releaseGuard(); await blocker; await queued;

    now = envelope.request.promotedAt; delayPromotion = true;
    const delayedPromotion = assert.rejects(service.promote(envelope), /no longer current|stale at the write boundary/);
    await enteredTransaction;
    assert.equal(clockCalls, 2);
    now = "2026-08-30T18:20:00.000Z"; releaseTransaction(); await delayedPromotion;
    assert.ok(clockCalls >= 3);
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_transition_events)::text transitions,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
      (SELECT count(*) FROM control_idempotency WHERE operation_scope='ready-frontier-promotion')::text requests`);
    assert.deepEqual(counts.rows[0], { ready: "0", reservations: "0", transitions: "0", handoffs: "0", requests: "0" });
    service.close();
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 trusted service time rejects historical and future promotion envelopes", async () => {
  for (const trustedNow of ["2026-08-30T18:20:00.000Z", "2026-08-30T18:03:50.000Z"]) {
    const resource = resources(), db = await database();
    try {
      const canonical = new CanonicalStore(adaptPglite(db));
      const { evaluation, standing, materialization } = await materialize(resource, canonical);
      const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey,
        { expiresAt: "2026-08-30T18:10:00.000Z" });
      resource.readyPolicies.recordPolicy(readyPolicy);
      const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
      const service = promoter(resource, canonical, trustedNow);
      await assert.rejects(() => service.promote(envelope), code("stale_proposal")); service.close();
      const counts = await db.query<Record<string, string>>(`SELECT
        (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
        (SELECT count(*) FROM control_resource_reservations)::text reservations,
        (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs`);
      assert.deepEqual(counts.rows[0], { ready: "0", reservations: "0", handoffs: "0" });
    } finally { await db.close(); close(resource); }
  }
});

test("CR11B-AUTO-030 simultaneous exact requests converge and conflicting request reuse fails", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const first = await materialize(resource, canonical, 0), second = await materialize(resource, canonical, 1);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(first.evaluation, first.standing, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const service = promoter(resource, canonical);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(first.materialization, readyPolicy,
      { requestId: "promotion.request.concurrent-replay" });
    const exact = await Promise.all([service.promote(envelope), service.promote(envelope)]);
    assert.deepEqual(exact.map((item) => item.replayed).sort(), [false, true]);
    const conflict = buildReadyFrontierPromotionEnvelopeFixtureV1(second.materialization, readyPolicy,
      { requestId: envelope.request.requestId });
    await assert.rejects(() => service.promote(conflict), /promotion request replay conflict/); service.close();
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_jobs WHERE state='proposed')::text proposed,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
      (SELECT count(*) FROM control_idempotency WHERE operation_scope='ready-frontier-promotion')::text requests`);
    assert.deepEqual(counts.rows[0], { ready: "1", proposed: "1", reservations: "1", handoffs: "1", requests: "1" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 atomically promotes one exact job, reserves database capacity, and queues only internal handoff", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const service = promoter(resource, canonical);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
    const first = await service.promote(envelope), replay = await service.promote(envelope);
    assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
    assert.deepEqual(parseReadyFrontierPromotionV1(first.receipt, resource.evaluationKey), first.receipt);
    assert.throws(() => parseReadyFrontierPromotionV1(first.receipt, new Uint8Array(32).fill(0x45)), code("digest_mismatch"));
    const tampered = clone(first.receipt); tampered.handoff.routeId = "route.changed";
    assert.throws(() => parseReadyFrontierPromotionV1(tampered, resource.evaluationKey), code("digest_mismatch"));
    assert.deepEqual({ state: first.receipt.readyJob.state, attempts: first.receipt.createsAttempt,
      leases: first.receipt.createsLease, approvals: first.receipt.createsApproval,
      schedules: first.receipt.createsSchedule, dispatch: first.receipt.dispatchState,
      destination: first.receipt.handoff.destination, agent: first.receipt.handoff.permitsAgentMessage,
      github: first.receipt.handoff.permitsGitHubMutation, effects: first.receipt.grantsExternalEffect },
    { state: "ready", attempts: false, leases: false, approvals: false, schedules: false,
      dispatch: "not_requested", destination: "internal_scheduler_jobber_table",
      agent: false, github: false, effects: false });
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations WHERE state='active')::text reservations,
      (SELECT count(*) FROM control_transition_events WHERE entity_kind='job' AND to_state='ready')::text transitions,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
      (SELECT count(*) FROM control_idempotency WHERE operation_scope='ready-frontier-promotion')::text requests,
      (SELECT count(*) FROM control_outbox)::text outbox,
      (SELECT count(*) FROM control_attempts)::text attempts, (SELECT count(*) FROM control_leases)::text leases,
      (SELECT count(*) FROM control_approvals)::text approvals, (SELECT count(*) FROM control_schedules)::text schedules`);
    assert.deepEqual(counts.rows[0], { ready: "1", reservations: "1", transitions: "1", handoffs: "1", requests: "1", outbox: "1",
      attempts: "0", leases: "0", approvals: "0", schedules: "0" });
    const handoff = await db.query<{ state: string; payload: { jobId: string; state: string } }>(
      "SELECT state,payload FROM control_ready_frontier_handoffs WHERE id=$1", [first.receipt.handoff.handoffId]);
    assert.deepEqual(handoff.rows[0], { state: "pending_internal_handoff", payload: { ...first.receipt.handoff } });
    const delivery = new DeliveryStore(adaptPglite(db));
    const deliverable = await delivery.claimOutbox({ tenantId: first.receipt.tenantId,
      claimToken: "frontier-domain-only", limit: 10, maxAttempts: 3, now: first.receipt.promotedAt });
    assert.deepEqual(deliverable.map((item) => item.topic), ["domain.transition"]);
    await assert.rejects(() => canonical.claimReadyJob({ tenantId: first.receipt.tenantId,
      jobId: first.receipt.readyJob.id, expectedJobVersion: 1, nodeId: "node:blocked",
      attemptId: "attempt:blocked", leaseId: "lease:blocked", transitionId: "transition:blocked",
      idempotencyKey: "frontier-claim-blocked", actor: { actorId: "service:test", actorType: "service" },
      acquiredAt: first.receipt.promotedAt, expiresAt: first.receipt.reservation.expiresAt }),
    /separately reviewed internal handoff consumer/);
    await db.query("UPDATE control_resource_reservations SET state='expired' WHERE id=$1",
      [first.receipt.reservation.reservationId]);
    await assert.rejects(() => service.promote(envelope), /replay lacks its database reservation/);
    service.close();
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 suspended, revoked, superseded, stale, narrowed, and parent-drift policy fails before ready mutation", async () => {
  for (const mode of ["ready_suspended", "ready_revoked", "standing_suspended", "superseded", "stale", "narrowed", "parent"] as const) {
    const resource = resources(), db = await database();
    try {
      const canonical = new CanonicalStore(adaptPglite(db));
      const { evaluation, standing, materialization } = await materialize(resource, canonical);
      let readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
      if (mode === "stale" || mode === "narrowed" || mode === "parent") {
        const { policyCeilingDigest: _ceiling, policyDigest: _digest, policyAuthTag: _tag, ...base } = readyPolicy;
        void _ceiling; void _digest; void _tag;
        readyPolicy = buildReadyFrontierReadyPolicyV1({ ...base,
          ...(mode === "stale" ? { maximumMaterializationAgeSeconds: 60 } : {}),
          ...(mode === "narrowed" ? { projectPolicies: readyPolicy.projectPolicies.map((item) =>
            item.projectId === materialization.job.projectId ? { ...item, maximumCostMicrousdPerWork: 0 } : item) } : {}),
          ...(mode === "parent" ? { parentStandingPolicyDigest: "sha256:" + "9".repeat(64) } : {}) }, resource.readyKey);
      }
      resource.readyPolicies.recordPolicy(readyPolicy);
      let envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
      if (mode === "stale") envelope = { ...envelope, request: { ...envelope.request,
        requestedAt: "2026-08-30T18:05:20.000Z", promotedAt: "2026-08-30T18:05:30.000Z",
        reservationExpiresAt: "2026-08-30T18:10:30.000Z" } };
      if (mode === "ready_suspended" || mode === "ready_revoked" || mode === "superseded") {
        const changed = readyLifecycle(evaluation, standing, readyPolicy,
          { action: mode === "ready_suspended" ? "suspend" : mode === "ready_revoked" ? "revoke" : "revise",
            state: mode === "ready_suspended" ? "suspended" : mode === "ready_revoked" ? "revoked" : "active",
            revision: 2, recordedAt: "2026-08-30T18:03:25.000Z" }, resource.readyKey);
        resource.readyPolicies.recordPolicy(changed);
        if (mode !== "superseded") envelope = { ...envelope, request: { ...envelope.request,
          readyPolicyRevision: changed.revision, readyPolicyDigest: changed.policyDigest } };
      }
      if (mode === "standing_suspended") {
        const changedStanding = buildReadyFrontierStandingPolicyFixtureV1(resource.standingKey, {
          revision: 2, previousPolicyDigest: standing.policyDigest, action: "suspend", state: "suspended",
          recordedAt: "2026-08-30T18:03:25.000Z", effectiveAt: "2026-08-30T18:03:25.000Z",
          expiresAt: "2026-08-31T17:00:00.000Z" });
        resource.standingPolicies.recordPolicy(changedStanding);
        envelope = { ...envelope, request: { ...envelope.request, standingPolicyRevision: changedStanding.revision,
          standingPolicyDigest: changedStanding.policyDigest } };
      }
      const service = promoter(resource, canonical, envelope.request.promotedAt);
      await assert.rejects(() => service.promote(envelope), code(mode === "stale" ? "stale_proposal"
        : mode === "narrowed" || mode === "parent" ? "policy_denied" : "policy_inactive")); service.close();
      const counts = await db.query<Record<string, string>>(`SELECT
        (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
        (SELECT count(*) FROM control_resource_reservations)::text reservations,
        (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
        (SELECT count(*) FROM control_outbox)::text outbox`);
      assert.deepEqual(counts.rows[0], { ready: "0", reservations: "0", handoffs: "0", outbox: "0" });
    } finally { await db.close(); close(resource); }
  }
});

test("CR11B-AUTO-030 database reservation capacity serializes competing ready promotions", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const first = await materialize(resource, canonical, 0), second = await materialize(resource, canonical, 1);
    const base = buildReadyFrontierReadyPolicyFixtureV1(first.evaluation, first.standing, resource.readyKey);
    const { policyCeilingDigest: _ceiling, policyDigest: _digest, policyAuthTag: _tag, ...unsigned } = base;
    void _ceiling; void _digest; void _tag;
    const readyPolicy = buildReadyFrontierReadyPolicyV1({ ...unsigned,
      projectPolicies: base.projectPolicies.map((project) => ({ ...project,
        resourceKey: "frontier.ready.shared", resourceCapacityUnits: 1, reservationUnits: 1 })) }, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const service = promoter(resource, canonical);
    const outcomes = await Promise.allSettled([
      service.promote(buildReadyFrontierPromotionEnvelopeFixtureV1(first.materialization, readyPolicy,
        { requestId: "promotion.request.capacity.first" })),
      service.promote(buildReadyFrontierPromotionEnvelopeFixtureV1(second.materialization, readyPolicy,
        { requestId: "promotion.request.capacity.second" })),
    ]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((item) => item.status === "rejected"
      && /resource unavailable/.test(String(item.reason))).length, 1); service.close();
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_jobs WHERE state='proposed')::text proposed,
      (SELECT count(*) FROM control_resource_reservations WHERE state='active')::text reservations,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs`);
    assert.deepEqual(counts.rows[0], { ready: "1", proposed: "1", reservations: "1", handoffs: "1" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 handoff collision rolls back ready transition and reservation", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
    const receipt = buildReadyFrontierPromotionV1(envelope, resource.evaluationKey, resource.standingKey,
      resource.readyKey, evaluation, standing, readyPolicy);
    await db.query("INSERT INTO control_resource_reservation_heads(tenant_id,resource_key,capacity_units) VALUES($1,$2,1)",
      [receipt.tenantId, "frontier.collision.resource"]);
    await db.query(`INSERT INTO control_resource_reservations
      (id,tenant_id,project_id,work_item_id,route_id,resource_key,units,decision_digest,state,acquired_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,'active',$8,$9)`, ["reservation:collision-existing", receipt.tenantId,
      receipt.readyJob.projectId, receipt.readyJob.id, receipt.schedulerDecision.selectedRouteId, "frontier.collision.resource",
      "sha256:" + "a".repeat(64), "2026-08-30T18:03:00.000Z", "2026-08-30T18:30:00.000Z"]);
    await db.query(`INSERT INTO control_ready_frontier_handoffs
      (id,tenant_id,request_id,project_id,job_id,reservation_id,state,payload_digest,available_at,expires_at,payload)
      VALUES($1,$2,$3,$4,$5,$6,'pending_internal_handoff',$7,$8,$9,$10::jsonb)`, [receipt.handoff.handoffId,
      receipt.tenantId, "promotion.request.collision-existing", receipt.readyJob.projectId, receipt.readyJob.id,
      "reservation:collision-existing", "sha256:" + "b".repeat(64), "2026-08-30T18:03:00.000Z",
      "2026-08-30T18:30:00.000Z", JSON.stringify({ collision: true })]);
    const service = promoter(resource, canonical);
    await assert.rejects(() => service.promote(envelope), /duplicate key|unique/i); service.close();
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='proposed')::text proposed,
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_transition_events)::text transitions,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
      (SELECT count(*) FROM control_idempotency WHERE operation_scope='ready-frontier-promotion')::text requests,
      (SELECT count(*) FROM control_outbox)::text outbox`);
    assert.deepEqual(counts.rows[0], { proposed: "1", ready: "0", reservations: "1", transitions: "0",
      handoffs: "1", requests: "0", outbox: "0" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 safe projection reports policy and pending handoff without operator authority", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    const envelope = buildReadyFrontierPromotionEnvelopeFixtureV1(materialization, readyPolicy);
    const receipt = buildReadyFrontierPromotionV1(envelope, resource.evaluationKey, resource.standingKey,
      resource.readyKey, evaluation, standing, readyPolicy);
    const projection = projectReadyFrontierPromotionV1({ tenantId: evaluation.tenantId, readyPolicy, receipts: [receipt],
      observedAt: envelope.request.promotedAt, evaluationIntegrityKey: resource.evaluationKey,
      readyPolicyIntegrityKey: resource.readyKey });
    assert.deepEqual({ policy: projection.readyPolicyState, production: projection.productionReadyPolicyState,
      state: projection.readyPromotionState, jobs: projection.readyJobCount, handoffs: projection.pendingInternalHandoffCount,
      promote: projection.viewCanPromote, schedule: projection.viewCanSchedule,
      lease: projection.viewCanClaimOrLease, dispatch: projection.viewCanDispatchOrExecute },
    { policy: "repository_fixture_active", production: "not_enrolled", state: "ready_handoff_pending",
      jobs: 1, handoffs: 1, promote: false, schedule: false, lease: false, dispatch: false });
    const json = JSON.stringify(projection);
    for (const forbidden of ["ownerActorDigest", "ownerAuthenticationEvidenceDigest", "separateReadyReviewDigest",
      "policyAuthTag", "packetAuthTag", "receiptAuthTag", "objective", "credential", "private locator"]) {
      assert.equal(json.includes(forbidden), false);
    }
    assert.throws(() => projectReadyFrontierPromotionV1({ tenantId: evaluation.tenantId, readyPolicy,
      receipts: [receipt, receipt], observedAt: envelope.request.promotedAt,
      evaluationIntegrityKey: resource.evaluationKey, readyPolicyIntegrityKey: resource.readyKey }),
    /duplicate lineage/);
    assert.throws(() => projectReadyFrontierPromotionV1({ tenantId: evaluation.tenantId, readyPolicy,
      receipts: [receipt], observedAt: receipt.handoff.expiresAt,
      evaluationIntegrityKey: resource.evaluationKey, readyPolicyIntegrityKey: resource.readyKey }),
    /lacks current active reservation and pending handoff evidence/);
    for (const invalid of ["not-an-instant", "2026-08-30T12:04:00-06:00", "2026-02-30T18:04:00.000Z"]) {
      assert.throws(() => projectReadyFrontierPromotionV1({ tenantId: evaluation.tenantId, readyPolicy,
        receipts: [], observedAt: invalid, evaluationIntegrityKey: resource.evaluationKey,
        readyPolicyIntegrityKey: resource.readyKey }));
    }
    for (const observedAt of ["2026-08-30T18:03:19.999Z", readyPolicy.expiresAt, "2026-08-30T19:00:00.001Z"]) {
      const inactive = projectReadyFrontierPromotionV1({ tenantId: evaluation.tenantId, readyPolicy,
        receipts: [], observedAt, evaluationIntegrityKey: resource.evaluationKey,
        readyPolicyIntegrityKey: resource.readyKey });
      assert.equal(inactive.readyPolicyState, "expired");
    }
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-030 exact boundaries reject accessors and Proxies and source has no effect client", async () => {
  const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1();
  const standingKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  const readyKey = readyFrontierRepositoryFixtureReadyPolicyKeyV1();
  try {
    const standing = buildReadyFrontierStandingPolicyFixtureV1(standingKey);
    const policy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, readyKey);
    let touched = 0; const accessor = clone(policy) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "state", { enumerable: true, get: () => { touched += 1; return "active"; } });
    assert.throws(() => parseReadyFrontierReadyPolicyV1(accessor, readyKey), code("invalid_input"));
    assert.equal(touched, 0);
    assert.throws(() => parseReadyFrontierReadyPolicyV1(observedProxy(clone(policy), "transparent").value, readyKey), code("invalid_input"));
    const files = ["src/ready-frontier/v1/promotion.ts", "src/ready-frontier/v1/promotion-service.ts",
      "src/ready-frontier/v1/ready-policy.ts", "src/ready-frontier/v1/ready-policy-store.ts"];
    const source = files.map((file) => readFileSync(resolve(file), "utf8")).join("\n");
    for (const forbidden of [/\bfetch\s*\(/, /node:https/, /octokit/i, /sendMessage\s*\(/,
      /claimReadyJob\s*\(/, /createIssue\s*\(/, /child_process/, /execFile\s*\(/]) assert.doesNotMatch(source, forbidden);
  } finally { standingKey.fill(0); readyKey.fill(0); }
});
