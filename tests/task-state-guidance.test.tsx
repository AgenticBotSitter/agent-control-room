import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDetail } from "../src/web/v1/task-wire.ts";
import { TaskStateGuidance, taskStateGuidance } from "../private-app/app/task-panels.tsx";

const at = "2026-09-13T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
function detail(state: TaskDetail["task"]["state"], run?: Partial<TaskDetail["attempts"][number]["runs"][number]>,
  progressSource: TaskDetail["progressSource"] = "configured"): TaskDetail {
  return { project: { projectId: "project:test", title: "Test project", summary: "Test summary", origin: "ordinary",
    lifecycle: "active", version: 1, createdAt: at, updatedAt: at, lifecycleEditable: true },
    task: { jobId: "job:test", projectId: "project:test", requestId: "request:test", title: "Test task",
      state, version: 1, createdAt: at, updatedAt: at }, instructions: "Deliver the requested result", inputDigest: digest,
    observedAt: at, attempts: run ? [{ attemptId: "attempt:test", attemptNumber: 1, state: "running", additionalRunsOmitted: false,
      runs: [{ runId: "run:test", harness: "codex", state: "running", lastObservedAt: at, stale: false,
        firstObservedExecutionAt: at, finishedObservedAt: null, cancellation: "not_requested", source: "native_snapshot",
        nativeState: "running", availability: "current", usage: null, resultClaim: null, timeline: [],
        earlierObservationsOmitted: false, ...run }] }] : [], earlierAttemptsOmitted: false,
    progressSource, dispatch: "configured", artifacts: "configured", review: "recorded" };
}

test("each ordinary task state points to one safe next destination or explanation", () => {
  const expected = new Map<TaskDetail["task"]["state"], string | undefined>([
    ["proposed", "#task-planning"], ["ready", "#task-assignment"], ["leased", "#task-assignment"],
    ["running", undefined], ["waiting_approval", "#task-approval"], ["succeeded", "#task-results"],
    ["failed", undefined], ["cancelled", undefined], ["orphaned", undefined], ["rejected", undefined],
  ]);
  for (const [state, href] of expected) {
    const guidance = taskStateGuidance(state === "running" ? detail(state, {}) : detail(state));
    assert.equal(guidance.href, href, state);
    assert.equal(guidance.uncertain, state === "orphaned", state);
  }
});

test("old, disconnected and ambiguous latest observations allow only a read-only recheck", () => {
  const cases = [{ stale: true }, { state: "disconnected" as const }, { nativeState: "ambiguous" as const },
    { availability: "offline" as const }, { availability: "expired" as const }, { availability: "unknown" as const }];
  for (const patch of cases) {
    const value = detail("running", patch);
    const guidance = taskStateGuidance(value);
    assert.equal(guidance.uncertain, true);
    assert.equal(guidance.href, undefined);
    const html = renderToStaticMarkup(<TaskStateGuidance detail={value} refreshing={false} onRefresh={() => {}} />);
    assert.match(html, /does not retry this task or send replacement work/);
    assert.match(html, />Check latest saved status</);
    assert.doesNotMatch(html, /Go to (assignment|approval|preparation)/);
    assert.doesNotMatch(html, /Retry task|Resubmit|Start replacement/i);
  }
});

test("current states render semantic links and a disabled read-only check while refreshing", () => {
  const succeeded = renderToStaticMarkup(<TaskStateGuidance detail={detail("succeeded")} refreshing={true} onRefresh={() => {}} />);
  assert.match(succeeded, /href="#task-results"/);
  assert.match(succeeded, /disabled=""/);
  assert.match(succeeded, /Checking saved status/);
  const proposed = renderToStaticMarkup(<TaskStateGuidance detail={detail("proposed")} refreshing={false} onRefresh={() => {}} />);
  assert.match(proposed, /href="#task-planning"/);
  assert.match(proposed, /This does not assign or start an agent/);
});

test("a running task never claims current work when agent evidence is absent or terminal", () => {
  const cases = [detail("running"), detail("running", undefined, "not_configured"),
    ...(["completed", "failed", "cancelled", "interrupted"] as const).map(nativeState => detail("running", { nativeState })),
    ...(["succeeded", "failed", "cancelled"] as const).map(state => detail("running", { state }))];
  for (const value of cases) {
    const guidance = taskStateGuidance(value);
    assert.equal(guidance.uncertain, true);
    assert.equal(guidance.href, undefined);
    assert.doesNotMatch(guidance.explanation, /current progress|work is in progress/i);
    assert.match(guidance.explanation, /does not retry/);
  }
});
