import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { exactProjectWorkspaceJsonV1 } from "../../project-workspace/v1/exact";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, exactHostUint8ArrayV1 } from "../../security/host-value";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";

export const OPERATIONS_RUNBOOK_CONTRACT_V1 = "control-room-operations-runbook/v1" as const;
export const OPERATIONS_RUNBOOK_IDS_V1 = [
  "runbook:operations:deploy-release",
  "runbook:operations:forward-migration",
  "runbook:operations:one-host-canary",
  "runbook:operations:application-rollback",
  "runbook:operations:backup-wal",
  "runbook:operations:isolated-restore",
  "runbook:operations:incident-isolation",
  "runbook:operations:audit-anchor-recovery",
] as const;
export type OperationsRunbookIdV1 = (typeof OPERATIONS_RUNBOOK_IDS_V1)[number];
export type OperationsRunbookStepKindV1 = "evidence_check" | "owner_gate" | "effect_slot" | "verification" |
  "cleanup" | "reconciliation";
export type OperationsRunbookBoundaryV1 = "before_change" | "change_marker" | "after_change";

export interface OperationsRunbookStepV1 {
  runbookId: OperationsRunbookIdV1;
  stepId: string;
  position: number;
  kind: OperationsRunbookStepKindV1;
  evidenceClass: string;
  boundary: OperationsRunbookBoundaryV1;
  requiresPreviousStep: boolean;
  requiresFreshEvidence: true;
  nativeExecutorSlotPresent: false;
  automaticRetryAllowed: false;
  actionAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  stepDigest: string;
}

export interface OperationsRunbookDefinitionV1 {
  contractVersion: typeof OPERATIONS_RUNBOOK_CONTRACT_V1;
  runbookId: OperationsRunbookIdV1;
  operationClass: string;
  titleCode: string;
  steps: OperationsRunbookStepV1[];
  cleanupStepId: string;
  reconciliationStepId: string;
  resumableFromAuthenticatedState: true;
  ownerDecisionRequired: true;
  nativeExecutorPresent: false;
  commandLines: [];
  targetPresent: false;
  automaticRetryAllowed: false;
  authorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  definitionDigest: string;
}

export interface OperationsRunbookRegistryV1 {
  contractVersion: typeof OPERATIONS_RUNBOOK_CONTRACT_V1;
  registryId: "registry:operations:runbooks:v1";
  definitions: OperationsRunbookDefinitionV1[];
  nativeExecutorPresent: false;
  productionValuesPresent: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  registryDigest: string;
}

type StepSpec = readonly [stepKey: string, kind: OperationsRunbookStepKindV1, evidenceClass: string,
  boundary: OperationsRunbookBoundaryV1];
