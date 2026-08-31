import { z } from "zod";
import { sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import {
  contentBloomsAdapterReleaseSchemaV1,
  contentBloomsDigestSchemaV1,
  contentBloomsSafeIdSchemaV1,
  contentBloomsTimeSchemaV1,
} from "./schemas";
import {
  CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
  CONTENT_BLOOMS_AUTHORITY_MODE_V1,
  CONTENT_BLOOMS_READ_OPERATIONS_V1,
  CONTENT_BLOOMS_SOURCE_SYSTEM_V1,
  type ContentBloomsAdapterReleaseV1,
} from "./types";

const releaseInputSchemaV1 = z.object({
  releaseId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  redactionPolicyVersion: contentBloomsSafeIdSchemaV1,
  adapterPackageDigest: contentBloomsDigestSchemaV1,
  projectionSchemaDigest: contentBloomsDigestSchemaV1,
  conformanceEvidenceDigest: contentBloomsDigestSchemaV1,
  acceptanceProfileDigest: contentBloomsDigestSchemaV1,
  acceptedReviewDigest: contentBloomsDigestSchemaV1,
  completionSnapshotDigest: contentBloomsDigestSchemaV1,
  producerIdentityDigest: contentBloomsDigestSchemaV1,
  reviewerIdentityDigest: contentBloomsDigestSchemaV1,
  acceptedAt: contentBloomsTimeSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.producerIdentityDigest === value.reviewerIdentityDigest) {
    context.addIssue({ code: "custom", message: "adapter release requires producer-independent acceptance" });
  }
});

function withoutDigest(release: ContentBloomsAdapterReleaseV1): Omit<ContentBloomsAdapterReleaseV1, "releaseDigest"> {
  const { releaseDigest: _releaseDigest, ...unsigned } = release;
  void _releaseDigest;
  return unsigned;
}

export function buildContentBloomsAdapterReleaseV1(inputValue: unknown): ContentBloomsAdapterReleaseV1 {
  const input = parseExactContentBloomsV1(releaseInputSchemaV1, inputValue);
  const unsigned: Omit<ContentBloomsAdapterReleaseV1, "releaseDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    releaseId: input.releaseId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    sourceSystem: CONTENT_BLOOMS_SOURCE_SYSTEM_V1,
    authorityMode: CONTENT_BLOOMS_AUTHORITY_MODE_V1,
    coreAdapterContractVersion: "control-room-project-adapter/v1",
    projectType: "content-operations",
    supportedReadOperations: [...CONTENT_BLOOMS_READ_OPERATIONS_V1],
    supportedCommands: [],
    redactionPolicyVersion: input.redactionPolicyVersion,
    adapterPackageDigest: input.adapterPackageDigest,
    projectionSchemaDigest: input.projectionSchemaDigest,
    conformanceEvidenceDigest: input.conformanceEvidenceDigest,
    acceptanceProfileDigest: input.acceptanceProfileDigest,
    acceptedReviewDigest: input.acceptedReviewDigest,
    completionSnapshotDigest: input.completionSnapshotDigest,
    producerIdentityDigest: input.producerIdentityDigest,
    reviewerIdentityDigest: input.reviewerIdentityDigest,
    reviewedAndAccepted: true,
    acceptedAt: input.acceptedAt,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(contentBloomsAdapterReleaseSchemaV1, {
    ...unsigned,
    releaseDigest: sha256Digest(unsigned),
  }) as ContentBloomsAdapterReleaseV1;
}

export function parseContentBloomsAdapterReleaseV1(value: unknown): ContentBloomsAdapterReleaseV1 {
  const release = parseExactContentBloomsV1(contentBloomsAdapterReleaseSchemaV1, value) as ContentBloomsAdapterReleaseV1;
  if (sha256Digest(withoutDigest(release)) !== release.releaseDigest) {
    throw new ContentBloomsContractErrorV1("release_untrusted");
  }
  return release;
}
