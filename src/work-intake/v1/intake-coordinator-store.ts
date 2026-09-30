import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { workBatchProposalDigestV1 } from "./digest";
import { computeIntakeFlagsV1, type IntakeFlagV1 } from "./intake-gate";
import {
  common, InMemoryIntakePlannerFailureStoreV1, plannerNeedsYouScopeKeysV1,
  type IntakeCompletionLookupPortV1, type IntakeCoordinatorResultV1,
  type IntakePlannerFailureStoreV1, type IntakePlannerNeedsYouPortV1,
  type IntakePlannerRunAllowancePortV1, type IntakeSuggestionRecordV1, type IntakeSuggestionStoreV1,
} from "./intake-coordinator";
import { workBatchProposalSchemaV1, workBatchReceiptSchemaV1, type WorkBatchProposalV1 } from "./schemas";

// The production adapters for the three IntakeCoordinatorV1 ports that need a
// database. Everything here is proposal-only: an append to an append-only
// suggestion table, a keyed counter, and a ledger row. None of them writes a
// work_batch_revision, approves a batch, admits a claim, assigns work or starts
// anything, and each carries the shape the port declares.

type SuggestionRow = { id: string; tenant_id: string; project_id: string; batch_id: string;
  request_key: string; base_revision: string | number; base_revision_digest: string;
  proposed_by_identity_id: string; proposal: unknown; proposal_digest: string;
  suggestion_digest: string; auth_tag: string; created_at: string | Date };
type CounterRow = { failure_count: string | number; cleared_at: string | Date | null; scope_key?: string };

const iso = (value: string | Date) => new Date(value).toISOString();
const json = (value: unknown) => JSON.stringify(value);
/** The port's `id` grammar, and the table's own CHECK, agree on this. */
const suggestionId = () => `split-suggestion:${createHash("sha256")
  .update(randomUUID(), "utf8").digest("hex").slice(0, 32)}`;

function freezeFlags(value: Readonly<Record<string, readonly IntakeFlagV1[]>>) {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([localId, flags]) =>
    [localId, Object.freeze(flags.map(flag => Object.freeze({ ...flag })))])));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Raised when the database refused a suggestion, with a safe reason code. */
export class IntakeSuggestionStoreErrorV1 extends Error {
  constructor(readonly safeReasonCode: "intake_suggestion_replay_conflict" | "intake_suggestion_rejected"
    | "intake_suggestion_not_found" | "intake_suggestion_stale" | "intake_suggestion_owner_required") {
    super(safeReasonCode);
    this.name = "IntakeSuggestionStoreErrorV1";
  }
}

/** The in-memory failure store, kept as the default so an unconfigured
 * composition still runs. It is NOT durable: see PostgresIntakePlannerFailureStoreV1. */
export { InMemoryIntakePlannerFailureStoreV1 };

/** Suggestion persistence against 0200's work_batch_split_suggestions.
 *
 * The database, not this class, decides whether an insert is allowed: the table's
 * write guard requires an active agent holding exactly ['work_batches.propose'],
 * a batch that is still 'proposed', the batch's current version, that revision's
 * own digest, and the batch's own proposer. This adapter therefore does not
 * re-implement those checks -- a second copy of an authority rule is a second
 * copy to get wrong -- and instead maps the database's own refusals onto the
 * port's safe reason codes. What it DOES own is integrity material (the
 * suggestion digest and HMAC over the stored record), because the key never
 * leaves this process, and the idempotent replay read. */
