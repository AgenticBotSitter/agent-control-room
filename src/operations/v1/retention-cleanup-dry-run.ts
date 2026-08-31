import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { exactProjectWorkspaceJsonV1 } from "../../project-workspace/v1/exact";
import {
  hmacSha256Tag,
  ROLLBACK_CHECKPOINT_SCHEMA_V1,
  rollbackCheckpointDigestV1,
  sha256Digest,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security";
import { dataMethodV1, exactHostDataSnapshotV1, exactHostUint8ArrayV1 } from "../../security/host-value";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import {
  assessOperationsDataDispositionV1,
  buildOperationsDataDispositionProposalV1,
  parseOperationsDataClassRegistryV1,
  parseOperationsDataDispositionAssessmentV1,
  parseOperationsDataDispositionProposalV1,
  parseOperationsDataDispositionRequestV1,
  parseOperationsLegalHoldReleaseEvidenceV1,
  parseOperationsLegalHoldV1,
  parseOperationsPrivacyRetentionPolicyV1,
  parseOperationsRetentionEvidenceV1,
  type OperationsDataClassIdV1,
  type OperationsDataDispositionCandidateActionV1,
} from "./privacy-retention";

export const OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1 = "control-room-operations-retention-cleanup-dry-run/v1" as const;
export const OPERATIONS_RETENTION_CLEANUP_STEP_IDS_V1 = [
  "verify_exact_candidate",
  "verify_current_policy",
  "verify_bounded_inventory",
  "verify_legal_hold_clearance",
  "verify_dependency_horizons",
  "verify_active_reference_absence",
  "prepare_tombstone_or_source_record",
  "request_fresh_owner_decision",
  "acquire_protected_effect_claim",
  "record_pre_effect_marker",
  "verify_independent_terminal_receipt",
  "reconcile_cleanup_and_audit",
] as const;
export type OperationsRetentionCleanupStepIdV1 = (typeof OPERATIONS_RETENTION_CLEANUP_STEP_IDS_V1)[number];
export type OperationsRetentionCleanupActionV1 = "delete_body" | "replace_with_digest_tombstone" |
  "reconcile_source_authority" | "record_quarantine_candidate";
export type OperationsRetentionCleanupTombstoneModeV1 = "pending_deletion_tombstone" |
  "atomic_digest_tombstone_replacement" | "source_authoritative_evidence" | "immutable_quarantine_evidence";

export interface OperationsRetentionCleanupStepV1 {
  stepId: OperationsRetentionCleanupStepIdV1;
  position: number;
  kind: "evidence_check" | "record_preparation" | "owner_gate" | "effect_gate" | "verification" | "reconciliation";
  safeInstructionCode: string;
  requiresPreviousStep: boolean;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  stepDigest: string;
}

export interface OperationsRetentionCleanupDryRunPlanV1 {
  contractVersion: typeof OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1;
  planId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  scopeDigest: string;
  registryDigest: string;
  policyDigest: string;
  requestDigest: string;
  assessmentDigest: string;
  proposalDigest: string;
  dataClassId: OperationsDataClassIdV1;
  recordSetDigest: string;
  candidateAction: OperationsDataDispositionCandidateActionV1;
  cleanupAction: OperationsRetentionCleanupActionV1;
  tombstoneMode: OperationsRetentionCleanupTombstoneModeV1;
  steps: OperationsRetentionCleanupStepV1[];
  maximumInventoryItems: 100_000;
  maximumInventoryBytes: number;
  requiresCurrentPolicy: true;
  requiresFreshInventory: true;
  requiresLegalHoldClearance: true;
  requiresCompleteDependencyHorizons: true;
  requiresActiveReferenceAbsence: true;
  requiresFreshOwnerDecision: true;
  requiresProtectedEffectClaim: true;
  requiresPreEffectMarker: true;
  requiresIndependentTerminalReceipt: true;
  requiresAuditAppend: true;
  automaticRetryAllowed: false;
  unknownAfterMarker: "terminal_ambiguity";
  dryRunOnly: true;
  commandLines: [];
  rawMaterialPresent: false;
  locatorPresent: false;
  credentialReferencePresent: false;
  nativeExecutorPresent: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  expiresAt: string;
  planDigest: string;
}

const cleanupAction = z.enum(["delete_body", "replace_with_digest_tombstone", "reconcile_source_authority",
  "record_quarantine_candidate"]), tombstoneMode = z.enum(["pending_deletion_tombstone",
  "atomic_digest_tombstone_replacement", "source_authoritative_evidence", "immutable_quarantine_evidence"]),
  candidateAction = z.enum(["delete_candidate", "compact_to_digest_tombstone_candidate", "source_reconciliation_candidate",
    "quarantine_candidate"]), dataClassId = z.enum([
    "data-class:operations:scope-identity", "data-class:operations:source-projection",
    "data-class:operations:work-lifecycle", "data-class:operations:approval-authority",
    "data-class:operations:audit-security", "data-class:operations:effect-replay",
    "data-class:operations:credential-reference", "data-class:operations:observability",
    "data-class:operations:artifact-metadata", "data-class:operations:private-artifact-body",
    "data-class:operations:public-artifact-body", "data-class:operations:transient-transport-body",
    "data-class:operations:backup-recovery-material", "data-class:operations:quarantine-evidence",
  ]);
const stepId = z.enum(OPERATIONS_RETENTION_CLEANUP_STEP_IDS_V1);
const stepSchema = z.object({ stepId, position: z.number().int().min(0).max(11),
  kind: z.enum(["evidence_check", "record_preparation", "owner_gate", "effect_gate", "verification", "reconciliation"]),
  safeInstructionCode: id, requiresPreviousStep: z.boolean(), performsAction: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), stepDigest: digest }).strict();
