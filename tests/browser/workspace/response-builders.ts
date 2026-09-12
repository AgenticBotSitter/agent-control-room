// Pure response builders for the workspace browser fixture. Extracted from
// main.tsx so a Node-side test can validate the wire shapes against the
// Zod schemas in src/web/v1/{task,task-result}-wire.ts.
//
// This module has no React or DOM dependencies: it is plain JavaScript that
// produces JSON-compatible objects matching the workspace component's fetch
// contract. Both the browser fixture and the Node-side test consume it.

import type { ProjectFixture } from "./fixture-data";

export interface WorkspaceResponseState {
  // sha256-prefixed digest of the open result text. In the browser this is
  // patched asynchronously once crypto.subtle finishes; tests pass it in
  // synchronously by calling setContentHash() before buildXxx() runs.
  contentHash: string;
}

export interface WorkspaceResponses {
  // Base URLs (without trailing slashes) the fixture will respond to.
  urls: { listUrl: string; detailUrl: string; resultsUrl: string; resultContentUrl: string };
  setContentHash: (digest: string) => void;
  buildTaskPage: () => unknown;
  buildTaskDetail: () => unknown;
  buildResultsPage: (canReadContent: boolean) => unknown;
  buildResultContent: () => unknown;
}

export function buildWorkspaceResponses(fixture: ProjectFixture, now: string): WorkspaceResponses {
  const { projectId, task, result, review } = fixture;
  const contentText = result.text;
  const sizeBytes = new TextEncoder().encode(contentText).byteLength;
  const state: WorkspaceResponseState = { contentHash: `sha256:${"a".repeat(64)}` };

  const setContentHash = (digest: string) => { state.contentHash = digest; };

  const projectView = {
    projectId, title: fixture.title, summary: fixture.summary,
    lifecycle: "active", version: 1, createdAt: now, updatedAt: now,
    origin: "ordinary", lifecycleEditable: true,
  } as const;

  const taskSummary = {
    jobId: task.jobId, projectId, requestId: `request:${task.jobId}`,
    title: task.title, state: "succeeded", version: 2, createdAt: now, updatedAt: now,
  } as const;

  const buildTaskPage = () => ({
    project: projectView, tasks: [taskSummary],
    nextCursor: null, canPropose: true, dispatch: "configured", observedAt: now,
  });

  const buildTaskRun = () => ({
    runId: `run:${task.jobId}`, harness: "hermes", state: "succeeded",
    lastObservedAt: now, stale: false, firstObservedExecutionAt: now, finishedObservedAt: now,
    cancellation: "not_requested", source: "native_snapshot", nativeState: "completed",
    availability: "current",
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, hardCostLimitEnforced: false },
    resultClaim: { contentHash: state.contentHash, sizeBytes, verified: false },
    timeline: [{ version: 1, state: "completed", observedAt: now, availability: "current" }],
    earlierObservationsOmitted: false,
  });

  const buildTaskDetail = () => ({
    project: projectView, task: taskSummary, instructions: task.instructions,
    inputDigest: `sha256:${"b".repeat(64)}`, observedAt: now,
    attempts: [{ attemptId: `attempt:${task.jobId}`, attemptNumber: 1, state: "succeeded",
      runs: [buildTaskRun()], additionalRunsOmitted: false }],
    earlierAttemptsOmitted: false, progressSource: "configured",
    dispatch: "configured", artifacts: "configured", review: "recorded",
  });

  const buildResultsPage = (canRead: boolean) => ({
    projectId, jobId: task.jobId, observedAt: now,
    resultSource: "configured", reviewSource: "configured",
    items: [{
      artifactId: result.artifactId, attemptId: `attempt:${task.jobId}`,
      runId: `run:${task.jobId}`, contentHash: state.contentHash,
      sizeBytes, receivedAt: now, byteCheck: "matched_recorded_claim", qualityAccepted: false,
    }],
    reviews: [{
      targetId: review.targetId, kind: "document",
      targetDigest: state.contentHash, contentHash: state.contentHash,
      revision: 2, supersedesTargetId: null,
      status: review.status, matchingArtifactIds: [result.artifactId],
      additionalEvidenceOmitted: false, reviews: [{
        id: `decision:${review.targetId}`, decision: review.status === "ready" ? "accepted" : "changes_requested",
        authority: "advisory", reviewedAt: now,
      }], verifications: [], findings: [], missingVerificationScenarioIds: [],
      openFindingCount: review.status === "ready" ? 0 : 1, grantsApproval: false, grantsExecutionAuthority: false,
    }],
    additionalResultsOmitted: false, additionalTargetsOmitted: false,
    canReadContent: canRead, reviewCommands: "configured", verificationCommands: "configured",
  });

  const buildResultContent = () => ({
    projectId, jobId: task.jobId,
    artifact: {
      artifactId: result.artifactId, attemptId: `attempt:${task.jobId}`,
      runId: `run:${task.jobId}`, contentHash: state.contentHash,
      sizeBytes, receivedAt: now, byteCheck: "matched_recorded_claim", qualityAccepted: false,
    },
    text: contentText, contentVerifiedAt: now, untrustedContent: true,
  });

  const base = "/api/v1/projects/" + encodeURIComponent(projectId) + "/tasks";
  const listUrl = base;
  const detailUrl = base + "/" + encodeURIComponent(task.jobId);
  const resultsUrl = detailUrl + "/results";
  const resultContentUrl = resultsUrl + "/" + encodeURIComponent(result.artifactId);

  return {
    urls: { listUrl, detailUrl, resultsUrl, resultContentUrl },
    setContentHash, buildTaskPage, buildTaskDetail, buildResultsPage, buildResultContent,
  };
}
