import { createHash } from "node:crypto";
import { z } from "zod";
import {
  completionAcceptanceProfileSchemaV1,
  completionFindingSchemaV1,
  completionPreferenceSchemaV1,
  completionReviewSchemaV1,
  completionReviewTargetSchemaV1,
  completionRevisionSchemaV1,
  completionVerificationSchemaV1,
  consequentialApprovalDecisionSchemaV1,
  consequentialApprovalRequestSchemaV1,
  type CompletionAcceptanceProfileV1,
  type CompletionFindingV1,
  type CompletionGateSnapshotV1,
  type CompletionPreferenceV1,
  type CompletionPrincipalV1,
  type CompletionReviewTargetV1,
  type CompletionReviewV1,
  type CompletionRevisionV1,
  type CompletionVerificationV1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../../completion-gate/v1";
import { artifactManifestRecordSchema, type ArtifactManifestRecord } from "../../domain/v1";
import {
  computeNormalizedOperationDigest,
  localPolicyDecisionSchema,
  normalizedLocalPolicyRequestSchema,
  type LocalPolicyDecisionV1,
  type NormalizedLocalPolicyRequestV1,
} from "../../node-policy/v1";
import {
  buildArtifactLineageRecord,
  type ArtifactLineageRecordV1,
  type ArtifactVerificationClaimV1,
} from "../../node-executor";
import { actionInboxItemSchemaV1, type ActionInboxItemV1 } from "../../operator-surfaces/v1";
import {
  parseCredentialCatalogEntryV1,
  parseSecretInvocationGrantV1,
  secretInvocationReceiptSchemaV1,
  type CredentialCatalogEntryV1,
  type SecretInvocationGrantV1,
  type SecretInvocationReceiptV1,
} from "../../secret-broker/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
} from "../../security/host-value";
import {
  telegramCallbackRecordSchemaV1,
  telegramMessagePlanSchemaV1,
  telegramPresentationSchemaV1,
  telegramResponseProposalSchemaV1,
  type TelegramCallbackRecordV1,
  type TelegramMessagePlanV1,
  type TelegramPresentationV1,
  type TelegramResponseProposalV1,
} from "../../telegram/v1";
import { completionFlowReceiptSchemaV1, effectFreeExecutionObservationSchemaV1 } from "./schemas";
import {
  COMPLETION_FLOW_CONTRACT_V1,
  type CompletionFlowReceiptV1,
  type EffectFreeExecutionObservationV1,
} from "./types";

export type CompletionFlowSafeCodeV1 =
  | "invalid_input"
  | "scope_mismatch"
  | "lineage_mismatch"
  | "authority_conflation"
  | "sequence_invalid"
  | "completion_not_ready";

