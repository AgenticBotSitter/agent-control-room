import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletionGateViewModelV1, completionGateReadInputSchemaV1 } from "../src/completion-gate/v1";
import { sha256Digest } from "../src/security";

const digest = (value: string) => sha256Digest({ cr8c: value });

function input() {
  return {
    schemaVersion: "control-room-completion-gate/v1",
    target: { id: "target:cr8c:1", projectId: "project:cr8c", kind: "document", subjectLabel: "Safe handoff", targetDigest: digest("target"), revisionNumber: 1, supersedesTargetId: "target:cr8c:0" },
    snapshot: { status: "ready", acceptedReviewIds: ["review:gate"], missingVerificationScenarioIds: [], openFindingIds: [], requiresSeparateApproval: true, grantsApproval: false, grantsExecutionAuthority: false },
    reviews: [
      { id: "review:later", authority: "completion_gate", decision: "accepted", reviewerLabel: "Independent reviewer", effectiveRisk: "medium", evidenceDigests: [digest("later")], reviewedAt: "2026-08-28T14:10:00.000Z" },
      { id: "review:earlier", authority: "advisory", decision: "commented", reviewerLabel: "Editorial review", effectiveRisk: "low", evidenceDigests: [digest("earlier")], reviewedAt: "2026-08-28T14:09:00.000Z" },
    ],
    verifications: [{ id: "verify:document", scenarioId: "scenario:document-qc", outcome: "passed", verifierLabel: "Independent verifier", evidenceDigests: [digest("verify")], verifiedAt: "2026-08-28T14:11:00.000Z" }],
    findings: [], preferences: [],
    previews: [
      { kind: "report", previewId: "preview:z", title: "Report metadata", contentDigest: digest("report"), sectionCount: 3, availability: "metadata_only" },
      { kind: "diff", previewId: "preview:a", title: "Diff metadata", contentDigest: digest("diff"), changedFileCount: 2, additions: 8, deletions: 1, availability: "redacted" },
    ],
    approval: { state: "central_decision_recorded", expiresAt: "2026-08-28T14:20:00.000Z" },
  };
}

test("CR8C makes a deterministic, negative-authority Completion Gate view", () => {
  const view = buildCompletionGateViewModelV1(input());
  assert.equal(view.schema, "control-room-completion-gate-view/v1");
  assert.deepEqual(view.reviews.map((review) => review.id), ["review:earlier", "review:later"]);
  assert.deepEqual(view.previews.map((preview) => preview.previewId), ["preview:a", "preview:z"]);
  assert.deepEqual(view.authority, { requiresSeparateApproval: true, grantsApproval: false, grantsExecutionAuthority: false });
  assert.equal(view.approval.grantsExecutionAuthority, false);
  assert.equal(view.approval.requiresSeparateNodeAttestation, true);
  assert.match(view.approval.detail, /separate signed node attestation/i);
  assert.match(view.statusDetail, /not approval/i);
});

test("CR8C rejects raw artifact material, locator-shaped additions, and authority escalation", () => {
  const rawArtifact = input();
  (rawArtifact.previews[0] as Record<string, unknown>).rawReportBody = "not allowed";
  assert.equal(completionGateReadInputSchemaV1.safeParse(rawArtifact).success, false);

  const locator = input();
  (locator.previews[0] as Record<string, unknown>).opaqueLocator = "memory://protected";
  assert.equal(completionGateReadInputSchemaV1.safeParse(locator).success, false);

  const authority = input();
  (authority.snapshot as Record<string, unknown>).grantsExecutionAuthority = true;
  assert.equal(completionGateReadInputSchemaV1.safeParse(authority).success, false);
});

test("CR8C refuses secret-bearing text before it can enter a view", () => {
  const unsafe = input();
  unsafe.target.subjectLabel = "api_key=abc123456789";
  assert.throws(() => buildCompletionGateViewModelV1(unsafe), /preview text cannot carry secret material|secret material/i);
});

test("CR8C accepts metadata for media, diff, and report previews without artifact bytes", () => {
  const allPreviews = input() as { previews: unknown[] };
  allPreviews.previews = [
    { kind: "media", previewId: "preview:media", title: "Media metadata", contentDigest: digest("media"), mimeType: "video/mp4", byteSize: 100, durationSeconds: 12, availability: "metadata_only" },
    { kind: "diff", previewId: "preview:diff", title: "Diff metadata", contentDigest: digest("diff-2"), changedFileCount: 1, additions: 2, deletions: 1, availability: "redacted" },
    { kind: "report", previewId: "preview:report", title: "Report metadata", contentDigest: digest("report-2"), sectionCount: 2, availability: "unavailable" },
  ];
  assert.deepEqual(buildCompletionGateViewModelV1(allPreviews).previews.map((preview) => preview.kind), ["diff", "media", "report"]);
});
