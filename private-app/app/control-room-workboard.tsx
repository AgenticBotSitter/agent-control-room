"use client";

import { useEffect, useRef, useState } from "react";
import { readControlRoomWorkboardV1, type ControlRoomWorkboardReadV1 } from "../../src/web/v1/control-room-workboard-browser-client";
import { CAPACITY_FRESHNESS_MINUTES_V1, type OperatorCapacityWorkerV1 } from "../../src/web/v1/operator-capacity-browser-client";
import type { TaskProjectAgentOptions } from "../../src/web/v1/task-project-agents-wire";
import { PrivateHeader } from "./private-header";

type WorkerAvailability = Readonly<{ state: "available" | "unavailable"; message: string }>;
type ExpiryScheduler = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
const systemClock = () => Date.now();
const scheduleTimeout: ExpiryScheduler = (callback, delayMs) => setTimeout(callback, delayMs);
const cancelTimeout = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
const taskHref = (projectId: string, jobId: string) => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

/** The word "available" is intentionally stricter than eligibility or a row in a fleet list. */
export function workerAvailabilityForTaskV1(eligibility: TaskProjectAgentOptions, capacity: OperatorCapacityWorkerV1 | undefined,
  jobId: string, nowMs: number = Date.now()): WorkerAvailability {
  const candidate = eligibility.workers.find(worker => worker.eligibleTasks.some(task => task.jobId === jobId));
  if (eligibility.eligibilitySource !== "configured" || !candidate)
    return { state: "unavailable", message: "Not eligible for this exact task." };
  if (!capacity || capacity.workerId !== candidate.nodeId)
    return { state: "unavailable", message: "Matching worker capacity is unavailable." };
  if (capacity.capability.evidence !== "measured" || capacity.capability.value !== "verified")
    return { state: "unavailable", message: "Matching worker capability is not verified." };
  if (capacity.capacity.evidence !== "measured")
    return { state: "unavailable", message: `Matching capacity is unavailable: ${capacity.capacity.reasonCode.replaceAll("_", " ")}.` };
  const observedAt = Date.parse(capacity.lastObservedAt);
  if (!Number.isFinite(observedAt) || nowMs - observedAt > CAPACITY_FRESHNESS_MINUTES_V1 * 60_000)
    return { state: "unavailable", message: "Matching capacity observation is stale." };
  if (capacity.capacity.value.availableSlots <= 0)
    return { state: "unavailable", message: "No measured slot is available." };
  if (capacity.state === "offline") return { state: "unavailable", message: "Worker is offline." };
  if (capacity.state !== "online" && capacity.state !== "idle")
    return { state: "unavailable", message: `Worker is ${capacity.state}; it is not online or idle.` };
  return { state: "available", message: "Available now — exact eligibility, verified fresh capacity, online or idle state, and a positive measured slot agree." };
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return <p className="private-note" role="status">{children} No empty, idle, or all-clear state is inferred.</p>;
}

function Attention({ title, read, projectId }: { title: string; read: ControlRoomWorkboardReadV1["inbox"]; projectId: string }) {
  return <section className="private-panel"><h2>{title}</h2>
    {!read || read.state === "unavailable" ? <Unavailable>{title} evidence is unavailable.</Unavailable>
      : read.value.items.length ? <ul className="private-dashboard-list">{read.value.items.map(item => <li key={item.task.jobId}>
        <a href={taskHref(projectId, item.task.jobId)}>{item.task.title}</a><span>{item.reasons.join(" · ").replaceAll("_", " ")}</span>
      </li>)}</ul> : <p>No matching items were found in this checked page. This is not an all-clear.</p>}
  </section>;
}

