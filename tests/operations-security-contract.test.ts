import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCurrentOperationsDeploymentDisabledV1,
  buildOperationsBackupManifestV1,
  buildOperationsDeploymentPlanV1,
  buildOperationsDeploymentPrerequisiteV1,
  buildOperationsDeploymentReadinessAssessmentV1,
  buildOperationsHealthProbeV1,
  buildOperationsHealthSnapshotV1,
  buildOperationsProductionTopologyV1,
  buildOperationsRecoveryPlanV1,
  buildOperationsReleaseCandidateV1,
  buildOperationsRollbackPlanV1,
  buildOperationsServiceHealthV1,
  buildOperationsSyntheticBackupManifestV1,
  buildOperationsSyntheticHealthSnapshotV1,
  buildOperationsSyntheticReleaseCandidateV1,
  buildOperationsSyntheticTopologyFixtureV1,
  evaluateOperationsDeploymentTransitionV1,
  OperationsContractErrorV1,
  OPERATIONS_DEPLOYMENT_GATE_IDS_V1,
  OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1,
  OPERATIONS_RECOVERY_PHASE_IDS_V1,
  OPERATIONS_SERVICE_IDS_V1,
  OPERATIONS_SERVICE_ROLES_V1,
  parseOperationsBackupManifestV1,
  parseOperationsDeploymentPlanV1,
  parseOperationsDeploymentReadinessAssessmentV1,
  parseOperationsHealthProbeV1,
  parseOperationsHealthSnapshotV1,
  parseOperationsProductionTopologyV1,
  parseOperationsRecoveryPlanV1,
  parseOperationsReleaseCandidateV1,
  parseOperationsRollbackPlanV1,
  type OperationsDeploymentPlanV1,
  type OperationsHealthProbeV1,
  type OperationsProductionTopologyV1,
  type OperationsReleaseCandidateV1,
} from "../src/operations/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

function clone<T>(value: T): T { return structuredClone(value); }
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value };
  delete material[key];
  return { ...value, [key]: sha256Digest(material) };
}
function code(safeCode: string) {
  return (error: unknown) => error instanceof OperationsContractErrorV1 && error.safeCode === safeCode;
}
function distinct(label: string) { return sha256Digest({ test: "operations", label }); }
function previousRelease(topology: OperationsProductionTopologyV1): OperationsReleaseCandidateV1 {
  return buildOperationsReleaseCandidateV1({ releaseId: "release:operations:previous:1", version: "0.0.9",
    sourceRevisionDigest: distinct("previous-source"), applicationArtifactDigest: topology.services[1]!.artifactIdentityDigest,
    migrationBundleDigest: topology.services[2]!.artifactIdentityDigest,
    publicAssetsDigest: topology.services[0]!.artifactIdentityDigest, lockfileDigest: distinct("previous-lockfile"),
    sbomDigest: distinct("previous-sbom"), provenanceDigest: distinct("previous-provenance"),
    signatureEvidenceDigest: distinct("previous-signature"),
    configurationSchemaDigest: topology.services[1]!.configurationSchemaDigest,
    protocolCompatibilityDigest: distinct("previous-protocol"), rollbackCompatibilityDigest: distinct("previous-rollback"),
    builtAt: "2026-08-29T20:00:00.000Z" });
}
function completePrerequisites(plan: OperationsDeploymentPlanV1) {
  const checkedAt = "2026-08-29T23:58:00.000Z";
  const volatile = new Set(["credential_reference_custody", "edge_access_policy", "database_backup_freshness",
    "wal_archiving_health", "resource_headroom", "monitoring_alert_path", "audit_anchor_freshness", "fresh_owner_window"]);
  return OPERATIONS_DEPLOYMENT_GATE_IDS_V1.map((gateId, position) => buildOperationsDeploymentPrerequisiteV1({ gateId,
    state: "met", evidenceDigest: position === 0 ? plan.topologyDigest : position === 1 ? plan.releaseDigest
      : position === 13 ? OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 : distinct(`gate:${gateId}`), checkedAt,
    ...(volatile.has(gateId) ? { validUntil: "2026-08-30T00:30:00.000Z" } : {}),
    safeReasonCode: "authoritative_evidence_verified" }));
}

