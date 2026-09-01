import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1,
} from "./hermes-021-fixed-operation-set";
import { ideaLabHermes021BuiltInConnectionSourceV1 } from "./hermes-021-enrolled-connection";
import {
  IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
} from "./hermes-021-fixed-rpc-bridge";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
} from "./hermes-021-panel-packet";
import { ideaDigestSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_021_ENROLLMENT_READINESS_V1 =
  "control-room-hermes-021-enrollment-readiness/v1" as const;
export const IDEA_LAB_HERMES_021_FIXED_RPC_IMPLEMENTATION_COMMIT_V1 =
  "2bc80a20c7e4e1753b014395866972622c134fd3" as const;
export const IDEA_LAB_HERMES_021_FIXED_RPC_REVIEW_PACKET_SHA256_V1 =
  "sha256:a5d406b36546524bba452cdae34f670261e243ae758287cb55c217848402f3a8" as const;
export const IDEA_LAB_HERMES_021_PRIOR_REVIEW_REPORT_SHA256_V1 =
  "sha256:d5695fb5d52bbcf90cfa7440ae3ec46a3a46e8628ee7866ec90a291b4129b87f" as const;
export const IDEA_LAB_HERMES_021_LATEST_REVIEW_REPORT_SHA256_V1 =
  "sha256:7f9e3f73142a3af120218f3df51f9e47fbc71d5764bb586346da7c87ee75bd62" as const;
export const IDEA_LAB_HERMES_021_ACCEPTED_REVIEW_REPORT_SHA256_V1 =
  "sha256:6ed834e8b5c3418bc0bc932e56ae991a9c33f4699b81860f78be194a34a5b9c8" as const;
export const IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REMEDIATION_COMMIT_V1 =
  "d22c76444b80f8dd469380aab52ec457f5d76fad" as const;
export const IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_PACKET_SHA256_V1 =
  "sha256:4800d632123fc1d97a98ed4a3e887e7502520461ba3ce4533c718b1625acb4eb" as const;
export const IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_REPORT_SHA256_V1 =
  "sha256:d9a1acb60b3a272a71469fc07574db2d504100f7a382fb33a702a50c585b5808" as const;

const readinessSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_ENROLLMENT_READINESS_V1),
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  connectionSourceCandidateDigest: z.literal(ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest),
  fixedRpcSourceManifestDigest: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1),
  gatewayOperationSetDigest: z.literal(IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1),
  fixedRpcImplementationCommit: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_IMPLEMENTATION_COMMIT_V1),
  independentReviewPacketSha256: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_REVIEW_PACKET_SHA256_V1),
  priorIndependentReviewReportSha256: z.literal(IDEA_LAB_HERMES_021_PRIOR_REVIEW_REPORT_SHA256_V1),
  priorIndependentReviewDisposition: z.literal("remediation_required"),
  latestIndependentReviewReportSha256: z.literal(IDEA_LAB_HERMES_021_LATEST_REVIEW_REPORT_SHA256_V1),
  latestIndependentReviewDisposition: z.literal("remediation_required"),
  acceptedIndependentReviewReportSha256: z.literal(IDEA_LAB_HERMES_021_ACCEPTED_REVIEW_REPORT_SHA256_V1),
  reviewMode: z.literal("independent_review_report_only_zero_repair"),
  independentReviewDisposition: z.literal("accepted_provider_disabled_snapshot"),
  independentReviewerVerified: z.literal(true),
  macosConnectorRemediationCommit: z.literal(IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REMEDIATION_COMMIT_V1),
  macosConnectorIndependentReviewPacketSha256: z.literal(
    IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_PACKET_SHA256_V1),
  macosConnectorIndependentReviewReportSha256: z.literal(
    IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_REPORT_SHA256_V1),
  macosConnectorIndependentReviewDisposition: z.literal("remediation_required"),
  macosConnectorLatestReviewDisposition: z.literal("blocked_incomplete_review"),
  macosConnectorInterruptedReviewAttempts: z.literal(2),
  macosConnectorCancellationDefectReproduced: z.literal(true),
  macosConnectorCancellationBoundary: z.literal("opaque_repository_capability"),
  macosConnectorRemediationReviewPending: z.literal(true),
  connectorImplementationAccepted: z.literal(false),
  trustedNodeSignerEnrolled: z.literal(false),
  signedConnectionEnrollmentAccepted: z.literal(false),
  effectFreePreflightAccepted: z.literal(false),
  ownerPacketRefreshed: z.literal(false),
  freshOwnerAuthorizationPresent: z.literal(false),
  nativeQualificationAccepted: z.literal(false),
  realEnrollmentEligible: z.literal(false),
  ownerCommandEmitted: z.literal(false),
  oldAuthorizationReusable: z.literal(false),
  status: z.literal("blocked_before_real_enrollment"),
  blockerCodes: z.tuple([
    z.literal("connector_implementation_unaccepted"),
    z.literal("trusted_node_signer_not_enrolled"),
    z.literal("signed_connection_enrollment_missing"),
    z.literal("effect_free_preflight_missing"),
    z.literal("owner_packet_refresh_missing"),
    z.literal("fresh_owner_authorization_missing"),
    z.literal("native_qualification_missing"),
  ]),
  connectionAttemptsMade: z.literal(0),
  sshConnectionsMade: z.literal(0),
  gatewayCallsMade: z.literal(0),
  nativeAttemptsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  protectedValuesAccessed: z.literal(false),
  networkContacted: z.literal(false),
  automaticRetryAllowed: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  readinessDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabHermes021EnrollmentReadinessV1 = z.infer<typeof readinessSchema>;

