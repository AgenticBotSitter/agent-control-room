import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import {
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1,
  ReadyFrontierContractErrorV1,
  ReadyFrontierInMemoryFakeDeliveryV1,
  ReadyFrontierMaterializationServiceV1,
  ReadyFrontierNoRelayCoordinatorV1,
  ReadyFrontierNoRelayStoreV1,
  ReadyFrontierPromotionServiceV1,
  ReadyFrontierReadyPolicyStoreV1,
  ReadyFrontierSimulationStoreV1,
  ReadyFrontierStandingPolicyStoreV1,
  buildReadyFrontierActivationPacketV1,
  buildReadyFrontierNoRelayProjectionFixtureV1,
  buildReadyFrontierNoRelayRequestFixtureV1,
  buildReadyFrontierReadyPolicyFixtureV1,
  buildReadyFrontierRepositoryFixtureEvaluationV1,
  buildReadyFrontierStandingPolicyFixtureV1,
  parseReadyFrontierActivationPacketV1,
  projectReadyFrontierNoRelayAttentionV1,
  readyFrontierRepositoryFixtureActivationPacketKeyV1,
  readyFrontierRepositoryFixtureEvaluationKeyV1,
  readyFrontierRepositoryFixtureNoRelayKeyV1,
  readyFrontierRepositoryFixtureReadyPolicyKeyV1,
  readyFrontierRepositoryFixtureStandingPolicyKeyV1,
} from "../src/ready-frontier/v1/index.ts";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const code = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function resources() {
  const directory = mkdtempSync(join(tmpdir(), "cr11b-auto-040-")); chmodSync(directory, 0o700);
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1();
  const standingKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  const readyKey = readyFrontierRepositoryFixtureReadyPolicyKeyV1();
  const runKey = readyFrontierRepositoryFixtureNoRelayKeyV1();
  const evaluations = new ReadyFrontierSimulationStoreV1(join(directory, "evaluations.sqlite"), "tenant.owner",
    evaluationKey, new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  const standingPolicies = new ReadyFrontierStandingPolicyStoreV1(join(directory, "standing.sqlite"),
    "tenant.owner", "workspace.control-room", standingKey, new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  const readyPolicies = new ReadyFrontierReadyPolicyStoreV1(join(directory, "ready.sqlite"),
    "tenant.owner", "workspace.control-room", readyKey, new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  const runCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const runs = new ReadyFrontierNoRelayStoreV1(join(directory, "runs.sqlite"), "tenant.owner",
    "workspace.control-room", runKey, runCheckpoints);
  return { directory, evaluationKey, standingKey, readyKey, runKey, evaluations, standingPolicies,
    readyPolicies, runCheckpoints, runs };
}
function close(resource: ReturnType<typeof resources>) {
  try { resource.evaluations.closeDatabase(); } catch { /* closed */ }
  try { resource.standingPolicies.closeDatabase(); } catch { /* closed */ }
  try { resource.readyPolicies.closeDatabase(); } catch { /* closed */ }
  try { resource.runs.closeDatabase(); } catch { /* closed */ }
  resource.evaluationKey.fill(0); resource.standingKey.fill(0); resource.readyKey.fill(0); resource.runKey.fill(0);
  rmSync(resource.directory, { recursive: true, force: true });
}
async function database() {
  const db = new PGlite();
  for (const file of readdirSync(resolve("db/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(resolve("db/migrations", file), "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", ["tenant.owner", "Owner"]); return db;
}
function setup(resource: ReturnType<typeof resources>, canonical: CanonicalStore,
  fake = new ReadyFrontierInMemoryFakeDeliveryV1("acknowledge", "2026-08-30T18:04:06.000Z"),
  deliveryNow = "2026-08-30T18:04:05.000Z") {
  const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(); resource.evaluations.recordEvaluation(evaluation);
  const standing = buildReadyFrontierStandingPolicyFixtureV1(resource.standingKey); resource.standingPolicies.recordPolicy(standing);
  const ready = buildReadyFrontierReadyPolicyFixtureV1(evaluation, standing, resource.readyKey); resource.readyPolicies.recordPolicy(ready);
  const materializer = new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.standingPolicies,
    canonical, resource.evaluationKey, resource.standingKey);
  const promoter = new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
    resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
    { now: () => "2026-08-30T18:04:00.000Z" });
  const coordinator = new ReadyFrontierNoRelayCoordinatorV1(materializer, promoter, resource.runs, fake,
    { now: () => deliveryNow }, resource.runKey);
  return { evaluation, standing, ready, materializer, promoter, coordinator, fake,
    request: buildReadyFrontierNoRelayRequestFixtureV1(evaluation, standing, ready) };
}
function finish(value: ReturnType<typeof setup>) { value.coordinator.close(); value.materializer.close(); value.promoter.close(); }

test("CR11B-AUTO-040 runs materialization, ready promotion, fake handoff, and acknowledgement once without relay", async () => {
  const resource = resources(), db = await database();
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db)));
    const first = await value.coordinator.run(value.request), replay = await value.coordinator.run(value.request);
    assert.equal(first.run.state, "acknowledged_repository_simulation"); assert.equal(first.runReplayed, false);
    assert.equal(first.materializationReplayed, false); assert.equal(first.promotionReplayed, false);
    assert.equal(replay.run.runDigest, first.run.runDigest); assert.equal(replay.runReplayed, true);
    assert.equal(value.fake.deliveryCount(), 1);
    assert.deepEqual(value.coordinator.projection("tenant.owner"), {
      schema: "control-room-ready-frontier-no-relay-projection/v1", tenantId: "tenant.owner",
      simulationState: "acknowledged", runs: [{ runId: first.run.runId,
        projectId: first.run.projectId, jobId: first.run.jobId, routeId: first.run.routeId,
        state: "acknowledged_repository_simulation", safeReason: "fake_handoff_acknowledged",
        deliveryAttemptCount: 1, updatedAt: first.run.updatedAt }], attention: [],
      activationState: "blocked_pending_production_proof", repositorySimulationOnly: true,
      canActivateProduction: false, canDeliver: false, canClaimOrLease: false, canDispatchOrExecute: false,
      projectionDigest: value.coordinator.projection("tenant.owner").projectionDigest });
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs WHERE state='ready')::text ready,
      (SELECT count(*) FROM control_resource_reservations)::text reservations,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs,
      (SELECT count(*) FROM control_attempts)::text attempts,
      (SELECT count(*) FROM control_leases)::text leases`);
    assert.deepEqual(counts.rows[0], { ready: "1", reservations: "1", handoffs: "1", attempts: "0", leases: "0" });
    finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 thrown and malformed fake delivery become terminal ambiguity without retry", async () => {
  for (const mode of ["throw_after_marker", "malformed"] as const) {
    const resource = resources(), db = await database();
    try {
      const fake = new ReadyFrontierInMemoryFakeDeliveryV1(mode, "2026-08-30T18:04:06.000Z"),
        value = setup(resource, new CanonicalStore(adaptPglite(db)), fake);
      const first = await value.coordinator.run(value.request), replay = await value.coordinator.run(value.request);
      assert.equal(first.run.state, "terminal_ambiguous"); assert.equal(replay.run.state, "terminal_ambiguous");
      assert.equal(replay.runReplayed, true); assert.equal(fake.deliveryCount(), 1);
      const projection = value.coordinator.projection("tenant.owner");
      assert.equal(projection.attention[0]?.safeReason, "delivery_outcome_ambiguous");
      const inbox = projectReadyFrontierNoRelayAttentionV1(projection);
      assert.equal(inbox[0]?.kind, "ambiguity"); assert.equal(inbox[0]?.workItemId, first.run.jobId);
      assert.equal(inbox[0]?.legalResponses[0]?.available, false);
      assert.equal(inbox[0]?.legalResponses[0]?.unavailableReasonCode, "repository_simulation_only");
      finish(value);
    } finally { await db.close(); close(resource); }
  }
});

test("CR11B-AUTO-040 expiry after promotion records no fake delivery and remains reviewable", async () => {
  const resource = resources(), db = await database();
  try {
    const fake = new ReadyFrontierInMemoryFakeDeliveryV1("acknowledge", "2026-08-30T18:08:00.000Z"),
      value = setup(resource, new CanonicalStore(adaptPglite(db)), fake, "2026-08-30T18:08:00.000Z");
    const result = await value.coordinator.run(value.request);
    assert.equal(result.run.state, "expired_before_delivery"); assert.equal(fake.deliveryCount(), 0);
    const projection = value.coordinator.projection("tenant.owner");
    assert.equal(projection.activationState, "blocked_no_simulation_evidence");
    assert.equal(projectReadyFrontierNoRelayAttentionV1(projection)[0]?.kind, "authority_expiry");
    finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 acknowledgements outside the started delivery window become terminal ambiguity", async () => {
  for (const acknowledgedAt of ["2026-08-30T18:04:04.999Z", "2026-08-30T18:08:00.001Z"]) {
    const resource = resources(), db = await database();
    try {
      const fake = new ReadyFrontierInMemoryFakeDeliveryV1("acknowledge", acknowledgedAt),
        value = setup(resource, new CanonicalStore(adaptPglite(db)), fake);
      const first = await value.coordinator.run(value.request), replay = await value.coordinator.run(value.request);
      assert.equal(first.run.state, "terminal_ambiguous"); assert.equal(replay.run.runDigest, first.run.runDigest);
      assert.equal(replay.runReplayed, true); assert.equal(fake.deliveryCount(), 1); finish(value);
    } finally { await db.close(); close(resource); }
  }
});

test("CR11B-AUTO-040 invalid preflight delivery time fails before canonical mutation or fake contact", async () => {
  const resource = resources(), db = await database();
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db)), undefined,
      "2026-08-30T18:03:59.999Z");
    await assert.rejects(() => value.coordinator.run(value.request), code("replay_drift"));
    assert.equal(value.fake.deliveryCount(), 0); assert.equal(resource.runs.listCurrent().length, 0);
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs)::text jobs,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs`);
    assert.deepEqual(counts.rows[0], { jobs: "0", handoffs: "0" }); finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 restart turns an unsettled marker into terminal ambiguity without adapter contact", async () => {
  const resource = resources(), db = await database();
  try {
    const canonical = new CanonicalStore(adaptPglite(db)), value = setup(resource, canonical);
    const requestDigest = sha256Digest(value.request);
    resource.runs.begin({ runId: value.request.runId, tenantId: value.request.tenantId,
      workspaceId: value.request.workspaceId, projectId: "project.blooms.content-ops", requestDigest,
      materializationReceiptDigest: sha256Digest({ fixture: "materialization" }),
      promotionReceiptDigest: sha256Digest({ fixture: "promotion" }), jobId: "job.frontier.fixture",
      routeId: "route.marvin.macos", handoffId: "handoff.frontier.fixture",
      handoffPacketDigest: sha256Digest({ fixture: "handoff" }), deliveryId: "frontier.fake-delivery:fixture",
      deliveryDeadline: value.request.deliveryDeadline, startedAt: value.request.observedAt }, "delivery_started");
    const restarted = await value.coordinator.run(value.request);
    assert.equal(restarted.run.state, "terminal_ambiguous"); assert.equal(value.fake.deliveryCount(), 0);
    finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 durable ledger detects request drift, row tampering, and complete database rollback", async () => {
  const resource = resources(), db = await database(), path = join(resource.directory, "runs.sqlite"),
    backup = join(resource.directory, "runs-backup.sqlite");
  try {
    copyFileSync(path, backup); chmodSync(backup, 0o600);
    const value = setup(resource, new CanonicalStore(adaptPglite(db))), result = await value.coordinator.run(value.request);
    const changed = clone(value.request); changed.deliveryDeadline = "2026-08-30T18:07:59.000Z";
    await assert.rejects(() => value.coordinator.run(changed), code("replay_drift"));
    finish(value); resource.runs.closeDatabase();
    const raw = new DatabaseSync(path); raw.prepare("UPDATE frontier_no_relay_run SET payload=? WHERE run_id=? AND version=2")
      .run("{}", result.run.runId); raw.close();
    assert.throws(() => new ReadyFrontierNoRelayStoreV1(path, "tenant.owner", "workspace.control-room",
      resource.runKey, resource.runCheckpoints), code("integrity_failed"));
    copyFileSync(backup, path); chmodSync(path, 0o600);
    assert.throws(() => new ReadyFrontierNoRelayStoreV1(path, "tenant.owner", "workspace.control-room",
      resource.runKey, resource.runCheckpoints), code("integrity_failed"));
  } finally {
    await db.close();
    try { resource.evaluations.closeDatabase(); } catch { /* closed */ }
    try { resource.standingPolicies.closeDatabase(); } catch { /* closed */ }
    try { resource.readyPolicies.closeDatabase(); } catch { /* closed */ }
    resource.evaluationKey.fill(0); resource.standingKey.fill(0); resource.readyKey.fill(0); resource.runKey.fill(0);
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

test("CR11B-AUTO-040 exact durable restart succeeds and terminal replay rejects changed completion facts", async () => {
  const resource = resources(), db = await database(), path = join(resource.directory, "runs.sqlite");
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db))), result = await value.coordinator.run(value.request);
    assert.throws(() => resource.runs.complete(result.run.runId, result.run.requestDigest, {
      state: "acknowledged_repository_simulation", updatedAt: "2026-08-30T18:04:07.000Z",
      acknowledgementDigest: result.run.acknowledgementDigest ?? undefined,
    }), code("replay_drift"));
    assert.throws(() => resource.runs.begin({ runId: result.run.runId, tenantId: result.run.tenantId,
      workspaceId: result.run.workspaceId, projectId: result.run.projectId, requestDigest: result.run.requestDigest,
      materializationReceiptDigest: result.run.materializationReceiptDigest,
      promotionReceiptDigest: result.run.promotionReceiptDigest, jobId: result.run.jobId, routeId: result.run.routeId,
      handoffId: result.run.handoffId, handoffPacketDigest: result.run.handoffPacketDigest,
      deliveryId: "frontier.fake-delivery:changed", deliveryDeadline: result.run.deliveryDeadline,
      startedAt: result.run.startedAt }, "delivery_started"), code("replay_drift"));
    finish(value); resource.runs.closeDatabase();
    const reopened = new ReadyFrontierNoRelayStoreV1(path, "tenant.owner", "workspace.control-room",
      resource.runKey, resource.runCheckpoints);
    try { assert.deepEqual(reopened.current(result.run.runId), result.run); }
    finally { reopened.closeDatabase(); }
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 activation packet is authenticated, complete, blocked, and cannot activate itself", async () => {
  const resource = resources(), db = await database();
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db))), result = await value.coordinator.run(value.request);
    const packetKey = readyFrontierRepositoryFixtureActivationPacketKeyV1();
    try {
      const packet = buildReadyFrontierActivationPacketV1({ packetId: "frontier.activation-packet.0001",
        run: result.run, createdAt: "2026-08-30T18:05:00.000Z" }, resource.runKey, packetKey);
      assert.deepEqual(packet.requiredProductionGateCodes, [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
      assert.equal(packet.canActivateItself, false); assert.equal(packet.productionOwnerApprovalPresent, false);
      assert.deepEqual(parseReadyFrontierActivationPacketV1(packet, packetKey), packet);
      const tampered = clone(packet); tampered.requiredProductionGateCodes.pop();
      assert.throws(() => parseReadyFrontierActivationPacketV1(tampered, packetKey), code("digest_mismatch"));
    } finally { packetKey.fill(0); }
    finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 exact boundaries reject accessors and Proxies without executing traps", async () => {
  const resource = resources(), db = await database();
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db)));
    let accessed = 0; const hostile = clone(value.request) as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "runId", { enumerable: true, get: () => { accessed += 1; return value.request.runId; } });
    await assert.rejects(() => value.coordinator.run(hostile), code("invalid_input")); assert.equal(accessed, 0);
    const proxy = observedProxy(clone(value.request), "throwing");
    await assert.rejects(() => value.coordinator.run(proxy.value), code("invalid_input")); assert.equal(proxy.trapCount(), 0);
    assert.equal(value.fake.deliveryCount(), 0); finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 coordinator accepts only the registered exact fake and an exact host key", async () => {
  const resource = resources(), db = await database();
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db)));
    class SubclassedFake extends ReadyFrontierInMemoryFakeDeliveryV1 {}
    const subclassed = new SubclassedFake("acknowledge", "2026-08-30T18:04:06.000Z");
    assert.throws(() => new ReadyFrontierNoRelayCoordinatorV1(value.materializer, value.promoter,
      resource.runs, subclassed, { now: () => "2026-08-30T18:04:05.000Z" }, resource.runKey),
    code("policy_denied"));
    const proxy = observedProxy(resource.runKey, "throwing");
    assert.throws(() => new ReadyFrontierNoRelayCoordinatorV1(value.materializer, value.promoter,
      resource.runs, value.fake, { now: () => "2026-08-30T18:04:05.000Z" }, proxy.value),
    code("policy_denied"));
    assert.equal(proxy.trapCount(), 0); assert.equal(value.fake.deliveryCount(), 0); finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 honest server projection claims no run and exposes no activation authority", () => {
  assert.deepEqual(buildReadyFrontierNoRelayProjectionFixtureV1(), {
    schema: "control-room-ready-frontier-no-relay-projection/v1", tenantId: "tenant.owner",
    simulationState: "not_run", runs: [], attention: [], activationState: "blocked_no_simulation_evidence",
    repositorySimulationOnly: true, canActivateProduction: false, canDeliver: false, canClaimOrLease: false,
    canDispatchOrExecute: false, projectionDigest: buildReadyFrontierNoRelayProjectionFixtureV1().projectionDigest,
  });
});

test("CR11B-AUTO-040 coordinator and fake adapter contain no real effect client", () => {
  const source = ["no-relay-coordinator.ts", "no-relay-store.ts", "no-relay.ts"].map((file) =>
    readFileSync(resolve("src/ready-frontier/v1", file), "utf8")).join("\n");
  for (const forbidden of ["fetch(", "https.request", "child_process", "execFile", "spawn(", "Octokit",
    "github.com", "sendMessage", "providerClient", "control_attempts", "control_leases"]) assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
