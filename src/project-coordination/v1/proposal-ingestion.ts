import {
  projectCoordinatorExecutionBindingDigestV1,
  projectCoordinatorPlanningMarkerDigestV1,
} from "../../contracts/v1/project-coordination-boundaries";
import { assertNoSecretMaterial } from "../../security";
import {
  coordinationResultContentDigestV1,
  projectCoordinationProposalDigestV1,
  projectCoordinationProposalSchemaV1,
  verifiedCoordinationResultEvidenceSchemaV1,
  type ProjectCoordinationProposalV1,
  type VerifiedCoordinationResultEvidenceV1,
} from "./schemas";
import { ProjectCoordinationErrorV1 } from "./errors";
import { parseStrictJsonObjectV1 } from "./strict-json";

/**
 * Bounded rejection reasons stored on a rejected proposal row. They describe the
 * class of failure only. The raw invalid text stays in the protected artifact and
 * is never copied into a reason, an error message or a log line.
 */
export type CoordinationProposalRejectionV1 =
  | "evidence_invalid"
  | "evidence_binding_mismatch"
  | "evidence_content_mismatch"
  | "content_not_one_json_object"
  | "content_duplicate_key"
  | "content_over_limit"
  | "proposal_schema_mismatch"
  | "proposal_cross_project"
  | "proposal_limit_exceeded"
  | "proposal_unsafe_material";

export type CoordinationProposalValidationV1 =
  | {
    validationState: "accepted";
    evidence: VerifiedCoordinationResultEvidenceV1;
    markerDigest: string;
    proposal: ProjectCoordinationProposalV1;
    proposalDigest: string;
  }
  | {
    validationState: "rejected";
    evidence?: VerifiedCoordinationResultEvidenceV1;
    markerDigest?: string;
    safeReasonCode: CoordinationProposalRejectionV1;
  };

function rejection(safeReasonCode: CoordinationProposalRejectionV1,
  evidence?: VerifiedCoordinationResultEvidenceV1, markerDigest?: string): CoordinationProposalValidationV1 {
  return { validationState: "rejected", safeReasonCode, ...(evidence ? { evidence, markerDigest } : {}) };
}

/**
 * Validates one exact retained result supplied through the trusted engine port.
 *
 * Nothing here reads a browser value, a job title, a capability, an action-inbox
 * entry or the result's own claim about who produced it: authority comes only
 * from the server-created planning marker and the stable execution binding it
 * names. A result that fails any check is reported as a bounded rejection rather
 * than an exception, so the caller can record it durably and safely.
 */
export function validateCoordinationProposalV1(value: unknown): CoordinationProposalValidationV1 {
  const parsedEvidence = verifiedCoordinationResultEvidenceSchemaV1.safeParse(value);
  if (!parsedEvidence.success) return rejection("evidence_invalid");
  const evidence = parsedEvidence.data;
  const marker = evidence.planningMarker;
  const binding = evidence.executionBinding;

  let markerDigest: string;
  try {
    markerDigest = projectCoordinatorPlanningMarkerDigestV1(marker);
  } catch {
    return rejection("evidence_invalid");
  }

  // The marker must name exactly this binding; a node signature or an adapter
  // identity is never the identity of every agent that ran on that node.
  if (binding.tenantId !== marker.tenantId || binding.projectId !== marker.projectId
    || binding.coordinatorIdentityId !== marker.coordinatorIdentityId
    || binding.adapterId !== marker.adapterId
    || binding.connectorProfileDigest !== marker.connectorProfileDigest
    || projectCoordinatorExecutionBindingDigestV1(binding) !== marker.executionBindingDigest
    || binding.coordinatorIdentityId === binding.executorId) {
    return rejection("evidence_binding_mismatch", evidence, markerDigest);
  }
  // The text handed to the parser must be exactly the retained artifact.
  if (evidence.contentHash !== coordinationResultContentDigestV1(evidence.resultText)) {
    return rejection("evidence_content_mismatch", evidence, markerDigest);
  }

  let object: Record<string, unknown>;
  try {
    object = parseStrictJsonObjectV1(evidence.resultText);
  } catch (error) {
    if (error instanceof ProjectCoordinationErrorV1) {
      if (error.safeCode === "proposal_duplicate_key") return rejection("content_duplicate_key", evidence, markerDigest);
      if (error.safeCode === "proposal_content_too_large") return rejection("content_over_limit", evidence, markerDigest);
    }
    return rejection("content_not_one_json_object", evidence, markerDigest);
  }

  if (object.schema !== marker.expectedProposalSchema) {
    return rejection("proposal_schema_mismatch", evidence, markerDigest);
  }
  const parsedProposal = projectCoordinationProposalSchemaV1.safeParse(object);
  if (!parsedProposal.success) {
    const limitIssue = parsedProposal.error.issues.some((issue) =>
      issue.code === "too_big" && (issue.path[0] === "tasks" || issue.path[0] === "edges"));
    return rejection(limitIssue ? "proposal_limit_exceeded" : "proposal_schema_mismatch", evidence, markerDigest);
  }
  const proposal = parsedProposal.data;
  if (proposal.projectId !== marker.projectId) {
    return rejection("proposal_cross_project", evidence, markerDigest);
  }
  try {
    assertNoSecretMaterial(proposal, "project coordination proposal");
  } catch {
    return rejection("proposal_unsafe_material", evidence, markerDigest);
  }
  return {
    validationState: "accepted",
    evidence,
    markerDigest,
    proposal,
    proposalDigest: projectCoordinationProposalDigestV1(proposal),
  };
}
