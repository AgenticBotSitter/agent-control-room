import { assertNoSecretMaterial } from "../../security";
import { parseStrictJsonObjectV1 } from "../../project-coordination/v1/strict-json";
import { ProjectCoordinationErrorV1 } from "../../project-coordination/v1/errors";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "./schemas";
import { workBatchProposalDigestV1 } from "./digest";
import { isPostgresJsonTextV1 } from "../../persistence/postgres-text";

export type WorkBatchRejectionCodeV1 = "content_invalid" | "content_duplicate_key" | "content_over_limit"
  | "proposal_schema_mismatch" | "proposal_limit_exceeded" | "proposal_cross_project"
  | "proposal_unsafe_material";
export type WorkBatchValidationV1 = { accepted: true; proposal: WorkBatchProposalV1; proposalDigest: string }
  | { accepted: false; safeReasonCode: WorkBatchRejectionCodeV1 };

export function validateWorkBatchProposalV1(raw: string, expectedProjectId: string): WorkBatchValidationV1 {
  let value: Record<string, unknown>;
  try { value = parseStrictJsonObjectV1(raw); }
  catch (error) {
    if (error instanceof ProjectCoordinationErrorV1 && error.safeCode === "proposal_duplicate_key")
      return { accepted: false, safeReasonCode: "content_duplicate_key" };
    if (error instanceof ProjectCoordinationErrorV1 && error.safeCode === "proposal_content_too_large")
      return { accepted: false, safeReasonCode: "content_over_limit" };
    return { accepted: false, safeReasonCode: "content_invalid" };
  }
  if (!isPostgresJsonTextV1(value)) return { accepted: false, safeReasonCode: "content_invalid" };
  const parsed = workBatchProposalSchemaV1.safeParse(value);
  if (!parsed.success) {
    const limit = parsed.error.issues.some(issue => issue.code === "too_big"
      && (issue.path[0] === "tasks" || issue.path[0] === "edges"));
    return { accepted: false, safeReasonCode: limit ? "proposal_limit_exceeded" : "proposal_schema_mismatch" };
  }
  if (parsed.data.projectId !== expectedProjectId)
    return { accepted: false, safeReasonCode: "proposal_cross_project" };
  try { assertNoSecretMaterial(parsed.data, "work batch proposal"); }
  catch { return { accepted: false, safeReasonCode: "proposal_unsafe_material" }; }
  return { accepted: true, proposal: parsed.data, proposalDigest: workBatchProposalDigestV1(parsed.data) };
}
