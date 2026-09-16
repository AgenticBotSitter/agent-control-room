"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { readScheduleStatus } from "../../src/schedules/browser-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import type { ProjectScheduleStatus, ScheduleStatus } from "../../src/schedules/status-wire";
import { ConfiguredTimestamp, formatConfiguredTimestamp } from "./configured-timestamp";
import { useProductConfiguration } from "./product-configuration";

type State =
  | { state: "loading" }
  | { state: "unavailable"; code: string; message: string; projectId: string }
  | { state: "ready"; value: ProjectScheduleStatus };

const fallbackTimezone = "UTC";

const nextReasonCopy: Record<ScheduleStatus["nextReason"], string> = {
  calculated: "Calculated next occurrence",
  paused: "Paused — no next occurrence is calculated.",
  disabled: "Disabled — no next occurrence is calculated.",
  anchor_unavailable: "Next occurrence unavailable: no interval anchor is recorded.",
  invalid_schedule: "Next occurrence unavailable: the saved definition or timezone is invalid.",
  range_too_large: "Next occurrence unavailable: the calculation window exceeds 31 days.",
  none_in_window: "No occurrence found in the displayed calculation window. Later work is unknown.",
};

const stateCopy: Record<ScheduleStatus["state"], string> = {
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
};

const requestFailureCopy = (code: string): { heading: string; detail: string; action: string } => {
  if (code === "authentication_required") {
    return {
      heading: "Your session has ended.",
      detail: "Sign in again to read this project’s schedules. Older occurrences remain in the project log; nothing has been removed.",
      action: "Sign in and retry",
    };
  }
  if (code === "access_denied") {
    return {
      heading: "You do not have access to this project’s schedules.",
      detail: "Ask the project owner to grant scheduling access, then return here.",
      action: "Retry",
    };
  }
  if (code === "not_found") {
    return {
      heading: "This project’s schedules are not available.",
      detail: "The project may have been closed, moved, or the schedules have not been recorded yet.",
      action: "Retry",
    };
  }
  return {
    heading: browserErrorMessage.unavailable,
    detail: "Older occurrences remain in the project log; nothing has been replaced with sample data. Retry to ask the server again.",
    action: "Retry",
  };
};

function renderInTimezone(value: string, timezone: string) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(instant);
}

/**
 * Render an instant formatted in the *saved* schedule timezone, with the
 * product display timezone disclosed separately when the two differ. This
 * keeps each label truthful — the saved-tz string never describes a wall-clock
 * value rendered in a different zone.
 */
function SavedTimezoneTimestamp({ value, timezone, prefix }: { value: string; timezone: string; prefix?: string }) {
  const configured = useProductConfiguration()?.defaultTimezone ?? fallbackTimezone;
  const formattedInSaved = renderInTimezone(value, timezone);
  const formattedInDisplay = timezone === configured ? null : renderInTimezone(value, configured);
  const headerLabel = `${timezone} · ${formattedInSaved}`;
  const displayNote = formattedInDisplay ? <span className="private-note"> ({configured}: {formattedInDisplay})</span> : null;
  return <time dateTime={value} title={`${headerLabel}${formattedInDisplay ? ` | ${configured} ${formattedInDisplay}` : ""}`} suppressHydrationWarning>
    {prefix ? `${prefix} ` : ""}{headerLabel}{displayNote}
  </time>;
}

function OccurrenceLine({ scheduledFor, timezone, occurrenceState, pastDue }: {
  scheduledFor: string; timezone: string; occurrenceState: "pending" | "dispatched" | "cancelled"; pastDue: boolean;
}) {
  const label = occurrenceState === "dispatched"
    ? "Delivery recorded — execution unverified"
    : occurrenceState === "cancelled"
      ? "Cancelled occurrence"
      : pastDue
        ? "Pending past its scheduled time — execution unknown"
        : "Pending occurrence";
  return <li>
    <SavedTimezoneTimestamp value={scheduledFor} timezone={timezone} prefix="saved" /> — {label}
  </li>;
}

function ScheduleCard({ schedule }: { schedule: ProjectScheduleStatus["schedules"][number] }) {
  const hasOccurrences = schedule.occurrences.length > 0;
  const [open, setOpen] = useState(hasOccurrences && schedule.occurrences.length <= 3);
  return <article className="private-schedule-card">
    <h3>{schedule.scheduleId}</h3>
    <p className="private-schedule-state">
      <span className={`private-state private-state--${schedule.state}`}>{stateCopy[schedule.state]}</span>
      <span aria-hidden="true"> · </span>
      <span>{schedule.scheduleType}</span>
    </p>
    <p data-field="timezone">Saved timezone: <code>{schedule.timezone}</code></p>
    <p data-field="next-reason">{nextReasonCopy[schedule.nextReason]}{
      schedule.nextOccurrenceAt ? <>: <SavedTimezoneTimestamp value={schedule.nextOccurrenceAt} timezone={schedule.timezone} /></> : null
    }</p>
    {hasOccurrences
      ? <details open={open} onToggle={event => setOpen((event.target as HTMLDetailsElement).open)}>
          <summary>{open ? "Hide" : "Show"} retained occurrences ({schedule.occurrences.length}{schedule.additionalOccurrencesOmitted ? " most recent" : ""})</summary>
          <ul>
            {schedule.occurrences.map(item => <OccurrenceLine key={item.occurrenceKey}
              scheduledFor={item.scheduledFor} timezone={schedule.timezone}
              occurrenceState={item.state} pastDue={item.pastDue} />)}
          </ul>
          {schedule.additionalOccurrencesOmitted
            ? <p className="private-note">Older occurrence records are omitted from this bounded view.</p>
            : null}
        </details>
      : <p className="private-note">No retained occurrences are recorded for this schedule.</p>}
  </article>;
}

