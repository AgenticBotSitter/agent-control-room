"use client";

import { useEffect, useRef, useState } from "react";
import { createProjectBrowserClient } from "../../src/web/v1/browser-client";
import { readPrivateConnections, type PrivateConnectionSnapshot } from "../../src/web/v1/connection-browser-client";
import { readTaskAttention } from "../../src/web/v1/queue-attention-browser-client";
import { readTaskHomeActivity } from "../../src/web/v1/task-home-browser-client";
import type { TaskAttentionPage } from "../../src/web/v1/task-attention-wire";
import type { TaskHomeActivity } from "../../src/web/v1/task-home-wire";
import type { ProjectCatalogPage } from "../../src/web/v1/project-wire";
import { PrivateHeader } from "./private-header";
import { useProductDisplayName, useProductModule } from "./product-configuration";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { taskResultHrefV1 } from "./task-results";
import { useInstallationTopology } from "./installation-topology";
import { InstallationTopologySummary } from "./installation-topology-summary";
import { LocalWorkerRouteStatus, type TaskWorkerReadState } from "./local-worker-route-status";
import { PrivateOperatorCapacityWorkspace } from "./operator-capacity-workspace";
import { localWorkerStateLabel, useLocalRuntime, type LocalStatus } from "./local-runtime";
import { StateChip, LoadingState, EmptyState, UnavailableState, PanelHeading, PrivateCount, workerChipToneV1 } from "./owner-ui";

type WorkerRead = PrivateConnectionSnapshot | { source: "local"; value: LocalStatus };
function isLocalWorkerRead(value: WorkerRead): value is { source: "local"; value: LocalStatus } {
  return "source" in value && value.source === "local";
}

export function MacLocalWorkerEvidence({ status }: { status?: LocalStatus }) {
  return <section className="private-panel" aria-labelledby="local-worker-evidence-title">
    <h2 id="local-worker-evidence-title">Local worker evidence</h2>
    <p>{status ? `The current local host reports ${status.workers.length} configured route${status.workers.length === 1 ? "" : "s"} separately from saved result proof.`
      : "The current local host route inventory is unavailable."} A passed startup check means the pinned executable was verified when this host started. Result proof means this host generation has saved a result from that route.</p>
    <p><strong>Neither signal says a worker is currently running, has capacity, is eligible for a particular task, or has owner acceptance.</strong> Check the exact task before assignment.</p>
    {!status && <p role="status">The local host status could not be checked, so no startup or result proof is inferred.</p>}
  </section>;
}

type ReadState<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "unavailable" };
export type HomeDashboardState = Readonly<{
  projects: ReadState<ProjectCatalogPage>;
  activity: ReadState<TaskHomeActivity>;
  attention: ReadState<TaskAttentionPage>;
  connections: ReadState<WorkerRead>;
}>;

const loadingState: HomeDashboardState = Object.freeze({ projects: { state: "loading" }, activity: { state: "loading" },
  attention: { state: "loading" }, connections: { state: "loading" } });
