import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { exactProjectWorkspaceJsonV1 } from "../../project-workspace/v1/exact";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { dataMethodV1, exactHostUint8ArrayV1 } from "../../security/host-value";
import {
  ROLLBACK_CHECKPOINT_SCHEMA_V1,
  rollbackCheckpointDigestV1,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security/rollback-checkpoint";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import {
  parseOperationsDeploymentPlanV1,
  parseOperationsDeploymentReadinessAssessmentV1,
} from "./deployment";
import { parseOperationsRollbackPlanV1 } from "./recovery";

export const OPERATIONS_CANARY_ROLLBACK_PLANNER_V1 = "control-room-operations-canary-rollback-planner/v1" as const;
export const OPERATIONS_CANARY_ROLLBACK_STEP_IDS_V1 = [
  "verify_exact_readiness",
  "ask_canary_window",
  "propose_forward_migration",
  "propose_one_host_canary",
  "observe_independent_canary",
  "ask_promote_or_rollback",
  "prepare_selected_branch",
  "reconcile_terminal_evidence",
] as const;
export const OPERATIONS_CANARY_ROLLBACK_ACTIONS_V1 = [
  "forward_migration_candidate",
  "one_host_canary_candidate",
  "promotion_candidate",
  "application_rollback_candidate",
] as const;
export const OPERATIONS_CANARY_ROLLBACK_QUESTION_IDS_V1 = [
  "question:operations:open-canary-window",
  "question:operations:choose-after-canary",
  "question:operations:acknowledge-terminal-evidence",
] as const;

export type OperationsCanaryRollbackStepIdV1 = (typeof OPERATIONS_CANARY_ROLLBACK_STEP_IDS_V1)[number];
export type OperationsCanaryRollbackActionV1 = (typeof OPERATIONS_CANARY_ROLLBACK_ACTIONS_V1)[number];
export type OperationsCanaryRollbackQuestionIdV1 = (typeof OPERATIONS_CANARY_ROLLBACK_QUESTION_IDS_V1)[number];

export interface OperationsCanaryRollbackStepV1 {
  stepId: OperationsCanaryRollbackStepIdV1;
  position: number;
  kind: "evidence_check" | "owner_question" | "effect_proposal" | "reconciliation";
  requiresPreviousStep: boolean;
  safeInstructionCode: string;
  performsAction: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  stepDigest: string;
}

export interface OperationsCanaryRollbackOwnerQuestionV1 {
  questionId: OperationsCanaryRollbackQuestionIdV1;
  position: number;
  safePromptCode: string;
  choices: string[];
  requiresFreshStrongOwnerDecision: true;
  responseRecorded: false;
  responseIsApproval: false;
  performsAction: false;
  questionDigest: string;
}

export interface OperationsPlannedEffectIntentV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  intentId: string;
  plannerId: string;
  plannerDigestBasis: string;
  position: number;
  action: OperationsCanaryRollbackActionV1;
  topologyDigest: string;
  deploymentPlanDigest: string;
  rollbackPlanDigest: string;
  currentReleaseDigest: string;
  previousReleaseDigest: string;
  requiresFreshExternalAuthority: true;
  requiresPreEffectClaim: true;
  requiresPreEffectMarker: true;
  requiresIndependentReceipt: true;
  automaticDispatchAllowed: false;
  automaticRetryAllowed: false;
  commandLines: [];
  targetPresent: false;
  credentialReferencePresent: false;
  authorized: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsRollbackAuthority: false;
  grantsExecutionAuthority: false;
  expiresAt: string;
  intentDigest: string;
}

export interface OperationsCanaryRollbackPlannerV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  plannerId: string;
  deploymentId: string;
  topologyDigest: string;
  deploymentPlanDigest: string;
  readinessAssessmentDigest: string;
  rollbackPlanDigest: string;
  currentReleaseDigest: string;
  previousReleaseDigest: string;
  databaseDisposition: "unchanged_verified";
  strategy: "one_host_canary_then_separate_owner_branch";
  steps: OperationsCanaryRollbackStepV1[];
  ownerQuestions: OperationsCanaryRollbackOwnerQuestionV1[];
  intents: OperationsPlannedEffectIntentV1[];
  canaryHostLimit: 1;
  automaticPromotionAllowed: false;
  automaticRollbackAllowed: false;
  databaseDownMigrationAllowed: false;
  databaseRestoreIncluded: false;
  automaticRetryAfterChange: false;
  unknownAfterChange: "terminal_ambiguity";
  plannerOnly: true;
  commandsPresent: false;
  executorPresent: false;
  serviceClientPresent: false;
  databaseClientPresent: false;
  providerClientPresent: false;
  networkClientPresent: false;
  authorized: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsRollbackAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  expiresAt: string;
  plannerDigest: string;
}

const stepId = z.enum(OPERATIONS_CANARY_ROLLBACK_STEP_IDS_V1), action = z.enum(OPERATIONS_CANARY_ROLLBACK_ACTIONS_V1),
  questionId = z.enum(OPERATIONS_CANARY_ROLLBACK_QUESTION_IDS_V1);
const stepSchema = z.object({ stepId, position: z.number().int().min(0).max(7),
  kind: z.enum(["evidence_check", "owner_question", "effect_proposal", "reconciliation"]),
  requiresPreviousStep: z.boolean(), safeInstructionCode: id, performsAction: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), stepDigest: digest }).strict();
const questionSchema = z.object({ questionId, position: z.number().int().min(0).max(2), safePromptCode: id,
  choices: z.array(id).min(2).max(3), requiresFreshStrongOwnerDecision: z.literal(true), responseRecorded: z.literal(false),
  responseIsApproval: z.literal(false), performsAction: z.literal(false), questionDigest: digest }).strict();