test("CR10A-OPS-000 freezes seven distinct least-privilege service identities", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1();
  assert.deepEqual(topology.services.map((service) => service.role), [...OPERATIONS_SERVICE_ROLES_V1]);
  assert.deepEqual(topology.services.map((service) => service.serviceId), [...OPERATIONS_SERVICE_IDS_V1]);
  assert.equal(new Set(topology.services.map((service) => service.principalIdentityDigest)).size, 7);
  assert.equal(topology.services.every((service) => !service.runsAsRoot && !service.hostAdministrationAllowed
    && !service.publicListenerAllowed && !service.directNodeListenerAllowed && !service.credentialMaterialPersisted
    && !service.credentialMaterialLogged && !service.grantsDeploymentAuthority && !service.grantsExecutionAuthority), true);
  assert.deepEqual(topology.services.filter((service) => service.schemaMutationAllowed).map((service) => service.role), ["migration_runner"]);
  assert.equal(topology.globalWriteAuthority, "postgres_primary_only");
  assert.equal(topology.sharedOperatingSystemPrincipalAllowed, false);
  assert.deepEqual(parseOperationsProductionTopologyV1(topology), topology);
});

test("CR10A-OPS-000 freezes fifteen exact flows and denies public origin or invented networking", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1();
  assert.equal(topology.networkFlows.length, 15);
  assert.equal(topology.networkFlows.every((flow) => flow.exactPeerIdentityRequired && !flow.redirectsAllowed
    && !flow.wildcardDestinationAllowed && !flow.rawAddressStored && !flow.grantsNetworkAuthority), true);
  assert.equal(topology.edgeModel, "protected_tunnel_no_public_origin");
  assert.equal(topology.nodeConnectivity, "outbound_authenticated_only");
  assert.equal(topology.unknownNetworkFlowsDenied, true);
  assert.equal(topology.hostnamesPresent || topology.addressesPresent || topology.portsPresent
    || topology.credentialValuesPresent || topology.deployableConfigurationPresent, false);
});

test("CR10A-OPS-000 service and flow semantics cannot drift after nested and outer re-signing", () => {
  const principal = clone(buildOperationsSyntheticTopologyFixtureV1());
  principal.services[1]!.principalIdentityDigest = principal.services[0]!.principalIdentityDigest;
  principal.services[1] = resign(principal.services[1] as unknown as Record<string, unknown>, "serviceDigest") as never;
  assert.throws(() => parseOperationsProductionTopologyV1(resign(principal as unknown as Record<string, unknown>, "topologyDigest")),
    code("scope_mismatch"));
  const flow = clone(buildOperationsSyntheticTopologyFixtureV1());
  flow.networkFlows[0]!.direction = "outbound_only";
  flow.networkFlows[0] = resign(flow.networkFlows[0] as unknown as Record<string, unknown>, "flowDigest") as never;
  assert.throws(() => parseOperationsProductionTopologyV1(resign(flow as unknown as Record<string, unknown>, "topologyDigest")),
    code("scope_mismatch"));
  const role = clone(buildOperationsSyntheticTopologyFixtureV1());
  role.services[0]!.trustZone = "data";
  role.services[0] = resign(role.services[0] as unknown as Record<string, unknown>, "serviceDigest") as never;
  assert.throws(() => parseOperationsProductionTopologyV1(resign(role as unknown as Record<string, unknown>, "topologyDigest")),
    code("scope_mismatch"));
});