export class PostgresIntakeSuggestionStoreV1 implements IntakeSuggestionStoreV1 {
  readonly #key: Uint8Array;
  constructor(private readonly db: DatabaseClient, integrityKey: Uint8Array) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32)
      throw new Error("intake_suggestion_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey);
  }

  /** The authenticated material the guard and the readback both re-derive. */
  #material(input: { suggestionId: string; tenantId: string; projectId: string; batchId: string;
    requestKey: string; baseRevision: number; baseRevisionDigest: string; proposerIdentityId: string;
    proposal: WorkBatchProposalV1; proposalDigest: string; createdAt: string }) {
    return { id: input.suggestionId, tenantId: input.tenantId, projectId: input.projectId,
      batchId: input.batchId, requestKey: input.requestKey, baseRevision: input.baseRevision,
      baseRevisionDigest: input.baseRevisionDigest, proposerIdentityId: input.proposerIdentityId,
      proposal: input.proposal, proposalDigest: input.proposalDigest, createdAt: input.createdAt };
  }

  #verify(row: SuggestionRow, key: Uint8Array): WorkBatchProposalV1 {
    const proposal = workBatchProposalSchemaV1.parse(row.proposal);
    const proposalDigest = workBatchProposalDigestV1(proposal);
    const material = { id: row.id, tenantId: row.tenant_id, projectId: row.project_id,
      batchId: row.batch_id, requestKey: row.request_key, baseRevision: Number(row.base_revision),
      baseRevisionDigest: row.base_revision_digest, proposerIdentityId: row.proposed_by_identity_id,
      proposal, proposalDigest, createdAt: iso(row.created_at) };
    const tag = hmacSha256Tag(key, { purpose: "work-batch-split-suggestion/v1", record: material });
    // Both digests are re-derived from the STORED bytes, so a row whose content,
    // stored digest or integrity tag has been altered since it was written is
    // refused here rather than handed to the owner as a plan.
    if (proposalDigest !== row.proposal_digest || tag !== row.auth_tag
      || row.suggestion_digest !== `sha256:${createHash("sha256")
        .update(json({ baseRevisionDigest: row.base_revision_digest, proposalDigest }),
          "utf8").digest("hex")}`)
      throw new IntakeSuggestionStoreErrorV1("intake_suggestion_rejected");
    return proposal;
  }

  async append(input: Omit<IntakeSuggestionRecordV1,
    "suggestionId" | "startsWork" | "grantsExecutionAuthority" | "savesRevision">): Promise<IntakeSuggestionRecordV1> {
    const proposal = workBatchProposalSchemaV1.parse(input.proposal);
    if (workBatchProposalDigestV1(proposal) !== input.proposalDigest)
      throw new IntakeSuggestionStoreErrorV1("intake_suggestion_rejected");
    // A request key names ONE suggestion, and a request key already used must not
    // be able to name a second, different one. An EXACT replay is answered from
    // the stored row; a DIFFERING one is refused, in the same place, before any
    // write.
    //
    // The comparison is over all THREE bound values, and it is `||` rather than
    // `&&`: a replay that changed the proposal, or the revision it answers, or
    // the digest of that revision, is a different request wearing a used key. This
    // was measured against production before it was written: the pre-read used
    // to return ANY existing row under the key without comparing anything, so a
    // same-key different-proposal replay came back as the FIRST record and the
    // caller was told it had stored a 3-part plan when it had asked for 4. The
    // in-memory double refused that case, so every coordinator test passed on a
    // contract production did not keep. A missing row is a replay of nothing and
    // goes on to the insert.
    const existing = (await this.db.query<SuggestionRow>(`SELECT id,tenant_id,project_id,batch_id,
      request_key,base_revision,base_revision_digest,proposed_by_identity_id,proposal,proposal_digest,
      suggestion_digest,auth_tag,created_at FROM work_batch_split_suggestions
      WHERE tenant_id=$1 AND project_id=$2 AND batch_id=$3 AND request_key=$4`,
    [input.tenantId, input.projectId, input.batchId, input.requestKey])).rows[0];
    if (existing) {
      if (Number(existing.base_revision) !== input.baseRevision
        || existing.base_revision_digest !== input.baseRevisionDigest
        || existing.proposal_digest !== input.proposalDigest)
        throw new IntakeSuggestionStoreErrorV1("intake_suggestion_replay_conflict");
      return this.#record(existing);
    }
    const id = suggestionId();
    const material = this.#material({ suggestionId: id, tenantId: input.tenantId, projectId: input.projectId,
      batchId: input.batchId, requestKey: input.requestKey, baseRevision: input.baseRevision,
      baseRevisionDigest: input.baseRevisionDigest, proposerIdentityId: input.proposerIdentityId,
      proposal, proposalDigest: input.proposalDigest, createdAt: input.createdAt });
    const suggestionDigest = createHash("sha256")
      .update(json({ baseRevisionDigest: input.baseRevisionDigest, proposalDigest: input.proposalDigest }),
        "utf8").digest("hex");
    const tag = hmacSha256Tag(this.#key,
      { purpose: "work-batch-split-suggestion/v1", record: material });
    try {
      await this.db.query(`INSERT INTO work_batch_split_suggestions(id,tenant_id,project_id,batch_id,
        request_key,base_revision,base_revision_digest,proposed_by_identity_id,proposed_by_actor_type,
        proposal,proposal_digest,suggestion_digest,auth_tag,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'agent',$9::jsonb,$10,$11,$12,$13)
        ON CONFLICT (tenant_id,project_id,batch_id,request_key) DO NOTHING`,
      [id, input.tenantId, input.projectId, input.batchId, input.requestKey, input.baseRevision,
        input.baseRevisionDigest, input.proposerIdentityId, json(proposal), input.proposalDigest,
        `sha256:${suggestionDigest}`, tag, input.createdAt]);
    } catch (error) {
      throw this.#refusal(error);
    }
    // Read back rather than trusting the values just sent: the row is what the
    // owner will see, and the integrity check runs against what is actually stored.
    const stored = (await this.db.query<SuggestionRow>(`SELECT id,tenant_id,project_id,batch_id,
      request_key,base_revision,base_revision_digest,proposed_by_identity_id,proposal,proposal_digest,
      suggestion_digest,auth_tag,created_at FROM work_batch_split_suggestions
      WHERE tenant_id=$1 AND project_id=$2 AND batch_id=$3 AND request_key=$4`,
    [input.tenantId, input.projectId, input.batchId, input.requestKey])).rows[0];
    // The insert can lose a race it did not expect: `DO NOTHING` means a
    // concurrent append of the SAME key under different content leaves the other
    // caller's row in place and this statement inserts nothing. Reporting that as
    // a success would return the other caller's plan under this caller's name.
    //
    // `||` is the whole fix, and it is the same rule as the pre-read above. With
    // `&&` this branch only fired when BOTH the proposal digest and the revision
    // digest differed -- so a replay that changed the base REVISION but carried a
    // colliding proposal digest, or vice versa, was reported as a success. Every
    // one of the three bound values must match for this to be our own row; any
    // difference, or a row that is not there at all, is a refusal.
    if (!stored || Number(stored.base_revision) !== input.baseRevision
      || stored.base_revision_digest !== input.baseRevisionDigest
      || stored.proposal_digest !== input.proposalDigest)
      throw new IntakeSuggestionStoreErrorV1("intake_suggestion_replay_conflict");
    return this.#record(stored);
  }

  #record(row: SuggestionRow): IntakeSuggestionRecordV1 {
    const proposal = this.#verify(row, this.#key);
    const flagsByLocalId = freezeFlags(Object.fromEntries(proposal.tasks
      .map(task => [task.localId, computeIntakeFlagsV1(task)])));
    return Object.freeze({ suggestionId: row.id, tenantId: row.tenant_id, projectId: row.project_id,
      batchId: row.batch_id, requestKey: row.request_key, baseRevision: Number(row.base_revision),
      baseRevisionDigest: row.base_revision_digest, proposerIdentityId: row.proposed_by_identity_id,
      proposal: deepFreeze(proposal), proposalDigest: row.proposal_digest, flagsByLocalId,
      createdAt: iso(row.created_at), startsWork: false as const, grantsExecutionAuthority: false as const,
      savesRevision: false as const });
  }

  /** The owner prefill read. It NEVER writes a revision: it returns the stored
   * proposal for the owner's own form, and the stale check is the same bound
   * revision the write guard enforced, re-read here. */
  async prefillForOwner(input: Readonly<{ tenantId: string; projectId: string; batchId: string;
    suggestionId: string; ownerIdentityId: string; actorType: "human"; currentRevision: number;
    currentRevisionDigest: string }>): Promise<Readonly<{ proposal: WorkBatchProposalV1; startsWork: false;
      grantsExecutionAuthority: false; savesRevision: false }>> {
    if (input.actorType !== "human" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u.test(input.ownerIdentityId))
      throw new IntakeSuggestionStoreErrorV1("intake_suggestion_owner_required");
    // The view is the CURRENT-revision read, so it is the only thing a stale
    // suggestion can be looked up in -- which is why a stale one is "not found"
    // rather than "found and rejected". It carries the integrity material too, so
    // a tampered row is refused here rather than handed to the owner.
    const row = (await this.db.query<SuggestionRow>(`SELECT s.id,s.tenant_id,s.project_id,s.batch_id,
      s.request_key,s.base_revision,s.base_revision_digest,s.proposed_by_identity_id,s.proposal,
      s.proposal_digest,s.suggestion_digest,s.auth_tag,s.created_at
      FROM work_batch_current_split_suggestions s
      WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.batch_id=$3 AND s.id=$4`,
    [input.tenantId, input.projectId, input.batchId, input.suggestionId])).rows[0];
    // The view is current-revision-only, so a stale suggestion is not "found and
    // then checked" -- it is not there at all. Both refusals are the same one: the
    // owner cannot be handed a plan bound to a revision that no longer exists.
    if (!row) throw new IntakeSuggestionStoreErrorV1("intake_suggestion_stale");
    if (Number(row.base_revision) !== input.currentRevision
      || row.base_revision_digest !== input.currentRevisionDigest)
      throw new IntakeSuggestionStoreErrorV1("intake_suggestion_stale");
    return Object.freeze({ proposal: deepFreeze(this.#verify(row, this.#key)), startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const });
  }

  /** Map the database's own refusals onto the port's safe reason codes. A
   * refusal the store cannot classify is still a refusal, never a success.
   *
   * The replay refusal is the request-key unique index (0200), so it arrives as
   * PostgreSQL's own 23505 naming that index. The index name is matched, not the
   * message prose, so a localised or reworded server message does not change what
   * the caller is told -- and a DIFFERING content under a used key is the same
   * refusal as an exact one, because the key is the whole contract. */
  #refusal(error: unknown): IntakeSuggestionStoreErrorV1 {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("work_batch_split_suggestions_request_key_unique")
      || text.includes("work_batch_split_suggestion_replay_conflict"))
      return new IntakeSuggestionStoreErrorV1("intake_suggestion_replay_conflict");
    if (text.includes("work batch split suggestion insert rejected"))
      return new IntakeSuggestionStoreErrorV1("intake_suggestion_rejected");
    return new IntakeSuggestionStoreErrorV1("intake_suggestion_rejected");
  }
}

