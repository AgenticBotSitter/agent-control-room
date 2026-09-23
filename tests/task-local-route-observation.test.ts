import assert from "node:assert/strict";
import test from "node:test";
import { observeTaskLocalRoute } from "../src/web/v1/task-local-route-observation";
import type { TaskDetail } from "../src/web/v1/task-wire";

const at = "2026-09-22T12:00:00.000Z";
function run(patch: Partial<TaskDetail["attempts"][number]["runs"][number]> = {}): TaskDetail["attempts"][number]["runs"][number] {
  return { runId: "run:test", harness: "claude", state: "running", lastObservedAt: at, stale: false,
    routeEvidence: "local_claude", firstObservedExecutionAt: at, finishedObservedAt: null, cancellation: "not_requested",
    source: "native_snapshot", nativeState: "running", availability: "current", usage: null, resultClaim: null,
    timeline: [], earlierObservationsOmitted: false, ...patch };
}
function detail(preparedFor: TaskDetail["preparedFor"], runs: ReturnType<typeof run>[]): Pick<TaskDetail, "preparedFor" | "attempts"> {
  return { preparedFor, attempts: runs.length ? [{ attemptId: "attempt:test", attemptNumber: 1, state: "running", runs,
    additionalRunsOmitted: false }] : [] };
}

test("local route observation uses the newest matching saved adapter record only", () => {
  const olderCurrent = run({ lastObservedAt: "2026-09-22T11:59:00.000Z" });
  const latestTerminal = run({ lastObservedAt: at, state: "succeeded", nativeState: "completed" });
  assert.deepEqual(observeTaskLocalRoute(detail("claude", [olderCurrent, latestTerminal]), "configured"),
    { state: "recorded_not_current", adapter: "claude" });
  assert.deepEqual(observeTaskLocalRoute(detail("claude", [run({ routeEvidence: "local_hermes" })]), "configured"),
    { state: "not_observed", adapter: "claude" });
});

test("local route observation downgrades stale or uncertain saved evidence", () => {
  for (const patch of [{ stale: true }, { availability: "offline" as const }, { nativeState: "ambiguous" as const }]) {
    assert.deepEqual(observeTaskLocalRoute(detail("claude", [run(patch)]), "configured"), { state: "needs_attention", adapter: "claude" });
  }
  assert.deepEqual(observeTaskLocalRoute(detail(null, [])), { state: "not_prepared", adapter: null });
  assert.deepEqual(observeTaskLocalRoute(detail("configured_worker", [])), { state: "not_local_route", adapter: null });
});

test("configured-local wording requires the trusted exact route conclusion", () => {
  const current = detail("claude", [run()]);
  assert.deepEqual(observeTaskLocalRoute(current, "configured"), { state: "configured_local_route", adapter: "claude" });
  for (const conclusion of [undefined, "not_configured", "ambiguous"] as const) {
    assert.deepEqual(observeTaskLocalRoute(current, conclusion), { state: "needs_attention", adapter: "claude" });
  }
});
