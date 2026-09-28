/**
 * Shared owner-interface vocabulary: state chips and the three read outcomes.
 *
 * The pages already modelled their reads honestly — `loading`, `ready` and
 * `unavailable` are literal in the browser-client types, and the copy is careful
 * to say "this is not an all-clear" when a read came back empty. What was missing
 * was the visual half of that honesty: empty and unavailable were the same grey
 * text on the same card, so a glance could not tell a checked nothing from an
 * unchecked anything.
 *
 * These components are presentation only. They render what they are given, add no
 * data, and never infer a count or a state the caller did not read.
 */

/** Tones map to the existing state tokens. Every value here is used together
 * with its text label, so the tone is an aid and never the only carrier of
 * meaning. */
export type ChipTone = "neutral" | "good" | "warn" | "bad" | "busy";

/**
 * Rendered states that mean "this is working" as opposed to "this is not".
 * These are the values the real task and project records actually carry; an
 * unrecognised value falls through to the neutral tone rather than being
 * guessed into a good/bad tone, so a new backend state can never be misreported
 * as healthy.
 */
const stateTones: Readonly<Record<string, ChipTone>> = {
  // Settled and healthy.
  succeeded: "good", completed: "good", verified: "good", passed: "good",
  // `ready` is deliberately NOT mapped to "good". On a local worker row it means
  // "this pinned executable passed its startup checks", which the same row
  // immediately qualifies as "readiness not proven" — a green dot beside that
  // sentence contradicts it. A worker is a saved fact about a route, not proof
  // that a task is healthy, so it takes its tone from the caller.
  active: "good", running: "good", accepted: "good",
  // In progress.
  starting: "busy", submitting: "busy", preparing: "busy",
  assigned: "busy", queued: "busy", proposed: "warn", pending: "warn",
  // Needs the owner.
  changes_requested: "warn", awaiting_review: "warn", paused: "warn",
  blocked: "bad", failed: "bad", rejected: "bad", unavailable: "bad",
  offline: "bad", stale: "bad", superseded: "bad", archived: "neutral",
  cancelled: "neutral", draft: "neutral",
};

/** The tone for a local worker row. The route being `ready` is a saved fact about
 * a pinned executable, not evidence that anything is healthy, so it is neutral;
 * an explicitly unavailable route is bad. Anything else is left neutral rather
 * than guessed into a healthy tone. */
export function workerChipToneV1(worker: { state: string }): ChipTone {
  return worker.state === "unavailable" ? "bad" : "neutral";
}

export function chipToneForStateV1(state: string): ChipTone {
  return stateTones[state] ?? "neutral";
}

/** Human-readable form of a canonical state, matching the existing page copy
 * (`state.replaceAll("_", " ")`) so adopting a chip does not change any string an
 * existing test asserts on. */
export function stateLabelV1(state: string): string {
  return state.replaceAll("_", " ");
}

export function StateChip({ state, tone, label }: { state: string; tone?: ChipTone; label?: string }) {
  const resolved = tone ?? chipToneForStateV1(state);
  // The chip also carries .private-state. That class used to be the task's own
  // state label in the task-detail panel, and the owner journey selects
  // `.private-task-detail .private-state` to read the task state — so the chip
  // keeps the hook rather than the journey's selector being rewritten to follow
  // this refactor. Anything that is prose about a state is given its own class
  // instead (see the route-observation panel).
  return <span className={`private-state ${resolved === "neutral" ? "private-chip" : `private-chip is-${resolved}`}`}>
    {label ?? stateLabelV1(state)}</span>;
}

/**
 * The three read outcomes, as three visibly different things.
 *
 * `Unavailable` is deliberately the loudest of the three: it is the only one that
 * means "the Control Room could not check". It never renders a count, a dash or
 * a zero, because the app has no read that would justify one.
 */
export function LoadingState({ children }: { children?: React.ReactNode }) {
  return <p className="private-state-loading" role="status">
    {children ?? "Loading saved data…"}</p>;
}

export function EmptyState({ children }: { children?: React.ReactNode }) {
  return <p className="private-state-empty">{children ?? "Nothing is recorded in this checked view."}</p>;
}

export function UnavailableState({ children, urgent }: { children?: React.ReactNode; urgent?: boolean }) {
  // `urgent` keeps role="alert" for the case where the read failed and the owner
  // must be interrupted, versus a panel that merely reports one section as
  // unreadable alongside others. Downgrading an alert to a polite status region
  // would be a behaviour change, so it is opt-in rather than automatic.
  return <p className="private-state-unavailable" role={urgent ? "alert" : "status"}>
    {children ?? "This could not be read. No count or all-clear is inferred."}</p>;
}

/** A panel heading with an optional trailing count. The count is rendered only
 * when the caller has a real number from a real read; there is deliberately no
 * default of 0, because "zero" is a claim the client has not made. */
export function PanelHeading({ id, children, count }:
  { id: string; children: React.ReactNode; count?: number }) {
  return <div className="private-panel-heading">
    <h2 id={id}>{children}</h2>
    {typeof count === "number" ? <span className="private-count">{count}</span> : null}
  </div>;
}

/** The count pill on its own, for a panel whose heading is already composed. It
 * takes the number explicitly and has no zero default, so a panel that was never
 * read shows no count rather than an invented one. */
export function PrivateCount({ value }: { value: number }) {
  return <span className="private-count">{value}</span>;
}