const planSchema = z.object({ contractVersion: z.literal(OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1), planId: id,
  tenantId: id, workspaceId: id, projectId: id, scopeDigest: digest, registryDigest: digest, policyDigest: digest,
  requestDigest: digest, assessmentDigest: digest, proposalDigest: digest, dataClassId, recordSetDigest: digest,
  candidateAction, cleanupAction, tombstoneMode, steps: z.array(stepSchema).length(12), maximumInventoryItems: z.literal(100_000),
  maximumInventoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), requiresCurrentPolicy: z.literal(true),
  requiresFreshInventory: z.literal(true), requiresLegalHoldClearance: z.literal(true),
  requiresCompleteDependencyHorizons: z.literal(true), requiresActiveReferenceAbsence: z.literal(true),
  requiresFreshOwnerDecision: z.literal(true), requiresProtectedEffectClaim: z.literal(true),
  requiresPreEffectMarker: z.literal(true), requiresIndependentTerminalReceipt: z.literal(true),
  requiresAuditAppend: z.literal(true), automaticRetryAllowed: z.literal(false), unknownAfterMarker: z.literal("terminal_ambiguity"),
  dryRunOnly: z.literal(true), commandLines: z.tuple([]), rawMaterialPresent: z.literal(false), locatorPresent: z.literal(false),
  credentialReferencePresent: z.literal(false), nativeExecutorPresent: z.literal(false), performsAction: z.literal(false),
  grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  createdAt: time, expiresAt: time, planDigest: digest }).strict();

const actionMap: Record<OperationsDataDispositionCandidateActionV1, { cleanupAction: OperationsRetentionCleanupActionV1;
  tombstoneMode: OperationsRetentionCleanupTombstoneModeV1 }> = {
  delete_candidate: { cleanupAction: "delete_body", tombstoneMode: "pending_deletion_tombstone" },
  compact_to_digest_tombstone_candidate: { cleanupAction: "replace_with_digest_tombstone",
    tombstoneMode: "atomic_digest_tombstone_replacement" },
  source_reconciliation_candidate: { cleanupAction: "reconcile_source_authority",
    tombstoneMode: "source_authoritative_evidence" },
  quarantine_candidate: { cleanupAction: "record_quarantine_candidate", tombstoneMode: "immutable_quarantine_evidence" },
};
const stepKinds = ["evidence_check", "evidence_check", "evidence_check", "evidence_check", "evidence_check", "evidence_check",
  "record_preparation", "owner_gate", "effect_gate", "effect_gate", "verification", "reconciliation"] as const;
const stepCodes = ["rederive_candidate_from_exact_primary_evidence", "require_current_revisioned_project_policy",
  "require_fresh_bounded_digest_only_inventory", "require_external_legal_hold_clearance_evidence",
  "require_every_dependency_horizon_known", "require_independent_active_reference_absence",
  "prepare_non_authorizing_tombstone_or_source_evidence", "require_fresh_external_owner_decision",
  "require_one_use_protected_effect_claim", "require_durable_marker_before_any_effect",
  "require_independent_terminal_and_postcondition_receipts", "append_audit_and_reconcile_without_retry"] as const;

function fixedSteps(): OperationsRetentionCleanupStepV1[] {
  return OPERATIONS_RETENTION_CLEANUP_STEP_IDS_V1.map((currentStepId, position) => {
    const material: Omit<OperationsRetentionCleanupStepV1, "stepDigest"> = { stepId: currentStepId, position,
      kind: stepKinds[position]!, safeInstructionCode: stepCodes[position]!, requiresPreviousStep: position > 0,
      performsAction: false, grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
    return { ...material, stepDigest: sha256Digest(material) };
  });
}

const trustedPlans = new WeakSet<object>();

export function buildOperationsRetentionCleanupDryRunPlanV1(inputValue: unknown): OperationsRetentionCleanupDryRunPlanV1 {
  const input = parseExactOperationsV1(z.object({ registry: z.unknown(), policy: z.unknown(), request: z.unknown(),
    evidence: z.unknown(), holds: z.array(z.unknown()).max(32), releases: z.array(z.unknown()).max(32),
    assessment: z.unknown(), proposal: z.unknown(), createdAt: time, expiresAt: time }).strict(), inputValue,
  "operations retention cleanup dry-run plan input"), registry = parseOperationsDataClassRegistryV1(input.registry),
    policy = parseOperationsPrivacyRetentionPolicyV1(input.policy, registry), request = parseOperationsDataDispositionRequestV1(input.request),
    evidence = parseOperationsRetentionEvidenceV1(input.evidence), holds = input.holds.map(parseOperationsLegalHoldV1),
    releases = input.releases.map(parseOperationsLegalHoldReleaseEvidenceV1),
    assessment = parseOperationsDataDispositionAssessmentV1(input.assessment),
    canonicalAssessment = assessOperationsDataDispositionV1({ registry, policy, request, evidence, holds, releases }),
    proposal = parseOperationsDataDispositionProposalV1(input.proposal), canonicalProposal = buildOperationsDataDispositionProposalV1(canonicalAssessment);
  if (assessment.assessmentDigest !== canonicalAssessment.assessmentDigest || proposal.proposalDigest !== canonicalProposal.proposalDigest
    || Date.parse(input.createdAt) < Date.parse(assessment.assessedAt) || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)
    || Date.parse(input.expiresAt) > Date.parse(input.createdAt) + 15 * 60_000) throw new OperationsContractErrorV1("scope_mismatch");
  const mapping = actionMap[proposal.candidateAction], planBasis = sha256Digest({ policyDigest: policy.policyDigest,
    requestDigest: request.requestDigest, assessmentDigest: assessment.assessmentDigest, proposalDigest: proposal.proposalDigest,
    cleanupAction: mapping.cleanupAction, recordSetDigest: request.recordSetDigest }),
    material: Omit<OperationsRetentionCleanupDryRunPlanV1, "planDigest"> = {
      contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1,
      planId: `plan:operations:retention-cleanup:${planBasis.slice(7, 31)}`, tenantId: policy.tenantId,
      workspaceId: policy.workspaceId, projectId: policy.projectId,
      scopeDigest: sha256Digest({ tenantId: policy.tenantId, workspaceId: policy.workspaceId, projectId: policy.projectId }),
      registryDigest: registry.registryDigest, policyDigest: policy.policyDigest, requestDigest: request.requestDigest,
      assessmentDigest: assessment.assessmentDigest, proposalDigest: proposal.proposalDigest, dataClassId: request.dataClassId,
      recordSetDigest: request.recordSetDigest, candidateAction: proposal.candidateAction,
      cleanupAction: mapping.cleanupAction, tombstoneMode: mapping.tombstoneMode, steps: fixedSteps(),
      maximumInventoryItems: 100_000, maximumInventoryBytes: 1_099_511_627_776,
      requiresCurrentPolicy: true, requiresFreshInventory: true, requiresLegalHoldClearance: true,
      requiresCompleteDependencyHorizons: true, requiresActiveReferenceAbsence: true, requiresFreshOwnerDecision: true,
      requiresProtectedEffectClaim: true, requiresPreEffectMarker: true, requiresIndependentTerminalReceipt: true,
      requiresAuditAppend: true, automaticRetryAllowed: false, unknownAfterMarker: "terminal_ambiguity", dryRunOnly: true,
      commandLines: [], rawMaterialPresent: false, locatorPresent: false, credentialReferencePresent: false,
      nativeExecutorPresent: false, performsAction: false, grantsApproval: false, grantsDeletionAuthority: false,
      grantsExecutionAuthority: false, createdAt: input.createdAt, expiresAt: input.expiresAt };
  const plan = parseOperationsRetentionCleanupDryRunPlanV1({ ...material, planDigest: sha256Digest(material) });
  trustedPlans.add(plan as object); return plan;
}

