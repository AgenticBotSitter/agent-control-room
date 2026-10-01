// Stage 0 + 0b: the owner's recurring chores, page visits and page pins.
//
// Navigation + Home §9, stages 0 and 0b. Three small tables, four actions, and
// one rule that everything else follows from:
//
//   EVERY READ AND EVERY WRITE IS SCOPED TO (tenant_id, owner_identity_id),
//   with owner_identity_id taken from the authenticated session and NEVER from
//   the request body.
//
// That is the whole isolation model. The web login holds a table-wide SELECT on
// all three tables (they are declared in privateWebReadTables), so "one owner
// cannot read another's rows" is a property of the queries in this file, not of
// the grants — and the database guards in 0241 re-check the live owner grant on
// every write, so a forged owner_identity_id is refused by the database rather
// than trusted from here.
//
// DUE IS COMPUTED, NEVER STORED (§3b). `nextDueAt` is derived from
// cron_expression and last_done_at at read time, which is why the table has no
// due_at column: a stored due date is a second copy of the cadence that drifts
// the moment a chore is done, snoozed, or a clock moves.
//
// AND A CHORE STARTS NOTHING. There is no task, no proposal, no approval and no
// execution authority anywhere in this file, and every wire carries
// `startsWork: false` and `grantsExecutionAuthority: false` so that fact travels
// with the response rather than living only in a comment.

