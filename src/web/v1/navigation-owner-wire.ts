import { z } from "zod";

// Stage 0 + 0b wires (Navigation + Home §3a, §3b, §4). Nothing here decides what
// is "due" or which tiles to show: those are reads, and this file only describes
// the shapes they return and the input grammar they accept.

// A page registry key (app/page-registry.ts, Stage 1). The same shape the
// database CHECKs, so a key that cannot exist in the registry is refused before
// it reaches a query. Deliberately NOT a path and NOT a URL: a chore's Done
// button walks to a page this app chose, never to a link the caller supplied.
export const pageRegistryKeySchemaV1 = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/u);

export const choreIdSchemaV1 = z.string().regex(/^chore:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

// One due chore. `dueAt` is COMPUTED at read time from cron_expression and
// last_done_at (§3b: due is computed, never stored), so it is always present and
// always honest — there is no "no due date" case to render, because a chore
// without a cadence could not be in this table.
export const dueChoreSchemaV1 = z.object({
  choreId: choreIdSchemaV1,
  title: z.string().min(1).max(180),
  // The registry key, NOT an href: the client resolves it against the registry it
  // already ships, so a stale key in the database cannot become a live link to a
  // route that no longer exists.
  targetPageKey: pageRegistryKeySchemaV1,
  // The owner's own words, echoed back. This is what §3b's "one line of why" is
  // built from, and it is why plain_schedule is stored beside the cron.
  schedule: z.string().min(1).max(120),
  // The normalized cadence. Read off `parsePlainRecurringScheduleV1` rather than
  // guessed, because a first draft asserted a two-digit minute and a bare digit
  // for day-of-week and a real cluster refused the first row a test inserted. The
  // parser emits `${minute} ${hour} * * ${dayField}` with both numbers UNPADDED,
  // and dayField "*" (every day), "1-5" (weekday) or "0".."6" (one named day). The
  // database CHECK in 0240 is the same shape, so a grammar change has to move
  // both or the insert is refused.
  cronExpression: z.string().regex(/^[0-9]{1,2} [0-9]{1,2} \* \* (\*|[1-5]|[0-6])$/u),
  timezone: z.string().min(1).max(80),
  dueAt: z.string().datetime(),
  lastDoneAt: z.string().datetime().nullable(),
  // When it will next be shown again, so the panel can say so without the client
  // re-deriving a cadence.
  nextDueAt: z.string().datetime().nullable(),
  snoozedUntil: z.string().datetime().nullable(),
}).strict();

/**
 * The "Due this week" read.
 *
 * `chores` is deliberately an ARRAY THAT MAY BE EMPTY, and the panel that renders
 * it omits itself entirely in that case (§3b's stated exception to this app's
 * empty-state convention). The API states the fact plainly; deciding not to draw a
 * section is the client's call, and this wire makes "nothing is due" and "we
 * could not read" different values rather than one.
 */
export const dueChoresSchemaV1 = z.object({
  chores: z.array(dueChoreSchemaV1).max(50),
  /** True when the owner has more due chores than the panel returned. Reported
   * rather than silently truncated: this app's standing rule is that a missing
   * signal has to be a real signal, and an invented "that is all of them" is not
   * one. The panel may still choose to hide itself (§3b) — this is about the API
   * not lying about how much it read. */
  additionalChoresOmitted: z.boolean(),
  // The one honest read-state axis this app uses: a load that failed is not a
  // load that found nothing. See LoadingState / EmptyState / UnavailableState in
  // owner-ui.tsx.
  source: z.enum(["recorded", "unavailable"]),
  observedAt: z.string().datetime(),
  // A chore is a habit with a due date. It starts no task, proposes no AI run
  // and grants no execution authority — the whole reason it is not
  // `control_recurring_rules` (0186). Stated on every read so a client cannot
  // present it as work.
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export const declareChoreSchemaV1 = z.object({
  title: z.string().min(1).max(180),
  targetPageKey: pageRegistryKeySchemaV1,
  // The owner's own cadence in the deliberately-small vocabulary 0186 already
  // parses. No cron, no timezone guess: the service parses the plain text and
  // derives both, so a caller cannot supply a cadence this app cannot explain.
  schedule: z.string().min(1).max(120),
  timezone: z.string().min(1).max(80),
}).strict();

export const choreIdRequestSchemaV1 = z.object({
  choreId: choreIdSchemaV1,
}).strict();

/**
 * Done and Snooze share one input shape and one route, because they are one act
 * with two directions: the owner saying "not now" or "not until later". Both push
 * state FORWARD, which is why the database guards (0241) refuse a decrease and
 * why a retry after a lost response is harmless.
 *
 * `until` is required for a snooze and must be absent for a Done. Both rules are
 * checked in the schema rather than in the service so the refusal is a parse
 * failure the client can act on, and so there is exactly one place that decides
 * which of the two happened.
 */
export const choreActionSchemaV1 = z.discriminatedUnion("action", [
  z.object({ action: z.literal("done"), choreId: choreIdSchemaV1 }).strict(),
  z.object({ action: z.literal("snooze"), choreId: choreIdSchemaV1,
    // A snooze must name when it ends. A snooze with no end date is indistinguishable
    // from one that is in force forever, and "forever" is not an action the panel
    // offers.
    until: z.string().datetime() }).strict(),
]);

export const choreReceiptSchemaV1 = z.object({
  chore: dueChoreSchemaV1,
  // Whether the chore is STILL DUE after the action. A Done that leaves a chore
  // due would be a silent failure the owner could not see, so the receipt says
  // it either way rather than leaving the client to re-read and compare.
  stillDue: z.boolean(),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict();

// -------------------------------------------------------------------------------------
// Stage 0b: page visits and pins.
// -------------------------------------------------------------------------------------

/**
 * The tile inputs, in the order §3a asks for them.
 *
 * `pinned` is the owner's pins in the order pinned; `recent` is the most recently
 * opened DISTINCT pages, most recent first. The read returns both and does NOT
 * merge them: the merge rule (pins first, then recent, then three fixed defaults
 * for a new install) is a UI decision about how many tiles there are and which
 * page a key resolves to, and the client already has the registry to resolve it.
 * What the database can answer honestly, and answers here, is which pages this
 * owner has pinned and which it has opened and when.
 */
export const ownerPageShortcutsSchemaV1 = z.object({
  pinned: z.array(z.object({ pageKey: pageRegistryKeySchemaV1, pinnedAt: z.string().datetime() }).strict()).max(50),
  recent: z.array(z.object({ pageKey: pageRegistryKeySchemaV1, lastOpenedAt: z.string().datetime(),
    openCount: z.number().int().min(1) }).strict()).max(50),
  /** Reported rather than silently truncated, for the same reason as
   * `additionalChoresOmitted`: the tile rule falls back to three fixed defaults
   * on an empty history, so a client that cannot tell "you have three pins" from
   * "here are fifty, there may be more" can quietly reorder the owner's Home. */
  additionalPinsOmitted: z.boolean(),
  additionalRecentOmitted: z.boolean(),
  // No history at all is a real, different state from a failed read: the first
  // says "fall back to the three defaults", the second says "we do not know".
  source: z.enum(["recorded", "unavailable"]),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict();

export const recordPageVisitSchemaV1 = z.object({
  pageKey: pageRegistryKeySchemaV1,
  // The browser's own clock, when it has one. It is a HINT, bounded by the
  // service clock: the guard in 0241 refuses a stamp more than a minute ahead of
  // the database's own clock, so a phone with a wrong clock cannot pin its page
  // to the top of the owner's Home forever by sending a year-2099 timestamp.
  openedAt: z.string().datetime().optional(),
}).strict();

export const setPagePinSchemaV1 = z.object({
  pageKey: pageRegistryKeySchemaV1,
  pinned: z.boolean(),
}).strict();

export const pageVisitReceiptSchemaV1 = z.object({
  pageKey: pageRegistryKeySchemaV1,
  lastOpenedAt: z.string().datetime(),
  openCount: z.number().int().min(1),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict();

export const pagePinReceiptSchemaV1 = z.object({
  pageKey: pageRegistryKeySchemaV1,
  // False once the owner has unpinned it. The receipt says so explicitly so a
  // toggle that raced with another tab is still readable without a re-read.
  pinned: z.boolean(),
  pinnedAt: z.string().datetime().nullable(),
  observedAt: z.string().datetime(),
  startsWork: z.literal(false),
}).strict();

export type DueChoreV1 = z.infer<typeof dueChoreSchemaV1>;
export type DueChoresV1 = z.infer<typeof dueChoresSchemaV1>;
export type OwnerPageShortcutsV1 = z.infer<typeof ownerPageShortcutsSchemaV1>;