export function parseOperationsRetentionCleanupDryRunPlanV1(value: unknown): OperationsRetentionCleanupDryRunPlanV1 {
  const parsed = parseExactOperationsV1(planSchema, value, "operations retention cleanup dry-run plan"),
    expected = actionMap[parsed.candidateAction], expectedPlanBasis = sha256Digest({ policyDigest: parsed.policyDigest,
      requestDigest: parsed.requestDigest, assessmentDigest: parsed.assessmentDigest, proposalDigest: parsed.proposalDigest,
      cleanupAction: parsed.cleanupAction, recordSetDigest: parsed.recordSetDigest });
  if (parsed.cleanupAction !== expected.cleanupAction || parsed.tombstoneMode !== expected.tombstoneMode
    || parsed.planId !== `plan:operations:retention-cleanup:${expectedPlanBasis.slice(7, 31)}`
    || parsed.steps.map((item) => item.stepId).join("|") !== OPERATIONS_RETENTION_CLEANUP_STEP_IDS_V1.join("|")
    || parsed.steps.some((step, position) => JSON.stringify(step) !== JSON.stringify(fixedSteps()[position]))
    || Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)
    || Date.parse(parsed.expiresAt) > Date.parse(parsed.createdAt) + 15 * 60_000) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "planDigest", parsed.planDigest); return parsed;
}

export interface OperationsRetentionFakeInventoryAdapterV1 {
  contractVersion: typeof OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1;
  adapterId: string;
  testOnly: true;
}
interface FakeInventoryFixture {
  recordSetDigest: string;
  itemCount: number;
  totalBytes: number;
  activeReferenceCount: number;
  legalHoldCount: number;
  existingTombstoneCount: number;
  existingQuarantineCount: number;
  inventoryEvidenceDigest: string;
  referenceEvidenceDigest: string;
  holdEvidenceDigest: string;
  observedAt: string;
  validUntil: string;
}
const fakeInventoryFixtureSchema = z.object({ recordSetDigest: digest,
  itemCount: z.number().int().min(0).max(100_000), totalBytes: z.number().int().min(0).max(1_099_511_627_776),
  activeReferenceCount: z.number().int().min(0).max(100_000), legalHoldCount: z.number().int().min(0).max(32),
  existingTombstoneCount: z.number().int().min(0).max(100_000), existingQuarantineCount: z.number().int().min(0).max(100_000),
  inventoryEvidenceDigest: digest, referenceEvidenceDigest: digest, holdEvidenceDigest: digest,
  observedAt: time, validUntil: time }).strict();
const fakeAdapters = new WeakMap<object, FakeInventoryFixture>();

export function createOperationsRetentionFakeInventoryAdapterV1(inputValue: unknown): OperationsRetentionFakeInventoryAdapterV1 {
  const input = parseExactOperationsV1(fakeInventoryFixtureSchema, inputValue, "operations retention fake inventory fixture");
  if (Date.parse(input.validUntil) <= Date.parse(input.observedAt) || input.itemCount === 0 && input.totalBytes !== 0) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const adapter: OperationsRetentionFakeInventoryAdapterV1 = Object.freeze({ contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1,
    adapterId: `adapter:operations:retention:${sha256Digest(input).slice(7, 31)}`, testOnly: true });
  fakeAdapters.set(adapter as object, input); return adapter;
}

export type OperationsRetentionDryRunOutcomeV1 = "candidate_for_external_authority_review" | "blocked_active_reference" |
  "blocked_legal_hold" | "blocked_inventory_changed" | "reconciliation_required_already_absent" |
  "reconciliation_required_existing_tombstone" | "reconciliation_required_existing_quarantine";
export interface OperationsRetentionCleanupDryRunReportV1 {
  contractVersion: typeof OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1;
  reportId: string;
  planId: string;
  planDigest: string;
  policyDigest: string;
  dataClassId: OperationsDataClassIdV1;
  recordSetDigest: string;
  cleanupAction: OperationsRetentionCleanupActionV1;
  itemCount: number;
  totalBytes: number;
  activeReferenceCount: number;
  legalHoldCount: number;
  existingTombstoneCount: number;
  existingQuarantineCount: number;
  inventoryEvidenceDigest: string;
  referenceEvidenceDigest: string;
  holdEvidenceDigest: string;
  outcome: OperationsRetentionDryRunOutcomeV1;
  candidateForExternalAuthorityReview: boolean;
  cleanupAuthorized: false;
  inventoryBodyRead: false;
  rawMaterialPresent: false;
  locatorResolved: false;
  adapterTestOnly: true;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  observedAt: string;
  validUntil: string;
  reportDigest: string;
}
const dryRunOutcome = z.enum(["candidate_for_external_authority_review", "blocked_active_reference", "blocked_legal_hold",
  "blocked_inventory_changed", "reconciliation_required_already_absent", "reconciliation_required_existing_tombstone",
  "reconciliation_required_existing_quarantine"]);
const reportSchema = z.object({ contractVersion: z.literal(OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1), reportId: id,
  planId: id, planDigest: digest, policyDigest: digest, dataClassId, recordSetDigest: digest, cleanupAction,
  itemCount: z.number().int().min(0).max(100_000), totalBytes: z.number().int().min(0).max(1_099_511_627_776),
  activeReferenceCount: z.number().int().min(0).max(100_000), legalHoldCount: z.number().int().min(0).max(32),
  existingTombstoneCount: z.number().int().min(0).max(100_000), existingQuarantineCount: z.number().int().min(0).max(100_000),
  inventoryEvidenceDigest: digest, referenceEvidenceDigest: digest, holdEvidenceDigest: digest, outcome: dryRunOutcome,
  candidateForExternalAuthorityReview: z.boolean(), cleanupAuthorized: z.literal(false), inventoryBodyRead: z.literal(false),
  rawMaterialPresent: z.literal(false), locatorResolved: z.literal(false), adapterTestOnly: z.literal(true),
  performsAction: z.literal(false), grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), observedAt: time, validUntil: time, reportDigest: digest }).strict();
