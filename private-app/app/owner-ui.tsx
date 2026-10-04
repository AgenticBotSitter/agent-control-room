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

import { Children, isValidElement, type ReactNode } from "react";

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
 *
 * Every key below is a state some record in this repository can actually carry
 * (job/attempt states in `src/domain/v1/types.ts`, native run states in
 * `src/web/v1/task-wire.ts`, project lifecycle in `src/web/v1/project-wire.ts`,
 * lease and node states for the worker routes). That was not true before: this
 * map used to carry 25 keys of which 19 corresponded to no record state at all,
 * which made it read as a considered mapping of the domain and was not one. The
 * test in tests/owner-ui.test.tsx now asserts both directions against the
 * exported enums, so a state added there without a tone here fails the build's
 * test lane rather than silently rendering neutral.
 */
const stateTones: Readonly<Record<string, ChipTone>> = {
  // Settled and healthy.
  succeeded: "good", completed: "good", verified: "good", passed: "good",
  // `ready` is deliberately NOT mapped to "good". On a local worker row it means
  // "this pinned executable passed its startup checks", which the same row
  // immediately qualifies as "readiness not proven" — a green dot beside that
  // sentence contradicts it. A worker is a saved fact about a route, not proof
  // that a task is healthy, so it takes its tone from the caller.
  active: "good", running: "good", accepted: "good", fulfilled: "good",
  // In progress. `prepared` is the pre-dispatch plan, `dispatching` the
  // hand-off, `stopping`/`cancelling` a wind-down: all of these are the task host
  // working, not a problem.
  prepared: "busy", dispatching: "busy", stopping: "busy", starting: "busy",
  cancelling: "busy", discovered: "busy", executing: "busy", submitted: "busy",
  queued: "busy", leased: "busy", offered: "busy", claimed: "busy",
  // Waiting on the owner or the agent. A person has to look at these, so they
  // read as a warning rather than as either healthy or broken.
  proposed: "warn", pending: "warn", waiting: "warn", waiting_input: "warn",
  waiting_approval: "warn", changes_requested: "warn", paused: "warn",
  // A review target that cannot be verified yet is waiting on a person, not
  // broken, so it warns for the same reason `changes_requested` does.
  verification_blocked: "warn", revision_limit_reached: "warn",
  // Adverse. `orphaned` is an attempt that lost its worker, `interrupted` one
  // cut off mid-run, `disconnected` one whose observation went stale, and
  // `ambiguous` one whose outcome could not be established. None of them may
  // fall through to the neutral default: the whole premise of this vocabulary is
  // that a glance must not mislead, and these are exactly the states a neutral
  // grey would under-report.
  orphaned: "bad", interrupted: "bad", ambiguous: "bad", disconnected: "bad",
  blocked: "bad", failed: "bad", rejected: "bad", unavailable: "bad",
  offline: "bad", stale: "bad", superseded: "bad", denied: "bad", inconclusive: "bad",
  // Settled without anything good to report.
  cancelled: "neutral", archived: "neutral", draft: "neutral", expired: "neutral",
  revoked: "neutral", released: "neutral", retired: "neutral",
};

/** The tone for a local worker row. The route being `ready` is a saved fact about
 * a pinned executable, not evidence that anything is healthy, so it is neutral;
 * an explicitly unavailable route is bad. Anything else is left neutral rather
 * than guessed into a healthy tone. */
export function workerChipToneV1(worker: { state: string }): ChipTone {
  return worker.state === "unavailable" ? "bad" : "neutral";
}

/** The tone keys this map carries. Exported so the test lane can check the map
 * against the real enums in both directions: a real state that is not here
 * renders neutral, and a key here that no record can carry is a guess that rots. */
export function stateToneKeysV1(): readonly string[] {
  return Object.keys(stateTones);
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
 * default of 0, because "zero" is a claim the client has not made.
 *
 * Two ways to pass a count, and both render as the same trailing pill:
 *
 * 1. `count={n}` — the number. The pill is a sibling of the heading, the shape
 *    `.private-panel-heading`'s flex row is designed for.
 * 2. A `<PrivateCount>` child — how every production call site actually passes
 *    it, because the number is frequently conditional (`state === "ready"`).
 *
 * A count supplied as a child used to be rendered inside the `<h2>`, where it
 * inherited the heading's font size and stacked inline after the heading text
 * as "Running work3" instead of a count chip. Detecting the child and hoisting
 * it out is what makes the chip styling apply on the real pages. The two forms
 * are not redundant: `count` is the API the isolated component test uses, and
 * the child form is what a conditional read has to use. */
export function PanelHeading({ id, children, count }:
  { id: string; children?: React.ReactNode; count?: number }) {
  const nodes = Children.toArray(children);
  const trailing = nodes.filter(node => isPrivateCount(node));
  const heading = nodes.filter(node => !isPrivateCount(node));
  return <div className="private-panel-heading">
    <h2 id={id}>{heading}</h2>
    {typeof count === "number" ? <PrivateCount value={count} />
      : trailing.length ? trailing : null}
  </div>;
}

/** The count pill on its own, for a panel whose heading is already composed. It
 * takes the number explicitly and has no zero default, so a panel that was never
 * read shows no count rather than an invented one. */
export function PrivateCount({ value }: { value: number | string }) {
  return <span className="private-count">{value}</span>;
}

/**
 * What a count of a PAGINATED read may honestly claim (R4U-11).
 *
 * `readTaskAttention` returns one bounded page plus a `nextCursor` when more
 * exist, so `items.length` on a tenant with more attention than a page holds is
 * a specific smaller number than the truth. The owner read "25" on Home and
 * Morning while the header badge beside it said "25+" -- the same saved page,
 * presented two different ways, on two screens read side by side.
 *
 * So the rule lives here rather than as a "+" typed at each call site: the
 * honest claim is a function of the page, and three copies of that function
 * would drift exactly the way the three copies of the bug did. A complete page
 * gets NO "+", because a "+" there would claim work that does not exist.
 *
 * A cursor or an explicit omitted-record flag supplies the pagination evidence.
 * Only a count is given this treatment. A count of a non-paginated read, or of
 * anything the app did not read, keeps the plain `PrivateCount` above.
 */
export function pagedCount(count: number, more: string | boolean | null | undefined): string {
  return more ? `${count}+` : `${count}`;
}

/** Recognises a `<PrivateCount>` child so `PanelHeading` can hoist it out of the
 * heading. Matching on the component reference rather than the class name means
 * a hand-written `<span className="private-count">` is left exactly where its
 * author put it, and only the component is relocated. */
function isPrivateCount(node: ReactNode): boolean {
  return isValidElement(node) && node.type === PrivateCount;
}

/** Preserve spelling and isolate direction without letting invisible overrides alter it. */
export function OwnerName({ children }: { children: string }) {
  return <bdi>{children.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")}</bdi>;
}
