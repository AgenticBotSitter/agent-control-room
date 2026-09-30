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
 * on a DIFFERENT item all coexist without a second push for any one stall.
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
 * than RESERVATION_STALE_MS to 'pending' with its attempt already counted, so the
 * worst case is one extra send attempt, never a silent drop. The 0174 ledger's
 * own per-subscription dedupe key is what keeps that extra attempt from becoming
 * a second visible notification: the same item maps to the same dedupe key, so a
 * push service that already received it refuses the repeat.
 */

/** Attempts per item, ever. Mirrors the CHECK on attempt_count. */
export const OWNER_PUSH_ATTEMPT_LIMIT_V1 = 8;

/** Backoff before attempt N (1-based), in seconds. Capped at ATTEMPT_LIMIT. */
const BACKOFF_SECONDS_V1 = Object.freeze([0, 30, 60, 300, 600, 1800, 3600, 7200]);

/**
 * A reservation older than this was left behind by a crash, not by a live
 * dispatcher. Generous compared with the send timeout: a slow push endpoint
 * must never have its reservation stolen out from under it.
 */
export const OWNER_PUSH_RESERVATION_STALE_MS_V1 = 300_000;

/** Upper bound on one claim batch, so a burst cannot hold one transaction open. */
const CLAIM_LIMIT_V1 = 64;

const iso = (value: string | Date) => new Date(value).toISOString();

function safeNow(clock: () => number): string {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("owner_push_clock_invalid");
  return new Date(now).toISOString();
}

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
  return `needs:${actionInboxId}`;
}