test("CR10A-OPS-000 release candidate is immutable reference evidence and not deployable material", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), release = buildOperationsSyntheticReleaseCandidateV1(topology);
  assert.equal(release.applicationArtifactDigest, topology.services[1]!.artifactIdentityDigest);
  assert.equal(release.migrationBundleDigest, topology.services[2]!.artifactIdentityDigest);
  assert.equal(release.publicAssetsDigest, topology.services[0]!.artifactIdentityDigest);
  assert.equal(release.state, "candidate_references_only");
  assert.equal(release.artifactBytesPresent || release.productionConfigurationPresent || release.credentialValuesPresent
    || release.verifiedAtRuntime || release.grantsDeploymentAuthority, false);
  assert.deepEqual(parseOperationsReleaseCandidateV1(release), release);
});

test("CR10A-OPS-000 deployment plan binds topology and release with stable effect identity and zero authority", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), plan = current.plan;
  assert.equal(plan.topologyDigest, current.topology.topologyDigest);
  assert.equal(plan.releaseDigest, current.release.releaseDigest);
  assert.equal(plan.strategy, "one_host_canary_then_owner_promotion");
  assert.equal(plan.canaryHostLimit, 1);
  assert.equal(plan.migrationPolicy, "forward_only_separate_runner");
  assert.equal(plan.automaticPromotionAllowed || plan.automaticRollbackAllowed || plan.databaseDownMigrationAllowed
    || plan.automaticRetryAfterChange || plan.deploymentAuthorized || plan.serviceControlAllowed
    || plan.databaseMutationAllowed || plan.grantsDeploymentAuthority, false);
  assert.deepEqual(parseOperationsDeploymentPlanV1(plan), plan);
  const replay = buildOperationsDeploymentPlanV1({ planId: "plan:operations:replay", topology: current.topology,
    release: current.release, plannedAt: plan.plannedAt, expiresAt: plan.expiresAt });
  assert.equal(replay.operationDigest, plan.operationDigest);
  assert.equal(replay.deploymentIdempotencyKey, plan.deploymentIdempotencyKey);
});

test("CR10A-OPS-000 release-to-topology mismatch and invalid windows fail closed", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), release = buildOperationsSyntheticReleaseCandidateV1(topology);
  const drift = clone(release); drift.applicationArtifactDigest = distinct("foreign-application");
  const resigned = resign(drift as unknown as Record<string, unknown>, "releaseDigest");
  assert.throws(() => buildOperationsDeploymentPlanV1({ planId: "plan:operations:drift", topology, release: resigned,
    plannedAt: "2026-08-29T23:00:00.000Z", expiresAt: "2026-08-30T00:00:00.000Z" }), code("scope_mismatch"));
  assert.throws(() => buildOperationsDeploymentPlanV1({ planId: "plan:operations:expired", topology, release,
    plannedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-29T23:00:00.000Z" }), code("scope_mismatch"));
});

test("CR10A-OPS-000 current deployment truth records three of eighteen gates and zero effects", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1();
  assert.equal(current.assessment.prerequisites.length, 18);
  assert.equal(current.assessment.prerequisites.filter((item) => item.state === "met").length, 3);
  assert.equal(current.assessment.blockingGateIds.length, 15);
  assert.equal(current.assessment.readiness, "blocked");
  assert.equal(current.assessment.eligibleForOwnerWindow, false);
  assert.equal(current.disposition.status, "disabled_before_change");
  for (const field of ["deploymentAttempted", "serviceControlAttempted", "configurationWritten",
    "credentialResolutionObserved", "networkOrDnsChanged", "databaseMigrationAttempted", "backupOrRestoreAttempted",
    "canaryStarted", "trafficChanged", "externalEffectOccurred", "grantsDeploymentAuthority"] as const) {
    assert.equal(current.disposition[field], false, field);
  }
});