const trustedReports = new WeakSet<object>();

function reportOutcome(plan: OperationsRetentionCleanupDryRunPlanV1, fixture: FakeInventoryFixture): OperationsRetentionDryRunOutcomeV1 {
  if (fixture.recordSetDigest !== plan.recordSetDigest) return "blocked_inventory_changed";
  if (fixture.legalHoldCount > 0) return "blocked_legal_hold";
  if (fixture.activeReferenceCount > 0) return "blocked_active_reference";
  if (fixture.itemCount === 0) return "reconciliation_required_already_absent";
  if (["delete_body", "replace_with_digest_tombstone"].includes(plan.cleanupAction) && fixture.existingTombstoneCount > 0) {
    return "reconciliation_required_existing_tombstone";
  }
  if (plan.cleanupAction === "record_quarantine_candidate" && fixture.existingQuarantineCount > 0) {
    return "reconciliation_required_existing_quarantine";
  }
  return "candidate_for_external_authority_review";
}

export function runOperationsRetentionCleanupDryRunV1(inputValue: unknown): OperationsRetentionCleanupDryRunReportV1 {
  const snapshot = exactHostDataSnapshotV1(inputValue, ["plan", "adapter"]), planValue = snapshot?.plan,
    adapter = snapshot?.adapter;
  if (!snapshot || !planValue || typeof planValue !== "object" || !trustedPlans.has(planValue as object)
    || !adapter || typeof adapter !== "object" || !fakeAdapters.has(adapter as object)) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const plan = parseOperationsRetentionCleanupDryRunPlanV1(planValue), fixture = fakeAdapters.get(adapter as object)!,
    outcome = reportOutcome(plan, fixture);
  if (Date.parse(fixture.observedAt) < Date.parse(plan.createdAt) || Date.parse(fixture.validUntil) > Date.parse(plan.expiresAt)
    || fixture.itemCount > plan.maximumInventoryItems || fixture.totalBytes > plan.maximumInventoryBytes) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const reportBasis = sha256Digest({ planDigest: plan.planDigest, inventoryEvidenceDigest: fixture.inventoryEvidenceDigest,
    observedAt: fixture.observedAt }), material: Omit<OperationsRetentionCleanupDryRunReportV1, "reportDigest"> = {
      contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1,
      reportId: `report:operations:retention:${reportBasis.slice(7, 31)}`, planId: plan.planId, planDigest: plan.planDigest,
      policyDigest: plan.policyDigest, dataClassId: plan.dataClassId, recordSetDigest: plan.recordSetDigest,
      cleanupAction: plan.cleanupAction, itemCount: fixture.itemCount, totalBytes: fixture.totalBytes,
      activeReferenceCount: fixture.activeReferenceCount, legalHoldCount: fixture.legalHoldCount,
      existingTombstoneCount: fixture.existingTombstoneCount, existingQuarantineCount: fixture.existingQuarantineCount,
      inventoryEvidenceDigest: fixture.inventoryEvidenceDigest, referenceEvidenceDigest: fixture.referenceEvidenceDigest,
      holdEvidenceDigest: fixture.holdEvidenceDigest, outcome,
      candidateForExternalAuthorityReview: outcome === "candidate_for_external_authority_review", cleanupAuthorized: false,
      inventoryBodyRead: false, rawMaterialPresent: false, locatorResolved: false, adapterTestOnly: true, performsAction: false,
      grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false,
      observedAt: fixture.observedAt, validUntil: fixture.validUntil };
  const report = parseOperationsRetentionCleanupDryRunReportV1({ ...material, reportDigest: sha256Digest(material) });
  trustedReports.add(report as object); return report;
}

export function parseOperationsRetentionCleanupDryRunReportV1(value: unknown): OperationsRetentionCleanupDryRunReportV1 {
  const parsed = parseExactOperationsV1(reportSchema, value, "operations retention cleanup dry-run report"),
    reportBasis = sha256Digest({ planDigest: parsed.planDigest, inventoryEvidenceDigest: parsed.inventoryEvidenceDigest,
      observedAt: parsed.observedAt });
  if (parsed.reportId !== `report:operations:retention:${reportBasis.slice(7, 31)}`
    || parsed.candidateForExternalAuthorityReview !== (parsed.outcome === "candidate_for_external_authority_review")
    || Date.parse(parsed.validUntil) <= Date.parse(parsed.observedAt)) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "reportDigest", parsed.reportDigest); return parsed;
}

export type OperationsRetentionCleanupReceiptOutcomeV1 = "simulated_success" | "simulated_definite_failure" |
  "simulated_unknown_after_marker";
export interface OperationsRetentionCleanupReceiptV1 {
  contractVersion: typeof OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1;
  receiptId: string;
  operationId: string;
  planDigest: string;
  cleanupAction: OperationsRetentionCleanupActionV1;
  outcome: OperationsRetentionCleanupReceiptOutcomeV1;
  independentPostConditionDigest?: string;
  auditAppendEvidenceDigest?: string;
  tombstoneEvidenceDigest?: string;
  quarantineEvidenceDigest?: string;
  sourceReconciliationEvidenceDigest?: string;
  failureEvidenceDigest?: string;
  syntheticOnly: true;
  nativeReceiptPresent: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  recordedAt: string;
  receiptDigest: string;
}
const receiptOutcome = z.enum(["simulated_success", "simulated_definite_failure", "simulated_unknown_after_marker"]);
const receiptSchema = z.object({ contractVersion: z.literal(OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1), receiptId: id,
  operationId: id, planDigest: digest, cleanupAction, outcome: receiptOutcome, independentPostConditionDigest: digest.optional(),
  auditAppendEvidenceDigest: digest.optional(), tombstoneEvidenceDigest: digest.optional(), quarantineEvidenceDigest: digest.optional(),
  sourceReconciliationEvidenceDigest: digest.optional(), failureEvidenceDigest: digest.optional(), syntheticOnly: z.literal(true),
  nativeReceiptPresent: z.literal(false), performsAction: z.literal(false), grantsApproval: z.literal(false),
  grantsDeletionAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), recordedAt: time,
  receiptDigest: digest }).strict();

