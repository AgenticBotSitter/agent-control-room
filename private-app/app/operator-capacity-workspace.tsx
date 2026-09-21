"use client";

import { useEffect, useRef, useState } from "react";
import { readOperatorCapacityViewV1, type CapacityEvidenceV1, type CapacityUnavailableReasonV1,
  type OperatorCapacityViewV1 } from "../../src/web/v1/operator-capacity-browser-client";

const unavailableCopy: Record<CapacityUnavailableReasonV1, string> = {
  not_reported: "not reported by the source records",
  observation_stale: "the last observation is older than the freshness window",
  observation_missing: "no current observation is recorded",
  source_unavailable: "the source projection did not include this section",
  evidence_not_served: "no evidence is served to this surface",
};

const readFailureCopy: Record<"authentication_required" | "operator_surface_unavailable" | "invalid_response" | "request_failed", string> = {
  authentication_required: "Your session has ended. Sign in again to read the operator capacity view.",
  operator_surface_unavailable: "The operator projection is unavailable. No sample or saved capacity figures are substituted here.",
  invalid_response: "The operator projection could not be read as a valid snapshot. Nothing is displayed from it.",
  request_failed: "The operator projection could not be reached. No cached value is displayed as current.",
};

type ReadFailureCode = "authentication_required" | "operator_surface_unavailable" | "invalid_response" | "request_failed";

/** Renders an evidence class next to the number it describes, so a reader can tell measured from guessed. */
function Evidence({ label, evidence }: { label: string; evidence: CapacityEvidenceV1<unknown> }) {
  if (evidence.evidence === "measured") return <p className="private-note">{label}: measured from the source records.</p>;
  if (evidence.evidence === "inferred") return <p className="private-note">{label}: inferred — {evidence.basis}. This is not a measurement.</p>;
  return <p className="private-note" role="status">{label}: unavailable — {unavailableCopy[evidence.reasonCode]}.</p>;
}

function Value({ evidence }: { evidence: CapacityEvidenceV1<number> }) {
  return evidence.evidence === "unavailable"
    ? <span>Unavailable</span>
    : <span>{evidence.value.toLocaleString()}{evidence.evidence === "inferred" ? " (inferred)" : ""}</span>;
}

/** Narrows a section's evidence to one number without dropping the evidence class. */
function scalar<T>(evidence: CapacityEvidenceV1<T>, pick: (value: T) => number): CapacityEvidenceV1<number> {
  if (evidence.evidence === "unavailable") return evidence;
  if (evidence.evidence === "inferred") return { evidence: "inferred", value: pick(evidence.value), basis: evidence.basis };
  return { evidence: "measured", value: pick(evidence.value) };
}