test("CR10A-OPS-000 complete readiness creates only an owner-window candidate", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), assessment = buildOperationsDeploymentReadinessAssessmentV1({
    assessmentId: "assessment:operations:complete", plan: current.plan, prerequisites: completePrerequisites(current.plan),
    assessedAt: "2026-08-29T23:58:00.000Z" });
  assert.equal(assessment.readiness, "candidate_for_owner_window");
  assert.equal(assessment.eligibleForOwnerWindow, true);
  assert.equal(assessment.blockingGateIds.length, 0);
  assert.equal(assessment.deploymentAuthorized || assessment.grantsApproval || assessment.grantsDeploymentAuthority
    || assessment.grantsExecutionAuthority, false);
  assert.deepEqual(parseOperationsDeploymentReadinessAssessmentV1(assessment), assessment);
});

test("CR10A-OPS-000 readiness rejects gate order, evidence aliases, and unfresh volatile evidence", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), values = completePrerequisites(current.plan);
  const reordered = clone(values); reordered.reverse();
  assert.throws(() => buildOperationsDeploymentReadinessAssessmentV1({ assessmentId: "assessment:operations:reordered",
    plan: current.plan, prerequisites: reordered, assessedAt: "2026-08-29T23:58:00.000Z" }), code("scope_mismatch"));
  const alias = clone(values); alias[0]!.evidenceDigest = distinct("topology-alias");
  alias[0] = resign(alias[0] as unknown as Record<string, unknown>, "prerequisiteDigest") as never;
  assert.throws(() => buildOperationsDeploymentReadinessAssessmentV1({ assessmentId: "assessment:operations:alias",
    plan: current.plan, prerequisites: alias, assessedAt: "2026-08-29T23:58:00.000Z" }), code("scope_mismatch"));
  assert.throws(() => buildOperationsDeploymentPrerequisiteV1({ gateId: "fresh_owner_window", state: "met",
    evidenceDigest: distinct("owner"), checkedAt: "2026-08-29T23:58:00.000Z", safeReasonCode: "missing_expiry" }),
  code("invalid_input"));
});

test("CR10A-OPS-000 deployment lifecycle has explicit owner stops and terminal ambiguity", () => {
  assert.deepEqual(evaluateOperationsDeploymentTransitionV1("planned", "readiness_confirmed").toState, "readiness_candidate");
  assert.deepEqual(evaluateOperationsDeploymentTransitionV1("readiness_candidate", "owner_window_opened").toState, "canary_pending");
  assert.equal(evaluateOperationsDeploymentTransitionV1("readiness_candidate", "owner_window_opened").requiresExternalAuthority, true);
  assert.deepEqual(evaluateOperationsDeploymentTransitionV1("canary_observing", "canary_observation_unknown").toState, "ambiguous");
  assert.deepEqual(evaluateOperationsDeploymentTransitionV1("rollback_pending", "post_change_unknown").toState, "ambiguous");
  const denied = evaluateOperationsDeploymentTransitionV1("ambiguous", "canary_started");
  assert.equal(denied.permittedByStateMachine, false);
  assert.equal(denied.toState, undefined);
  assert.equal(denied.automaticRetryAllowed || denied.performsAction || denied.grantsDeploymentAuthority, false);
});

test("CR10A-OPS-000 independent health can become only a readiness candidate", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), snapshot = buildOperationsSyntheticHealthSnapshotV1(topology);
  assert.equal(snapshot.overallReadiness, "ready_candidate");
  assert.equal(snapshot.blockingServiceIds.length, 0);
  assert.equal(snapshot.observations[2]!.readiness, "dormant_ready");
  assert.equal(snapshot.observations[2]!.liveness, "not_applicable");
  assert.equal(snapshot.observations.every((item) => item.observerPrincipalDigest !== item.servicePrincipalDigest
    && !item.selfReportSufficient && !item.serviceControlAttempted && !item.networkProbeAttemptedByContract
    && !item.grantsServiceControl && !item.grantsDeploymentAuthority), true);
  assert.equal(snapshot.deployableHealthAuthority || snapshot.grantsDeploymentAuthority, false);
  assert.deepEqual(parseOperationsHealthSnapshotV1(snapshot), snapshot);
});