export function ControlRoomWorkboardContent({ projectId, data, nowMs = Date.now() }: {
  projectId?: string; data: ControlRoomWorkboardReadV1; nowMs?: number;
}) {
  const current = data.project?.state === "ready" ? data.project.value.current : [];
  const eligibility = data.eligibility?.state === "ready" ? data.eligibility.value : undefined;
  const capacity = data.capacity.state === "ready" ? data.capacity.value : undefined;
  return <div className="private-dashboard-grid">
    <section className="private-panel"><h2>Current saved work</h2>
      {data.home.state === "unavailable" ? <Unavailable>Current saved work is unavailable.</Unavailable>
        : data.home.value.active.length ? <ul className="private-dashboard-list">{data.home.value.active.map(task => <li key={task.jobId}>
          <a href={taskHref(task.projectId, task.jobId)}>{task.title}</a><span>{task.state.replaceAll("_", " ")}</span>
        </li>)}</ul> : <p>No running or approval-waiting work is recorded.</p>}
    </section>
    <section className="private-panel"><h2>Operator capacity</h2>
      {!capacity ? <Unavailable>Recorded capacity evidence is unavailable.</Unavailable>
        : capacity.capacity.evidence === "measured" ? <p>{capacity.capacity.value.availableSlots} measured available slot(s) from {capacity.capacity.value.reportingWorkers} reporting worker(s).</p>
          : <Unavailable>Measured capacity is unavailable.</Unavailable>}
      <p className="private-note">This is an observation only. It cannot schedule, assign, reserve, or start work.</p>
    </section>
    {projectId ? <>
      <section className="private-panel"><h2>Project activity</h2>
        {data.project?.state === "unavailable" ? <Unavailable>Project activity is unavailable.</Unavailable>
          : current.length ? <ul className="private-dashboard-list">{current.map(task => <li key={task.jobId}>
            <a href={taskHref(projectId, task.jobId)}>{task.title}</a><span>{task.state.replaceAll("_", " ")}</span>
          </li>)}</ul> : <p>No current work is recorded for this project.</p>}
      </section>
      <section className="private-panel"><h2>Eligible worker readiness</h2>
        {!data.project || data.project.state === "unavailable" ? <Unavailable>Project activity is unavailable, so worker eligibility cannot be evaluated for a task.</Unavailable>
          : !eligibility || !capacity ? <Unavailable>Eligibility or capacity evidence is unavailable.</Unavailable>
          : current.length ? <ul className="private-dashboard-list">{current.map(task => {
            const matching = eligibility.workers.find(worker => worker.eligibleTasks.some(item => item.jobId === task.jobId));
            const observation = matching ? capacity.workers.find(worker => worker.workerId === matching.nodeId) : undefined;
            const status = workerAvailabilityForTaskV1(eligibility, observation, task.jobId, nowMs);
            return <li key={task.jobId}><a href={taskHref(projectId, task.jobId)}>{task.title}</a>
              <span>{status.state === "available" ? "Eligible worker: Available now" : `Eligible worker: ${status.message}`}</span></li>;
          })}</ul> : <p>No current project task has eligibility to evaluate.</p>}
        <p className="private-note">This board cannot assign, start, stop, retry, approve, or submit a result.</p>
      </section>
      <Attention title="Project inbox" read={data.inbox} projectId={projectId} />
      <Attention title="Project reviews" read={data.reviews} projectId={projectId} />
    </> : <section className="private-panel"><h2>Project detail</h2><p>Open this board from a project’s Control Room link to read that project’s activity, task eligibility, inbox, and reviews.</p></section>}
  </div>;
}

/**
 * Schedules one redraw at the next canonical capacity-expiry boundary. This
 * neither re-reads nor polls; the normal protected read only happens on mount
 * or the owner pressing Refresh. Cleanup prevents a closed page from updating.
 */
export function ControlRoomWorkboardExpiryContent({ projectId, data, clock = systemClock,
  schedule = scheduleTimeout, cancel = cancelTimeout }: { projectId?: string; data: ControlRoomWorkboardReadV1;
  clock?: () => number; schedule?: ExpiryScheduler; cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const [nowMs, setNowMs] = useState(clock);
  const presentedData = useRef(data);
  // A new protected snapshot may arrive after this component mounted. Sync its
  // presentation clock once for that new data only; this is deliberately not
  // part of the expiry scheduler, which changes time only on its one-shot.
  useEffect(() => {
    if (presentedData.current === data) return;
    presentedData.current = data;
    const current = clock();
    setNowMs(previous => previous === current ? previous : current);
  }, [data, clock]);
  useEffect(() => {
    if (data.capacity.state !== "ready") return;
    // `workerAvailabilityForTaskV1` treats exactly the canonical boundary as
    // fresh (`age > window` is stale), so redraw one millisecond afterwards.
    // Rows already past that point are deliberately ignored: they must not
    // prevent a later still-fresh row from scheduling its own redraw.
    const expiry = Math.min(...data.capacity.value.workers.map(worker => {
      const observed = Date.parse(worker.lastObservedAt);
      const nextExpiry = Number.isFinite(observed) ? observed + CAPACITY_FRESHNESS_MINUTES_V1 * 60_000 + 1 : Number.POSITIVE_INFINITY;
      return nextExpiry > nowMs ? nextExpiry : Number.POSITIVE_INFINITY;
    }));
    const delay = expiry - clock();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = schedule(() => setNowMs(clock()), delay);
    return () => cancel(timer);
  }, [data, nowMs, clock, schedule, cancel]);
  return <ControlRoomWorkboardContent projectId={projectId} data={data} nowMs={nowMs} />;
}

export function PrivateControlRoomWorkboard({ projectId, read = readControlRoomWorkboardV1, clock = systemClock,
  schedule = scheduleTimeout, cancel = cancelTimeout }: { projectId?: string; read?: typeof readControlRoomWorkboardV1;
  clock?: () => number; schedule?: ExpiryScheduler; cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const [data, setData] = useState<ControlRoomWorkboardReadV1>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(undefined);
    void read(projectId, fetch, controller.signal).then(value => {
      if (!controller.signal.aborted) setData(value);
    });
    return () => controller.abort();
  }, [projectId, refresh, read]);
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <section className="private-home-intro"><p className="private-eyebrow">Private workspace</p><h1>Control Room workboard</h1>
      <p>One local view of protected saved work and evidence. It reads existing records only; it does not connect to a worker host or run a worker.</p>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh evidence</button></section>
    {data ? <ControlRoomWorkboardExpiryContent projectId={projectId} data={data} clock={clock} schedule={schedule} cancel={cancel} /> : <section className="private-panel" aria-live="polite"><h2>Control Room workboard</h2><p>Reading saved evidence.</p></section>}
  </main></div>;
}
