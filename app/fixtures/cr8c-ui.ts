import { buildCompletionGateViewModelV1, type CompletionGateViewModelV1 } from "@/src/completion-gate/v1/view-model";

// Static test digests keep this client-rendered fixture free of server-only crypto.
const fixtureDigests = {
  "target-wayfarer-1": "sha256:2a3dcb76730473526231b255db5aa3cdc1c58c68db4b5cb4f5db66fd996b4436",
  advisory: "sha256:54c14f01eec43a6749116b9dd70033edd44c9cf0b4700f15914ec34fe2edfdc7",
  gate: "sha256:6e2ca455635c25d4fa23ef6c3939bd6956d40cf079d6dab9ce6833f888099c2f",
  render: "sha256:299896a4361b6a33818302cda64f0d6a1f0ad22112965c402dff78f4343349df",
  "audio-finding": "sha256:d3a3113471cc4aff038fed32138fe7a60c0bae7aa9be72645ae891587471bb1c",
  media: "sha256:44377c336f1b90b204a61563f84c425c74018a8b4be4d57a2993f1f0e87662bd",
  "target-blooms-0": "sha256:d087479e2267f6dc2cbd35117559271452e474094ceb9b47814ca5961dae753e",
  "blooms-review": "sha256:eea31bec81b879d247bb1c74d330fea447b3259858936ca5c38afb9c455f6734",
  "blooms-links": "sha256:a2bd4ce8b4e2f3efbb7a738cd5ceb6e96c2b2eac8ab5d079deb6666dda4bf1e2",
  report: "sha256:f599209f2826dc4cb9198f0b3efd2994c9f257cab51ee8f67705be3decd91e08",
  diff: "sha256:8a14fa5eddc4a41821d3c2c7bb45b1767302f191f643911f7e9b285107c93c10",
} as const;

const digest = (value: keyof typeof fixtureDigests) => fixtureDigests[value];

export const cr8cCompletionGateFixture: readonly CompletionGateViewModelV1[] = [
  buildCompletionGateViewModelV1({
    schemaVersion: "control-room-completion-gate/v1",
    target: { id: "target:wayfarer:revision:1", projectId: "project.wayfarer.lazy-river", kind: "media", subjectLabel: "Episode cut review", targetDigest: digest("target-wayfarer-1"), revisionNumber: 1, supersedesTargetId: "target:wayfarer:revision:0" },
    snapshot: { status: "changes_requested", acceptedReviewIds: [], missingVerificationScenarioIds: ["scenario:audio-qc"], openFindingIds: ["finding:wayfarer:audio"], requiresSeparateApproval: true, grantsApproval: false, grantsExecutionAuthority: false },
    reviews: [
      { id: "review:wayfarer:advisory", authority: "advisory", decision: "commented", reviewerLabel: "Editorial pre-review", effectiveRisk: "medium", evidenceDigests: [digest("advisory")], reviewedAt: "2026-08-28T14:01:00.000Z" },
      { id: "review:wayfarer:gate", authority: "completion_gate", decision: "changes_requested", reviewerLabel: "Independent media reviewer", effectiveRisk: "medium", evidenceDigests: [digest("gate")], reviewedAt: "2026-08-28T14:03:00.000Z" },
    ],
    verifications: [{ id: "verification:wayfarer:render", scenarioId: "scenario:render-qc", outcome: "passed", verifierLabel: "Independent render verifier", evidenceDigests: [digest("render")], verifiedAt: "2026-08-28T14:02:00.000Z" }],
    findings: [{ id: "finding:wayfarer:audio", code: "audio_level_gap", severity: "medium", statement: "Audio level evidence needs a revised independent check.", evidenceDigests: [digest("audio-finding")], raisedAt: "2026-08-28T14:03:00.000Z" }],
    preferences: [{ id: "preference:wayfarer:cut", subjectLabel: "Episode cut pacing", state: "recorded", selectedAt: "2026-08-28T13:55:00.000Z" }],
    previews: [{ kind: "media", previewId: "preview:wayfarer:cut", title: "Episode cut metadata", contentDigest: digest("media"), mimeType: "video/mp4", byteSize: 184000000, durationSeconds: 612, availability: "metadata_only" }],
    approval: { state: "not_requested" },
  }),
  buildCompletionGateViewModelV1({
    schemaVersion: "control-room-completion-gate/v1",
    target: { id: "target:blooms:revision:0", projectId: "project.blooms.content-ops", kind: "document", subjectLabel: "Research handoff summary", targetDigest: digest("target-blooms-0"), revisionNumber: 0 },
    snapshot: { status: "ready", acceptedReviewIds: ["review:blooms:gate"], missingVerificationScenarioIds: [], openFindingIds: [], requiresSeparateApproval: true, grantsApproval: false, grantsExecutionAuthority: false },
    reviews: [{ id: "review:blooms:gate", authority: "completion_gate", decision: "accepted", reviewerLabel: "Independent document reviewer", effectiveRisk: "medium", evidenceDigests: [digest("blooms-review")], reviewedAt: "2026-08-28T14:08:00.000Z" }],
    verifications: [{ id: "verification:blooms:links", scenarioId: "scenario:source-links", outcome: "passed", verifierLabel: "Independent source verifier", evidenceDigests: [digest("blooms-links")], verifiedAt: "2026-08-28T14:07:00.000Z" }],
    findings: [], preferences: [],
    previews: [{ kind: "report", previewId: "preview:blooms:report", title: "Handoff report metadata", contentDigest: digest("report"), sectionCount: 6, availability: "metadata_only" }, { kind: "diff", previewId: "preview:blooms:revision", title: "Revision metadata", contentDigest: digest("diff"), changedFileCount: 3, additions: 42, deletions: 11, availability: "redacted" }],
    approval: { state: "central_decision_recorded", expiresAt: "2026-08-28T14:20:00.000Z" },
  }),
];
