import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  OPERATIONS_ACCEPTED_AUTO100_COMMIT_V1,
  OPERATIONS_ACCEPTED_AUTO100_REVIEW_SHA256_V1,
  OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_AT_V1,
  OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1,
  OPERATIONS_POSTGRES_REHEARSAL_MAX_DATABASE_SESSIONS_V1,
  OPERATIONS_POSTGRES_REHEARSAL_MAX_DURATION_SECONDS_V1,
  OPERATIONS_POSTGRES_REHEARSAL_MAX_EVIDENCE_BYTES_V1,
  OPERATIONS_POSTGRES_REHEARSAL_MAX_HOST_SESSIONS_V1,
  OPERATIONS_POSTGRES_REHEARSAL_MAX_NATIVE_ATTEMPTS_V1,
  OPERATIONS_POSTGRES_REHEARSAL_MAX_REQUEST_LIFETIME_SECONDS_V1,
  OperationsContractErrorV1,
  buildCurrentOperationsDeploymentDisabledV1,
  buildOperationsPostgresReadinessDispositionV1,
  buildOperationsPostgresReadinessPacketV1,
  buildOperationsPostgresRehearsalDispositionV1,
  buildOperationsPostgresRehearsalRequestV1,
  buildOperationsProductionDatabaseTargetV1,
  operationsPostgresRehearsalRequirementCodesV1,
  operationsPostgresRehearsalStageCodesV1,
  parseOperationsPostgresRehearsalDispositionV1,
  parseOperationsPostgresRehearsalProjectionV1,
  parseOperationsPostgresRehearsalRequestV1,
  projectOperationsPostgresRehearsalV1,
} from "../src/operations/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

function fixture() {
  const databaseTarget = buildOperationsProductionDatabaseTargetV1({
    decisionId: "decision:operations:production-database:hostinger:1",
    decidedAt: "2026-08-31T18:00:00.000Z",
  });
  const operations = buildCurrentOperationsDeploymentDisabledV1();
  const readinessPacket = buildOperationsPostgresReadinessPacketV1({
    packetId: "packet:operations:postgres-readiness:auto110", databaseTarget, operations,
    preparedAt: "2026-08-31T18:01:00.000Z",
  });
  const readinessDisposition = buildOperationsPostgresReadinessDispositionV1({
    packet: readinessPacket, recordedAt: "2026-08-31T18:02:00.000Z",
  });
  const request = buildOperationsPostgresRehearsalRequestV1({
    requestId: "request:operations:postgres-rehearsal:auto110",
    sourceReadinessPacket: readinessPacket,
    sourceReadinessDisposition: readinessDisposition,
    requestedAt: "2026-08-31T19:01:00.000Z",
    expiresAt: "2026-08-31T20:01:00.000Z",
  });
  const disposition = buildOperationsPostgresRehearsalDispositionV1({
    request, recordedAt: "2026-08-31T19:02:00.000Z",
  });
  const projection = projectOperationsPostgresRehearsalV1(request, disposition);
  return { databaseTarget, operations, readinessPacket, readinessDisposition, request, disposition, projection };
}

function redigest<T extends Record<string, unknown>>(value: T, field: keyof T): T {
  const material = { ...value };
  delete material[field];
  return { ...material, [field]: sha256Digest(material) } as T;
}

test("CR11B-AUTO-110 binds the exact accepted AUTO-100 lineage and all 36 live blockers", () => {
  const { request, readinessPacket, readinessDisposition } = fixture();
  assert.equal(request.acceptedAuto100Commit, OPERATIONS_ACCEPTED_AUTO100_COMMIT_V1);
  assert.equal(request.acceptedAuto100ReviewSha256, OPERATIONS_ACCEPTED_AUTO100_REVIEW_SHA256_V1);
  assert.equal(request.sourceReadinessPacketDigest, readinessPacket.packetDigest);
  assert.equal(request.sourceReadinessDispositionDigest, readinessDisposition.dispositionDigest);
  assert.equal(request.readinessBlockingGateCount, 36);
  assert.deepEqual(request.readinessBlockingGateKeys, readinessPacket.blockingGateKeys);
  assert.equal(request.phasePreparationAuthorized, true);
});