const intentSchema = z.object({ contractVersion: z.literal(OPERATIONS_CANARY_ROLLBACK_PLANNER_V1), intentId: id,
  plannerId: id, plannerDigestBasis: digest, position: z.number().int().min(0).max(3), action,
  topologyDigest: digest, deploymentPlanDigest: digest, rollbackPlanDigest: digest, currentReleaseDigest: digest,
  previousReleaseDigest: digest, requiresFreshExternalAuthority: z.literal(true), requiresPreEffectClaim: z.literal(true),
  requiresPreEffectMarker: z.literal(true), requiresIndependentReceipt: z.literal(true),
  automaticDispatchAllowed: z.literal(false), automaticRetryAllowed: z.literal(false), commandLines: z.tuple([]),
  targetPresent: z.literal(false), credentialReferencePresent: z.literal(false), authorized: z.literal(false),
  grantsApproval: z.literal(false), grantsDeploymentAuthority: z.literal(false), grantsRollbackAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), expiresAt: time, intentDigest: digest }).strict();
const plannerInputSchema = z.object({ plannerId: id, deploymentPlan: z.unknown(), readinessAssessment: z.unknown(),
  rollbackPlan: z.unknown(), createdAt: time, expiresAt: time }).strict();
const plannerSchema = z.object({ contractVersion: z.literal(OPERATIONS_CANARY_ROLLBACK_PLANNER_V1), plannerId: id,
  deploymentId: id, topologyDigest: digest, deploymentPlanDigest: digest, readinessAssessmentDigest: digest,
  rollbackPlanDigest: digest, currentReleaseDigest: digest, previousReleaseDigest: digest,
  databaseDisposition: z.literal("unchanged_verified"), strategy: z.literal("one_host_canary_then_separate_owner_branch"),
  steps: z.array(stepSchema).length(8), ownerQuestions: z.array(questionSchema).length(3), intents: z.array(intentSchema).length(4),
  canaryHostLimit: z.literal(1), automaticPromotionAllowed: z.literal(false), automaticRollbackAllowed: z.literal(false),
  databaseDownMigrationAllowed: z.literal(false), databaseRestoreIncluded: z.literal(false),
  automaticRetryAfterChange: z.literal(false), unknownAfterChange: z.literal("terminal_ambiguity"), plannerOnly: z.literal(true),
  commandsPresent: z.literal(false), executorPresent: z.literal(false), serviceClientPresent: z.literal(false),
  databaseClientPresent: z.literal(false), providerClientPresent: z.literal(false), networkClientPresent: z.literal(false),
  authorized: z.literal(false), grantsApproval: z.literal(false), grantsDeploymentAuthority: z.literal(false),
  grantsRollbackAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), createdAt: time, expiresAt: time,
  plannerDigest: digest }).strict();

const stepKinds = ["evidence_check", "owner_question", "effect_proposal", "effect_proposal", "evidence_check",
  "owner_question", "effect_proposal", "reconciliation"] as const;
const stepCodes = ["verify_all_eighteen_exact_current_gates", "request_fresh_external_canary_authority",
  "prepare_forward_only_migration_proposal", "prepare_exactly_one_host_canary_proposal",
  "require_independent_canary_observation", "request_separate_promote_or_rollback_decision",
  "prepare_only_the_owner_selected_branch", "reconcile_receipts_or_stop_ambiguous"] as const;
const questionCodes = ["confirm_external_canary_window", "choose_promote_rollback_or_stop",
  "acknowledge_terminal_evidence_without_retry"] as const;
const questionChoices = [
  ["continue_to_external_authority_review", "stop"],
  ["promote_candidate", "prepare_application_rollback_candidate", "stop_and_reconcile"],
  ["acknowledge_evidence_only", "stop"],
] as const;

function fixedSteps(): OperationsCanaryRollbackStepV1[] {
  return OPERATIONS_CANARY_ROLLBACK_STEP_IDS_V1.map((currentStepId, position) => {
    const material: Omit<OperationsCanaryRollbackStepV1, "stepDigest"> = { stepId: currentStepId, position,
      kind: stepKinds[position]!, requiresPreviousStep: position > 0, safeInstructionCode: stepCodes[position]!,
      performsAction: false, grantsApproval: false, grantsDeploymentAuthority: false, grantsExecutionAuthority: false };
    return { ...material, stepDigest: sha256Digest(material) };
  });
}

function fixedQuestions(): OperationsCanaryRollbackOwnerQuestionV1[] {
  return OPERATIONS_CANARY_ROLLBACK_QUESTION_IDS_V1.map((currentQuestionId, position) => {
    const material: Omit<OperationsCanaryRollbackOwnerQuestionV1, "questionDigest"> = { questionId: currentQuestionId,
      position, safePromptCode: questionCodes[position]!, choices: [...questionChoices[position]!],
      requiresFreshStrongOwnerDecision: true, responseRecorded: false, responseIsApproval: false, performsAction: false };
    return { ...material, questionDigest: sha256Digest(material) };
  });
}

const trustedPlanners = new WeakSet<object>(), trustedIntents = new WeakSet<object>();

