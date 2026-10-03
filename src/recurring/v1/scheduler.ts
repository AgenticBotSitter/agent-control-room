import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { calculateScheduleOccurrencesV1 } from "../../services/v1/recurrence";
import { supervisorRunModeDecisionV1, type SupervisorRunModePortV1 } from "../../supervisor/v1/operations-mode";
import type { WorkBatchProposalV1, WorkBatchReceiptV1 } from "../../work-intake/v1";
import { workBatchProposalDigestV1, type WorkBatchServiceV1 } from "../../work-intake/v1";
import type { AuthenticatedPrincipal } from "../../security";
import { reusableSkillReferencesSchemaV1 } from "../../skills/v1";
import { recurringRuleDefinitionDigestV1, type RecurringRuleRowV1 } from "./service";

export const RECURRING_S7B_CAPS_V1 = Object.freeze({ maxProposalsPerCycle: 3, maxConcurrentProposals: 1,
  maxTasksPerProposal: 1, maxCostMicroUsd: 0 });

type TaskTemplate = { title: string; instructions: string; requiredCapability: string;
  acceptanceCriteria: string; acceptanceTests: string; skillRefs: unknown };

export type RecurringProposalPortV1 = Readonly<{ propose(input: Readonly<{ ruleId: string; projectId: string;
  occurrenceKey: string; scheduledFor: string; definitionDigest: string; task: TaskTemplate;
  idempotencyKey: string }>): Promise<WorkBatchReceiptV1> }>;

export function recurringWorkBatchProposalPortV1(service: WorkBatchServiceV1, principal: AuthenticatedPrincipal,
  clock: () => number = Date.now): RecurringProposalPortV1 {
  return Object.freeze({ async propose(input) {
    const task = input.task;
    const proposal: WorkBatchProposalV1 = { schema: "control-room.work-batch-proposal/v1", projectId: input.projectId,
      tasks: [{ localId: "recurring", title: task.title, instructions: task.instructions,
        requiredCapability: task.requiredCapability, role: "builder", acceptanceCriteria: task.acceptanceCriteria,
        acceptanceTests: task.acceptanceTests, skillRefs: reusableSkillReferencesSchemaV1.parse(task.skillRefs) }], edges: [] };
    const result = await service.submit({ principal, projectId: input.projectId, rawProposal: JSON.stringify(proposal),
      idempotencyKey: input.idempotencyKey, now: new Date(clock()).toISOString() });
    if (!("batchId" in result) || result.startsWork !== false || result.grantsExecutionAuthority !== false)
      throw new Error("recurring_proposal_refused");
    return result;
  } });
}

type ProposalRow = { state: "pending" | "proposed" | "failed"; batch_id: string | null;
  definition_digest: string; idempotency_key: string; attempt_count: number | string; updated_at: string | Date };

/** One page of the active-rule scan, and whether more rules exist past it. */
type RulePage = { rows: RecurringRuleRowV1[]; hasMore: boolean };

/**
 * A durable claim row (0243), exactly as the coordinator login reads it.
 *
 * The claim is what carries `maxConcurrentProposals: 1` across processes. The
 * claim_owner column is the whole of it: a claim held by anybody else is one
 * somebody else is speaking for, and is not taken.
 */
type ClaimRow = { claim_owner: string; expires_at: string | Date };

/**
 * What one rule's admission decided.
 *
 * Only `failed` is a failure. `fenced` is a rule that stopped being active under
 * the lock, and `skipped` is an occurrence that is already proposed or inside its
 * backoff window: both are owed nothing, and recording either as a failure would
 * spend the owner's attention on the scheduler's own bookkeeping. A `proposed`
 * outcome carries the new batch id, and a `halted` one is the owner's own
 * operations mode changing mid-tick, which ends the tick.
 */
type RuleOutcome = "failed" | "fenced" | "skipped"
  | Readonly<{ proposed: string }> | Readonly<{ halted: "paused" | "draining" | "stopped" }>;

/** The tick's own vocabulary, widened by one halt reason the claim can produce. */
type Halted = "paused" | "draining" | "stopped" | "fenced" | null;

const iso = (value: string | Date) => new Date(value).toISOString();

/**
 * How many active rules one tick reads, and how many pages it will spend reading them.
 *
 * PLAN-U2 proved on real PostgreSQL that the previous `ORDER BY rule_id LIMIT
 * 100` prefix could never reach a due rule past the window, and the window
 * cannot simply be removed: a tick has a deadline, and an unbounded scan would
 * let a tenant with a very large rule set spend the whole budget reading rules it
 * can never propose from (the per-cycle proposal cap is 3). So the scan stays
 * BOUNDED, and the bound is spent in keyset order over a ROTATING cursor, which
 * is what makes every rule reachable across consecutive bounded ticks instead of
 * only the first N.
 */