export type OwnerPushDispatchOutcomeV1 = Readonly<{
  actionInboxId: string;
  result: "delivered" | "no_subscription" | "retry_scheduled" | "exhausted" | "claimed_by_another";
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
   */
  async adoptOpenAttention(limit = CLAIM_LIMIT_V1): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > CLAIM_LIMIT_V1)
      throw new Error("owner_push_limit_invalid");
    const at = safeNow(this.#clock());
    const result = await this.input.db.query(`INSERT INTO control_owner_push_attempt_heads
      (tenant_id,action_inbox_id,link,attempt_count,state,next_attempt_at,created_at,updated_at)
      SELECT i.tenant_id,i.id,$3,0,'pending',$4,$4,$4
      FROM control_action_inbox i
      WHERE i.tenant_id=$1 AND i.state='open' AND i.kind IN ('failure','ambiguity','incident')
        AND NOT EXISTS (SELECT 1 FROM control_owner_push_attempt_heads h
          WHERE h.tenant_id=i.tenant_id AND h.action_inbox_id=i.id)
      ORDER BY i.created_at,i.id LIMIT $2
      ON CONFLICT DO NOTHING RETURNING action_inbox_id`, [this.input.tenantId, limit, NEEDS_YOU_LINK, at]);
    return result.rows.length;
  }

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
   */
  async recoverStaleReservations(now = safeNow(this.#clock())): Promise<number> {
    const staleBefore = new Date(Date.parse(now) - OWNER_PUSH_RESERVATION_STALE_MS_V1).toISOString();
    const result = await this.input.db.query(`UPDATE control_owner_push_attempt_heads h
      SET state='pending',reserved_at=NULL,next_attempt_at=$3,updated_at=$3
      FROM control_action_inbox i
      WHERE h.tenant_id=$1 AND h.state='reserved' AND h.reserved_at<=$2
        AND i.tenant_id=h.tenant_id AND i.id=h.action_inbox_id AND i.state='open'
        AND h.attempt_count<${OWNER_PUSH_ATTEMPT_LIMIT_V1}
      RETURNING h.action_inbox_id`, [this.input.tenantId, staleBefore, now]);
    return result.rows.length;
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
    // The claim is a bounded read of the due, undelivered, still-open items.
    // SKIP LOCKED is the whole multi-dispatcher story: it takes the rows nobody
    // else holds and walks past the ones somebody else does, instead of blocking
    // behind them or, worse, letting both send the same item.
    const claimed = await this.input.db.transaction(async (tx: DatabaseSession) => {
      const due = await tx.query<HeadRow>(`SELECT h.action_inbox_id,h.link,
          h.attempt_count,h.state,h.next_attempt_at,h.reserved_at
        FROM control_owner_push_attempt_heads h
        JOIN control_action_inbox i ON i.tenant_id=h.tenant_id AND i.id=h.action_inbox_id
        WHERE h.tenant_id=$1 AND h.state IN ('pending','reserved') AND h.next_attempt_at<=$2
          AND h.attempt_count<${OWNER_PUSH_ATTEMPT_LIMIT_V1} AND i.state='open'
        ORDER BY h.next_attempt_at,h.action_inbox_id LIMIT $3
        FOR UPDATE OF h SKIP LOCKED`, [this.input.tenantId, at, limit]);
      return due.rows;
    });
    const outcomes: OwnerPushDispatchOutcomeV1[] = [];
    for (const head of claimed) {
      // One shape of alert, one shape of payload. A service incident and a second
      // stall both open /needs-me, so they push the same generic title and tag;
      // which one it was stays in the database, never in the payload.
      outcomes.push(await this.#attempt(head));
    }
    return Object.freeze(outcomes);
  }

  /** One item: take the reservation, send outside any transaction, then settle. */
  async #attempt(head: HeadRow): Promise<OwnerPushDispatchOutcomeV1> {
    const id = head.action_inbox_id;
    const now = safeNow(this.#clock());
    const attempt = Number(head.attempt_count) + 1;
    // The reservation is committed before the send so the push never happens
    // inside a transaction, and so a crash leaves a recoverable 'reserved' row
    // rather than an invisible half-send. A concurrent second dispatcher that
    // already reserved this item finds no row to update and is told so.
    const reserved = await this.input.db.transaction(async (tx: DatabaseSession) => {
      const result = await tx.query<{ attempt_count: number | string; state: string }>(`UPDATE control_owner_push_attempt_heads
        SET state='reserved',attempt_count=$4,reserved_at=$3,last_attempt_at=$3,updated_at=$3
        WHERE tenant_id=$1 AND action_inbox_id=$2 AND state IN ('pending','reserved')
          AND attempt_count<${OWNER_PUSH_ATTEMPT_LIMIT_V1}
        RETURNING attempt_count,state`, [this.input.tenantId, id, now, attempt]);
      return result.rows[0];
    });
    if (!reserved) return Object.freeze({ actionInboxId: id, result: "claimed_by_another", attempt: Number(head.attempt_count),
      nextAttemptAt: iso(head.next_attempt_at) });
    const spent = Number(reserved.attempt_count);
    const backoffUntil = new Date(Date.parse(now) + ownerPushBackoffMsV1(spent)).toISOString();
    let failure: { statusCode?: number } | undefined;
    let deliveredCount = 0;
    let deduplicated = 0;
    try {
      // `ownerPushLinkV1` re-validates the stored link on the way out. The column
      // CHECK constrains it in the database, but a value that reached here some
      // other way must not become an open redirect on a phone.
      const link = ownerPushLinkV1(head.link);
      const result = await deliverOwnerPushV1({ tenantId: this.input.tenantId, kind: "needs_you", link,
        dedupeKey: ownerPushDedupeKeyV1(id), now, store: this.input.store, channel: this.input.channel });
      deliveredCount = result.delivered;
      deduplicated = result.deduplicated;
    } catch (error) {
      failure = typeof error === "object" && error !== null && "statusCode" in error
        && typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? { statusCode: (error as { statusCode: number }).statusCode } : {};
    }
    if (!failure && deliveredCount > 0) return this.#settle(id, "delivered", spent, now, null);
    if (!failure && deduplicated > 0)
      // The browser already holds this exact event: a send DID land for this
      // item, the acknowledgement was simply lost (the restart window above). The
      // dedupe ledger is the evidence, so this is delivered, not a retry.
      return this.#settle(id, "delivered", spent, now, null);
    if (!failure) {
      // No subscription, or a channel that reported success while delivering
      // nothing. Either way there is nothing to retry and no reason to spend the
      // bounded attempts on a phone that was never going to be handed this item:
      // the owner still has it on /needs-me. The attempt is REFUNDED here, which
      // is the one place it is, and it is safe precisely because the 0174 ledger
      // -- not this counter -- is what stops a duplicate visible notification.
      return this.#release(id, "no_subscription", Number(head.attempt_count), now, "owner_push_no_subscription");
    }
    // 404/410: the push service reports the browser subscription is gone, and
    // `deliverOwnerPushV1` has already removed it. Retrying would reach nothing,
    // so the item stops here as permanently undeliverable rather than as a stall
    // that keeps spending attempts.
    if (failure.statusCode === 404 || failure.statusCode === 410)
      return this.#settle(id, "failed", spent, now, "owner_push_subscription_gone");
    return this.#settle(id, "retry", spent, backoffUntil, "owner_push_endpoint_unavailable");
  }

  /**
   * Write the outcome. A delivered head is terminal under 0225's guard, and the
   * bound is enforced here as well as in the column CHECK: at the limit the head
   * becomes 'failed' rather than 'pending', so a permanently broken push service
   * costs exactly ATTEMPT_LIMIT sends and then stops.
   */
  async #settle(id: string, disposition: "delivered" | "retry" | "failed", spent: number,
    when: string, safeReasonCode: string | null): Promise<OwnerPushDispatchOutcomeV1> {
    const terminal = disposition === "delivered" || disposition === "failed" || spent >= OWNER_PUSH_ATTEMPT_LIMIT_V1;
    const state = terminal ? (disposition === "delivered" ? "delivered" : "failed") : "pending";
    const reason = state === "failed" && safeReasonCode === null ? "owner_push_attempts_exhausted" : safeReasonCode;
    // `when` is the settle instant, except for a retry where the caller has
    // already advanced it by the backoff. The two are passed separately rather
    // than recomputed, so the value written is exactly the one the caller chose.
    const nextAt = disposition === "retry" && !terminal ? when : null;
    const updatedAt = disposition === "retry" && !terminal ? null : when;
    await this.input.db.query(`UPDATE control_owner_push_attempt_heads
      SET state=$4,
        next_attempt_at=COALESCE($5,next_attempt_at),
        reserved_at=NULL,
        completed_at=CASE WHEN $4 IN ('delivered','failed') THEN $6 ELSE NULL END,
        safe_reason_code=$7,
        updated_at=COALESCE($8,updated_at)
      WHERE tenant_id=$1 AND action_inbox_id=$2 AND state='reserved'`,
    [this.input.tenantId, id, null, state, nextAt, when, reason, updatedAt]);
    return Object.freeze({ actionInboxId: id,
      result: state === "delivered" ? "delivered" : state === "failed" ? "exhausted" : "retry_scheduled",
      attempt: spent, nextAttemptAt: nextAt ?? when });
  }

  /**
   * Return a reserved head to the sendable state WITHOUT spending an attempt.
   *
   * Only reachable when there was no subscription to hand the item to, so there
   * is no send to have made. 0225's guard admits this: it refuses a DECREMENT of
   * attempt_count, so the count is left exactly as it was rather than subtracted
   * -- the honest record is "we reserved, found nobody, put it back", not "we
   * never looked".
   */
  async #release(id: string, result: "no_subscription", spent: number, when: string,
    safeReasonCode: string): Promise<OwnerPushDispatchOutcomeV1> {
    await this.input.db.query(`UPDATE control_owner_push_attempt_heads
      SET state='pending',reserved_at=NULL,next_attempt_at=$3,last_attempt_at=NULL,
        safe_reason_code=$4,updated_at=$3
      WHERE tenant_id=$1 AND action_inbox_id=$2 AND state='reserved'`,
    [this.input.tenantId, id, when, safeReasonCode]);
    return Object.freeze({ actionInboxId: id, result, attempt: spent, nextAttemptAt: when });
  }
}
