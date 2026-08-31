import { hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1, parseReadyFrontierActivationPacketV1 } from "./no-relay";
import {
  readyFrontierProductionBoundaryAssessmentInputSyntaxParserV1 as productionBoundaryAssessmentInputParserV1,
  readyFrontierProductionBoundaryAssessmentSyntaxParserV1 as productionBoundaryAssessmentParserV1,
  readyFrontierProductionBoundaryPlanInputSyntaxParserV1 as productionBoundaryPlanInputParserV1,
  readyFrontierProductionBoundaryPlanSyntaxParserV1 as productionBoundaryPlanParserV1,
  readyFrontierProductionBoundaryProjectionSyntaxParserV1 as productionBoundaryProjectionParserV1,
  readyFrontierProductionDisabledDispositionInputSyntaxParserV1 as productionDisabledDispositionInputParserV1,
  readyFrontierProductionDisabledDispositionSyntaxParserV1 as productionDisabledDispositionParserV1,
  readyFrontierProductionGateRequirementSyntaxParserV1 as productionGateRequirementParserV1,
  readyFrontierProductionReconciliationDecisionSyntaxParserV1 as productionReconciliationDecisionParserV1,
  readyFrontierProductionReconciliationEventSyntaxParserV1 as productionReconciliationEventParserV1,
  readyFrontierProductionReconciliationStateSyntaxParserV1 as productionReconciliationStateParserV1,
} from "./production-boundary-schemas";
import {
  READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1,
  READY_FRONTIER_PRODUCTION_PLAN_MAX_LIFETIME_SECONDS_V1,
  READY_FRONTIER_PRODUCTION_BOUNDARY_ASSESSMENT_V1,
  READY_FRONTIER_PRODUCTION_BOUNDARY_PLAN_V1,
  READY_FRONTIER_PRODUCTION_BOUNDARY_PROJECTION_V1,
  READY_FRONTIER_PRODUCTION_DISABLED_DISPOSITION_V1,
  READY_FRONTIER_PRODUCTION_GATE_REQUIREMENT_V1,
  READY_FRONTIER_PRODUCTION_RECONCILIATION_DECISION_V1,
  type ReadyFrontierProductionBoundaryAssessmentV1,
  type ReadyFrontierProductionBoundaryPlanV1,
  type ReadyFrontierProductionBoundaryProjectionV1,
  type ReadyFrontierProductionDisabledDispositionV1,
  type ReadyFrontierProductionEvidenceClassV1,
  type ReadyFrontierProductionGateCodeV1,
  type ReadyFrontierProductionGateRequirementV1,
  type ReadyFrontierProductionProofAuthorityV1,
  type ReadyFrontierProductionReconciliationDecisionV1,
  type ReadyFrontierProductionReconciliationStateV1,
} from "./production-boundary-types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never {
  throw new ReadyFrontierContractErrorV1(code);
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function key(value: unknown): Uint8Array {
  const parsed = exactHostUint8ArrayV1(value, 128);
  if (!parsed || parsed.byteLength < 32) fail("integrity_failed");
  return parsed.copy();
}
function equal(left: string, right: string): boolean {
  return left.length === right.length && left === right;
}
function unsigned<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function planUnsigned(plan: ReadyFrontierProductionBoundaryPlanV1):
  Omit<ReadyFrontierProductionBoundaryPlanV1, "planDigest" | "planAuthTag"> {
  const { planDigest: _digest, planAuthTag: _tag, ...material } = plan;
  void _digest; void _tag;
  return material;
}

function planAuthMaterial(plan: Pick<ReadyFrontierProductionBoundaryPlanV1, "planId" | "planDigest"
  | "tenantId" | "workspaceId" | "activationPacketId" | "activationPacketDigest" | "activationPacketCreatedAt"
  | "simulationRunId" | "simulationRunDigest" | "plannedAt" | "expiresAt">) {
  return {
    planId: plan.planId,
    planDigest: plan.planDigest,
    tenantId: plan.tenantId,
    workspaceId: plan.workspaceId,
    activationPacketId: plan.activationPacketId,
    activationPacketDigest: plan.activationPacketDigest,
    activationPacketCreatedAt: plan.activationPacketCreatedAt,
    simulationRunId: plan.simulationRunId,
    simulationRunDigest: plan.simulationRunDigest,
    plannedAt: plan.plannedAt,
    expiresAt: plan.expiresAt,
  };
}