test("CR10A-OPS-000 a failed application dependency makes the whole topology not ready", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), snapshot = buildOperationsSyntheticHealthSnapshotV1(topology, "application_failed");
  assert.equal(snapshot.overallReadiness, "not_ready");
  assert.deepEqual(snapshot.blockingServiceIds, ["service:operations:application"]);
  assert.equal(snapshot.observations[1]!.readiness, "not_ready");
  assert.equal(snapshot.observations[1]!.safeStatusCode, "required_probe_failed");
});

test("CR10A-OPS-000 health rejects self-reporting and incorrect probe applicability", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), snapshot = buildOperationsSyntheticHealthSnapshotV1(topology),
    application = snapshot.observations[1]!;
  assert.throws(() => buildOperationsServiceHealthV1({ observationId: "observation:operations:self",
    topology, serviceId: application.serviceId, observerPrincipalDigest: application.servicePrincipalDigest,
    probes: application.probes, observedAt: application.observedAt, validUntil: application.validUntil }), code("scope_mismatch"));
  const probes = clone(application.probes); probes[4] = buildOperationsHealthProbeV1({ probeId: "database_transaction",
    applicability: "not_applicable", state: "not_applicable", safeStatusCode: "incorrectly_omitted", observedAt: application.observedAt });
  assert.throws(() => buildOperationsServiceHealthV1({ observationId: "observation:operations:applicability",
    topology, serviceId: application.serviceId, observerPrincipalDigest: application.observerPrincipalDigest,
    probes, observedAt: application.observedAt, validUntil: application.validUntil }), code("scope_mismatch"));
});

test("CR10A-OPS-000 stale and unknown probes never become healthy", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), passing = buildOperationsSyntheticHealthSnapshotV1(topology),
    edge = passing.observations[0]!, probes = clone(edge.probes);
  probes[0] = buildOperationsHealthProbeV1({ probeId: "process_identity", applicability: "required", state: "stale",
    safeStatusCode: "probe_expired", evidenceDigest: distinct("stale-process"), observedAt: "2026-08-30T00:03:00.000Z",
    validUntil: "2026-08-30T00:02:00.000Z", observerIdentityDigest: edge.observerPrincipalDigest });
  const observation = buildOperationsServiceHealthV1({ observationId: "observation:operations:stale-edge", topology,
    serviceId: edge.serviceId, observerPrincipalDigest: edge.observerPrincipalDigest, probes,
    observedAt: "2026-08-30T00:03:00.000Z", validUntil: "2026-08-30T00:04:00.000Z" });
  assert.equal(observation.liveness, "unknown");
  assert.equal(observation.readiness, "unknown");
});

test("CR10A-OPS-000 health snapshot refuses cross-topology or reordered observations", () => {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), snapshot = buildOperationsSyntheticHealthSnapshotV1(topology),
    reordered = clone(snapshot.observations); reordered.reverse();
  assert.throws(() => buildOperationsHealthSnapshotV1({ snapshotId: "snapshot:operations:reordered", topology,
    observations: reordered, observedAt: snapshot.observedAt, validUntil: snapshot.validUntil }), code("scope_mismatch"));
  const foreign = buildOperationsProductionTopologyV1({ topologyId: "topology:operations:foreign", deploymentId: "deployment:operations:foreign",
    serviceArtifactDigests: OPERATIONS_SERVICE_ROLES_V1.map((role) => sha256Digest({ role, foreign: true })),
    configurationSchemaDigest: distinct("foreign-config"), credentialReferenceDigests: { edge: [], application: [], migration: [],
      postgres: [], backup: [], auditAnchor: [], observer: [] }, createdAt: "2026-08-29T23:55:00.000Z" });
  assert.throws(() => buildOperationsHealthSnapshotV1({ snapshotId: "snapshot:operations:foreign", topology: foreign,
    observations: snapshot.observations, observedAt: snapshot.observedAt, validUntil: snapshot.validUntil }), code("scope_mismatch"));
});

