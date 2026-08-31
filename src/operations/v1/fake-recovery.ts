import { z } from "zod";
import { projectWorkspaceDigestSchemaV1 as digest, projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time } from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { parseOperationsHealthSnapshotV1, type OperationsHealthSnapshotV1 } from "./health";
import { parseOperationsProductionTopologyV1, type OperationsProductionTopologyV1 } from "./topology";
import {
  OPERATIONS_RECOVERY_PHASE_IDS_V1,
  parseOperationsBackupManifestV1,
  parseOperationsRecoveryPlanV1,
  type OperationsBackupManifestV1,
  type OperationsRecoveryPhaseIdV1,
  type OperationsRecoveryPlanV1,
} from "./recovery";
import {
  buildOperationsFakeLifecycleReceiptV1,
  OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
  type OperationsFakeLifecycleOperationV1,
  type OperationsFakeLifecycleRecordV1,
  type SqliteOperationsFakeLifecycleLedgerV1,
} from "./fake-lifecycle-ledger";

export const OPERATIONS_FAKE_RECOVERY_CONTRACT_V1 = "control-room-operations-fake-recovery/v1" as const;
export const OPERATIONS_FAKE_RECOVERY_MODES_V1 = ["success", "missing_anchor", "overwrite_node_truth", "self_validation",
  "cleanup_failed", "uncertain_restore_marker"] as const;
export type OperationsFakeRecoveryModeV1 = (typeof OPERATIONS_FAKE_RECOVERY_MODES_V1)[number];

export interface OperationsCleanHostFixtureV1 {
  contractVersion: typeof OPERATIONS_FAKE_RECOVERY_CONTRACT_V1;
  fixtureId: string;
  targetIdentityDigest: string;
  fixtureClass: "empty_disposable_isolated_fake";
  existingDatabasePresent: false;
  existingApplicationStatePresent: false;
  existingObjectLocatorPresent: false;
  existingCredentialMaterialPresent: false;
  existingNetworkRoutePresent: false;
  productionIdentityPresent: false;
  containerRuntimePresent: false;
  nativeRestoreToolPresent: false;
  reusableAfterAttempt: false;
  observedAt: string;
  fixtureDigest: string;
}

export interface OperationsFakeRecoveryPhaseEvidenceV1 {
  contractVersion: typeof OPERATIONS_FAKE_RECOVERY_CONTRACT_V1;
  recoveryPlanDigest: string;
  phaseId: OperationsRecoveryPhaseIdV1;
  position: number;
  state: "pass" | "fail" | "uncertain";
  safeCode: string;
  evidenceDigest: string;
  nodeTruthOverwritten: false;
  externalAuditAnchorVerified: boolean;
  independentValidation: boolean;
  nativeActionAttempted: false;
  containsDatabaseBytes: false;
  containsWalBytes: false;
  grantsCutoverAuthority: false;
  grantsProductionReadiness: false;
  evidenceRecordDigest: string;
}

export interface OperationsFakeRecoveryCleanupEvidenceV1 {
  contractVersion: typeof OPERATIONS_FAKE_RECOVERY_CONTRACT_V1;
  recoveryPlanDigest: string;
  targetIdentityDigest: string;
  state: "cleaned" | "failed";
  safeCode: "synthetic_target_destroyed" | "synthetic_cleanup_failed";
  targetReusable: false;
  existingStateRetained: false;
  nativeCleanupAttempted: false;
  grantsCutoverAuthority: false;
  recordedAt: string;
  cleanupDigest: string;
}

export interface OperationsFakeRecoveryAttestationV1 {
  contractVersion: typeof OPERATIONS_FAKE_RECOVERY_CONTRACT_V1;
  recoveryPlanId: string;
  recoveryPlanDigest: string;
  backupDigest: string;
  targetIdentityDigest: string;
  topologyDigest: string;
  releaseDigest: string;
  phaseReceiptDigests: string[];
  healthSnapshotDigest: string;
  nodeJournalSetDigest: string;
  cleanupDigest: string;
  recoveryWorkerIdentityDigest: string;
  independentValidatorIdentityDigest: string;
  requestedRestorePointAt: string;
  incidentObservedAt: string;
  startedAt: string;
  completedAt: string;
  measuredRpoSeconds: number;
  measuredRtoSeconds: number;
  rpoObjectiveMet: boolean;
  rtoObjectiveMet: boolean;
  disposition: "recovery_candidate_only";
  allElevenPhasesVerified: true;
  nodeTruthPreserved: true;
  auditChainAndExternalAnchorVerified: true;
  cleanupVerified: true;
  independentValidationVerified: true;
  ownerCutoverWindowOpened: false;
  productionReadinessEstablished: false;
  cutoverAttempted: false;
  nativeActionAttempted: false;
  grantsApproval: false;
  grantsRestoreAuthority: false;
  grantsCutoverAuthority: false;
  grantsProductionReadiness: false;
  grantsExecutionAuthority: false;
  attestationDigest: string;
}