function buildIntents(input: { plannerId: string; topologyDigest: string; deploymentPlanDigest: string;
  rollbackPlanDigest: string; currentReleaseDigest: string; previousReleaseDigest: string; expiresAt: string }): OperationsPlannedEffectIntentV1[] {
  const plannerDigestBasis = sha256Digest(input);
  return OPERATIONS_CANARY_ROLLBACK_ACTIONS_V1.map((currentAction, position) => {
    const material: Omit<OperationsPlannedEffectIntentV1, "intentDigest"> = {
      contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1,
      intentId: `intent:operations:${currentAction.replaceAll("_", "-")}:${plannerDigestBasis.slice(7, 23)}`,
      plannerId: input.plannerId, plannerDigestBasis, position, action: currentAction, topologyDigest: input.topologyDigest,
      deploymentPlanDigest: input.deploymentPlanDigest, rollbackPlanDigest: input.rollbackPlanDigest,
      currentReleaseDigest: input.currentReleaseDigest, previousReleaseDigest: input.previousReleaseDigest,
      requiresFreshExternalAuthority: true, requiresPreEffectClaim: true, requiresPreEffectMarker: true,
      requiresIndependentReceipt: true, automaticDispatchAllowed: false, automaticRetryAllowed: false, commandLines: [],
      targetPresent: false, credentialReferencePresent: false, authorized: false, grantsApproval: false,
      grantsDeploymentAuthority: false, grantsRollbackAuthority: false, grantsExecutionAuthority: false, expiresAt: input.expiresAt };
    return parseOperationsPlannedEffectIntentV1({ ...material, intentDigest: sha256Digest(material) });
  });
}

export function parseOperationsPlannedEffectIntentV1(value: unknown): OperationsPlannedEffectIntentV1 {
  const parsed = parseExactOperationsV1(intentSchema, value, "operations planned effect intent");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "intentDigest", parsed.intentDigest);
  return parsed;
}

export function buildOperationsCanaryRollbackPlannerV1(inputValue: unknown): OperationsCanaryRollbackPlannerV1 {
  const input = parseExactOperationsV1(plannerInputSchema, inputValue, "operations canary rollback planner input"),
    deployment = parseOperationsDeploymentPlanV1(input.deploymentPlan),
    readiness = parseOperationsDeploymentReadinessAssessmentV1(input.readinessAssessment),
    rollback = parseOperationsRollbackPlanV1(input.rollbackPlan), ownerGate = readiness.prerequisites.at(-1);
  if (readiness.readiness !== "candidate_for_owner_window" || !readiness.eligibleForOwnerWindow
    || readiness.planDigest !== deployment.planDigest || readiness.deploymentId !== deployment.deploymentId
    || readiness.topologyDigest !== deployment.topologyDigest || readiness.releaseDigest !== deployment.releaseDigest
    || rollback.deploymentId !== deployment.deploymentId || rollback.topologyDigest !== deployment.topologyDigest
    || rollback.currentReleaseDigest !== deployment.releaseDigest || rollback.previousReleaseDigest !== deployment.previousReleaseDigest
    || rollback.databaseDisposition !== "unchanged_verified" || rollback.backupDigest
    || ownerGate?.gateId !== "fresh_owner_window" || ownerGate.state !== "met" || !ownerGate.validUntil
    || Date.parse(input.createdAt) < Date.parse(readiness.assessedAt) || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)
    || Date.parse(input.expiresAt) > Date.parse(ownerGate.validUntil) || Date.parse(input.expiresAt) > Date.parse(deployment.expiresAt)
    || Date.parse(input.expiresAt) > Date.parse(rollback.expiresAt)) throw new OperationsContractErrorV1("scope_mismatch");
  const intents = buildIntents({ plannerId: input.plannerId, topologyDigest: deployment.topologyDigest,
    deploymentPlanDigest: deployment.planDigest, rollbackPlanDigest: rollback.rollbackPlanDigest,
    currentReleaseDigest: deployment.releaseDigest, previousReleaseDigest: deployment.previousReleaseDigest,
    expiresAt: input.expiresAt });
  const material: Omit<OperationsCanaryRollbackPlannerV1, "plannerDigest"> = {
    contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1, plannerId: input.plannerId, deploymentId: deployment.deploymentId,
    topologyDigest: deployment.topologyDigest, deploymentPlanDigest: deployment.planDigest,
    readinessAssessmentDigest: readiness.assessmentDigest, rollbackPlanDigest: rollback.rollbackPlanDigest,
    currentReleaseDigest: deployment.releaseDigest, previousReleaseDigest: deployment.previousReleaseDigest!,
    databaseDisposition: "unchanged_verified", strategy: "one_host_canary_then_separate_owner_branch",
    steps: fixedSteps(), ownerQuestions: fixedQuestions(), intents, canaryHostLimit: 1, automaticPromotionAllowed: false,
    automaticRollbackAllowed: false, databaseDownMigrationAllowed: false, databaseRestoreIncluded: false,
    automaticRetryAfterChange: false, unknownAfterChange: "terminal_ambiguity", plannerOnly: true, commandsPresent: false,
    executorPresent: false, serviceClientPresent: false, databaseClientPresent: false, providerClientPresent: false,
    networkClientPresent: false, authorized: false, grantsApproval: false, grantsDeploymentAuthority: false,
    grantsRollbackAuthority: false, grantsExecutionAuthority: false, createdAt: input.createdAt, expiresAt: input.expiresAt };
  const planner = parseOperationsCanaryRollbackPlannerV1({ ...material, plannerDigest: sha256Digest(material) });
  trustedPlanners.add(planner as object); planner.intents.forEach((intent) => trustedIntents.add(intent as object));
  return planner;
}

export function parseOperationsCanaryRollbackPlannerV1(value: unknown): OperationsCanaryRollbackPlannerV1 {
  const parsed = parseExactOperationsV1(plannerSchema, value, "operations canary rollback planner"), expectedSteps = fixedSteps(),
    expectedQuestions = fixedQuestions(), expectedIntents = buildIntents({ plannerId: parsed.plannerId,
      topologyDigest: parsed.topologyDigest, deploymentPlanDigest: parsed.deploymentPlanDigest,
      rollbackPlanDigest: parsed.rollbackPlanDigest, currentReleaseDigest: parsed.currentReleaseDigest,
      previousReleaseDigest: parsed.previousReleaseDigest, expiresAt: parsed.expiresAt });
  if (JSON.stringify(parsed.steps) !== JSON.stringify(expectedSteps) || JSON.stringify(parsed.ownerQuestions) !== JSON.stringify(expectedQuestions)
    || JSON.stringify(parsed.intents) !== JSON.stringify(expectedIntents) || Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  parsed.intents.forEach(parseOperationsPlannedEffectIntentV1);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "plannerDigest", parsed.plannerDigest);
  return parsed;
}