test("CR10A-OPS-000 backup manifest contains only immutable encrypted evidence references", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), backup = buildOperationsSyntheticBackupManifestV1(current.topology, current.release);
  assert.equal(backup.encrypted && backup.immutable && backup.independentlyVerifiable, true);
  assert.equal(backup.containsDatabaseBytes || backup.containsWalBytes || backup.containsObjectLocator
    || backup.containsCredentialMaterial || backup.grantsRestoreAuthority || backup.grantsCutoverAuthority
    || backup.grantsExecutionAuthority, false);
  assert.equal(backup.topologyDigest, current.topology.topologyDigest);
  assert.equal(backup.releaseDigest, current.release.releaseDigest);
  assert.deepEqual(parseOperationsBackupManifestV1(backup), backup);
});

test("CR10A-OPS-000 backup chronology and manifest drift fail closed", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1();
  const base = { backupId: "backup:operations:bad", topology: current.topology, release: current.release,
    databaseIdentityDigest: distinct("database"), databaseSchemaDigest: distinct("schema"), baseBackupDigest: distinct("base"),
    walStartDigest: distinct("wal-start"), walEndDigest: distinct("wal-end"), auditChainHeadDigest: distinct("chain"),
    auditAnchorDigest: distinct("anchor"), objectLocationReferenceDigest: distinct("location"),
    encryptionKeyReferenceDigest: distinct("key-ref"), manifestSignatureDigest: distinct("signature"), declaredEncryptedBytes: 1,
    startedAt: "2026-08-29T22:10:00.000Z", completedAt: "2026-08-29T22:00:00.000Z",
    earliestRestorePointAt: "2026-08-29T22:00:00.000Z", latestRestorePointAt: "2026-08-29T22:09:00.000Z" };
  assert.throws(() => buildOperationsBackupManifestV1(base), code("invalid_input"));
  const backup = clone(buildOperationsSyntheticBackupManifestV1(current.topology, current.release));
  backup.baseBackupDigest = distinct("drift");
  assert.throws(() => parseOperationsBackupManifestV1(backup), code("digest_mismatch"));
});

test("CR10A-OPS-000 recovery is an ordered disposable restore candidate with no production cutover", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), backup = buildOperationsSyntheticBackupManifestV1(current.topology, current.release),
    targetIdentityDigest = distinct("disposable-restore-target"), input = { recoveryPlanId: "recovery:operations:synthetic:1",
      topology: current.topology, release: current.release, backup, requestedRestorePointAt: "2026-08-29T22:05:00.000Z",
      targetIdentityDigest, targetRpoSeconds: 3600, targetRtoSeconds: 7200,
      plannedAt: "2026-08-29T23:59:00.000Z", expiresAt: "2026-08-30T00:59:00.000Z" }, plan = buildOperationsRecoveryPlanV1(input);
  assert.deepEqual(plan.phases.map((phase) => phase.phaseId), [...OPERATIONS_RECOVERY_PHASE_IDS_V1]);
  assert.equal(plan.phases.every((phase, position) => phase.position === position && phase.requiresPreviousPhase === (position > 0)
    && !phase.phaseAuthorized), true);
  assert.equal(plan.targetClass, "disposable_isolated_only");
  assert.equal(plan.journalReconciliationMode, "node_truth_cannot_be_overwritten");
  assert.equal(plan.productionOverwriteAllowed || plan.directProductionCutoverAllowed || plan.databaseDownMigrationAllowed
    || plan.automaticRetryAfterRestoreMarker || plan.restoreAuthorized || plan.cutoverAuthorized
    || plan.grantsRestoreAuthority || plan.grantsExecutionAuthority, false);
  assert.deepEqual(parseOperationsRecoveryPlanV1(plan), plan);
  assert.equal(buildOperationsRecoveryPlanV1({ ...input, recoveryPlanId: "recovery:operations:replay" }).recoveryIdempotencyKey,
    plan.recoveryIdempotencyKey);
});

