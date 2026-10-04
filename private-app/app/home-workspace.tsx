"use client";
import { ownerStatusLabels } from "./owner-status-labels";
import { OwnerName } from "./owner-ui";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createProjectBrowserClient } from "../../src/web/v1/browser-client";
import { readPrivateConnections, type PrivateConnectionSnapshot } from "../../src/web/v1/connection-browser-client";
import { type SharedAttentionValue, useSharedTaskAttention, refreshSharedTaskAttention } from "./shared-task-attention";
import { readTaskHomeActivity } from "../../src/web/v1/task-home-browser-client";
import { buildActionInbox } from "../../src/web/v1/action-inbox";
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
import { StateChip, LoadingState, EmptyState, UnavailableState, PanelHeading, PrivateCount, pagedCount, workerChipToneV1 } from "./owner-ui";
import { useOperationsControl } from "./operations-control";
import { createOperationsModeBrowserClient } from "../../src/web/v1/operations-mode-browser-client";
import type { OperationsModeViewV1 } from "../../src/web/v1/operations-mode-wire";
import { UpdateCandidatesHome } from "./update-candidates-home";
import { UpdaterHomeStatus } from "./updater-home-status";
import { EverythingElseMenu } from "./everything-else-menu";

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

/** The installation's operations mode as the attention box needs it (R4U-08).
 *
 * A separate prop rather than part of `HomeDashboardState` because it is a
 * DIFFERENT read with a different lifetime: the dashboard state is reset to
 * `loadingState` on every poll, while the mode keeps its last successful
 * answer during its own refreshes. Folding it in would have made the mode's
 * line blink to "Checking…" on every 30-second poll.
 *
 * `loading` and `unavailable` are kept apart on purpose. Silence in the red box
 * is read as "nothing is wrong", so a failed mode read has to say it could not
 * be checked; a read still in progress has to say it is being checked. Both
 * say no mode until a first successful read; later checks retain that answer. */
export type HomeOperationsModeState =
  | { state: "loading" }
  | { state: "ready"; value: OperationsModeViewV1; checking?: boolean; refreshFailed?: boolean }
  | { state: "unavailable" };

/** The one sentence the attention box adds for the installation's mode.
 *
 * "No new work" is the owner's consequence, not the server's field name, so it
 * is the sentence that leads and the mode name follows: an owner who pressed
 * Paused must be able to match what they see here to what they pressed. A
 * `running` installation adds NOTHING, because a healthy page must stay healthy.
 *
 * Exported so the test reads the sentence from here rather than restating it. */