interface GateDefinitionV1 {
  evidenceClass: ReadyFrontierProductionEvidenceClassV1;
  proofAuthority: ReadyFrontierProductionProofAuthorityV1;
  requiredBindings: readonly string[];
  freshnessRequired: boolean;
  independentVerifierRequired: boolean;
}

const gateDefinitions: Readonly<Record<ReadyFrontierProductionGateCodeV1, GateDefinitionV1>> = Object.freeze({
  ambiguity_reconciliation_unproved: Object.freeze({
    evidenceClass: "destination_reconciliation_attestation",
    proofAuthority: "destination_reconciler",
    requiredBindings: Object.freeze(["tenant_id", "workspace_id", "handoff_id", "idempotency_key",
      "destination_evidence", "terminal_disposition"]),
    freshnessRequired: true,
    independentVerifierRequired: true,
  }),
  consumer_channel_unqualified: Object.freeze({
    evidenceClass: "consumer_channel_qualification",
    proofAuthority: "consumer_qualifier",
    requiredBindings: Object.freeze(["consumer_artifact", "service_identity", "protocol_revision", "egress_policy",
      "cancellation_contract", "receipt_signature"]),
    freshnessRequired: true,
    independentVerifierRequired: true,
  }),
  credential_broker_unbound: Object.freeze({
    evidenceClass: "credential_broker_custody_attestation",
    proofAuthority: "credential_broker_custodian",
    requiredBindings: Object.freeze(["credential_reference", "broker_identity", "node_scope", "operation_digest",
      "no_plaintext_central"]),
    freshnessRequired: true,
    independentVerifierRequired: true,
  }),
  hosted_postgresql_unqualified: Object.freeze({
    evidenceClass: "hosted_postgresql_qualification",
    proofAuthority: "database_qualifier",
    requiredBindings: Object.freeze(["topology_digest", "database_identity", "migration_digest", "isolation_level",
      "backup_restore_evidence", "transaction_boundary"]),
    freshnessRequired: true,
    independentVerifierRequired: true,
  }),
  multi_process_concurrency_unproved: Object.freeze({
    evidenceClass: "multi_process_concurrency_qualification",
    proofAuthority: "concurrency_qualifier",
    requiredBindings: Object.freeze(["concurrency_test_digest", "process_count", "claim_uniqueness", "crash_checkpoint",
      "replay_result"]),
    freshnessRequired: true,
    independentVerifierRequired: true,
  }),
  production_clock_custody_unproved: Object.freeze({
    evidenceClass: "production_clock_custody_attestation",
    proofAuthority: "clock_custodian",
    requiredBindings: Object.freeze(["clock_source_identity", "monotonicity", "skew_policy", "commit_boundary",
      "expiry_behavior"]),
    freshnessRequired: true,
    independentVerifierRequired: true,
  }),
  production_independent_review_missing: Object.freeze({
    evidenceClass: "production_independent_review",
    proofAuthority: "independent_reviewer",
    requiredBindings: Object.freeze(["candidate_commit", "contract_digest", "test_digest", "reviewer_identity",
      "disposition"]),
    freshnessRequired: false,
    independentVerifierRequired: true,
  }),
  production_owner_approval_missing: Object.freeze({
    evidenceClass: "production_owner_approval_attestation",
    proofAuthority: "owner_approval_authority",
    requiredBindings: Object.freeze(["activation_plan_digest", "assessment_digest", "decision_nonce", "issued_at",
      "expires_at", "strong_factor_evidence"]),
    freshnessRequired: true,
    independentVerifierRequired: false,
  }),
  production_policy_custody_unproved: Object.freeze({
    evidenceClass: "production_policy_custody_attestation",
    proofAuthority: "owner_policy_custodian",
    requiredBindings: Object.freeze(["policy_revision", "prior_digest", "owner_signature", "high_water_checkpoint",
      "effective_at", "expires_at"]),
    freshnessRequired: true,
    independentVerifierRequired: true,
  }),
});

function requirementMaterial(gateCode: ReadyFrontierProductionGateCodeV1):
  Omit<ReadyFrontierProductionGateRequirementV1, "requirementDigest"> {
  const definition = gateDefinitions[gateCode];
  return {
    schema: READY_FRONTIER_PRODUCTION_GATE_REQUIREMENT_V1,
    gateCode,
    evidenceClass: definition.evidenceClass,
    proofAuthority: definition.proofAuthority,
    requiredBindings: [...definition.requiredBindings],
    freshnessRequired: definition.freshnessRequired,
    independentVerifierRequired: definition.independentVerifierRequired,
    status: "unobserved",
    evidenceDigest: null,
    validUntil: null,
    repositoryCanSatisfy: false,
    grantsApproval: false,
    grantsActivationAuthority: false,
    grantsDispatchOrExecution: false,
    grantsExternalEffects: false,
  };
}

