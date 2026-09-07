import { z } from "zod";
import { assertNoSecretMaterial } from "../../security/redaction";
import { COMPLETION_GATE_SCHEMA_VERSION_V1 } from "./types";

export const COMPLETION_GATE_VIEW_MODEL_SCHEMA_V1 = "control-room-completion-gate-view/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const safeText = z.string().trim().min(1).max(280).refine((value) => !/[\r\n\t]/.test(value), "preview text must stay on one line")
  .refine((value) => !/(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?cookie|bearer\s)/i.test(value), "preview text cannot carry secret material");
const targetKind = z.enum(["code", "media", "document", "operation"]);
const reviewDecision = z.enum(["commented", "accepted", "changes_requested", "rejected"]);
const completionStatus = z.enum(["pending", "changes_requested", "verification_blocked", "revision_limit_reached", "ready", "superseded"]);
const verificationOutcome = z.enum(["passed", "failed", "blocked", "inconclusive"]);

const previewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("media"), previewId: id, title: safeText, contentDigest: digest, mimeType: safeText, byteSize: z.number().int().nonnegative().max(2_000_000_000), durationSeconds: z.number().nonnegative().max(86_400).optional(), availability: z.enum(["metadata_only", "redacted", "unavailable"]) }).strict(),
  z.object({ kind: z.literal("diff"), previewId: id, title: safeText, contentDigest: digest, changedFileCount: z.number().int().nonnegative().max(10_000), additions: z.number().int().nonnegative().max(10_000_000), deletions: z.number().int().nonnegative().max(10_000_000), availability: z.enum(["metadata_only", "redacted", "unavailable"]) }).strict(),
  z.object({ kind: z.literal("report"), previewId: id, title: safeText, contentDigest: digest, sectionCount: z.number().int().nonnegative().max(10_000), availability: z.enum(["metadata_only", "redacted", "unavailable"]) }).strict(),
]);