export function installationModeLine(value: OperationsModeViewV1): string | undefined {
  if (value.mode === "running") return undefined;
  if (value.mode === "stopped") return "Stopped — nothing new is claimed or started, and Control Room has asked the running work to stop.";
  if (value.mode === "draining") return "Draining — no new work is claimed or started. Work already in progress finishes rather than being extended.";
  return "Paused — no new work will be claimed or started. Work already in progress keeps running.";
}
export type HomeDashboardState = Readonly<{
  projects: ReadState<ProjectCatalogPage>;
  activity: ReadState<TaskHomeActivity>;
  attention: ReadState<TaskAttentionPage | SharedAttentionValue>;
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

export function HomeDashboard({ data, operationsMode }:
  { data: HomeDashboardState; operationsMode?: HomeOperationsModeState }) {
  const attentionItems = data.attention.state === "ready"
    ? "complete" in data.attention.value ? data.attention.value.items : buildActionInbox([data.attention.value]) : [];
  const attentionComplete = data.attention.state === "ready"
    && ("complete" in data.attention.value ? data.attention.value.complete : !data.attention.value.nextCursor);
  const workerWarnings = data.connections.state === "ready" ? stuckWorkerCount(data.connections.value) : 0;
  const hasWarning = workerWarnings > 0 || data.connections.state === "unavailable";
  const previousAttention = useRef<string | undefined>(undefined);
  const [attentionAnnouncement, setAttentionAnnouncement] = useState<{ key: string; text: string }>();
  // The announcement reads the same aggregate items the list shows (r6ibfix), so
  // operator items are announced too. A re-check in flight marks the snapshot
  // incomplete for a moment; that is not news, so it is not announced.
  const attentionChecking = data.attention.state === "ready" && "checking" in data.attention.value && !!data.attention.value.checking;
  const attentionSignature = data.attention.state === "ready" && !attentionChecking
    ? JSON.stringify(attentionItems.map(item => [item.key, item.kind]).sort())
    : undefined;
  const attentionCount = attentionItems.length;
  const attentionTruncated = !attentionComplete;
  useEffect(() => {
    if (attentionSignature === undefined) return;
    const key = `${attentionSignature}:${attentionTruncated}`;
    if (previousAttention.current === key) return;
    const initialEmpty = previousAttention.current === undefined && attentionCount === 0;
    previousAttention.current = key;
    if (initialEmpty) return;
    setAttentionAnnouncement({ key, text: attentionCount
      ? `${attentionCount}${attentionTruncated ? " or more" : ""} ${attentionCount === 1 ? "item needs" : "items need"} your attention. Open Action Inbox to review.`
      : "Nothing needs you on the checked attention page." });
  }, [attentionSignature, attentionCount, attentionTruncated]);
  // What the installation's mode adds to the box, or nothing. Four states, all
  // named, none of them silence (R4U-08):
  //   ready + running              -> nothing, so a healthy page stays healthy;
  //   ready + a mode admitting no new work -> the consequence sentence;
  //   loading                      -> "being checked", because a red box that
  //                                  says nothing yet is a box that looks empty;
  //   unavailable                  -> "could not be checked", because an absent
  //                                  mode line in a red box reads as "all clear".
  const modeNote = operationsMode === undefined ? null
    : operationsMode.state === "loading"
      ? { tone: "warn" as const, text: "Checking whether this installation is running or paused…" }
      : operationsMode.state === "unavailable"
        ? { tone: "warn" as const, text: "The installation's run state could not be checked, so no mode is claimed here." }
        : (() => {
          const line = installationModeLine(operationsMode.value);
          return line === undefined ? null : { tone: "warn" as const, text: line };
        })();
  return <><a className="private-action-link" href="/projects">New task</a><div className="private-dashboard-grid">
    {/* Needs attention leads the dashboard and is visually loud (red), per
        owner-ux-feedback-2026-09-27.md items 1-3: "a clear list 'This needs
        you → why → one button to act'", a red box, and an empty state that is
        one short line. An incomplete read stays visible in the main flow. The panel keeps its exact heading
        text "Needs attention" (asserted by tests/mac-local-real-pages.test.tsx)
        and its id/aria-labelledby (asserted by
        tests/owner-home-reading-order.test.tsx); only its position, styling
        and item markup change. */}
    <section className={`private-panel private-attention-box${hasWarning || data.attention.state === "ready" && attentionItems.length ? " has-items" : ""}`}
      aria-labelledby="home-attention"><PanelHeading id="home-attention">Needs attention
      {/* "N+" whenever the snapshot is not complete (a next cursor on a page, a
          truncated or failed source, or a re-check in flight), the same rule as
          the header badge: never an exact number the owner could under-read. */}
      {data.attention.state === "ready" && data.connections.state === "ready"
        ? <PrivateCount value={pagedCount(attentionItems.length + workerWarnings, attentionComplete ? null : "incomplete")} /> : null}</PanelHeading>
      <p className="private-sr-only" data-field="attention-announcement" aria-live="polite" aria-atomic="true">
        {attentionAnnouncement && <span key={attentionAnnouncement.key}>{attentionAnnouncement.text}</span>}
      </p>
      {data.attention.state === "loading" ? <LoadingState>Loading saved attention items…</LoadingState>
        : data.attention.state === "unavailable" ? <Unavailable>Attention items are unavailable.</Unavailable>
          : attentionItems.length ? <ul className="private-dashboard-list private-attention-list">{attentionItems.slice(0, 5).map(item => <li key={item.key}>
            <StateChip label={item.kind} tone="bad" state="attention" />
            <p className="private-attention-what">{item.title}</p>
            <a className="private-action-link" href={item.href ?? "/needs-me"}>{item.href ? item.actionLabel : "Open Action Inbox"}</a></li>)}</ul>
            : attentionComplete && !hasWarning && data.connections.state === "ready" ? <EmptyState>{ownerStatusLabels.attention.clear}</EmptyState> : null}
      {data.attention.state === "ready" && "checking" in data.attention.value && data.attention.value.checking ? <LoadingState>Checking saved attention…</LoadingState>
        : data.attention.state === "ready" && !attentionComplete ? <p role="alert">Attention could not be checked completely. No all-clear is assumed.</p> : null}
      {workerWarnings > 0 ? <p role="alert"><strong>Worker warning:</strong> {workerWarnings} worker{workerWarnings === 1 ? " is" : "s are"} offline or unavailable. <a href="/workers">Check workers</a></p> : null}
      {data.connections.state === "unavailable" && data.attention.state === "ready" ? <Unavailable>Worker warnings are unavailable.</Unavailable>
        : data.connections.state === "loading" && data.attention.state === "ready" ? <LoadingState>Checking worker warnings…</LoadingState> : null}
      {/* The installation's own run state, inside the red box and ABOVE the task
          list. It is the one thing here that is about the whole installation
          rather than one task, and it is the thing an owner most needs to know
          before reading a list of tasks that will not start. It goes first so
          the consequence is read before the items. */}
      {modeNote ? <p className="private-notice private-attention-mode" role="status">{modeNote.text}</p> : null}
      {operationsMode?.state === "ready" && operationsMode.checking
        && <p className="private-note" role="status">Checking…</p>}
      {operationsMode?.state === "ready" && operationsMode.refreshFailed
        && <p className="private-note" role="status">{ownerStatusLabels.attention.refreshFailed}</p>}
      {data.attention.state === "ready" && (attentionItems.length > 5 || !attentionComplete)
        ? <details><summary>Details</summary><p className="private-note">More attention items may be available than the five shown here.</p></details> : null}
      {data.attention.state === "ready" && !attentionItems.length
        ? <details><summary>Details</summary><p className="private-note">This reflects a checked page of saved task attention. It is not a fleet-wide all-clear.</p></details> : null}
      <a className="private-action-link" href="/needs-me">Open Action Inbox</a>
    </section>

    <UpdateCandidatesHome />

    <section className="private-panel" aria-labelledby="home-active"><PanelHeading id="home-active">Running work
      {data.activity.state === "ready" ? <PrivateCount value={pagedCount(data.activity.value.active.length, data.activity.value.additionalActiveOmitted)} /> : null}</PanelHeading>
      {data.activity.state === "loading" ? <LoadingState>Loading saved work…</LoadingState>
        : data.activity.state === "unavailable" ? <Unavailable>Running work is unavailable.</Unavailable>
          : data.activity.value.active.length ? <ul className="private-dashboard-list">{data.activity.value.active.map(task => <li key={task.jobId}>
            <a href={taskHref(task.projectId, task.jobId)}>{task.title}</a><StateChip state={task.state} /></li>)}</ul>
            : <EmptyState>No running or approval-waiting work is recorded.</EmptyState>}
      {data.activity.state === "ready" && data.activity.value.additionalActiveOmitted
        ? <p className="private-note">More running work may exist. Open Projects to inspect it.</p> : null}
      <a className="private-action-link" href="/projects">Open projects</a>
    </section>

    <section className="private-panel" aria-labelledby="home-results"><PanelHeading id="home-results">Recent results
      {data.activity.state === "ready" && data.activity.value.resultSource === "configured"
        ? <PrivateCount value={pagedCount(data.activity.value.recentResults.length, data.activity.value.additionalResultsOmitted)} /> : null}</PanelHeading>
      {data.activity.state === "loading" ? <LoadingState>Loading verified result records…</LoadingState>
        : data.activity.state === "unavailable" || data.activity.value.resultSource !== "configured"
          ? <Unavailable>Verified result records are unavailable.</Unavailable>
          : data.activity.value.recentResults.length ? <ul className="private-dashboard-list">{data.activity.value.recentResults.slice(0, 5).map(({ task, artifact }) =>
            <li key={artifact.artifactId}><a href={taskResultHrefV1(task.projectId, task.jobId, artifact.artifactId)}>{task.title}</a>
              <span>{task.state === "succeeded" ? `Completed${task.qualityStatus === "accepted" ? " · Accepted" : ""} · ` : ""}{artifact.sizeBytes.toLocaleString()} bytes · <ConfiguredTimestamp value={artifact.receivedAt} prefix="Received" /></span></li>)}</ul>
            : <EmptyState>No recent results are recorded.</EmptyState>}
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
      {data.projects.state === "ready" ? <PrivateCount value={pagedCount(data.projects.value.projects.length, data.projects.value.nextCursor)} /> : null}</PanelHeading>
      {data.projects.state === "loading" ? <LoadingState>Loading saved projects…</LoadingState>
        : data.projects.state === "unavailable" ? <Unavailable>Projects are unavailable.</Unavailable>
          : data.projects.value.projects.length ? <ul className="private-dashboard-list">{data.projects.value.projects.slice(0, 6).map(project => <li key={project.projectId}>
            <span><a href={`/projects/${encodeURIComponent(project.projectId)}`}><OwnerName>{project.title}</OwnerName></a>{project.lifecycle === "active" && <> · <a href={`/projects/${encodeURIComponent(project.projectId)}/tasks#new-task`}>New task</a></>}</span><StateChip state={project.lifecycle} /></li>)}</ul>
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
  const pollingEnabled = runtime.mode !== "checking" || runtimeDetectionTimedOut
    // A SETTLED failed runtime read is not "still checking" (R4U-09). The host
    // told us nothing; it did not tell us slowly. So the dashboard's other reads
    // are allowed to run, which is what puts every panel into a real state
    // instead of leaving the two worker panels on "Loading…" forever.
    || runtime.unreadable !== undefined;
  const sharedAttention = useSharedTaskAttention(pollingEnabled);
  useEffect(() => {
    setData(loadingState);
    if (!pollingEnabled) return;
    setData(runtime.mode === "local" ? { ...loadingState,
      connections: runtime.status ? { state: "ready", value: { source: "local", value: runtime.status } } : { state: "unavailable" } }
      // The host could not be identified, so the worker-signal read is
      // UNAVAILABLE -- stated, with the app's standing refusal to infer a zero.
      // It is never left loading, and it is never an all-clear.
      : runtime.unreadable !== undefined
        ? { ...loadingState, connections: { state: "unavailable" } }
        : loadingState);
  }, [pollingEnabled, runtime.mode, runtime.status, runtime.unreadable]);
  const load = useCallback(async (signal: AbortSignal) => {
    const transport = createHomeReadTransport(signal);
    const settle = <T,>(promise: Promise<T>, key: keyof HomeDashboardState) => promise.then(value => {
      if (!signal.aborted) setData(current => ({ ...current, [key]: { state: "ready", value } }));
    }, () => { if (!signal.aborted) setData(current => ({ ...current, [key]: { state: "unavailable" } })); });
    const reads = [settle(createProjectBrowserClient(transport).list(), "projects"),
      settle(readTaskHomeActivity(transport), "activity"), refreshSharedTaskAttention()];
    if (runtime.mode === "hosted") reads.push(settle(readPrivateConnections(transport), "connections"));
    await Promise.all(reads);
  }, [runtime.mode]);
  const refresh = useVisiblePolling(load, pollingEnabled);
  // One mode reader owns both displays, including resume checks and panel actions.
  const operationsClient = useMemo(() => createOperationsModeBrowserClient(), []);
  const operations = useOperationsControl(operationsClient);
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
    <HomeDashboard data={{ ...data, attention: sharedAttention }} operationsMode={
      operations.view ? { state: "ready", value: operations.view, checking: operations.checking, refreshFailed: operations.refreshFailed }
        : operations.checking ? { state: "loading" }
          : { state: "unavailable" }} />
    <UpdaterHomeStatus />
    <p className="private-note"><a href="/morning">Open morning summary</a> — finished, waiting for you, stalled and PRs opened since Control Room last checked.</p>
    <OperationsControlPanel control={operations} />
    {runtime.mode === "local" ? <MacLocalWorkerEvidence status={runtime.status} />
      : <HomeInstallationStatus topology={installationTopology} showSetupGuidance={runtime.mode === "hosted"} />}
    {runtime.mode === "hosted" && <PrivateOperatorCapacityWorkspace />}
    {runtime.mode === "hosted" && ideaLab && <aside className="private-note private-home-note" aria-label="Optional module"><strong>Idea Lab is optional.</strong>{" "}
      <a href="/ideas">Open Idea Lab</a> to compare ideas before promoting an approved one to a project.</aside>}
    {/* This sits after the attention-first dashboard, so the browse menu never
        pushes the owner’s urgent work below the fold on a phone. */}
    <EverythingElseMenu />
    <div className="private-home-lead">
      <p>Current saved work, results and attention from the protected Control Room services. This page refreshes while it is open and again when you return to it. Each section reports unavailable data instead of replacing it with a zero.</p>
      <p className="private-note">Unavailable means the saved database or protected read could not be checked. Checking again only rereads saved records; it does not start, assign, approve or retry work.</p>
      <button type="button" onClick={refresh}>Check saved dashboard again</button>
    </div>
  </main></div>;
}