import type { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { compileCronCalendar } from "../../services/v1/cron-calendar";
import { parsePlainRecurringScheduleV1 } from "../../recurring/v1/plain-schedule";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "./access-verifier";
import { WebAccessError } from "./access-verifier";
import { WebSessionAuthority } from "./session-authority";
import {
  choreActionSchemaV1, choreIdSchemaV1, choreReceiptSchemaV1, declareChoreSchemaV1, dueChoresSchemaV1,
  ownerPageShortcutsSchemaV1, pagePinReceiptSchemaV1, pageRegistryKeySchemaV1, pageVisitReceiptSchemaV1,
  recordPageVisitSchemaV1, setPagePinSchemaV1, type DueChoreV1,
} from "./navigation-owner-wire";

const iso = (value: string | Date) => new Date(value).toISOString();

/**
 * How many rows one read may return, and how far ahead a snooze may reach.
 *
 * Both bounds are stated rather than implied. The read limit is the panel's own
 * limit (a "Due this week" line is a line, not a report), and it is enforced in
 * the query with a LIMIT so a large table cannot make the panel slow. The snooze
 * horizon is a year: long enough for "after the trip", short enough that a typo
 * cannot hide a chore for a decade, and bounded in the database as well so a
 * future-dated snooze past it is refused there too.
 */
const MAX_CHORES = 50;
const MAX_SHORTCUTS = 50;
const SNOOZE_HORIZON_MS = 366 * 86_400_000;
/** A visit older than this is not "recent" for the tile rule. */
const RECENT_WINDOW_MS = 90 * 86_400_000;

type ChoreRow = {
  chore_id: string; title: string; target_page_key: string; plain_schedule: string;
  cron_expression: string; timezone: string; owner_identity_id: string;
  last_done_at: string | Date | null; snoozed_until: string | Date | null;
  created_at: string | Date; updated_at: string | Date;
};
type VisitRow = { page_key: string; last_opened_at: string | Date; open_count: string | number };
type PinRow = { page_key: string; pinned_at: string | Date };

/**
 * The next time a cadence fires strictly after `from`, or undefined if the cron
 * can never fire again (an impossible calendar such as "31 February" as produced
 * by the pinned-library path in compileCronCalendar).
 *
 * The calendar is COMPILED PER CALL rather than cached, and that is measured
 * rather than assumed: compiling "0 9 * * 1" and stepping it once costs about
 * 0.17ms, so 50 chores cost under 10ms and a cache would be a second piece of
 * mutable state to invalidate for no measurable gain.
 */
function nextDueAt(cronExpression: string, timezone: string, from: number): Date | undefined {
  const calendar = compileCronCalendar(cronExpression, timezone);
  if (!calendar) return undefined;
  // `compileCronCalendar` returns a narrow CronCalendar on its public interface and
  // the upstream CronExpression it wraps; this is the one call that needs the
  // wider surface, so the cast is here, at the single seam, with the shape below
  // asserted rather than assumed.
  const next = (calendar as unknown as { next(date: Date): Date | undefined }).next(new Date(from));
  return next ?? undefined;
}

/**
 * A due chore, projected from a row at `nowMs`.
 *
 * `lastDoneAt IS NULL` means "never done", so the first due date is the first
 * firing of the cadence at or after the row's creation — a chore declared today
 * with a Monday cadence is not due today unless today is a Monday, which is what
 * an owner would expect and is why `created_at` rather than the epoch is the
 * floor. `nextDueAt` is the firing AFTER the one that made it due, so the panel
 * can say when it will come back without the client re-deriving the cadence.
 */
function dueAt(row: ChoreRow, nowMs: number): { dueAt: Date; nextDueAt: Date | undefined } | undefined {
  const floor = row.last_done_at ? Date.parse(iso(row.last_done_at)) : Date.parse(iso(row.created_at));
  if (!Number.isFinite(floor)) return undefined;
  // Due the instant the cadence next fires after the floor, so a chore that was
  // last done at 09:00 exactly on a Monday is not due again until next Monday.
  const due = nextDueAt(row.cron_expression, row.timezone, floor - 1);
  if (!due) return undefined;
  const next = nextDueAt(row.cron_expression, row.timezone, due.getTime());
  return { dueAt: due, nextDueAt: next };
}

function project(row: ChoreRow, nowMs: number): DueChoreV1 | undefined {
  const schedule = dueAt(row, nowMs);
  if (!schedule) return undefined;
  return {
    choreId: row.chore_id, title: row.title, targetPageKey: row.target_page_key,
    schedule: row.plain_schedule, cronExpression: row.cron_expression, timezone: row.timezone,
    dueAt: iso(schedule.dueAt), lastDoneAt: row.last_done_at ? iso(row.last_done_at) : null,
    nextDueAt: schedule.nextDueAt ? iso(schedule.nextDueAt) : null,
    snoozedUntil: row.snoozed_until ? iso(row.snoozed_until) : null,
  };
}

/** A row is IN the panel when its cadence has come round and it is not snoozed. */
function isDue(row: ChoreRow, nowMs: number): boolean {
  if (row.snoozed_until && Date.parse(iso(row.snoozed_until)) > nowMs) return false;
  const schedule = dueAt(row, nowMs);
  return !!schedule && schedule.dueAt.getTime() <= nowMs;
}

/**
 * The projection, with the one fallback that can ever be needed.
 *
 * `project` returns undefined only when the stored cadence can never fire again
 * (an impossible calendar). That is a state the service refuses to create — the
 * cron is parsed here from the owner's own words, and the grammar cannot produce
 * one — so the fallback exists for a row that predates this service or was
 * written by an operator, and it reports the row's own creation instant as the
 * due date rather than inventing a cadence or dropping the chore silently. A
 * chore disappearing from the panel because its cron is odd would be the worst
 * possible failure here: the owner would conclude they were done.
 */
function projectOrCreation(row: ChoreRow): DueChoreV1 {
  const projected = project(row, Date.parse(iso(row.created_at)));
  return projected ?? {
    choreId: row.chore_id, title: row.title, targetPageKey: row.target_page_key,
    schedule: row.plain_schedule, cronExpression: row.cron_expression, timezone: row.timezone,
    dueAt: iso(row.created_at), lastDoneAt: row.last_done_at ? iso(row.last_done_at) : null,
    nextDueAt: null, snoozedUntil: row.snoozed_until ? iso(row.snoozed_until) : null };
}

function timezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export class OwnerNavigationServiceV1 {
  readonly #authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    clock: () => number = Date.now) {
    this.#authority = new WebSessionAuthority(db, scope, clock, "navigation");
  }

  /**
   * "Due this week", newest deadline last.
   *
   * A FAILED READ IS NOT AN EMPTY LIST. If the query throws, this returns
   * `source: "unavailable"` with no chores rather than propagating an error the
   * caller would have to translate, because §3b's whole point is that the panel
   * disappears when nothing is due — and a panel that disappears because the
   * database was unreachable would tell the owner "you are done" exactly when
   * they are not. The three honest read states are `LoadingState`,
   * `EmptyState` and `UnavailableState` in owner-ui.tsx, and "unavailable" is
   * what keeps this from rendering as the first one.
   */
  async dueChores(identity: VerifiedWebIdentity): Promise<z.infer<typeof dueChoresSchemaV1>> {
    const nowMs = Date.now();
    return this.#authority.authenticated(identity, async (tx, actor) => {
      // A chore is owner-level state with no project, so the check is the
      // owner-scoped one (third argument) rather than a per-project require: a
      // partial project grant must not be able to read another owner's week.
      actor.require("projects.read", undefined, true);
      try {
        const rows = (await tx.query<ChoreRow>(`SELECT chore_id,title,target_page_key,plain_schedule,
            cron_expression,timezone,owner_identity_id,last_done_at,snoozed_until,created_at,updated_at
          FROM recurring_chores WHERE tenant_id=$1 AND owner_identity_id=$2
          ORDER BY created_at,chore_id LIMIT $3`, [this.scope.tenantId, actor.id, MAX_CHORES + 1])).rows;
        const due = rows.slice(0, MAX_CHORES).flatMap(row => {
          if (!isDue(row, nowMs)) return [];
          const projected = project(row, nowMs);
          return projected ? [projected] : [];
        }).sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.choreId.localeCompare(right.choreId));
        return dueChoresSchemaV1.parse({ chores: due, source: "recorded", observedAt: actor.now,
          startsWork: false, grantsExecutionAuthority: false });
      } catch {
        return dueChoresSchemaV1.parse({ chores: [], source: "unavailable", observedAt: actor.now,
          startsWork: false, grantsExecutionAuthority: false });
      }
    });
  }

  /**
   * Declare one of the owner's own chores.
   *
   * The cadence is parsed HERE, from the owner's own words, and both forms are
   * stored: a caller cannot supply a cron expression, a timezone it made up, or a
   * cadence this app could not explain back to them. The parsed expression is
   * checked against the same regex the database CHECKs, so a grammar change in
   * plain-schedule.ts cannot produce a row the insert would refuse.
   */
  async declareChore(identity: VerifiedWebIdentity, value: unknown) {
    const parsed = declareChoreSchemaV1.safeParse(value);
    if (!parsed.success || !timezone(parsed.data.timezone)) throw new WebAccessError("invalid_request");
    const schedule = parsePlainRecurringScheduleV1(parsed.data.schedule);
    if (!schedule) throw new WebAccessError("invalid_request");
    const nowMs = Date.now();
    try { assertNoSecretMaterial(parsed.data, "recurring chore"); }
    catch { throw new WebAccessError("invalid_request"); }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      const choreId = `chore:${crypto.randomUUID()}`;
      const row = (await tx.query<ChoreRow>(`INSERT INTO recurring_chores
        (tenant_id,chore_id,title,target_page_key,plain_schedule,cron_expression,timezone,
          owner_identity_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [this.scope.tenantId, choreId, parsed.data.title, parsed.data.targetPageKey, schedule.normalized,
        schedule.expression, parsed.data.timezone, actor.id, actor.now])).rows[0];
      if (!row) throw new Error("owner_chore_unavailable");
      // A chore that is not due yet still comes back, with its next due date, so
      // the client can show it as "not due yet" rather than as a failed declare.
      const projected = project(row, nowMs);
      return choreReceiptSchemaV1.parse({ chore: projectOrCreation(row),
        stillDue: !!projected && Date.parse(projected.dueAt) <= nowMs, observedAt: actor.now,
        startsWork: false });
    });
  }

  /**
   * Done, or Snooze.
   *
   * Both push state forward, which is what makes them retry-safe and what makes
   * a stale second tab harmless: the database guard refuses a decrease (0241), and
   * the service refuses a non-advance before the query even runs, so a caller
   * cannot be told "done" when the row did not move.
   *
   * The UPDATE is matched on (tenant, owner, chore_id) and returns nothing when it
   * does not match, which is the "not found" answer for another owner's chore
   * rather than an "access denied" one that would confirm the row exists.
   */
  async actOnChore(identity: VerifiedWebIdentity, value: unknown) {
    const parsed = choreActionSchemaV1.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const action = parsed.data;
    const nowMs = Date.now();
    if (action.action === "snooze") {
      const until = Date.parse(action.until);
      if (!Number.isFinite(until) || until <= nowMs) throw new WebAccessError("invalid_request");
      if (until > nowMs + SNOOZE_HORIZON_MS) throw new WebAccessError("invalid_request");
    }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      const current = (await tx.query<ChoreRow>(`SELECT * FROM recurring_chores
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND chore_id=$3 FOR UPDATE`,
      [this.scope.tenantId, actor.id, action.choreId])).rows[0];
      if (!current) throw new WebAccessError("not_found");
      // A second caller that already did the same thing is not an error and is
      // not a re-write: the row is returned as it stands. Refusing here would
      // make a phone's retry after a lost response look like a failure the owner
      // has to act on, when the thing they asked for already happened.
      const advancing = action.action === "done"
        ? !current.last_done_at || Date.parse(iso(current.last_done_at)) < nowMs
        : current.snoozed_until === null || Date.parse(iso(current.snoozed_until)) < nowMs;
      const row = advancing
        ? (await tx.query<ChoreRow>(action.action === "done"
          ? `UPDATE recurring_chores SET last_done_at=$1,updated_at=$1
             WHERE tenant_id=$2 AND owner_identity_id=$3 AND chore_id=$4 RETURNING *`
          : `UPDATE recurring_chores SET snoozed_until=$1,updated_at=$2
             WHERE tenant_id=$3 AND owner_identity_id=$4 AND chore_id=$5 RETURNING *`,
        action.action === "done"
          ? [actor.now, this.scope.tenantId, actor.id, action.choreId]
          : [(action as { action: "snooze"; until: string }).until, actor.now, this.scope.tenantId, actor.id,
            action.choreId])).rows[0]
        : current;
      if (!row) throw new Error("owner_chore_unavailable");
      // Read straight after the write, in the same transaction, so the receipt
      // cannot claim a chore is still due after a Done that moved it forward.
      return choreReceiptSchemaV1.parse({ chore: projectOrCreation(row), stillDue: isDue(row, nowMs),
        observedAt: actor.now, startsWork: false });
    });
  }

  /**
   * Pins and recent pages, each already ordered by the read that will use it.
   *
   * NOT merged, and not filtered down to three: §3a's merge rule needs the
   * registry to resolve a key to a page and needs to know which pages are
   * distinct top-level entries, and the client has both. What the database can
   * answer without guessing is what this owner has pinned, in what order, and
   * what it has opened and when — so that is all this returns.
   */
  async shortcuts(identity: VerifiedWebIdentity) {
    const nowMs = Date.now();
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      try {
        const pinned = (await tx.query<PinRow>(`SELECT page_key,pinned_at FROM page_pins
          WHERE tenant_id=$1 AND owner_identity_id=$2 ORDER BY pinned_at,page_key LIMIT $3`,
        [this.scope.tenantId, actor.id, MAX_SHORTCUTS])).rows;
        // The window is applied in the query rather than in the projection, so
        // the index does the work: a page last opened a year ago is not "recent"
        // and must not occupy one of the fifty slots a real recent page needs.
        const recent = (await tx.query<VisitRow>(`SELECT page_key,last_opened_at,open_count FROM page_visits
          WHERE tenant_id=$1 AND owner_identity_id=$2
            AND last_opened_at > $3::timestamptz - make_interval(secs => $4::double precision / 1000)
          ORDER BY last_opened_at DESC,page_key LIMIT $5`,
        [this.scope.tenantId, actor.id, actor.now, RECENT_WINDOW_MS, MAX_SHORTCUTS])).rows;
        return ownerPageShortcutsSchemaV1.parse({
          pinned: pinned.map(row => ({ pageKey: row.page_key, pinnedAt: iso(row.pinned_at) })),
          recent: recent.map(row => ({ pageKey: row.page_key, lastOpenedAt: iso(row.last_opened_at),
            openCount: Number(row.open_count) })),
          source: "recorded", observedAt: actor.now, startsWork: false });
      } catch {
        return ownerPageShortcutsSchemaV1.parse({ pinned: [], recent: [], source: "unavailable",
          observedAt: actor.now, startsWork: false });
      }
    });
  }

  /**
   * Record one page open. Fire-and-forget by design (§3a: a tiny POST from the
   * header, the one place every page already mounts).
   *
   * Both fields move FORWARD and never back: GREATEST on the upsert, plus the
   * 0241 guard refusing a decrease outright. That is what makes a retry from a
   * tab whose response was lost harmless — the second write is a no-op rather
   * than a rewind of the owner's own recency order.
   *
   * `openedAt` is a bounded HINT. It is clamped to the service clock's own now,
   * never trusted forward: a phone with a clock a year fast must not be able to
   * pin one page to the top of Home for a year by sending it on every load.
   */
  async recordVisit(identity: VerifiedWebIdentity, value: unknown) {
    const parsed = recordPageVisitSchemaV1.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const nowMs = Date.now();
    const hint = parsed.data.openedAt === undefined ? nowMs : Date.parse(parsed.data.openedAt);
    if (!Number.isFinite(hint)) throw new WebAccessError("invalid_request");
    // A hint up to a minute ahead is tolerated, matching the guard's own bound;
    // anything further ahead is refused rather than silently rewritten, because a
    // caller sending one deserves to know its clock is wrong.
    if (hint > nowMs + 60_000) throw new WebAccessError("invalid_request");
    const openedAt = new Date(Math.min(hint, nowMs)).toISOString();
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      const row = (await tx.query<VisitRow>(`INSERT INTO page_visits
        (tenant_id,owner_identity_id,page_key,last_opened_at,open_count,updated_at)
        VALUES($1,$2,$3,$4,1,$4)
        ON CONFLICT (tenant_id,owner_identity_id,page_key) DO UPDATE SET
          last_opened_at=GREATEST(page_visits.last_opened_at,EXCLUDED.last_opened_at),
          open_count=page_visits.open_count+1,
          updated_at=GREATEST(page_visits.updated_at,EXCLUDED.updated_at)
        RETURNING page_key,last_opened_at,open_count`,
      [this.scope.tenantId, actor.id, parsed.data.pageKey, openedAt])).rows[0];
      if (!row) throw new Error("owner_page_visit_unavailable");
      return pageVisitReceiptSchemaV1.parse({ pageKey: row.page_key, lastOpenedAt: iso(row.last_opened_at),
        openCount: Number(row.open_count), observedAt: actor.now, startsWork: false });
    });
  }

  /**
   * Pin or unpin one page.
   *
   * A pin that already exists and is pinned AGAIN moves to the back of the
   * owner's own order, because "pin this" on an already-pinned page is the
   * obvious way an owner reorders by hand and there is no other spelling for it.
   * Unpin deletes exactly this owner's row for exactly this page.
   */
  async setPin(identity: VerifiedWebIdentity, value: unknown) {
    const parsed = setPagePinSchemaV1.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", undefined, true);
      if (!parsed.data.pinned) {
        await tx.query(`DELETE FROM page_pins WHERE tenant_id=$1 AND owner_identity_id=$2 AND page_key=$3`,
          [this.scope.tenantId, actor.id, parsed.data.pageKey]);
        return pagePinReceiptSchemaV1.parse({ pageKey: parsed.data.pageKey, pinned: false, pinnedAt: null,
          observedAt: actor.now, startsWork: false });
      }
      const row = (await tx.query<PinRow>(`INSERT INTO page_pins
        (tenant_id,owner_identity_id,page_key,pinned_at,updated_at) VALUES($1,$2,$3,$4,$4)
        ON CONFLICT (tenant_id,owner_identity_id,page_key) DO UPDATE SET pinned_at=EXCLUDED.pinned_at,
          updated_at=EXCLUDED.updated_at RETURNING page_key,pinned_at`,
      [this.scope.tenantId, actor.id, parsed.data.pageKey, actor.now])).rows[0];
      if (!row) throw new Error("owner_page_pin_unavailable");
      return pagePinReceiptSchemaV1.parse({ pageKey: row.page_key, pinned: true, pinnedAt: iso(row.pinned_at),
        observedAt: actor.now, startsWork: false });
    });
  }
}

// A digest helper for the "did this change" question the mutation checks ask, kept
// next to the shapes it covers so a test cannot drift onto a different projection.
export const ownerNavigationRowDigestV1 = (row: Pick<ChoreRow, "chore_id" | "title" | "target_page_key" |
  "plain_schedule" | "cron_expression" | "timezone" | "last_done_at" | "snoozed_until">) =>
  sha256Digest({ schema: "control-room.owner-navigation-row/v1", choreId: row.chore_id, title: row.title,
    targetPageKey: row.target_page_key, schedule: row.plain_schedule, cron: row.cron_expression,
    timezone: row.timezone, lastDoneAt: row.last_done_at ? iso(row.last_done_at) : null,
    snoozedUntil: row.snoozed_until ? iso(row.snoozed_until) : null });

// Re-exported so a test can build a valid id without duplicating the regex, and
// so the grammar has exactly one definition in the tree.
export const ownerChoreIdV1 = (): string => `chore:${crypto.randomUUID()}`;
export { choreIdSchemaV1, pageRegistryKeySchemaV1 };
export type { ChoreRow };