export const completionGateReadInputSchemaV1 = z.object({
  schemaVersion: z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),
  target: z.object({ id, projectId: id, kind: targetKind, subjectLabel: safeText, targetDigest: digest, revisionNumber: z.number().int().min(0).max(20), supersedesTargetId: id.optional() }).strict(),
  snapshot: z.object({ status: completionStatus, acceptedReviewIds: z.array(id).max(5), missingVerificationScenarioIds: z.array(id).max(50), openFindingIds: z.array(id).max(100), requiresSeparateApproval: z.literal(true), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  reviews: z.array(z.object({ id, authority: z.enum(["advisory", "completion_gate"]), decision: reviewDecision, reviewerLabel: safeText, effectiveRisk: z.enum(["low", "medium", "high", "critical"]), evidenceDigests: z.array(digest).max(100), reviewedAt: instant }).strict()).max(50),
  verifications: z.array(z.object({ id, scenarioId: id, outcome: verificationOutcome, verifierLabel: safeText, evidenceDigests: z.array(digest).max(100), verifiedAt: instant }).strict()).max(50),
  findings: z.array(z.object({ id, code: id, severity: z.enum(["low", "medium", "high", "critical"]), statement: safeText, evidenceDigests: z.array(digest).max(100), raisedAt: instant }).strict()).max(100),
  preferences: z.array(z.object({ id, subjectLabel: safeText, state: z.enum(["recorded", "expired"]), selectedAt: instant }).strict()).max(20),
  previews: z.array(previewSchema).max(50),
  approval: z.object({ state: z.enum(["unavailable", "not_requested", "requested", "central_decision_recorded", "expired", "denied"]), expiresAt: instant.optional() }).strict(),
  coverage: z.object({ additionalEvidenceOmitted: z.boolean(), preferencesLoaded: z.boolean(),
    previewsLoaded: z.boolean(), findingStatementsLoaded: z.boolean() }).strict().optional(),
}).strict();

export type CompletionGateReadInputV1 = z.infer<typeof completionGateReadInputSchemaV1>;
export type CompletionGatePreviewV1 = z.infer<typeof previewSchema>;

export interface CompletionGateViewModelV1 {
  schema: typeof COMPLETION_GATE_VIEW_MODEL_SCHEMA_V1;
  target: CompletionGateReadInputV1["target"];
  status: CompletionGateReadInputV1["snapshot"]["status"];
  statusLabel: string;
  statusDetail: string;
  reviews: CompletionGateReadInputV1["reviews"];
  verifications: CompletionGateReadInputV1["verifications"];
  findings: CompletionGateReadInputV1["findings"];
  preferences: CompletionGateReadInputV1["preferences"];
  previews: CompletionGatePreviewV1[];
  missingVerificationScenarioIds: string[];
  openFindingIds: string[];
  coverage?: CompletionGateReadInputV1["coverage"];
  approval: CompletionGateReadInputV1["approval"] & { label: string; detail: string; grantsExecutionAuthority: false; requiresSeparateNodeAttestation: true };
  authority: { requiresSeparateApproval: true; grantsApproval: false; grantsExecutionAuthority: false };
}

const statusCopy: Record<CompletionGateViewModelV1["status"], { label: string; detail: string }> = {
  pending: { label: "Review in progress", detail: "Required review or verification evidence is still missing." },
  changes_requested: { label: "Changes requested", detail: "Findings must be resolved in a bounded new revision." },
  verification_blocked: { label: "Verification blocked", detail: "A required verification did not pass." },
  revision_limit_reached: { label: "Revision limit reached", detail: "This target needs human direction before another revision." },
  ready: { label: "Quality review complete", detail: "Quality evidence is complete. This is not approval to perform an external action." },
  superseded: { label: "Superseded", detail: "A newer immutable revision is the current review target." },
};

function approvalCopy(state: CompletionGateReadInputV1["approval"]["state"]): { label: string; detail: string } {
  switch (state) {
    case "unavailable": return { label: "Approval information not loaded", detail: "This review source does not report operation approvals. Do not infer approval or the absence of a request." };
    case "not_requested": return { label: "No consequential approval requested", detail: "Quality review does not request or create an operation approval." };
    case "requested": return { label: "Consequential approval requested", detail: "A separate human approval decision is pending. Nothing can execute from this panel." };
    case "central_decision_recorded": return { label: "Central approval decision recorded", detail: "A separate signed node attestation is still required before any approval-required effect." };
    case "expired": return { label: "Approval record expired", detail: "Expired approval evidence cannot be used for an operation." };
    case "denied": return { label: "Consequential approval denied", detail: "The operation remains unavailable. Quality review is unchanged." };
  }
}

/**
 * Converts already-redacted completion facts into a presentational model.
 * It deliberately accepts only digest-addressed metadata: no artifact bytes,
 * locators, raw patches, report bodies, credentials, or action capability.
 */
export function buildCompletionGateViewModelV1(input: unknown): CompletionGateViewModelV1 {
  const parsed = completionGateReadInputSchemaV1.parse(input);
  assertNoSecretMaterial(parsed, "completion gate view input");
  const status = statusCopy[parsed.snapshot.status];
  const approval = approvalCopy(parsed.approval.state);
  return {
    schema: COMPLETION_GATE_VIEW_MODEL_SCHEMA_V1,
    target: parsed.target,
    status: parsed.snapshot.status,
    statusLabel: status.label,
    statusDetail: status.detail,
    reviews: [...parsed.reviews].sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt) || left.id.localeCompare(right.id)),
    verifications: [...parsed.verifications].sort((left, right) => left.scenarioId.localeCompare(right.scenarioId) || left.id.localeCompare(right.id)),
    findings: [...parsed.findings].sort((left, right) => left.raisedAt.localeCompare(right.raisedAt) || left.id.localeCompare(right.id)),
    preferences: [...parsed.preferences].sort((left, right) => left.selectedAt.localeCompare(right.selectedAt) || left.id.localeCompare(right.id)),
    previews: [...parsed.previews].sort((left, right) => left.previewId.localeCompare(right.previewId)),
    missingVerificationScenarioIds: [...parsed.snapshot.missingVerificationScenarioIds].sort(),
    openFindingIds: [...parsed.snapshot.openFindingIds].sort(),
    ...(parsed.coverage ? { coverage: parsed.coverage } : {}),
    approval: { ...parsed.approval, ...approval, grantsExecutionAuthority: false, requiresSeparateNodeAttestation: true },
    authority: { requiresSeparateApproval: true, grantsApproval: false, grantsExecutionAuthority: false },
  };
}