export interface OperationsFakeRecoveryProgressV1 {
  recoveryPlanId: string;
  state: "not_started" | "in_progress" | "cleanup_pending" | "attestation_pending" | "complete" | "failed" | "ambiguous";
  completedPhaseIds: OperationsRecoveryPhaseIdV1[];
  nextPhaseId?: OperationsRecoveryPhaseIdV1;
  blockingSafeCode?: string;
  targetConsumed: boolean;
  automaticRetryAllowed: false;
  cutoverAvailable: false;
}

export interface OperationsFakeRecoveryAdapterV1 {
  readonly kind: "in_memory_fake_no_io";
  performPhase(planDigest: string, phaseId: OperationsRecoveryPhaseIdV1): OperationsFakeRecoveryPhaseEvidenceV1;
  cleanup(planDigest: string, recordedAt: string): OperationsFakeRecoveryCleanupEvidenceV1;
}

type AdapterFixture = {
  plan: OperationsRecoveryPlanV1;
  backup: OperationsBackupManifestV1;
  topology: OperationsProductionTopologyV1;
  healthSnapshot: OperationsHealthSnapshotV1;
  cleanHost: OperationsCleanHostFixtureV1;
  recoveryWorkerIdentityDigest: string;
  independentValidatorIdentityDigest: string;
  nodeJournalHeadDigests: string[];
  mode: OperationsFakeRecoveryModeV1;
};

const cleanHostInputSchema = z.object({ fixtureId: id, targetIdentityDigest: digest, observedAt: time }).strict();
const cleanHostSchema = z.object({ contractVersion: z.literal(OPERATIONS_FAKE_RECOVERY_CONTRACT_V1), fixtureId: id,
  targetIdentityDigest: digest, fixtureClass: z.literal("empty_disposable_isolated_fake"), existingDatabasePresent: z.literal(false),
  existingApplicationStatePresent: z.literal(false), existingObjectLocatorPresent: z.literal(false),
  existingCredentialMaterialPresent: z.literal(false), existingNetworkRoutePresent: z.literal(false),
  productionIdentityPresent: z.literal(false), containerRuntimePresent: z.literal(false), nativeRestoreToolPresent: z.literal(false),
  reusableAfterAttempt: z.literal(false), observedAt: time, fixtureDigest: digest }).strict();
const adapterInputSchema = z.object({ plan: z.unknown(), backup: z.unknown(), topology: z.unknown(), healthSnapshot: z.unknown(),
  cleanHost: z.unknown(), recoveryWorkerIdentityDigest: digest, independentValidatorIdentityDigest: digest,
  nodeJournalHeadDigests: z.array(digest).min(1).max(32), mode: z.enum(OPERATIONS_FAKE_RECOVERY_MODES_V1) }).strict();
const phaseEvidenceSchema = z.object({ contractVersion: z.literal(OPERATIONS_FAKE_RECOVERY_CONTRACT_V1),
  recoveryPlanDigest: digest, phaseId: z.enum(OPERATIONS_RECOVERY_PHASE_IDS_V1), position: z.number().int().min(0).max(10),
  state: z.enum(["pass", "fail", "uncertain"]), safeCode: id, evidenceDigest: digest, nodeTruthOverwritten: z.literal(false),
  externalAuditAnchorVerified: z.boolean(), independentValidation: z.boolean(), nativeActionAttempted: z.literal(false),
  containsDatabaseBytes: z.literal(false), containsWalBytes: z.literal(false), grantsCutoverAuthority: z.literal(false),
  grantsProductionReadiness: z.literal(false), evidenceRecordDigest: digest }).strict();