function assertReceiptEvidence(receipt: OperationsRetentionCleanupReceiptV1): void {
  const success = receipt.outcome === "simulated_success", failed = receipt.outcome === "simulated_definite_failure",
    requiresTombstone = ["delete_body", "replace_with_digest_tombstone"].includes(receipt.cleanupAction),
    requiresQuarantine = receipt.cleanupAction === "record_quarantine_candidate",
    requiresSource = receipt.cleanupAction === "reconcile_source_authority";
  if (success !== Boolean(receipt.independentPostConditionDigest && receipt.auditAppendEvidenceDigest)
    || (success && requiresTombstone) !== Boolean(receipt.tombstoneEvidenceDigest)
    || (success && requiresQuarantine) !== Boolean(receipt.quarantineEvidenceDigest)
    || (success && requiresSource) !== Boolean(receipt.sourceReconciliationEvidenceDigest)
    || (!success || !requiresTombstone) && receipt.tombstoneEvidenceDigest !== undefined
    || (!success || !requiresQuarantine) && receipt.quarantineEvidenceDigest !== undefined
    || (!success || !requiresSource) && receipt.sourceReconciliationEvidenceDigest !== undefined
    || failed !== Boolean(receipt.failureEvidenceDigest)
    || receipt.outcome === "simulated_unknown_after_marker" && Boolean(receipt.failureEvidenceDigest)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
}

export function parseOperationsRetentionCleanupReceiptV1(value: unknown): OperationsRetentionCleanupReceiptV1 {
  const parsed = parseExactOperationsV1(receiptSchema, value, "operations retention cleanup receipt");
  if (parsed.receiptId !== `receipt:operations:retention:${sha256Digest({ operationId: parsed.operationId,
    outcome: parsed.outcome, recordedAt: parsed.recordedAt }).slice(7, 31)}`) throw new OperationsContractErrorV1("scope_mismatch");
  assertReceiptEvidence(parsed);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "receiptDigest", parsed.receiptDigest); return parsed;
}

export type OperationsRetentionCleanupLifecycleStatusV1 = "dry_run_ready" | "blocked_before_marker" |
  "synthetic_claim_recorded" | "synthetic_marker_recorded" | "reconciliation_required" |
  "completed_evidence_only" | "failed_before_marker" | "failed_evidence_only" | "terminal_ambiguity";
export interface OperationsRetentionCleanupLifecycleV1 {
  contractVersion: typeof OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1;
  operationId: string;
  authenticatorIdentityDigest: string;
  planId: string;
  planDigest: string;
  reportDigest: string;
  policyDigest: string;
  recordSetDigest: string;
  cleanupAction: OperationsRetentionCleanupActionV1;
  idempotencyKey: string;
  revision: number;
  status: OperationsRetentionCleanupLifecycleStatusV1;
  safeStatusCode: string;
  syntheticClaimEvidenceDigest?: string;
  syntheticClaimRecordedAt?: string;
  syntheticMarkerEvidenceDigest?: string;
  syntheticMarkerRecordedAt?: string;
  receipt?: OperationsRetentionCleanupReceiptV1;
  reconciliationEvidenceDigest?: string;
  reconciledAt?: string;
  dryRunOnly: true;
  syntheticClaimOnly: true;
  syntheticMarkerOnly: true;
  nativeClaimRecorded: false;
  nativeMarkerRecorded: false;
  nativeReceiptRecorded: false;
  effectAttemptCount: 0;
  automaticRetryAllowed: false;
  commandLines: [];
  rawMaterialPresent: false;
  locatorPresent: false;
  clientPresent: false;
  credentialResolutionAttempted: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  stateDigest: string;
  stateAuthTag: string;
}
const lifecycleStatus = z.enum(["dry_run_ready", "blocked_before_marker", "synthetic_claim_recorded",
  "synthetic_marker_recorded", "reconciliation_required", "completed_evidence_only", "failed_before_marker",
  "failed_evidence_only", "terminal_ambiguity"]);
const lifecycleSchema = z.object({ contractVersion: z.literal(OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1), operationId: id,
  authenticatorIdentityDigest: digest, planId: id, planDigest: digest, reportDigest: digest, policyDigest: digest,
  recordSetDigest: digest, cleanupAction, idempotencyKey: digest, revision: z.number().int().positive(), status: lifecycleStatus,
  safeStatusCode: id, syntheticClaimEvidenceDigest: digest.optional(), syntheticClaimRecordedAt: time.optional(),
  syntheticMarkerEvidenceDigest: digest.optional(), syntheticMarkerRecordedAt: time.optional(), receipt: receiptSchema.optional(),
  reconciliationEvidenceDigest: digest.optional(), reconciledAt: time.optional(), dryRunOnly: z.literal(true),
  syntheticClaimOnly: z.literal(true), syntheticMarkerOnly: z.literal(true), nativeClaimRecorded: z.literal(false),
  nativeMarkerRecorded: z.literal(false), nativeReceiptRecorded: z.literal(false), effectAttemptCount: z.literal(0),
  automaticRetryAllowed: z.literal(false), commandLines: z.tuple([]), rawMaterialPresent: z.literal(false),
  locatorPresent: z.literal(false), clientPresent: z.literal(false), credentialResolutionAttempted: z.literal(false),
  performsAction: z.literal(false), grantsApproval: z.literal(false), grantsDeletionAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), createdAt: time, updatedAt: time, expiresAt: time, stateDigest: digest,
  stateAuthTag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/) }).strict();

