import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  OPERATIONS_DEPLOYMENT_GATE_IDS_V1,
  OPERATIONS_POSTGRES_READINESS_REPOSITORY_MET_GATES_V1,
  OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1,
  OperationsContractErrorV1,
  buildCurrentOperationsDeploymentDisabledV1,
  buildOperationsPostgresReadinessDispositionV1,
  buildOperationsPostgresReadinessPacketV1,
  buildOperationsProductionDatabaseTargetV1,
  parseOperationsPostgresReadinessDispositionV1,
  parseOperationsPostgresReadinessPacketV1,
  parseOperationsPostgresReadinessProjectionV1,
  projectOperationsPostgresReadinessV1,
} from "../src/operations/v1";
import {
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1,
  readyFrontierProductionEvidenceClassesV1,
} from "../src/ready-frontier/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

function fixture() {
  const databaseTarget = buildOperationsProductionDatabaseTargetV1({
    decisionId: "decision:operations:production-database:hostinger:1",
    decidedAt: "2026-08-31T18:00:00.000Z",
  });
  const operations = buildCurrentOperationsDeploymentDisabledV1();
  const packet = buildOperationsPostgresReadinessPacketV1({
    packetId: "packet:operations:postgres-readiness:1", databaseTarget, operations,
    preparedAt: "2026-08-31T18:01:00.000Z",
  });
  const disposition = buildOperationsPostgresReadinessDispositionV1({
    packet, recordedAt: "2026-08-31T18:02:00.000Z",
  });
  const projection = projectOperationsPostgresReadinessV1(packet, disposition);
  return { databaseTarget, operations, packet, disposition, projection };
}

function redigest<T extends Record<string, unknown>>(value: T, field: keyof T): T {
  const material = { ...value };
  delete material[field];
  return { ...material, [field]: sha256Digest(material) } as T;
}