const taskHref = (projectId: string, jobId: string) =>
  `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

/** Home reads are safe to repeat, but only the admission-pressure refusal is
 * transient here. Authentication, authorization, routing and malformed-data
 * failures retain their normal fail-closed handling. */
export function createHomeReadTransport(parentSignal: AbortSignal, transport: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ? AbortSignal.any([parentSignal, init.signal]) : parentSignal;
    const options = { ...init, signal };
    const response = await transport(input, options);
    if (response.status !== 503 || (init?.method ?? "GET") !== "GET") return response;
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    return transport(input, options);
  }) as typeof fetch;
}

function Unavailable({ children }: { children: React.ReactNode }) {
  // The trailing sentence is kept verbatim: it is the app's standing refusal to
  // let an unreadable read look like an empty one. Only the presentation moves
  // to the shared component so Home and the other pages cannot drift apart.
  return <UnavailableState>{children} No zero count or all-clear is inferred.</UnavailableState>;
}

export function HomeDashboard({ data }: { data: HomeDashboardState }) {
  return <><a className="private-action-link" href="/projects">New task</a><div className="private-dashboard-grid">
    <section className="private-panel" aria-labelledby="home-active"><PanelHeading id="home-active">Running work
      {data.activity.state === "ready" ? <PrivateCount value={data.activity.value.active.length} /> : null}</PanelHeading>
      {data.activity.state === "loading" ? <LoadingState>Loading saved work…</LoadingState>
        : data.activity.state === "unavailable" ? <Unavailable>Running work is unavailable.</Unavailable>
          : data.activity.value.active.length ? <ul className="private-dashboard-list">{data.activity.value.active.map(task => <li key={task.jobId}>
            <a href={taskHref(task.projectId, task.jobId)}>{task.title}</a><StateChip state={task.state} /></li>)}</ul>
            : <EmptyState>No running or approval-waiting work is recorded.</EmptyState>}
      {data.activity.state === "ready" && data.activity.value.additionalActiveOmitted
        ? <p className="private-note">More running work may exist. Open Projects to inspect it.</p> : null}
      <a className="private-action-link" href="/projects">Open projects</a>
    </section>

    <section className="private-panel" aria-labelledby="home-attention"><PanelHeading id="home-attention">Needs attention
      {data.attention.state === "ready" ? <PrivateCount value={data.attention.value.items.length} /> : null}</PanelHeading>
      {data.attention.state === "loading" ? <LoadingState>Loading saved attention items…</LoadingState>
        : data.attention.state === "unavailable" ? <Unavailable>Attention items are unavailable.</Unavailable>
          : data.attention.value.items.length ? <ul className="private-dashboard-list">{data.attention.value.items.slice(0, 5).map(item => <li key={item.task.jobId}>
            <a href={taskHref(item.task.projectId, item.task.jobId)}>{item.task.title}</a>
            <StateChip label={item.reasons.join(" · ").replaceAll("_", " ")} tone="warn" state="attention" /></li>)}</ul>
            : <EmptyState>No matching task attention items were found in this checked page. This is not a fleet-wide all-clear.</EmptyState>}
      {data.attention.state === "ready" && (data.attention.value.items.length > 5 || data.attention.value.nextCursor)
        ? <p className="private-note">More attention items may be available.</p> : null}
      <a className="private-action-link" href="/needs-me">Open needs attention</a>
    </section>

    <section className="private-panel" aria-labelledby="home-results"><PanelHeading id="home-results">Recent results
      {data.activity.state === "ready" && data.activity.value.resultSource === "configured"
        ? <PrivateCount value={data.activity.value.recentResults.length} /> : null}</PanelHeading>
      {data.activity.state === "loading" ? <LoadingState>Loading verified result records…</LoadingState>
        : data.activity.state === "unavailable" || data.activity.value.resultSource !== "configured"
          ? <Unavailable>Verified result records are unavailable.</Unavailable>
          : data.activity.value.recentResults.length ? <ul className="private-dashboard-list">{data.activity.value.recentResults.slice(0, 5).map(({ task, artifact }) =>
            <li key={artifact.artifactId}><a href={taskResultHrefV1(task.projectId, task.jobId, artifact.artifactId)}>{task.title}</a>
              <span>{task.state === "succeeded" ? `Completed${task.qualityStatus === "accepted" ? " · Accepted" : ""} · ` : ""}{artifact.sizeBytes.toLocaleString()} bytes · <ConfiguredTimestamp value={artifact.receivedAt} prefix="Received" /></span></li>)}</ul>
            : <EmptyState>No verified result records are available yet.</EmptyState>}
      {data.activity.state === "ready" && data.activity.value.additionalResultsOmitted
        ? <p className="private-note">More recent results exist. Open the affected projects to inspect them.</p> : null}
    </section>

    <section className="private-panel" aria-labelledby="home-workers"><PanelHeading id="home-workers">Worker status</PanelHeading>
      {data.connections.state === "loading" ? <LoadingState>Loading saved worker signals…</LoadingState>
        : data.connections.state === "unavailable" ? <Unavailable>Worker status is unavailable.</Unavailable>
          : isLocalWorkerRead(data.connections.value)
            ? <><p>{data.connections.value.value.workers.length} configured local worker route{data.connections.value.value.workers.length === 1 ? "" : "s"}.</p>
              <ul className="private-dashboard-list">{data.connections.value.value.workers.map(worker => <li key={worker.kind}>
                {/* The chip carries only the raw state. An earlier version also
                    appended "readiness <proof>", which produced the string
                    "readiness not proven" — wording the adversarial owner test
                    explicitly forbids on the dashboard, and worse copy than
                    main's own localWorkerStateLabel sentence right beside it.
                    Main's label is the canonical phrasing, so it is not restated
                    in the chip. */}
                <span>{worker.kind}</span><StateChip state={worker.state} tone={workerChipToneV1(worker)} />
                <span>{localWorkerStateLabel(worker)}</span></li>)}</ul>
              <p className="private-note">Current assignment, capacity and resource usage are unknown here. Open Workers and the exact task before assigning work.</p></>
            : <><p>{data.connections.value.projection.summary.connectionCount} enrolled workers · {data.connections.value.projection.summary.currentSignalCount} current signals.</p>
              <p>{data.connections.value.projection.summary.staleSignalCount} stale · {data.connections.value.projection.summary.missingSignalCount} missing · {data.connections.value.projection.summary.attentionCount} need setup or review.</p>
              {data.connections.value.telemetry === "not_configured" && <Unavailable>Signal verification is not configured.</Unavailable>}</>}
      <a className="private-action-link" href="/workers">Open workers</a>
    </section>

    <section className="private-panel private-dashboard-projects" aria-labelledby="home-projects"><PanelHeading id="home-projects">Projects
      {data.projects.state === "ready" ? <PrivateCount value={data.projects.value.projects.length} /> : null}</PanelHeading>
      {data.projects.state === "loading" ? <LoadingState>Loading saved projects…</LoadingState>
        : data.projects.state === "unavailable" ? <Unavailable>Projects are unavailable.</Unavailable>
          : data.projects.value.projects.length ? <ul className="private-dashboard-list">{data.projects.value.projects.slice(0, 6).map(project => <li key={project.projectId}>
            <span><a href={`/projects/${encodeURIComponent(project.projectId)}`}>{project.title}</a>{project.lifecycle === "active" && <> · <a href={`/projects/${encodeURIComponent(project.projectId)}/tasks#new-task`}>New task</a></>}</span><StateChip state={project.lifecycle} /></li>)}</ul>
            : <EmptyState>No saved projects are visible with this access.</EmptyState>}
      {data.projects.state === "ready" && (data.projects.value.projects.length > 6 || data.projects.value.nextCursor)
        ? <p className="private-note">More projects are available in the full catalog.</p> : null}
      <a className="private-action-link" href="/projects">Open all projects</a>
    </section>
  </div></>;
}

