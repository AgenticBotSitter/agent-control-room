"use client";

import { useEffect, useState } from "react";
import { StateChip, LoadingState, UnavailableState, type ChipTone } from "../owner-ui";
import { readOperatorCapacityViewV1, type OperatorCapacityWorkerV1 } from "../../../src/web/v1/operator-capacity-browser-client";
import { ConfiguredTimestamp } from "../configured-timestamp";

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

function WorkerBoardRow({ worker }: { worker: OperatorCapacityWorkerV1 }) {
  const status = workerBoardStatus(worker.state);
  return <li>
    <StateChip state={worker.state} tone={status.tone} label={status.label} />
    <p className="private-attention-what">{worker.workerId}</p>
    <p className="private-note">{worker.platform} ·{" "}
      {worker.capacity.evidence === "measured" ? `${worker.capacity.value.availableSlots} of ${worker.capacity.value.totalSlots} slots available`
        : "capacity unknown — not measured"} ·{" "}
      <ConfiguredTimestamp value={worker.lastObservedAt} prefix="Last seen" /></p>
  </li>;
}

/** A scannable board above the detailed capacity panel: every registered
 * worker, its plain status, capacity and when it was last seen
 * (owner-ux-feedback-2026-09-27.md and OWNER_PRODUCT_VISION.md "See the whole
 * operation": "current capacity ... and honest resource/usage information for
 * each worker"). Current task and recent results are not tracked per worker
 * by any read this app has, so this says so once, here, rather than inventing
 * a per-row line that would repeat the same "unknown" sentence N times — the
 * same wall-of-text problem this board exists to fix. The detailed capacity,
 * queue-pressure and model-outcome panel below it on the page
 * (`PrivateOperatorCapacityWorkspace`) is the fuller, already-shipped read of
 * the same evidence; this board is deliberately not a second data source. */
export function HostedWorkersBoard() {
  const [view, setView] = useState<Awaited<ReturnType<typeof readOperatorCapacityViewV1>>>();
  useEffect(() => { let live = true; void readOperatorCapacityViewV1().then(result => { if (live) setView(result); });
    return () => { live = false; }; }, []);
  return <section className="private-panel" aria-labelledby="workers-board-title">
    <h2 id="workers-board-title">Workers board</h2>
    {!view ? <LoadingState>Loading saved worker signals…</LoadingState>
      : view.state === "unavailable" ? <UnavailableState>Worker signals are unavailable. No readiness, capacity or running work is inferred.</UnavailableState>
        : !view.view.workers.length ? <p>No worker is registered.</p>
          : <ul className="private-dashboard-list">{view.view.workers.map(worker => <WorkerBoardRow key={worker.workerId} worker={worker} />)}</ul>}
    <p className="private-note">Current task and recent results are not tracked per worker in this view. Open a task to see who has it.</p>
  </section>;
}
