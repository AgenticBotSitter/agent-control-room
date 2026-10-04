"use client";

import { ownerStatusLabels } from "../owner-status-labels";
import { useCallback, useState } from "react";
import { StateChip, LoadingState, UnavailableState, type ChipTone } from "../owner-ui";
import { readOperatorCapacityViewV1, CAPACITY_FRESHNESS_MINUTES_V1, type OperatorCapacityWorkerV1 } from "../../../src/web/v1/operator-capacity-browser-client";
import { useVisiblePolling } from "../use-visible-polling";
import { usePresentationNow } from "../presentation-clock";
import { ConfiguredTimestamp } from "../configured-timestamp";
import { readWorkerBoardV1, type WorkerBoardReadV1 } from "../../../src/web/v1/worker-board-browser-client";

const taskHref = (projectId: string, jobId: string) => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

export function workerBoardStatus(state: OperatorCapacityWorkerV1["state"]): { label: string; tone: ChipTone } {
  if (state === "busy") return { label: ownerStatusLabels.worker.working, tone: "good" };
  if (state === "online") return { label: ownerStatusLabels.worker.online, tone: "neutral" };
  if (state === "idle") return { label: ownerStatusLabels.worker.idle, tone: "neutral" };
  if (state === "offline") return { label: ownerStatusLabels.worker.offline, tone: "bad" };
  return { label: ownerStatusLabels.worker.stuck, tone: "warn" }; // draining, degraded, maintenance
}

export function WorkerBoardRow({ worker, attribution }: { worker: OperatorCapacityWorkerV1; attribution?: WorkerBoardReadV1["workers"][number] }) {
  const now = usePresentationNow();
  const age = worker.lastObservedAt === null ? Infinity : now - Date.parse(worker.lastObservedAt);
  // A saved online/busy/idle observation cannot prove current availability after
  // the fleet telemetry's maximum five-minute lifetime, even if a read hangs.
  // The lifetime is the named CAPACITY_FRESHNESS_MINUTES_V1, the same constant the
  // capacity projection and the workboard use, so this card and those screens
  // cannot disagree about the same worker. The COMPARISON matches them too: an
  // observation exactly at the boundary is still inside its lifetime, and only a
  // millisecond past it is stale. This card used `>=`, which made one instant --
  // exactly the boundary -- read stale here and measured on the other two
  // screens, so naming the lifetime once was not by itself enough.
  const expired = ["online", "busy", "idle"].includes(worker.state) && age > CAPACITY_FRESHNESS_MINUTES_V1 * 60_000;
  const status = expired ? { label: "Stale — status unknown", tone: "warn" as const }
    // A recorded assignment whose lease is gone is not "busy": the card says so
    // rather than promoting a dead lease to Working (R7-03).
    : attribution?.currentTask && (worker.state === "online" || worker.state === "idle")
      ? workerBoardStatus("busy") : workerBoardStatus(worker.state);
  return <li>
    <StateChip state={worker.state} tone={status.tone} label={status.label} />
    <p className="private-attention-what">{worker.workerId}</p>
    <p className="private-note">{worker.platform} ·{" "}
      {expired ? "capacity unknown — observation stale" : worker.capacity.evidence === "measured" ? `${worker.capacity.value.availableSlots} of ${worker.capacity.value.totalSlots} slots available`
        : "capacity unknown — not measured"} ·{" "}
      {worker.lastObservedAt === null ? ownerStatusLabels.worker.lastSeenUnknown : <ConfiguredTimestamp value={worker.lastObservedAt} prefix={ownerStatusLabels.worker.lastSeen} />}</p>
    <p className="private-note">Current task: {attribution?.currentTask
      ? <><a href={taskHref(attribution.currentTask.projectId, attribution.currentTask.jobId)}>{attribution.currentTask.title}</a> · <ConfiguredTimestamp value={attribution.currentTask.since} prefix="Started" /></>
      : attribution?.deadAssignment
        // One plain line, no action: the assignment exists and nothing holds it
        // now. The coordinator reaps it; the owner is not asked to intervene.
        ? <><StateChip state="stale" tone="warn" label="Lease expired" /> Assigned{" "}
          <a href={taskHref(attribution.deadAssignment.projectId, attribution.deadAssignment.jobId)}>{attribution.deadAssignment.title}</a>{" "}
          was recorded; no live lease holds it, so this is not work in progress.</>
        : "unknown — no active assignment, lease, or attempt is recorded for this worker."}</p>
    <div className="private-note"><span>Last 3 results: </span>{attribution === undefined ? "unknown — task history could not be read."
      : !attribution.recentResults.length ? "unknown — no terminal result is recorded for this worker."
        : <ul>{attribution.recentResults.map(item => <li key={`${item.jobId}:${item.finishedAt}`}><a href={taskHref(item.projectId, item.jobId)}>{item.title}</a>{" · "}<StateChip state={item.status} label={item.status.replaceAll("_", " ")} />{" · "}<ConfiguredTimestamp value={item.finishedAt} prefix="Finished" /></li>)}</ul>}</div>
  </li>;
}

/** Keep cancelled reads from publishing, including transports that settle after abort. */
export async function refreshHostedWorkersBoard(signal: AbortSignal, accept: (
  view: Awaited<ReturnType<typeof readOperatorCapacityViewV1>>,
  attribution: Awaited<ReturnType<typeof readWorkerBoardV1>>,
) => void) {
  const [view, attribution] = await Promise.all([
    readOperatorCapacityViewV1({ signal }), readWorkerBoardV1(fetch, signal),
  ]);
  if (!signal.aborted) accept(view, attribution);
}

/** A scannable board: every registered worker's plain status, capacity, current
 * task, and recent terminal results. This combines bounded canonical reads;
 * absent records stay unknown rather than being inferred from health signals. */
export function HostedWorkersBoard() {
  const [view, setView] = useState<Awaited<ReturnType<typeof readOperatorCapacityViewV1>>>();
  const [attribution, setAttribution] = useState<Awaited<ReturnType<typeof readWorkerBoardV1>>>();
  const load = useCallback((signal: AbortSignal) => refreshHostedWorkersBoard(signal, (nextView, nextAttribution) => {
    setView(nextView); setAttribution(nextAttribution);
  }), []);
  useVisiblePolling(load);
  const byWorker = attribution?.state === "available" ? new Map(attribution.view.workers.map(item => [item.workerId, item])) : undefined;
  return <section className="private-panel" aria-labelledby="workers-board-title">
    <h2 id="workers-board-title">Workers board</h2>
    {!view ? <LoadingState>Loading saved worker signals…</LoadingState>
      : view.state === "unavailable" ? <UnavailableState>Worker signals are unavailable. No readiness, capacity or running work is inferred.</UnavailableState>
        : !view.view.workers.length ? <p>No worker is registered.</p>
          : <ul className="private-dashboard-list">{view.view.workers.map(worker => <WorkerBoardRow key={worker.workerId} worker={worker} attribution={byWorker?.get(worker.workerId)} />)}</ul>}
  </section>;
}