const cleanupSchema = z.object({ contractVersion: z.literal(OPERATIONS_FAKE_RECOVERY_CONTRACT_V1), recoveryPlanDigest: digest,
  targetIdentityDigest: digest, state: z.enum(["cleaned", "failed"]),
  safeCode: z.enum(["synthetic_target_destroyed", "synthetic_cleanup_failed"]), targetReusable: z.literal(false),
  existingStateRetained: z.literal(false), nativeCleanupAttempted: z.literal(false), grantsCutoverAuthority: z.literal(false),
  recordedAt: time, cleanupDigest: digest }).strict();
const attestationSchema = z.object({ contractVersion: z.literal(OPERATIONS_FAKE_RECOVERY_CONTRACT_V1), recoveryPlanId: id,
  recoveryPlanDigest: digest, backupDigest: digest, targetIdentityDigest: digest, topologyDigest: digest, releaseDigest: digest,
  phaseReceiptDigests: z.array(digest).length(11), healthSnapshotDigest: digest, nodeJournalSetDigest: digest, cleanupDigest: digest,
  recoveryWorkerIdentityDigest: digest, independentValidatorIdentityDigest: digest, requestedRestorePointAt: time,
  incidentObservedAt: time, startedAt: time, completedAt: time, measuredRpoSeconds: z.number().int().min(0).max(604_800),
  measuredRtoSeconds: z.number().int().min(0).max(604_800), rpoObjectiveMet: z.boolean(), rtoObjectiveMet: z.boolean(),
  disposition: z.literal("recovery_candidate_only"), allElevenPhasesVerified: z.literal(true), nodeTruthPreserved: z.literal(true),
  auditChainAndExternalAnchorVerified: z.literal(true), cleanupVerified: z.literal(true),
  independentValidationVerified: z.literal(true), ownerCutoverWindowOpened: z.literal(false),
  productionReadinessEstablished: z.literal(false), cutoverAttempted: z.literal(false), nativeActionAttempted: z.literal(false),
  grantsApproval: z.literal(false), grantsRestoreAuthority: z.literal(false), grantsCutoverAuthority: z.literal(false),
  grantsProductionReadiness: z.literal(false), grantsExecutionAuthority: z.literal(false), attestationDigest: digest }).strict();

const trustedRecoveryAdapters = new WeakMap<object, AdapterFixture>();

function parseCleanHost(value: unknown): OperationsCleanHostFixtureV1 {
  const parsed = parseExactOperationsV1(cleanHostSchema, value, "operations clean-host fixture");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "fixtureDigest", parsed.fixtureDigest); return parsed;
}

export function buildOperationsCleanHostFixtureV1(inputValue: unknown): OperationsCleanHostFixtureV1 {
  const input = parseExactOperationsV1(cleanHostInputSchema, inputValue, "operations clean-host fixture input");
  const material: Omit<OperationsCleanHostFixtureV1, "fixtureDigest"> = {
    contractVersion: OPERATIONS_FAKE_RECOVERY_CONTRACT_V1, fixtureId: input.fixtureId,
    targetIdentityDigest: input.targetIdentityDigest, fixtureClass: "empty_disposable_isolated_fake",
    existingDatabasePresent: false, existingApplicationStatePresent: false, existingObjectLocatorPresent: false,
    existingCredentialMaterialPresent: false, existingNetworkRoutePresent: false, productionIdentityPresent: false,
    containerRuntimePresent: false, nativeRestoreToolPresent: false, reusableAfterAttempt: false, observedAt: input.observedAt,
  };
  return parseCleanHost({ ...material, fixtureDigest: sha256Digest(material) });
}