const material = {
  contractVersion: IDEA_LAB_HERMES_021_ENROLLMENT_READINESS_V1,
  runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1,
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  connectionSourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
  fixedRpcSourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
  gatewayOperationSetDigest: IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1,
  fixedRpcImplementationCommit: IDEA_LAB_HERMES_021_FIXED_RPC_IMPLEMENTATION_COMMIT_V1,
  independentReviewPacketSha256: IDEA_LAB_HERMES_021_FIXED_RPC_REVIEW_PACKET_SHA256_V1,
  priorIndependentReviewReportSha256: IDEA_LAB_HERMES_021_PRIOR_REVIEW_REPORT_SHA256_V1,
  priorIndependentReviewDisposition: "remediation_required" as const,
  latestIndependentReviewReportSha256: IDEA_LAB_HERMES_021_LATEST_REVIEW_REPORT_SHA256_V1,
  latestIndependentReviewDisposition: "remediation_required" as const,
  acceptedIndependentReviewReportSha256: IDEA_LAB_HERMES_021_ACCEPTED_REVIEW_REPORT_SHA256_V1,
  reviewMode: "independent_review_report_only_zero_repair" as const,
  independentReviewDisposition: "accepted_provider_disabled_snapshot" as const,
  independentReviewerVerified: true as const,
  macosConnectorRemediationCommit: IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REMEDIATION_COMMIT_V1,
  macosConnectorIndependentReviewPacketSha256: IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_PACKET_SHA256_V1,
  macosConnectorIndependentReviewReportSha256: IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_REPORT_SHA256_V1,
  macosConnectorIndependentReviewDisposition: "remediation_required" as const,
  macosConnectorLatestReviewDisposition: "blocked_incomplete_review" as const,
  macosConnectorInterruptedReviewAttempts: 2 as const,
  macosConnectorCancellationDefectReproduced: true as const,
  macosConnectorCancellationBoundary: "opaque_repository_capability" as const,
  macosConnectorRemediationReviewPending: true as const,
  connectorImplementationAccepted: false as const,
  trustedNodeSignerEnrolled: false as const,
  signedConnectionEnrollmentAccepted: false as const,
  effectFreePreflightAccepted: false as const,
  ownerPacketRefreshed: false as const,
  freshOwnerAuthorizationPresent: false as const,
  nativeQualificationAccepted: false as const,
  realEnrollmentEligible: false as const,
  ownerCommandEmitted: false as const,
  oldAuthorizationReusable: false as const,
  status: "blocked_before_real_enrollment" as const,
  blockerCodes: [
    "connector_implementation_unaccepted", "trusted_node_signer_not_enrolled",
    "signed_connection_enrollment_missing", "effect_free_preflight_missing", "owner_packet_refresh_missing",
    "fresh_owner_authorization_missing", "native_qualification_missing",
  ] as const,
  connectionAttemptsMade: 0 as const,
  sshConnectionsMade: 0 as const,
  gatewayCallsMade: 0 as const,
  nativeAttemptsMade: 0 as const,
  providerCallsMade: 0 as const,
  protectedValuesAccessed: false as const,
  networkContacted: false as const,
  automaticRetryAllowed: false as const,
  grantsApproval: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

const readiness = readinessSchema.parse({ ...material, readinessDigest: sha256Digest(material) });
Object.freeze(readiness.blockerCodes);

export const ideaLabHermes021EnrollmentReadinessV1: IdeaLabHermes021EnrollmentReadinessV1 =
  Object.freeze(readiness);

export function parseIdeaLabHermes021EnrollmentReadinessV1(value: unknown):
IdeaLabHermes021EnrollmentReadinessV1 {
  const parsed = parseExactIdeaLabV1(readinessSchema, value);
  const unsigned = { ...parsed } as Record<string, unknown>;
  delete unsigned.readinessDigest;
  if (sha256Digest(unsigned) !== parsed.readinessDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}
