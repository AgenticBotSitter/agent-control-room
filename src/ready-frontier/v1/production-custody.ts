import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1 } from "./no-relay";
import { parseReadyFrontierProductionBoundaryAssessmentV1 } from "./production-boundary";
import {
  READY_FRONTIER_ACCEPTED_AUTO060_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO060_REVIEW_SHA256_V1,
  READY_FRONTIER_PRODUCTION_CUSTODY_MAX_LIFETIME_SECONDS_V1,
  READY_FRONTIER_PRODUCTION_CUSTODY_PLAN_V1,
  READY_FRONTIER_PRODUCTION_CUSTODY_PROJECTION_V1,
  READY_FRONTIER_PRODUCTION_CUSTODY_REPORT_V1,
  readyFrontierProductionCustodyFaultCodesV1,
  readyFrontierProductionCustodyScenarioCodesV1,
  type ReadyFrontierProductionCustodyFaultCodeV1,
  type ReadyFrontierProductionCustodyPlanV1,
  type ReadyFrontierProductionCustodyProjectionV1,
  type ReadyFrontierProductionCustodyReportV1,
  type ReadyFrontierProductionCustodyScenarioCodeV1,
  type ReadyFrontierProductionCustodyScenarioResultV1,
  type ReadyFrontierProductionCustodyServiceRoleV1,
} from "./production-custody-types";

function bindPrivateParserV1<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
  const parse = schema.parse.bind(schema);
  return Object.freeze({ parse });
}