export function buildReadyFrontierProductionGateRequirementsV1(): ReadyFrontierProductionGateRequirementV1[] {
  return READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1.map((gateCode) => {
    const material = requirementMaterial(gateCode);
    return parseReadyFrontierProductionGateRequirementV1({ ...material, requirementDigest: sha256Digest(material) });
  });
}

export function parseReadyFrontierProductionGateRequirementV1(value: unknown):
  ReadyFrontierProductionGateRequirementV1 {
  const parsed = parseExactReadyFrontierV1(productionGateRequirementParserV1,
    value) as ReadyFrontierProductionGateRequirementV1;
  const expected = requirementMaterial(parsed.gateCode);
  if (parsed.evidenceClass !== expected.evidenceClass
    || parsed.proofAuthority !== expected.proofAuthority
    || !same(parsed.requiredBindings, expected.requiredBindings)
    || parsed.freshnessRequired !== expected.freshnessRequired
    || parsed.independentVerifierRequired !== expected.independentVerifierRequired
    || parsed.requirementDigest !== sha256Digest(expected)) fail("digest_mismatch");
  return parsed;
}

export function buildReadyFrontierProductionBoundaryPlanV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown): ReadyFrontierProductionBoundaryPlanV1 {
  const planKey = key(activationPacketIntegrityKey);
  try {
    const input = parseExactReadyFrontierV1(productionBoundaryPlanInputParserV1, inputValue);
    const packet = parseReadyFrontierActivationPacketV1(input.activationPacket, planKey);
    if (Date.parse(input.plannedAt) < Date.parse(packet.createdAt)
      || Date.parse(input.expiresAt) <= Date.parse(input.plannedAt)
      || Date.parse(input.expiresAt) - Date.parse(input.plannedAt)
        > READY_FRONTIER_PRODUCTION_PLAN_MAX_LIFETIME_SECONDS_V1 * 1_000) fail("policy_denied");
    const material: Omit<ReadyFrontierProductionBoundaryPlanV1, "planDigest" | "planAuthTag"> = {
    schema: READY_FRONTIER_PRODUCTION_BOUNDARY_PLAN_V1,
    planId: input.planId,
    tenantId: packet.tenantId,
    workspaceId: packet.workspaceId,
    activationPacketId: packet.packetId,
    activationPacketDigest: packet.packetDigest,
    activationPacketCreatedAt: packet.createdAt,
    simulationRunId: packet.simulationRunId,
    simulationRunDigest: packet.simulationRunDigest,
    acceptedAuto040Commit: READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1,
    acceptedAuto040ReviewSha256: READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1,
    requiredProductionGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    consumerProcessModel: "separate_service_principal",
    consumerChannelProtocol: "mutual_ed25519_authenticated_handoff_v1",
    handoffClaimMode: "transactional_single_owner_claim",
    databaseMode: "hosted_postgresql_required_unconfigured",
    brokerMode: "node_local_reference_only",
    clockMode: "protected_monotonic_and_database_boundary_required",
    policyCustodyMode: "owner_signed_external_high_water_required",
    ambiguityMode: "destination_evidence_or_new_owner_action",
    postMarkerUnknownState: "terminal_ambiguity",
    automaticRetryAfterMarker: false,
    defaultDisabled: true,
    repositoryDesignOnly: true,
    productionConfigurationPresent: false,
    protectedMaterialPresent: false,
    consumerImplemented: false,
    policyEnrolled: false,
    activationAuthorized: false,
    permitsProtectedReferenceResolution: false,
    permitsNetwork: false,
    permitsGitHubMutation: false,
    permitsAgentOrProviderContact: false,
    permitsClaimOrLease: false,
    permitsDispatchOrExecution: false,
    permitsExternalEffects: false,
    plannedAt: input.plannedAt,
    expiresAt: input.expiresAt,
    };
    const withDigest = { ...material, planDigest: sha256Digest(material) };
    return parseReadyFrontierProductionBoundaryPlanV1({ ...withDigest,
      planAuthTag: hmacSha256Tag(planKey, planAuthMaterial(withDigest)) }, planKey);
  } finally { planKey.fill(0); }
}

