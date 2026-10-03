import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { ownerPushLinkV1 } from "./policy";
import type { OwnerNotificationChannelV1, OwnerPushStoreV1 } from "./types";
import { deliverOwnerPushV1 } from "./delivery";

/**
 * The bounded-retry owner push dispatcher (MIG-I, plan v4.3 §2.11).
 *
 * ## What it owns
 *
 * One durable row per owner attention ITEM, in `control_owner_push_attempt_heads`
 * (0224). That row is the whole idempotence story: the primary key is
 * `(tenant_id, action_inbox_id)`, so a stall has exactly one head for its whole
 * life, and `state='delivered'` is terminal under 0225's guard. A second
 * dispatcher, a repeated loop tick, a host restart mid-send, and a second stall
 * on a DIFFERENT item all coexist without a second PUSH for any one stall --
 * with one measured exception, in the crash window described below, where the
 * provider can be handed the same event twice and the owner's browser is what
 * stops it being seen twice.
 *
 * ## What it deliberately does not own
 *
 * It never creates, resolves, or edits the attention item itself. The item is the
 * product's authority for "the owner needs to look at this"; the dispatcher only
 * records that the phone has been told. A push that cannot be delivered changes
 * the retry row and nothing else -- the Needs-you item is still there, and the
 * owner still finds it on /needs-me even if the phone never rings.
 *
 * ## Why a separate table and not 0196 / 0174
 *
 * 0196 widens the COORDINATOR outbox guard to the service-incident shape; that is
 * an internal event feed no phone ever sees, and it grants no retry metadata.
 * The 0174 delivery ledger is keyed by (subscription, dedupe_key), so it answers
 * "has this browser been handed this event", not "is this stall still waiting to
 * be retried": it has no attempt count, no next-attempt time, and no terminal
 * state. A reservation that failed against a dead push service is invisible to
 * any retry that does not consult this table.
 *
 * ## Ordering, and what a crash mid-send costs
 *
 * The claim is taken and COMMITTED before the send, so a send never happens
 * inside a transaction and a slow or dropped push endpoint cannot hold a
 * database connection or a row lock (the owner-visible failure this must not
 * have: the coordinator going unavailable because a phone did not answer).
 *
 * The cost of that ordering is a crash in the window between commit and
 * completion: the row is left 'reserved' with no `completed_at`. That is
 * recovered, not lost. `recoverStaleReservations` returns a reservation older
 * than RESERVATION_STALE_MS to 'pending' with its attempt already counted, so
 * the worst case is one extra send attempt, never a silent drop. At the attempt
 * BOUND there is no retry left to return it to, so that reservation is settled
 * instead -- delivered if the ledger proves the send, failed with a crashed
 * reason if it does not.
 *
 * ## What "one notification" does and does not mean here
 *
 * One alert per Needs-you item is the PRODUCT promise, and it is a promise about
 * what the OWNER SEES. It is not a promise that the push provider is handed the
 * event once, because no sender can keep it: `deliverOwnerPushV1` sends and
 * THEN records the delivery (delivery.ts), and a process killed between those
 * two steps leaves a provider that accepted an event and a database that does
 * not know it. The other order would be worse -- a lost alert, silently -- so
 * the ambiguity is accepted on the sender side and closed on the RECEIVER side,
 * where the service worker remembers which event tags it has already surfaced
 * and does not surface one again (see private-app/app/service-worker.js).
 *
 * So the claim this file used to make -- "Both cases converge on exactly one
 * visible notification" -- was true of everything except the window the crash
 * landed in, and said nothing about the visible half. It is stated here the way
 * it actually holds:
 *
 *  - the 0174 ledger suppresses the duplicate whenever the ledger itself
 *    reached 'delivered', so a crash after the local write costs nothing;
 *  - a crash BEFORE that write is genuinely ambiguous, and the ledger correctly
 *    re-sends, because a 'reserved' row is evidence that a send was attempted
 *    and not that one landed;
 *  - the re-sent event carries the SAME tag, and that tag is the event identity,
 *    so the receiver can recognise it as one the owner has already seen;
 *  - the item still converges on exactly one terminal head either way, and the
 *    ledger is what proves it.
 *
 * The cross-process proof of the receiver half is
 * tests/owner-push-service-worker.test.mjs; the sender half is
 * tests/owner-push-dispatch-postgres.test.ts.
 *
 * ## An item with nobody to send it to
 *
 * The interesting case is a tenant with NO subscribed browser, which is the
 * DEFAULT state of a fresh install and a state the owner can return to from
 * Settings at any time.
 *
 * Such an item is not retried and does not burn its attempt budget. The
 * dispatcher asks whether there is anybody to send to BEFORE it claims
 * anything, and when the answer is no it moves each due item's
 * `next_attempt_at` out by a bounded re-check and leaves `attempt_count` at
 * whatever it was. Nothing is reserved, no send is attempted, and no counter
 * moves -- so when the owner finally subscribes, the very next tick that finds
 * the item due delivers it.
 *
 * An earlier version claimed first and released afterwards, calling the release
 * a "refund" of the attempt. It was not a refund: 0225's guard correctly refuses
 * any UPDATE that decrements `attempt_count`, the release's own UPDATE never
 * touched the column, and `next_attempt_at` was set to now so the item was
 * re-claimed on the next tick. Eight such ticks at the production 30s interval
 * spent the whole budget in about four minutes and left the item at 'pending',
 * attempt_count=8, permanently unclaimable and never delivered -- a stuck state
 * that is neither a retry nor a failure, and that nothing in the product
 * revives. Asking first removes the question rather than papering over it.
 *
 * An item whose subscription vanishes MID-BATCH still spends its attempt, which
 * is honest and is the direction the guard is right to enforce. It cannot
 * starve, because the attempt bound in #settle turns it into a visible,
 * terminal 'failed' rather than a row nothing can claim again.
 */