export class CompletionFlowErrorV1 extends Error {
  constructor(readonly safeCode: CompletionFlowSafeCodeV1) {
    super(safeCode);
    this.name = "CompletionFlowErrorV1";
  }
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timeSchema = z.string().datetime({ offset: true });
const safeIdSchema = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const riskRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;

const artifactVerificationClaimSchemaV1 = z.object({
  schema: z.literal("control-room.artifact-verification-claim/v1"),
  claimId: safeIdSchema,
  artifactId: safeIdSchema,
  tenantId: safeIdSchema,
  projectId: safeIdSchema,
  jobId: safeIdSchema,
  attemptId: safeIdSchema,
  producerId: safeIdSchema,
  claim: z.literal("content_hash_matches_exact_bytes"),
  contentHash: digestSchema,
  manifestDigest: digestSchema,
  createdAt: timeSchema,
  claimDigest: digestSchema,
}).strict();

const artifactLineageSchemaV1 = z.object({
  schema: z.literal("control-room.artifact-lineage/v1"),
  artifactId: safeIdSchema,
  tenantId: safeIdSchema,
  projectId: safeIdSchema,
  jobId: safeIdSchema,
  attemptId: safeIdSchema,
  producerId: safeIdSchema,
  manifest: artifactManifestRecordSchema,
  producerClaim: artifactVerificationClaimSchemaV1,
  independentVerification: z.object({ status: z.literal("not_run") }).strict(),
  recordedAt: timeSchema,
  lineageDigest: digestSchema,
}).strict();

const completionGateSnapshotSchemaV1 = z.object({
  target: completionReviewTargetSchemaV1,
  targetDigest: digestSchema,
  status: z.enum(["pending", "changes_requested", "verification_blocked", "revision_limit_reached", "ready", "superseded"]),
  acceptedReviewIds: z.array(safeIdSchema).max(5),
  missingVerificationScenarioIds: z.array(safeIdSchema).max(50),
  openFindingIds: z.array(safeIdSchema).max(100),
  revisionNumber: z.number().int().min(0).max(20),
  requiresSeparateApproval: z.literal(true),
  grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

interface SnapshotBudget { remaining: number; }

/** Copy ordinary JSON data without invoking getters, iterators, or Proxy traps. */
function exactJsonSnapshot(value: unknown, budget: SnapshotBudget, depth = 0): unknown {
  if (depth > 24 || budget.remaining-- <= 0) throw new CompletionFlowErrorV1("invalid_input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || isHostProxyV1(value)) throw new CompletionFlowErrorV1("invalid_input");
  if (Array.isArray(value)) {
    const items = exactHostDataArrayV1(value, 2_000);
    if (!items) throw new CompletionFlowErrorV1("invalid_input");
    return items.map((item) => exactJsonSnapshot(item, budget, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new CompletionFlowErrorV1("invalid_input");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 500 || keys.some((key) => typeof key !== "string")) throw new CompletionFlowErrorV1("invalid_input");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new CompletionFlowErrorV1("invalid_input");
    }
    Object.defineProperty(result, key, {
      value: exactJsonSnapshot(descriptor.value, budget, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function exactJson(value: unknown): unknown {
  return exactJsonSnapshot(value, { remaining: 25_000 });
}

function parseExact<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(exactJson(value));
    assertNoSecretMaterial(parsed, "completion flow record");
    return parsed;
  } catch (error) {
    if (error instanceof CompletionFlowErrorV1) throw error;
    throw new CompletionFlowErrorV1("invalid_input");
  }
}

function parseExactRecord<T>(parser: (value: unknown) => T, value: unknown, context: string): T {
  try {
    const parsed = parser(exactJson(value));
    assertNoSecretMaterial(parsed, context);
    return parsed;
  } catch (error) {
    if (error instanceof CompletionFlowErrorV1) throw error;
    throw new CompletionFlowErrorV1("invalid_input");
  }
}

function parseExactArray<T>(schema: { parse(value: unknown): T }, value: unknown): T[] {
  const values = exactHostDataArrayV1(value, 100);
  if (!values) throw new CompletionFlowErrorV1("invalid_input");
  return values.map((item) => parseExact(schema, item));
}

function withoutDigest<T extends Record<string, unknown>>(value: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function sameSorted(left: string[], right: string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function atOrAfter(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

function sameQuestionProjection(initial: ActionInboxItemV1, resolved: ActionInboxItemV1): boolean {
  const { state: initialState, ...initialBody } = initial;
  const { state: resolvedState, ...resolvedBody } = resolved;
  return initialState === "open" && resolvedState === "resolved" && sha256Digest(initialBody) === sha256Digest(resolvedBody);
}

function principalAxis(principal: CompletionPrincipalV1, key: keyof CompletionPrincipalV1): string | undefined {
  const value = principal[key];
  return typeof value === "string" ? value : undefined;
}

function requireIndependent(
  left: CompletionPrincipalV1,
  right: CompletionPrincipalV1,
  profile: CompletionAcceptanceProfileV1,
): void {
  const axes: Array<[keyof CompletionPrincipalV1, boolean]> = [
    ["actorId", profile.reviewerSeparation.actor],
    ["workerId", profile.reviewerSeparation.worker],
    ["agentProfileId", profile.reviewerSeparation.agentProfile],
    ["harness", profile.reviewerSeparation.harness],
    ["modelFamily", profile.reviewerSeparation.modelFamily],
  ];
  for (const [key, required] of axes) {
    if (!required) continue;
    const leftValue = principalAxis(left, key), rightValue = principalAxis(right, key);
    if (!leftValue || !rightValue || leftValue === rightValue) throw new CompletionFlowErrorV1("lineage_mismatch");
  }
}

function canonicalArtifactLineage(input: unknown): ArtifactLineageRecordV1 {
  const parsed = parseExact(artifactLineageSchemaV1, input) as ArtifactLineageRecordV1;
  const manifest = parseExact(artifactManifestRecordSchema, parsed.manifest) as ArtifactManifestRecord;
  const producerClaim = parseExact(artifactVerificationClaimSchemaV1, parsed.producerClaim) as ArtifactVerificationClaimV1;
  const canonical = buildArtifactLineageRecord({ bytes: new Uint8Array(), manifest, verificationClaim: producerClaim });
  if (sha256Digest(canonical) !== sha256Digest(parsed)) throw new CompletionFlowErrorV1("lineage_mismatch");
  return parsed;
}

export function parseEffectFreeExecutionObservationV1(value: unknown): EffectFreeExecutionObservationV1 {
  const parsed = parseExact(effectFreeExecutionObservationSchemaV1, value) as EffectFreeExecutionObservationV1;
  if (sha256Digest(withoutDigest(parsed as unknown as Record<string, unknown>, "observationDigest")) !== parsed.observationDigest) {
    throw new CompletionFlowErrorV1("lineage_mismatch");
  }
  return parsed;
}

/**
 * Convert one actual synthetic artifact result and accepted local-policy fact
 * into a safe observation. Exact artifact bytes are checked here and discarded
 * from the returned record.
 */
export function buildEffectFreeExecutionObservationV1(inputValue: unknown): EffectFreeExecutionObservationV1 {
  const top = exactHostDataSnapshotV1(
    inputValue,
    ["phase", "executionId", "policyRequest", "policyDecision", "artifactLineage", "artifactBytes", "completedAt"],
    ["secretReceipt"],
  );
  if (!top) throw new CompletionFlowErrorV1("invalid_input");
  const phase = top.phase;
  const executionId = top.executionId;
  const completedAt = top.completedAt;
  if ((phase !== "initial" && phase !== "revision") || typeof executionId !== "string" || !safeIdSchema.safeParse(executionId).success
    || typeof completedAt !== "string" || !timeSchema.safeParse(completedAt).success) throw new CompletionFlowErrorV1("invalid_input");

  const policyRequest = parseExact(normalizedLocalPolicyRequestSchema, top.policyRequest) as NormalizedLocalPolicyRequestV1;
  const policyDecision = parseExact(localPolicyDecisionSchema, top.policyDecision) as LocalPolicyDecisionV1;
  if (!policyDecision.accepted || policyDecision.requestId !== policyRequest.requestId
    || policyDecision.requestDigest !== sha256Digest(policyRequest)
    || policyDecision.authorityDigest !== policyRequest.authorityDigest
    || policyRequest.operationDigest !== computeNormalizedOperationDigest(policyRequest)) {
    throw new CompletionFlowErrorV1("lineage_mismatch");
  }
  if (policyRequest.externalEffect || policyRequest.target.kind !== "none" || policyRequest.approval !== undefined) {
    throw new CompletionFlowErrorV1("authority_conflation");
  }

  const artifactLineage = canonicalArtifactLineage(top.artifactLineage);
  const artifactBytes = exactHostUint8ArrayV1(top.artifactBytes, 65_536);
  if (!artifactBytes) throw new CompletionFlowErrorV1("invalid_input");
  const artifactCopy = artifactBytes.copy();
  const contentHash = `sha256:${createHash("sha256").update(artifactCopy).digest("hex")}`;
  artifactCopy.fill(0);
  if (contentHash !== artifactLineage.manifest.contentHash
    || artifactBytes.byteLength !== artifactLineage.manifest.sizeBytes
    || artifactLineage.tenantId !== policyRequest.tenantId
    || artifactLineage.projectId !== policyRequest.projectId
    || artifactLineage.jobId !== policyRequest.jobId
    || artifactLineage.attemptId !== policyRequest.attemptId) throw new CompletionFlowErrorV1("lineage_mismatch");

  const secretReceipt = top.secretReceipt === undefined
    ? undefined
    : parseExact(secretInvocationReceiptSchemaV1, top.secretReceipt) as SecretInvocationReceiptV1;
  if (phase === "initial") {
    if (!secretReceipt || secretReceipt.state !== "succeeded" || !secretReceipt.outputDigest
      || !policyRequest.credentialRefs.includes(secretReceipt.credentialRef)) throw new CompletionFlowErrorV1("lineage_mismatch");
  } else if (secretReceipt || policyRequest.credentialRefs.length !== 0) {
    throw new CompletionFlowErrorV1("authority_conflation");
  }
  if (!atOrAfter(completedAt, policyDecision.decidedAt)
    || !atOrAfter(completedAt, artifactLineage.recordedAt)
    || (secretReceipt && !atOrAfter(completedAt, secretReceipt.recordedAt))) throw new CompletionFlowErrorV1("sequence_invalid");

  const unsigned: Omit<EffectFreeExecutionObservationV1, "observationDigest"> = {
    contractVersion: COMPLETION_FLOW_CONTRACT_V1,
    phase,
    executionId,
    tenantId: policyRequest.tenantId,
    projectId: policyRequest.projectId,
    jobId: policyRequest.jobId,
    attemptId: policyRequest.attemptId,
    localPolicyRequestId: policyRequest.requestId,
    localPolicyRequestDigest: sha256Digest(policyRequest),
    operationDigest: policyRequest.operationDigest,
    authorityDigest: policyRequest.authorityDigest,
    artifactId: artifactLineage.artifactId,
    artifactContentHash: artifactLineage.manifest.contentHash,
    artifactManifestDigest: sha256Digest(artifactLineage.manifest),
    producerClaimDigest: artifactLineage.producerClaim.claimDigest,
    artifactLineageDigest: artifactLineage.lineageDigest,
    ...(secretReceipt ? { secretReceiptDigest: sha256Digest(secretReceipt) } : {}),
    completedAt,
    executionKind: "synthetic",
    externalEffect: false,
    networkUsed: false,
    nativeProcessUsed: false,
    liveProviderUsed: false,
    approvalDecisionConsumed: false,
    nodeApprovalAttestationPresent: false,
    grantsApproval: false,
    grantsExecutionAuthority: false,
  };
  const observation = effectFreeExecutionObservationSchemaV1.parse({ ...unsigned, observationDigest: sha256Digest(unsigned) }) as EffectFreeExecutionObservationV1;
  assertNoSecretMaterial(observation, "effect-free execution observation");
  return observation;
}

export function parseCompletionFlowReceiptV1(value: unknown): CompletionFlowReceiptV1 {
  const parsed = parseExact(completionFlowReceiptSchemaV1, value) as CompletionFlowReceiptV1;
  if (sha256Digest(withoutDigest(parsed as unknown as Record<string, unknown>, "receiptDigest")) !== parsed.receiptDigest) {
    throw new CompletionFlowErrorV1("lineage_mismatch");
  }
  return parsed;
}

/** Build the digest-only receipt after every component ledger has accepted its exact record. */
export function buildCompletionFlowReceiptV1(inputValue: unknown): CompletionFlowReceiptV1 {
  const required = [
    "workflowId", "question", "resolvedQuestion", "messagePlan", "presentation", "callbackRecord", "responseProposal",
    "preference", "approvalRequest", "approvalDecision", "catalogEntry", "secretGrant", "secretReceipt",
    "initialExecution", "revisionExecution", "acceptanceProfile", "initialTarget", "initialReview", "initialFindings",
    "revision", "revisedTarget", "revisedVerifications", "finalReview", "finalSnapshot", "completedAt",
  ];
  const top = exactHostDataSnapshotV1(inputValue, required);
  if (!top || typeof top.workflowId !== "string" || !safeIdSchema.safeParse(top.workflowId).success
    || typeof top.completedAt !== "string" || !timeSchema.safeParse(top.completedAt).success) {
    throw new CompletionFlowErrorV1("invalid_input");
  }

  const question = parseExact(actionInboxItemSchemaV1, top.question) as ActionInboxItemV1;
  const resolvedQuestion = parseExact(actionInboxItemSchemaV1, top.resolvedQuestion) as ActionInboxItemV1;
  const messagePlan = parseExact(telegramMessagePlanSchemaV1, top.messagePlan) as TelegramMessagePlanV1;
  const presentation = parseExact(telegramPresentationSchemaV1, top.presentation) as TelegramPresentationV1;
  const callbackRecord = parseExact(telegramCallbackRecordSchemaV1, top.callbackRecord) as TelegramCallbackRecordV1;
  const responseProposal = parseExact(telegramResponseProposalSchemaV1, top.responseProposal) as TelegramResponseProposalV1;
  const preference = parseExact(completionPreferenceSchemaV1, top.preference) as CompletionPreferenceV1;
  const approvalRequest = parseExact(consequentialApprovalRequestSchemaV1, top.approvalRequest) as ConsequentialApprovalRequestV1;
  const approvalDecision = parseExact(consequentialApprovalDecisionSchemaV1, top.approvalDecision) as ConsequentialApprovalDecisionV1;
  const catalogEntry = parseExactRecord(
    parseCredentialCatalogEntryV1,
    top.catalogEntry,
    "completion flow credential catalog entry",
  ) as CredentialCatalogEntryV1;
  const secretGrant = parseExactRecord(
    parseSecretInvocationGrantV1,
    top.secretGrant,
    "completion flow secret invocation grant",
  ) as SecretInvocationGrantV1;
  const secretReceipt = parseExact(secretInvocationReceiptSchemaV1, top.secretReceipt) as SecretInvocationReceiptV1;
  const initialExecution = parseEffectFreeExecutionObservationV1(top.initialExecution);
  const revisionExecution = parseEffectFreeExecutionObservationV1(top.revisionExecution);
  const acceptanceProfile = parseExact(completionAcceptanceProfileSchemaV1, top.acceptanceProfile) as CompletionAcceptanceProfileV1;
  const initialTarget = parseExact(completionReviewTargetSchemaV1, top.initialTarget) as CompletionReviewTargetV1;
  const initialReview = parseExact(completionReviewSchemaV1, top.initialReview) as CompletionReviewV1;
  const initialFindings = parseExactArray(completionFindingSchemaV1, top.initialFindings) as CompletionFindingV1[];
  const revision = parseExact(completionRevisionSchemaV1, top.revision) as CompletionRevisionV1;
  const revisedTarget = parseExact(completionReviewTargetSchemaV1, top.revisedTarget) as CompletionReviewTargetV1;
  const revisedVerifications = parseExactArray(completionVerificationSchemaV1, top.revisedVerifications) as CompletionVerificationV1[];
  const finalReview = parseExact(completionReviewSchemaV1, top.finalReview) as CompletionReviewV1;
  const finalSnapshot = parseExact(completionGateSnapshotSchemaV1, top.finalSnapshot) as CompletionGateSnapshotV1;

  const tenantId = question.tenantId, projectId = question.projectId;
  if (!projectId || [resolvedQuestion, messagePlan, callbackRecord, responseProposal, preference, approvalRequest, approvalDecision,
    secretGrant, initialExecution, revisionExecution, acceptanceProfile, initialTarget, initialReview, revision,
    revisedTarget, finalReview].some((item) => item.tenantId !== tenantId || item.projectId !== projectId)
    || catalogEntry.tenantId !== tenantId || !catalogEntry.projectIds.includes(projectId)
    || initialFindings.some((item) => item.tenantId !== tenantId || item.projectId !== projectId)
    || revisedVerifications.some((item) => item.tenantId !== tenantId || item.projectId !== projectId)) {
    throw new CompletionFlowErrorV1("scope_mismatch");
  }

  const questionDigest = sha256Digest(question);
  if (question.kind !== "question" || !sameQuestionProjection(question, resolvedQuestion)
    || !question.legalResponses.some((item) => item.kind === "record_decision" && item.available)
    || question.legalResponses.some((item) => item.kind === "approve_exact_operation" && item.available)) {
    throw new CompletionFlowErrorV1("authority_conflation");
  }
  const optionDigests = messagePlan.responseOptions.map((item) => item.valueDigest).sort();
  if (messagePlan.attentionId !== question.id || messagePlan.attentionDigest !== questionDigest
    || messagePlan.messageClass !== "question" || !messagePlan.responseKinds.includes("answer_choice") || optionDigests.length < 2
    || presentation.sourceMessagePlanIds.length !== 1 || presentation.sourceMessagePlanIds[0] !== messagePlan.messagePlanId
    || !presentation.buttons.some((item) => item.kind === "callback_intent" && item.responseKind === "answer_choice")
    || callbackRecord.attentionId !== question.id || callbackRecord.attentionDigest !== questionDigest
    || callbackRecord.messagePlanDigest !== sha256Digest(messagePlan) || callbackRecord.responseKind !== "answer_choice"
    || !callbackRecord.responseValueDigest || !optionDigests.includes(callbackRecord.responseValueDigest)
    || responseProposal.callbackId !== callbackRecord.callbackId || responseProposal.attentionId !== question.id
    || responseProposal.attentionDigest !== questionDigest || responseProposal.responseKind !== callbackRecord.responseKind
    || responseProposal.responseValueDigest !== callbackRecord.responseValueDigest) throw new CompletionFlowErrorV1("lineage_mismatch");

  if (preference.subjectId !== question.id || preference.subjectDigest !== questionDigest
    || !sameSorted(preference.optionDigests, optionDigests) || preference.selectedOptionDigest !== responseProposal.responseValueDigest
    || !atOrAfter(preference.selectedAt, responseProposal.observedAt)) throw new CompletionFlowErrorV1("lineage_mismatch");

  if (approvalDecision.requestId !== approvalRequest.id || approvalDecision.requestDigest !== sha256Digest(approvalRequest)
    || approvalDecision.operationDigest !== approvalRequest.operationDigest || approvalDecision.decision !== "approved"
    || !approvalDecision.requiresSeparateNodeAttestation || approvalDecision.grantsExecutionAuthority
    || !atOrAfter(approvalRequest.requestedAt, preference.selectedAt)
    || !atOrAfter(approvalDecision.decidedAt, approvalRequest.requestedAt)) throw new CompletionFlowErrorV1("authority_conflation");

  if (catalogEntry.providerKind !== "synthetic_test" || catalogEntry.state !== "active"
    || secretGrant.catalogEntryDigest !== catalogEntry.entryDigest || secretGrant.credentialRef !== catalogEntry.credentialRef
    || secretReceipt.invocationId !== secretGrant.invocationId || secretReceipt.credentialRef !== secretGrant.credentialRef
    || secretReceipt.state !== "succeeded" || !secretReceipt.outputDigest
    || initialExecution.phase !== "initial" || revisionExecution.phase !== "revision"
    || initialExecution.secretReceiptDigest !== sha256Digest(secretReceipt) || revisionExecution.secretReceiptDigest !== undefined
    || secretGrant.admissionRequestId !== initialExecution.localPolicyRequestId
    || secretGrant.admissionRequestDigest !== initialExecution.localPolicyRequestDigest
    || secretGrant.operationDigest !== initialExecution.operationDigest
    || secretGrant.authorityDigest !== initialExecution.authorityDigest
    || approvalDecision.operationDigest === initialExecution.operationDigest
    || approvalDecision.operationDigest === revisionExecution.operationDigest) throw new CompletionFlowErrorV1("authority_conflation");

  const profileDigest = sha256Digest(acceptanceProfile), initialTargetDigest = sha256Digest(initialTarget);
  const revisedTargetDigest = sha256Digest(revisedTarget), initialFindingIds = initialFindings.map((item) => item.id).sort();
  if (initialExecution.artifactId !== initialTarget.subjectId || initialExecution.artifactManifestDigest !== initialTarget.subjectDigest
    || initialTarget.acceptanceProfileId !== acceptanceProfile.id || initialTarget.acceptanceProfileDigest !== profileDigest
    || initialReview.targetId !== initialTarget.id || initialReview.targetDigest !== initialTargetDigest
    || initialReview.decision !== "changes_requested" || initialReview.authority !== "completion_gate"
    || !sameSorted(initialReview.findingIds, initialFindingIds) || initialFindingIds.length === 0
    || initialFindings.some((item) => item.targetId !== initialTarget.id || item.targetDigest !== initialTargetDigest
      || item.reviewId !== initialReview.id)
    || revision.rootTargetId !== initialTarget.id || revision.fromTargetId !== initialTarget.id
    || revision.fromTargetDigest !== initialTargetDigest || revision.toTargetId !== revisedTarget.id
    || revision.toTargetDigest !== revisedTargetDigest || revision.revisionNumber !== 1
    || !sameSorted(revision.resolvedFindingIds, initialFindingIds)
    || revisedTarget.rootTargetId !== initialTarget.id || revisedTarget.supersedesTargetId !== initialTarget.id
    || revisedTarget.revisionNumber !== 1 || revisedTarget.subjectId !== initialTarget.subjectId
    || revisedTarget.subjectDigest !== revisionExecution.artifactManifestDigest
    || revisionExecution.artifactId !== revisedTarget.subjectId
    || revisedTarget.subjectDigest === initialTarget.subjectDigest) throw new CompletionFlowErrorV1("lineage_mismatch");

  requireIndependent(initialTarget.producer, initialReview.reviewer, acceptanceProfile);
  requireIndependent(revisedTarget.producer, finalReview.reviewer, acceptanceProfile);
  requireIndependent(initialReview.reviewer, finalReview.reviewer, acceptanceProfile);
  const scenarioIds = revisedVerifications.map((item) => item.scenarioId).sort();
  if (!sameSorted(scenarioIds, acceptanceProfile.requiredVerificationScenarioIds)
    || revisedVerifications.some((item) => item.targetId !== revisedTarget.id || item.targetDigest !== revisedTargetDigest
      || item.acceptanceProfileId !== acceptanceProfile.id || item.acceptanceProfileDigest !== profileDigest || item.outcome !== "passed")
    || finalReview.targetId !== revisedTarget.id || finalReview.targetDigest !== revisedTargetDigest
    || finalReview.acceptanceProfileId !== acceptanceProfile.id || finalReview.acceptanceProfileDigest !== profileDigest
    || finalReview.authority !== "completion_gate" || finalReview.decision !== "accepted" || finalReview.findingIds.length !== 0
    || riskRank[finalReview.effectiveRisk] < riskRank[acceptanceProfile.minimumRisk]
    || finalSnapshot.status !== "ready" || finalSnapshot.target.id !== revisedTarget.id
    || finalSnapshot.targetDigest !== revisedTargetDigest || finalSnapshot.revisionNumber !== 1
    || !sameSorted(finalSnapshot.acceptedReviewIds, [finalReview.id])
    || finalSnapshot.missingVerificationScenarioIds.length !== 0 || finalSnapshot.openFindingIds.length !== 0) {
    throw new CompletionFlowErrorV1("completion_not_ready");
  }

  const latestVerificationAt = [...revisedVerifications].map((item) => item.verifiedAt).sort().at(-1);
  if (!atOrAfter(initialTarget.submittedAt, initialExecution.completedAt)
    || !atOrAfter(initialReview.reviewedAt, initialTarget.submittedAt)
    || initialFindings.some((item) => !atOrAfter(item.raisedAt, initialReview.reviewedAt))
    || !atOrAfter(revisionExecution.completedAt, initialReview.reviewedAt)
    || !atOrAfter(revisedTarget.submittedAt, revisionExecution.completedAt)
    || revision.revisedAt !== revisedTarget.submittedAt
    || revisedVerifications.some((item) => !atOrAfter(item.verifiedAt, revisedTarget.submittedAt))
    || !latestVerificationAt || !atOrAfter(finalReview.reviewedAt, latestVerificationAt)
    || !atOrAfter(top.completedAt as string, finalReview.reviewedAt)
    || !atOrAfter(secretReceipt.recordedAt, approvalDecision.decidedAt)) throw new CompletionFlowErrorV1("sequence_invalid");

  const revisedVerificationIds = revisedVerifications.map((item) => item.id).sort();
  const unsigned: Omit<CompletionFlowReceiptV1, "receiptDigest"> = {
    contractVersion: COMPLETION_FLOW_CONTRACT_V1,
    workflowId: top.workflowId,
    tenantId,
    projectId,
    questionAttentionId: question.id,
    questionAttentionDigest: questionDigest,
    resolvedAttentionDigest: sha256Digest(resolvedQuestion),
    messagePlanId: messagePlan.messagePlanId,
    messagePlanDigest: sha256Digest(messagePlan),
    presentationId: presentation.presentationId,
    presentationDigest: sha256Digest(presentation),
    callbackId: callbackRecord.callbackId,
    callbackRecordDigest: sha256Digest(callbackRecord),
    responseProposalId: responseProposal.proposalId,
    responseProposalDigest: sha256Digest(responseProposal),
    selectedOptionDigest: preference.selectedOptionDigest,
    preferenceId: preference.id,
    preferenceDigest: sha256Digest(preference),
    approvalRequestId: approvalRequest.id,
    approvalRequestDigest: sha256Digest(approvalRequest),
    approvalDecisionId: approvalDecision.id,
    approvalDecisionDigest: sha256Digest(approvalDecision),
    approvedOperationDigest: approvalDecision.operationDigest,
    approvedOperationDisposition: "approved_not_executed",
    credentialCatalogEntryDigest: catalogEntry.entryDigest,
    secretGrantDigest: secretGrant.grantDigest,
    secretReceiptDigest: sha256Digest(secretReceipt),
    initialExecutionObservationDigest: initialExecution.observationDigest,
    revisionExecutionObservationDigest: revisionExecution.observationDigest,
    acceptanceProfileId: acceptanceProfile.id,
    acceptanceProfileDigest: profileDigest,
    initialTargetId: initialTarget.id,
    initialTargetDigest,
    initialReviewId: initialReview.id,
    initialReviewDigest: sha256Digest(initialReview),
    initialFindingIds,
    revisionId: revision.id,
    revisionDigest: sha256Digest(revision),
    revisedTargetId: revisedTarget.id,
    revisedTargetDigest,
    revisedVerificationIds,
    finalReviewId: finalReview.id,
    finalReviewDigest: sha256Digest(finalReview),
    finalSnapshotDigest: sha256Digest(finalSnapshot),
    finalStatus: "ready",
    completedAt: top.completedAt as string,
    liveEffectsPerformed: false,
    approvedOperationExecuted: false,
    productionCredentialMaterialPersisted: false,
    nodeApprovalAttestationPresent: false,
    grantsApproval: false,
    grantsExecutionAuthority: false,
  };
  const receipt = completionFlowReceiptSchemaV1.parse({ ...unsigned, receiptDigest: sha256Digest(unsigned) }) as CompletionFlowReceiptV1;
  assertNoSecretMaterial(receipt, "completion flow receipt");
  return receipt;
}