const idSchemaV1 = z.string().min(3).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
const safeCodeSchemaV1 = z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const digestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const authTagSchemaV1 = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
const timeSchemaV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }, "invalid canonical instant");
const gateSchemaV1 = z.enum(READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1);
const scenarioSchemaV1 = z.enum(readyFrontierProductionCustodyScenarioCodesV1);
const faultSchemaV1 = z.enum(readyFrontierProductionCustodyFaultCodesV1);
const serviceRoleSchemaV1 = z.object({
  role: z.enum(["proof_ingress_writer", "proof_read_verifier", "rollback_checkpoint_custodian"]),
  serviceIdentityId: idSchemaV1,
  keyIdentityDigest: digestSchemaV1,
  independenceDomainDigest: digestSchemaV1,
  mayWriteProofLedger: z.boolean(),
  mayVerifyProofLedger: z.boolean(),
  mayAdvanceCheckpoint: z.boolean(),
  mayIssueProof: z.literal(false),
  mayApproveProduction: z.literal(false),
  mayActivateProduction: z.literal(false),
}).strict();
const planInputSchemaV1 = z.object({
  planId: idSchemaV1,
  assessment: z.unknown(),
  plannedAt: timeSchemaV1,
  expiresAt: timeSchemaV1,
}).strict();
const planSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_CUSTODY_PLAN_V1),
  planId: idSchemaV1,
  tenantId: idSchemaV1,
  workspaceId: idSchemaV1,
  productionBoundaryPlanId: idSchemaV1,
  productionBoundaryPlanDigest: digestSchemaV1,
  productionBoundaryAssessmentId: idSchemaV1,
  productionBoundaryAssessmentDigest: digestSchemaV1,
  productionBoundaryAssessment: z.unknown(),
  acceptedAuto060Commit: z.literal(READY_FRONTIER_ACCEPTED_AUTO060_COMMIT_V1),
  acceptedAuto060ReviewSha256: z.literal(READY_FRONTIER_ACCEPTED_AUTO060_REVIEW_SHA256_V1),
  qualificationMode: z.literal("repository_fake_only"),
  databaseMode: z.literal("hosted_postgresql_required_unconfigured"),
  transactionIsolationRequired: z.literal("serializable"),
  ownerPolicyMode: z.literal("owner_signed_external_high_water_required"),
  clockMode: z.literal("protected_monotonic_database_commit_required"),
  revocationMode: z.literal("terminal_cross_process_high_water_required"),
  checkpointMode: z.literal("external_compare_and_swap_required"),
  restoreMode: z.literal("isolated_restore_then_reconcile_required"),
  ambiguityMode: z.literal("post_marker_unknown_is_terminal_ambiguity"),
  processCount: z.literal(3),
  processIds: z.tuple([idSchemaV1, idSchemaV1, idSchemaV1]),
  serviceRoles: z.array(serviceRoleSchemaV1).length(3),
  scenarioCodes: z.array(scenarioSchemaV1).length(8),
  requiredProductionGateCodes: z.array(gateSchemaV1).length(9),
  defaultDisabled: z.literal(true),
  repositoryFakeOnly: z.literal(true),
  liveQualificationAuthorized: z.literal(false),
  productionConfigurationPresent: z.literal(false),
  protectedMaterialPresent: z.literal(false),
  productionKeysEnrolled: z.literal(false),
  ownerPolicyEnrolled: z.literal(false),
  hostedDatabaseContactAuthorized: z.literal(false),
  networkAuthorized: z.literal(false),
  consumerImplemented: z.literal(false),
  activationAuthorized: z.literal(false),
  permitsProtectedReferenceResolution: z.literal(false),
  permitsClaimOrLease: z.literal(false),
  permitsDispatchOrExecution: z.literal(false),
  permitsExternalEffects: z.literal(false),
  plannedAt: timeSchemaV1,
  expiresAt: timeSchemaV1,
  planDigest: digestSchemaV1,
  planAuthTag: authTagSchemaV1,
}).strict();
const runInputSchemaV1 = z.object({
  runId: idSchemaV1,
  plan: z.unknown(),
  startedAt: timeSchemaV1,
  completedAt: timeSchemaV1,
  injectedFault: faultSchemaV1.optional(),
}).strict();
const scenarioResultSchemaV1 = z.object({
  scenarioCode: scenarioSchemaV1,
  status: z.enum(["simulated_pass", "simulated_failure"]),
  safeFindingCode: safeCodeSchemaV1,
  processCount: z.literal(3),
  evidenceDigest: digestSchemaV1,
}).strict();
const reportSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_CUSTODY_REPORT_V1),
  reportId: idSchemaV1,
  runId: idSchemaV1,
  planId: idSchemaV1,
  planDigest: digestSchemaV1,
  tenantId: idSchemaV1,
  workspaceId: idSchemaV1,
  productionBoundaryAssessmentId: idSchemaV1,
  productionBoundaryAssessmentDigest: digestSchemaV1,
  qualificationMode: z.literal("repository_fake_only"),
  injectedFault: faultSchemaV1,
  status: z.enum(["simulated_pass", "simulated_failure"]),
  scenarioResults: z.array(scenarioResultSchemaV1).length(8),
  simulatedPassCount: z.number().int().min(0).max(8),
  simulatedFailureCount: z.number().int().min(0).max(8),
  blockingGateCodes: z.array(gateSchemaV1).length(9),
  qualifiedProofCount: z.literal(0),
  remainingQualifiedProofCount: z.literal(9),
  state: z.literal("blocked_fake_qualification_only"),
  safeReason: z.literal("protected_production_qualification_not_run"),
  liveQualificationPerformed: z.literal(false),
  productionDatabaseContacted: z.literal(false),
  productionClockContacted: z.literal(false),
  productionKeyStoreContacted: z.literal(false),
  productionCheckpointContacted: z.literal(false),
  ownerPolicyRead: z.literal(false),
  ownerApprovalIssued: z.literal(false),
  protectedReferenceResolutionAttempted: z.literal(false),
  consumerConstructed: z.literal(false),
  claimOrLeaseAttempted: z.literal(false),
  dispatchOrExecutionAttempted: z.literal(false),
  networkContacted: z.literal(false),
  externalEffectOccurred: z.literal(false),
  grantsApproval: z.literal(false),
  grantsActivationAuthority: z.literal(false),
  grantsClaimOrLease: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  grantsExternalEffects: z.literal(false),
  startedAt: timeSchemaV1,
  completedAt: timeSchemaV1,
  reportDigest: digestSchemaV1,
  reportAuthTag: authTagSchemaV1,
}).strict();
const projectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_CUSTODY_PROJECTION_V1),
  tenantId: idSchemaV1,
  workspaceId: idSchemaV1,
  planId: idSchemaV1,
  reportId: idSchemaV1,
  status: z.literal("blocked_fake_qualification_only"),
  safeReason: z.literal("protected_production_qualification_not_run"),
  scenarioStatuses: z.array(z.object({ scenarioCode: scenarioSchemaV1,
    status: z.enum(["simulated_pass", "simulated_failure"]) }).strict()).length(8),
  blockingGateCodes: z.array(gateSchemaV1).length(9),
  qualifiedProofCount: z.literal(0),
  remainingQualifiedProofCount: z.literal(9),
  canRunLiveQualification: z.literal(false),
  canEnrollProductionKeys: z.literal(false),
  canEnrollOwnerPolicy: z.literal(false),
  canContactHostedDatabase: z.literal(false),
  canActivateProduction: z.literal(false),
  canConstructConsumer: z.literal(false),
  canResolveProtectedReferences: z.literal(false),
  canContactNetwork: z.literal(false),
  canClaimOrLease: z.literal(false),
  canDispatchOrExecute: z.literal(false),
  projectionDigest: digestSchemaV1,
}).strict();
const planInputParserV1 = bindPrivateParserV1(planInputSchemaV1);
const planParserV1 = bindPrivateParserV1(planSchemaV1);
const runInputParserV1 = bindPrivateParserV1(runInputSchemaV1);
const reportParserV1 = bindPrivateParserV1(reportSchemaV1);
const projectionParserV1 = bindPrivateParserV1(projectionSchemaV1);

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never {
  throw new ReadyFrontierContractErrorV1(code);
}
function key(value: unknown): Uint8Array {
  const parsed = exactHostUint8ArrayV1(value, 128);
  if (!parsed || parsed.byteLength < 32) fail("integrity_failed");
  return parsed.copy();
}
function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function without<T extends Record<string, unknown>>(value: T, field: keyof T): Record<string, unknown> {
  const copy = { ...value }; delete copy[field]; return copy;
}
function reportUnsigned(report: ReadyFrontierProductionCustodyReportV1): Record<string, unknown> {
  const material = without(report as unknown as Record<string, unknown>, "reportAuthTag");
  return without(material, "reportDigest");
}
function planUnsigned(plan: ReadyFrontierProductionCustodyPlanV1): Record<string, unknown> {
  const material = without(plan as unknown as Record<string, unknown>, "planAuthTag");
  return without(material, "planDigest");
}
function planAuthMaterial(plan: Pick<ReadyFrontierProductionCustodyPlanV1,
  "planId" | "planDigest" | "tenantId" | "workspaceId" | "productionBoundaryAssessmentDigest"
  | "plannedAt" | "expiresAt">): Record<string, unknown> {
  return { planId: plan.planId, planDigest: plan.planDigest, tenantId: plan.tenantId,
    workspaceId: plan.workspaceId, productionBoundaryAssessmentDigest: plan.productionBoundaryAssessmentDigest,
    plannedAt: plan.plannedAt, expiresAt: plan.expiresAt };
}
function reportAuthMaterial(report: Pick<ReadyFrontierProductionCustodyReportV1,
  "reportId" | "reportDigest" | "runId" | "planId" | "planDigest" | "tenantId" | "workspaceId"
  | "startedAt" | "completedAt">): Record<string, unknown> {
  return { reportId: report.reportId, reportDigest: report.reportDigest, runId: report.runId,
    planId: report.planId, planDigest: report.planDigest, tenantId: report.tenantId,
    workspaceId: report.workspaceId, startedAt: report.startedAt, completedAt: report.completedAt };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach((item) => deepFreeze(item));
  }
  return value;
}