const specs: Record<OperationsRunbookIdV1, { operationClass: string; titleCode: string; steps: readonly StepSpec[] }> = {
  "runbook:operations:deploy-release": { operationClass: "deploy_release_candidate", titleCode: "deploy_release_safely",
    steps: [["verify_topology_release", "evidence_check", "exact_topology_release_binding", "before_change"],
      ["verify_eighteen_gates", "evidence_check", "exact_current_deployment_readiness", "before_change"],
      ["request_deployment_window", "owner_gate", "synthetic_owner_deployment_window_rehearsal", "before_change"],
      ["prepare_forward_migration", "effect_slot", "synthetic_forward_migration_marker", "change_marker"],
      ["verify_migration", "verification", "synthetic_independent_migration_receipt", "after_change"],
      ["prepare_one_host_canary", "effect_slot", "synthetic_one_host_canary_marker", "change_marker"],
      ["verify_canary", "verification", "synthetic_independent_canary_observation", "after_change"],
      ["request_promote_or_rollback", "owner_gate", "synthetic_owner_branch_decision_rehearsal", "after_change"],
      ["cleanup_deployment_workspace", "cleanup", "synthetic_deployment_cleanup_receipt", "after_change"],
      ["reconcile_deployment", "reconciliation", "synthetic_deployment_reconciliation", "after_change"]] },
  "runbook:operations:forward-migration": { operationClass: "forward_migration_candidate", titleCode: "forward_migration_safely",
    steps: [["verify_schema_backup_wal", "evidence_check", "exact_schema_backup_wal_binding", "before_change"],
      ["request_migration_window", "owner_gate", "synthetic_owner_migration_window_rehearsal", "before_change"],
      ["prepare_migration_claim", "effect_slot", "synthetic_forward_migration_marker", "change_marker"],
      ["verify_migration_transaction", "verification", "synthetic_independent_migration_receipt", "after_change"],
      ["verify_no_down_migration", "verification", "synthetic_forward_only_verification", "after_change"],
      ["cleanup_migration_runner", "cleanup", "synthetic_migration_cleanup_receipt", "after_change"],
      ["reconcile_migration", "reconciliation", "synthetic_migration_reconciliation", "after_change"]] },
  "runbook:operations:one-host-canary": { operationClass: "one_host_canary_candidate", titleCode: "one_host_canary_safely",
    steps: [["verify_migration_release", "evidence_check", "exact_migration_release_binding", "before_change"],
      ["request_canary_window", "owner_gate", "synthetic_owner_canary_window_rehearsal", "before_change"],
      ["prepare_one_host_canary", "effect_slot", "synthetic_one_host_canary_marker", "change_marker"],
      ["observe_health_monitoring", "verification", "synthetic_independent_canary_observation", "after_change"],
      ["request_branch_decision", "owner_gate", "synthetic_owner_branch_decision_rehearsal", "after_change"],
      ["cleanup_canary_workspace", "cleanup", "synthetic_canary_cleanup_receipt", "after_change"],
      ["reconcile_canary", "reconciliation", "synthetic_canary_reconciliation", "after_change"]] },
  "runbook:operations:application-rollback": { operationClass: "application_rollback_candidate", titleCode: "application_rollback_safely",
    steps: [["verify_release_pair", "evidence_check", "exact_current_previous_release_binding", "before_change"],
      ["verify_database_unchanged", "evidence_check", "exact_unchanged_database_disposition", "before_change"],
      ["request_rollback_window", "owner_gate", "synthetic_owner_rollback_window_rehearsal", "before_change"],
      ["prepare_rollback_canary", "effect_slot", "synthetic_application_rollback_marker", "change_marker"],
      ["verify_rollback_canary", "verification", "synthetic_independent_rollback_observation", "after_change"],
      ["verify_restore_separation", "verification", "synthetic_restore_separation_verification", "after_change"],
      ["cleanup_rollback_workspace", "cleanup", "synthetic_rollback_cleanup_receipt", "after_change"],
      ["reconcile_rollback", "reconciliation", "synthetic_rollback_reconciliation", "after_change"]] },
  "runbook:operations:backup-wal": { operationClass: "backup_wal_candidate", titleCode: "backup_wal_safely",
    steps: [["verify_backup_plan", "evidence_check", "exact_backup_wal_plan_binding", "before_change"],
      ["request_backup_window", "owner_gate", "synthetic_owner_backup_window_rehearsal", "before_change"],
      ["prepare_backup_claim", "effect_slot", "synthetic_backup_wal_marker", "change_marker"],
      ["verify_immutable_manifest", "verification", "synthetic_independent_backup_manifest", "after_change"],
      ["verify_retention_bounds", "verification", "synthetic_retention_verification", "after_change"],
      ["cleanup_backup_workspace", "cleanup", "synthetic_backup_cleanup_receipt", "after_change"],
      ["reconcile_backup", "reconciliation", "synthetic_backup_reconciliation", "after_change"]] },
  "runbook:operations:isolated-restore": { operationClass: "isolated_restore_candidate", titleCode: "isolated_restore_safely",
    steps: [["verify_disposable_target", "evidence_check", "exact_disposable_target_binding", "before_change"],
      ["verify_backup_manifest", "evidence_check", "exact_backup_manifest_binding", "before_change"],
      ["verify_restore_window", "evidence_check", "exact_bounded_restore_window", "before_change"],
      ["request_restore_window", "owner_gate", "synthetic_owner_restore_window_rehearsal", "before_change"],
      ["prepare_base_restore", "effect_slot", "synthetic_base_restore_marker", "change_marker"],
      ["prepare_bounded_wal_replay", "effect_slot", "synthetic_bounded_wal_marker", "change_marker"],
      ["verify_database_integrity", "verification", "synthetic_database_integrity_verification", "after_change"],
      ["verify_audit_anchor", "verification", "synthetic_audit_anchor_verification", "after_change"],
      ["reconcile_node_journals", "verification", "synthetic_node_journal_reconciliation", "after_change"],
      ["verify_independent_health", "verification", "synthetic_independent_health_verification", "after_change"],
      ["request_cutover_review", "owner_gate", "synthetic_owner_cutover_review_rehearsal", "after_change"],
      ["cleanup_disposable_restore", "cleanup", "synthetic_restore_cleanup_receipt", "after_change"],
      ["reconcile_restore", "reconciliation", "synthetic_restore_reconciliation", "after_change"]] },
  "runbook:operations:incident-isolation": { operationClass: "incident_isolation_candidate", titleCode: "incident_isolation_safely",
    steps: [["verify_incident_scope", "evidence_check", "exact_incident_monitoring_binding", "before_change"],
      ["request_isolation_window", "owner_gate", "synthetic_owner_isolation_window_rehearsal", "before_change"],
      ["prepare_narrow_isolation", "effect_slot", "synthetic_incident_isolation_marker", "change_marker"],
      ["verify_bounded_isolation", "verification", "synthetic_independent_isolation_verification", "after_change"],
      ["verify_no_scope_expansion", "verification", "synthetic_scope_containment_verification", "after_change"],
      ["cleanup_isolation_workspace", "cleanup", "synthetic_isolation_cleanup_receipt", "after_change"],
      ["reconcile_incident", "reconciliation", "synthetic_incident_reconciliation", "after_change"]] },
  "runbook:operations:audit-anchor-recovery": { operationClass: "audit_anchor_recovery_candidate", titleCode: "audit_anchor_recovery_safely",
    steps: [["verify_chain_head_anchor", "evidence_check", "exact_audit_chain_anchor_binding", "before_change"],
      ["request_anchor_window", "owner_gate", "synthetic_owner_anchor_window_rehearsal", "before_change"],
      ["prepare_anchor_recovery", "effect_slot", "synthetic_audit_anchor_marker", "change_marker"],
      ["verify_chain_continuity", "verification", "synthetic_independent_chain_verification", "after_change"],
      ["verify_monitoring_continuity", "verification", "synthetic_anchor_monitoring_verification", "after_change"],
      ["cleanup_anchor_workspace", "cleanup", "synthetic_anchor_cleanup_receipt", "after_change"],
      ["reconcile_anchor", "reconciliation", "synthetic_anchor_reconciliation", "after_change"]] },
};

