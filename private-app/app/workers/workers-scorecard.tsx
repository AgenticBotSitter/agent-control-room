"use client";

import { useEffect, useState } from "react";
import { LoadingState, UnavailableState, PanelHeading } from "../owner-ui";
import { readWorkerScorecardV1, type WorkerScorecardReadV1 } from "../../../src/web/v1/worker-scorecard-browser-client";

const WORKER_LABELS: Record<WorkerScorecardReadV1["groups"][number]["workerKind"], string> = {
  codex: "Codex", "claude-code": "Claude", hermes: "Hermes",
};

export function groupTitle(group: WorkerScorecardReadV1["groups"][number]) {
  const worker = WORKER_LABELS[group.workerKind];
  const profile = group.provider && group.profile ? ` (${group.provider}/${group.profile})` : "";
  return `${worker} — ${group.model}/${group.effort}${profile}`;
}

export function ScorecardWindow({ label, window }: { label: string; window: WorkerScorecardReadV1["groups"][number]["last7Days"] }) {
  if (window.finished === 0) return <p className="private-note">{label}: no build stage finished.</p>;
  return <div className="private-note">
    <span>{label}: </span>{window.finished} finished · {window.passedFirstTime} passed first time
    {" · "}{window.neededFixes} needed fixes{" · "}{window.failedOrBlocked} failed or blocked
    {window.unknownReview > 0 ? <> · {window.unknownReview} review outcome unknown</> : null}
    {window.neededFixes > 0 && window.caughtBy.length > 0
      ? <> · caught by {window.caughtBy.map(item => `${item.label} (${item.count})`).join(", ")}</> : null}
  </div>;
}

export function ScorecardGroupRow({ group }: { group: WorkerScorecardReadV1["groups"][number] }) {
  return <li>
    <p className="private-attention-what">{groupTitle(group)}</p>
    <ScorecardWindow label="Last 7 days" window={group.last7Days} />
    <ScorecardWindow label="Last 30 days" window={group.last30Days} />
  </li>;
}

/** Read-only bot/model performance, derived from pipeline build-stage completion
 * and the completion-gate's own revision lineage — never written from here.
 * "Needed fixes" and "caught by" reflect only build stages that went through at
 * least one owner or agent review round; a check or sign-off stage's own
 * throughput is not yet counted (see worker-scorecard-read.ts). */
export function WorkersScorecard() {
  const [view, setView] = useState<Awaited<ReturnType<typeof readWorkerScorecardV1>>>();
  useEffect(() => { let live = true; void readWorkerScorecardV1().then(result => { if (live) setView(result); });
    return () => { live = false; }; }, []);
  return <section className="private-panel" aria-labelledby="workers-scorecard-title">
    <PanelHeading id="workers-scorecard-title" count={view?.state === "available" ? view.view.groups.length : undefined}>
      Bot &amp; model scorecard</PanelHeading>
    <p className="private-note">How each bot and model has performed on build-stage work, over the last 7 and 30 days.</p>
    {view?.state === "available" && view.view.olderGroupsOmitted > 0
      ? <p className="private-note">{view.view.olderGroupsOmitted} older groups not shown.</p> : null}
    {/* The EMPTY state and the UNREADABLE state are deliberately different
        words. "No pipeline build stage has finished yet" is a real, checked
        answer and it is a plain status line, not an alarm; "could not be read"
        is the only sentence here that means Control Room did not find out. A
        200 with no groups must never render as the second. */}
    {!view ? <LoadingState>Loading saved scorecard…</LoadingState>
      : view.state === "unavailable" ? <UnavailableState>The scorecard could not be read. No pass rate or count is inferred.</UnavailableState>
        : !view.view.groups.length ? <p className="private-state-empty">No pipeline build stage has finished yet.</p>
          : <ul className="private-dashboard-list">{view.view.groups.map(group =>
              <ScorecardGroupRow key={groupTitle(group)} group={group} />)}</ul>}
  </section>;
}