export type OperationsIntentStateV1 = "proposed" | "claimed" | "marked" | "completed_evidence_only" |
  "failed_before_change" | "failed" | "ambiguous";
export type OperationsIntentReceiptOutcomeV1 = "forward_migration_verified" | "canary_passed" | "canary_failed" |
  "promotion_verified" | "application_rollback_verified" | "definite_failure" | "unknown_after_change";

export interface OperationsIntentClaimV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  claimId: string;
  intentId: string;
  intentDigest: string;
  claimEvidenceDigest: string;
  recordedAt: string;
  evidenceOnly: true;
  dispatchAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  claimDigest: string;
}

export interface OperationsIntentMarkerV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  intentId: string;
  intentDigest: string;
  markerEvidenceDigest: string;
  recordedAt: string;
  effectReportedByExternalBoundary: true;
  effectPerformedByPlanner: false;
  grantsExecutionAuthority: false;
  markerDigest: string;
}

export interface OperationsIntentReceiptV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  intentId: string;
  intentDigest: string;
  outcome: OperationsIntentReceiptOutcomeV1;
  effectReceiptDigest?: string;
  independentVerificationDigest?: string;
  recordedAt: string;
  evidenceOnly: true;
  performsAction: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsRollbackAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface OperationsIntentRecordV1 {
  intent: OperationsPlannedEffectIntentV1;
  state: OperationsIntentStateV1;
  claim?: OperationsIntentClaimV1;
  marker?: OperationsIntentMarkerV1;
  receipt?: OperationsIntentReceiptV1;
  updatedAt: string;
}

const receiptOutcome = z.enum(["forward_migration_verified", "canary_passed", "canary_failed", "promotion_verified",
  "application_rollback_verified", "definite_failure", "unknown_after_change"]);
const claimSchema = z.object({ contractVersion: z.literal(OPERATIONS_CANARY_ROLLBACK_PLANNER_V1), claimId: id,
  intentId: id, intentDigest: digest, claimEvidenceDigest: digest, recordedAt: time, evidenceOnly: z.literal(true),
  dispatchAuthorized: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  claimDigest: digest }).strict();
const markerSchema = z.object({ contractVersion: z.literal(OPERATIONS_CANARY_ROLLBACK_PLANNER_V1), intentId: id,
  intentDigest: digest, markerEvidenceDigest: digest, recordedAt: time, effectReportedByExternalBoundary: z.literal(true),
  effectPerformedByPlanner: z.literal(false), grantsExecutionAuthority: z.literal(false), markerDigest: digest }).strict();
const receiptSchema = z.object({ contractVersion: z.literal(OPERATIONS_CANARY_ROLLBACK_PLANNER_V1), intentId: id,
  intentDigest: digest, outcome: receiptOutcome, effectReceiptDigest: digest.optional(), independentVerificationDigest: digest.optional(),
  recordedAt: time, evidenceOnly: z.literal(true), performsAction: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsRollbackAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  receiptDigest: digest }).strict();
const recordSchema = z.object({ intent: intentSchema, state: z.enum(["proposed", "claimed", "marked", "completed_evidence_only",
  "failed_before_change", "failed", "ambiguous"]), claim: claimSchema.optional(), marker: markerSchema.optional(),
  receipt: receiptSchema.optional(), updatedAt: time }).strict();

function parseClaim(value: unknown): OperationsIntentClaimV1 {
  const parsed = parseExactOperationsV1(claimSchema, value, "operations effect intent claim");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "claimDigest", parsed.claimDigest); return parsed;
}
function parseMarker(value: unknown): OperationsIntentMarkerV1 {
  const parsed = parseExactOperationsV1(markerSchema, value, "operations effect intent marker");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "markerDigest", parsed.markerDigest); return parsed;
}
function parseReceipt(value: unknown): OperationsIntentReceiptV1 {
  const parsed = parseExactOperationsV1(receiptSchema, value, "operations effect intent receipt"), complete = parsed.outcome !== "unknown_after_change";
  if (complete !== Boolean(parsed.effectReceiptDigest && parsed.independentVerificationDigest)
    || (!complete && (parsed.effectReceiptDigest || parsed.independentVerificationDigest))) throw new OperationsContractErrorV1("invalid_input");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "receiptDigest", parsed.receiptDigest); return parsed;
}
function parseRecord(value: unknown): OperationsIntentRecordV1 {
  const parsed = parseExactOperationsV1(recordSchema, value, "operations effect intent record");
  parseOperationsPlannedEffectIntentV1(parsed.intent); const claim = parsed.claim ? parseClaim(parsed.claim) : undefined,
    marker = parsed.marker ? parseMarker(parsed.marker) : undefined, receipt = parsed.receipt ? parseReceipt(parsed.receipt) : undefined;
  if ((parsed.state === "proposed" && (claim || marker || receipt)) || (parsed.state === "claimed" && (!claim || marker || receipt))
    || (parsed.state === "marked" && (!claim || !marker || receipt))
    || (["completed_evidence_only", "failed", "ambiguous"].includes(parsed.state) && (!claim || !marker || !receipt))
    || (parsed.state === "failed_before_change" && (!claim || marker || !receipt))
    || claim && (claim.intentId !== parsed.intent.intentId || claim.intentDigest !== parsed.intent.intentDigest)
    || marker && (marker.intentId !== parsed.intent.intentId || marker.intentDigest !== parsed.intent.intentDigest)
    || receipt && (receipt.intentId !== parsed.intent.intentId || receipt.intentDigest !== parsed.intent.intentDigest)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  return parsed;
}

export interface OperationsEffectIntentLedgerSnapshotV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  ledgerIdentityDigest: string;
  revision: number;
  highWaterAt: string;
  records: OperationsIntentRecordV1[];
  stateAuthTag: string;
  snapshotDigest: string;
}
const authTag = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
const ledgerSnapshotSchema = z.object({ contractVersion: z.literal(OPERATIONS_CANARY_ROLLBACK_PLANNER_V1),
  ledgerIdentityDigest: digest, revision: z.number().int().positive(), highWaterAt: time,
  records: z.array(recordSchema).max(4), stateAuthTag: authTag, snapshotDigest: digest }).strict();