function buildPhaseEvidence(fixture: AdapterFixture, phaseId: OperationsRecoveryPhaseIdV1,
  state: "pass" | "fail" | "uncertain", safeCode: string, overrides: {
    nodeTruthOverwritten?: false; externalAuditAnchorVerified?: boolean; independentValidation?: boolean } = {}): OperationsFakeRecoveryPhaseEvidenceV1 {
  const position = OPERATIONS_RECOVERY_PHASE_IDS_V1.indexOf(phaseId);
  const evidenceDigest = sha256Digest({ fakeRecovery: fixture.plan.recoveryPlanDigest, phaseId, state, safeCode,
    cleanHostDigest: fixture.cleanHost.fixtureDigest, backupDigest: fixture.backup.backupDigest,
    healthSnapshotDigest: fixture.healthSnapshot.snapshotDigest, nodeJournalHeadDigests: fixture.nodeJournalHeadDigests });
  const material: Omit<OperationsFakeRecoveryPhaseEvidenceV1, "evidenceRecordDigest"> = {
    contractVersion: OPERATIONS_FAKE_RECOVERY_CONTRACT_V1, recoveryPlanDigest: fixture.plan.recoveryPlanDigest,
    phaseId, position, state, safeCode, evidenceDigest, nodeTruthOverwritten: overrides.nodeTruthOverwritten ?? false,
    externalAuditAnchorVerified: overrides.externalAuditAnchorVerified ?? (position >= 7),
    independentValidation: overrides.independentValidation ?? (position >= 9), nativeActionAttempted: false,
    containsDatabaseBytes: false, containsWalBytes: false, grantsCutoverAuthority: false, grantsProductionReadiness: false,
  };
  const result = parseExactOperationsV1(phaseEvidenceSchema, { ...material, evidenceRecordDigest: sha256Digest(material) },
    "operations fake recovery phase evidence");
  verifyOperationsDigestV1(result as unknown as Record<string, unknown>, "evidenceRecordDigest", result.evidenceRecordDigest);
  return result;
}

export function createOperationsFakeRecoveryAdapterV1(inputValue: unknown): OperationsFakeRecoveryAdapterV1 {
  const input = parseExactOperationsV1(adapterInputSchema, inputValue, "operations fake recovery adapter input"),
    plan = parseOperationsRecoveryPlanV1(input.plan), backup = parseOperationsBackupManifestV1(input.backup),
    topology = parseOperationsProductionTopologyV1(input.topology), healthSnapshot = parseOperationsHealthSnapshotV1(input.healthSnapshot),
    cleanHost = parseCleanHost(input.cleanHost), servicePrincipals = new Set(topology.services.map((service) => service.principalIdentityDigest));
  if (plan.topologyDigest !== topology.topologyDigest || plan.releaseDigest !== backup.releaseDigest || plan.backupDigest !== backup.backupDigest
    || plan.targetIdentityDigest !== cleanHost.targetIdentityDigest || healthSnapshot.topologyDigest !== topology.topologyDigest
    || healthSnapshot.overallReadiness !== "ready_candidate" || servicePrincipals.has(input.recoveryWorkerIdentityDigest)
    || servicePrincipals.has(input.independentValidatorIdentityDigest) || input.recoveryWorkerIdentityDigest === input.independentValidatorIdentityDigest
    || new Set(input.nodeJournalHeadDigests).size !== input.nodeJournalHeadDigests.length) throw new OperationsContractErrorV1("scope_mismatch");
  const fixture: AdapterFixture = { plan, backup, topology, healthSnapshot, cleanHost,
    recoveryWorkerIdentityDigest: input.recoveryWorkerIdentityDigest,
    independentValidatorIdentityDigest: input.independentValidatorIdentityDigest,
    nodeJournalHeadDigests: [...input.nodeJournalHeadDigests], mode: input.mode };
  const adapter: OperationsFakeRecoveryAdapterV1 = { kind: "in_memory_fake_no_io", performPhase(planDigest, phaseId) {
    const trusted = trustedRecoveryAdapters.get(adapter);
    if (!trusted || planDigest !== trusted.plan.recoveryPlanDigest || !OPERATIONS_RECOVERY_PHASE_IDS_V1.includes(phaseId)) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
    if (trusted.mode === "uncertain_restore_marker" && phaseId === "restore_base_backup") {
      return buildPhaseEvidence(trusted, phaseId, "uncertain", "synthetic_restore_outcome_unknown_after_marker");
    }
    if (trusted.mode === "missing_anchor" && phaseId === "verify_audit_chain_and_anchor") {
      return buildPhaseEvidence(trusted, phaseId, "fail", "external_audit_anchor_missing", { externalAuditAnchorVerified: false });
    }
    if (trusted.mode === "overwrite_node_truth" && phaseId === "reconcile_node_journals") {
      return buildPhaseEvidence(trusted, phaseId, "fail", "node_truth_overwrite_refused", { nodeTruthOverwritten: false });
    }
    if (trusted.mode === "self_validation" && phaseId === "run_independent_health_validation") {
      return buildPhaseEvidence(trusted, phaseId, "fail", "self_validation_refused", { independentValidation: false });
    }
    const safeCode = phaseId === "request_owner_cutover_window" ? "owner_gate_remains_closed" : "synthetic_phase_verified";
    return buildPhaseEvidence(trusted, phaseId, "pass", safeCode);
  }, cleanup(planDigest, recordedAt) {
    const trusted = trustedRecoveryAdapters.get(adapter);
    if (!trusted || planDigest !== trusted.plan.recoveryPlanDigest) throw new OperationsContractErrorV1("scope_mismatch");
    const state = trusted.mode === "cleanup_failed" ? "failed" as const : "cleaned" as const;
    const material: Omit<OperationsFakeRecoveryCleanupEvidenceV1, "cleanupDigest"> = {
      contractVersion: OPERATIONS_FAKE_RECOVERY_CONTRACT_V1, recoveryPlanDigest: trusted.plan.recoveryPlanDigest,
      targetIdentityDigest: trusted.plan.targetIdentityDigest, state,
      safeCode: state === "cleaned" ? "synthetic_target_destroyed" : "synthetic_cleanup_failed",
      targetReusable: false, existingStateRetained: false, nativeCleanupAttempted: false, grantsCutoverAuthority: false, recordedAt,
    };
    const result = parseExactOperationsV1(cleanupSchema, { ...material, cleanupDigest: sha256Digest(material) },
      "operations fake recovery cleanup evidence");
    verifyOperationsDigestV1(result as unknown as Record<string, unknown>, "cleanupDigest", result.cleanupDigest); return result;
  } };
  trustedRecoveryAdapters.set(adapter, fixture); return Object.freeze(adapter);
}

