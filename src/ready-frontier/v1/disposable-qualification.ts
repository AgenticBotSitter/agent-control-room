import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import {
  READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_EVIDENCE_BYTES_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_REQUEST_LIFETIME_SECONDS_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_PROJECTION_V1,
  READY_FRONTIER_DISPOSABLE_QUALIFICATION_REQUEST_V1,
  readyFrontierDisposableQualificationOperationCodesV1,
  readyFrontierDisposableQualificationRequirementCodesV1,
  type ReadyFrontierDisposableQualificationProjectionV1,
  type ReadyFrontierDisposableQualificationRequestV1,
} from "./disposable-qualification-types";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import {
  parseReadyFrontierProductionCustodyPlanV1,
  parseReadyFrontierProductionCustodyReportV1,
} from "./production-custody";
import { readyFrontierProductionCustodyScenarioCodesV1 } from "./production-custody-types";

const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const objectValuesV1 = Object.values;
const dateConstructorV1 = Date;
const dateParseV1 = Date.parse;
const dateGetTimeV1 = Date.prototype.getTime;
const dateToISOStringV1 = Date.prototype.toISOString;
const reflectApplyV1 = Reflect.apply;
const numberIsNaNV1 = Number.isNaN;
const bufferFromV1 = Buffer.from;

function bindPrivateParserV1<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
  const parse = schema.parse.bind(schema);
  return objectFreezeV1({ parse });
}

const idSchemaV1 = z.string().min(3).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
const digestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const authTagSchemaV1 = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
const timeSchemaV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new dateConstructorV1(value);
    const epoch = reflectApplyV1(dateGetTimeV1, parsed, []) as number;
    const canonical = numberIsNaNV1(epoch) ? "" : reflectApplyV1(dateToISOStringV1, parsed, []) as string;
    return !numberIsNaNV1(epoch) && canonical === value && dateParseV1(value) === epoch;
  }, "invalid canonical instant");
const operationSchemaV1 = z.enum(readyFrontierDisposableQualificationOperationCodesV1);
const requirementSchemaV1 = z.enum(readyFrontierDisposableQualificationRequirementCodesV1);
const scenarioSchemaV1 = z.enum(readyFrontierProductionCustodyScenarioCodesV1);
const requestInputSchemaV1 = z.object({
  requestId: idSchemaV1,
  sourceCustodyPlan: z.unknown(),
  sourceCustodyReport: z.unknown(),
  requestedAt: timeSchemaV1,
  expiresAt: timeSchemaV1,
}).strict();
const requestSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_DISPOSABLE_QUALIFICATION_REQUEST_V1),
  requestId: idSchemaV1,
  tenantId: idSchemaV1,
  workspaceId: idSchemaV1,
  sourceCustodyPlanId: idSchemaV1,
  sourceCustodyPlanDigest: digestSchemaV1,
  sourceCustodyReportId: idSchemaV1,
  sourceCustodyReportDigest: digestSchemaV1,
  sourceCustodyPlan: z.unknown(),
  sourceCustodyReport: z.unknown(),
  acceptedAuto070Commit: z.literal(READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1),
  acceptedAuto070ReviewSha256: z.literal(READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1),
  packetKind: z.literal("controlled_effect_request_not_authority"),
  qualificationMode: z.literal("owner_authorized_disposable_hosted_required"),
  requestedProviderClass: z.literal("owner_selected_private_hosted_postgresql"),
  requestedResourceClass: z.literal("new_disposable_nonproduction_only"),
  protectedAccessMode: z.literal("owner_attended_protected_reference_only"),
  transactionIsolationRequired: z.literal("serializable"),
  evidenceMode: z.literal("sanitized_digest_and_safe_codes_only"),
  scenarioCodes: z.array(scenarioSchemaV1).length(8),
  requestedOperations: z.array(operationSchemaV1).length(7),
  blockingRequirementCodes: z.array(requirementSchemaV1).length(10),
  requestedDatabaseCount: z.literal(2),
  requestedProcessCount: z.literal(3),
  maxProviderCallsRequested: z.literal(READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1),
  maxDurationSecondsRequested: z.literal(READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1),
  maxEvidenceBytesRequested: z.literal(READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_EVIDENCE_BYTES_V1),
  cleanupRequired: z.literal(true),
  cleanupMustBeSeparatelyAuthorized: z.literal(true),
  cleanupReceiptRequired: z.literal(true),
  rawEvidenceRetentionAllowed: z.literal(false),
  productionDataAllowed: z.literal(false),
  publicEndpointAllowed: z.literal(false),
  providerSelected: z.literal(false),
  disposableResourcesAssigned: z.literal(false),
  protectedReferencesPresent: z.literal(false),
  ownerAuthorizationPresent: z.literal(false),
  ownerSignaturePresent: z.literal(false),
  networkAuthorized: z.literal(false),
  processStartAuthorized: z.literal(false),
  databaseContactAuthorized: z.literal(false),
  cleanupAuthorized: z.literal(false),
  liveQualificationAuthorized: z.literal(false),
  productionConsumerAuthorized: z.literal(false),
  productionActivationAuthorized: z.literal(false),
  grantsApproval: z.literal(false),
  grantsClaimOrLease: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  grantsExternalEffects: z.literal(false),
  state: z.literal("blocked_pending_owner_authorization_and_resources"),
  safeReason: z.literal("controlled_effect_packet_not_issued"),
  requestedAt: timeSchemaV1,
  expiresAt: timeSchemaV1,
  requestDigest: digestSchemaV1,
  requestAuthTag: authTagSchemaV1,
}).strict();
const projectionSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_DISPOSABLE_QUALIFICATION_PROJECTION_V1),
  requestId: idSchemaV1,
  tenantId: idSchemaV1,
  workspaceId: idSchemaV1,
  sourceCustodyReportId: idSchemaV1,
  status: z.literal("blocked_pending_owner_authorization_and_resources"),
  safeReason: z.literal("controlled_effect_packet_not_issued"),
  requestedProviderClass: z.literal("owner_selected_private_hosted_postgresql"),
  requestedResourceClass: z.literal("new_disposable_nonproduction_only"),
  requestedOperations: z.array(operationSchemaV1).length(7),
  blockingRequirementCodes: z.array(requirementSchemaV1).length(10),
  maxProviderCallsRequested: z.literal(READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1),
  maxDurationSecondsRequested: z.literal(READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1),
  cleanupRequired: z.literal(true),
  canSelectProvider: z.literal(false),
  canResolveProtectedReferences: z.literal(false),
  canContactNetwork: z.literal(false),
  canStartProcesses: z.literal(false),
  canContactDatabase: z.literal(false),
  canRunLiveQualification: z.literal(false),
  canCleanupResources: z.literal(false),
  canActivateProduction: z.literal(false),
  canDispatchOrExecute: z.literal(false),
  projectionDigest: digestSchemaV1,
}).strict();