function parseLedgerSnapshot(value: unknown): OperationsEffectIntentLedgerSnapshotV1 {
  const parsed = parseExactOperationsV1(ledgerSnapshotSchema, value, "operations effect intent ledger snapshot");
  parsed.records.forEach(parseRecord);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "snapshotDigest", parsed.snapshotDigest);
  return parsed;
}

export interface OperationsIntentMemoryPortV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  portId: string;
  testOnly: true;
}
interface LedgerState { ledgerIdentityDigest: string; revision: number; highWaterAt: string; records: OperationsIntentRecordV1[]; stateAuthTag: string; }
const memoryPorts = new WeakMap<object, LedgerState | undefined>();
const equalTag = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createOperationsIntentMemoryPortV1(portId: string): OperationsIntentMemoryPortV1 {
  const port = parseExactOperationsV1(z.object({ contractVersion: z.literal(OPERATIONS_CANARY_ROLLBACK_PLANNER_V1),
    portId: id, testOnly: z.literal(true) }).strict(), { contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1,
    portId, testOnly: true }, "operations intent memory port");
  memoryPorts.set(port as object, undefined); return Object.freeze(port);
}

export function createOperationsIntentMemoryPortFromSnapshotV1(portId: string,
  snapshotValue: unknown): OperationsIntentMemoryPortV1 {
  const snapshot = parseLedgerSnapshot(snapshotValue), port = createOperationsIntentMemoryPortV1(portId);
  memoryPorts.set(port as object, { ledgerIdentityDigest: snapshot.ledgerIdentityDigest, revision: snapshot.revision,
    highWaterAt: snapshot.highWaterAt, records: snapshot.records, stateAuthTag: snapshot.stateAuthTag });
  return port;
}

const terminalStates = new Set<OperationsIntentStateV1>(["completed_evidence_only", "failed_before_change", "failed", "ambiguous"]);
const validOutcomes: Record<OperationsCanaryRollbackActionV1, OperationsIntentReceiptOutcomeV1[]> = {
  forward_migration_candidate: ["forward_migration_verified", "definite_failure", "unknown_after_change"],
  one_host_canary_candidate: ["canary_passed", "canary_failed", "definite_failure", "unknown_after_change"],
  promotion_candidate: ["promotion_verified", "definite_failure", "unknown_after_change"],
  application_rollback_candidate: ["application_rollback_verified", "definite_failure", "unknown_after_change"],
};

export class OperationsEffectIntentLedgerV1 {
  readonly #key: Uint8Array;
  readonly #port: OperationsIntentMemoryPortV1;
  readonly #clock: () => string;
  readonly #checkpointRead: RollbackCheckpointStoreV1["read"];
  readonly #checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  readonly #checkpointAdvance: RollbackCheckpointStoreV1["advance"];