/** The durable failure counter behind 0202's control_planner_failure_counters.
 *
 * record() is ONE statement so two concurrent failures cannot both read 1 and
 * both believe they were first: INSERT ... ON CONFLICT DO UPDATE ... RETURNING
 * hands each caller the count after its own increment. The guard trigger refuses
 * every transition except increment-by-one and clear-to-zero, so a hand-written
 * UPDATE cannot invent the second failure the escalation depends on. */
export class PostgresIntakePlannerFailureStoreV1 implements IntakePlannerFailureStoreV1 {
  constructor(private readonly db: DatabaseClient,
    private readonly scope: (scopeKey: string) => Readonly<{ tenantId: string; projectId: string }>,
    private readonly now: () => string) {}

  async count(scopeKey: string): Promise<number> {
    const { tenantId, projectId } = this.scope(scopeKey);
    const row = (await this.db.query<CounterRow>(
      `SELECT failure_count, cleared_at FROM control_planner_failure_counters
       WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
    [tenantId, projectId, scopeKey])).rows[0];
    return row ? Number(row.failure_count) : 0;
  }

  /** Whether 0205's latch is set on this scope. Read-only, and deliberately not a
   * reset: the count is the evidence the Needs-you item and the guard rest on.
   *
   * The coordinator DOES hold UPDATE on the column (0202's five-column grant plus
   * 0205's, which `task_coordinator_roles.sql` and the preflight's column audit
   * both name) -- round 4 measured the earlier comment's claim that it did not,
   * and the claim was false. What is still true, and is the property this method
   * relies on, is that it only READS the column: nothing here SETS a latch, and
   * the only SQL that can is 0205's SECURITY DEFINER function, whose EXECUTE the
   * owner owns alone. The coordinator can therefore spend a latch (below) and
   * cannot mint one.
   *
   * It is a hint, not the decision. `#escalated` in the coordinator no longer
   * treats "the latch was set when I looked" as authority to run; it calls
   * `spendOwnerRetry`, which decides with the same predicate in ONE statement, so
   * twenty presses that all read this as true still produce one run. */
  async ownerRetryGranted(scopeKey: string): Promise<boolean> {
    const { tenantId, projectId } = this.scope(scopeKey);
    const row = (await this.db.query<{ owner_retry_cleared_at: string | Date | null }>(
      `SELECT owner_retry_cleared_at FROM control_planner_failure_counters
       WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
    [tenantId, projectId, scopeKey])).rows[0];
    return !!row?.owner_retry_cleared_at;
  }

  /** SPEND an owner-retry latch on this scope, and say whether it did.
   *
   * THIS IS THE R4-M1 FIX, and the shape of it is the whole point. Round 3's
   * `#escalated` read the count, read the latch, called `clear()` and IGNORED
   * `clear()`'s result, then ran. Every press that read the latch before the first
   * clear landed got a run, so one owner grant followed by twenty concurrent
   * presses produced TWENTY planner runs -- and with a working planner, fifteen
   * runs plus five throws of `planner_needs_you_not_escalated`, because a press
   * that saw the latch already spent decided "escalated" and called `raise()`
   * after another press had zeroed the counter.
   *
   * So the latch is spent ATOMICALLY here: one `UPDATE ... WHERE` that carries
   * every precondition, `RETURNING 1` when a row came back, and the coordinator
   * runs only then. PostgreSQL takes the row lock for the duration, so of twenty
   * concurrent callers exactly one re-reads the row as latch-free and the other
   * nineteen match no row. The count is zeroed in the SAME statement, which is
   * what makes a FAILED retry count as failure 1 of a new escalation rather than
   * escalating again immediately.
   *
   * The predicate is deliberately the same one 0205's grant function admits on and
   * the guard trigger admits as a clear, so "the latch was granted" and "the latch
   * was spent" cannot disagree: `owner_retry_cleared_at IS NOT NULL` (there is a
   * latch), `cleared_at IS NULL` (the counter is live), `failure_count >= 2` (it
   * really escalated), and the row is on this tenant/project/scope. `version+1`
   * and `GREATEST(updated_at, ...)` are 0205's guard's own requirements.
   *
   * Returns false rather than throwing when nothing was spent, because "another
   * press spent it first" is the ordinary outcome under concurrency and the
   * coordinator's answer to it is `needs_you`, not a 500. */
  async spendOwnerRetry(scopeKey: string): Promise<boolean> {
    const { tenantId, projectId } = this.scope(scopeKey);
    const at = this.now();
    const row = (await this.db.query<{ spent: number }>(
      `UPDATE control_planner_failure_counters SET failure_count=0, cleared_at=$4::timestamptz,
        owner_retry_cleared_at=NULL, version=version+1, updated_at=GREATEST(updated_at,$4::timestamptz)
       WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3
         AND owner_retry_cleared_at IS NOT NULL AND cleared_at IS NULL AND failure_count>=2
       RETURNING 1 AS spent`,
    [tenantId, projectId, scopeKey, at])).rows[0];
    return !!row;
  }

  async record(scopeKey: string): Promise<number> {
    const { tenantId, projectId } = this.scope(scopeKey);
    const at = this.now();
    // $4 is CAST to timestamptz in every position it appears. Without the cast
    // PostgreSQL cannot infer its type where it is only compared, and raises
    // 42P08 ("could not determine data type of parameter") instead of counting.
    //
    // The statement does NOT mention `owner_retry_cleared_at`, and that is the
    // point: 0205's guard requires the latch to be UNCHANGED by an increment, so a
    // granted retry survives a failed run and is spent only by the `clear()`. The
    // escalation bound therefore reads exactly as intended -- one extra run per
    // escalation -- and a retry that fails again lands at count 1 of a new
    // escalation rather than straight back at 2.
    const row = (await this.db.query<{ failure_count: string | number }>(
      `INSERT INTO control_planner_failure_counters AS c
         (tenant_id,project_id,scope_key,failure_count,last_failure_at,cleared_at,version,updated_at,created_at)
       VALUES($1,$2,$3,1,$4::timestamptz,NULL,1,$4::timestamptz,$4::timestamptz)
       ON CONFLICT (tenant_id,project_id,scope_key) DO UPDATE
         SET failure_count=c.failure_count+1, last_failure_at=$4::timestamptz, cleared_at=NULL,
           version=c.version+1, updated_at=GREATEST(c.updated_at,$4::timestamptz)
       RETURNING failure_count`,
    [tenantId, projectId, scopeKey, at])).rows[0];
    return Number(row?.failure_count ?? 0);
  }

  async clear(scopeKey: string): Promise<void> {
    const { tenantId, projectId } = this.scope(scopeKey);
    const at = this.now();
    // `owner_retry_cleared_at=NULL` is part of this statement, and it is what
    // SPENDS an owner-retry latch. That is deliberate: 0205's trigger admits a
    // clear only when the latch goes to NULL, so a granted retry is consumed by
    // the run it authorised and cannot authorise a second one. Without the column
    // in this UPDATE the trigger refuses the clear on a latched counter, which is
    // how the bound is enforced rather than merely intended.
    //
    // The coordinator holds UPDATE on exactly five columns plus this one, so this
    // is a sixth named column in the role grant (task_coordinator_roles.sql) --
    // without it the statement fails with permission denied, not with a trigger
    // error, which is the more confusing of the two.
    //
    // GREATEST is on both statements, and it is load-bearing rather than
    // defensive. 0202's guard requires `NEW.updated_at >= OLD.updated_at`, and
    // THREE writers share this column with three different clocks: this store
    // stamps an INJECTED `now` (which is what makes it testable), 0205's
    // `control_room_planner_grant_owner_retry` can only use the server's, and the
    // two are independent. Without GREATEST the write after a grant fails with
    // "planner failure counter update rejected" whenever the injected clock is
    // behind the server's -- measured, and it reads as a broken guard rather than
    // as two clocks. GREATEST keeps the column monotonic whichever clock wrote
    // last, which is the only property the guard asks for.
    await this.db.query(`UPDATE control_planner_failure_counters SET failure_count=0, cleared_at=$4::timestamptz,
      owner_retry_cleared_at=NULL, version=version+1, updated_at=GREATEST(updated_at,$4::timestamptz)
      WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3 AND failure_count<>0`,
    [tenantId, projectId, scopeKey, at]);
  }
}

/** The append-only Needs-you ledger behind 0202's control_planner_needs_you_items,
 * keyed in 0205 on the SCOPE THAT ESCALATED.
 *
 * The key change is measured, not stylistic. The identity used to be the request
 * key, and the browser mints a FRESH `orchestrator:<uuid>` key on every press, so
 * six presses of one description against a broken planner produced FIVE Needs-you
 * items and five open inbox items for one failure. The id is now a digest of
 * (tenant, project, scope) -- the same scope the counter that earned the
 * escalation lives on -- so any number of presses of one description converge on
 * one row and one inbox item, while two DIFFERENT descriptions in one project
 * still get two items, which is the property the project scope exists to protect.
 *
 * The request key is still STORED, because it is the honest evidence of which
 * request hit the second failure and the owner-facing view still names it. It
 * stops being the identity. */
export class PostgresIntakeNeedsYouStoreV1 implements IntakePlannerNeedsYouPortV1 {
  constructor(private readonly db: DatabaseClient,
    private readonly principal: () => Readonly<{ identityId: string }>,
    private readonly now: () => string) {}

  async raise(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    reasonCode: "orchestrator_failed_twice"; ownerRequest: string; now: string }>): Promise<void> {
    const { tenantId, projectId } = input;
    const id = this.principal().identityId;
    // The escalation must be TRUE, and for THIS request: the counter has to be
    // at 2 or more and live. The counter is matched on the RAISED request, not
    // merely the project: one project can have several planner requests in
    // flight, and the second failure of one of them must not license an
    // escalation for another.
    //
    // The scope key is a DIGEST (`initial:<hex>` or `project:<hex>`), not a
    // readable string ending in the request key, so the old
    // `scope_key LIKE '%:' || $3` test no longer identifies it. The digest is
    // recomputed here from the same three values the coordinator used, which is
    // why this adapter takes the description's part of the scope rather than
    // trusting a caller-supplied key string.
    //
    // The guard trigger in 0202 re-checks exactly this and its own predicate
    // needs the same treatment; `plannerNeedsYouScopeKeysV1` is the single
    // definition of "which counters may license this raise", shared by the
    // adapter and the migration, and a mismatch fails the raise rather than
    // passing quietly.
    const counters = plannerNeedsYouScopeKeysV1(tenantId, projectId, input.requestKey, input.ownerRequest);
    // $3 is the array. The parameters are numbered without a gap so PostgreSQL can
    // infer every type: an unused placeholder is not allowed in a parameter list,
    // and `= ANY($N::text[])` needs the array itself, not a joined string.
    //
    // THE ESCALATING SCOPE ITSELF IS SELECTED, not just its count, because 0205
    // made the scope the ledger's identity. A single `LIMIT 1` over a count was
    // not enough to build the row: the id, the action-item id and the ON CONFLICT
    // target all have to name the scope that earned the escalation, and a second
    // press of the same description reaches this with a DIFFERENT request key, so
    // the two candidate scopes are different strings and picking either one
    // blindly would let a raise be filed against a counter that did not earn it.
    // The ORDER BY is deterministic on purpose: `failure_count DESC` then
    // `scope_key` ascending, so two equally-escalated scopes resolve to the same
    // row every time rather than alternating between presses.
    const counter = (await this.db.query<CounterRow>(
      `SELECT failure_count, scope_key FROM control_planner_failure_counters
       WHERE tenant_id=$1 AND project_id=$2 AND failure_count>=2 AND cleared_at IS NULL
         AND scope_key = ANY($3::text[])
       ORDER BY failure_count DESC, scope_key ASC LIMIT 1`,
    [tenantId, projectId, counters])).rows[0];
    if (!counter) throw new Error("planner_needs_you_not_escalated");
    // The description DIGEST, never the description: 0204's guard recomputes the
    // project scope from it, and the Needs-you ledger stays content-free exactly
    // as 0202's header promised. sha256Digest is the same sha256 over the same
    // canonical JSON the SQL helper computes, which the production test proves by
    // requiring this INSERT to be accepted.
    //
    // The identity is sha256 over (tenant, project, scope) TRUNCATED to the 32
    // hex characters 0202's id CHECK allows, and the trigger recomputes it from
    // the row's own values -- so the digest is a shape both sides derive rather
    // than a string only this adapter can produce.
    await this.db.query(`INSERT INTO control_planner_needs_you_items
      (id,tenant_id,project_id,request_key,reason_code,failure_count,raised_by_identity_id,raised_at,
        action_item_id,owner_request_digest,scope_key)
      VALUES('planner-needs-you:' || substring(encode(sha256(convert_to($1 || '/' || $2 || '/' || $4,'UTF8')),'hex') from 1 for 32),
        $1,$2,$3,'orchestrator_failed_twice',$5::bigint,$6,$7::timestamptz,
        'attention:planner:' || substring(encode(sha256(convert_to($1 || '/' || $2 || '/' || $4,'UTF8')),'hex') from 1 for 32),
        $8,$4)
      -- BARE ON CONFLICT, and both indexes matter, which the twenty-press stress
      -- proved the hard way. Naming only the scope index covers a concurrent
      -- raise of the same SCOPE, but 19 of 20 concurrent raises of one
      -- description then failed with a primary-key violation instead: they
      -- collide on (tenant_id, id), which is a different constraint, and
      -- PostgreSQL only suppresses the one the target names. The bare form covers
      -- every unique constraint, which is the only way "twenty presses of one
      -- description are one item" is true at the database rather than only in
      -- sequence.
      ON CONFLICT DO NOTHING`,
    [tenantId, projectId, input.requestKey, String(counter.scope_key),
      Number(counter.failure_count), id, input.now, sha256Digest({ ownerRequest: input.ownerRequest })]);
    // ONE inbox item per escalating scope, and the id is the SAME digest, so a
    // repeat of the same escalation re-uses the row and the payload below -- which
    // is why `work_item_id` names the request key that FIRST escalated rather
    // than whichever request happened to be pressed last. Six presses of one
    // description therefore leave one open item, not six.
    const first = (await this.db.query<{ request_key: string }>(
      `SELECT request_key FROM control_planner_needs_you_items
       WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
    [tenantId, projectId, String(counter.scope_key)])).rows[0];
    const requestKey = first?.request_key ?? input.requestKey;
    await this.db.query(`INSERT INTO control_action_inbox
      (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
      VALUES('attention:planner:' || substring(encode(sha256(convert_to($1 || '/' || $2 || '/' || $4,'UTF8')),'hex') from 1 for 32),
        $1,$2,'planner:' || $3,'failure','open','delivered',$5::timestamptz,NULL,
        json_build_object('id','attention:planner:' || substring(encode(sha256(convert_to($1 || '/' || $2 || '/' || $4,'UTF8')),'hex') from 1 for 32),
          'tenantId',$1,'projectId',$2,'workItemId','planner:' || $3,'kind','failure','state','open',
          'requestedAction','Review the orchestrator failure','reasonCode','orchestrator_failed_twice',
          'blockedWorkItemIds','[]'::jsonb,
          'legalResponses',json_build_array(json_build_object('id','open:' || $3,'kind','open_source',
            'label','Open the failed request','requiresConfirmation',false,'available',true)),
          'evidence','[]'::jsonb,'deliveryState','delivered','createdAt',$5::timestamptz))
      -- The action inbox's key is (tenant_id, id), not (id) alone: 0019 declares
      -- it that way, and naming only the id column raises 42P10 ("no unique or
      -- exclusion constraint matching the ON CONFLICT specification") -- measured,
      -- and it reads as a missing index rather than a wrong conflict target.
      ON CONFLICT (tenant_id,id) DO NOTHING`,
    [tenantId, projectId, requestKey, String(counter.scope_key), input.now]);
  }
}

/** The owner's deliberate retry, over 0205's `control_room_planner_grant_owner_retry`.
 *
 * The owner's web login holds NO privilege on control_planner_failure_counters --
 * 0202 says so in terms and the private-web preflight's column audit enforces it
 * for every column -- so this is the only way the owner can ask for one more run
 * of a description that escalated. It cannot clear the counter itself, and it
 * cannot lower the count: the trigger behind the function admits exactly one
 * transition, and only on a live counter at 2 or more that has not already been
 * granted a retry.
 *
 * It is a SEPARATE class rather than a method on the failure store on purpose.
 * The failure store runs on the COORDINATOR login and the retry is the OWNER's
 * act, so the two are different authorities and a composition that supplied the
 * wrong one would be granting retries nobody asked for. The scope keys are the
 * caller's OWN keys -- the same `plannerNeedsYouScopeKeysV1` the raise used -- so
 * this cannot touch a counter outside the scopes this request computed.
 */
export class PostgresIntakeOwnerRetryStoreV1 {
  constructor(private readonly db: DatabaseClient) {}

  /** Grant a retry on every scope of this request that is live at >= 2.
   *
   * Returns how many counters were granted, so "nothing was granted" is
   * observable rather than silent: that is what lets the owner path tell "you
   * already have a retry waiting, press again" from "there was nothing to
   * retry", which are different sentences for the owner. */
  async grant(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    ownerRequest: string }>): Promise<number> {
    const keys = plannerNeedsYouScopeKeysV1(input.tenantId, input.projectId, input.requestKey, input.ownerRequest);
    const row = (await this.db.query<{ granted: number }>(
      `SELECT control_room_planner_grant_owner_retry($1,$2,$3::text[])::int AS granted`,
    [input.tenantId, input.projectId, keys])).rows[0];
    return Number(row?.granted ?? 0);
  }
}

/** The durable completion lookup behind 0093's control_idempotency row.
 *
 * `WorkBatchStoreV1.create` already writes the receipt there: it inserts the row
 * with status 'processing', writes the batch, then sets status 'completed' with
 * the receipt as the result, all in one transaction. So "has this request already
 * produced a proposal?" is a read of one row by the SAME key the submission uses,
 * and the answer is already durable.
 *
 * WHICH LOGIN READS IT, and why that is measured rather than chosen. The intake
 * login is the one that wrote the row, and it holds SELECT on
 * control_idempotency (production_table_grants.sql). The coordinator login does
 * NOT -- 0202 gave it the failure counter and the Needs-you ledger and nothing
 * else, so pointing this at the coordinator login fails with "permission denied
 * for table control_idempotency" (measured). The intake login is therefore the
 * right reader on both counts: it is the identity whose receipt it is, and it is
 * the one the durable row is scoped to.
 *
 * Only a COMPLETED row counts. A 'processing' row is a submission that was in
 * flight when the process died, and answering from it would hand the owner a
 * receipt for a batch that may never have been committed -- so it reads as "not
 * completed" and the caller runs, which the store's own idempotency check then
 * resolves or refuses. That is the safe direction: an extra run over a
 * fabricated receipt.
 *
 * The scope string is built to match `WorkBatchStoreV1.create` exactly. It is
 * duplicated rather than imported because the store builds it inline inside a
 * transaction and exports nothing for it; the two are held together by the
 * production test in tests/project-orchestration-postgres.test.ts, which
 * submits through the real service and then retries through this adapter and
 * requires the SAME batchId back. If either side changes its spelling, that test
 * fails rather than the retry silently re-running the planner. */
export class PostgresIntakeCompletionLookupV1 implements IntakeCompletionLookupPortV1 {
  constructor(private readonly db: DatabaseClient) {}

  async completed(input: Readonly<{ tenantId: string; projectId: string; identityId: string;
    requestKey: string; ownerRequest?: string }>): Promise<IntakeCoordinatorResultV1 | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(input.requestKey)) return null;
    // `status='completed'` IS STILL HERE, and it is not optional. Only a COMPLETED
    // row counts: a 'processing' row is a submission that was in flight when the
    // process died, and answering from it would hand the owner a receipt for a
    // batch that may never have been committed. Round 3 rewrote this SELECT to add
    // `request_digest` and dropped the predicate by accident; the B2c mutation's
    // anchor then no longer existed, which is what surfaced it.
    const row = (await this.db.query<{ result: unknown; request_digest: string }>(`SELECT result, request_digest
      FROM control_idempotency
      WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3 AND status='completed'`,
    [input.tenantId, `work-batches.propose/v1:${input.identityId}`, input.requestKey])).rows[0];
    const receipt = workBatchReceiptSchemaV1.safeParse(row?.result);
    if (!row || !receipt.success) return null;
    // A COMPLETED key must not answer a DIFFERENT description (N8), and the fix
    // is to refuse rather than to guess.
    //
    // The key alone says nothing about what was asked. Measured in review round 2:
    // the same key with a DIFFERENT description returned the OLD receipt,
    // `submitted` with `replayed: true`, no run and no refusal -- so a caller that
    // reused a key for a new job was told that job had been prepared, and the
    // answer to it was never computed. The browser cannot reach this (its retry
    // always resends the retained body, and its describe mints a fresh key),
    // which is exactly why a direct API caller could and nothing noticed.
    //
    // AND THIS REFUSAL IS NOT REACHED FROM THE COORDINATOR, which is round 4's N8
    // finding restated honestly rather than defended. The coordinator does not pass
    // `ownerRequest` here, and must not: its recovery path -- the owner retrying a
    // describe that succeeded, with the browser resending the RETAINED BODY -- is
    // the one this port exists to answer, and forwarding the description would make
    // every such retry answer `null`, spend a second planner run and collide with
    // its own earlier work. Two callers that arrive identically need opposite
    // answers, so one of them has to lose, and the one that loses here is the
    // different-description caller, because losing it costs a run while losing
    // recovery costs a false failure for work that already succeeded. The argument
    // is written out on `IntakeCompletionLookupPortV1`, which is where a future
    // wiring has to start: it needs a caller-declared retry, not a pass-through.
    //
    // WHY THIS REFUSES RATHER THAN COMPARES. The stored `request_digest` is
    // `sha256Digest({ identityId, idempotencyKey, proposalDigest })` -- a digest
    // of the PLANNER'S OUTPUT. The owner cannot recompute it before the planner
    // has run, so a description can never win that comparison, and comparing
    // anything else would be comparing something that is not what the key
    // identified. So a caller that supplies a description gets NO answer from
    // storage, which is the direction this store already takes for everything it
    // cannot establish, and the safe one: a repeat may cost a run, but it can never
    // be answered with a receipt for work nobody asked for. The submission's own
    // replay comparison then refuses a differing body under a used key, so the
    // caller is told "conflict" rather than handed the wrong batch.
    //
    // The port therefore does NOT take a description. It cannot use one, and an
    // optional parameter that is ignored is a promise the type does not keep.
    if (input.ownerRequest !== undefined) return null;
    // The stored receipt is re-parsed, never passed through: `result` is a jsonb
    // column, and a row that does not parse is not a receipt this adapter is
    // willing to hand the owner. It is also scoped to the project that was asked
    // about: a completed receipt for a DIFFERENT project is not this project's
    // proposal, and answering with it would send the owner to somebody else's
    // batch page.
    if (receipt.data.projectId !== input.projectId) return null;
    // The stored receipt carries no proposal and no flags -- it is deliberately
    // the minimal answer to "which batch did this request produce", and it is
    // `.strict()`, so nothing else can be smuggled into the column. That is
    // exactly right for a retry: the owner is sent to the batch page, which is
    // where the proposal is read from, and the flags are recomputed there from
    // the batch. Reporting an empty flag map rather than a fabricated one is the
    // honest answer, and the only caller of this path is the retry.
    return Object.freeze({ ...common, status: "submitted" as const,
      submission: Object.freeze({ ...receipt.data, replayed: true }),
      flagsByLocalId: Object.freeze({}) });
  }
}

/** TODO(s7b): the production planner-run allowance adapter.
 *
 * Plan v4.3 2.1 requires each orchestrator run to consume ONE S7b allowance,
 * idempotently, keyed by tenant, project and request key, and to retain the
 * worker, model, the `orchestrator:<model>` scorecard key and the start time.
 *
 * THE ALLOWANCE MIGRATIONS ARE ON THIS TREE NOW -- 0150 adds
 * pipeline_installation_allowances and 0154 adds pipeline_advance_receipts, both
 * visible in the coordinator's own read list above -- so the comment this replaced,
 * which said they were NOT and would land with S7b, was stale and wrong. Round 4
 * found it still here after the round-3 report claimed it had been fixed, which is
 * why it is corrected here rather than deleted: deleting it would leave the next
 * reader with a TODO and no reason, and the reason it was wrong is the evidence.
 *
 * What is STILL true, and is why the port stays unwired rather than guessed: the
 * tables that exist are the INSTALLATION's caps (`runs_per_hour`,
 * `runs_per_agent_per_day`, `dollar_cap_microusd`, ...) and a pipeline advance
 * receipt, not the per-run consumption row 2.1 asks for. Consumption is
 * idempotent by tenant, project and request key, which is a different key from
 * `pipeline_advance_receipts`'s. Pointing `consume` at a table name or column that
 * is merely plausible would produce an adapter that compiles, passes its own tests
 * and is wrong at run time.
 *
 * Until then this port refuses, and the refusal is honest: twenty concurrent
 * presses with no allowance adapter gave twenty `allowance_refused:
 * planner_allowance_not_configured`, 0 runs, 0 counters and 0 batches (round 4), and
 * a granted retry is SPENT by that refusal -- worth knowing, because the owner's
 * retry evaporates silently. The fix belongs with the real consumption row.
 *
 * The coordinator's own call site (`allowance.consume(...)` in
 * intake-coordinator.ts) needs no change when that row lands. */
export class UnwiredPlannerAllowanceV1 implements IntakePlannerRunAllowancePortV1 {
  async consume(_input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    scorecardKey: string; workerId: string; model: string; now: string }>):
    Promise<Readonly<{ allowed: true } | { allowed: false; reasonCode: string }>> {
    // A refusal, not an allow. A missing allowance must never look like a spent
    // one, and "no allowance adapter" must never read as "allowed".
    return Object.freeze({ allowed: false as const, reasonCode: "planner_allowance_not_configured" });
  }
}