test("CR11B-AUTO-100 composes all 39 target, operations, and automatic-work gates", () => {
  const { packet } = fixture();
  assert.equal(packet.gates.length, 39);
  assert.deepEqual(packet.databaseTargetBlockerCodes, [...OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1]);
  assert.deepEqual(packet.operationsGateIds, [...OPERATIONS_DEPLOYMENT_GATE_IDS_V1]);
  assert.deepEqual(packet.automaticWorkGateCodes, [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
  assert.deepEqual(packet.gates.slice(0, 12).map((gate) => gate.source), Array(12).fill("database_target"));
  assert.deepEqual(packet.gates.slice(12, 30).map((gate) => gate.source), Array(18).fill("operations_deployment"));
  assert.deepEqual(packet.gates.slice(30).map((gate) => gate.source), Array(9).fill("automatic_work"));
});

test("CR11B-AUTO-100 accepts only three repository contracts and keeps 36 blockers", () => {
  const { packet } = fixture();
  const met = packet.gates.filter((gate) => !gate.blocking);
  assert.deepEqual(met.map((gate) => gate.sourceGateCode), [...OPERATIONS_POSTGRES_READINESS_REPOSITORY_MET_GATES_V1]);
  assert.equal(met.every((gate) => gate.repositoryEvidenceOnly && !gate.liveEvidenceAccepted), true);
  assert.equal(packet.metRepositoryContractCount, 3);
  assert.equal(packet.blockingGateCount, 36);
  assert.equal(packet.blockingGateKeys.length, 36);
  assert.equal(packet.eligibleForOwnerWindow, false);
  assert.equal(packet.productionReady, false);
});

test("CR11B-AUTO-100 exposes every required readiness category without treating overlap as a pass", () => {
  const { packet } = fixture();
  for (const key of [
    "database_target:private_network_boundary_evidence",
    "database_target:database_role_separation",
    "operations_deployment:migration_compatibility",
    "operations_deployment:database_backup_freshness",
    "operations_deployment:wal_archiving_health",
    "operations_deployment:restore_rehearsal",
    "operations_deployment:resource_headroom",
    "automatic_work:consumer_channel_unqualified",
    "automatic_work:production_clock_custody_unproved",
    "automatic_work:production_policy_custody_unproved",
  ]) assert.equal(packet.blockingGateKeys.includes(key), true, key);
});

test("CR11B-AUTO-100 preserves the Hostinger target and rejects AWS, production PGlite, public DB, and R2 state", () => {
  const { packet } = fixture();
  assert.equal(packet.databaseTarget.providerTarget, "hostinger_kvm2_vps");
  assert.equal(packet.databaseTarget.awsRdsAllowed, false);
  assert.equal(packet.databaseTarget.pgliteProductionAllowed, false);
  assert.equal(packet.databaseTarget.publicDatabaseEndpointAllowed, false);
  assert.equal(packet.databaseTarget.r2CoordinationAllowed, false);
  assert.equal(packet.databaseTarget.r2TransactionalStateAllowed, false);
  assert.equal(packet.reportedHostContextUsedAsEvidence, false);
  assert.equal(packet.databaseTarget.reportedHostState.acceptedAsLiveEvidence, false);
});

test("CR11B-AUTO-100 disposition and projection remain disabled before host contact", () => {
  const { packet, disposition, projection } = fixture();
  assert.deepEqual(parseOperationsPostgresReadinessPacketV1(packet), packet);
  assert.deepEqual(parseOperationsPostgresReadinessDispositionV1(disposition, packet), disposition);
  assert.deepEqual(parseOperationsPostgresReadinessProjectionV1(projection, packet, disposition), projection);
  assert.equal(disposition.status, "disabled_before_host_contact");
  for (const value of [disposition.hostContacted, disposition.protectedReferenceResolved,
    disposition.serviceInstalledOrStarted, disposition.configurationWritten, disposition.databaseContacted,
    disposition.migrationAttempted, disposition.backupOrRestoreAttempted, disposition.consumerActivated,
    disposition.deploymentAttempted, disposition.externalEffectOccurred, disposition.grantsApproval,
    disposition.grantsDeploymentAuthority, disposition.grantsExecutionAuthority]) assert.equal(value, false);
  for (const key of ["canContactHost", "canResolveProtectedReferences", "canInstallOrStartServices",
    "canWriteConfiguration", "canContactDatabase", "canRunMigrations", "canRunBackupOrRestore",
    "canActivateConsumer", "canDeploy"] as const) assert.equal(projection[key], false, key);
});

test("CR11B-AUTO-100 rejects nested target and operations source substitution", () => {
  const { packet } = fixture();
  const targetDrift = { ...packet, databaseTarget: { ...packet.databaseTarget, awsRdsAllowed: true } };
  assert.throws(() => parseOperationsPostgresReadinessPacketV1(redigest(targetDrift, "packetDigest")),
    OperationsContractErrorV1);
  const planDrift = { ...packet.operations.plan, topologyDigest: sha256Digest({ foreign: "topology" }) };
  const operationsDrift = { ...packet, operations: { ...packet.operations, plan: planDrift } };
  assert.throws(() => parseOperationsPostgresReadinessPacketV1(redigest(operationsDrift, "packetDigest")),
    OperationsContractErrorV1);
});

test("CR11B-AUTO-100 rejects re-digested gate reordering, omission, and false readiness", () => {
  const { packet } = fixture();
  const reordered = { ...packet, gates: [...packet.gates].reverse() };
  assert.throws(() => parseOperationsPostgresReadinessPacketV1(redigest(reordered, "packetDigest")),
    OperationsContractErrorV1);
  const omitted = { ...packet, blockingGateKeys: packet.blockingGateKeys.slice(1) };
  assert.throws(() => parseOperationsPostgresReadinessPacketV1(omitted), OperationsContractErrorV1);
  const ready = { ...packet, productionReady: true };
  assert.throws(() => parseOperationsPostgresReadinessPacketV1(ready), OperationsContractErrorV1);
});

test("CR11B-AUTO-100 binds disposition to the exact packet and chronology", () => {
  const { packet, disposition } = fixture();
  const other = buildOperationsPostgresReadinessPacketV1({ packetId: "packet:operations:postgres-readiness:2",
    databaseTarget: packet.databaseTarget, operations: packet.operations, preparedAt: packet.preparedAt });
  assert.throws(() => parseOperationsPostgresReadinessDispositionV1(disposition, other), OperationsContractErrorV1);
  assert.throws(() => buildOperationsPostgresReadinessDispositionV1({ packet,
    recordedAt: "2026-08-31T17:59:00.000Z" }), OperationsContractErrorV1);
});

test("CR11B-AUTO-100 rejects a completely re-digested cross-object identity fork", () => {
  const { packet } = fixture();
  const plan = redigest({ ...packet.operations.plan, topologyId: "topology:operations:foreign:1" }, "planDigest");
  const assessment = redigest({ ...packet.operations.assessment, planDigest: plan.planDigest }, "assessmentDigest");
  const dispositionId = `disposition:operations:deployment:${assessment.assessmentDigest.slice(7, 31)}`;
  const disposition = redigest({ ...packet.operations.disposition, dispositionId, planDigest: plan.planDigest,
    assessmentDigest: assessment.assessmentDigest }, "dispositionDigest");
  const drift = redigest({ ...packet, operations: { ...packet.operations, plan, assessment, disposition } }, "packetDigest");
  assert.throws(() => parseOperationsPostgresReadinessPacketV1(drift), OperationsContractErrorV1);
});

test("CR11B-AUTO-100 freezes every source gate registry used after module initialization", () => {
  for (const values of [OPERATIONS_PRODUCTION_DATABASE_BLOCKERS_V1, OPERATIONS_DEPLOYMENT_GATE_IDS_V1,
    READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1, readyFrontierProductionEvidenceClassesV1,
    OPERATIONS_POSTGRES_READINESS_REPOSITORY_MET_GATES_V1]) {
    assert.equal(Object.isFrozen(values), true);
    assert.throws(() => { (values as unknown as string[])[0] = "forged_gate"; }, TypeError);
  }
  assert.deepEqual(parseOperationsPostgresReadinessPacketV1(fixture().packet), fixture().packet);
});

test("CR11B-AUTO-100 projection parsing requires the exact packet and disposition", () => {
  const first = fixture();
  const packet = buildOperationsPostgresReadinessPacketV1({ packetId: "packet:operations:postgres-readiness:2",
    databaseTarget: first.packet.databaseTarget, operations: first.packet.operations, preparedAt: first.packet.preparedAt });
  const disposition = buildOperationsPostgresReadinessDispositionV1({ packet, recordedAt: first.disposition.recordedAt });
  assert.throws(() => parseOperationsPostgresReadinessProjectionV1(first.projection, packet, disposition),
    OperationsContractErrorV1);
  const forged = redigest({ ...first.projection, packetDigest: packet.packetDigest }, "projectionDigest");
  assert.throws(() => parseOperationsPostgresReadinessProjectionV1(forged, first.packet, first.disposition),
    OperationsContractErrorV1);
});

test("CR11B-AUTO-100 rejects accessors and Proxies without executing caller behavior", () => {
  const { packet } = fixture();
  let calls = 0;
  const accessor = { packetId: "packet:operations:postgres-readiness:accessor", databaseTarget: packet.databaseTarget,
    operations: packet.operations, preparedAt: packet.preparedAt };
  Object.defineProperty(accessor, "databaseTarget", { enumerable: true, get() { calls += 1; return packet.databaseTarget; } });
  assert.throws(() => buildOperationsPostgresReadinessPacketV1(accessor), OperationsContractErrorV1);
  assert.equal(calls, 0);
  const proxied = observedProxy(accessor, "throwing");
  assert.throws(() => buildOperationsPostgresReadinessPacketV1(proxied.value), OperationsContractErrorV1);
  assert.equal(proxied.trapCount(), 0);
});

test("CR11B-AUTO-100 source contains no host, process, database, provider, credential, or deployment client", async () => {
  const source = await readFile(new URL("../src/operations/v1/postgres-readiness.ts", import.meta.url), "utf8");
  for (const forbidden of ["child_process", "exec(", "spawn(", "fetch(", "axios", "@aws-sdk", "aws-sdk",
    "from \"postgres\"", "from 'postgres'", "DATABASE_URL", "AWS_ACCESS_KEY_ID", "RDS_",
    "operationsPostgresReadinessSchemasV1"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