const requestInputParserV1 = bindPrivateParserV1(requestInputSchemaV1);
const requestParserV1 = bindPrivateParserV1(requestSchemaV1);
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
  const a = bufferFromV1(left), b = bufferFromV1(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function without<T extends Record<string, unknown>>(value: T, field: keyof T): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}
function requestUnsigned(request: ReadyFrontierDisposableQualificationRequestV1): Record<string, unknown> {
  return without(without(request as unknown as Record<string, unknown>, "requestAuthTag"), "requestDigest");
}
function requestAuthMaterial(request: Pick<ReadyFrontierDisposableQualificationRequestV1,
  "requestId" | "requestDigest" | "tenantId" | "workspaceId" | "sourceCustodyPlanDigest"
  | "sourceCustodyReportDigest" | "requestedAt" | "expiresAt">): Record<string, unknown> {
  return {
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    sourceCustodyPlanDigest: request.sourceCustodyPlanDigest,
    sourceCustodyReportDigest: request.sourceCustodyReportDigest,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
  };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !objectIsFrozenV1(value)) {
    objectFreezeV1(value);
    if (!objectIsFrozenV1(value)) fail("integrity_failed");
    const children = objectValuesV1(value as Record<string, unknown>);
    for (let index = 0; index < children.length; index += 1) deepFreeze(children[index]);
  }
  return value;
}
function scenarioCodesV1(): ReadyFrontierDisposableQualificationRequestV1["scenarioCodes"] {
  return [
    "service_identity_separation",
    "owner_policy_high_water",
    "protected_clock_commit_boundary",
    "revocation_cross_process_convergence",
    "serializable_claim_uniqueness",
    "checkpoint_compare_and_swap",
    "backup_restore_rollback_detection",
    "post_marker_ambiguity",
  ];
}
function operationCodesV1(): ReadyFrontierDisposableQualificationRequestV1["requestedOperations"] {
  return [
    "provision_disposable_database",
    "start_three_isolated_workers",
    "run_eight_bounded_scenarios",
    "create_isolated_backup",
    "restore_to_second_isolated_database",
    "collect_sanitized_evidence",
    "destroy_disposable_resources",
  ];
}
function requirementCodesV1(): ReadyFrontierDisposableQualificationRequestV1["blockingRequirementCodes"] {
  return [
    "exact_owner_signature",
    "owner_selected_private_provider",
    "disposable_resource_identity",
    "protected_credential_reference",
    "three_independent_service_identities",
    "external_checkpoint_custodian",
    "protected_commit_clock",
    "terminal_revocation_feed",
    "cleanup_authority_and_receipt",
    "independent_result_review",
  ];
}
function validateSourceV1(planValue: unknown, reportValue: unknown,
  activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown) {
  const plan = parseReadyFrontierProductionCustodyPlanV1(
    planValue, activationPacketIntegrityKey, qualificationIntegrityKey);
  const report = parseReadyFrontierProductionCustodyReportV1(
    reportValue, plan, activationPacketIntegrityKey, qualificationIntegrityKey);
  if (report.status !== "simulated_pass" || report.injectedFault !== "none"
    || report.simulatedPassCount !== 8 || report.simulatedFailureCount !== 0
    || report.qualifiedProofCount !== 0 || report.remainingQualifiedProofCount !== 9) {
    fail("policy_denied");
  }
  return { plan, report };
}