export function parseReadyFrontierProductionBoundaryPlanV1(value: unknown,
  activationPacketIntegrityKey: unknown): ReadyFrontierProductionBoundaryPlanV1 {
  const planKey = key(activationPacketIntegrityKey);
  try {
    const parsed = parseExactReadyFrontierV1(productionBoundaryPlanParserV1,
      value) as ReadyFrontierProductionBoundaryPlanV1;
    if (!same(parsed.requiredProductionGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
      || Date.parse(parsed.plannedAt) < Date.parse(parsed.activationPacketCreatedAt)
      || Date.parse(parsed.expiresAt) <= Date.parse(parsed.plannedAt)
      || Date.parse(parsed.expiresAt) - Date.parse(parsed.plannedAt)
        > READY_FRONTIER_PRODUCTION_PLAN_MAX_LIFETIME_SECONDS_V1 * 1_000
      || parsed.planDigest !== sha256Digest(planUnsigned(parsed))
      || !equal(parsed.planAuthTag, hmacSha256Tag(planKey, planAuthMaterial(parsed)))) fail("digest_mismatch");
    return parsed;
  } finally { planKey.fill(0); }
}

export function buildReadyFrontierProductionBoundaryAssessmentV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown):
  ReadyFrontierProductionBoundaryAssessmentV1 {
  const input = parseExactReadyFrontierV1(productionBoundaryAssessmentInputParserV1, inputValue);
  const plan = parseReadyFrontierProductionBoundaryPlanV1(input.plan, activationPacketIntegrityKey);
  if (Date.parse(input.assessedAt) < Date.parse(plan.plannedAt)
    || Date.parse(input.assessedAt) >= Date.parse(plan.expiresAt)) fail("policy_denied");
  const requirements = buildReadyFrontierProductionGateRequirementsV1();
  const material: Omit<ReadyFrontierProductionBoundaryAssessmentV1, "assessmentDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_BOUNDARY_ASSESSMENT_V1,
    assessmentId: input.assessmentId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    tenantId: plan.tenantId,
    workspaceId: plan.workspaceId,
    activationPacketId: plan.activationPacketId,
    activationPacketDigest: plan.activationPacketDigest,
    activationPacketCreatedAt: plan.activationPacketCreatedAt,
    simulationRunId: plan.simulationRunId,
    simulationRunDigest: plan.simulationRunDigest,
    plannedAt: plan.plannedAt,
    planExpiresAt: plan.expiresAt,
    planAuthTag: plan.planAuthTag,
    requirements,
    blockingGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    remainingProofCount: 9,
    state: "blocked_design_only",
    safeReason: "production_evidence_unobserved",
    eligibleForOwnerApproval: false,
    eligibleForActivation: false,
    requiresNewProductionEvidenceAssessment: true,
    requiresFreshStrongOwnerApproval: true,
    requiresIndependentSecurityReview: true,
    assessedAt: input.assessedAt,
    activationAuthorized: false,
    grantsApproval: false,
    grantsActivationAuthority: false,
    grantsClaimOrLease: false,
    grantsDispatchOrExecution: false,
    grantsExternalEffects: false,
  };
  return parseReadyFrontierProductionBoundaryAssessmentV1({ ...material,
    assessmentDigest: sha256Digest(material) }, activationPacketIntegrityKey);
}

