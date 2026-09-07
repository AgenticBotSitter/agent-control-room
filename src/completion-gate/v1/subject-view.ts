import { z } from "zod";
import type { CompletionGateStoreV1 } from "./store";
import { buildCompletionGateViewModelV1, completionGateReadInputSchemaV1 } from "./view-model";

const identifier = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const scopeSchema = z.object({ tenantId: identifier, projectId: identifier, subjectId: identifier,
  subjectLabel: completionGateReadInputSchemaV1.shape.target.shape.subjectLabel }).strict();

/** Thin presentation adapter over one verified store read. The caller must authorize
 * this tenant/project/subject first. This function does not authenticate a browser,
 * verify a checkpoint itself, calculate acceptance, or read artifacts/approvals.
 * Import the store as a type only so presentation code does not acquire SQL access.
 */
export async function readCompletionSubjectViewV1(
  reader: Pick<CompletionGateStoreV1, "inspectSubject">,
  scope: z.infer<typeof scopeSchema>,
) {
  const value = scopeSchema.parse(scope);
  const inspection = await reader.inspectSubject(value.tenantId, value.projectId, value.subjectId);
  const items = inspection.targets.map(({ snapshot, reviews, verifications, findings, additionalEvidenceOmitted }) => {
    const target = snapshot.target;
    if (target.tenantId !== value.tenantId || target.projectId !== value.projectId || target.subjectId !== value.subjectId)
      throw new Error("completion_subject_scope_mismatch");
    return buildCompletionGateViewModelV1({ schemaVersion: target.schemaVersion,
      target: { id: target.id, projectId: target.projectId, kind: target.kind, subjectLabel: value.subjectLabel,
        targetDigest: snapshot.targetDigest, revisionNumber: target.revisionNumber, supersedesTargetId: target.supersedesTargetId },
      snapshot: { status: snapshot.status, acceptedReviewIds: snapshot.acceptedReviewIds.slice(0, 5),
        missingVerificationScenarioIds: snapshot.missingVerificationScenarioIds,
        openFindingIds: snapshot.openFindingIds.slice(0, 100), requiresSeparateApproval: snapshot.requiresSeparateApproval,
        grantsApproval: snapshot.grantsApproval, grantsExecutionAuthority: snapshot.grantsExecutionAuthority },
      reviews: reviews.map(review => ({ id: review.id, authority: review.authority, decision: review.decision,
        reviewerLabel: "Reviewer", effectiveRisk: review.effectiveRisk, evidenceDigests: review.evidenceDigests, reviewedAt: review.reviewedAt })),
      verifications: verifications.map(verification => ({ id: verification.id, scenarioId: verification.scenarioId,
        outcome: verification.outcome, verifierLabel: "Verifier", evidenceDigests: verification.evidenceDigests, verifiedAt: verification.verifiedAt })),
      findings: findings.map(finding => ({ id: finding.id, code: finding.code, severity: finding.severity,
        statement: "Finding text is not included in this metadata view.", evidenceDigests: finding.evidenceDigests, raisedAt: finding.raisedAt })),
      // The store returns neither of these collections nor operation approvals.
      // Empty arrays are transport placeholders, explicitly not evidence of absence.
      preferences: [], previews: [], approval: { state: "unavailable" },
      coverage: { additionalEvidenceOmitted: additionalEvidenceOmitted || snapshot.acceptedReviewIds.length > 5
        || snapshot.openFindingIds.length > 100, preferencesLoaded: false, previewsLoaded: false, findingStatementsLoaded: false },
    });
  });
  return { items, additionalTargetsOmitted: inspection.additionalTargetsOmitted };
}