const runbookId = z.enum(OPERATIONS_RUNBOOK_IDS_V1), stepKind = z.enum(["evidence_check", "owner_gate", "effect_slot",
  "verification", "cleanup", "reconciliation"]), boundary = z.enum(["before_change", "change_marker", "after_change"]);
const stepSchema = z.object({ runbookId, stepId: id, position: z.number().int().min(0).max(15), kind: stepKind,
  evidenceClass: id, boundary, requiresPreviousStep: z.boolean(), requiresFreshEvidence: z.literal(true),
  nativeExecutorSlotPresent: z.literal(false), automaticRetryAllowed: z.literal(false), actionAuthorized: z.literal(false),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), stepDigest: digest }).strict();
const definitionSchema = z.object({ contractVersion: z.literal(OPERATIONS_RUNBOOK_CONTRACT_V1), runbookId,
  operationClass: id, titleCode: id, steps: z.array(stepSchema).min(6).max(16), cleanupStepId: id,
  reconciliationStepId: id, resumableFromAuthenticatedState: z.literal(true), ownerDecisionRequired: z.literal(true),
  nativeExecutorPresent: z.literal(false), commandLines: z.tuple([]), targetPresent: z.literal(false),
  automaticRetryAllowed: z.literal(false), authorized: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), definitionDigest: digest }).strict();
const registrySchema = z.object({ contractVersion: z.literal(OPERATIONS_RUNBOOK_CONTRACT_V1),
  registryId: z.literal("registry:operations:runbooks:v1"), definitions: z.array(definitionSchema).length(8),
  nativeExecutorPresent: z.literal(false), productionValuesPresent: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), registryDigest: digest }).strict();

function buildDefinition(currentRunbookId: OperationsRunbookIdV1): OperationsRunbookDefinitionV1 {
  const spec = specs[currentRunbookId], steps = spec.steps.map(([stepKey, kind, evidenceClass, currentBoundary], position) => {
    const material: Omit<OperationsRunbookStepV1, "stepDigest"> = { runbookId: currentRunbookId,
      stepId: `step:operations:${currentRunbookId.split(":").at(-1)}:${stepKey.replaceAll("_", "-")}`, position, kind,
      evidenceClass, boundary: currentBoundary, requiresPreviousStep: position > 0, requiresFreshEvidence: true,
      nativeExecutorSlotPresent: false, automaticRetryAllowed: false, actionAuthorized: false, grantsApproval: false,
      grantsExecutionAuthority: false };
    return { ...material, stepDigest: sha256Digest(material) };
  }), cleanup = steps.find((step) => step.kind === "cleanup")!, reconciliation = steps.find((step) => step.kind === "reconciliation")!;
  const material: Omit<OperationsRunbookDefinitionV1, "definitionDigest"> = {
    contractVersion: OPERATIONS_RUNBOOK_CONTRACT_V1, runbookId: currentRunbookId, operationClass: spec.operationClass,
    titleCode: spec.titleCode, steps, cleanupStepId: cleanup.stepId, reconciliationStepId: reconciliation.stepId,
    resumableFromAuthenticatedState: true, ownerDecisionRequired: true, nativeExecutorPresent: false, commandLines: [],
    targetPresent: false, automaticRetryAllowed: false, authorized: false, grantsApproval: false, grantsExecutionAuthority: false };
  return { ...material, definitionDigest: sha256Digest(material) };
}