export function parseReadyFrontierProductionBoundaryAssessmentV1(value: unknown,
  activationPacketIntegrityKey: unknown):
  ReadyFrontierProductionBoundaryAssessmentV1 {
  const planKey = key(activationPacketIntegrityKey);
  try {
    const parsed = parseExactReadyFrontierV1(productionBoundaryAssessmentParserV1,
      value) as ReadyFrontierProductionBoundaryAssessmentV1;
    const requirements = parsed.requirements.map(parseReadyFrontierProductionGateRequirementV1);
    const planEvidence = { planId: parsed.planId, planDigest: parsed.planDigest,
      tenantId: parsed.tenantId, workspaceId: parsed.workspaceId,
      activationPacketId: parsed.activationPacketId,
      activationPacketDigest: parsed.activationPacketDigest,
      activationPacketCreatedAt: parsed.activationPacketCreatedAt,
      simulationRunId: parsed.simulationRunId, simulationRunDigest: parsed.simulationRunDigest,
      plannedAt: parsed.plannedAt,
      expiresAt: parsed.planExpiresAt };
    if (!same(requirements.map((item) => item.gateCode), READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
      || !same(parsed.blockingGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
      || Date.parse(parsed.plannedAt) < Date.parse(parsed.activationPacketCreatedAt)
      || Date.parse(parsed.planExpiresAt) <= Date.parse(parsed.plannedAt)
      || Date.parse(parsed.planExpiresAt) - Date.parse(parsed.plannedAt)
        > READY_FRONTIER_PRODUCTION_PLAN_MAX_LIFETIME_SECONDS_V1 * 1_000
      || Date.parse(parsed.assessedAt) < Date.parse(parsed.plannedAt)
      || Date.parse(parsed.assessedAt) >= Date.parse(parsed.planExpiresAt)
      || !equal(parsed.planAuthTag, hmacSha256Tag(planKey, planAuthMaterial(planEvidence)))
      || parsed.assessmentDigest !== sha256Digest(unsigned(parsed as unknown as Record<string, unknown>, "assessmentDigest"))) {
      fail("digest_mismatch");
    }
    return parsed;
  } finally { planKey.fill(0); }
}

export function buildReadyFrontierProductionDisabledDispositionV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown):
  ReadyFrontierProductionDisabledDispositionV1 {
  const input = parseExactReadyFrontierV1(productionDisabledDispositionInputParserV1, inputValue);
  const assessment = parseReadyFrontierProductionBoundaryAssessmentV1(input.assessment, activationPacketIntegrityKey);
  if (Date.parse(input.recordedAt) < Date.parse(assessment.assessedAt)) fail("policy_denied");
  const material: Omit<ReadyFrontierProductionDisabledDispositionV1, "dispositionDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_DISABLED_DISPOSITION_V1,
    dispositionId: `frontier.production-disabled.${assessment.assessmentDigest.slice(7, 31)}`,
    planId: assessment.planId,
    planDigest: assessment.planDigest,
    assessmentId: assessment.assessmentId,
    assessmentDigest: assessment.assessmentDigest,
    tenantId: assessment.tenantId,
    workspaceId: assessment.workspaceId,
    status: "disabled_before_consumer_construction",
    blockingGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    safeReason: "production_evidence_unobserved",
    recordedAt: input.recordedAt,
    requiresNewAssessmentAndOwnerAuthorization: true,
    automaticRetryAllowed: false,
    productionConfigurationRead: false,
    databaseContacted: false,
    protectedReferenceResolutionAttempted: false,
    consumerConstructed: false,
    claimOrLeaseAttempted: false,
    handoffConsumed: false,
    agentOrProviderContacted: false,
    networkContacted: false,
    deploymentAttempted: false,
    externalEffectOccurred: false,
    grantsApproval: false,
    grantsActivationAuthority: false,
    grantsDispatchOrExecution: false,
  };
  return parseReadyFrontierProductionDisabledDispositionV1({ ...material,
    dispositionDigest: sha256Digest(material) });
}

export function parseReadyFrontierProductionDisabledDispositionV1(value: unknown):
  ReadyFrontierProductionDisabledDispositionV1 {
  const parsed = parseExactReadyFrontierV1(productionDisabledDispositionParserV1,
    value) as ReadyFrontierProductionDisabledDispositionV1;
  const expectedDispositionId = `frontier.production-disabled.${parsed.assessmentDigest.slice(7, 31)}`;
  if (parsed.dispositionId !== expectedDispositionId
    || !same(parsed.blockingGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
    || parsed.dispositionDigest !== sha256Digest(unsigned(parsed as unknown as Record<string, unknown>,
      "dispositionDigest"))) fail("digest_mismatch");
  return parsed;
}

const reconciliationTransitions = new Map<string, ReadyFrontierProductionReconciliationStateV1>([
  ["pending|claim_acquired", "claimed"],
  ["claimed|definite_precontact_failure", "failed_before_contact"],
  ["claimed|delivery_marker_written", "delivery_started"],
  ["delivery_started|post_marker_unknown", "ambiguous"],
  ["delivery_started|qualified_destination_confirmed", "confirmed"],
  ["delivery_started|qualified_destination_absence_observed", "ambiguous"],
  ["ambiguous|qualified_destination_confirmed", "confirmed"],
  ["ambiguous|independent_destination_absence_confirmed", "reconciled_not_delivered"],
]);

export function evaluateReadyFrontierProductionReconciliationV1(fromStateValue: unknown,
  eventValue: unknown): ReadyFrontierProductionReconciliationDecisionV1 {
  const fromState = parseExactReadyFrontierV1(productionReconciliationStateParserV1, fromStateValue);
  const event = parseExactReadyFrontierV1(productionReconciliationEventParserV1, eventValue);
  const toState = reconciliationTransitions.get(`${fromState}|${event}`) ?? null;
  const destinationEvidence = event === "qualified_destination_confirmed"
    || event === "qualified_destination_absence_observed"
    || event === "independent_destination_absence_confirmed";
  const material: Omit<ReadyFrontierProductionReconciliationDecisionV1, "decisionDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_RECONCILIATION_DECISION_V1,
    fromState,
    event,
    toState,
    permittedByStateMachine: toState !== null,
    requiresProtectedDatabaseTransaction: toState !== null,
    requiresQualifiedDestinationEvidence: destinationEvidence,
    requiresNewOwnerAuthorizedActionBeforeRetry: toState === "ambiguous" || toState === "reconciled_not_delivered",
    automaticRetryAllowed: false,
    performsConsumerAction: false,
    contactsDestination: false,
    grantsClaimOrLease: false,
    grantsDispatchOrExecution: false,
    grantsExternalEffects: false,
  };
  return parseReadyFrontierProductionReconciliationDecisionV1({ ...material,
    decisionDigest: sha256Digest(material) });
}

