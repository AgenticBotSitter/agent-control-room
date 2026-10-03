"use client";

import { useEffect, useState } from "react";
import { PrivateHeader } from "../private-header";
import { readTaskHomeActivity } from "../../../src/web/v1/task-home-browser-client";
import type { TaskHomeActivity } from "../../../src/web/v1/task-home-wire";
import { readTaskAttention } from "../../../src/web/v1/queue-attention-browser-client";
import type { TaskAttentionPage } from "../../../src/web/v1/task-attention-wire";
import { readPrivateConnections } from "../../../src/web/v1/connection-browser-client";
import { useLocalRuntime } from "../local-runtime";
import { taskResultHrefV1 } from "../task-results";
import { LoadingState, EmptyState, UnavailableState, PanelHeading, PrivateCount, pagedCount } from "../owner-ui";
import { isLocalWorkerRead, stuckWorkerCount, type WorkerRead } from "../home-workspace";
import { ConfiguredTimestamp } from "../configured-timestamp";

const taskHref = (projectId: string, jobId: string) =>
  `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

type ReadState<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "unavailable" };

/** Summarises recent saved results, task attention and worker signals using
 * the same reads as Home. No last-visit or overnight boundary is recorded. */
export function PrivateMorningSummary() {
  const runtime = useLocalRuntime();
  const [activity, setActivity] = useState<ReadState<TaskHomeActivity>>({ state: "loading" });
  const [attention, setAttention] = useState<ReadState<TaskAttentionPage>>({ state: "loading" });
  const [connections, setConnections] = useState<ReadState<WorkerRead>>({ state: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    setActivity({ state: "loading" });
    setAttention({ state: "loading" });
    void readTaskHomeActivity().then(value => { if (live) setActivity({ state: "ready", value }); },
      () => { if (live) setActivity({ state: "unavailable" }); });
    void readTaskAttention().then(value => { if (live) setAttention({ state: "ready", value }); },
      () => { if (live) setAttention({ state: "unavailable" }); });
    return () => { live = false; };
  }, [generation]);

  useEffect(() => {
    if (runtime.mode === "checking") return;
    if (runtime.mode === "local") {
      setConnections(runtime.status ? { state: "ready", value: { source: "local", value: runtime.status } } : { state: "unavailable" });
      return;
    }
    let live = true;
    setConnections({ state: "loading" });
    void readPrivateConnections().then(value => { if (live) setConnections({ state: "ready", value }); },
      () => { if (live) setConnections({ state: "unavailable" }); });
    return () => { live = false; };
  }, [runtime.mode, runtime.status, generation]);

  const loading = activity.state === "loading" || attention.state === "loading" || connections.state === "loading";
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <div className="private-heading"><h1>Morning summary</h1>
      <p>Recent results, what is waiting for you, and saved worker signals.</p></div>
    <button type="button" disabled={loading} onClick={() => setGeneration(value => value + 1)}>{loading ? "Checking…" : "Check again"}</button>

    <section className="private-panel" aria-labelledby="morning-finished"><PanelHeading id="morning-finished">Recent results
      {activity.state === "ready" && activity.value.resultSource === "configured" ? <PrivateCount value={pagedCount(activity.value.recentResults.length, activity.value.additionalResultsOmitted)} /> : null}</PanelHeading>
      {activity.state === "loading" ? <LoadingState>Loading verified result records…</LoadingState>
        : activity.state === "unavailable" || activity.value.resultSource !== "configured"
          ? <UnavailableState>Finished work is unavailable. No zero count or all-clear is inferred.</UnavailableState>
          : activity.value.recentResults.length ? <ul className="private-dashboard-list">{activity.value.recentResults.map(({ task, artifact }) =>
            <li key={artifact.artifactId}><a href={taskResultHrefV1(task.projectId, task.jobId, artifact.artifactId)}>{task.title}</a>
              <span>{task.state === "succeeded" ? `Completed${task.qualityStatus === "accepted" ? " · Accepted" : ""} · ` : ""}
                <ConfiguredTimestamp value={artifact.receivedAt} prefix="Received" /></span></li>)}</ul>
            : <EmptyState>No recent results are recorded.</EmptyState>}
    </section>

    <section className="private-panel" aria-labelledby="morning-waiting"><PanelHeading id="morning-waiting">Waiting for you
      {attention.state === "ready"
        ? <PrivateCount value={pagedCount(attention.value.items.length, attention.value.nextCursor)} /> : null}</PanelHeading>
      {attention.state === "loading" ? <LoadingState>Loading saved attention items…</LoadingState>
        : attention.state === "unavailable" ? <UnavailableState>Attention items are unavailable. No zero count or all-clear is inferred.</UnavailableState>
          : attention.value.items.length ? <ul className="private-dashboard-list">{attention.value.items.map(item =>
            <li key={item.task.jobId}><a href={taskHref(item.task.projectId, item.task.jobId)}>{item.task.title}</a>
              <span>{item.reasons.join(" · ").replaceAll("_", " ")}</span></li>)}</ul>
            : <EmptyState>Nothing is waiting for you.</EmptyState>}
      <a className="private-action-link" href="/needs-me">Open Action Inbox</a>
    </section>

    <section className="private-panel" aria-labelledby="morning-stalled"><PanelHeading id="morning-stalled">Stalled
      {connections.state === "ready" ? <PrivateCount value={stuckWorkerCount(connections.value)} /> : null}</PanelHeading>
      {connections.state === "loading" ? <LoadingState>Loading saved worker signals…</LoadingState>
        : connections.state === "unavailable" ? <UnavailableState>Worker signals are unavailable. No zero count or all-clear is inferred.</UnavailableState>
          : stuckWorkerCount(connections.value) > 0
            ? <p>{stuckWorkerCount(connections.value)} worker signal{stuckWorkerCount(connections.value) === 1 ? "" : "s"} stale, missing or offline.</p>
            : <EmptyState>No worker is reporting stalled.</EmptyState>}
      <a className="private-action-link" href="/workers">Open workers</a>
    </section>

    <section className="private-panel" aria-labelledby="morning-prs"><PanelHeading id="morning-prs">PRs opened</PanelHeading>
      <p className="private-note">No pull request read is connected to this installation yet.</p>
    </section>
  </main></div>;
}