const PROCESS_IDS_V1 = Object.freeze(["custody.qualifier.a", "custody.qualifier.b",
  "custody.qualifier.c"] as const);
function serviceRolesV1(): ReadyFrontierProductionCustodyServiceRoleV1[] {
  const roles: Array<Pick<ReadyFrontierProductionCustodyServiceRoleV1, "role" | "serviceIdentityId"
    | "mayWriteProofLedger" | "mayVerifyProofLedger" | "mayAdvanceCheckpoint">> = [
    { role: "proof_ingress_writer", serviceIdentityId: "custody.service.proof-writer",
      mayWriteProofLedger: true, mayVerifyProofLedger: false, mayAdvanceCheckpoint: false },
    { role: "proof_read_verifier", serviceIdentityId: "custody.service.proof-verifier",
      mayWriteProofLedger: false, mayVerifyProofLedger: true, mayAdvanceCheckpoint: false },
    { role: "rollback_checkpoint_custodian", serviceIdentityId: "custody.service.checkpoint-custodian",
      mayWriteProofLedger: false, mayVerifyProofLedger: false, mayAdvanceCheckpoint: true },
  ];
  return roles.map((role) => ({ ...role,
    keyIdentityDigest: sha256Digest({ repositoryFakeKeyIdentity: role.serviceIdentityId }),
    independenceDomainDigest: sha256Digest({ repositoryFakeIndependenceDomain: role.role }),
    mayIssueProof: false, mayApproveProduction: false, mayActivateProduction: false }));
}

