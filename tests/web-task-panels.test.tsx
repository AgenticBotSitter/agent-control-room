import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCatalogPanel, TaskDetailPanel, TaskProposalForm } from "../private-app/app/task-panels";
import { PrivateTaskWorkspace } from "../private-app/app/task-workspace";
import type { TaskDetail, TaskPage } from "../src/web/v1/task-wire";

const project = { projectId: "project:test", title: "Business ideas", summary: "", lifecycle: "active" as const, version: 1,
  createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", origin: "ordinary" as const, lifecycleEditable: true };
const task = { jobId: "job:test", projectId: project.projectId, requestId: "request:test", title: "Compare ideas <script>", state: "leased" as const,
  version: 2, createdAt: project.createdAt, updatedAt: project.updatedAt };
test("task catalog is concrete, escaped and links each job to its own project page", () => {
  const page: TaskPage = { project, tasks: [task], nextCursor: null, canPropose: true, observedAt: project.updatedAt, dispatch: "not_connected" };
  const html = renderToStaticMarkup(<TaskCatalogPanel page={page} />);
  assert.match(html, /Compare ideas &lt;script&gt;/); assert.match(html, /project%3Atest\/tasks\/job%3Atest/); assert.match(html, /Assigned/);
  assert.doesNotMatch(html, /completed successfully|Approved/);
});
test("proposal form names its non-running save, labels inputs and holds uncertain instructions", () => {
  const html = renderToStaticMarkup(<TaskProposalForm draft={{ title: "Research", instructions: "Useful result" }} setDraft={() => {}}
    pending={false} uncertain onSave={() => {}} />);
  assert.match(html, /Save proposal/); assert.match(html, /assignment is not connected/); assert.match(html, /for="task-instructions"/);
  assert.match(html, /aria-describedby="task-secrets-note"/); assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
});
test("completion, reported cancellation, unknown tokens and missing review are not rendered as accepted work", () => {
  const detail: TaskDetail = { project, task, instructions: "Compare evidence", inputDigest: `sha256:${"a".repeat(64)}`,
    observedAt: project.updatedAt, attempts: [{ attemptId: "attempt:test", attemptNumber: 1, state: "leased", additionalRunsOmitted: false,
      runs: [{ runId: "run:test", harness: "hermes", state: "succeeded", lastObservedAt: project.updatedAt, stale: true,
        firstObservedExecutionAt: null, finishedObservedAt: project.updatedAt, cancellation: "reported", source: "native_snapshot",
        nativeState: "completed", usage: null, resultClaim: { contentHash: `sha256:${"b".repeat(64)}`, sizeBytes: 12, verified: false },
        timeline: [], earlierObservationsOmitted: false }] }], earlierAttemptsOmitted: false, progressSource: "configured",
    dispatch: "not_connected", artifacts: "not_connected", review: "not_connected" };
  const html = renderToStaticMarkup(<TaskDetailPanel detail={detail} />);
  for (const phrase of [/Agent reports completion/, /not owner acceptance/, /not been transferred or independently verified/,
    /Not a current live signal/, /Unknown/, /no enforced dollar limit/, /does not prove/]) assert.match(html, phrase);
  assert.doesNotMatch(html, /<button|<form|private synthetic result/);
});
test("server rendered task shell includes no project records, form, fake workers or live claims", () => {
  const html = renderToStaticMarkup(<PrivateTaskWorkspace projectId="project:test" />);
  assert.match(html, /Loading protected tasks/); assert.doesNotMatch(html, /<form|Business ideas|Lo-Fi|Marvin|Agent working/);
});