test("CR10A-OPS-000 recovery refuses a production principal, uncovered point, or cross-release backup", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), backup = buildOperationsSyntheticBackupManifestV1(current.topology, current.release),
    base = { recoveryPlanId: "recovery:operations:bad", topology: current.topology, release: current.release, backup,
      requestedRestorePointAt: "2026-08-29T22:05:00.000Z", targetIdentityDigest: distinct("disposable"),
      targetRpoSeconds: 3600, targetRtoSeconds: 7200, plannedAt: "2026-08-29T23:59:00.000Z",
      expiresAt: "2026-08-30T00:59:00.000Z" };
  assert.throws(() => buildOperationsRecoveryPlanV1({ ...base,
    targetIdentityDigest: current.topology.services[3]!.principalIdentityDigest }), code("scope_mismatch"));
  assert.throws(() => buildOperationsRecoveryPlanV1({ ...base,
    requestedRestorePointAt: "2026-08-29T22:30:00.000Z" }), code("scope_mismatch"));
  const previous = previousRelease(current.topology);
  assert.throws(() => buildOperationsRecoveryPlanV1({ ...base, release: previous }), code("scope_mismatch"));
});

test("CR10A-OPS-000 application rollback and database restore remain separate owner-gated plans", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), previous = previousRelease(current.topology),
    unchanged = buildOperationsRollbackPlanV1({ rollbackPlanId: "rollback:operations:application-only",
      topology: current.topology, currentRelease: current.release, previousRelease: previous,
      databaseDisposition: "unchanged_verified", compatibilityEvidenceDigest: distinct("compatibility"),
      plannedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T01:00:00.000Z" }),
    previousBackup = buildOperationsSyntheticBackupManifestV1(current.topology, previous),
    restored = buildOperationsRollbackPlanV1({ rollbackPlanId: "rollback:operations:with-restore",
      topology: current.topology, currentRelease: current.release, previousRelease: previous,
      databaseDisposition: "restore_from_verified_backup_required", compatibilityEvidenceDigest: distinct("restore-compatibility"),
      backup: previousBackup, plannedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T01:00:00.000Z" });
  for (const plan of [unchanged, restored]) {
    assert.equal(plan.applicationRollbackRequiresCanary, true);
    assert.equal(plan.databaseDownMigrationAllowed || plan.automaticRollbackAllowed || plan.automaticRetryAfterChange
      || plan.rollbackAuthorized || plan.serviceControlAllowed || plan.databaseMutationAllowed
      || plan.grantsRollbackAuthority || plan.grantsExecutionAuthority, false);
    assert.deepEqual(parseOperationsRollbackPlanV1(plan), plan);
  }
  assert.equal(unchanged.backupDigest, undefined);
  assert.equal(restored.backupDigest, previousBackup.backupDigest);
});

test("CR10A-OPS-000 rollback refuses missing, unnecessary, or wrong-release backup evidence", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), previous = previousRelease(current.topology),
    currentBackup = buildOperationsSyntheticBackupManifestV1(current.topology, current.release), base = {
      rollbackPlanId: "rollback:operations:bad", topology: current.topology, currentRelease: current.release,
      previousRelease: previous, compatibilityEvidenceDigest: distinct("compatibility"),
      plannedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T01:00:00.000Z" };
  assert.throws(() => buildOperationsRollbackPlanV1({ ...base,
    databaseDisposition: "restore_from_verified_backup_required" }), code("scope_mismatch"));
  assert.throws(() => buildOperationsRollbackPlanV1({ ...base,
    databaseDisposition: "unchanged_verified", backup: currentBackup }), code("scope_mismatch"));
  assert.throws(() => buildOperationsRollbackPlanV1({ ...base,
    databaseDisposition: "restore_from_verified_backup_required", backup: currentBackup }), code("scope_mismatch"));
});

test("CR10A-OPS-000 exact boundaries reject extras, secrets, accessors, and Proxies without traps", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1();
  assert.throws(() => parseOperationsProductionTopologyV1({ ...current.topology, hostname: "private.internal" }), code("invalid_input"));
  assert.throws(() => parseOperationsReleaseCandidateV1({ ...current.release,
    accessToken: "Bearer abcdefghijklmnopqrstuvwxyz" }), (error: unknown) => error instanceof OperationsContractErrorV1);
  let getterRan = false;
  const accessor = { ...current.plan } as Record<string, unknown>;
  Object.defineProperty(accessor, "planId", { enumerable: true, get() { getterRan = true; return current.plan.planId; } });
  assert.throws(() => parseOperationsDeploymentPlanV1(accessor), code("invalid_input"));
  assert.equal(getterRan, false);
  for (const value of [current.topology, current.release, current.assessment]) {
    const proxy = observedProxy(value, "transparent");
    assert.throws(() => value === current.topology ? parseOperationsProductionTopologyV1(proxy.value)
      : value === current.release ? parseOperationsReleaseCandidateV1(proxy.value)
        : parseOperationsDeploymentReadinessAssessmentV1(proxy.value), code("invalid_input"));
    assert.equal(proxy.trapCount(), 0);
  }
});

