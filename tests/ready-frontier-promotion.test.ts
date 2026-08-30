import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite } from "../src/persistence/database.ts";
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
  persistReadyFrontierPromotionV1,
  projectReadyFrontierPromotionV1,
  readyFrontierRepositoryFixtureEvaluationKeyV1,
  readyFrontierRepositoryFixtureReadyPolicyKeyV1,
  readyFrontierRepositoryFixtureStandingPolicyKeyV1,
  type ReadyFrontierReadyPolicyV1,
  type ReadyFrontierStandingPolicyV1,
} from "../src/ready-frontier/v1/index.ts";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/index.ts";
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
      transport: "canonical_outbox", productionOwner: false, productionReview: false, approval: false,
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

test("CR11B-AUTO-030 atomically promotes one exact job, reserves database capacity, and queues only internal handoff", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const { evaluation, standing, materialization } = await materialize(resource, canonical);
    const readyPolicy = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey);
    resource.readyPolicies.recordPolicy(readyPolicy);
    const service = new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
      resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey);
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
      dispatch: "not_requested", destination: "internal_scheduler_jobber_outbox",
      agent: false, github: false, effects: false });
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations WHERE state='active')::text reservations,
      (SELECT count(*) FROM control_transition_events WHERE entity_kind='job' AND to_state='ready')::text transitions,
      (SELECT count(*) FROM control_outbox)::text outbox,
      (SELECT count(*) FROM control_attempts)::text attempts, (SELECT count(*) FROM control_leases)::text leases,
      (SELECT count(*) FROM control_approvals)::text approvals, (SELECT count(*) FROM control_schedules)::text schedules`);
    assert.deepEqual(counts.rows[0], { ready: "1", reservations: "1", transitions: "1", outbox: "2",
      attempts: "0", leases: "0", approvals: "0", schedules: "0" });
    const handoff = await db.query<{ topic: string; status: string; payload: { jobId: string; state: string } }>(
      "SELECT topic,status,payload FROM control_outbox WHERE topic='ready-frontier.scheduler-jobber-handoff'");
    assert.deepEqual(handoff.rows[0], { topic: "ready-frontier.scheduler-jobber-handoff", status: "pending",
      payload: { ...first.receipt.handoff } });
    await db.query("DELETE FROM control_resource_reservations WHERE id=$1", [first.receipt.reservation.reservationId]);
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
      const service = new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
        resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey);
      await assert.rejects(() => service.promote(envelope), code(mode === "stale" ? "stale_proposal"
        : mode === "narrowed" || mode === "parent" ? "policy_denied" : "policy_inactive")); service.close();
      const counts = await db.query<Record<string, string>>(`SELECT
        (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
        (SELECT count(*) FROM control_resource_reservations)::text reservations,
        (SELECT count(*) FROM control_outbox)::text outbox`);
      assert.deepEqual(counts.rows[0], { ready: "0", reservations: "0", outbox: "0" });
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
    const service = new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
      resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey);
    await service.promote(buildReadyFrontierPromotionEnvelopeFixtureV1(first.materialization, readyPolicy));
    await assert.rejects(() => service.promote(buildReadyFrontierPromotionEnvelopeFixtureV1(second.materialization, readyPolicy)),
      /resource unavailable/); service.close();
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_jobs WHERE state='proposed')::text proposed,
      (SELECT count(*) FROM control_resource_reservations WHERE state='active')::text reservations,
      (SELECT count(*) FROM control_outbox WHERE topic='ready-frontier.scheduler-jobber-handoff')::text handoffs`);
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
    await db.query(`INSERT INTO control_outbox(id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload)
      VALUES($1,$2,'collision','job',$3,$4,'pending',$5,$6::jsonb)`, [receipt.handoff.handoffId,
      receipt.tenantId, receipt.readyJob.id, "collision-key", receipt.promotedAt, JSON.stringify({ collision: true })]);
    await assert.rejects(() => persistReadyFrontierPromotionV1({ canonicalStore: canonical, receipt, readyPolicy,
      evaluationKey: resource.evaluationKey, readyPolicyKey: resource.readyKey }), /duplicate key|unique/i);
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='proposed')::text proposed,
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_transition_events)::text transitions,
      (SELECT count(*) FROM control_outbox)::text outbox`);
    assert.deepEqual(counts.rows[0], { proposed: "1", ready: "0", reservations: "0", transitions: "0", outbox: "1" });
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
