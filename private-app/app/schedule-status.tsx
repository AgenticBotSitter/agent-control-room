"use client";
import { useEffect, useState } from "react";
import { readScheduleStatus } from "../../src/schedules/browser-client";
import type { ProjectScheduleStatus, ScheduleStatus } from "../../src/schedules/status-wire";

type State = { state: "loading" } | { state: "unavailable" } | { state: "ready"; value: ProjectScheduleStatus };
const reason: Record<ScheduleStatus["nextReason"], string> = {
  calculated: "Calculated next occurrence", paused: "Paused — no next occurrence is calculated.",
  disabled: "Disabled — no next occurrence is calculated.", anchor_unavailable: "Next occurrence unavailable: no interval anchor is recorded.",
  invalid_schedule: "Next occurrence unavailable: the saved definition or timezone is invalid.",
  range_too_large: "Next occurrence unavailable: the calculation window exceeds 31 days.",
  none_in_window: "No occurrence found in the displayed calculation window. Later work is unknown.",
};
function ScheduleTime({ value, timezone }: { value: string; timezone: string }) {
  let label = value;
  try { label = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
  catch { /* UTC value remains honest when a saved timezone is invalid. */ }
  return <time dateTime={value}>{label}</time>;
}
export function ScheduleStatusView({ state, projectId }: { state: State; projectId: string }) {
  return <section className="private-panel"><h2>Project schedules</h2>
    <p>Read-only forecasts and retained occurrence records. This page does not enable automatic work.</p>
    {state.state === "loading" ? <p role="status">Loading this project’s schedules…</p>
      : state.state === "unavailable" || state.value.projectId !== projectId
        ? <p role="alert">Schedule status is unavailable. No empty schedule list or missed-work conclusion is inferred.</p>
        : <>
          <p>Calculation window: {state.value.observedAt} to {state.value.windowEndsAt} (UTC).</p>
          {!state.value.schedules.length && <p>No schedules are recorded for this project.</p>}
          {state.value.schedules.map(schedule => <article key={schedule.scheduleId}>
            <h3>{schedule.scheduleId}</h3>
            <p>{schedule.state} · {schedule.scheduleType} · Timezone: {schedule.timezone}</p>
            <p>{reason[schedule.nextReason]}{schedule.nextOccurrenceAt && <>: <ScheduleTime value={schedule.nextOccurrenceAt} timezone={schedule.timezone} /></>}</p>
            {schedule.occurrences.length ? <ul>{schedule.occurrences.map(item => <li key={item.occurrenceKey}>
              <ScheduleTime value={item.scheduledFor} timezone={schedule.timezone} /> — {item.state === "dispatched"
                ? "Delivery recorded — execution unverified" : item.state === "cancelled" ? "Cancelled occurrence"
                  : item.pastDue ? "Pending past its scheduled time — execution unknown" : "Pending occurrence"}
            </li>)}</ul> : <p>No retained occurrences are recorded for this schedule.</p>}
            {schedule.additionalOccurrencesOmitted && <p>Older occurrence records are omitted.</p>}
          </article>)}
          {state.value.additionalSchedulesOmitted && <p>Additional schedules are omitted from this bounded view.</p>}
          <p className="private-note">Retained occurrences may belong to an earlier definition. A cancelled occurrence does not cancel the schedule; a forecast is not an admitted task. Delivery records do not prove execution or completion.</p>
        </>}
  </section>;
}
export function ProjectScheduleStatusPanel({ projectId }: { projectId: string }) {
  const [retained, setState] = useState<{ projectId: string; state: State }>({ projectId, state: { state: "loading" } });
  const [generation, refresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setState({ projectId, state: { state: "loading" } });
    void readScheduleStatus(projectId, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ projectId, state: { state: "ready", value } });
    }, () => { if (!abort.signal.aborted) setState({ projectId, state: { state: "unavailable" } }); });
    return () => abort.abort();
  }, [projectId, generation]);
  return <><ScheduleStatusView projectId={projectId} state={retained.projectId === projectId ? retained.state : { state: "loading" }} />
    <button type="button" onClick={() => refresh(value => value + 1)}>Refresh schedule status</button></>;
}