const RULE_SCAN_PAGE = 100;
/** r6proj (D4): a rule is scanned only while its project is active. */
const ACTIVE_PROJECT_JOIN = `JOIN projects p ON p.tenant_id=r.tenant_id AND p.id=r.project_id
          LEFT JOIN control_manual_project_heads h ON h.tenant_id=r.tenant_id AND h.project_id=r.project_id`;
const ACTIVE_PROJECT_PREDICATE = "(h.lifecycle IS NULL AND p.domain_state='idea_project_active' OR h.lifecycle='active')";
const RULE_SCAN_PAGES_PER_TICK = 3;

/**
 * The catch-up horizon. Bounds the recurrence window, as 0186's shared calculator
 * requires, and doubles as the floor a recovered cursor falls back to.
 */
const CATCH_UP_HORIZON_MS = 30 * 86_400_000;

/**
 * The largest gap a future cursor may claim before it is treated as a clock that
 * moved BACKWARDS rather than as genuine elapsed time.
 *
 * PLAN-U4 measured a cursor a week in the future after a clock correction, and
 * every subsequent tick refused its window and proposed nothing until the wall
 * clock actually reached the erroneous instant. A cursor further ahead than this
 * is not plausible elapsed time for a daily rule under a bounded horizon, so it
 * is recovered from rather than obeyed.
 */
const MAX_PLAUSIBLE_CURSOR_SKEW_MS = CATCH_UP_HORIZON_MS;

/**
 * How long a failing occurrence is ineligible before its next attempt, and the
 * hard stop after that.
 *
 * PLAN-U3 measured three permanently failing rules occupying every cycle
 * forever: 20 ticks made 60 calls and the healthy fourth rule was never once
 * reached. The three-attempt cap is the owner's stated bound and is kept. What
 * changes is that a rule inside its backoff window is SKIPPED rather than
 * retried, so the three calls are spent over three backoff windows instead of
 * three ticks, and a failing rule can no longer consume a cycle every minute. A
 * rule that has spent its whole cap leaves the scan until the owner edits it,
 * which is what finally breaks the indefinite occupation.
 */
const RETRY_BACKOFF_MS = 15 * 60_000;
const MAX_PROPOSAL_ATTEMPTS = RECURRING_S7B_CAPS_V1.maxProposalsPerCycle;

/**
 * How long one tick may hold the proposal claim, and how long a fenced tick waits
 * for a peer that may be finishing before it reports `fenced`.
 *
 * The wait is the compromise between the two bounds a fenced tick has: giving up
 * immediately would starve a rule behind a peer that is mid-proposal, and waiting
 * out the full lease would exceed the tick's own deadline.
 */
const CLAIM_LEASE_MS = 60_000;
const CLAIM_WAIT_MS = 250;

/** True when the retained cursor is ahead of now, i.e. the clock went backwards. */
function cursorIsAhead(cursorMs: number, nowMs: number): boolean {
  return cursorMs > nowMs;
}

/**
 * The instant to start the recurrence window from.
 *
 * A cursor ahead of now is a corrected clock, and obeying it would suppress every
 * legitimate occurrence until the erroneous instant arrives -- exactly the
 * measured PLAN-U4 failure. Recovery starts from `now - horizon` instead: the
 * LEDGER, not the cursor, is what prevents a duplicate, because every retained
 * occurrence key is already there and a proposed one is skipped. So a recovered
 * window re-derives occurrences that were already proposed and still proposes
 * nothing twice.
 */
function windowStartMs(cursorMs: number, nowMs: number): number {
  const floorMs = nowMs - CATCH_UP_HORIZON_MS;
  if (cursorIsAhead(cursorMs, nowMs) && cursorMs - nowMs <= MAX_PLAUSIBLE_CURSOR_SKEW_MS) return floorMs;
  return Math.max(cursorMs, floorMs);
}