export function buildReadyFrontierDisposableQualificationRequestV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown,
  requestIntegrityKey: unknown): ReadyFrontierDisposableQualificationRequestV1 {
  const requestKey = key(requestIntegrityKey);
  try {
    const input = parseExactReadyFrontierV1(requestInputParserV1, inputValue);
    const { plan, report } = validateSourceV1(input.sourceCustodyPlan, input.sourceCustodyReport,
      activationPacketIntegrityKey, qualificationIntegrityKey);
    if (dateParseV1(input.requestedAt) < dateParseV1(report.completedAt)
      || dateParseV1(input.expiresAt) <= dateParseV1(input.requestedAt)
      || dateParseV1(input.expiresAt) > dateParseV1(plan.expiresAt)
      || dateParseV1(input.expiresAt) - dateParseV1(input.requestedAt)
        > READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_REQUEST_LIFETIME_SECONDS_V1 * 1_000) {
      fail("policy_denied");
    }
    const material: Omit<ReadyFrontierDisposableQualificationRequestV1, "requestDigest" | "requestAuthTag"> = {
      schema: READY_FRONTIER_DISPOSABLE_QUALIFICATION_REQUEST_V1,
      requestId: input.requestId,
      tenantId: plan.tenantId,
      workspaceId: plan.workspaceId,
      sourceCustodyPlanId: plan.planId,
      sourceCustodyPlanDigest: plan.planDigest,
      sourceCustodyReportId: report.reportId,
      sourceCustodyReportDigest: report.reportDigest,
      sourceCustodyPlan: plan,
      sourceCustodyReport: report,
      acceptedAuto070Commit: READY_FRONTIER_ACCEPTED_AUTO070_COMMIT_V1,
      acceptedAuto070ReviewSha256: READY_FRONTIER_ACCEPTED_AUTO070_REVIEW_SHA256_V1,
      packetKind: "controlled_effect_request_not_authority",
      qualificationMode: "owner_authorized_disposable_hosted_required",
      requestedProviderClass: "owner_selected_private_hosted_postgresql",
      requestedResourceClass: "new_disposable_nonproduction_only",
      protectedAccessMode: "owner_attended_protected_reference_only",
      transactionIsolationRequired: "serializable",
      evidenceMode: "sanitized_digest_and_safe_codes_only",
      scenarioCodes: scenarioCodesV1(),
      requestedOperations: operationCodesV1(),
      blockingRequirementCodes: requirementCodesV1(),
      requestedDatabaseCount: 2,
      requestedProcessCount: 3,
      maxProviderCallsRequested: READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_PROVIDER_CALLS_V1,
      maxDurationSecondsRequested: READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_DURATION_SECONDS_V1,
      maxEvidenceBytesRequested: READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_EVIDENCE_BYTES_V1,
      cleanupRequired: true,
      cleanupMustBeSeparatelyAuthorized: true,
      cleanupReceiptRequired: true,
      rawEvidenceRetentionAllowed: false,
      productionDataAllowed: false,
      publicEndpointAllowed: false,
      providerSelected: false,
      disposableResourcesAssigned: false,
      protectedReferencesPresent: false,
      ownerAuthorizationPresent: false,
      ownerSignaturePresent: false,
      networkAuthorized: false,
      processStartAuthorized: false,
      databaseContactAuthorized: false,
      cleanupAuthorized: false,
      liveQualificationAuthorized: false,
      productionConsumerAuthorized: false,
      productionActivationAuthorized: false,
      grantsApproval: false,
      grantsClaimOrLease: false,
      grantsDispatchOrExecution: false,
      grantsExternalEffects: false,
      state: "blocked_pending_owner_authorization_and_resources",
      safeReason: "controlled_effect_packet_not_issued",
      requestedAt: input.requestedAt,
      expiresAt: input.expiresAt,
    };
    const requestDigest = sha256Digest(material);
    return parseReadyFrontierDisposableQualificationRequestV1({
      ...material,
      requestDigest,
      requestAuthTag: hmacSha256Tag(requestKey, requestAuthMaterial({ ...material, requestDigest })),
    }, activationPacketIntegrityKey, qualificationIntegrityKey, requestKey);
  } finally {
    requestKey.fill(0);
  }
}

