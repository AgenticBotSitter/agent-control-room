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
  ReadyFrontierFixedRepositoryClockV1,
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
  buildReadyFrontierNoRelayRunV1,
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
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const code = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function resources(maximumRecords = 1_000) {
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
    "workspace.control-room", runKey, runCheckpoints, maximumRecords);
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
  const promotionClock = new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:00.000Z");
  const promoter = new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
    resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
    promotionClock);
  const coordinator = new ReadyFrontierNoRelayCoordinatorV1(materializer, promoter, resource.runs, fake,
    new ReadyFrontierFixedRepositoryClockV1(deliveryNow), resource.runKey);
  return { evaluation, standing, ready, materializer, promoter, coordinator, fake, canonical, promotionClock,
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

test("CR11B-AUTO-040 reserves terminal ledger capacity before any second canonical mutation", async () => {
  const resource = resources(3), db = await database();
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db)));
    const first = await value.coordinator.run(value.request);
    assert.equal(first.run.state, "acknowledged_repository_simulation");
    const second = buildReadyFrontierNoRelayRequestFixtureV1(value.evaluation, value.standing, value.ready, 1);
    await assert.rejects(() => value.coordinator.run(second), code("capacity_exceeded"));
    assert.equal(resource.runs.listCurrent().length, 1); assert.equal(value.fake.deliveryCount(), 1);
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs)::text jobs,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs`);
    assert.deepEqual(counts.rows[0], { jobs: "1", handoffs: "1" }); finish(value);
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
    const interrupting = new ReadyFrontierInMemoryFakeDeliveryV1("interrupt_after_marker", "2026-08-30T18:04:06.000Z"),
      value = setup(resource, new CanonicalStore(adaptPglite(db)), interrupting);
    await assert.rejects(() => value.coordinator.run(value.request));
    assert.equal(interrupting.deliveryCount(), 1); value.coordinator.close();
    const restartFake = new ReadyFrontierInMemoryFakeDeliveryV1("acknowledge", "2026-08-30T18:04:06.000Z"),
      restartedCoordinator = new ReadyFrontierNoRelayCoordinatorV1(value.materializer, value.promoter,
        resource.runs, restartFake, new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:05.000Z"), resource.runKey);
    const restarted = await restartedCoordinator.run(value.request);
    assert.equal(restarted.run.state, "terminal_ambiguous"); assert.equal(restartFake.deliveryCount(), 0);
    restartedCoordinator.close(); value.materializer.close(); value.promoter.close();
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

test("CR11B-AUTO-040 exact durable restart succeeds and direct store mutation is capability denied", async () => {
  const resource = resources(), db = await database(), path = join(resource.directory, "runs.sqlite");
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db))), result = await value.coordinator.run(value.request);
    assert.throws(() => resource.runs.complete(undefined, result.run.runId, result.run.requestDigest, {
      state: "acknowledged_repository_simulation", updatedAt: "2026-08-30T18:04:07.000Z",
      acknowledgementDigest: result.run.acknowledgementDigest ?? undefined,
    }), code("policy_denied"));
    assert.throws(() => resource.runs.begin(undefined, { runId: result.run.runId, tenantId: result.run.tenantId,
      workspaceId: result.run.workspaceId, projectId: result.run.projectId, requestDigest: result.run.requestDigest,
      materializationReceiptDigest: result.run.materializationReceiptDigest,
      promotionReceiptDigest: result.run.promotionReceiptDigest, jobId: result.run.jobId, routeId: result.run.routeId,
      handoffId: result.run.handoffId, handoffPacketDigest: result.run.handoffPacketDigest,
      deliveryId: "frontier.fake-delivery:changed", deliveryDeadline: result.run.deliveryDeadline,
      startedAt: result.run.startedAt }, "delivery_started"), code("policy_denied"));
    const { schema: _schema, runDigest: _digest, runAuthTag: _tag, ...unsigned } = result.run;
    void _schema; void _digest; void _tag;
    assert.throws(() => buildReadyFrontierNoRelayRunV1({ ...unsigned, state: "expired_before_delivery",
      safeReason: "delivery_window_expired", updatedAt: result.run.startedAt, acknowledgedAt: null,
      acknowledgementDigest: null }, resource.runKey), code("replay_drift"));
    assert.throws(() => buildReadyFrontierNoRelayRunV1({ ...unsigned, state: "delivery_started",
      safeReason: "delivery_outcome_ambiguous", startedAt: result.run.deliveryDeadline,
      updatedAt: result.run.deliveryDeadline, acknowledgedAt: null, acknowledgementDigest: null }, resource.runKey),
    code("replay_drift"));
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
      assert.equal(Object.isFrozen(result.run), true);
      assert.throws(() => Object.defineProperty(result.run, "updatedAt", { value: "2026-08-30T18:03:00.000Z" }));
      assert.deepEqual(packet.requiredProductionGateCodes, [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
      assert.equal(packet.canActivateItself, false); assert.equal(packet.productionOwnerApprovalPresent, false);
      assert.deepEqual(parseReadyFrontierActivationPacketV1(packet, packetKey), packet);
      const tampered = clone(packet); tampered.requiredProductionGateCodes.pop();
      assert.throws(() => parseReadyFrontierActivationPacketV1(tampered, packetKey), code("digest_mismatch"));
      assert.throws(() => buildReadyFrontierActivationPacketV1({ packetId: "frontier.activation-packet.0002",
        run: clone(result.run), createdAt: "2026-08-30T18:05:00.000Z" }, resource.runKey, packetKey),
      code("policy_denied"));
      assert.throws(() => buildReadyFrontierActivationPacketV1({ packetId: "frontier.activation-packet.0003",
        run: result.run, createdAt: "2026-08-30T18:03:00.000Z" }, resource.runKey, packetKey),
      code("policy_denied"));
      let accesses = 0; const hostile = { packetId: "frontier.activation-packet.0004", run: result.run } as
        { packetId: string; run: typeof result.run; createdAt: string };
      Object.defineProperty(hostile, "createdAt", { enumerable: true,
        get: () => { accesses += 1; return "2026-08-30T18:05:00.000Z"; } });
      assert.throws(() => buildReadyFrontierActivationPacketV1(hostile, resource.runKey, packetKey), code("invalid_input"));
      assert.equal(accesses, 0);
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
      resource.runs, subclassed, new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:05.000Z"), resource.runKey),
    code("policy_denied"));
    const proxy = observedProxy(resource.runKey, "throwing");
    assert.throws(() => new ReadyFrontierNoRelayCoordinatorV1(value.materializer, value.promoter,
      resource.runs, value.fake, new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:05.000Z"), proxy.value),
    code("policy_denied"));
    let callbacks = 0; const duckMaterializer = { materialize: async () => { callbacks += 1; return {}; } };
    assert.throws(() => new ReadyFrontierNoRelayCoordinatorV1(duckMaterializer as never, value.promoter,
      resource.runs, value.fake, new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:05.000Z"), resource.runKey),
    code("policy_denied"));
    const fakeProxy = observedProxy(value.fake, "throwing");
    assert.throws(() => new ReadyFrontierNoRelayCoordinatorV1(value.materializer, value.promoter,
      resource.runs, fakeProxy.value as never,
      new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:05.000Z"), resource.runKey), code("policy_denied"));
    const materializerProxy = observedProxy(value.materializer, "throwing");
    assert.throws(() => new ReadyFrontierNoRelayCoordinatorV1(materializerProxy.value as never, value.promoter,
      resource.runs, value.fake,
      new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:05.000Z"), resource.runKey), code("policy_denied"));
    assert.deepEqual(Object.getOwnPropertyNames(value.coordinator), []);
    assert.equal(Reflect.set(value.coordinator as object, "fakeDelivery", duckMaterializer), false);
    assert.throws(() => Object.defineProperty(value.coordinator, "fakeDelivery", { value: duckMaterializer }));
    assert.throws(() => Object.defineProperty(value.fake, "deliver", { value: () => { callbacks += 1; } }));
    assert.throws(() => Object.defineProperty(ReadyFrontierInMemoryFakeDeliveryV1.prototype, "deliver",
      { value: () => { callbacks += 1; } }));
    assert.throws(() => Object.defineProperty(resource.runs, "complete", { value: () => { callbacks += 1; } }));
    assert.equal(callbacks, 0); assert.equal(proxy.trapCount(), 0); assert.equal(fakeProxy.trapCount(), 0);
    assert.equal(materializerProxy.trapCount(), 0);
    assert.equal(value.fake.deliveryCount(), 0); finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 freezes every nested collaborator before a hostile alias can enter the run", async () => {
  const resource = resources(), db = await database();
  try {
    const value = setup(resource, new CanonicalStore(adaptPglite(db)));
    let callbacks = 0;
    const callback = () => { callbacks += 1; return undefined; };
    const targets: Array<{ target: object; method: string }> = [
      { target: resource.evaluations, method: "evaluation" },
      { target: resource.standingPolicies, method: "withCurrentPolicy" },
      { target: resource.readyPolicies, method: "withCurrentPolicy" },
      { target: value.canonical, method: "createReadyFrontierProposedWorkBundleWithActionInbox" },
      { target: value.canonical, method: "promoteReadyFrontierJobWithInternalHandoff" },
      { target: value.promotionClock, method: "now" },
    ];
    for (const { target, method } of targets) {
      const before = Reflect.get(target, method);
      assert.equal(Object.isFrozen(target), true);
      assert.equal(Object.isFrozen(Object.getPrototypeOf(target) as object), true);
      assert.equal(Reflect.set(target, method, callback), false);
      assert.equal(Reflect.deleteProperty(target, method), true);
      assert.equal(Reflect.get(target, method), before);
      assert.throws(() => Object.defineProperty(target, method, { configurable: true, value: callback }));
      assert.throws(() => Object.defineProperty(Object.getPrototypeOf(target) as object, method,
        { configurable: true, value: callback }));
    }
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_jobs)::text jobs,
      (SELECT count(*) FROM control_ready_frontier_handoffs)::text handoffs`);
    assert.deepEqual(counts.rows[0], { jobs: "0", handoffs: "0" });
    assert.equal(callbacks, 0); assert.equal(value.fake.deliveryCount(), 0); finish(value);
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-040 nested collaborator Proxies and subclasses are rejected without executing traps", async () => {
  const resource = resources(), db = await database();
  const extra: Array<{ closeDatabase(): void }> = [];
  try {
    const canonical = new CanonicalStore(adaptPglite(db));
    const probes = [observedProxy(resource.evaluations, "throwing"), observedProxy(resource.standingPolicies, "throwing"),
      observedProxy(resource.readyPolicies, "throwing"), observedProxy(canonical, "throwing"),
      observedProxy(new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:00.000Z"), "throwing")];
    assert.throws(() => new ReadyFrontierMaterializationServiceV1(probes[0].value as never, resource.standingPolicies,
      canonical, resource.evaluationKey, resource.standingKey), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierMaterializationServiceV1(resource.evaluations, probes[1].value as never,
      canonical, resource.evaluationKey, resource.standingKey), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.standingPolicies,
      probes[3].value as never, resource.evaluationKey, resource.standingKey), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
      probes[2].value as never, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
      new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:00.000Z")), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
      resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
      probes[4].value as never), code("integrity_failed"));
    for (const probe of probes) assert.equal(probe.trapCount(), 0);

    class SimulationSubclass extends ReadyFrontierSimulationStoreV1 {}
    class StandingSubclass extends ReadyFrontierStandingPolicyStoreV1 {}
    class ReadySubclass extends ReadyFrontierReadyPolicyStoreV1 {}
    class CanonicalSubclass extends CanonicalStore {}
    class ClockSubclass extends ReadyFrontierFixedRepositoryClockV1 {}
    const simulation = new SimulationSubclass(join(resource.directory, "sub-evaluations.sqlite"), "tenant.owner",
      resource.evaluationKey, new InMemoryRollbackCheckpointStoreV1({ testOnly: true })); extra.push(simulation);
    const standing = new StandingSubclass(join(resource.directory, "sub-standing.sqlite"), "tenant.owner",
      "workspace.control-room", resource.standingKey, new InMemoryRollbackCheckpointStoreV1({ testOnly: true })); extra.push(standing);
    const ready = new ReadySubclass(join(resource.directory, "sub-ready.sqlite"), "tenant.owner",
      "workspace.control-room", resource.readyKey, new InMemoryRollbackCheckpointStoreV1({ testOnly: true })); extra.push(ready);
    const subclassedCanonical = new CanonicalSubclass(adaptPglite(db));
    assert.throws(() => new ReadyFrontierMaterializationServiceV1(simulation, resource.standingPolicies,
      canonical, resource.evaluationKey, resource.standingKey), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierMaterializationServiceV1(resource.evaluations, standing,
      canonical, resource.evaluationKey, resource.standingKey), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.standingPolicies,
      subclassedCanonical, resource.evaluationKey, resource.standingKey), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
      ready, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
      new ReadyFrontierFixedRepositoryClockV1("2026-08-30T18:04:00.000Z")), code("integrity_failed"));
    assert.throws(() => new ReadyFrontierPromotionServiceV1(resource.evaluations, resource.standingPolicies,
      resource.readyPolicies, canonical, resource.evaluationKey, resource.standingKey, resource.readyKey,
      new ClockSubclass("2026-08-30T18:04:00.000Z")), code("integrity_failed"));
  } finally {
    for (const store of extra) try { store.closeDatabase(); } catch { /* closed */ }
    await db.close(); close(resource);
  }
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