/**
 * Why a retained occurrence is not eligible to be proposed again, or null when it is.
 *
 * Read BEFORE the ledger upsert, and that ordering is load-bearing. The upsert sets
 * `updated_at` to now, so a backoff measured after the write finds every row inside
 * its own window -- including a row that statement had just created, which is a
 * FIRST attempt and has failed nothing. That was measured, not assumed: the other
 * order proposed nothing at all, on every rule, forever. Reading first makes
 * `updated_at` the instant of the last real event: the previous failure, or the
 * original insert.
 *
 * Three refusals, and each is a different thing rather than a restatement:
 *
 *   - `proposed` is a receipt the S1 intake already holds. Its idempotency key is
 *     spent, so a second call replays rather than creates, and the review asks for
 *     replays to be reported separately from newly created proposals.
 *   - an attempt count at the cap is the owner's stated retry bound; re-calling
 *     would spend a budget the owner never granted.
 *   - a row inside its backoff window failed RECENTLY, which is not the same as
 *     being permanently broken. Without this a failing rule is retried on the very
 *     next tick, which is PLAN-U3's starvation in its shortest form.
 */
function occurrenceIneligible(prior: ProposalRow, attemptCount: number, nowMs: number):
  "proposed" | "attempt_cap" | "backoff" | null {
  if (prior.state === "proposed") return "proposed";
  if (attemptCount >= MAX_PROPOSAL_ATTEMPTS) return "attempt_cap";
  if (nowMs - Date.parse(iso(prior.updated_at)) < RETRY_BACKOFF_MS) return "backoff";
  return null;
}