test("CR11B-AUTO-110 defines one bounded attempt, exact stages, and cleanup and evidence ceilings", () => {
  const { request } = fixture();
  assert.deepEqual(request.requestedStageCodes, [...operationsPostgresRehearsalStageCodesV1]);
  assert.deepEqual(request.blockingRequirementCodes, [...operationsPostgresRehearsalRequirementCodesV1]);
  assert.equal(request.maxNativeAttemptsRequested, OPERATIONS_POSTGRES_REHEARSAL_MAX_NATIVE_ATTEMPTS_V1);
  assert.equal(request.maxHostSessionsRequested, OPERATIONS_POSTGRES_REHEARSAL_MAX_HOST_SESSIONS_V1);
  assert.equal(request.maxDatabaseSessionsRequested, OPERATIONS_POSTGRES_REHEARSAL_MAX_DATABASE_SESSIONS_V1);
  assert.equal(request.maxDurationSecondsRequested, OPERATIONS_POSTGRES_REHEARSAL_MAX_DURATION_SECONDS_V1);
  assert.equal(request.maxEvidenceBytesRequested, OPERATIONS_POSTGRES_REHEARSAL_MAX_EVIDENCE_BYTES_V1);
  assert.equal(request.rollbackRequired, true);
  assert.equal(request.cleanupRequired, true);
  assert.equal(request.cleanupMustBeSeparatelyAuthorized, true);
  assert.equal(request.cleanupReceiptRequired, true);
});

test("CR11B-AUTO-110 treats the owner direction as phase preparation, never live effect authority", () => {
  const { request } = fixture();
  assert.equal(request.ownerPhaseDirectionId, OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_ID_V1);
  assert.equal(request.ownerPhaseDirection.acceptedAt, OPERATIONS_ACCEPTED_AUTO110_OWNER_DIRECTION_AT_V1);
  assert.equal(request.ownerPhaseDirection.source, "repository_accepted_owner_direction_snapshot");
  assert.equal(request.ownerPhaseDirection.scope,
    "auto110_effect_free_packet_preparation_and_independent_review_only");
  assert.equal(request.ownerPhaseDirection.liveEffectAuthorization, false);
  assert.equal(request.ownerPhaseDirection.protectedReferenceAuthority, false);
  assert.equal(request.ownerPhaseDirection.hostContactAuthority, false);
  for (const value of [request.exactLiveEffectAuthorizationPresent, request.ownerStrongFactorPresent,
    request.ownerEffectWindowPresent, request.protectedHostReferencePresent, request.protectedAccessPathPresent,
    request.effectClaimPresent, request.rollbackMaterialPresent, request.cleanupAuthorizationPresent,
    request.independentReviewAccepted, request.hostContactAuthorized, request.protectedReferenceResolutionAuthorized,
    request.processStartAuthorized, request.databaseContactAuthorized, request.migrationAuthorized,
    request.backupOrRestoreAuthorized, request.cleanupAuthorized, request.productionConsumerAuthorized,
    request.deploymentAuthorized, request.grantsApproval, request.grantsClaimOrLease,
    request.grantsDispatchOrExecution, request.grantsExternalEffects]) assert.equal(value, false);
  assert.equal(request.productionDataAllowed, false);
  assert.equal(request.publicEndpointAllowed, false);
  assert.equal(request.existingProductionSchemaWritesAllowed, false);
  assert.equal(request.rawEvidenceRetentionAllowed, false);
  assert.equal(request.automaticRetryAllowed, false);
});