export function parseReadyFrontierProductionReconciliationDecisionV1(value: unknown):
  ReadyFrontierProductionReconciliationDecisionV1 {
  const parsed = parseExactReadyFrontierV1(productionReconciliationDecisionParserV1,
    value) as ReadyFrontierProductionReconciliationDecisionV1;
  const expected = reconciliationTransitions.get(`${parsed.fromState}|${parsed.event}`) ?? null;
  const destinationEvidence = parsed.event === "qualified_destination_confirmed"
    || parsed.event === "qualified_destination_absence_observed"
    || parsed.event === "independent_destination_absence_confirmed";
  if (parsed.toState !== expected
    || parsed.permittedByStateMachine !== (expected !== null)
    || parsed.requiresProtectedDatabaseTransaction !== (expected !== null)
    || parsed.requiresQualifiedDestinationEvidence !== destinationEvidence
    || parsed.requiresNewOwnerAuthorizedActionBeforeRetry !== (expected === "ambiguous"
      || expected === "reconciled_not_delivered")
    || parsed.decisionDigest !== sha256Digest(unsigned(parsed as unknown as Record<string, unknown>, "decisionDigest"))) {
    fail("digest_mismatch");
  }
  return parsed;
}

export function projectReadyFrontierProductionBoundaryV1(assessmentValue: unknown,
  dispositionValue: unknown, activationPacketIntegrityKey: unknown): ReadyFrontierProductionBoundaryProjectionV1 {
  const assessment = parseReadyFrontierProductionBoundaryAssessmentV1(assessmentValue, activationPacketIntegrityKey);
  const disposition = parseReadyFrontierProductionDisabledDispositionV1(dispositionValue);
  if (disposition.planId !== assessment.planId
    || disposition.assessmentId !== assessment.assessmentId
    || disposition.assessmentDigest !== assessment.assessmentDigest
    || disposition.planDigest !== assessment.planDigest
    || disposition.tenantId !== assessment.tenantId
    || disposition.workspaceId !== assessment.workspaceId
    || Date.parse(disposition.recordedAt) < Date.parse(assessment.assessedAt)) fail("scope_mismatch");
  const material: Omit<ReadyFrontierProductionBoundaryProjectionV1, "projectionDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_BOUNDARY_PROJECTION_V1,
    tenantId: assessment.tenantId,
    workspaceId: assessment.workspaceId,
    planId: assessment.planId,
    assessmentId: assessment.assessmentId,
    status: "blocked_design_only",
    safeReason: "production_evidence_unobserved",
    blockingGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    remainingProofCount: 9,
    canActivateProduction: false,
    canConstructConsumer: false,
    canResolveProtectedReferences: false,
    canContactNetwork: false,
    canClaimOrLease: false,
    canDispatchOrExecute: false,
  };
  return parseReadyFrontierProductionBoundaryProjectionV1({ ...material, projectionDigest: sha256Digest(material) });
}

export function parseReadyFrontierProductionBoundaryProjectionV1(value: unknown):
  ReadyFrontierProductionBoundaryProjectionV1 {
  const parsed = parseExactReadyFrontierV1(productionBoundaryProjectionParserV1,
    value) as ReadyFrontierProductionBoundaryProjectionV1;
  if (!same(parsed.blockingGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
    || parsed.projectionDigest !== sha256Digest(unsigned(parsed as unknown as Record<string, unknown>,
      "projectionDigest"))) fail("digest_mismatch");
  return parsed;
}