/**
 * How long an item with nobody to send it to is re-checked.
 *
 * This is NOT the send backoff schedule, and deliberately not zero.
 *
 * The schedule in BACKOFF_SECONDS_V1 is for an item that has a phone and the
 * push service is refusing. An item with NO subscribed browser is in a
 * different state: nobody has to do anything wrong for it to stay that way,
 * and the owner may subscribe minutes or days from now. A short, bounded
 * re-check is right because it costs one indexed SELECT per tick, and a long
 * one is wrong because the moment the owner subscribes the item should be
 * offered, not left waiting out a four-hour step.
 *
 * What the earlier `next_attempt_at=now` cost is told once, in the class
 * comment above: it re-claimed the item on the next tick, and eight of those
 * spent the whole budget in about four minutes.
 */
const NO_SUBSCRIPTION_RECHECK_MS_V1 = 5 * 60_000;

/** Attempts per item, ever. Mirrors the CHECK on attempt_count. */
export const OWNER_PUSH_ATTEMPT_LIMIT_V1 = 8;

/**
 * Backoff before the retry that follows attempt N (1-based), in seconds.
 *
 * The first entry is NOT zero. An earlier version used a zero first step, on the
 * reasoning that the first failure deserves an immediate second try -- but the
 * loop already retries every 30 s, so a zero backoff means the backoff schedule
 * does not exist for the failure that matters most: an endpoint that has just
 * started refusing. Every entry is at least one loop interval, so "bounded
 * retry" means retrying on a schedule rather than as fast as the loop ticks.
 */
const BACKOFF_SECONDS_V1 = Object.freeze([30, 60, 300, 600, 1800, 3600, 7200, 14400]);

/**
 * A reservation older than this was left behind by a crash, not by a live
 * dispatcher. Generous compared with the send timeout: a slow push endpoint
 * must never have its reservation stolen out from under it.
 */
export const OWNER_PUSH_RESERVATION_STALE_MS_V1 = 300_000;

/** Upper bound on one claim batch, so a burst cannot hold one transaction open. */
const CLAIM_LIMIT_V1 = 64;

/**
 * Which open attention items are allowed to ring the phone.
 *
 * The rule is a property of the ITEM, not of the producer that wrote it. Before
 * (R7I-02) this list named only the three kinds the incident machinery writes --
 * `failure`, `ambiguity`, `incident` -- so the three kinds the decision machinery
 * writes were silently never pushed: the work-batch `approval`, the pipeline
 * `question`, and the `authority_expiry` item that is the one thing with a
 * DEADLINE on it. An owner could sit on an expiring authority with no phone
 * notification, having been told on the Settings page that notices ring the
 * phone.
 *
 * The general rule this implements: a decision the owner is expected to take
 * inside a window rings the phone, and so does anything that blocks work. That
 * is every kind the schema admits EXCEPT `review` and `native_session`:
 *
 *   * `approval` / `question` / `authority_expiry` are all decisions waiting on
 *     the owner. `actionInboxItemV1` renders all three as an "approval" row
 *     ("Approval needed"), so the inbox and the phone now agree on what a
 *     decision is.
 *   * `review` and `native_session` are notifications of fact, not questions,
 *     and an owner who reviews every returned result would get an unbounded
 *     stream of pushes for work that is progressing normally. They stay on
 *     /needs-me, which is where the task-attention reader (R7I-01) shows them.
 *
 * This is deliberately not "any item with an expires_at". That was the
 * narrowest reading of the finding and it is wrong in both directions: it would
 * keep pushing a deadline-free approval (the work batch, the common case) and
 * keep silent about a decision that has no expiry but still blocks a pipeline.
 *
 * `EXPIRED` items are still refused: the item's own state must be 'open', which
 * is the existing filter below and is what stops a lapsed deadline from ringing
 * the phone afterwards. The R7I-05 finding (nothing moves an open item to
 * 'expired') is NOT fixed here; this list does not make that worse, and adding a
 * deadline sweep is a separate change.
 */