export function parseOperationsRetentionCleanupLifecycleV1(value: unknown): OperationsRetentionCleanupLifecycleV1 {
  const parsed = parseExactOperationsV1(lifecycleSchema, value, "operations retention cleanup lifecycle"), hasClaim =
    Boolean(parsed.syntheticClaimEvidenceDigest && parsed.syntheticClaimRecordedAt), hasMarker =
    Boolean(parsed.syntheticMarkerEvidenceDigest && parsed.syntheticMarkerRecordedAt), hasReconciliation =
    Boolean(parsed.reconciliationEvidenceDigest && parsed.reconciledAt);
  if (parsed.operationId !== `cleanup-operation:operations:${parsed.planDigest.slice(7, 31)}`
    || parsed.idempotencyKey !== sha256Digest({ planDigest: parsed.planDigest, recordSetDigest: parsed.recordSetDigest,
      cleanupAction: parsed.cleanupAction }) || Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)
    || Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt)
    || Boolean(parsed.syntheticClaimEvidenceDigest) !== Boolean(parsed.syntheticClaimRecordedAt)
    || Boolean(parsed.syntheticMarkerEvidenceDigest) !== Boolean(parsed.syntheticMarkerRecordedAt)
    || Boolean(parsed.reconciliationEvidenceDigest) !== Boolean(parsed.reconciledAt)
    || hasMarker && !hasClaim || parsed.receipt && !hasMarker || hasReconciliation && !parsed.receipt
    || ["synthetic_claim_recorded", "synthetic_marker_recorded", "reconciliation_required", "completed_evidence_only",
      "failed_evidence_only", "terminal_ambiguity"].includes(parsed.status) && !hasClaim
    || ["synthetic_marker_recorded", "reconciliation_required", "completed_evidence_only", "failed_evidence_only",
      "terminal_ambiguity"].includes(parsed.status) && !hasMarker
    || parsed.status === "reconciliation_required" && !parsed.receipt
    || ["completed_evidence_only", "failed_evidence_only"].includes(parsed.status) && !hasReconciliation
    || parsed.status === "terminal_ambiguity" && parsed.receipt?.outcome !== "simulated_unknown_after_marker") {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  if (parsed.receipt) parseOperationsRetentionCleanupReceiptV1(parsed.receipt);
  const material = { ...parsed } as Record<string, unknown>; delete material.stateDigest; delete material.stateAuthTag;
  if (parsed.stateDigest !== sha256Digest(material)) throw new OperationsContractErrorV1("digest_mismatch"); return parsed;
}

const equalTag = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8"); return a.length === b.length && timingSafeEqual(a, b);
};
const trustedAuthenticators = new WeakSet<object>();

export class OperationsRetentionCleanupAuthenticatorV1 {
  readonly #key: Uint8Array;
  readonly #checkpointRead: RollbackCheckpointStoreV1["read"];
  readonly #checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  readonly #checkpointAdvance: RollbackCheckpointStoreV1["advance"];
  #closed = false;