export function buildOperationsRunbookRegistryV1(): OperationsRunbookRegistryV1 {
  const material: Omit<OperationsRunbookRegistryV1, "registryDigest"> = { contractVersion: OPERATIONS_RUNBOOK_CONTRACT_V1,
    registryId: "registry:operations:runbooks:v1", definitions: OPERATIONS_RUNBOOK_IDS_V1.map(buildDefinition),
    nativeExecutorPresent: false, productionValuesPresent: false, grantsApproval: false, grantsExecutionAuthority: false };
  return parseOperationsRunbookRegistryV1({ ...material, registryDigest: sha256Digest(material) });
}

export function parseOperationsRunbookDefinitionV1(value: unknown): OperationsRunbookDefinitionV1 {
  const parsed = parseExactOperationsV1(definitionSchema, value, "operations runbook definition"), expected = buildDefinition(parsed.runbookId);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new OperationsContractErrorV1("scope_mismatch");
  parsed.steps.forEach((step) => verifyOperationsDigestV1(step as unknown as Record<string, unknown>, "stepDigest", step.stepDigest));
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "definitionDigest", parsed.definitionDigest); return parsed;
}

export function parseOperationsRunbookRegistryV1(value: unknown): OperationsRunbookRegistryV1 {
  const parsed = parseExactOperationsV1(registrySchema, value, "operations runbook registry");
  if (parsed.definitions.map((definition) => definition.runbookId).join("|") !== OPERATIONS_RUNBOOK_IDS_V1.join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  parsed.definitions.forEach(parseOperationsRunbookDefinitionV1);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "registryDigest", parsed.registryDigest); return parsed;
}

export type OperationsRunbookEvidenceStateV1 = "met" | "failed" | "unknown";
export interface OperationsRunbookEvidenceV1 {
  contractVersion: typeof OPERATIONS_RUNBOOK_CONTRACT_V1;
  evidenceId: string;
  instanceId: string;
  operationDigest: string;
  stepId: string;
  stepDigest: string;
  evidenceClass: string;
  state: OperationsRunbookEvidenceStateV1;
  nativeOutcome: "not_attempted" | "unknown";
  evidenceDigest: string;
  observedAt: string;
  validUntil: string;
  syntheticOnly: true;
  approvalMaterialPresent: false;
  rawOutputPresent: false;
  performsAction: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  recordDigest: string;
}

export type OperationsRunbookInstanceStatusV1 = "not_started" | "in_progress" | "owner_input_required" |
  "blocked_before_change" | "ambiguous_cleanup_required" | "ambiguous_reconciliation_required" |
  "completed_evidence_only" | "terminal_ambiguity";
export interface OperationsRunbookStepStateV1 {
  stepId: string;
  position: number;
  state: "pending" | "met" | "failed" | "unknown" | "stale";
  evidence?: OperationsRunbookEvidenceV1;
}
export interface OperationsRunbookInstanceV1 {
  contractVersion: typeof OPERATIONS_RUNBOOK_CONTRACT_V1;
  instanceId: string;
  authenticatorIdentityDigest: string;
  runbookId: OperationsRunbookIdV1;
  definitionDigest: string;
  scopeDigest: string;
  operationDigest: string;
  stepStates: OperationsRunbookStepStateV1[];
  currentStepPosition: number;
  status: OperationsRunbookInstanceStatusV1;
  changeBoundaryRehearsed: boolean;
  ambiguityRecorded: boolean;
  effectAttemptCount: 0;
  commandLines: [];
  authorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  instanceDigest: string;
  stateAuthTag: string;
}

const evidenceSchema = z.object({ contractVersion: z.literal(OPERATIONS_RUNBOOK_CONTRACT_V1), evidenceId: id,
  instanceId: id, operationDigest: digest, stepId: id, stepDigest: digest, evidenceClass: id,
  state: z.enum(["met", "failed", "unknown"]), nativeOutcome: z.enum(["not_attempted", "unknown"]), evidenceDigest: digest,
  observedAt: time, validUntil: time, syntheticOnly: z.literal(true), approvalMaterialPresent: z.literal(false),
  rawOutputPresent: z.literal(false), performsAction: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), recordDigest: digest }).strict();
