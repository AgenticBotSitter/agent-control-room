import { sha256Digest } from "../../../security";
import { buildWayfarerProjectPackV1 } from "./contract";
import { WAYFARER_ADAPTER_ID_V1, WAYFARER_PROJECT_ID_V1, WAYFARER_WORKSPACE_ID_V1 } from "./types";

export function buildWayfarerSyntheticProjectPackV1() {
  return buildWayfarerProjectPackV1({ tenantId: "tenant:wayfarer", workspaceId: WAYFARER_WORKSPACE_ID_V1,
    projectId: WAYFARER_PROJECT_ID_V1, adapterId: WAYFARER_ADAPTER_ID_V1, producerId: "agent:codex:architect",
    reviewerId: "agent:wayfarer:independent-reviewer", sourceDigest: sha256Digest({ source: "CR9B-WF-000" }),
    reviewEvidenceDigest: sha256Digest({ review: "wayfarer-project-pack-contract" }), createdAt: "2026-08-29T18:00:00.000Z",
    reviewedAt: "2026-08-29T18:05:00.000Z" });
}