const OWNER_PUSH_ADOPTED_KINDS_V1 = Object.freeze(
  ["failure", "ambiguity", "incident", "approval", "question", "authority_expiry"] as const);
type OwnerPushAdoptedKindV1 = typeof OWNER_PUSH_ADOPTED_KINDS_V1[number];
const ownerPushAdoptedKindsList = OWNER_PUSH_ADOPTED_KINDS_V1.map(kind => `'${kind}'`).join(",");

/** How many claimed items may be in flight at once. Fixed and small on purpose:
 * it is the only thing standing between a 50-item burst and a saturated pool. */
const SEND_CONCURRENCY_V1 = 8;

const safeNow = (clock: () => number): string => {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("owner_push_clock_invalid");
  return new Date(now).toISOString();
};

/** Milliseconds to wait after attempt `count` has been made. */
export function ownerPushBackoffMsV1(count: number): number {
  if (!Number.isInteger(count) || count < 1) throw new Error("owner_push_backoff_invalid");
  return (BACKOFF_SECONDS_V1[Math.min(count, BACKOFF_SECONDS_V1.length) - 1] ?? 0) * 1000;
}

/**
 * The dedupe key for one attention item. Stable for the life of the item, and
 * derived from its own id rather than a generated value, so a retry -- in this
 * process or a later one after a restart -- proposes the SAME key. That is what
 * makes the 0174 ledger suppress a duplicate send after a lost acknowledgement.
 */
export function ownerPushDedupeKeyV1(actionInboxId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/.test(actionInboxId)) throw new Error("owner_push_item_id_invalid");
  return `${OWNER_PUSH_DEDUPE_PREFIX_V1}${actionInboxId}`;
}

/**
 * The fixed prefix every Needs-you dedupe key carries.
 *
 * Exported because the SQL that SETTLES a stranded final reservation has to
 * reconstruct the same key inside the statement, and a reconstruction that
 * spelled the prefix a second time is exactly how a recovery path ends up
 * looking for evidence under a key no send ever used -- a silent "no proof,
 * therefore failed" on an item the phone actually rang. One spelling, two
 * callers.
 */
export const OWNER_PUSH_DEDUPE_PREFIX_V1 = "needs:";

/**
 * The SAME prefix, quoted for use INSIDE a SQL statement.
 *
 * The settle compares each head against the 0174 ledger by dedupe key, and that
 * key is derived from the item id -- so the statement has to build it from the
 * row's own column, which means the prefix cannot travel as a bound parameter.
 *
 * MEASURED, both ways on real PostgreSQL 17 as the production owner-web login:
 *  - passing it as `$4 = 'needs:'||h.action_inbox_id` matched NOTHING. A
 *    parameter is bound once for the whole statement, so `h` is not in scope
 *    inside it, and every head took the 'failed' branch with a 'delivered'
 *    ledger row sitting under exactly that key.
 *  - writing `h.action_inbox_id||'needs:'` put the row's column on the left of
 *    the comparison and built the key BACKWARDS, so it still matched nothing.
 *  - `d.dedupe_key='needs:'||h.action_inbox_id` -- the row's column on the RIGHT
 *    of a literal prefix, inside the correlated subquery where `h` IS in scope --
 *    is what works.
 *
 * Derived from OWNER_PUSH_DEDUPE_PREFIX_V1 rather than spelled out, because a
 * second copy of a prefix is how a recovery path ends up looking for evidence
 * under a key no send ever used: every such mismatch reads as "no proof, so
 * failed", which is a FALSE FAILURE on an item the phone actually rang.
 */
const OWNER_PUSH_DEDUPE_PREFIX_SQL_V1 = `'${OWNER_PUSH_DEDUPE_PREFIX_V1}'||`;

export type OwnerPushDispatchOutcomeV1 = Readonly<{
  actionInboxId: string;
  result: "delivered" | "no_subscription" | "retry_scheduled" | "exhausted";
  attempt: number;
  nextAttemptAt: string;
}>;

type HeadRow = {
  action_inbox_id: string;
  link: string;
  attempt_count: number | string;
  state: "pending" | "reserved" | "delivered" | "failed";
  next_attempt_at: string | Date;
  reserved_at: string | Date | null;
};

/** Only the two owner-facing destinations a Needs-you or incident push may open. */
const NEEDS_YOU_LINK = "/needs-me";