class RepositoryFakeCustodyStateV1 {
  #policyRevision = 1;
  #checkpointRevision = 1;
  #databaseRevision = 1;
  #claimOwner: string | null = null;
  #revokedAtRevision: number | null = null;
  #deliveryMarker = false;

  advancePolicy(revision: number): boolean {
    if (revision !== this.#policyRevision + 1) return false;
    this.#policyRevision = revision; this.#databaseRevision += 1; return true;
  }
  policyRevision(): number { return this.#policyRevision; }
  revokeAt(revision: number): boolean {
    if (revision !== this.#policyRevision || this.#revokedAtRevision !== null) return false;
    this.#revokedAtRevision = revision; this.#databaseRevision += 1; return true;
  }
  acceptsCredentialAt(viewRevision: number): boolean {
    return this.#revokedAtRevision === null || viewRevision < this.#revokedAtRevision;
  }
  claim(processId: string): boolean {
    if (this.#claimOwner !== null) return false;
    this.#claimOwner = processId; this.#databaseRevision += 1; return true;
  }
  databaseRevision(): number { return this.#databaseRevision; }
  advanceCheckpoint(expected: number, next: number): boolean {
    if (this.#checkpointRevision !== expected || next !== expected + 1) return false;
    this.#checkpointRevision = next; return true;
  }
  checkpointRevision(): number { return this.#checkpointRevision; }
  markDelivery(): void { this.#deliveryMarker = true; this.#databaseRevision += 1; }
  deliveryMarked(): boolean { return this.#deliveryMarker; }
}

class RepositoryFakeProtectedClockV1 {
  #last = 0;
  observe(value: number): boolean {
    if (!Number.isSafeInteger(value) || value <= this.#last) return false;
    this.#last = value; return true;
  }
  current(): number { return this.#last; }
}

const faultForScenario: Readonly<Record<ReadyFrontierProductionCustodyScenarioCodeV1,
  ReadyFrontierProductionCustodyFaultCodeV1>> = Object.freeze({
  service_identity_separation: "service_identity_alias",
  owner_policy_high_water: "policy_rollback_accepted",
  protected_clock_commit_boundary: "clock_rollback_accepted",
  revocation_cross_process_convergence: "revocation_lag",
  serializable_claim_uniqueness: "duplicate_claim",
  checkpoint_compare_and_swap: "checkpoint_rollback_accepted",
  backup_restore_rollback_detection: "restored_database_trusted",
  post_marker_ambiguity: "retry_after_ambiguity",
});

function scenarioTranscriptV1(scenarioCode: ReadyFrontierProductionCustodyScenarioCodeV1,
  injectedFault: ReadyFrontierProductionCustodyFaultCodeV1): { passed: boolean; transcript: Record<string, unknown> } {
  const faultActive = injectedFault === faultForScenario[scenarioCode];
  if (scenarioCode === "service_identity_separation") {
    const roles = serviceRolesV1();
    const keyDigests = roles.map((item) => item.keyIdentityDigest);
    if (faultActive) keyDigests[1] = keyDigests[0]!;
    const passed = new Set(roles.map((item) => item.serviceIdentityId)).size === 3
      && new Set(keyDigests).size === 3
      && new Set(roles.map((item) => item.independenceDomainDigest)).size === 3
      && roles.filter((item) => item.mayWriteProofLedger).length === 1
      && roles.filter((item) => item.mayVerifyProofLedger).length === 1
      && roles.filter((item) => item.mayAdvanceCheckpoint).length === 1;
    return { passed, transcript: { identityCount: 3, uniqueKeyCount: new Set(keyDigests).size,
      uniqueDomainCount: new Set(roles.map((item) => item.independenceDomainDigest)).size,
      singlePurposeRoleCount: 3 } };
  }
  if (scenarioCode === "owner_policy_high_water") {
    const state = new RepositoryFakeCustodyStateV1();
    const advanceAccepted = state.advancePolicy(2);
    const rollbackAccepted = faultActive || state.advancePolicy(1);
    return { passed: advanceAccepted && !rollbackAccepted && state.policyRevision() === 2,
      transcript: { highWaterRevision: state.policyRevision(), advanceAccepted, rollbackAccepted } };
  }
  if (scenarioCode === "protected_clock_commit_boundary") {
    const clock = new RepositoryFakeProtectedClockV1();
    const firstAccepted = clock.observe(1_000), commitAccepted = clock.observe(1_020);
    const rollbackAccepted = faultActive || clock.observe(1_010);
    const expiredAtCommit = clock.current() > 1_015;
    return { passed: firstAccepted && commitAccepted && !rollbackAccepted && expiredAtCommit,
      transcript: { firstAccepted, commitAccepted, rollbackAccepted, expiredAtCommit,
        commitBoundaryTick: clock.current() } };
  }
  if (scenarioCode === "revocation_cross_process_convergence") {
    const state = new RepositoryFakeCustodyStateV1(); state.advancePolicy(2); state.revokeAt(2);
    const views = faultActive ? [2, 1, 2] : [2, 2, 2];
    const accepted = views.map((revision) => state.acceptsCredentialAt(revision));
    return { passed: accepted.every((value) => !value), transcript: { processViews: views,
      credentialAcceptedCount: accepted.filter(Boolean).length, revocationHighWater: 2 } };
  }
  if (scenarioCode === "serializable_claim_uniqueness") {
    const state = new RepositoryFakeCustodyStateV1();
    const accepted = PROCESS_IDS_V1.map((processId) => state.claim(processId));
    if (faultActive) accepted[1] = true;
    return { passed: accepted.filter(Boolean).length === 1,
      transcript: { processCount: 3, acceptedClaimCount: accepted.filter(Boolean).length,
        deterministicOwnerIndex: accepted.findIndex(Boolean) } };
  }
  if (scenarioCode === "checkpoint_compare_and_swap") {
    const state = new RepositoryFakeCustodyStateV1();
    const advanceAccepted = state.advanceCheckpoint(1, 2);
    const staleCompareAccepted = faultActive || state.advanceCheckpoint(1, 2);
    return { passed: advanceAccepted && !staleCompareAccepted && state.checkpointRevision() === 2,
      transcript: { advanceAccepted, staleCompareAccepted,
        checkpointRevision: state.checkpointRevision() } };
  }
  if (scenarioCode === "backup_restore_rollback_detection") {
    const state = new RepositoryFakeCustodyStateV1();
    const backupRevision = state.databaseRevision(); state.advancePolicy(2);
    state.advanceCheckpoint(1, 2);
    const restoredRevision = backupRevision;
    const rollbackDetected = !faultActive && restoredRevision < state.checkpointRevision();
    return { passed: rollbackDetected, transcript: { backupRevision, currentDatabaseRevision: state.databaseRevision(),
      restoredRevision, externalCheckpointRevision: state.checkpointRevision(), rollbackDetected } };
  }
  const state = new RepositoryFakeCustodyStateV1(); state.markDelivery();
  const destinationReceiptPresent = false;
  const terminalState = state.deliveryMarked() && !destinationReceiptPresent ? "ambiguous" : "unknown";
  const automaticRetryAllowed = faultActive;
  return { passed: terminalState === "ambiguous" && !automaticRetryAllowed,
    transcript: { deliveryMarkerCommitted: state.deliveryMarked(), destinationReceiptPresent,
      terminalState, automaticRetryAllowed } };
}

function buildScenarioResultsV1(fault: ReadyFrontierProductionCustodyFaultCodeV1,
  planDigest: string, runId: string, startedAt: string, completedAt: string):
  ReadyFrontierProductionCustodyScenarioResultV1[] {
  return readyFrontierProductionCustodyScenarioCodesV1.map((scenarioCode) => {
    const outcome = scenarioTranscriptV1(scenarioCode, fault);
    const safeFindingCode = outcome.passed ? "expected_boundary_observed" : faultForScenario[scenarioCode];
    return { scenarioCode, status: outcome.passed ? "simulated_pass" : "simulated_failure",
      safeFindingCode, processCount: 3,
      evidenceDigest: sha256Digest({ schema: "control-room-ready-frontier-production-custody-transcript/v1",
        planDigest, runId, startedAt, completedAt, scenarioCode, safeFindingCode,
        repositoryFakeOnly: true, transcript: outcome.transcript }) };
  });
}

export function buildReadyFrontierProductionCustodyPlanV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown):
  ReadyFrontierProductionCustodyPlanV1 {
  const qualificationKey = key(qualificationIntegrityKey);
  try {
    const input = parseExactReadyFrontierV1(planInputParserV1, inputValue);
    const assessment = parseReadyFrontierProductionBoundaryAssessmentV1(input.assessment,
      activationPacketIntegrityKey);
    if (Date.parse(input.plannedAt) < Date.parse(assessment.assessedAt)
      || Date.parse(input.expiresAt) <= Date.parse(input.plannedAt)
      || Date.parse(input.expiresAt) > Date.parse(assessment.planExpiresAt)
      || Date.parse(input.expiresAt) - Date.parse(input.plannedAt)
        > READY_FRONTIER_PRODUCTION_CUSTODY_MAX_LIFETIME_SECONDS_V1 * 1_000) fail("policy_denied");
    const material: Omit<ReadyFrontierProductionCustodyPlanV1, "planDigest" | "planAuthTag"> = {
      schema: READY_FRONTIER_PRODUCTION_CUSTODY_PLAN_V1,
      planId: input.planId,
      tenantId: assessment.tenantId,
      workspaceId: assessment.workspaceId,
      productionBoundaryPlanId: assessment.planId,
      productionBoundaryPlanDigest: assessment.planDigest,
      productionBoundaryAssessmentId: assessment.assessmentId,
      productionBoundaryAssessmentDigest: assessment.assessmentDigest,
      productionBoundaryAssessment: assessment,
      acceptedAuto060Commit: READY_FRONTIER_ACCEPTED_AUTO060_COMMIT_V1,
      acceptedAuto060ReviewSha256: READY_FRONTIER_ACCEPTED_AUTO060_REVIEW_SHA256_V1,
      qualificationMode: "repository_fake_only",
      databaseMode: "hosted_postgresql_required_unconfigured",
      transactionIsolationRequired: "serializable",
      ownerPolicyMode: "owner_signed_external_high_water_required",
      clockMode: "protected_monotonic_database_commit_required",
      revocationMode: "terminal_cross_process_high_water_required",
      checkpointMode: "external_compare_and_swap_required",
      restoreMode: "isolated_restore_then_reconcile_required",
      ambiguityMode: "post_marker_unknown_is_terminal_ambiguity",
      processCount: 3,
      processIds: [...PROCESS_IDS_V1],
      serviceRoles: serviceRolesV1(),
      scenarioCodes: [...readyFrontierProductionCustodyScenarioCodesV1],
      requiredProductionGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
      defaultDisabled: true, repositoryFakeOnly: true, liveQualificationAuthorized: false,
      productionConfigurationPresent: false, protectedMaterialPresent: false,
      productionKeysEnrolled: false, ownerPolicyEnrolled: false,
      hostedDatabaseContactAuthorized: false, networkAuthorized: false,
      consumerImplemented: false, activationAuthorized: false,
      permitsProtectedReferenceResolution: false, permitsClaimOrLease: false,
      permitsDispatchOrExecution: false, permitsExternalEffects: false,
      plannedAt: input.plannedAt, expiresAt: input.expiresAt,
    };
    const planDigest = sha256Digest(material);
    return parseReadyFrontierProductionCustodyPlanV1({ ...material, planDigest,
      planAuthTag: hmacSha256Tag(qualificationKey, planAuthMaterial({ ...material, planDigest })) },
    activationPacketIntegrityKey, qualificationKey);
  } finally { qualificationKey.fill(0); }
}

export function parseReadyFrontierProductionCustodyPlanV1(value: unknown,
  activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown):
  ReadyFrontierProductionCustodyPlanV1 {
  const qualificationKey = key(qualificationIntegrityKey);
  try {
    const plan = parseExactReadyFrontierV1(planParserV1, value) as ReadyFrontierProductionCustodyPlanV1;
    const assessment = parseReadyFrontierProductionBoundaryAssessmentV1(
      plan.productionBoundaryAssessment, activationPacketIntegrityKey);
    if (plan.tenantId !== assessment.tenantId || plan.workspaceId !== assessment.workspaceId
      || plan.productionBoundaryPlanId !== assessment.planId
      || plan.productionBoundaryPlanDigest !== assessment.planDigest
      || plan.productionBoundaryAssessmentId !== assessment.assessmentId
      || plan.productionBoundaryAssessmentDigest !== assessment.assessmentDigest
      || Date.parse(plan.plannedAt) < Date.parse(assessment.assessedAt)
      || Date.parse(plan.expiresAt) > Date.parse(assessment.planExpiresAt)
      || !sameList(plan.processIds, PROCESS_IDS_V1)
      || canonicalJson(plan.serviceRoles) !== canonicalJson(serviceRolesV1())
      || !sameList(plan.scenarioCodes, readyFrontierProductionCustodyScenarioCodesV1)
      || !sameList(plan.requiredProductionGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
      || Date.parse(plan.expiresAt) <= Date.parse(plan.plannedAt)
      || Date.parse(plan.expiresAt) - Date.parse(plan.plannedAt)
        > READY_FRONTIER_PRODUCTION_CUSTODY_MAX_LIFETIME_SECONDS_V1 * 1_000
      || !sameText(plan.planDigest, sha256Digest(planUnsigned(plan)))
      || !sameText(plan.planAuthTag, hmacSha256Tag(qualificationKey, planAuthMaterial(plan)))) {
      fail("digest_mismatch");
    }
    return deepFreeze(plan);
  } finally { qualificationKey.fill(0); }
}

export function runReadyFrontierProductionCustodyFakeQualificationV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown):
  ReadyFrontierProductionCustodyReportV1 {
  const qualificationKey = key(qualificationIntegrityKey);
  try {
    const input = parseExactReadyFrontierV1(runInputParserV1, inputValue);
    const plan = parseReadyFrontierProductionCustodyPlanV1(input.plan, activationPacketIntegrityKey,
      qualificationKey);
    const injectedFault = input.injectedFault ?? "none";
    if (Date.parse(input.startedAt) < Date.parse(plan.plannedAt)
      || Date.parse(input.completedAt) < Date.parse(input.startedAt)
      || Date.parse(input.completedAt) >= Date.parse(plan.expiresAt)) fail("policy_denied");
    const scenarioResults = buildScenarioResultsV1(injectedFault, plan.planDigest, input.runId,
      input.startedAt, input.completedAt);
    const simulatedPassCount = scenarioResults.filter((item) => item.status === "simulated_pass").length;
    const simulatedFailureCount = scenarioResults.length - simulatedPassCount;
    const reportId = `frontier.production-custody-report.${sha256Digest({ runId: input.runId,
      planDigest: plan.planDigest }).slice(7, 31)}`;
    const material: Omit<ReadyFrontierProductionCustodyReportV1, "reportDigest" | "reportAuthTag"> = {
      schema: READY_FRONTIER_PRODUCTION_CUSTODY_REPORT_V1,
      reportId, runId: input.runId, planId: plan.planId, planDigest: plan.planDigest,
      tenantId: plan.tenantId, workspaceId: plan.workspaceId,
      productionBoundaryAssessmentId: plan.productionBoundaryAssessmentId,
      productionBoundaryAssessmentDigest: plan.productionBoundaryAssessmentDigest,
      qualificationMode: "repository_fake_only", injectedFault,
      status: simulatedFailureCount === 0 ? "simulated_pass" : "simulated_failure",
      scenarioResults, simulatedPassCount, simulatedFailureCount,
      blockingGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
      qualifiedProofCount: 0, remainingQualifiedProofCount: 9,
      state: "blocked_fake_qualification_only",
      safeReason: "protected_production_qualification_not_run",
      liveQualificationPerformed: false, productionDatabaseContacted: false,
      productionClockContacted: false, productionKeyStoreContacted: false,
      productionCheckpointContacted: false, ownerPolicyRead: false, ownerApprovalIssued: false,
      protectedReferenceResolutionAttempted: false, consumerConstructed: false,
      claimOrLeaseAttempted: false, dispatchOrExecutionAttempted: false,
      networkContacted: false, externalEffectOccurred: false,
      grantsApproval: false, grantsActivationAuthority: false, grantsClaimOrLease: false,
      grantsDispatchOrExecution: false, grantsExternalEffects: false,
      startedAt: input.startedAt, completedAt: input.completedAt,
    };
    const reportDigest = sha256Digest(material);
    return parseReadyFrontierProductionCustodyReportV1({ ...material, reportDigest,
      reportAuthTag: hmacSha256Tag(qualificationKey, reportAuthMaterial({ ...material, reportDigest })) },
    plan, activationPacketIntegrityKey, qualificationKey);
  } finally { qualificationKey.fill(0); }
}

export function parseReadyFrontierProductionCustodyReportV1(value: unknown,
  planValue: unknown, activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown):
  ReadyFrontierProductionCustodyReportV1 {
  const qualificationKey = key(qualificationIntegrityKey);
  try {
    const plan = parseReadyFrontierProductionCustodyPlanV1(planValue, activationPacketIntegrityKey,
      qualificationKey);
    const report = parseExactReadyFrontierV1(reportParserV1, value) as ReadyFrontierProductionCustodyReportV1;
    const expectedResults = buildScenarioResultsV1(report.injectedFault, plan.planDigest, report.runId,
      report.startedAt, report.completedAt);
    const passCount = report.scenarioResults.filter((item) => item.status === "simulated_pass").length;
    const expectedId = `frontier.production-custody-report.${sha256Digest({ runId: report.runId,
      planDigest: plan.planDigest }).slice(7, 31)}`;
    if (report.reportId !== expectedId || report.planId !== plan.planId || report.planDigest !== plan.planDigest
      || report.tenantId !== plan.tenantId || report.workspaceId !== plan.workspaceId
      || report.productionBoundaryAssessmentId !== plan.productionBoundaryAssessmentId
      || report.productionBoundaryAssessmentDigest !== plan.productionBoundaryAssessmentDigest
      || Date.parse(report.startedAt) < Date.parse(plan.plannedAt)
      || Date.parse(report.completedAt) < Date.parse(report.startedAt)
      || Date.parse(report.completedAt) >= Date.parse(plan.expiresAt)
      || !sameList(report.scenarioResults.map((item) => item.scenarioCode),
        readyFrontierProductionCustodyScenarioCodesV1)
      || canonicalJson(report.scenarioResults) !== canonicalJson(expectedResults)
      || report.simulatedPassCount !== passCount
      || report.simulatedFailureCount !== 8 - passCount
      || report.status !== (passCount === 8 ? "simulated_pass" : "simulated_failure")
      || !sameList(report.blockingGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
      || !sameText(report.reportDigest, sha256Digest(reportUnsigned(report)))
      || !sameText(report.reportAuthTag, hmacSha256Tag(qualificationKey, reportAuthMaterial(report)))) {
      fail("digest_mismatch");
    }
    return deepFreeze(report);
  } finally { qualificationKey.fill(0); }
}

export function projectReadyFrontierProductionCustodyReportV1(reportValue: unknown,
  planValue: unknown, activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown):
  ReadyFrontierProductionCustodyProjectionV1 {
  const report = parseReadyFrontierProductionCustodyReportV1(reportValue, planValue,
    activationPacketIntegrityKey, qualificationIntegrityKey);
  const material: Omit<ReadyFrontierProductionCustodyProjectionV1, "projectionDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_CUSTODY_PROJECTION_V1,
    tenantId: report.tenantId, workspaceId: report.workspaceId,
    planId: report.planId, reportId: report.reportId, status: report.state,
    safeReason: report.safeReason,
    scenarioStatuses: report.scenarioResults.map(({ scenarioCode, status }) => ({ scenarioCode, status })),
    blockingGateCodes: [...report.blockingGateCodes],
    qualifiedProofCount: 0, remainingQualifiedProofCount: 9,
    canRunLiveQualification: false, canEnrollProductionKeys: false,
    canEnrollOwnerPolicy: false, canContactHostedDatabase: false,
    canActivateProduction: false, canConstructConsumer: false,
    canResolveProtectedReferences: false, canContactNetwork: false,
    canClaimOrLease: false, canDispatchOrExecute: false,
  };
  const projection = parseExactReadyFrontierV1(projectionParserV1,
    { ...material, projectionDigest: sha256Digest(material) }) as ReadyFrontierProductionCustodyProjectionV1;
  return deepFreeze(projection);
}