export function OperatorCapacityWorkspace({ view, unavailableCode, onRetry }: {
  view?: OperatorCapacityViewV1;
  unavailableCode?: ReadFailureCode;
  onRetry?: () => void;
}) {
  if (!view) return <section className="private-panel" aria-labelledby="operator-capacity-title" aria-live="polite">
    <h2 id="operator-capacity-title">Operator capacity</h2>
    <p>{unavailableCode
      ? readFailureCopy[unavailableCode]
      : "No operator capacity view is currently available to this page. Nothing here is estimated, sampled or carried over from an earlier read."}</p>
    <p className="private-note">This page reads existing capacity and outcome records only. It never schedules, assigns, reserves or authorizes work.</p>
    {onRetry && <button type="button" onClick={onRetry}>Check this read again</button>}
  </section>;

  const { capacity, activeWork, queuePressure, reviewDelay, idle, modelOutcomes } = view;
  const outcomes = modelOutcomes.evidence === "unavailable" ? undefined : modelOutcomes.value;
  return <section className="private-panel" aria-labelledby="operator-capacity-title">
    <h2 id="operator-capacity-title">Operator capacity</h2>
    <p>Recorded at <time dateTime={view.generatedAt}>{view.generatedAt}</time>. Observations older than {view.freshnessMinutes} minutes are shown as unavailable rather than as current capacity.</p>
    <p className="private-note">This view informs owners. It does not schedule, assign, reserve or authorize work, and it cannot start an agent.</p>

    <h3>Capacity</h3>
    <dl className="private-configuration-list">
      <div><dt>Reporting workers</dt><dd><Value evidence={scalar(capacity, value => value.reportingWorkers)} /></dd></div>
      <div><dt>Available slots</dt><dd><Value evidence={scalar(capacity, value => value.availableSlots)} /></dd></div>
      <div><dt>Total reported slots</dt><dd><Value evidence={scalar(capacity, value => value.totalSlots)} /></dd></div>
    </dl>
    <Evidence label="Capacity totals" evidence={capacity} />
    {view.workers.length === 0
      ? <p className="private-note">No worker row is recorded, so no capacity total is shown and nothing is assumed about who reported what.</p>
      : <>
        <p className="private-note">{view.excluded.unattributed.count === 0
          ? "Every worker row reports its own capacity, so every counted row is attributed to that worker."
          : `${view.excluded.unattributed.count} worker row(s) are excluded from every total because that row reports no capacity of its own. A shared account or an interrupted session is never folded into another row's total.`}</p>
        <p className="private-note">{view.excluded.notFresh.count === 0
          ? "Every self-reported row is inside the freshness window."
          : `A further ${view.excluded.notFresh.count} worker row(s) do report their own capacity but are excluded from every total because their observation is stale or missing. Freshness is not an attribution failure.`}</p>
      </>}
    <ul className="private-configuration-templates">
      {view.workers.map(worker => <li key={worker.workerId}><strong>{worker.workerId}</strong>
        <span>{worker.platform} · {worker.state} · {worker.capacity.evidence === "measured"
          ? `capacity ${worker.capacity.value.availableSlots} of ${worker.capacity.value.totalSlots} slots`
          : `capacity unavailable — ${unavailableCopy[worker.capacity.reasonCode]}`} · {worker.attribution === "self_reported" ? "self-reported" : "no capacity reported by this row"}</span></li>)}
    </ul>

    <h3>Active work and queue pressure</h3>
    <dl className="private-configuration-list">
      <div><dt>Running</dt><dd><Value evidence={scalar(activeWork, value => value.running)} /></dd></div>
      <div><dt>Leased</dt><dd><Value evidence={scalar(activeWork, value => value.leased)} /></dd></div>
      <div><dt>Waiting for approval</dt><dd><Value evidence={scalar(activeWork, value => value.waitingApproval)} /></dd></div>
      <div><dt>Open reviews awaiting an owner</dt><dd><Value evidence={scalar(reviewDelay, value => value.openReviews)} /></dd></div>
      <div><dt>Workers reporting the idle state</dt><dd><Value evidence={scalar(idle, value => value.idleWorkers)} /></dd></div>
    </dl>
    <Evidence label="Review delay" evidence={reviewDelay} />
    <p className="private-note">{reviewDelay.evidence !== "unavailable" && reviewDelay.value.oldestCreatedAt
      ? `The oldest open review request was recorded at ${reviewDelay.value.oldestCreatedAt}.`
      : "No oldest open review time is reported, so no delay is claimed."}</p>
    <Evidence label="Idle observation" evidence={idle} />
    {queuePressure.evidence === "unavailable"
      ? <p className="private-note" role="status">Queue pressure: unavailable — {unavailableCopy[queuePressure.reasonCode]}.</p>
      : queuePressure.value.length === 0
        ? <p className="private-note">Queue pressure: no bottleneck is recorded for the current window.</p>
        : <ul className="private-configuration-templates">{queuePressure.value.map(item => <li key={item.resourceKey}><strong>{item.resourceKey}</strong>
          <span>{item.utilizationPercent.toLocaleString()}% of the projected limit · {item.blockedWorkItemIds.length} blocked item(s) · {item.explanation}</span></li>)}</ul>}
    <Evidence label="Queue pressure" evidence={queuePressure} />

    <h3>Model and effort outcomes</h3>
    {!outcomes ? <p className="private-note" role="status">Model and effort outcomes: unavailable — {unavailableCopy[modelOutcomes.evidence === "unavailable" ? modelOutcomes.reasonCode : "evidence_not_served"]}. No outcome figure is estimated here.</p>
      : <>
        <dl className="private-configuration-list">
          <div><dt>Samples</dt><dd>{outcomes.samples.toLocaleString()}</dd></div>
          <div><dt>Rework rate</dt><dd>{outcomes.reworkRate === undefined ? "Not reported" : outcomes.reworkRate.toLocaleString()}</dd></div>
          <div><dt>Reported rework rounds</dt><dd>{outcomes.reworkRounds === undefined ? "Not reported" : outcomes.reworkRounds.toLocaleString()}</dd></div>
          <div><dt>Rejection rate</dt><dd>{outcomes.rejectionRate === undefined ? "Not reported" : outcomes.rejectionRate.toLocaleString()}</dd></div>
          <div><dt>Median elapsed minutes</dt><dd>{outcomes.medianElapsedMinutes === undefined ? "Not reported" : outcomes.medianElapsedMinutes.toLocaleString()}</dd></div>
          <div><dt>Reported tokens in</dt><dd>{outcomes.inputTokens === undefined ? "Not reported" : outcomes.inputTokens.toLocaleString()}</dd></div>
          <div><dt>Reported tokens out</dt><dd>{outcomes.outputTokens === undefined ? "Not reported" : outcomes.outputTokens.toLocaleString()}</dd></div>
          <div><dt>Reported cost (micro-USD)</dt><dd>{outcomes.costMicrousd === undefined ? "Not reported" : outcomes.costMicrousd.toLocaleString()}</dd></div>
        </dl>
        <p className="private-note">{outcomes.comparable
          ? `${outcomes.samples} comparable outcomes are recorded, which meets the ${outcomes.comparableMinimum}-sample floor.`
          : `${outcomes.samples} outcome(s) are recorded, below the ${outcomes.comparableMinimum}-sample floor, so these are observations without a winner.`}</p>
        <p className="private-note">A rate is the share of counted samples that reported it. Rework rounds are the raw reported count, never an average or a scaled-up figure.</p>
        <p className="private-note">{outcomes.unreported.length === 0
          ? "Every counted sample reported each optional field."
          : `Neither reported nor comparable: ${outcomes.unreported.join(", ")}. A field only some samples report is never summarized.`}</p>
      </>}
    <p className="private-note">Cost, tokens and effort come from what workers report. Nothing here is priced, looked up or billed.</p>
  </section>;
}

