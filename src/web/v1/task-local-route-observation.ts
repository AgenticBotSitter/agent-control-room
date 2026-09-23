import type { TaskDetail } from "./task-wire";

/**
 * A narrow, browser-safe reading of the already-saved plan and run records.
 * It deliberately cannot discover a process, worker identity, hostname, or
 * configuration. "current_recorded" means only that this task has a fresh
 * matching native snapshot in Control Room's existing records.
 */
export type TaskLocalRouteObservation = {
  state: "not_prepared" | "not_local_route" | "not_observed" | "current_recorded" | "needs_attention" | "recorded_not_current";
  adapter: "hermes" | "claude" | "codex" | null;
};

const expectedRoute = {
  hermes: "local_hermes",
  claude: "local_claude",
  codex: "local_codex",
} as const;

export function observeTaskLocalRoute(detail: Pick<TaskDetail, "preparedFor" | "attempts">): TaskLocalRouteObservation {
  if (!detail.preparedFor) return { state: "not_prepared", adapter: null };
  if (detail.preparedFor === "configured_worker") return { state: "not_local_route", adapter: null };
  const adapter = detail.preparedFor;
  const expected = expectedRoute[adapter];
  const runs = detail.attempts.flatMap(attempt => attempt.runs).filter(run => run.routeEvidence === expected)
    .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
  if (!runs.length) return { state: "not_observed", adapter };
  const latest = runs[0]!;
  if (latest.state === "running" && latest.source === "native_snapshot" && latest.nativeState === "running"
    && latest.availability === "current" && !latest.stale) return { state: "current_recorded", adapter };
  const uncertain = latest.stale || latest.state === "disconnected" || latest.nativeState === "ambiguous"
    || latest.availability === "unknown" || latest.availability === "offline" || latest.availability === "expired";
  return { state: uncertain ? "needs_attention" : "recorded_not_current", adapter };
}