export function ScheduleStatusView({ state, projectId, onRetry }: {
  state: State; projectId: string; onRetry?: () => void;
}) {
  const configured = useProductConfiguration()?.defaultTimezone ?? fallbackTimezone;
  const formattedWindow = useMemo(() => {
    if (state.state !== "ready") return null;
    return {
      observed: formatConfiguredTimestamp(state.value.observedAt, configured),
      ends: formatConfiguredTimestamp(state.value.windowEndsAt, configured),
    };
  }, [state, configured]);

  if (state.state === "loading") {
    return <section className="private-panel" aria-busy="true">
      <h2>Project schedules</h2>
      <p>Read-only forecasts and retained occurrence records. This page does not enable automatic work.</p>
      <p role="status">Loading this project’s schedules…</p>
    </section>;
  }

  if (state.state === "unavailable") {
    const failure = requestFailureCopy(state.code);
    return <section className="private-panel private-panel--warning" role="alert">
      <h2>Project schedules</h2>
      <p>Read-only forecasts and retained occurrence records. This page does not enable automatic work.</p>
      <p className="private-schedule-failure-heading">{failure.heading}</p>
      <p className="private-note">{failure.detail}</p>
      {onRetry ? <p><button type="button" onClick={onRetry}>{failure.action}</button></p> : null}
      <p className="private-note">Older occurrences remain in the project log; nothing has been removed or replaced with sample data.</p>
    </section>;
  }

  const value = state.value;
  if (value.projectId !== projectId) {
    return <section className="private-panel" role="alert">
      <h2>Project schedules</h2>
      <p>Schedule status is unavailable. No empty schedule list or missed-work conclusion is inferred.</p>
    </section>;
  }

  return <section className="private-panel">
    <h2>Project schedules</h2>
    <p>Read-only forecasts and retained occurrence records. This page does not enable automatic work.</p>
    {formattedWindow
      ? <p className="private-schedule-freshness">
          Calculation window: <ConfiguredTimestamp value={value.observedAt} prefix="from" />
          {" "}to <ConfiguredTimestamp value={value.windowEndsAt} prefix="until" />
          {" "}({configured}).
        </p>
      : null}
    {!value.schedules.length ? <p>No schedules are recorded for this project.</p> : null}
    {value.schedules.map(schedule => <ScheduleCard key={schedule.scheduleId} schedule={schedule} />)}
    {value.additionalSchedulesOmitted ? <p className="private-note">Additional schedules are omitted from this bounded view.</p> : null}
    <p className="private-note">Retained occurrences may belong to an earlier definition. A cancelled occurrence does not cancel the schedule; a forecast is not an admitted task. Delivery records do not prove execution or completion.</p>
  </section>;
}

function codeFor(error: unknown): string {
  if (error instanceof BrowserRequestError) return error.code;
  return "unavailable";
}

export function ProjectScheduleStatusPanel({ projectId }: { projectId: string }) {
  const [retained, setState] = useState<{ projectId: string; state: State }>({ projectId, state: { state: "loading" } });
  const [generation, refresh] = useState(0);
  const lastAnnouncementRef = useRef<{ observedAt: string; generation: number } | null>(null);
  const [announcement, setAnnouncement] = useState<string>("");

  useEffect(() => {
    const abort = new AbortController();
    setState({ projectId, state: { state: "loading" } });
    void readScheduleStatus(projectId, fetch, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      setState({ projectId, state: { state: "ready", value } });
      if (lastAnnouncementRef.current?.observedAt !== value.observedAt) {
        lastAnnouncementRef.current = { observedAt: value.observedAt, generation };
        setAnnouncement(`Schedules refreshed at ${value.observedAt}.`);
      }
    }, (error: unknown) => {
      if (abort.signal.aborted) return;
      const code = codeFor(error);
      const message = browserErrorMessage[code as keyof typeof browserErrorMessage] ?? browserErrorMessage.unavailable;
      setState({ projectId, state: { state: "unavailable", code, message, projectId } });
      setAnnouncement(`Schedule refresh failed: ${message}`);
    });
    return () => abort.abort();
  }, [projectId, generation]);

  const viewState: State = retained.projectId === projectId ? retained.state : { state: "loading" };
  const isLoading = viewState.state === "loading";

  return <>
    <ScheduleStatusView state={viewState} projectId={projectId} onRetry={isLoading ? undefined : () => refresh(value => value + 1)} />
    <div className="private-actions">
      <button type="button" onClick={() => refresh(value => value + 1)} disabled={isLoading} aria-busy={isLoading}>
        {isLoading ? "Refreshing…" : "Refresh schedule status"}
      </button>
      <p className="private-note" role="status" aria-live="polite">{announcement}</p>
    </div>
  </>;
}