test("CR11B-AUTO-110 rejects caller-selected and re-digested owner-direction identity forks", () => {
  const f = fixture();
  assert.throws(() => buildOperationsPostgresRehearsalRequestV1({
    requestId: "request:operations:postgres-rehearsal:caller-selected",
    sourceReadinessPacket: f.readinessPacket, sourceReadinessDisposition: f.readinessDisposition,
    ownerPhaseDirectionDigest: sha256Digest({ caller: "selected" }),
    ownerPhaseDirectionRecordedAt: "2026-08-31T19:00:00.000Z",
    requestedAt: f.request.requestedAt, expiresAt: f.request.expiresAt,
  }), OperationsContractErrorV1);

  for (const fork of [
    { directionId: "owner-direction:operations:postgres-rehearsal:auto110:fork" },
    { acceptedAt: "2026-08-31T16:58:35.001Z" },
  ]) {
    const direction = redigest({ ...f.request.ownerPhaseDirection, ...fork }, "directionDigest");
    const changed = redigest({ ...f.request, ownerPhaseDirection: direction,
      ownerPhaseDirectionId: direction.directionId,
      ownerPhaseDirectionDigest: direction.directionDigest }, "requestDigest");
    assert.throws(() => parseOperationsPostgresRehearsalRequestV1(changed), OperationsContractErrorV1);
  }
});

test("CR11B-AUTO-110 emits only a disabled disposition and safe operator projection", () => {
  const { request, disposition, projection } = fixture();
  assert.deepEqual(parseOperationsPostgresRehearsalRequestV1(request), request);
  assert.deepEqual(parseOperationsPostgresRehearsalDispositionV1(disposition, request), disposition);
  assert.deepEqual(parseOperationsPostgresRehearsalProjectionV1(projection, request, disposition), projection);
  assert.equal(disposition.status, "disabled_before_protected_reference_resolution");
  for (const value of [disposition.hostContacted, disposition.protectedReferenceResolved, disposition.processStarted,
    disposition.databaseContacted, disposition.migrationAttempted, disposition.backupOrRestoreAttempted,
    disposition.cleanupAttempted, disposition.productionConsumerActivated, disposition.deploymentAttempted,
    disposition.rawEvidenceRetained, disposition.externalEffectOccurred, disposition.grantsApproval,
    disposition.grantsDeploymentAuthority, disposition.grantsExecutionAuthority]) assert.equal(value, false);
  for (const key of ["canResolveProtectedReferences", "canContactHost", "canStartProcesses", "canContactDatabase",
    "canRunMigrations", "canRunBackupOrRestore", "canCleanupResources", "canActivateConsumer", "canDeploy"] as const) {
    assert.equal(projection[key], false, key);
  }
});

test("CR11B-AUTO-110 rejects source substitution and re-digested source identity drift", () => {
  const { request } = fixture();
  const changedPacketId = redigest({ ...request, sourceReadinessPacketId: "packet:operations:postgres-readiness:fork" },
    "requestDigest");
  assert.throws(() => parseOperationsPostgresRehearsalRequestV1(changedPacketId), OperationsContractErrorV1);
  const changedDisposition = { ...request.sourceReadinessDisposition,
    packetDigest: sha256Digest({ foreign: "readiness" }) };
  const sourceDrift = redigest({ ...request, sourceReadinessDisposition: changedDisposition }, "requestDigest");
  assert.throws(() => parseOperationsPostgresRehearsalRequestV1(sourceDrift), OperationsContractErrorV1);
});

test("CR11B-AUTO-110 rejects re-digested stage, requirement, and blocker manipulation", () => {
  const { request } = fixture();
  for (const changed of [
    { ...request, requestedStageCodes: [...request.requestedStageCodes].reverse() },
    { ...request, blockingRequirementCodes: [...request.blockingRequirementCodes].reverse() },
    { ...request, readinessBlockingGateKeys: [...request.readinessBlockingGateKeys].reverse() },
  ]) {
    assert.throws(() => parseOperationsPostgresRehearsalRequestV1(redigest(changed, "requestDigest")),
      OperationsContractErrorV1);
  }
});

test("CR11B-AUTO-110 rejects forged authority even when the request is re-digested", () => {
  const { request } = fixture();
  for (const changed of [
    { ...request, exactLiveEffectAuthorizationPresent: true },
    { ...request, hostContactAuthorized: true },
    { ...request, databaseContactAuthorized: true },
    { ...request, grantsExternalEffects: true },
    { ...request, independentReviewAccepted: true },
  ]) {
    assert.throws(() => parseOperationsPostgresRehearsalRequestV1(redigest(changed, "requestDigest")),
      OperationsContractErrorV1);
  }
});