/** Reads once on mount and on request; a failed read shows the unavailable panel. */
export function PrivateOperatorCapacityWorkspace({ client }: {
  client?: (input?: Parameters<typeof readOperatorCapacityViewV1>[0]) => ReturnType<typeof readOperatorCapacityViewV1>;
} = {}) {
  const read = client ?? readOperatorCapacityViewV1;
  const [view, setView] = useState<OperatorCapacityViewV1>();
  const [code, setCode] = useState<ReadFailureCode>();
  const [pending, setPending] = useState(true);
  const [refreshRequest, setRefreshRequest] = useState(0);
  // Every read takes a generation, including a retry, so a slower earlier read can
  // never overwrite a newer result and a rejected read always clears the panel.
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    const current = ++generation.current;
    setPending(true);
    setCode(undefined);
    void Promise.resolve()
      .then(() => read())
      .then(result => {
        if (!active || current !== generation.current) return;
        setPending(false);
        if (result.state === "available") { setView(result.view); setCode(undefined); }
        else { setView(undefined); setCode(result.code); }
      })
      .catch(() => {
        if (!active || current !== generation.current) return;
        setPending(false);
        setView(undefined);
        setCode("request_failed");
      });
    return () => { active = false; };
  }, [read, refreshRequest]);
  useEffect(() => {
    // The worker panel is a read-only observation. Refresh only while this
    // tab is visible so an open browser gets fresher capacity and outcome
    // evidence without creating background work or browser-side authority.
    const refreshVisible = () => { if (!document.hidden) setRefreshRequest(value => value + 1); };
    const interval = setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { clearInterval(interval); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, []);
  if (pending) return <section className="private-panel" aria-labelledby="operator-capacity-title" aria-live="polite">
    <h2 id="operator-capacity-title">Operator capacity</h2>
    <p>Reading the recorded capacity and outcome evidence.</p>
  </section>;
  return <OperatorCapacityWorkspace view={view} unavailableCode={code} onRetry={() => setRefreshRequest(value => value + 1)} />;
}