export class OwnerPushDispatcherV1 {
  constructor(private readonly input: Readonly<{
    db: DatabaseClient;
    tenantId: string;
    store: OwnerPushStoreV1;
    channel: OwnerNotificationChannelV1;
    clock?: () => number;
  }>) {
    if (!input || !input.db || typeof input.db.query !== "function" || typeof input.db.transaction !== "function"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/.test(input.tenantId)
      || !input.store || typeof input.store.list !== "function" || !input.channel
      || typeof input.channel.send !== "function") throw new Error("owner_push_dispatcher_input_invalid");
  }

  #clock(): () => number {
    return this.input.clock ?? Date.now;
  }

  /**
   * Notice open attention items that have no head yet. Idempotent: the INSERT is
   * ON CONFLICT DO NOTHING, so an item noticed by two dispatchers, or noticed
   * again on the next tick, keeps exactly the head it already has -- including
   * its original `link`, which is never rewritten.
   *
   * The kind list is interpolated from the frozen constant rather than written
   * into the SQL, so the list and the statement cannot drift apart. It carries no
   * caller value: every member is a literal from this file.
   */
  async adoptOpenAttention(limit = CLAIM_LIMIT_V1): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > CLAIM_LIMIT_V1)
      throw new Error("owner_push_limit_invalid");
    const at = safeNow(this.#clock());
    const result = await this.input.db.query(`INSERT INTO control_owner_push_attempt_heads
      (tenant_id,action_inbox_id,link,attempt_count,state,next_attempt_at,created_at,updated_at)
      SELECT i.tenant_id,i.id,$3,0,'pending',$4,$4,$4
      FROM control_action_inbox i
      WHERE i.tenant_id=$1 AND i.state='open' AND i.kind IN (${ownerPushAdoptedKindsList})
        AND NOT EXISTS (SELECT 1 FROM control_owner_push_attempt_heads h
          WHERE h.tenant_id=i.tenant_id AND h.action_inbox_id=i.id)
      ORDER BY i.created_at,i.id LIMIT $2
      ON CONFLICT DO NOTHING RETURNING action_inbox_id`, [this.input.tenantId, limit, NEEDS_YOU_LINK, at]);
    return result.rows.length;
  }

  /** The kinds this dispatcher will ring the phone for, for Settings and tests. */
  static adoptedKindsV1(): readonly OwnerPushAdoptedKindV1[] { return OWNER_PUSH_ADOPTED_KINDS_V1; }

  /**
   * Return reservations a dead dispatcher left behind to the sendable state.
   *
   * The attempt count is NOT refunded: a crash after the push service already
   * received the request has spent a real send, and a crash before it has not.
   * Which one it was is unknowable from here, and refunding would let a
   * repeatedly-crashing host retry forever. Counting it is the conservative
   * direction -- it can only ever stop earlier, never later.
   *
   * A 'failed' head is terminal and never recovered; that is what the bounded
   * retry is for.
   *
   * ## The reservation at the BOUND is a different question
   *
   * Everything below the bound is a plain retry: the claim predicate will take
   * the item again once `next_attempt_at` arrives. At the bound there is no
   * such "again" -- the column CHECK and this loop both exclude it -- so a
   * reservation stranded there has exactly one honest answer, and leaving it
   * 'reserved' is not one of them. Before this method existed for the bound
   * case, a dispatcher killed after its final claim left the head
   * 'reserved'/8 with no `completed_at` for ever: no send would ever happen,
   * no failure would ever be recorded, and `dispatch()` returned no outcomes at
   * all. The Needs-you item stayed available and its phone alert had simply
   * stopped, which is the worst of both worlds.
   *
   * So a stale reservation at the bound is SETTLED here, and settled by the
   * evidence rather than by a guess:
   *
   *  - the 0174 ledger holds a terminal 'delivered' row for this item's dedupe
   *    key, so the phone really did ring and the head becomes 'delivered';
   *  - otherwise the head becomes 'failed' with
   *    `owner_push_crashed_at_final_attempt`, which is what actually happened.
   *    It is deliberately NOT `owner_push_attempts_exhausted`, which means "the
   *    push service refused us and we ran out of tries" -- a different cause
   *    with a different remedy, and an operator told to wait for a retry that
   *    will never come would be reading a false story about their own Mac.
   *
   * The attempt count is never touched here or anywhere below: this method only
   * ever moves `state`, so a settle can neither refund an attempt nor invent
   * one, and 0225's guard would refuse either attempt.
   *
   * A closed item (the owner answered it while the dispatcher was dead) settles
   * the same way, with its own reason, because the head must still reach a
   * terminal state -- and a phone alert for an item nobody needs any more is
   * noise. The item's own `state` is the authority on that, not the head.
   *
   * Why this is here and not in `dispatch()`'s claim: a claim can only take
   * 'pending' rows, so an item stranded at 'reserved'/8 never reaches the claim
   * at all. Recovery has to run before the claim, and it already does.
   */
  async recoverStaleReservations(now = safeNow(this.#clock())): Promise<number> {
    const staleBefore = new Date(Date.parse(now) - OWNER_PUSH_RESERVATION_STALE_MS_V1).toISOString();
    // Two populations with two genuinely different answers, so two statements.
    // They are not two nets over one hole: the first is the RETRY every stranded
    // item below the bound already had, and the second is the TERMINAL settle
    // the bound makes necessary because no retry is left to run.
    const recoverable = await this.input.db.query(`UPDATE control_owner_push_attempt_heads h
      SET state='pending',reserved_at=NULL,next_attempt_at=$3,updated_at=$3
      FROM control_action_inbox i
      WHERE h.tenant_id=$1 AND h.state='reserved' AND h.reserved_at<=$2
        AND i.tenant_id=h.tenant_id AND i.id=h.action_inbox_id AND i.state='open'
        AND h.attempt_count<${OWNER_PUSH_ATTEMPT_LIMIT_V1}
      RETURNING h.action_inbox_id`, [this.input.tenantId, staleBefore, now]);
    // The bound. One statement, one decision per row, so two dispatchers
    // recovering the same stranded head cannot conclude differently about it,
    // and so the settle is a compare-and-set on `state='reserved'`: the first
    // dispatcher to reach a stranded head owns it, and every later one takes
    // nothing rather than re-settling it.
    //
    // The delivered test is the 0174 ledger's own terminal evidence, keyed by
    // the SAME dedupe key the send used. No join to the subscription table is
    // needed and none is wanted: the ledger row already references a real
    // subscription by foreign key, and a subscription that has since been
    // deleted takes its delivery rows with it -- so the evidence disappears with
    // the thing it was evidence OF, and a head with no proof is failed, never
    // claimed delivered on the strength of an absent row.
    const settled = await this.input.db.query(`UPDATE control_owner_push_attempt_heads h
      SET state=CASE WHEN (SELECT count(*) FROM owner_web_push_deliveries d
            WHERE d.tenant_id=h.tenant_id AND d.state='delivered'
              AND d.dedupe_key=${OWNER_PUSH_DEDUPE_PREFIX_SQL_V1}h.action_inbox_id)>0
          THEN 'delivered' ELSE 'failed' END,
        next_attempt_at=$3,
        reserved_at=NULL,
        completed_at=$3,
        safe_reason_code=CASE WHEN (SELECT count(*) FROM owner_web_push_deliveries d
            WHERE d.tenant_id=h.tenant_id AND d.state='delivered'
              AND d.dedupe_key=${OWNER_PUSH_DEDUPE_PREFIX_SQL_V1}h.action_inbox_id)>0
          THEN NULL
          WHEN i.state<>'open' THEN 'owner_push_item_no_longer_open'
          ELSE 'owner_push_crashed_at_final_attempt' END,
        updated_at=$3
      FROM control_action_inbox i
      WHERE h.tenant_id=$1 AND h.state='reserved' AND h.reserved_at<=$2
        AND i.tenant_id=h.tenant_id AND i.id=h.action_inbox_id
        AND h.attempt_count>=${OWNER_PUSH_ATTEMPT_LIMIT_V1}
      RETURNING h.action_inbox_id`, [this.input.tenantId, staleBefore, now]);
    return recoverable.rows.length + settled.rows.length;
  }

  /**
   * Claim the due items and send each one, one at a time, each claim already
   * committed. Returns one outcome per item examined.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes a second dispatcher safe: it takes
   * the rows nobody else holds and walks past the ones somebody else does,
   * rather than blocking behind them or, worse, sending the same item twice.
   */
  async dispatch(limit = CLAIM_LIMIT_V1): Promise<readonly OwnerPushDispatchOutcomeV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > CLAIM_LIMIT_V1)
      throw new Error("owner_push_limit_invalid");
    await this.adoptOpenAttention(limit);
    await this.recoverStaleReservations();
    const at = safeNow(this.#clock());
    // Is there anybody to send to?
    //
    // This is asked BEFORE anything is claimed, and that ordering is the whole
    // fix for the no-subscription starvation. The attempt is spent by the
    // CLAIM (`attempt_count=attempt_count+1`), and the claim is committed
    // before the send. So once an item is claimed, an attempt is spent whatever
    // the send then finds out -- and 0225's guard correctly refuses to decrement
    // it, because a decrement is indistinguishable from a caller rewinding a
    // delivered head. There is no way to learn "no subscription" without first
    // spending an attempt, unless the question is asked FIRST.
    //
    // Asking first is cheap: one read, no lock, and on a tenant with no
    // subscriptions it replaces the entire claim-then-fail cycle.
    //
    // The one thing this must not become is a snapshot the whole batch trusts:
    // `deliverOwnerPushV1` lists again per item, so a subscription that
    // disappears mid-batch is caught by the send path, not skipped here.
    if ((await this.input.store.list(this.input.tenantId)).length === 0) return await this.#deferUntilSubscribed(at);
    // The claim SELECTs and RESERVES in ONE transaction, and it is BOTH the lock
    // and the compare-and-set that make the claim exclusive.
    //
    // An earlier version selected under SKIP LOCKED, committed, and reserved in a
    // SECOND transaction -- so two dispatchers both selected the same rows, both
    // committed, and both went on to send. That was a real defect and it is
    // fixed. What the fix does NOT do is make either mechanism load bearing on
    // its own: with the reserve's own `state='pending'` in its WHERE clause, the
    // UPDATE is a compare-and-set that the lock is redundant with, and
    // mutation testing confirms it -- removing the FOR UPDATE SKIP LOCKED clause
    // leaves every test green, and removing the reserve's state test does too.
    // Both are kept because a claim that is safe for a wrong reason today can be
    // unsafe after one edit, and the two fail differently (a blocking claim under
    // a long send, versus a duplicate send under any scheduler change). That is a
    // deliberate redundancy, not two independent proofs of the same thing.
    //
    // The reservation is committed BEFORE the send so the push never happens
    // inside a transaction: a slow or dropped endpoint cannot hold a connection
    // or a row lock, which is the property that keeps a phone which never
    // answers from making the coordinator unavailable.
    //
    // Only 'pending' is claimable. A 'reserved' row belongs to a dispatcher that
    // is mid-send RIGHT NOW, and re-claiming it would be a second push for one
    // stall. A reservation abandoned by a dead dispatcher is returned to
    // 'pending' by recoverStaleReservations, which is the only path back.
    const claimed = await this.input.db.transaction(async (tx: DatabaseSession) => {
      const due = await tx.query<HeadRow>(`SELECT h.action_inbox_id,h.link,h.attempt_count,
          h.state,h.next_attempt_at,h.reserved_at
        FROM control_owner_push_attempt_heads h
        JOIN control_action_inbox i ON i.tenant_id=h.tenant_id AND i.id=h.action_inbox_id
        WHERE h.tenant_id=$1 AND h.state='pending' AND h.next_attempt_at<=$2
          AND h.attempt_count<${OWNER_PUSH_ATTEMPT_LIMIT_V1} AND i.state='open'
        ORDER BY h.next_attempt_at,h.action_inbox_id LIMIT $3
        FOR UPDATE OF h SKIP LOCKED`, [this.input.tenantId, at, limit]);
      // Reserve exactly the rows this transaction holds locked. The WHERE clause
      // repeats the state check, so a row a concurrent dispatcher claimed between
      // the SELECT and this statement is simply not taken.
      const reserved = await tx.query<HeadRow>(`UPDATE control_owner_push_attempt_heads
        SET state='reserved',attempt_count=attempt_count+1,reserved_at=$2,last_attempt_at=$2,updated_at=$2
        WHERE tenant_id=$1 AND action_inbox_id=ANY($3::text[]) AND state='pending'
        RETURNING action_inbox_id,link,attempt_count,state,next_attempt_at,reserved_at`,
      [this.input.tenantId, at, due.rows.map(row => row.action_inbox_id)]);
      return reserved.rows;
    });
    const outcomes: OwnerPushDispatchOutcomeV1[] = [];
    // Bounded concurrency, not serial. A wedged push endpoint costs one full
    // round trip per item, so sending a claimed batch one after another makes
    // the delay to the owner's phone grow with the size of the stall burst --
    // exactly when the alert matters most. The bound is small and fixed: a burst
    // of 50 against a 2s endpoint still finishes in well under a loop interval
    // per item, and a smaller bound cannot exhaust the web pool or the push
    // service's own rate limit.
    //
    // No database connection is held while any of these run. Each attempt is a
    // short reservation transaction, then a network call, then a short settle.
    const settled = new Array<OwnerPushDispatchOutcomeV1>(claimed.length);
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < claimed.length; index = next++) {
        // One shape of alert, one shape of payload. A service incident and a
        // second stall both open /needs-me, so they push the same generic title
        // and tag; which one it was stays in the database, never in the payload.
        settled[index] = await this.#attempt(claimed[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY_V1, claimed.length) }, worker));
    for (const outcome of settled) if (outcome) outcomes.push(outcome);
    return Object.freeze(outcomes);
  }

  /**
   * One item: the row is ALREADY reserved by dispatch(), so this sends outside
   * any transaction and then settles the outcome.
   */
  async #attempt(head: HeadRow): Promise<OwnerPushDispatchOutcomeV1> {
    const id = head.action_inbox_id;
    const now = safeNow(this.#clock());
    const attempt = Number(head.attempt_count);
    // A send that failed, as distinct from one that never happened. `deliverOwnerPushV1`
    // absorbs the per-subscription failure internally, so this is how the
    // difference is observed: without it, a dead push service is indistinguishable
    // from an owner who has not subscribed this browser, and the bounded retry
    // would quietly give up on a phone that is merely offline.
    let sendFailure: { statusCode: number | undefined; removed: boolean } | undefined;
    let retryAfterMs = 0;
    let deliveredCount = 0;
    let deduplicated = 0;
    try {
      // `ownerPushLinkV1` re-validates the stored link on the way out. The column
      // CHECK constrains it in the database, but a value that reached here some
      // other way must not become an open redirect on a phone.
      const link = ownerPushLinkV1(head.link);
      const result = await deliverOwnerPushV1({ tenantId: this.input.tenantId, kind: "needs_you", link,
        dedupeKey: ownerPushDedupeKeyV1(id), now, store: this.input.store, channel: this.input.channel,
        onFailure: failure => {
          // A removed phone cannot make another phone's temporary failure terminal.
          if (!sendFailure || !failure.removed) sendFailure = { statusCode: failure.statusCode, removed: failure.removed };
          retryAfterMs = Math.max(retryAfterMs, failure.retryAfterMs ?? 0);
        } });
      deliveredCount = result.delivered;
      deduplicated = result.deduplicated;
    } catch (error) {
      sendFailure = { statusCode: typeof error === "object" && error !== null && "statusCode" in error
        && typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode : undefined, removed: false };
    }
    const spent = attempt;
    const backoffUntil = new Date(Date.parse(now) + Math.max(ownerPushBackoffMsV1(spent), retryAfterMs)).toISOString();
    if ((!sendFailure || sendFailure.removed) && deliveredCount > 0) return this.#settle(id, "delivered", spent, now, null);
    if ((!sendFailure || sendFailure.removed) && deduplicated > 0)
      // The browser already holds this exact event: a send DID land for this
      // item, the acknowledgement was simply lost (the restart window above). The
      // dedupe ledger is the evidence, so this is delivered, not a retry.
      return this.#settle(id, "delivered", spent, now, null);
    if (!sendFailure) {
      // No subscription left by the time this item was sent to. The pre-claim
      // check catches the common case, so reaching here means the owner's only
      // subscription was removed (or pruned as expired) DURING this batch --
      // between the gate above and this send. There is still nothing to retry
      // and no reason to spend the bounded attempts on a phone that was never
      // going to be handed this item: the owner still has it on /needs-me.
      //
      // The attempt is NOT refunded. It was genuinely spent by the claim, and
      // 0225's guard is right to refuse a decrement: a decrement is
      // indistinguishable from a caller rewinding a delivered head, and the
      // guard has no way to tell this honest release from that attack. So the
      // honest record is "we claimed, sent to nobody, and it cost us one try",
      // and what protects the item from the old starvation is the bound below
      // -- a head at the limit becomes 'failed', which is a visible, terminal,
      // explainable state rather than a row nothing can ever claim again.
      return this.#settle(id, "deferred", spent, backoffUntil, "owner_push_no_subscription");
    }
    // 404/410: the push service reports the browser subscription is gone, and
    // `deliverOwnerPushV1` has already removed it. Retrying would reach nothing,
    // so the item stops here as permanently undeliverable rather than as a stall
    // that keeps spending attempts.
    if (sendFailure.removed) return this.#settle(id, "failed", spent, now, "owner_push_subscription_gone");
    return this.#settle(id, "retry", spent, backoffUntil, "owner_push_endpoint_unavailable");
  }

  /**
   * Write the outcome. A delivered head is terminal under 0225's guard, and the
   * bound is enforced here as well as in the column CHECK: at the limit the head
   * becomes 'failed' rather than 'pending', so a permanently broken push service
   * costs exactly ATTEMPT_LIMIT sends and then stops.
   */
  async #settle(id: string, disposition: "delivered" | "retry" | "deferred" | "failed", spent: number,
    when: string, safeReasonCode: string | null): Promise<OwnerPushDispatchOutcomeV1> {
    const terminal = disposition === "delivered" || disposition === "failed" || spent >= OWNER_PUSH_ATTEMPT_LIMIT_V1;
    const state = terminal ? (disposition === "delivered" ? "delivered" : "failed") : "pending";
    // A head that ran out of attempts records WHY it stopped trying, which is
    // the bound -- not the last individual failure. "the endpoint was
    // unavailable" is true of every retry and says nothing about the head being
    // finished, so an operator reading the ledger would be told to wait for a
    // retry that will never come. A head that stopped for a specific reason
    // (a removed subscription) keeps that reason, because it is the actionable
    // one.
    //
    // 'deferred' is a RETRY, not a distinct terminal state, and it is the one
    // case where the bound reaching the limit is the only thing that can stop
    // it: nobody was subscribed, so nothing about the item is permanently
    // undeliverable and an item that reached the bound with nobody to send it
    // is reported as exhausted exactly as a dead endpoint would be. The
    // difference is that this one cannot be reached at all through the
    // pre-claim gate -- only through a subscription that vanished mid-batch --
    // and the pre-claim gate is what makes a fresh install heal the moment the
    // owner subscribes.
    const exhausted = state === "failed" && disposition !== "failed";
    const reason = state === "failed" ? (exhausted ? "owner_push_attempts_exhausted" : safeReasonCode) : safeReasonCode;
    // Every parameter carries an explicit cast. A bare NULL placeholder carries
    // no type for PostgreSQL to resolve, and the statement fails to plan with
    // "could not determine data type of parameter" -- so the casts are load
    // bearing, not decoration.
    //
    // The caller passes the instant to write in each case: the backoff deadline
    // for a retry, the settle instant for a terminal outcome. It is passed
    // rather than recomputed here so the value written is exactly the one the
    // caller chose.
    const completedAt = terminal ? when : null;
    await this.input.db.query(`UPDATE control_owner_push_attempt_heads
      SET state=$3::text,
        next_attempt_at=$4::timestamptz,
        reserved_at=NULL,
        completed_at=$5::timestamptz,
        safe_reason_code=$6::text,
        updated_at=$7::timestamptz
      WHERE tenant_id=$1 AND action_inbox_id=$2 AND state='reserved'`,
    [this.input.tenantId, id, state, when, completedAt, reason, when]);
    return Object.freeze({ actionInboxId: id,
      result: state === "delivered" ? "delivered" : state === "failed" ? "exhausted" : "retry_scheduled",
      attempt: spent, nextAttemptAt: when });
  }

  /**
   * Push a 'pending' item's next attempt out, WITHOUT claiming it.
   *
   * This is the path an item takes on a tenant with no subscribed browser, and
   * it is deliberately the ONLY path that reaches 'no_subscription' in normal
   * operation. Two properties make it correct, and both come from what this
   * statement does not do:
   *
   * 1. It never touches `attempt_count`. The claim is what spends an attempt, and
   *    this runs before the claim. 0225's guard refuses any decrement, and this
   *    statement never asks for one -- so there is no refund to be blocked and no
   *    way for an item to burn its budget while nobody is listening. An item
   *    waiting here sits at `attempt_count=0` and stays there, which is the
   *    honest record: nothing was ever sent, and no send was ever tried.
   * 2. It only moves 'pending' rows. It writes neither `state` nor `reserved_at`
   *    nor `last_attempt_at`, so it cannot race a live send: a row another
   *    dispatcher has already reserved is invisible to it, and a row this
   *    defers is one no live send holds.
   *
   * `next_attempt_at` moves out by a bounded re-check rather than being left at
   * `now`. Leaving it at `now` is what made the old bug: the row was re-claimed
   * on the very next tick, so eight ticks at the production 30s interval burned
   * the entire budget in about four minutes.
   *
   * 0225's guard admits this statement: it changes no counter, no identity, no
   * link, and no terminal state, and its new next_attempt_at is within the
   * guard's own one-day horizon. That horizon is why the re-check is 5 minutes
   * and not 4 hours -- both are well inside it, but 5 minutes is what makes the
   * item reach the owner's phone promptly after they subscribe.
   */
  async #deferUntilSubscribed(now: string): Promise<readonly OwnerPushDispatchOutcomeV1[]> {
    const recheckAt = new Date(Date.parse(now) + NO_SUBSCRIPTION_RECHECK_MS_V1).toISOString();
    const deferred = await this.input.db.query<{ action_inbox_id: string; attempt_count: number | string }>(
      `UPDATE control_owner_push_attempt_heads
      SET next_attempt_at=$3,safe_reason_code='owner_push_no_subscription',updated_at=$4
      WHERE tenant_id=$1 AND state='pending' AND next_attempt_at<=$2
      RETURNING action_inbox_id,attempt_count`, [this.input.tenantId, now, recheckAt, now]);
    return Object.freeze(deferred.rows.map(row => Object.freeze({
      actionInboxId: row.action_inbox_id, result: "no_subscription" as const,
      // The attempt count is reported as it is in the ROW, not decremented for
      // presentation. An earlier version returned `attempt - 1` here, which was
      // cosmetic and made the outcome claim an attempt had been refunded when no
      // column said so. The returned number is now always what the database
      // holds, so it cannot be a fiction.
      attempt: Number(row.attempt_count), nextAttemptAt: recheckAt,
    })));
  }
}