const stepStateSchema = z.object({ stepId: id, position: z.number().int().min(0).max(15),
  state: z.enum(["pending", "met", "failed", "unknown", "stale"]),
  evidence: evidenceSchema.optional() }).strict();
const instanceSchema = z.object({ contractVersion: z.literal(OPERATIONS_RUNBOOK_CONTRACT_V1), instanceId: id,
  authenticatorIdentityDigest: digest, runbookId, definitionDigest: digest, scopeDigest: digest, operationDigest: digest,
  stepStates: z.array(stepStateSchema).min(6).max(16), currentStepPosition: z.number().int().min(0).max(16),
  status: z.enum(["not_started", "in_progress", "owner_input_required", "blocked_before_change",
    "ambiguous_cleanup_required", "ambiguous_reconciliation_required", "completed_evidence_only", "terminal_ambiguity"]),
  changeBoundaryRehearsed: z.boolean(), ambiguityRecorded: z.boolean(), effectAttemptCount: z.literal(0),
  commandLines: z.tuple([]), authorized: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  createdAt: time, updatedAt: time, expiresAt: time, instanceDigest: digest,
  stateAuthTag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/) }).strict();

export function buildOperationsSyntheticRunbookEvidenceV1(inputValue: unknown): OperationsRunbookEvidenceV1 {
  const input = parseExactOperationsV1(z.object({ definition: z.unknown(), instance: z.unknown(), stepId: id,
    state: z.enum(["met", "failed", "unknown"]), observedAt: time, validUntil: time }).strict(), inputValue,
  "operations synthetic runbook evidence input"), definition = parseOperationsRunbookDefinitionV1(input.definition),
    instance = parseOperationsRunbookInstanceV1(input.instance), step = definition.steps.find((item) => item.stepId === input.stepId);
  if (!step || instance.runbookId !== definition.runbookId || instance.definitionDigest !== definition.definitionDigest
    || Date.parse(input.validUntil) <= Date.parse(input.observedAt)) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsRunbookEvidenceV1, "recordDigest"> = { contractVersion: OPERATIONS_RUNBOOK_CONTRACT_V1,
    evidenceId: `evidence:operations:runbook:${sha256Digest({ instanceId: instance.instanceId, stepId: step.stepId,
      observedAt: input.observedAt }).slice(7, 31)}`, instanceId: instance.instanceId, operationDigest: instance.operationDigest,
    stepId: step.stepId, stepDigest: step.stepDigest, evidenceClass: step.evidenceClass, state: input.state,
    nativeOutcome: input.state === "unknown" ? "unknown" : "not_attempted", evidenceDigest: sha256Digest({
      rehearsal: "synthetic-runbook-evidence", instanceId: instance.instanceId, stepDigest: step.stepDigest, state: input.state }),
    observedAt: input.observedAt, validUntil: input.validUntil, syntheticOnly: true, approvalMaterialPresent: false,
    rawOutputPresent: false, performsAction: false, grantsApproval: false, grantsExecutionAuthority: false };
  return parseOperationsRunbookEvidenceV1({ ...material, recordDigest: sha256Digest(material) });
}

export function parseOperationsRunbookEvidenceV1(value: unknown): OperationsRunbookEvidenceV1 {
  const parsed = parseExactOperationsV1(evidenceSchema, value, "operations runbook evidence");
  if ((parsed.state === "unknown") !== (parsed.nativeOutcome === "unknown")
    || Date.parse(parsed.validUntil) <= Date.parse(parsed.observedAt)
    || parsed.evidenceDigest !== sha256Digest({ rehearsal: "synthetic-runbook-evidence", instanceId: parsed.instanceId,
      stepDigest: parsed.stepDigest, state: parsed.state })) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "recordDigest", parsed.recordDigest); return parsed;
}