  constructor(readonly identityDigest: string, integrityKey: Uint8Array, checkpointStore: RollbackCheckpointStoreV1,
    options: { testOnly: true }) {
    const observed = exactHostUint8ArrayV1(integrityKey, 64), optionSnapshot = exactHostDataSnapshotV1(options, ["testOnly"]),
      checkpointRead = dataMethodV1(checkpointStore, "read"), checkpointInitialize = dataMethodV1(checkpointStore, "initialize"),
      checkpointAdvance = dataMethodV1(checkpointStore, "advance");
    if (!digest.safeParse(identityDigest).success || !observed || observed.byteLength < 32 || optionSnapshot?.testOnly !== true
      || !checkpointRead || !checkpointInitialize || !checkpointAdvance) throw new Error("operations retention cleanup authenticator invalid");
    this.#key = observed.copy(); hmacSha256Tag(this.#key, { purpose: "operations-retention-cleanup-authenticator" });
    this.#checkpointRead = ((scope: string) => Reflect.apply(checkpointRead, checkpointStore, [scope])) as RollbackCheckpointStoreV1["read"];
    this.#checkpointInitialize = ((value: RollbackCheckpointV1) => Reflect.apply(checkpointInitialize, checkpointStore,
      [value])) as RollbackCheckpointStoreV1["initialize"];
    this.#checkpointAdvance = ((expected: string, value: RollbackCheckpointV1) => Reflect.apply(checkpointAdvance,
      checkpointStore, [expected, value])) as RollbackCheckpointStoreV1["advance"];
    trustedAuthenticators.add(this);
  }
  close(): void { if (!this.#closed) this.#key.fill(0); this.#closed = true; }

  start(planValue: unknown, reportValue: unknown): OperationsRetentionCleanupLifecycleV1 {
    if (!planValue || typeof planValue !== "object" || !trustedPlans.has(planValue as object)
      || !reportValue || typeof reportValue !== "object" || !trustedReports.has(reportValue as object)) {
      throw new OperationsContractErrorV1("unsupported_action");
    }
    const plan = parseOperationsRetentionCleanupDryRunPlanV1(planValue), report = parseOperationsRetentionCleanupDryRunReportV1(reportValue);
    if (report.planDigest !== plan.planDigest || report.policyDigest !== plan.policyDigest || report.recordSetDigest !== plan.recordSetDigest
      || report.cleanupAction !== plan.cleanupAction || Date.parse(report.validUntil) > Date.parse(plan.expiresAt)) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
    const operationId = `cleanup-operation:operations:${plan.planDigest.slice(7, 31)}`,
      material: Omit<OperationsRetentionCleanupLifecycleV1, "stateDigest" | "stateAuthTag"> = {
        contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1, operationId,
        authenticatorIdentityDigest: this.identityDigest, planId: plan.planId, planDigest: plan.planDigest,
        reportDigest: report.reportDigest, policyDigest: plan.policyDigest, recordSetDigest: plan.recordSetDigest,
        cleanupAction: plan.cleanupAction, idempotencyKey: sha256Digest({ planDigest: plan.planDigest,
          recordSetDigest: plan.recordSetDigest, cleanupAction: plan.cleanupAction }), revision: 1,
        status: report.candidateForExternalAuthorityReview ? "dry_run_ready" : "blocked_before_marker",
        safeStatusCode: report.outcome, dryRunOnly: true, syntheticClaimOnly: true, syntheticMarkerOnly: true,
        nativeClaimRecorded: false, nativeMarkerRecorded: false, nativeReceiptRecorded: false, effectAttemptCount: 0,
        automaticRetryAllowed: false, commandLines: [], rawMaterialPresent: false, locatorPresent: false, clientPresent: false,
        credentialResolutionAttempted: false, performsAction: false, grantsApproval: false, grantsDeletionAuthority: false,
        grantsExecutionAuthority: false, createdAt: report.observedAt, updatedAt: report.observedAt, expiresAt: report.validUntil };
    const state = this.seal(material), checkpoint = this.checkpoint(state);
    this.#checkpointInitialize(checkpoint); return state;
  }

  verify(value: unknown): OperationsRetentionCleanupLifecycleV1 {
    if (this.#closed) throw new Error("operations retention cleanup authenticator closed");
    const parsed = parseOperationsRetentionCleanupLifecycleV1(value), expectedTag = hmacSha256Tag(this.#key,
      { stateDigest: parsed.stateDigest, authenticatorIdentityDigest: this.identityDigest });
    if (parsed.authenticatorIdentityDigest !== this.identityDigest || !equalTag(parsed.stateAuthTag, expectedTag)) {
      throw new Error("operations retention cleanup state authentication failed");
    }
    const expected = this.checkpoint(parsed), known = this.#checkpointRead(expected.scope);
    if (!known || rollbackCheckpointDigestV1(known) !== rollbackCheckpointDigestV1(expected)) {
      throw new Error("operations retention cleanup rollback detected");
    }
    return parsed;
  }

  recordSyntheticClaim(value: unknown, claimEvidenceDigest: string, recordedAt: string): OperationsRetentionCleanupLifecycleV1 {
    const current = this.verify(value);
    if (current.syntheticClaimEvidenceDigest) {
      if (current.syntheticClaimEvidenceDigest !== claimEvidenceDigest || current.syntheticClaimRecordedAt !== recordedAt) {
        throw new OperationsContractErrorV1("invalid_transition");
      }
      return current;
    }
    if (current.status !== "dry_run_ready" || !digest.safeParse(claimEvidenceDigest).success) {
      throw new OperationsContractErrorV1("unsupported_action");
    }
    return this.transition(current, recordedAt, { status: "synthetic_claim_recorded",
      safeStatusCode: "synthetic_claim_evidence_recorded_no_authority", syntheticClaimEvidenceDigest: claimEvidenceDigest,
      syntheticClaimRecordedAt: recordedAt });
  }

  recordSyntheticMarker(value: unknown, markerEvidenceDigest: string, recordedAt: string): OperationsRetentionCleanupLifecycleV1 {
    const current = this.verify(value);
    if (current.syntheticMarkerEvidenceDigest) {
      if (current.syntheticMarkerEvidenceDigest !== markerEvidenceDigest || current.syntheticMarkerRecordedAt !== recordedAt) {
        throw new OperationsContractErrorV1("invalid_transition");
      }
      return current;
    }
    if (current.status !== "synthetic_claim_recorded" || !digest.safeParse(markerEvidenceDigest).success) {
      throw new OperationsContractErrorV1("unsupported_action");
    }
    return this.transition(current, recordedAt, { status: "synthetic_marker_recorded",
      safeStatusCode: "synthetic_marker_rehearsed_no_native_marker", syntheticMarkerEvidenceDigest: markerEvidenceDigest,
      syntheticMarkerRecordedAt: recordedAt });
  }

  recordSyntheticReceipt(value: unknown, inputValue: unknown): OperationsRetentionCleanupLifecycleV1 {
    const current = this.verify(value), input = parseExactOperationsV1(z.object({ outcome: receiptOutcome,
      independentPostConditionDigest: digest.optional(), auditAppendEvidenceDigest: digest.optional(),
      tombstoneEvidenceDigest: digest.optional(), quarantineEvidenceDigest: digest.optional(),
      sourceReconciliationEvidenceDigest: digest.optional(), failureEvidenceDigest: digest.optional(), recordedAt: time }).strict(),
    inputValue, "operations retention cleanup synthetic receipt input");
    const receiptId = `receipt:operations:retention:${sha256Digest({ operationId: current.operationId,
      outcome: input.outcome, recordedAt: input.recordedAt }).slice(7, 31)}`,
      material: Omit<OperationsRetentionCleanupReceiptV1, "receiptDigest"> = {
        contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1, receiptId, operationId: current.operationId,
        planDigest: current.planDigest, cleanupAction: current.cleanupAction, ...input, syntheticOnly: true,
        nativeReceiptPresent: false, performsAction: false, grantsApproval: false, grantsDeletionAuthority: false,
        grantsExecutionAuthority: false }, receipt = parseOperationsRetentionCleanupReceiptV1({ ...material,
        receiptDigest: sha256Digest(material) });
    if (current.receipt) {
      if (current.receipt.receiptDigest !== receipt.receiptDigest) throw new OperationsContractErrorV1("invalid_transition");
      return current;
    }
    if (current.status !== "synthetic_marker_recorded") throw new OperationsContractErrorV1("unsupported_action");
    return this.transition(current, input.recordedAt, { receipt,
      status: input.outcome === "simulated_unknown_after_marker" ? "terminal_ambiguity" : "reconciliation_required",
      safeStatusCode: input.outcome === "simulated_unknown_after_marker" ? "synthetic_unknown_rehearses_terminal_ambiguity"
        : "synthetic_terminal_receipt_requires_reconciliation" });
  }

  reconcile(value: unknown, reconciliationEvidenceDigest: string, recordedAt: string): OperationsRetentionCleanupLifecycleV1 {
    const current = this.verify(value);
    if (current.reconciliationEvidenceDigest) {
      if (current.reconciliationEvidenceDigest !== reconciliationEvidenceDigest || current.reconciledAt !== recordedAt) {
        throw new OperationsContractErrorV1("invalid_transition");
      }
      return current;
    }
    if (current.status !== "reconciliation_required" || !current.receipt || !digest.safeParse(reconciliationEvidenceDigest).success) {
      throw new OperationsContractErrorV1("unsupported_action");
    }
    const success = current.receipt.outcome === "simulated_success";
    return this.transition(current, recordedAt, { reconciliationEvidenceDigest, reconciledAt: recordedAt,
      status: success ? "completed_evidence_only" : "failed_evidence_only",
      safeStatusCode: success ? "synthetic_cleanup_rehearsal_completed_no_effect" : "synthetic_failure_reconciled_no_effect" });
  }

  resume(value: unknown, recordedAt: string): OperationsRetentionCleanupLifecycleV1 {
    const current = this.verify(value);
    if (["dry_run_ready", "blocked_before_marker", "reconciliation_required", "completed_evidence_only",
      "failed_before_marker", "failed_evidence_only", "terminal_ambiguity"].includes(current.status)) return current;
    if (current.status === "synthetic_claim_recorded") return this.transition(current, recordedAt, {
      status: "failed_before_marker", safeStatusCode: "restart_after_synthetic_claim_before_marker_no_effect_no_retry" });
    const receiptInput = { outcome: "simulated_unknown_after_marker" as const, recordedAt },
      receiptId = `receipt:operations:retention:${sha256Digest({ operationId: current.operationId,
        outcome: receiptInput.outcome, recordedAt }).slice(7, 31)}`,
      material: Omit<OperationsRetentionCleanupReceiptV1, "receiptDigest"> = {
        contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1, receiptId, operationId: current.operationId,
        planDigest: current.planDigest, cleanupAction: current.cleanupAction, outcome: receiptInput.outcome,
        syntheticOnly: true, nativeReceiptPresent: false, performsAction: false, grantsApproval: false,
        grantsDeletionAuthority: false, grantsExecutionAuthority: false, recordedAt },
      receipt = parseOperationsRetentionCleanupReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
    return this.transition(current, recordedAt, { receipt, status: "terminal_ambiguity",
      safeStatusCode: "restart_after_synthetic_marker_rehearses_terminal_ambiguity_no_retry" });
  }

  private checkpoint(value: OperationsRetentionCleanupLifecycleV1): RollbackCheckpointV1 {
    return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: `operations-retention-cleanup:${value.operationId}`,
      revision: value.revision, recordCount: value.receipt ? 4 : value.syntheticMarkerEvidenceDigest ? 3
        : value.syntheticClaimEvidenceDigest ? 2 : 1, stateDigest: value.stateDigest, stateAuthTag: value.stateAuthTag };
  }
  private seal(input: Omit<OperationsRetentionCleanupLifecycleV1, "stateDigest" | "stateAuthTag">): OperationsRetentionCleanupLifecycleV1 {
    if (this.#closed) throw new Error("operations retention cleanup authenticator closed");
    const stateDigest = sha256Digest(input), stateAuthTag = hmacSha256Tag(this.#key,
      { stateDigest, authenticatorIdentityDigest: this.identityDigest });
    return parseOperationsRetentionCleanupLifecycleV1({ ...input, stateDigest, stateAuthTag });
  }
  private transition(current: OperationsRetentionCleanupLifecycleV1, recordedAt: string,
    changes: Partial<OperationsRetentionCleanupLifecycleV1>): OperationsRetentionCleanupLifecycleV1 {
    if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(recordedAt) < Date.parse(current.updatedAt)
      || Date.parse(recordedAt) >= Date.parse(current.expiresAt)) throw new OperationsContractErrorV1("scope_mismatch");
    const material = exactProjectWorkspaceJsonV1(current) as OperationsRetentionCleanupLifecycleV1,
      previousCheckpoint = this.checkpoint(current), raw = { ...material, ...changes, revision: current.revision + 1,
        updatedAt: recordedAt } as Record<string, unknown>;
    delete raw.stateDigest; delete raw.stateAuthTag;
    const next = this.seal(raw as unknown as Omit<OperationsRetentionCleanupLifecycleV1, "stateDigest" | "stateAuthTag">);
    this.#checkpointAdvance(rollbackCheckpointDigestV1(previousCheckpoint), this.checkpoint(next)); return next;
  }
}

export interface OperationsDisabledRetentionCleanupV1 {
  contractVersion: typeof OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1;
  planDigest: string;
  cleanupAction: OperationsRetentionCleanupActionV1;
  status: "disabled_before_execution";
  commandLines: [];
  locatorPresent: false;
  clientPresent: false;
  credentialResolutionAttempted: false;
  effectAttempted: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  dispositionDigest: string;
}
export function createOperationsDisabledRetentionCleanupExecutorV1(): {
  prepare(value: unknown): OperationsDisabledRetentionCleanupV1;
} {
  return Object.freeze({ prepare(value: unknown) {
    if (!value || typeof value !== "object" || !trustedPlans.has(value as object)) {
      throw new OperationsContractErrorV1("unsupported_action");
    }
    const plan = parseOperationsRetentionCleanupDryRunPlanV1(value),
      material: Omit<OperationsDisabledRetentionCleanupV1, "dispositionDigest"> = {
        contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1, planDigest: plan.planDigest,
        cleanupAction: plan.cleanupAction, status: "disabled_before_execution", commandLines: [], locatorPresent: false,
        clientPresent: false, credentialResolutionAttempted: false, effectAttempted: false, performsAction: false,
        grantsApproval: false, grantsDeletionAuthority: false, grantsExecutionAuthority: false };
    return { ...material, dispositionDigest: sha256Digest(material) };
  } });
}

export interface OperationsRetentionCleanupProjectionV1 {
  contractVersion: typeof OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1;
  planDigest: string;
  reportDigest: string;
  operationId: string;
  cleanupAction: OperationsRetentionCleanupActionV1;
  dryRunOutcome: OperationsRetentionDryRunOutcomeV1;
  lifecycleStatus: OperationsRetentionCleanupLifecycleStatusV1;
  safeStatusCode: string;
  itemCount: number;
  totalBytes: number;
  activeReferenceCount: number;
  legalHoldCount: number;
  tombstoneRequired: boolean;
  controls: [];
  commandLines: [];
  rawMaterialPresent: false;
  locatorPresent: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  projectionDigest: string;
}
export function projectOperationsRetentionCleanupV1(authenticatorValue: unknown, planValue: unknown, reportValue: unknown,
  lifecycleValue: unknown): OperationsRetentionCleanupProjectionV1 {
  if (!authenticatorValue || typeof authenticatorValue !== "object" || !trustedAuthenticators.has(authenticatorValue as object)) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const plan = parseOperationsRetentionCleanupDryRunPlanV1(planValue), report = parseOperationsRetentionCleanupDryRunReportV1(reportValue),
    lifecycle = (authenticatorValue as OperationsRetentionCleanupAuthenticatorV1).verify(lifecycleValue);
  if (report.planDigest !== plan.planDigest || lifecycle.planDigest !== plan.planDigest
    || lifecycle.reportDigest !== report.reportDigest) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsRetentionCleanupProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_RETENTION_CLEANUP_DRY_RUN_V1, planDigest: plan.planDigest, reportDigest: report.reportDigest,
    operationId: lifecycle.operationId, cleanupAction: plan.cleanupAction, dryRunOutcome: report.outcome,
    lifecycleStatus: lifecycle.status, safeStatusCode: lifecycle.safeStatusCode, itemCount: report.itemCount,
    totalBytes: report.totalBytes, activeReferenceCount: report.activeReferenceCount, legalHoldCount: report.legalHoldCount,
    tombstoneRequired: ["delete_body", "replace_with_digest_tombstone"].includes(plan.cleanupAction), controls: [], commandLines: [],
    rawMaterialPresent: false, locatorPresent: false, performsAction: false, grantsApproval: false,
    grantsDeletionAuthority: false, grantsExecutionAuthority: false };
  return { ...material, projectionDigest: sha256Digest(material) };
}

export const operationsRetentionCleanupSchemasV1 = { step: stepSchema, plan: planSchema, report: reportSchema,
  receipt: receiptSchema, lifecycle: lifecycleSchema } as const;
