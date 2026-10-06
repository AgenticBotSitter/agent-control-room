"use client";

import { useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { readTaskProjectOverview } from "../../src/web/v1/task-project-overview-browser-client";
import type { TaskProjectOverview } from "../../src/web/v1/task-project-overview-wire";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { formatNanoUsdV1 } from "../../src/usage/v1/usage-cost";
import { LoadingState, StateChip, UnavailableState } from "./owner-ui";

type OverviewState = { state: "loading" } | { state: "ready"; value: TaskProjectOverview }
  | { state: "unavailable"; code: BrowserRequestError["code"] };
const href = (projectId: string, jobId: string) =>
  `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

function TaskList({ projectId, tasks }: { projectId: string; tasks: TaskProjectOverview["recent"] }) {
  return <ul className="private-dashboard-list">{tasks.map(task => <li key={task.jobId}>
    <a href={href(projectId, task.jobId)}>{task.title}</a>
    {/* The chip wraps only the state word; the middle dot and timestamp stay as
        adjacent text so this element's text stays "state · Updated <time>". */}
    <span><StateChip state={task.state} /> · <ConfiguredTimestamp value={task.updatedAt} prefix="Updated" /></span>
  </li>)}</ul>;
}

export function ProjectOverviewActivityView({ state, projectId }: { state: OverviewState; projectId: string }) {
  if (state.state === "loading") return <section className="private-panel"><h2>Project activity</h2>
    <LoadingState>Loading this project’s saved work…</LoadingState></section>;
  if (state.state === "unavailable") return <section className="private-panel"><h2>Project activity</h2>
    <UnavailableState urgent>{state.code === "access_denied" ? "Your current access does not include this project’s tasks."
      : state.code === "authentication_required" ? "Your session has ended. Sign in again to see this project’s work."
        : "The saved database or protected task-activity read could not be checked. No empty project or all-clear is inferred, and checking again does not start work."}</UnavailableState></section>;
  const { value } = state;
  return <div className="private-dashboard-grid private-project-overview-grid">
    <section className="private-panel"><h2>Project usage and cost</h2>
      <dl className="private-task-facts"><div><dt>Runs</dt><dd>{value.usageRollup.runs.toLocaleString()}</dd></div>
        <div><dt>Input tokens</dt><dd>{value.usageRollup.inputTokens === null ? "Unknown — not reported by every run" : value.usageRollup.inputTokens.toLocaleString()}</dd></div>
        <div><dt>Output tokens</dt><dd>{value.usageRollup.outputTokens === null ? "Unknown — not reported by every run" : value.usageRollup.outputTokens.toLocaleString()}</dd></div>
        <div><dt>Wall time</dt><dd>{value.usageRollup.wallTimeMs === null ? "Unknown — not recorded for every run" : `${value.usageRollup.wallTimeMs.toLocaleString()} ms`}</dd></div>
        <div><dt>Known cost</dt><dd>{value.usageRollup.knownCostRuns > 0 ? formatNanoUsdV1(value.usageRollup.knownCostNanoUsd) : value.usageRollup.unknownCostRuns > 0 ? "Unknown" : "No token-priced runs"} across {value.usageRollup.knownCostRuns} run(s)</dd></div>
        <div><dt>Subscription</dt><dd>{value.usageRollup.subscriptionRuns} run(s) included in subscription</dd></div>
        <div><dt>Unknown cost</dt><dd>{value.usageRollup.unknownCostRuns} run(s)</dd></div></dl>
      <p className="private-note">{value.priceTable.state === "recorded"
        ? <>Prices use owner-recorded table <code>{value.priceTable.tableId}</code>, recorded <ConfiguredTimestamp value={value.priceTable.recordedAt!} />.</>
        : "No owner price table is recorded. Token usage is shown, but per-token cost remains unknown."}</p>
    </section>
    <section className="private-panel"><h2>Current work</h2>
      {value.current.length ? <TaskList projectId={projectId} tasks={value.current} />
        : <p>No proposed, queued, running, approval-waiting, or recovery work is recorded for this project.</p>}
      {value.additionalCurrentOmitted && <p className="private-note">More current work exists. Open the full Tasks page.</p>}
      <a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/tasks`}>Create or open tasks</a>
    </section>
    <section className="private-panel"><h2>Waiting for approval</h2>
      {value.awaitingReview.length ? <TaskList projectId={projectId} tasks={value.awaitingReview} />
        : <p>No task is currently recorded as waiting for approval. This does not replace other review checks.</p>}
      {value.additionalReviewsOmitted && <p className="private-note">More review-waiting work exists. Open the full Tasks page.</p>}
    </section>
    <section className="private-panel private-dashboard-projects"><h2>Recent task activity</h2>
      {value.recent.length ? <TaskList projectId={projectId} tasks={value.recent} /> : <p>No saved tasks exist for this project yet.</p>}
      {value.additionalRecentOmitted && <p className="private-note">More task history exists. Open the full Tasks page.</p>}
    </section>
  </div>;
}

export function ProjectOverviewActivity({ projectId }: { projectId: string }) {
  const [state, setState] = useState<OverviewState>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setState({ state: "loading" });
    void readTaskProjectOverview(projectId, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ state: "ready", value });
    }, error => {
      if (!abort.signal.aborted) setState({ state: "unavailable",
        code: error instanceof BrowserRequestError ? error.code : "unavailable" });
    });
    return () => abort.abort();
  }, [projectId, generation]);
  return <><ProjectOverviewActivityView state={state} projectId={projectId} />
    <button type="button" onClick={() => setGeneration(value => value + 1)}>Check saved project activity again</button></>;
}