test("CR11B-AUTO-110 enforces source, owner-direction, request, expiry, and disposition chronology", () => {
  const f = fixture();
  const base = { requestId: f.request.requestId, sourceReadinessPacket: f.readinessPacket,
    sourceReadinessDisposition: f.readinessDisposition };
  assert.throws(() => buildOperationsPostgresRehearsalRequestV1({ ...base,
    requestedAt: "2026-08-31T18:01:59.999Z",
    expiresAt: "2026-08-31T20:01:00.000Z" }), OperationsContractErrorV1);
  assert.throws(() => buildOperationsPostgresRehearsalRequestV1({ ...base,
    requestedAt: "2026-08-31T19:01:00.000Z",
    expiresAt: "2026-08-31T20:01:00.001Z" }), OperationsContractErrorV1);
  assert.throws(() => buildOperationsPostgresRehearsalDispositionV1({ request: f.request,
    recordedAt: "2026-08-31T19:00:59.999Z" }), OperationsContractErrorV1);
  assert.equal(OPERATIONS_POSTGRES_REHEARSAL_MAX_REQUEST_LIFETIME_SECONDS_V1, 3_600);
});

test("CR11B-AUTO-110 binds disposition and projection to one exact request", () => {
  const first = fixture();
  const request = buildOperationsPostgresRehearsalRequestV1({
    requestId: "request:operations:postgres-rehearsal:auto110:second",
    sourceReadinessPacket: first.readinessPacket, sourceReadinessDisposition: first.readinessDisposition,
    requestedAt: first.request.requestedAt, expiresAt: first.request.expiresAt,
  });
  assert.throws(() => parseOperationsPostgresRehearsalDispositionV1(first.disposition, request),
    OperationsContractErrorV1);
  assert.throws(() => parseOperationsPostgresRehearsalProjectionV1(first.projection, request, first.disposition),
    OperationsContractErrorV1);
});

test("CR11B-AUTO-110 freezes its public registries", () => {
  for (const values of [operationsPostgresRehearsalStageCodesV1, operationsPostgresRehearsalRequirementCodesV1]) {
    assert.equal(Object.isFrozen(values), true);
    assert.throws(() => { (values as unknown as string[])[0] = "forged"; }, TypeError);
  }
  assert.deepEqual(parseOperationsPostgresRehearsalRequestV1(fixture().request), fixture().request);
});

test("CR11B-AUTO-110 rejects accessors and Proxies without executing caller behavior", () => {
  const f = fixture();
  let calls = 0;
  const accessor = { requestId: f.request.requestId, sourceReadinessPacket: f.readinessPacket,
    sourceReadinessDisposition: f.readinessDisposition, requestedAt: f.request.requestedAt, expiresAt: f.request.expiresAt };
  Object.defineProperty(accessor, "sourceReadinessPacket", { enumerable: true,
    get() { calls += 1; return f.readinessPacket; } });
  assert.throws(() => buildOperationsPostgresRehearsalRequestV1(accessor), OperationsContractErrorV1);
  assert.equal(calls, 0);
  const proxied = observedProxy(accessor, "throwing");
  assert.throws(() => buildOperationsPostgresRehearsalRequestV1(proxied.value), OperationsContractErrorV1);
  assert.equal(proxied.trapCount(), 0);
});

test("CR11B-AUTO-110 source contains no host, process, database, credential, or deployment client", async () => {
  const source = await readFile(new URL("../src/operations/v1/postgres-rehearsal.ts", import.meta.url), "utf8");
  for (const forbidden of ["child_process", "exec(", "spawn(", "fetch(", "axios", "@aws-sdk", "aws-sdk",
    "from \"postgres\"", "from 'postgres'", "DATABASE_URL", "AWS_ACCESS_KEY_ID", "RDS_",
    "operationsPostgresRehearsalSchemasV1", "projectWorkspaceTimeSchemaV1"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
