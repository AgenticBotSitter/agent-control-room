"use client";

import { useEffect, useState } from "react";
import { StateChip, LoadingState, UnavailableState, type ChipTone } from "../owner-ui";
import { readOperatorCapacityViewV1, type OperatorCapacityWorkerV1 } from "../../../src/web/v1/operator-capacity-browser-client";
import { ConfiguredTimestamp } from "../configured-timestamp";
import { readWorkerBoardV1, type WorkerBoardReadV1 } from "../../../src/web/v1/worker-board-browser-client";

const taskHref = (projectId: string, jobId: string) => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;

/** The owner asked for one plain status word per worker — working, idle,
 * offline or stuck — rather than the raw fleet vocabulary
 * (owner-ux-feedback-2026-09-27.md: "plain status words"). This is a
 * synthetic label, not a record state, so it is never added to owner-ui's
 * `stateTones` map (that map is asserted against the real state enums in
 * tests/owner-ui.test.tsx); the tone is supplied explicitly here instead. */
export function workerBoardStatus(state: OperatorCapacityWorkerV1["state"]): { label: string; tone: ChipTone } {
  if (state === "busy") return { label: "Working", tone: "good" };
  if (state === "online" || state === "idle") return { label: "Idle", tone: "neutral" };
  if (state === "offline") return { label: "Offline", tone: "bad" };
  return { label: "Stuck", tone: "warn" }; // draining, degraded, maintenance
}

export function WorkerBoardRow({ worker, attribution }: { worker: OperatorCapacityWorkerV1; attribution?: WorkerBoardReadV1["workers"][number] }) {
  const status = workerBoardStatus(worker.state);
  return <li>
    <StateChip state={worker.state} tone={status.tone} label={status.label} />
    <p className="private-attention-what">{worker.workerId}</p>
    <p className="private-note">{worker.platform} ·{" "}
      {worker.capacity.evidence === "measured" ? `${worker.capacity.value.availableSlots} of ${worker.capacity.value.totalSlots} slots available`
        : "capacity unknown — not measured"} ·{" "}
      <ConfiguredTimestamp value={worker.lastObservedAt} prefix="Last seen" /></p>
    <p className="private-note">Current task: {attribution?.currentTask
      ? <><a href={taskHref(attribution.currentTask.projectId, attribution.currentTask.jobId)}>{attribution.currentTask.title}</a> · <ConfiguredTimestamp value={attribution.currentTask.since} prefix="Started" /></>
      : "unknown — no active assignment, lease, or attempt is recorded for this worker."}</p>
    <div className="private-note"><span>Last 3 results: </span>{attribution === undefined ? "unknown — task history could not be read."
      : !attribution.recentResults.length ? "unknown — no terminal result is recorded for this worker."
        : <ul>{attribution.recentResults.map(item => <li key={`${item.jobId}:${item.finishedAt}`}><a href={taskHref(item.projectId, item.jobId)}>{item.title}</a>{" · "}<StateChip state={item.status} label={item.status.replaceAll("_", " ")} />{" · "}<ConfiguredTimestamp value={item.finishedAt} prefix="Finished" /></li>)}</ul>}</div>
  </li>;
}

/** A scannable board: every registered worker's plain status, capacity, current
 * task, and recent terminal results. This combines bounded canonical reads;
 * absent records stay unknown rather than being inferred from health signals. */
export function HostedWorkersBoard() {
  const [view, setView] = useState<Awaited<ReturnType<typeof readOperatorCapacityViewV1>>>();
  const [attribution, setAttribution] = useState<Awaited<ReturnType<typeof readWorkerBoardV1>>>();
  useEffect(() => { let live = true; void readOperatorCapacityViewV1().then(result => { if (live) setView(result); });
    void readWorkerBoardV1().then(result => { if (live) setAttribution(result); });
    return () => { live = false; }; }, []);
  const byWorker = attribution?.state === "available" ? new Map(attribution.view.workers.map(item => [item.workerId, item])) : undefined;
  return <section className="private-panel" aria-labelledby="workers-board-title">
    <h2 id="workers-board-title">Workers board</h2>
    {!view ? <LoadingState>Loading saved worker signals…</LoadingState>
      : view.state === "unavailable" ? <UnavailableState>Worker signals are unavailable. No readiness, capacity or running work is inferred.</UnavailableState>
        : !view.view.workers.length ? <p>No worker is registered.</p>
          : <ul className="private-dashboard-list">{view.view.workers.map(worker => <WorkerBoardRow key={worker.workerId} worker={worker} attribution={byWorker?.get(worker.workerId)} />)}</ul>}
  </section>;
}