  constructor(port: OperationsIntentMemoryPortV1, ledgerIdentityDigest: string, options: {
    integrityKey: Uint8Array; checkpointStore: RollbackCheckpointStoreV1;
    mode: "create" | "open"; testOnly: true; clock?: () => string;
  }) {
    if (!memoryPorts.has(port as object) || options.testOnly !== true || !digest.safeParse(ledgerIdentityDigest).success) {
      throw new Error("operations intent ledger is test-only");
    }
    const observedKey = exactHostUint8ArrayV1(options.integrityKey, 64);
    if (!observedKey || observedKey.byteLength < 32) throw new Error("operations intent ledger integrity key invalid");
    this.#key = observedKey.copy(); hmacSha256Tag(this.#key, { purpose: "operations-intent-ledger-key-check" });
    this.#port = port; this.#clock = options.clock ?? (() => new Date().toISOString());
    const checkpointRead = dataMethodV1(options.checkpointStore, "read"),
      checkpointInitialize = dataMethodV1(options.checkpointStore, "initialize"),
      checkpointAdvance = dataMethodV1(options.checkpointStore, "advance");
    if (!checkpointRead || !checkpointInitialize || !checkpointAdvance) throw new Error("operations intent checkpoint invalid");
    this.#checkpointRead = ((scope: string) => Reflect.apply(checkpointRead, options.checkpointStore, [scope])) as RollbackCheckpointStoreV1["read"];
    this.#checkpointInitialize = ((checkpoint: RollbackCheckpointV1) => Reflect.apply(checkpointInitialize,
      options.checkpointStore, [checkpoint])) as RollbackCheckpointStoreV1["initialize"];
    this.#checkpointAdvance = ((expected: string, checkpoint: RollbackCheckpointV1) => Reflect.apply(checkpointAdvance,
      options.checkpointStore, [expected, checkpoint])) as RollbackCheckpointStoreV1["advance"];
    const state = memoryPorts.get(port as object);
    try {
      if (options.mode === "create") {
        if (state) throw new Error("operations intent ledger already exists");
        const initial: LedgerState = { ledgerIdentityDigest, revision: 1, highWaterAt: "1970-01-01T00:00:00.000Z",
          records: [], stateAuthTag: "" };
        initial.stateAuthTag = this.tag(initial); memoryPorts.set(port as object, initial);
        this.#checkpointInitialize(this.checkpoint(initial));
      } else {
        if (!state || state.ledgerIdentityDigest !== ledgerIdentityDigest) throw new Error("operations intent ledger missing or foreign");
        this.assertState(); this.reconcileInterrupted();
      }
    } catch (error) {
      if (options.mode === "create") memoryPorts.set(port as object, undefined);
      this.#key.fill(0); throw error;
    }
  }

  close(): void { this.#key.fill(0); }

  exportSnapshot(): OperationsEffectIntentLedgerSnapshotV1 {
    const state = this.assertState(), material: Omit<OperationsEffectIntentLedgerSnapshotV1, "snapshotDigest"> = {
      contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1, ledgerIdentityDigest: state.ledgerIdentityDigest,
      revision: state.revision, highWaterAt: state.highWaterAt,
      records: exactProjectWorkspaceJsonV1(state.records) as OperationsIntentRecordV1[], stateAuthTag: state.stateAuthTag };
    return parseLedgerSnapshot({ ...material, snapshotDigest: sha256Digest(material) });
  }

  registerPlanner(planner: OperationsCanaryRollbackPlannerV1): OperationsIntentRecordV1[] {
    if (!trustedPlanners.has(planner as object)) throw new Error("operations planner was not repository-built");
    return this.mutate(planner.createdAt, (state) => {
      for (const intentValue of planner.intents) {
        const intent = parseOperationsPlannedEffectIntentV1(intentValue), existing = state.records.find((item) => item.intent.intentId === intent.intentId);
        if (existing) {
          if (existing.intent.intentDigest !== intent.intentDigest) throw new Error("operations intent registration conflict");
          continue;
        }
        state.records.push({ intent, state: "proposed", updatedAt: planner.createdAt });
      }
      state.records.sort((left, right) => left.intent.position - right.intent.position);
    });
  }

  claim(intentId: string, claimEvidenceDigest: string, recordedAt: string): OperationsIntentRecordV1 {
    return this.mutateOne(intentId, recordedAt, (record, state) => {
      if (record.claim) {
        if (record.claim.claimEvidenceDigest !== claimEvidenceDigest || record.claim.recordedAt !== recordedAt) {
          throw new Error("operations intent claim conflict");
        }
        return;
      }
      if (terminalStates.has(record.state)) throw new Error("operations intent claim terminal");
      if (record.state !== "proposed" || Date.parse(recordedAt) >= Date.parse(record.intent.expiresAt)) throw new Error("operations intent claim invalid");
      this.assertPredecessor(record, state.records);
      const material: Omit<OperationsIntentClaimV1, "claimDigest"> = { contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1,
        claimId: `claim:operations:${record.intent.intentDigest.slice(7, 31)}`, intentId: record.intent.intentId,
        intentDigest: record.intent.intentDigest, claimEvidenceDigest, recordedAt, evidenceOnly: true, dispatchAuthorized: false,
        grantsApproval: false, grantsExecutionAuthority: false };
      record.claim = parseClaim({ ...material, claimDigest: sha256Digest(material) }); record.state = "claimed"; record.updatedAt = recordedAt;
    });
  }

  recordMarker(intentId: string, markerEvidenceDigest: string, recordedAt: string): OperationsIntentRecordV1 {
    return this.mutateOne(intentId, recordedAt, (record) => {
      if (record.marker) {
        if (record.marker.markerEvidenceDigest !== markerEvidenceDigest || record.marker.recordedAt !== recordedAt) {
          throw new Error("operations intent marker conflict");
        }
        return;
      }
      if (terminalStates.has(record.state)) throw new Error("operations intent marker terminal");
      if (record.state !== "claimed") throw new Error("operations intent marker transition invalid");
      const material: Omit<OperationsIntentMarkerV1, "markerDigest"> = { contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1,
        intentId, intentDigest: record.intent.intentDigest, markerEvidenceDigest, recordedAt,
        effectReportedByExternalBoundary: true, effectPerformedByPlanner: false, grantsExecutionAuthority: false };
      record.marker = parseMarker({ ...material, markerDigest: sha256Digest(material) }); record.state = "marked"; record.updatedAt = recordedAt;
    });
  }

  recordReceipt(intentId: string, input: { outcome: OperationsIntentReceiptOutcomeV1; effectReceiptDigest?: string;
    independentVerificationDigest?: string; recordedAt: string }): OperationsIntentRecordV1 {
    return this.mutateOne(intentId, input.recordedAt, (record) => {
      if (terminalStates.has(record.state)) {
        const existing = record.receipt;
        if (!existing || existing.outcome !== input.outcome || existing.effectReceiptDigest !== input.effectReceiptDigest
          || existing.independentVerificationDigest !== input.independentVerificationDigest
          || existing.recordedAt !== input.recordedAt) throw new Error("operations intent receipt conflict");
        return;
      }
      if (record.state !== "marked" || !validOutcomes[record.intent.action].includes(input.outcome)) throw new Error("operations intent receipt transition invalid");
      const material: Omit<OperationsIntentReceiptV1, "receiptDigest"> = { contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1,
        intentId, intentDigest: record.intent.intentDigest, outcome: input.outcome,
        ...(input.effectReceiptDigest ? { effectReceiptDigest: input.effectReceiptDigest } : {}),
        ...(input.independentVerificationDigest ? { independentVerificationDigest: input.independentVerificationDigest } : {}),
        recordedAt: input.recordedAt, evidenceOnly: true, performsAction: false, grantsApproval: false,
        grantsDeploymentAuthority: false, grantsRollbackAuthority: false, grantsExecutionAuthority: false };
      record.receipt = parseReceipt({ ...material, receiptDigest: sha256Digest(material) });
      record.state = input.outcome === "unknown_after_change" ? "ambiguous"
        : input.outcome === "definite_failure" ? "failed" : "completed_evidence_only";
      record.updatedAt = input.recordedAt;
    });
  }

  failBeforeChange(intentId: string, evidenceDigest: string, recordedAt: string): OperationsIntentRecordV1 {
    return this.mutateOne(intentId, recordedAt, (record) => {
      if (record.state === "failed_before_change") {
        if (record.receipt?.effectReceiptDigest !== evidenceDigest || record.receipt.independentVerificationDigest !== evidenceDigest
          || record.receipt.recordedAt !== recordedAt) throw new Error("operations intent prechange failure conflict");
        return;
      }
      if (terminalStates.has(record.state)) throw new Error("operations intent prechange failure terminal");
      if (record.state !== "claimed") throw new Error("operations intent prechange failure transition invalid");
      const material: Omit<OperationsIntentReceiptV1, "receiptDigest"> = { contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1,
        intentId, intentDigest: record.intent.intentDigest, outcome: "definite_failure", effectReceiptDigest: evidenceDigest,
        independentVerificationDigest: evidenceDigest, recordedAt, evidenceOnly: true, performsAction: false,
        grantsApproval: false, grantsDeploymentAuthority: false, grantsRollbackAuthority: false, grantsExecutionAuthority: false };
      record.receipt = parseReceipt({ ...material, receiptDigest: sha256Digest(material) }); record.state = "failed_before_change";
      record.updatedAt = recordedAt;
    });
  }

  get(intentId: string): OperationsIntentRecordV1 {
    const state = this.assertState(), record = state.records.find((item) => item.intent.intentId === intentId);
    if (!record) throw new Error("operations intent missing"); return this.trustedClone(record);
  }
  list(): OperationsIntentRecordV1[] { return this.assertState().records.map((record) => this.trustedClone(record)); }

  private assertPredecessor(record: OperationsIntentRecordV1, records: OperationsIntentRecordV1[]): void {
    const byAction = (wanted: OperationsCanaryRollbackActionV1) => records.find((item) => item.intent.action === wanted);
    if (record.intent.action === "forward_migration_candidate") return;
    const migration = byAction("forward_migration_candidate");
    if (record.intent.action === "one_host_canary_candidate") {
      if (migration?.state !== "completed_evidence_only" || migration.receipt?.outcome !== "forward_migration_verified") {
        throw new Error("operations canary bypass refused");
      }
      return;
    }
    const canary = byAction("one_host_canary_candidate"), promotion = byAction("promotion_candidate"), rollback = byAction("application_rollback_candidate");
    if (record.intent.action === "promotion_candidate") {
      if (canary?.state !== "completed_evidence_only" || canary.receipt?.outcome !== "canary_passed" || rollback?.state !== "proposed") {
        throw new Error("operations automatic promotion or mixed branch refused");
      }
    } else if (canary?.state !== "completed_evidence_only" || canary.receipt?.outcome !== "canary_failed" || promotion?.state !== "proposed") {
      throw new Error("operations automatic rollback or mixed branch refused");
    }
  }

  private reconcileInterrupted(): void {
    const current = this.assertState();
    if (!current.records.some((record) => record.state === "claimed" || record.state === "marked")) return;
    const at = this.nextTime(current.highWaterAt);
    this.mutate(at, (state) => {
      for (const record of state.records) {
        if (record.state !== "claimed" && record.state !== "marked") continue;
        const afterMarker = record.state === "marked", material: Omit<OperationsIntentReceiptV1, "receiptDigest"> = {
          contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1, intentId: record.intent.intentId,
          intentDigest: record.intent.intentDigest, outcome: afterMarker ? "unknown_after_change" : "definite_failure",
          ...(afterMarker ? {} : { effectReceiptDigest: sha256Digest({ reconciliation: "reopened_before_change", intentDigest: record.intent.intentDigest }),
            independentVerificationDigest: sha256Digest({ reconciliation: "reopened_before_change", intentDigest: record.intent.intentDigest }) }),
          recordedAt: at, evidenceOnly: true, performsAction: false, grantsApproval: false,
          grantsDeploymentAuthority: false, grantsRollbackAuthority: false, grantsExecutionAuthority: false };
        record.receipt = parseReceipt({ ...material, receiptDigest: sha256Digest(material) });
        record.state = afterMarker ? "ambiguous" : "failed_before_change"; record.updatedAt = at;
      }
    });
  }

  private trustedClone(record: OperationsIntentRecordV1): OperationsIntentRecordV1 {
    const clone = parseRecord(exactProjectWorkspaceJsonV1(record)); trustedIntents.add(clone.intent as object); return clone;
  }
  private nextTime(highWaterAt: string): string {
    const now = this.#clock(), value = Math.max(Date.parse(now), Date.parse(highWaterAt) + 1);
    if (!Number.isFinite(value)) throw new Error("operations intent ledger clock invalid"); return new Date(value).toISOString();
  }
  private material(state: Omit<LedgerState, "stateAuthTag"> | LedgerState) {
    return { ledgerIdentityDigest: state.ledgerIdentityDigest, revision: state.revision, highWaterAt: state.highWaterAt,
      records: state.records };
  }
  private tag(state: Omit<LedgerState, "stateAuthTag"> | LedgerState): string { return hmacSha256Tag(this.#key, this.material(state)); }
  private checkpoint(state: LedgerState): RollbackCheckpointV1 {
    return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: `operations-intent-ledger:${state.ledgerIdentityDigest}`,
      revision: state.revision, recordCount: state.records.length, stateDigest: sha256Digest(this.material(state)),
      stateAuthTag: state.stateAuthTag };
  }
  private assertState(): LedgerState {
    const state = memoryPorts.get(this.#port as object);
    if (!state || !equalTag(state.stateAuthTag, this.tag(state)) || !Number.isSafeInteger(state.revision) || state.revision < 1
      || !Number.isFinite(Date.parse(state.highWaterAt))) throw new Error("operations intent ledger integrity failed");
    state.records.forEach(parseRecord);
    const expected = this.checkpoint(state), known = this.#checkpointRead(expected.scope);
    if (!known || rollbackCheckpointDigestV1(known) !== rollbackCheckpointDigestV1(expected)) {
      throw new Error("operations intent ledger rollback detected");
    }
    return state;
  }
  private mutate(at: string, callback: (state: LedgerState) => void): OperationsIntentRecordV1[] {
    const current = this.assertState();
    const next = exactProjectWorkspaceJsonV1(current) as LedgerState, before = JSON.stringify(next.records); callback(next);
    if (JSON.stringify(next.records) === before) return current.records.map((record) => this.trustedClone(record));
    if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(current.highWaterAt)) throw new Error("operations intent ledger clock rollback");
    next.revision += 1; next.highWaterAt = at;
    next.records.forEach(parseRecord); next.stateAuthTag = this.tag(next);
    this.#checkpointAdvance(rollbackCheckpointDigestV1(this.checkpoint(current)), this.checkpoint(next));
    memoryPorts.set(this.#port as object, next);
    return next.records.map((record) => this.trustedClone(record));
  }
  private mutateOne(intentId: string, at: string, callback: (record: OperationsIntentRecordV1, state: LedgerState) => void): OperationsIntentRecordV1 {
    const records = this.mutate(at, (state) => {
      const record = state.records.find((item) => item.intent.intentId === intentId);
      if (!record) throw new Error("operations intent missing"); callback(record, state);
    });
    return records.find((item) => item.intent.intentId === intentId)!;
  }
}

export interface OperationsCanaryRollbackOperatorProjectionV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  plannerDigest: string;
  topologyDigest: string;
  status: "owner_questions_pending" | "evidence_in_progress" | "completed_evidence_only" | "terminal_ambiguity";
  questionCodes: string[];
  intentCards: Array<{ action: OperationsCanaryRollbackActionV1; state: OperationsIntentStateV1; safeStatusCode: string;
    intentDigest: string; }>;
  controls: [];
  commandLines: [];
  performsAction: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsRollbackAuthority: false;
  grantsExecutionAuthority: false;
  projectionDigest: string;
}

export function projectOperationsCanaryRollbackV1(planner: OperationsCanaryRollbackPlannerV1,
  recordValues: OperationsIntentRecordV1[]): OperationsCanaryRollbackOperatorProjectionV1 {
  if (!trustedPlanners.has(planner as object)) throw new Error("operations planner was not repository-built");
  const records = recordValues.map(parseRecord);
  if (records.length !== 4 || records.map((record) => record.intent.intentDigest).join("|") !== planner.intents.map((intent) => intent.intentDigest).join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const status = records.some((record) => record.state === "ambiguous") ? "terminal_ambiguity" as const
    : records.some((record) => record.state === "claimed" || record.state === "marked") ? "evidence_in_progress" as const
      : records.some((record) => record.state === "completed_evidence_only") ? "completed_evidence_only" as const
        : "owner_questions_pending" as const;
  const material: Omit<OperationsCanaryRollbackOperatorProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1, plannerDigest: planner.plannerDigest,
    topologyDigest: planner.topologyDigest, status, questionCodes: planner.ownerQuestions.map((question) => question.safePromptCode),
    intentCards: records.map((record) => ({ action: record.intent.action, state: record.state,
      safeStatusCode: record.receipt?.outcome ?? record.state, intentDigest: record.intent.intentDigest })), controls: [], commandLines: [],
    performsAction: false, grantsApproval: false, grantsDeploymentAuthority: false, grantsRollbackAuthority: false,
    grantsExecutionAuthority: false };
  return { ...material, projectionDigest: sha256Digest(material) };
}

export interface OperationsDisabledPlannerExecutorReceiptV1 {
  contractVersion: typeof OPERATIONS_CANARY_ROLLBACK_PLANNER_V1;
  intentDigest: string;
  action: OperationsCanaryRollbackActionV1;
  status: "disabled_before_execution";
  commandLines: [];
  targetPresent: false;
  clientPresent: false;
  credentialResolutionAttempted: false;
  effectAttempted: false;
  performsAction: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsRollbackAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export function createOperationsDisabledCanaryRollbackExecutorV1() {
  return Object.freeze({ prepare(intentValue: OperationsPlannedEffectIntentV1): OperationsDisabledPlannerExecutorReceiptV1 {
    if (!trustedIntents.has(intentValue as object)) throw new Error("operations executor refused untrusted intent");
    const intent = parseOperationsPlannedEffectIntentV1(intentValue), material: Omit<OperationsDisabledPlannerExecutorReceiptV1, "receiptDigest"> = {
      contractVersion: OPERATIONS_CANARY_ROLLBACK_PLANNER_V1, intentDigest: intent.intentDigest, action: intent.action,
      status: "disabled_before_execution", commandLines: [], targetPresent: false, clientPresent: false,
      credentialResolutionAttempted: false, effectAttempted: false, performsAction: false, grantsApproval: false,
      grantsDeploymentAuthority: false, grantsRollbackAuthority: false, grantsExecutionAuthority: false };
    return { ...material, receiptDigest: sha256Digest(material) };
  } });
}

export const operationsCanaryRollbackSchemasV1 = { step: stepSchema, question: questionSchema, intent: intentSchema,
  planner: plannerSchema, claim: claimSchema, marker: markerSchema, receipt: receiptSchema, record: recordSchema,
  ledgerSnapshot: ledgerSnapshotSchema } as const;