export function parseOperationsRunbookInstanceV1(value: unknown): OperationsRunbookInstanceV1 {
  const parsed = parseExactOperationsV1(instanceSchema, value, "operations runbook instance");
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt) || Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt)
    || parsed.currentStepPosition > parsed.stepStates.length
    || parsed.stepStates.some((step, position) => step.position !== position || (step.state === "pending") === Boolean(step.evidence)
      || step.evidence && (step.evidence.instanceId !== parsed.instanceId || step.evidence.operationDigest !== parsed.operationDigest
        || step.evidence.stepId !== step.stepId || step.state !== "stale" && step.evidence.state !== step.state))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  parsed.stepStates.filter((step) => step.evidence).forEach((step) => parseOperationsRunbookEvidenceV1(step.evidence));
  const allPending = parsed.stepStates.every((step) => step.state === "pending"), allMet = parsed.stepStates.every((step) => step.state === "met");
  if (parsed.status === "not_started" && (parsed.currentStepPosition !== 0 || !allPending || parsed.changeBoundaryRehearsed || parsed.ambiguityRecorded)
    || parsed.status === "completed_evidence_only" && (parsed.currentStepPosition !== parsed.stepStates.length || !allMet || parsed.ambiguityRecorded)
    || parsed.status === "terminal_ambiguity" && (parsed.currentStepPosition !== parsed.stepStates.length || !parsed.ambiguityRecorded)
    || ["ambiguous_cleanup_required", "ambiguous_reconciliation_required"].includes(parsed.status) && !parsed.ambiguityRecorded
    || parsed.status === "blocked_before_change" && (parsed.changeBoundaryRehearsed || parsed.ambiguityRecorded)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const material = { ...parsed } as Record<string, unknown>; delete material.stateAuthTag; delete material.instanceDigest;
  if (parsed.instanceDigest !== sha256Digest(material)) throw new OperationsContractErrorV1("digest_mismatch"); return parsed;
}

const equalTag = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8"); return a.length === b.length && timingSafeEqual(a, b);
};
const trustedAuthenticators = new WeakSet<object>();