export function parseReadyFrontierDisposableQualificationRequestV1(value: unknown,
  activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown,
  requestIntegrityKey: unknown): ReadyFrontierDisposableQualificationRequestV1 {
  const requestKey = key(requestIntegrityKey);
  try {
    const request = parseExactReadyFrontierV1(requestParserV1, value) as
      ReadyFrontierDisposableQualificationRequestV1;
    const { plan, report } = validateSourceV1(request.sourceCustodyPlan, request.sourceCustodyReport,
      activationPacketIntegrityKey, qualificationIntegrityKey);
    if (request.tenantId !== plan.tenantId || request.workspaceId !== plan.workspaceId
      || request.sourceCustodyPlanId !== plan.planId
      || request.sourceCustodyPlanDigest !== plan.planDigest
      || request.sourceCustodyReportId !== report.reportId
      || request.sourceCustodyReportDigest !== report.reportDigest
      || !sameList(request.scenarioCodes, scenarioCodesV1())
      || !sameList(request.requestedOperations, operationCodesV1())
      || !sameList(request.blockingRequirementCodes, requirementCodesV1())
      || dateParseV1(request.requestedAt) < dateParseV1(report.completedAt)
      || dateParseV1(request.expiresAt) <= dateParseV1(request.requestedAt)
      || dateParseV1(request.expiresAt) > dateParseV1(plan.expiresAt)
      || dateParseV1(request.expiresAt) - dateParseV1(request.requestedAt)
        > READY_FRONTIER_DISPOSABLE_QUALIFICATION_MAX_REQUEST_LIFETIME_SECONDS_V1 * 1_000
      || !sameText(request.requestDigest, sha256Digest(requestUnsigned(request)))
      || !sameText(request.requestAuthTag, hmacSha256Tag(requestKey, requestAuthMaterial(request)))) {
      fail("digest_mismatch");
    }
    return deepFreeze(request);
  } finally {
    requestKey.fill(0);
  }
}

export function projectReadyFrontierDisposableQualificationRequestV1(value: unknown,
  activationPacketIntegrityKey: unknown, qualificationIntegrityKey: unknown,
  requestIntegrityKey: unknown): ReadyFrontierDisposableQualificationProjectionV1 {
  const request = parseReadyFrontierDisposableQualificationRequestV1(value,
    activationPacketIntegrityKey, qualificationIntegrityKey, requestIntegrityKey);
  const material: Omit<ReadyFrontierDisposableQualificationProjectionV1, "projectionDigest"> = {
    schema: READY_FRONTIER_DISPOSABLE_QUALIFICATION_PROJECTION_V1,
    requestId: request.requestId,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    sourceCustodyReportId: request.sourceCustodyReportId,
    status: request.state,
    safeReason: request.safeReason,
    requestedProviderClass: request.requestedProviderClass,
    requestedResourceClass: request.requestedResourceClass,
    requestedOperations: operationCodesV1(),
    blockingRequirementCodes: requirementCodesV1(),
    maxProviderCallsRequested: request.maxProviderCallsRequested,
    maxDurationSecondsRequested: request.maxDurationSecondsRequested,
    cleanupRequired: true,
    canSelectProvider: false,
    canResolveProtectedReferences: false,
    canContactNetwork: false,
    canStartProcesses: false,
    canContactDatabase: false,
    canRunLiveQualification: false,
    canCleanupResources: false,
    canActivateProduction: false,
    canDispatchOrExecute: false,
  };
  const projection = parseExactReadyFrontierV1(projectionParserV1, {
    ...material,
    projectionDigest: sha256Digest(material),
  }) as ReadyFrontierDisposableQualificationProjectionV1;
  return deepFreeze(projection);
}