const sleepMs = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export class RecurringRuleSchedulerV1 {
  /**
   * This instance's claim identity, minted once so a tick's acquisition and its
   * release name the same owner.
   *
   * A liveness label, not a credential: a peer only needs to tell "somebody else
   * is speaking" from "the lease lapsed and nobody took it".
   */
  readonly #owner = `recurring-tick:${process.pid}:${Math.random().toString(36).slice(2, 12)}`;

  constructor(private readonly db: DatabaseClient, private readonly tenantId: string,
    private readonly operations: SupervisorRunModePortV1, private readonly proposals: RecurringProposalPortV1,
    private readonly clock: () => number = Date.now) {}

  async tick(): Promise<Readonly<{ proposed: readonly string[]; failed: readonly string[];
    halted: Halted; startsWork: false }>> {
    const decision = supervisorRunModeDecisionV1(await this.operations.read());
    if (decision !== "start") return Object.freeze({ proposed: [], failed: [],
      halted: decision === "pause" ? "paused" : decision === "drain" ? "draining" : "stopped", startsWork: false });
    const nowMs = this.clock(), now = new Date(nowMs).toISOString();
    // The claim is taken BEFORE the rule scan, so a fenced tick costs one statement
    // rather than a whole scan it may not use. It is released in a finally, and it
    // is LEASED rather than deleted, so an instance that dies mid-proposal fences
    // the installation for one lease rather than forever.
    if (!await this.#acquireClaim() && !await this.#awaitClaimExpiry())
      return Object.freeze({ proposed: [], failed: [], halted: "fenced", startsWork: false });
    try {
      return await this.#runClaimed(nowMs, now);
    } finally {
      await this.#releaseClaim();
    }
  }

  /**
   * Take the tenant's proposal claim, or report that somebody else holds it.
   *
   * One statement, and the atomicity is the point. `ON CONFLICT DO UPDATE ...
   * WHERE expires_at <= statement_timestamp()` compares and takes in the same
   * operation, so fifty racers produce exactly one winner and the other
   * forty-nine see zero rows. The lease runs on the database's own clock rather
   * than the caller's, so a scheduler whose wall clock jumps cannot hold a claim
   * indefinitely and a slow one cannot lose a live claim to its own slowness.
   */
  async #acquireClaim(): Promise<boolean> {
    const rows = (await this.db.query<ClaimRow>(`INSERT INTO control_recurring_proposal_claims
      (tenant_id,claim_owner,claimed_at,expires_at)
      VALUES($1,$2,statement_timestamp(),statement_timestamp()+($3::text||' milliseconds')::interval)
      ON CONFLICT (tenant_id) DO UPDATE SET claim_owner=EXCLUDED.claim_owner,
        claimed_at=statement_timestamp(),expires_at=statement_timestamp()+($3::text||' milliseconds')::interval
      WHERE control_recurring_proposal_claims.expires_at<=statement_timestamp()
      RETURNING claim_owner`, [this.tenantId, this.#owner, String(CLAIM_LEASE_MS)])).rows;
    return rows.length === 1;
  }

  /**
   * Wait a bounded moment for a peer's claim to lapse, then take it.
   *
   * Returns false when the peer is still live, which is the honest outcome and the
   * reason `fenced` is a reported state at all: a caller can tell "another
   * instance is proposing" from "there was nothing due". Taking over an EXPIRED
   * claim is the crash recovery, and it needs no separate reconciliation pass.
   *
   * The wait is measured on REAL time, never on the injected clock. A test that
   * freezes its clock at one instant -- which every one of these cases does --
   * would otherwise spin here until the deadline, because `clock()` would never
   * reach the bound.
   */
  async #awaitClaimExpiry(): Promise<boolean> {
    const until = Date.now() + CLAIM_WAIT_MS;
    while (Date.now() < until) {
      await sleepMs(25);
      if (await this.#acquireClaim()) return true;
    }
    return false;
  }

  /**
   * Release the claim by EXPIRING it, never by deleting it.
   *
   * 0243 grants this login no DELETE on the table, on purpose: a claim the fenced
   * instance could remove is a claim that proves nothing. The row always stays and
   * the next tick takes it over, so a crash and a clean exit are distinguishable
   * only by whether the lease is still in the future.
   */
  async #releaseClaim(): Promise<void> {
    await this.db.query(`UPDATE control_recurring_proposal_claims SET expires_at=statement_timestamp()
      WHERE tenant_id=$1 AND claim_owner=$2`, [this.tenantId, this.#owner]);
  }

  async #runClaimed(nowMs: number, now: string): Promise<Readonly<{ proposed: readonly string[];
    failed: readonly string[]; halted: Halted; startsWork: false }>> {
    const proposed: string[] = [], failed: string[] = [];
    // The per-cycle cap counts CALLS to the proposal port, not successes. A call
    // that throws still reached S1 and still cost the installation an attempt, so
    // counting only successes would quietly raise the cap from three to whatever a
    // broken rule set manages to spend -- and the ledger would then record more
    // S1 calls in one cycle than the owner was promised. The counter is shared with
    // #admit so the spend happens at the port boundary, not at the caller's
    // discretion.
    const budget = { used: 0 };
    // Keyset pagination from the durable cursor, bounded to a fixed page budget.
    // The cursor is read ONCE per tick and written back at the end, so a tick that
    // dies mid-scan resumes where it stopped rather than skipping the rules it
    // never reached.
    const cursor = (await this.db.query<{ last_rule_id: string | null }>(
      `SELECT last_rule_id FROM control_recurring_scan_cursors WHERE tenant_id=$1`,
    [this.tenantId])).rows[0]?.last_rule_id ?? null;
    // Two positions, not one, and the difference is the whole point of a bounded
    // scan: `read` is where this tick's page starts, and `covered` is the last rule
    // it actually EVALUATED. Advancing the cursor to `read` would step over every
    // rule the per-cycle cap stopped this tick short of, which is PLAN-U2's defect
    // rebuilt one layer up -- measured: with 101 rules and a cap of three, five
    // ticks proposed fifteen rules and the last one was never reached, exactly
    // because each tick committed its cursor past the ninety-eight it had not
    // looked at. `covered` is therefore advanced only over rules this tick read, so
    // the cap bounds the WORK and never the REACH.
    let read = cursor, covered = cursor, pages = 0;
    for (;;) {
      const page = await this.#readPage(read);
      if (page.rows.length) read = page.rows.at(-1)!.rule_id;
      for (const rule of page.rows) {
        // The cap is checked BEFORE `covered` advances, and that ordering is the
        // whole correction. My first attempt set `covered = rule.rule_id` first, on
        // the reasoning that the rule had been "read"; measured, that is wrong --
        // the rule was read into memory and then never evaluated, and advancing
        // past it is exactly PLAN-U2's "a due rule the scan never visited". With
        // 101 rules and a cap of three, five ticks proposed fifteen rules and rule
        // 101 was still never reached, byte for byte the original defect. A rule
        // counts as covered only once this tick has actually evaluated it.
        if (budget.used >= RECURRING_S7B_CAPS_V1.maxProposalsPerCycle) break;
        const outcome = await this.#evaluateRule(rule, nowMs, now, budget);
        covered = rule.rule_id;
        if (outcome === "failed") failed.push(rule.rule_id);
        else if (typeof outcome === "object" && "proposed" in outcome) proposed.push(outcome.proposed);
        else if (typeof outcome === "object")
          // The owner's own operations mode changed mid-tick. Nothing further
          // starts this tick, and the halt is reported rather than swallowed.
          return Object.freeze({ proposed: Object.freeze(proposed), failed: Object.freeze(failed),
            halted: outcome.halted, startsWork: false });
      }
      pages += 1;
      // A short page means the tail was reached, so the scan wraps and the next
      // tick starts at the beginning. Without the wrap a tenant whose rule count
      // is an exact multiple of the page size would read page one forever.
      if (page.rows.length < RULE_SCAN_PAGE || !page.hasMore || pages >= RULE_SCAN_PAGES_PER_TICK) break;
    }
    if (covered !== null && covered !== cursor) await this.#advanceCursor(covered, now);
    return Object.freeze({ proposed: Object.freeze(proposed), failed: Object.freeze(failed), halted: null,
      startsWork: false });
  }

  /** One keyset page of active rules, and whether more exist past it. */
  async #readPage(after: string | null): Promise<RulePage> {
    // `rule_id > NULL` is never true, so the first page is its own statement
    // rather than a coalesce that would defeat the index. The walk is
    // (tenant_id, rule_id), which is the rules table's own keyset.
    //
    // EFFICIENCY, NOT THE FENCE (r6proj, lead decision D4). Skipping a rule whose
    // project is not active here saves the recurrence calculation and the proposal
    // attempt, but it is explicitly NOT what keeps an archived project from receiving
    // work: this scan reads no lock, so it can see 'active' and then lose the race
    // with the owner's archive. The guarantee lives in the two authoritative
    // transactions -- the intake store's create() and scheduled admission's admit()
    // -- which read and lock the same lifecycle the archive transition writes.
    const rows = (after === null
      ? (await this.db.query<RecurringRuleRowV1>(`SELECT r.* FROM control_recurring_rules r
          ${ACTIVE_PROJECT_JOIN}
          WHERE r.tenant_id=$1 AND r.state='active' AND ${ACTIVE_PROJECT_PREDICATE}
          ORDER BY r.rule_id LIMIT $2`,
      [this.tenantId, RULE_SCAN_PAGE + 1])).rows
      : (await this.db.query<RecurringRuleRowV1>(`SELECT r.* FROM control_recurring_rules r
          ${ACTIVE_PROJECT_JOIN}
          WHERE r.tenant_id=$1 AND r.state='active' AND ${ACTIVE_PROJECT_PREDICATE} AND r.rule_id>$2
          ORDER BY r.rule_id LIMIT $3`,
      [this.tenantId, after, RULE_SCAN_PAGE + 1])).rows);
    // One row over the page is the has-more signal, so the caller asks for
    // exactly a page and never evaluates the row that only answers the question.
    return Object.freeze({ rows: rows.slice(0, RULE_SCAN_PAGE), hasMore: rows.length > RULE_SCAN_PAGE });
  }

  /**
   * Advance the rotating cursor, resetting to the start when the scan wrapped.
   *
   * A NULL `last_rule_id` means "the next tick begins at the beginning", which is
   * what makes this a rotation rather than a walk to the end that stops.
   */
  async #advanceCursor(lastRuleId: string, now: string): Promise<void> {
    // The tail is counted over the same rules the scan reads, so a tail of only
    // inactive-project rules still wraps the cursor (D4).
    const tail = (await this.db.query<{ count: number }>(`SELECT count(*)::int count
      FROM control_recurring_rules r ${ACTIVE_PROJECT_JOIN}
      WHERE r.tenant_id=$1 AND r.state='active' AND ${ACTIVE_PROJECT_PREDICATE} AND r.rule_id>$2`,
    [this.tenantId, lastRuleId])).rows[0]?.count ?? 0;
    await this.db.query(`INSERT INTO control_recurring_scan_cursors(tenant_id,last_rule_id,updated_at)
      VALUES($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET last_rule_id=EXCLUDED.last_rule_id,
        updated_at=EXCLUDED.updated_at`, [this.tenantId, tail === 0 ? null : lastRuleId, now]);
  }

  /** One rule: derive its newest due occurrence and decide whether it may be proposed. */
  async #evaluateRule(rule: RecurringRuleRowV1, nowMs: number, now: string,
    budget: { used: number }): Promise<RuleOutcome> {
    // The shared recurrence calculator refuses windows over 31 days. A 30-day
    // catch-up horizon leaves room for the inclusive end instant and still
    // collapses every missed occurrence to the newest one below.
    const startMs = Math.max(windowStartMs(Date.parse(iso(rule.last_evaluated_at)), nowMs),
      nowMs - CATCH_UP_HORIZON_MS);
    const calculation = calculateScheduleOccurrencesV1({ id: rule.rule_id, kind: "cron", state: "active",
      expression: rule.cron_expression, timezone: rule.timezone },
    { startsAt: new Date(startMs).toISOString(), endsAt: new Date(nowMs + 1).toISOString() });
    if (calculation.safeReason) return "failed";
    const occurrence = calculation.occurrences.at(-1);
    if (!occurrence) { await this.#advanceRuleCursor(rule.rule_id, now); return "skipped"; }
    const definitionDigest = recurringRuleDefinitionDigestV1(rule);
    const idempotencyKey = `recurring:${definitionDigest.slice(7, 39)}:${occurrence.localTime.replace(/[^0-9]/g, "")}`;
    // Read the retained row BEFORE any write, so eligibility is decided from the
    // last real event rather than from this tick's own write.
    const prior = (await this.db.query<ProposalRow>(`SELECT state,batch_id,definition_digest,idempotency_key,
      attempt_count,updated_at FROM control_recurring_proposals
      WHERE tenant_id=$1 AND rule_id=$2 AND occurrence_key=$3`,
    [this.tenantId, rule.rule_id, occurrence.occurrenceKey])).rows[0];
    // An occurrence is immutable. If the owner edited the rule after a failed call,
    // wait for the next scheduled occurrence instead of retargeting this ledger row
    // or spending a different S1 idempotency key.
    if (prior && (prior.definition_digest !== definitionDigest || prior.idempotency_key !== idempotencyKey)) {
      await this.#advanceRuleCursor(rule.rule_id, now);
      return "failed";
    }
    if (prior && occurrenceIneligible(prior, Number(prior.attempt_count), nowMs) !== null) return "skipped";
    return await this.#admit(rule, occurrence.occurrenceKey, occurrence.scheduledFor, definitionDigest,
      idempotencyKey, now, budget);
  }

  /**
   * Admission: lock the rule, verify it is still active, claim the occurrence and
   * propose -- all inside ONE transaction.
   *
   * PLAN-U5 measured a pause committed between selection and admission still
   * submitting its old proposal, and the review is explicit that an unprotected
   * extra read alone leaves the race. The lock is what closes it: the owner's own
   * Pause is an UPDATE on this same row, so it cannot commit while this transaction
   * holds the lock, and this transaction cannot read a stale state while the Pause
   * is uncommitted. Whichever takes the lock first wins and the other observes the
   * committed truth. A pause that lands first fences the proposal; a proposal that
   * lands first was durably admitted before the pause was ordered, which is a
   * truthful ordering rather than a lost write.
   *
   * `FOR NO KEY UPDATE` rather than `FOR UPDATE` because the key never changes here,
   * and it is measured on real PostgreSQL 17 to need no privilege beyond the SELECT
   * this login already holds -- so the fence does not widen the grant.
   *
   * THE PROPOSAL CALL IS NOT INSIDE THAT TRANSACTION, and that is a correction
   * rather than a preference. Holding a transaction open across a port call is only
   * safe when the port is guaranteed to use a different connection, and this one is
   * not: measured, the call deadlocks outright when the port shares the caller's
   * client, and the same shape would stall a real pool while the row lock is held.
   * So admission is three short transactions instead of one long one, and the fence
   * does not depend on the call being inside:
   *
   *   1. claim  -- lock the rule, verify it is still active, spend the attempt, COMMIT
   *   2. propose -- the S1 call, on its own connection, holding nothing
   *   3. settle -- record the receipt, advance the rule cursor, COMMIT
   *
   * The fence is phase 1, and it is real because the ledger row it commits IS the
   * admission: a pause that completed before phase 1 took the lock is observed by
   * phase 1 and no proposal follows, because phase 1 returns without spending an
   * attempt. A pause that commits after phase 1 is later admission than the one
   * that already happened, which the review asks for -- it fences a LATER admission,
   * it does not retroactively cancel a durably admitted occurrence. A crash between
   * phases leaves a `pending` row with one spent attempt, which is the retryable
   * state the backoff above is designed around.
   */
  async #admit(rule: RecurringRuleRowV1, occurrenceKey: string, scheduledFor: string, definitionDigest: string,
    idempotencyKey: string, now: string, budget: { used: number }): Promise<RuleOutcome> {
    const claimed = await this.#claimOccurrence(rule, occurrenceKey, scheduledFor, definitionDigest, idempotencyKey, now);
    if (claimed !== "") return claimed;
    // The cap is spent HERE, at the port boundary, so a refusal by a peer above has
    // not consumed one and a call that is about to happen always has.
    budget.used += 1;
    let receipt: WorkBatchReceiptV1;
    try {
      const task = rule.task_template as TaskTemplate;
      receipt = await this.proposals.propose({ ruleId: rule.rule_id, projectId: rule.project_id,
        occurrenceKey, scheduledFor, definitionDigest, task, idempotencyKey });
    } catch {
      // A failed proposal must leave a durable, retryable record rather than no
      // record at all, and the write is restricted to `state='pending'` so a row
      // some other caller already committed as `proposed` is never marked failed
      // behind its own receipt.
      await this.db.query(`UPDATE control_recurring_proposals SET state='failed',safe_reason_code='proposal_failed',
        updated_at=$1 WHERE tenant_id=$2 AND rule_id=$3 AND occurrence_key=$4 AND state='pending'`,
      [now, this.tenantId, rule.rule_id, occurrenceKey]);
      return "failed";
    }
    if (receipt.startsWork !== false || receipt.grantsExecutionAuthority !== false
      || receipt.projectId !== rule.project_id) {
      // An unsafe receipt is recorded the same way a thrown call is, so the
      // occurrence cannot be retried on a receipt the S1 adapter would refuse
      // again -- and cannot be counted as proposed either.
      await this.db.query(`UPDATE control_recurring_proposals SET state='failed',safe_reason_code='proposal_failed',
        updated_at=$1 WHERE tenant_id=$2 AND rule_id=$3 AND occurrence_key=$4 AND state='pending'`,
      [now, this.tenantId, rule.rule_id, occurrenceKey]);
      return "failed";
    }
    // Phase 3: the receipt is durable at S1, so the ledger must record it even if
    // this process dies immediately afterwards. A row left `pending` with one spent
    // attempt is the retryable state, and S1's own idempotency key means the retry
    // replays this same batch rather than creating a second one.
    await this.db.transaction(async tx => {
      await tx.query(`UPDATE control_recurring_proposals SET state='proposed',batch_id=$1,safe_reason_code=NULL,
        updated_at=$2 WHERE tenant_id=$3 AND rule_id=$4 AND occurrence_key=$5`,
      [receipt.batchId, now, this.tenantId, rule.rule_id, occurrenceKey]);
      await tx.query(`UPDATE control_recurring_rules SET last_evaluated_at=$1
        WHERE tenant_id=$2 AND rule_id=$3 AND last_evaluated_at<$1`, [now, this.tenantId, rule.rule_id]);
    });
    return { proposed: receipt.batchId };
  }

  /**
   * Phase 1: spend one attempt on an occurrence, under the rule's row lock.
   *
   * Returns `{ proposed: false }`-shaped outcomes as the bare vocabulary the caller
   * reports, or the empty string `` when the attempt is genuinely spent and the
   * caller should go on to propose.
   *
   * The three refusals each answer a different question. `fenced` is the rule no
   * longer active under the lock, and it spends no attempt. A halt is the owner's
   * operations mode, which spends no attempt either and ends the tick. `skipped` is
   * an occurrence that is already proposed or has spent the retry cap, and the
   * attempt-count upsert below is what increments the count, so the cap is enforced
   * against the ledger rather than against this caller's memory of it.
   */
  async #claimOccurrence(rule: RecurringRuleRowV1, occurrenceKey: string, scheduledFor: string,
    definitionDigest: string, idempotencyKey: string, now: string): Promise<RuleOutcome | ""> {
    // THE MODE IS READ BEFORE THE ROW LOCK IS TAKEN, and that ordering is a measured
    // correction rather than a preference. `operations.read()` is an I/O call, and
    // holding a row lock across it means an owner's Pause -- which is an UPDATE on
    // this same row -- waits for it. Measured on real PostgreSQL 17: with the read
    // inside the transaction, PLAN-U5's committed Pause timed out at the pool's
    // lock_timeout and surfaced as `database_unavailable` from the release path,
    // i.e. the fence was tested by making the OWNER fail.
    //
    // Reading first is safe for the fence, which is what matters: the lock is taken
    // immediately afterwards, and a Pause that commits in between is still observed,
    // because the locked read is issued after the Pause has committed. A Pause that
    // arrives after the lock still waits, which is correct -- it is later admission
    // than the one that already won.
    const modeBeforeLock = supervisorRunModeDecisionV1(await this.operations.read());
    return this.db.transaction(async tx => {
      const current = (await tx.query<{ state: string }>(`SELECT state FROM control_recurring_rules
        WHERE tenant_id=$1 AND rule_id=$2 FOR NO KEY UPDATE`, [this.tenantId, rule.rule_id])).rows[0];
      if (!current || current.state !== "active") return "fenced" as const;
      // THE MODE IS DECIDED BEFORE THE ATTEMPT-COUNT UPSERT, and that ordering is a
      // measured correction rather than a preference. The review found the ledger upsert
      // running first: an operations-mode halt -- the owner's own Pause, Drain or Stop --
      // spent one of the occurrence's three attempts even though it made no proposal call
      // at all. So an owner who paused, waited out a backoff, resumed, and paused again
      // could burn an occurrence's whole retry budget without the scheduler ever once
      // having offered the work to S1, and the occurrence then left the scan for good on
      // `attempt_cap` with nothing to show for it. An attempt is the price of CALLING S1,
      // so it is spent where the call happens -- below, in `#admit` -- and nowhere else.
      //
      // The halt still RECORDS the occurrence it stopped. That record is what makes the
      // owner's pause visible in the one place they would look for it, and what stops the
      // next tick re-deriving the same occurrence as brand new. `attempt_count` is left
      // exactly as it was found: 1 on a row this statement creates (the column is
      // NOT NULL CHECK (attempt_count >= 1), so a new row cannot be written without one),
      // and UNCHANGED on a row that already exists, which is the case the review measured.
      if (modeBeforeLock !== "start") {
        await tx.query(`INSERT INTO control_recurring_proposals
          (tenant_id,project_id,rule_id,occurrence_key,scheduled_for,definition_digest,idempotency_key,state,
            safe_reason_code,attempt_count,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'failed','operations_mode',1,$8,$8)
          ON CONFLICT(tenant_id,rule_id,occurrence_key) DO UPDATE
            SET state='failed',safe_reason_code='operations_mode',updated_at=EXCLUDED.updated_at
          WHERE control_recurring_proposals.state='pending'
            AND control_recurring_proposals.definition_digest=EXCLUDED.definition_digest`,
        [this.tenantId, rule.project_id, rule.rule_id, occurrenceKey, scheduledFor, definitionDigest,
          idempotencyKey, now]);
        return { halted: modeBeforeLock === "pause" ? "paused" : modeBeforeLock === "drain" ? "draining"
          : "stopped" } as const;
      }
      await tx.query(`INSERT INTO control_recurring_proposals
        (tenant_id,project_id,rule_id,occurrence_key,scheduled_for,definition_digest,idempotency_key,state,attempt_count,
          created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',1,$8,$8)
        ON CONFLICT(tenant_id,rule_id,occurrence_key) DO UPDATE
          SET attempt_count=control_recurring_proposals.attempt_count+1,
            state=CASE WHEN control_recurring_proposals.state='proposed' THEN 'proposed' ELSE 'pending' END,
            safe_reason_code=CASE WHEN control_recurring_proposals.state='proposed'
              THEN control_recurring_proposals.safe_reason_code ELSE NULL END,
            updated_at=EXCLUDED.updated_at
          WHERE control_recurring_proposals.state<>'proposed'
            AND control_recurring_proposals.definition_digest=EXCLUDED.definition_digest`,
      [this.tenantId, rule.project_id, rule.rule_id, occurrenceKey, scheduledFor, definitionDigest,
        idempotencyKey, now]);
      // Re-read what the upsert settled, so a peer that got here first is observed
      // rather than assumed. An existing receipt means the S1 idempotency key is
      // already spent, and a count past the cap means this occurrence has spent the
      // owner's whole retry budget. Both are `skipped`, which is what keeps "newly
      // created" separate from "replayed" in the tick's own result.
      const settled = (await tx.query<{ state: string; attempt_count: number | string }>(
        `SELECT state,attempt_count FROM control_recurring_proposals
          WHERE tenant_id=$1 AND rule_id=$2 AND occurrence_key=$3`,
      [this.tenantId, rule.rule_id, occurrenceKey])).rows[0];
      if (settled?.state === "proposed" || Number(settled?.attempt_count ?? 1) > MAX_PROPOSAL_ATTEMPTS)
        return "skipped" as const;
      return "" as const;
    });
  }

  /** Move a rule's own cursor forward, never backwards. */
  async #advanceRuleCursor(ruleId: string, now: string): Promise<void> {
    await this.db.query(`UPDATE control_recurring_rules SET last_evaluated_at=$1
      WHERE tenant_id=$2 AND rule_id=$3 AND last_evaluated_at<$1`, [now, this.tenantId, ruleId]);
  }
}
