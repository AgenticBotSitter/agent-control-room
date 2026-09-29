"use client";

import { useCallback, useEffect, useState } from "react";
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
import { useVisiblePolling } from "./use-visible-polling";
import { OperationsControlPanel } from "./operations-control";
import { StateChip, LoadingState, EmptyState, UnavailableState, PanelHeading, PrivateCount, workerChipToneV1 } from "./owner-ui";
import { UpdateCandidatesHome } from "./update-candidates-home";

export type WorkerRead = PrivateConnectionSnapshot | { source: "local"; value: LocalStatus };
export function isLocalWorkerRead(value: WorkerRead): value is { source: "local"; value: LocalStatus } {
  return "source" in value && value.source === "local";
}

export function MacLocalWorkerEvidence({ status }: { status?: LocalStatus }) {
  return <section className="private-panel private-local-worker-evidence" aria-labelledby="local-worker-evidence-title">
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

/** Workers whose current signal means the owner should look: offline,
 * unreachable, or a local route that failed its startup check. This is a
 * narrow, honestly-derived subset of the same connection data "Worker status"
 * already reads — not a second data source and not a guess about a worker
 * this view has no signal for. */
export function stuckWorkerCount(value: WorkerRead): number {
  return isLocalWorkerRead(value) ? value.value.workers.filter(worker => worker.state === "unavailable").length
    : value.projection.summary.staleSignalCount + value.projection.summary.missingSignalCount;
}

export function HomeDashboard({ data }: { data: HomeDashboardState }) {
  return <><a className="private-action-link" href="/projects">New task</a><div className="private-dashboard-grid">
    {/* Needs attention leads the dashboard and is visually loud (red), per
        owner-ux-feedback-2026-09-27.md items 1-3: "a clear list 'This needs
        you → why → one button to act'", a red box, and an empty state that is
        one short line. Caveats about page limits move to a details toggle
        instead of sitting in the main flow. The panel keeps its exact heading
        text "Needs attention" (asserted by tests/mac-local-real-pages.test.tsx)
        and its id/aria-labelledby (asserted by
        tests/owner-home-reading-order.test.tsx); only its position, styling
        and item markup change. */}
    <section className={`private-panel private-attention-box${data.attention.state === "ready" && data.attention.value.items.length ? " has-items" : ""}`}
      aria-labelledby="home-attention"><PanelHeading id="home-attention">Needs attention
      {data.attention.state === "ready" ? <PrivateCount value={data.attention.value.items.length} /> : null}</PanelHeading>
      {data.attention.state === "loading" ? <LoadingState>Loading saved attention items…</LoadingState>
        : data.attention.state === "unavailable" ? <Unavailable>Attention items are unavailable.</Unavailable>
          : data.attention.value.items.length ? <ul className="private-dashboard-list private-attention-list">{data.attention.value.items.slice(0, 5).map(item => <li key={item.task.jobId}>
            <StateChip label={item.reasons.join(" · ").replaceAll("_", " ")} tone="bad" state="attention" />
            <p className="private-attention-what">{item.task.title}</p>
            <a className="private-action-link" href={taskHref(item.task.projectId, item.task.jobId)}>Open task</a></li>)}</ul>
            : <EmptyState>Nothing needs you right now.</EmptyState>}
      {data.attention.state === "ready" && (data.attention.value.items.length > 5 || data.attention.value.nextCursor)
        ? <details><summary>Details</summary><p className="private-note">More attention items may be available than the five shown here.</p></details> : null}
      {data.attention.state === "ready" && !data.attention.value.items.length
        ? <details><summary>Details</summary><p className="private-note">This reflects a checked page of saved task attention. It is not a fleet-wide all-clear.</p></details> : null}
      <a className="private-action-link" href="/needs-me">Open Action Inbox</a>
    </section>

    <UpdateCandidatesHome />

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

    {/* "Finished since you last looked" per owner-ux-feedback and the Tango
        recommendations (research/tango/03-recommendations.md row 15). This
        reuses the exact same verified result records the former "Recent
        results" panel read; only the heading and framing change, so every
        result link and its acceptance/byte/received copy is unchanged. */}
    <section className="private-panel" aria-labelledby="home-results"><PanelHeading id="home-results">Finished since you last looked
      {data.activity.state === "ready" && data.activity.value.resultSource === "configured"
        ? <PrivateCount value={data.activity.value.recentResults.length} /> : null}</PanelHeading>
      {data.activity.state === "loading" ? <LoadingState>Loading verified result records…</LoadingState>
        : data.activity.state === "unavailable" || data.activity.value.resultSource !== "configured"
          ? <Unavailable>Verified result records are unavailable.</Unavailable>
          : data.activity.value.recentResults.length ? <ul className="private-dashboard-list">{data.activity.value.recentResults.slice(0, 5).map(({ task, artifact }) =>
            <li key={artifact.artifactId}><a href={taskResultHrefV1(task.projectId, task.jobId, artifact.artifactId)}>{task.title}</a>
              <span>{task.state === "succeeded" ? `Completed${task.qualityStatus === "accepted" ? " · Accepted" : ""} · ` : ""}{artifact.sizeBytes.toLocaleString()} bytes · <ConfiguredTimestamp value={artifact.receivedAt} prefix="Received" /></span></li>)}</ul>
            : <EmptyState>Nothing has finished since your last visit.</EmptyState>}
      {data.activity.state === "ready" && data.activity.value.additionalResultsOmitted
        ? <p className="private-note">More recent results exist. Open the affected projects to inspect them.</p> : null}
    </section>

    {/* Stuck, blocked or offline: the worker-side counterpart to "Needs
        attention" (which is task-side). It reads the same connection signals
        "Worker status" below already fetched — a stale or missing signal in
        hosted mode, an unavailable startup check in Mac-local mode — and
        never invents a state this app has no signal for. */}
    <section className="private-panel" aria-labelledby="home-stuck"><PanelHeading id="home-stuck">Stuck, blocked or offline
      {data.connections.state === "ready" ? <PrivateCount value={stuckWorkerCount(data.connections.value)} /> : null}</PanelHeading>
      {data.connections.state === "loading" ? <LoadingState>Loading saved worker signals…</LoadingState>
        : data.connections.state === "unavailable" ? <Unavailable>Worker signals are unavailable.</Unavailable>
          : isLocalWorkerRead(data.connections.value)
            ? (() => { const stuck = data.connections.value.value.workers.filter(worker => worker.state === "unavailable");
              return stuck.length
                ? <ul className="private-dashboard-list">{stuck.map(worker => <li key={worker.kind}>
                  <span>{worker.kind}</span><StateChip state={worker.state} tone="bad" /></li>)}</ul>
                : <EmptyState>No worker route is reporting stuck, blocked or offline.</EmptyState>; })()
            : stuckWorkerCount(data.connections.value) > 0
              ? <p>{data.connections.value.projection.summary.staleSignalCount} stale worker signal{data.connections.value.projection.summary.staleSignalCount === 1 ? "" : "s"} ·
                {" "}{data.connections.value.projection.summary.missingSignalCount} missing.</p>
              : <EmptyState>No worker is reporting a stale or missing signal.</EmptyState>}
      {data.connections.state === "ready" ? <details><summary>Details</summary><p className="private-note">A stale or missing signal means this Control Room has not recently heard from that worker.
        It does not by itself mean the worker's task failed, and a fresh signal is not proof of capacity to take more work.</p></details> : null}
      <a className="private-action-link" href="/workers">Open workers</a>
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
  useEffect(() => {
    if (runtime.mode !== "checking") { setRuntimeDetectionTimedOut(false); return; }
    const timeout = setTimeout(() => setRuntimeDetectionTimedOut(true), 5_000);
    return () => clearTimeout(timeout);
  }, [runtime.mode]);
  const pollingEnabled = runtime.mode !== "checking" || runtimeDetectionTimedOut;
  useEffect(() => {
    setData(loadingState);
    if (!pollingEnabled) return;
    setData(runtime.mode === "local" ? { ...loadingState,
      connections: runtime.status ? { state: "ready", value: { source: "local", value: runtime.status } } : { state: "unavailable" } }
      : loadingState);
  }, [pollingEnabled, runtime.mode, runtime.status]);
  const load = useCallback(async (signal: AbortSignal) => {
    const transport = createHomeReadTransport(signal);
    const settle = <T,>(promise: Promise<T>, key: keyof HomeDashboardState) => promise.then(value => {
      if (!signal.aborted) setData(current => ({ ...current, [key]: { state: "ready", value } }));
    }, () => { if (!signal.aborted) setData(current => ({ ...current, [key]: { state: "unavailable" } })); });
    const reads = [settle(createProjectBrowserClient(transport).list(), "projects"),
      settle(readTaskHomeActivity(transport), "activity"), settle(readTaskAttention(undefined, transport), "attention")];
    if (runtime.mode === "hosted") reads.push(settle(readPrivateConnections(transport), "connections"));
    await Promise.all(reads);
  }, [runtime.mode]);
  const refresh = useVisiblePolling(load, pollingEnabled);
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1} className="private-home-main">
    <section className="private-home-intro" aria-labelledby="home-title"><p className="private-eyebrow">Private workspace</p>
      <h1 id="home-title">{displayName}</h1></section>
    {/* ONE order, and it is the order it paints in — no `order` on this page,
        at any width, in either runtime.

        An earlier version made `main` a phone-width flex column and gave the
        intro, the dashboard, the worker-evidence panel and this copy explicit
        `order` values, so the panels could paint above the copy without moving
        anything in the DOM. That was the wrong tool. CSS `order` changes paint
        order only: keyboard focus and screen-reader reading order still follow
        the DOM, so the focusable "Check saved dashboard again" button was the
        first control in `main` for a keyboard while painting last for a sighted
        owner. In hosted mode it was worse — the installation panels, the "New
        task" link and operator capacity carry no `order`, so they painted at
        the default 0, ahead of the dashboard's `order: 1`, and the
        attention-first result did not hold at all.

        The DOM order below is the old *painted* order, made real:

          intro -> dashboard -> evidence/install -> capacity -> idea lab -> copy

        So the dashboard leads the panels in both runtimes, the copy and its
        button come last, and a keyboard, a screen reader and a sighted owner
        all walk the page in the same sequence. "Needs attention" is the second
        panel inside the dashboard and the dashboard now follows only the
        workspace heading, so attention clears the fold on a 375x812 phone in
        hosted mode as well as Mac-local — which the old painted order could
        not promise, because the install panels are two full panels of text.

        Four guards keep this from coming back, and each covers a different
        spelling of it. tests/owner-home-reading-order.test.tsx scans the
        shipped stylesheet for `order`, `*-reverse` and explicit grid placement
        on these blocks, and every owner component for a positive tabindex; it
        also renders both runtime modes against the real stylesheet and
        requires paint order to be monotonic.
        tests/browser/owner-phone-width.spec.ts then walks `main` in real
        Chromium in both runtime modes and requires the keyboard to reach
        controls in painted order. jsdom cannot measure painted order, so that
        second one is the only check that would have caught the original defect
        on a real page. */}
    <HomeDashboard data={data} />
    <p className="private-note"><a href="/morning">Open morning summary</a> — finished, waiting for you, stalled and PRs opened since Control Room last checked.</p>
    <OperationsControlPanel />
    {runtime.mode === "local" ? <MacLocalWorkerEvidence status={runtime.status} />
      : <HomeInstallationStatus topology={installationTopology} showSetupGuidance={runtime.mode === "hosted"} />}
    {runtime.mode === "hosted" && <PrivateOperatorCapacityWorkspace />}
    {runtime.mode === "hosted" && ideaLab && <aside className="private-note private-home-note" aria-label="Optional module"><strong>Idea Lab is optional.</strong>{" "}
      <a href="/ideas">Open Idea Lab</a> to compare ideas before promoting an approved one to a project.</aside>}
    <div className="private-home-lead">
      <p>Current saved work, results and attention from the protected Control Room services. This page refreshes while it is open and again when you return to it. Each section reports unavailable data instead of replacing it with a zero.</p>
      <p className="private-note">Unavailable means the saved database or protected read could not be checked. Checking again only rereads saved records; it does not start, assign, approve or retry work.</p>
      <button type="button" onClick={refresh}>Check saved dashboard again</button>
    </div>
  </main></div>;
}