test("CR10A-OPS-000 health and recovery parsers reject digest drift after outer re-signing", () => {
  const current = buildCurrentOperationsDeploymentDisabledV1(), health = clone(buildOperationsSyntheticHealthSnapshotV1(current.topology));
  health.observations[0]!.safeStatusCode = "invented_success";
  health.observations[0] = resign(health.observations[0] as unknown as Record<string, unknown>, "observationDigest") as never;
  assert.throws(() => parseOperationsHealthSnapshotV1(resign(health as unknown as Record<string, unknown>, "snapshotDigest")),
    code("scope_mismatch"));
  const backup = buildOperationsSyntheticBackupManifestV1(current.topology, current.release), recovery = clone(buildOperationsRecoveryPlanV1({
    recoveryPlanId: "recovery:operations:drift", topology: current.topology, release: current.release, backup,
    requestedRestorePointAt: "2026-08-29T22:05:00.000Z", targetIdentityDigest: distinct("drift-target"),
    targetRpoSeconds: 3600, targetRtoSeconds: 7200, plannedAt: "2026-08-29T23:59:00.000Z",
    expiresAt: "2026-08-30T00:59:00.000Z" }));
  recovery.phases[0]!.effectClass = "owner_gate";
  recovery.phases[0] = resign(recovery.phases[0] as unknown as Record<string, unknown>, "phaseDigest") as never;
  assert.throws(() => parseOperationsRecoveryPlanV1(resign(recovery as unknown as Record<string, unknown>, "recoveryPlanDigest")),
    code("scope_mismatch"));
});

test("CR10A-OPS-000 probe parser enforces freshness even after re-signing", () => {
  const probe: OperationsHealthProbeV1 = buildOperationsHealthProbeV1({ probeId: "process_identity", applicability: "required",
    state: "pass", safeStatusCode: "current", evidenceDigest: distinct("process"),
    observedAt: "2026-08-30T00:00:00.000Z", validUntil: "2026-08-30T00:01:00.000Z",
    observerIdentityDigest: distinct("observer") });
  const drift = clone(probe); drift.validUntil = "2026-08-29T23:59:00.000Z";
  assert.throws(() => parseOperationsHealthProbeV1(resign(drift as unknown as Record<string, unknown>, "probeDigest")),
    code("scope_mismatch"));
});

test("CR10A-OPS-000 accepted source has no process, filesystem, network, database, provider, or service-control runtime", async () => {
  const sources = await Promise.all(["topology.ts", "deployment.ts", "health.ts", "recovery.ts"]
    .map((name) => readFile(new URL(`../src/operations/v1/${name}`, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /node:(?:child_process|fs|http|https|net|tls)|\b(?:spawn|execFile|fetch)\s*\(/);
    assert.doesNotMatch(source, /postgres(?:ql)?\(|dockerode|cloudflare|@aws-sdk|systemctl|launchctl|sc\.exe/i);
  }
});