function phaseOperation(plan: OperationsRecoveryPlanV1, phaseId: OperationsRecoveryPhaseIdV1): OperationsFakeLifecycleOperationV1 {
  const position = OPERATIONS_RECOVERY_PHASE_IDS_V1.indexOf(phaseId), phase = plan.phases[position]!;
  return { contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
    operationId: `${plan.recoveryPlanId}:phase:${position}`, operationDigest: sha256Digest({ recoveryPlanDigest: plan.recoveryPlanDigest,
      phaseId, position, phaseDigest: phase.phaseDigest }), kind: "recovery_phase", parentOperationId: plan.recoveryPlanId,
    position, markerRequired: phase.effectClass === "isolated_restore", authorizedAt: plan.plannedAt, expiresAt: plan.expiresAt,
    grantsApproval: false, grantsExecutionAuthority: false };
}

export class OperationsFakeRecoveryCoordinatorV1 {
  readonly #plan: OperationsRecoveryPlanV1;
  readonly #backup: OperationsBackupManifestV1;
  readonly #topology: OperationsProductionTopologyV1;
  readonly #fixture: AdapterFixture;
  constructor(private readonly input: { plan: OperationsRecoveryPlanV1; backup: OperationsBackupManifestV1;
    topology: OperationsProductionTopologyV1; adapter: OperationsFakeRecoveryAdapterV1;
    ledger: SqliteOperationsFakeLifecycleLedgerV1; incidentObservedAt: string; startedAt: string }) {
    this.#plan = parseOperationsRecoveryPlanV1(input.plan); this.#backup = parseOperationsBackupManifestV1(input.backup);
    this.#topology = parseOperationsProductionTopologyV1(input.topology);
    const fixture = trustedRecoveryAdapters.get(input.adapter);
    if (!fixture || fixture.plan.recoveryPlanDigest !== this.#plan.recoveryPlanDigest
      || fixture.backup.backupDigest !== this.#backup.backupDigest || fixture.topology.topologyDigest !== this.#topology.topologyDigest
      || !Number.isFinite(Date.parse(input.incidentObservedAt)) || !Number.isFinite(Date.parse(input.startedAt))
      || Date.parse(input.incidentObservedAt) < Date.parse(this.#plan.requestedRestorePointAt)
      || Date.parse(input.startedAt) < Date.parse(this.#plan.plannedAt) || Date.parse(input.startedAt) >= Date.parse(this.#plan.expiresAt)) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
    this.#fixture = fixture;
  }

  initialize(claimedAt: string, settledAt: string): OperationsFakeLifecycleRecordV1 {
    const operation: OperationsFakeLifecycleOperationV1 = { contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
      operationId: `${this.#plan.recoveryPlanId}:target`, operationDigest: sha256Digest({ recoveryPlanDigest: this.#plan.recoveryPlanDigest,
        targetIdentityDigest: this.#plan.targetIdentityDigest, cleanHostDigest: this.#fixture.cleanHost.fixtureDigest }),
      kind: "recovery_target_claim", parentOperationId: this.#plan.recoveryPlanId,
      targetIdentityDigest: this.#plan.targetIdentityDigest, markerRequired: false, authorizedAt: this.#plan.plannedAt,
      expiresAt: this.#plan.expiresAt, grantsApproval: false, grantsExecutionAuthority: false };
    this.input.ledger.authorize(operation);
    for (const phaseId of OPERATIONS_RECOVERY_PHASE_IDS_V1) this.input.ledger.authorize(phaseOperation(this.#plan, phaseId));
    const claimed = this.input.ledger.claim(operation.operationId, claimedAt);
    if (claimed.disposition !== "dispatch") return claimed.record;
    const receipt = buildOperationsFakeLifecycleReceiptV1({ operationId: operation.operationId,
      operationDigest: operation.operationDigest, state: "succeeded", safeCode: "disposable_target_consumed_once",
      evidenceDigest: this.#fixture.cleanHost.fixtureDigest, recordedAt: settledAt });
    return this.input.ledger.settle(operation.operationId, receipt);
  }

  advance(phaseId: OperationsRecoveryPhaseIdV1, claimedAt: string, markerAt: string, settledAt: string): OperationsFakeRecoveryProgressV1 {
    const before = this.progress();
    if (before.state === "failed" || before.state === "ambiguous" || before.state === "complete") return before;
    if (!before.targetConsumed) throw new OperationsContractErrorV1("invalid_transition");
    if (before.nextPhaseId !== phaseId) throw new OperationsContractErrorV1("invalid_transition");
    const operation = phaseOperation(this.#plan, phaseId); this.input.ledger.authorize(operation);
    const claim = this.input.ledger.claim(operation.operationId, claimedAt);
    if (claim.disposition === "terminal") return this.progress();
    if (claim.disposition === "in_progress") return this.progress();
    if (operation.markerRequired) this.input.ledger.recordMarker(operation.operationId,
      sha256Digest({ recoveryPlanDigest: this.#plan.recoveryPlanDigest, phaseId, state: "synthetic_pre_effect_marker" }), markerAt);
    const evidence = this.input.adapter.performPhase(this.#plan.recoveryPlanDigest, phaseId);
    if (evidence.state === "uncertain") return this.progress();
    const receipt = buildOperationsFakeLifecycleReceiptV1({ operationId: operation.operationId,
      operationDigest: operation.operationDigest, state: evidence.state === "pass" ? "succeeded" : "failed",
      safeCode: evidence.safeCode, evidenceDigest: evidence.evidenceRecordDigest, recordedAt: settledAt });
    this.input.ledger.settle(operation.operationId, receipt); return this.progress();
  }

  cleanup(claimedAt: string, markerAt: string, settledAt: string): OperationsFakeRecoveryProgressV1 {
    const before = this.progress();
    if (before.state !== "cleanup_pending") throw new OperationsContractErrorV1("invalid_transition");
    const operation: OperationsFakeLifecycleOperationV1 = { contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
      operationId: `${this.#plan.recoveryPlanId}:cleanup`, operationDigest: sha256Digest({
        recoveryPlanDigest: this.#plan.recoveryPlanDigest, targetIdentityDigest: this.#plan.targetIdentityDigest,
        phaseReceiptDigests: this.phaseRecords().map((record) => record.receipt!.receiptDigest) }),
      kind: "recovery_cleanup", parentOperationId: this.#plan.recoveryPlanId, position: 11,
      targetIdentityDigest: this.#plan.targetIdentityDigest, markerRequired: true, authorizedAt: claimedAt,
      expiresAt: this.#plan.expiresAt, grantsApproval: false, grantsExecutionAuthority: false };
    this.input.ledger.authorize(operation); const claim = this.input.ledger.claim(operation.operationId, claimedAt);
    if (claim.disposition !== "dispatch") return this.progress();
    this.input.ledger.recordMarker(operation.operationId, sha256Digest({ recoveryPlanDigest: this.#plan.recoveryPlanDigest,
      targetIdentityDigest: this.#plan.targetIdentityDigest, state: "synthetic_cleanup_marker" }), markerAt);
    const evidence = this.input.adapter.cleanup(this.#plan.recoveryPlanDigest, settledAt);
    const receipt = buildOperationsFakeLifecycleReceiptV1({ operationId: operation.operationId,
      operationDigest: operation.operationDigest, state: evidence.state === "cleaned" ? "succeeded" : "failed",
      safeCode: evidence.safeCode, evidenceDigest: evidence.cleanupDigest, recordedAt: settledAt });
    this.input.ledger.settle(operation.operationId, receipt); return this.progress();
  }

  attest(claimedAt: string, completedAt: string): OperationsFakeRecoveryAttestationV1 {
    if (this.progress().state !== "attestation_pending") throw new OperationsContractErrorV1("invalid_transition");
    const phaseRecords = this.phaseRecords(), cleanup = this.input.ledger.requireRecord(`${this.#plan.recoveryPlanId}:cleanup`);
    const measuredRpoSeconds = Math.floor((Date.parse(this.input.incidentObservedAt) - Date.parse(this.#plan.requestedRestorePointAt)) / 1000),
      measuredRtoSeconds = Math.floor((Date.parse(completedAt) - Date.parse(this.input.startedAt)) / 1000);
    if (measuredRpoSeconds < 0 || measuredRtoSeconds < 0) throw new OperationsContractErrorV1("scope_mismatch");
    const material: Omit<OperationsFakeRecoveryAttestationV1, "attestationDigest"> = {
      contractVersion: OPERATIONS_FAKE_RECOVERY_CONTRACT_V1, recoveryPlanId: this.#plan.recoveryPlanId,
      recoveryPlanDigest: this.#plan.recoveryPlanDigest, backupDigest: this.#backup.backupDigest,
      targetIdentityDigest: this.#plan.targetIdentityDigest, topologyDigest: this.#topology.topologyDigest,
      releaseDigest: this.#plan.releaseDigest, phaseReceiptDigests: phaseRecords.map((record) => record.receipt!.receiptDigest),
      healthSnapshotDigest: this.#fixture.healthSnapshot.snapshotDigest,
      nodeJournalSetDigest: sha256Digest({ nodeJournalHeadDigests: this.#fixture.nodeJournalHeadDigests }),
      cleanupDigest: cleanup.receipt!.evidenceDigest!, recoveryWorkerIdentityDigest: this.#fixture.recoveryWorkerIdentityDigest,
      independentValidatorIdentityDigest: this.#fixture.independentValidatorIdentityDigest,
      requestedRestorePointAt: this.#plan.requestedRestorePointAt, incidentObservedAt: this.input.incidentObservedAt,
      startedAt: this.input.startedAt, completedAt, measuredRpoSeconds, measuredRtoSeconds,
      rpoObjectiveMet: measuredRpoSeconds <= this.#plan.targetRpoSeconds,
      rtoObjectiveMet: measuredRtoSeconds <= this.#plan.targetRtoSeconds, disposition: "recovery_candidate_only",
      allElevenPhasesVerified: true, nodeTruthPreserved: true, auditChainAndExternalAnchorVerified: true,
      cleanupVerified: true, independentValidationVerified: true, ownerCutoverWindowOpened: false,
      productionReadinessEstablished: false, cutoverAttempted: false, nativeActionAttempted: false,
      grantsApproval: false, grantsRestoreAuthority: false, grantsCutoverAuthority: false,
      grantsProductionReadiness: false, grantsExecutionAuthority: false,
    };
    const attestation = parseExactOperationsV1(attestationSchema, { ...material, attestationDigest: sha256Digest(material) },
      "operations fake recovery attestation");
    verifyOperationsDigestV1(attestation as unknown as Record<string, unknown>, "attestationDigest", attestation.attestationDigest);
    const operation: OperationsFakeLifecycleOperationV1 = { contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
      operationId: `${this.#plan.recoveryPlanId}:attestation`, operationDigest: attestation.attestationDigest,
      kind: "recovery_attestation", parentOperationId: this.#plan.recoveryPlanId, position: 12, markerRequired: false,
      authorizedAt: claimedAt, expiresAt: this.#plan.expiresAt, grantsApproval: false, grantsExecutionAuthority: false };
    this.input.ledger.authorize(operation); const claim = this.input.ledger.claim(operation.operationId, claimedAt);
    if (claim.disposition === "dispatch") this.input.ledger.settle(operation.operationId, buildOperationsFakeLifecycleReceiptV1({
      operationId: operation.operationId, operationDigest: operation.operationDigest, state: "succeeded",
      safeCode: "independent_recovery_candidate_attested", evidenceDigest: attestation.attestationDigest, recordedAt: completedAt }));
    return attestation;
  }

  progress(): OperationsFakeRecoveryProgressV1 {
    let targetConsumed = false;
    try { targetConsumed = this.input.ledger.requireRecord(`${this.#plan.recoveryPlanId}:target`).state === "succeeded"; } catch { /* not initialized */ }
    const records = this.phaseRecords(false), completed = records.filter((record) => record.state === "succeeded")
      .map((record) => this.#plan.phases[record.operation.position!]!.phaseId);
    const terminal = records.find((record) => record.state === "failed" || record.state === "failed_before_marker" || record.state === "ambiguous");
    if (terminal) return { recoveryPlanId: this.#plan.recoveryPlanId, state: terminal.state === "ambiguous" ? "ambiguous" : "failed",
      completedPhaseIds: completed, blockingSafeCode: terminal.receipt?.safeCode, targetConsumed, automaticRetryAllowed: false, cutoverAvailable: false };
    if (completed.length < 11) return { recoveryPlanId: this.#plan.recoveryPlanId,
      state: targetConsumed ? "in_progress" : "not_started", completedPhaseIds: completed,
      nextPhaseId: OPERATIONS_RECOVERY_PHASE_IDS_V1[completed.length], targetConsumed, automaticRetryAllowed: false, cutoverAvailable: false };
    let cleanup: OperationsFakeLifecycleRecordV1 | undefined, attestation: OperationsFakeLifecycleRecordV1 | undefined;
    try { cleanup = this.input.ledger.requireRecord(`${this.#plan.recoveryPlanId}:cleanup`); } catch { /* pending */ }
    if (!cleanup) return { recoveryPlanId: this.#plan.recoveryPlanId, state: "cleanup_pending", completedPhaseIds: completed,
      targetConsumed, automaticRetryAllowed: false, cutoverAvailable: false };
    if (cleanup.state === "ambiguous" || cleanup.state === "failed" || cleanup.state === "failed_before_marker") {
      return { recoveryPlanId: this.#plan.recoveryPlanId, state: cleanup.state === "ambiguous" ? "ambiguous" : "failed",
        completedPhaseIds: completed, blockingSafeCode: cleanup.receipt?.safeCode, targetConsumed,
        automaticRetryAllowed: false, cutoverAvailable: false };
    }
    if (cleanup.state !== "succeeded") return { recoveryPlanId: this.#plan.recoveryPlanId, state: "in_progress",
      completedPhaseIds: completed, targetConsumed, automaticRetryAllowed: false, cutoverAvailable: false };
    try { attestation = this.input.ledger.requireRecord(`${this.#plan.recoveryPlanId}:attestation`); } catch { /* pending */ }
    return { recoveryPlanId: this.#plan.recoveryPlanId, state: attestation?.state === "succeeded" ? "complete" : "attestation_pending",
      completedPhaseIds: completed, targetConsumed, automaticRetryAllowed: false, cutoverAvailable: false };
  }

  private phaseRecords(requireAll = true): OperationsFakeLifecycleRecordV1[] {
    const records = this.input.ledger.list(this.#plan.recoveryPlanId).filter((record) => record.operation.kind === "recovery_phase")
      .sort((left, right) => left.operation.position! - right.operation.position!);
    if (requireAll && (records.length !== 11 || records.some((record, position) => record.operation.position !== position || record.state !== "succeeded"))) {
      throw new OperationsContractErrorV1("evidence_missing");
    }
    return records;
  }
}

export const operationsFakeRecoverySchemasV1 = { cleanHost: cleanHostSchema, phaseEvidence: phaseEvidenceSchema,
  cleanup: cleanupSchema, attestation: attestationSchema } as const;