/**
 * Keep the installation overview and the concise local-route setup states
 * together on Home. Both are backed by the same protected, redacted read;
 * neither is a live process or availability check.
 */
/** The route panel reads task-worker state itself unless a caller supplies a
 * resolved read. Passing it through here keeps the home panel's three saved
 * route states assertable without waiting on a live `/api/v1/local-workers`
 * read, and lets a page that already holds the read avoid a second one. */
export function HomeInstallationStatus({ topology, taskWorkerStatus, showSetupGuidance }: {
  topology: ReturnType<typeof useInstallationTopology>;
  taskWorkerStatus?: TaskWorkerReadState;
  showSetupGuidance?: boolean;
}) {
  return <>
    <InstallationTopologySummary setup={topology.setup} status={topology.state} />
    <LocalWorkerRouteStatus setup={topology.setup} state={topology.state} taskWorkerStatus={taskWorkerStatus}
      showSetupGuidance={showSetupGuidance} />
  </>;
}

export function PrivateHome() {
  const runtime = useLocalRuntime();
  const displayName = useProductDisplayName();
  const ideaLab = useProductModule("ideaLab");
  const installationTopology = useInstallationTopology();
  const [data, setData] = useState<HomeDashboardState>(loadingState);
  const [runtimeDetectionTimedOut, setRuntimeDetectionTimedOut] = useState(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (runtime.mode !== "checking") { setRuntimeDetectionTimedOut(false); return; }
    const timeout = setTimeout(() => setRuntimeDetectionTimedOut(true), 5_000);
    return () => clearTimeout(timeout);
  }, [runtime.mode]);
  useEffect(() => {
    refresh.current = () => {};
    setData(loadingState);
    if (runtime.mode === "checking" && !runtimeDetectionTimedOut) return;
    let live = true, inFlight = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    setData(runtime.mode === "local" ? { ...loadingState,
      connections: runtime.status ? { state: "ready", value: { source: "local", value: runtime.status } } : { state: "unavailable" } }
      : loadingState);
    // This dashboard only reads already-saved records.  Keep an open local
    // Control Room view useful without inventing browser-side scheduling or
    // treating an old page load as a current worker status.  Hidden tabs do
    // not poll; they refresh once when the owner returns to the tab. Schedule
    // the next poll only after this one settles, and coalesce every other
    // trigger while it is in flight.
    const schedulePoll = () => { if (live) poll = setTimeout(refreshWhenVisible, 30_000); };
    const load = async () => {
      if (!live || inFlight) return;
      inFlight = true;
      clearTimeout(poll);
      request = new AbortController();
      const transport = createHomeReadTransport(request.signal);
      const settle = <T,>(promise: Promise<T>, key: keyof HomeDashboardState) => promise.then(value => {
        if (live) setData(current => ({ ...current, [key]: { state: "ready", value } }));
      }, () => { if (live) setData(current => ({ ...current, [key]: { state: "unavailable" } })); });
      const reads = [settle(createProjectBrowserClient(transport).list(), "projects"),
        settle(readTaskHomeActivity(transport), "activity"), settle(readTaskAttention(undefined, transport), "attention")];
      if (runtime.mode === "hosted") reads.push(settle(readPrivateConnections(transport), "connections"));
      try { await Promise.all(reads); }
      finally { request = undefined; inFlight = false; schedulePoll(); }
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) void load();
    };
    refresh.current = refreshWhenVisible;
    // Deferring the first read lets React's development StrictMode clean up
    // its probe effect before any network request begins.
    const initial = setTimeout(refreshWhenVisible, 0);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      live = false;
      refresh.current = () => {};
      clearTimeout(initial);
      clearTimeout(poll);
      request?.abort();
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [runtime.mode, runtime.status, runtimeDetectionTimedOut]);
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <section className="private-home-intro" aria-labelledby="home-title"><p className="private-eyebrow">Private workspace</p>
      <h1 id="home-title">{displayName}</h1><p>Current saved work, results and attention from the protected Control Room services. This page refreshes while it is open and again when you return to it. Each section reports unavailable data instead of replacing it with a zero.</p>
      <p className="private-note">Unavailable means the saved database or protected read could not be checked. Checking again only rereads saved records; it does not start, assign, approve or retry work.</p>
      <button type="button" onClick={() => refresh.current()}>Check saved dashboard again</button></section>
    {runtime.mode === "local" ? <MacLocalWorkerEvidence status={runtime.status} />
      : <HomeInstallationStatus topology={installationTopology} showSetupGuidance={runtime.mode === "hosted"} />}
    <HomeDashboard data={data} />
    {runtime.mode === "hosted" && <PrivateOperatorCapacityWorkspace />}
    {runtime.mode === "hosted" && ideaLab && <aside className="private-note private-home-note" aria-label="Optional module"><strong>Idea Lab is optional.</strong>{" "}
      <a href="/ideas">Open Idea Lab</a> to compare ideas before promoting an approved one to a project.</aside>}
  </main></div>;
}
