import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1,
} from "./hermes-021-enrolled-gateway-port";
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
  "0a736ad16e1ea7ffef37e434eba5bd46f483f95d" as const;
export const IDEA_LAB_HERMES_021_FIXED_RPC_REVIEW_PACKET_SHA256_V1 =
  "sha256:3af97a655945f978492682ecbab26c9a4aeda1d5c202f22ed3f6c021d1d337a8" as const;

const readinessSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_ENROLLMENT_READINESS_V1),
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  connectionSourceCandidateDigest: z.literal(ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest),
  fixedRpcSourceManifestDigest: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1),
  gatewayOperationSetDigest: z.literal(IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1),
  fixedRpcImplementationCommit: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_IMPLEMENTATION_COMMIT_V1),
  independentReviewPacketSha256: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_REVIEW_PACKET_SHA256_V1),
  reviewMode: z.literal("independent_review_report_only_zero_repair"),
  independentReviewDisposition: z.literal("unobserved"),
  independentReviewerVerified: z.literal(false),
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
    z.literal("independent_review_missing"),
    z.literal("connector_implementation_missing"),
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
  reviewMode: "independent_review_report_only_zero_repair" as const,
  independentReviewDisposition: "unobserved" as const,
  independentReviewerVerified: false as const,
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
    "independent_review_missing", "connector_implementation_missing", "trusted_node_signer_not_enrolled",
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