export class OperationsRunbookAuthenticatorV1 {
  readonly #key: Uint8Array;
  #closed = false;
  constructor(readonly identityDigest: string, integrityKey: Uint8Array, options: { testOnly: true }) {
    const observed = exactHostUint8ArrayV1(integrityKey, 64), optionSnapshot = exactHostDataSnapshotV1(options, ["testOnly"]);
    if (!digest.safeParse(identityDigest).success || optionSnapshot?.testOnly !== true || !observed || observed.byteLength < 32) {
      throw new Error("operations runbook authenticator invalid");
    }
    this.#key = observed.copy(); hmacSha256Tag(this.#key, { purpose: "operations-runbook-authenticator" });
    trustedAuthenticators.add(this);
  }
  close(): void { if (!this.#closed) this.#key.fill(0); this.#closed = true; }

  start(inputValue: unknown): OperationsRunbookInstanceV1 {
    const input = parseExactOperationsV1(z.object({ registry: z.unknown(), runbookId, instanceId: id,
      scopeDigest: digest, operationDigest: digest, createdAt: time, expiresAt: time }).strict(), inputValue,
    "operations runbook start input"), registry = parseOperationsRunbookRegistryV1(input.registry),
      definition = registry.definitions.find((item) => item.runbookId === input.runbookId);
    if (!definition || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) throw new OperationsContractErrorV1("scope_mismatch");
    return this.seal({ contractVersion: OPERATIONS_RUNBOOK_CONTRACT_V1, instanceId: input.instanceId,
      authenticatorIdentityDigest: this.identityDigest, runbookId: definition.runbookId,
      definitionDigest: definition.definitionDigest, scopeDigest: input.scopeDigest, operationDigest: input.operationDigest,
      stepStates: definition.steps.map((step) => ({ stepId: step.stepId, position: step.position, state: "pending" as const })),
      currentStepPosition: 0, status: "not_started", changeBoundaryRehearsed: false, ambiguityRecorded: false,
      effectAttemptCount: 0, commandLines: [], authorized: false, grantsApproval: false, grantsExecutionAuthority: false,
      createdAt: input.createdAt, updatedAt: input.createdAt, expiresAt: input.expiresAt });
  }

  verify(value: unknown): OperationsRunbookInstanceV1 {
    if (this.#closed) throw new Error("operations runbook authenticator closed");
    const parsed = parseOperationsRunbookInstanceV1(value);
    if (parsed.authenticatorIdentityDigest !== this.identityDigest || !equalTag(parsed.stateAuthTag,
      hmacSha256Tag(this.#key, { instanceDigest: parsed.instanceDigest, authenticatorIdentityDigest: this.identityDigest }))) {
      throw new Error("operations runbook state authentication failed");
    }
    return parsed;
  }

  advance(instanceValue: unknown, definitionValue: unknown, evidenceValue: unknown, now: string): OperationsRunbookInstanceV1 {
    const current = this.verify(instanceValue), definition = parseOperationsRunbookDefinitionV1(definitionValue),
      evidence = parseOperationsRunbookEvidenceV1(evidenceValue);
    if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(current.updatedAt) || Date.parse(now) >= Date.parse(current.expiresAt)
      || definition.runbookId !== current.runbookId || definition.definitionDigest !== current.definitionDigest
      || evidence.instanceId !== current.instanceId || evidence.operationDigest !== current.operationDigest) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
    const step = definition.steps.find((item) => item.stepId === evidence.stepId), stored = step && current.stepStates[step.position];
    if (!step || !stored || evidence.stepDigest !== step.stepDigest || evidence.evidenceClass !== step.evidenceClass) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
    if (stored.state !== "pending") {
      if (stored.evidence?.recordDigest !== evidence.recordDigest) throw new OperationsContractErrorV1("invalid_transition");
      return current;
    }
    if (step.position !== current.currentStepPosition) throw new OperationsContractErrorV1("unsupported_action");
    const next = exactProjectWorkspaceJsonV1(current) as OperationsRunbookInstanceV1,
      nextState = next.stepStates[step.position]!, stale = Date.parse(now) >= Date.parse(evidence.validUntil)
        || Date.parse(now) < Date.parse(evidence.observedAt), uncertain = stale || evidence.state === "unknown",
      failed = evidence.state === "failed", afterChange = current.changeBoundaryRehearsed || step.boundary !== "before_change";
    nextState.state = stale ? "stale" : evidence.state; nextState.evidence = evidence; next.updatedAt = now;
    if (step.kind === "effect_slot") next.changeBoundaryRehearsed = true;
    if (uncertain || failed) {
      if (afterChange) {
        next.ambiguityRecorded = true;
        if (step.kind === "reconciliation") {
          next.status = "terminal_ambiguity"; next.currentStepPosition = definition.steps.length;
        } else if (step.kind === "cleanup") {
          next.status = "ambiguous_reconciliation_required";
          next.currentStepPosition = definition.steps.find((item) => item.stepId === definition.reconciliationStepId)!.position;
        } else {
          next.status = "ambiguous_cleanup_required";
          next.currentStepPosition = definition.steps.find((item) => item.stepId === definition.cleanupStepId)!.position;
        }
      } else {
        next.status = "blocked_before_change"; next.currentStepPosition = step.position;
      }
      return this.reseal(next);
    }
    if (current.ambiguityRecorded && step.kind === "cleanup") {
      next.status = "ambiguous_reconciliation_required";
      next.currentStepPosition = definition.steps.find((item) => item.stepId === definition.reconciliationStepId)!.position;
    } else if (current.ambiguityRecorded && step.kind === "reconciliation") {
      next.status = "terminal_ambiguity"; next.currentStepPosition = definition.steps.length;
    } else {
      next.currentStepPosition = step.position + 1;
      const following = definition.steps[next.currentStepPosition];
      next.status = !following ? "completed_evidence_only" : following.kind === "owner_gate" ? "owner_input_required" : "in_progress";
    }
    return this.reseal(next);
  }

  abort(instanceValue: unknown, definitionValue: unknown, now: string): OperationsRunbookInstanceV1 {
    const current = this.verify(instanceValue), definition = parseOperationsRunbookDefinitionV1(definitionValue);
    if (definition.runbookId !== current.runbookId || definition.definitionDigest !== current.definitionDigest
      || Date.parse(now) < Date.parse(current.updatedAt) || Date.parse(now) >= Date.parse(current.expiresAt)) {
      throw new OperationsContractErrorV1("scope_mismatch");
    }
    if (["completed_evidence_only", "terminal_ambiguity", "blocked_before_change", "ambiguous_cleanup_required",
      "ambiguous_reconciliation_required"].includes(current.status)) return current;
    const next = exactProjectWorkspaceJsonV1(current) as OperationsRunbookInstanceV1; next.updatedAt = now;
    if (!current.changeBoundaryRehearsed) next.status = "blocked_before_change";
    else {
      const cleanupPosition = definition.steps.find((item) => item.stepId === definition.cleanupStepId)!.position,
        reconciliationPosition = definition.steps.find((item) => item.stepId === definition.reconciliationStepId)!.position;
      next.ambiguityRecorded = true;
      if (current.currentStepPosition >= reconciliationPosition || current.stepStates[cleanupPosition]?.state !== "pending") {
        next.status = "ambiguous_reconciliation_required"; next.currentStepPosition = reconciliationPosition;
      } else {
        next.status = "ambiguous_cleanup_required"; next.currentStepPosition = cleanupPosition;
      }
    }
    return this.reseal(next);
  }

  private seal(input: Omit<OperationsRunbookInstanceV1, "instanceDigest" | "stateAuthTag">): OperationsRunbookInstanceV1 {
    if (this.#closed) throw new Error("operations runbook authenticator closed");
    const instanceDigest = sha256Digest(input), material = { ...input, instanceDigest }, stateAuthTag = hmacSha256Tag(this.#key,
      { instanceDigest, authenticatorIdentityDigest: this.identityDigest });
    return parseOperationsRunbookInstanceV1({ ...material, stateAuthTag });
  }
  private reseal(value: OperationsRunbookInstanceV1): OperationsRunbookInstanceV1 {
    const material = { ...value } as Record<string, unknown>; delete material.instanceDigest; delete material.stateAuthTag;
    return this.seal(material as unknown as Omit<OperationsRunbookInstanceV1, "instanceDigest" | "stateAuthTag">);
  }
}

export interface OperationsRunbookGuideV1 {
  contractVersion: typeof OPERATIONS_RUNBOOK_CONTRACT_V1;
  runbookId: OperationsRunbookIdV1;
  definitionDigest: string;
  titleCode: string;
  stepCards: Array<{ stepId: string; position: number; kind: OperationsRunbookStepKindV1; evidenceClass: string;
    boundary: OperationsRunbookBoundaryV1; ownerPromptCode?: string; }>;
  controls: [];
  commandLines: [];
  nativeExecutorPresent: false;
  performsAction: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  guideDigest: string;
}

export function renderOperationsRunbookGuideV1(definitionValue: unknown): OperationsRunbookGuideV1 {
  const definition = parseOperationsRunbookDefinitionV1(definitionValue), material: Omit<OperationsRunbookGuideV1, "guideDigest"> = {
    contractVersion: OPERATIONS_RUNBOOK_CONTRACT_V1, runbookId: definition.runbookId,
    definitionDigest: definition.definitionDigest, titleCode: definition.titleCode,
    stepCards: definition.steps.map((step) => ({ stepId: step.stepId, position: step.position, kind: step.kind,
      evidenceClass: step.evidenceClass, boundary: step.boundary,
      ...(step.kind === "owner_gate" ? { ownerPromptCode: step.evidenceClass } : {}) })), controls: [], commandLines: [],
    nativeExecutorPresent: false, performsAction: false, grantsApproval: false, grantsExecutionAuthority: false };
  return { ...material, guideDigest: sha256Digest(material) };
}

export function rehearseOperationsRunbookV1(input: { authenticator: OperationsRunbookAuthenticatorV1;
  registry: OperationsRunbookRegistryV1; runbookId: OperationsRunbookIdV1; instanceId: string;
  scopeDigest: string; operationDigest: string; startedAt: string; expiresAt: string }): OperationsRunbookInstanceV1 {
  const snapshot = exactHostDataSnapshotV1(input, ["authenticator", "registry", "runbookId", "instanceId", "scopeDigest",
    "operationDigest", "startedAt", "expiresAt"]), parsed = snapshot && parseExactOperationsV1(z.object({
      runbookId, instanceId: id, scopeDigest: digest, operationDigest: digest, startedAt: time, expiresAt: time }).strict(), {
      runbookId: snapshot.runbookId, instanceId: snapshot.instanceId, scopeDigest: snapshot.scopeDigest,
      operationDigest: snapshot.operationDigest, startedAt: snapshot.startedAt, expiresAt: snapshot.expiresAt,
    }, "operations runbook rehearsal input"), auth = snapshot?.authenticator;
  if (!snapshot || !parsed || !auth || typeof auth !== "object" || !trustedAuthenticators.has(auth)) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const trustedAuth = auth as OperationsRunbookAuthenticatorV1;
  const registry = parseOperationsRunbookRegistryV1(snapshot.registry),
    definition = registry.definitions.find((item) => item.runbookId === parsed.runbookId)!,
    start = Date.parse(parsed.startedAt); let instance = trustedAuth.start({ registry,
      runbookId: parsed.runbookId, instanceId: parsed.instanceId, scopeDigest: parsed.scopeDigest,
      operationDigest: parsed.operationDigest, createdAt: parsed.startedAt, expiresAt: parsed.expiresAt });
  for (const step of definition.steps) {
    const observedAt = new Date(start + (step.position + 1) * 1_000).toISOString(), validUntil = new Date(start + 120_000).toISOString(),
      evidence = buildOperationsSyntheticRunbookEvidenceV1({ definition, instance, stepId: step.stepId,
        state: "met", observedAt, validUntil });
    instance = trustedAuth.advance(instance, definition, evidence, observedAt);
  }
  return instance;
}

export const operationsRunbookSchemasV1 = { step: stepSchema, definition: definitionSchema, registry: registrySchema,
  evidence: evidenceSchema, stepState: stepStateSchema, instance: instanceSchema } as const;
