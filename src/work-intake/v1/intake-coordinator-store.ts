import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";
import { hmacSha256Tag } from "../../security";
import { workBatchProposalDigestV1 } from "./digest";
import { computeIntakeFlagsV1, type IntakeFlagV1 } from "./intake-gate";
import {
  InMemoryIntakePlannerFailureStoreV1, type IntakePlannerFailureStoreV1, type IntakePlannerNeedsYouPortV1,
  type IntakePlannerRunAllowancePortV1, type IntakeSuggestionRecordV1, type IntakeSuggestionStoreV1,
} from "./intake-coordinator";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "./schemas";

// The production adapters for the three IntakeCoordinatorV1 ports that need a
// database. Everything here is proposal-only: an append to an append-only
// suggestion table, a keyed counter, and a ledger row. None of them writes a
// work_batch_revision, approves a batch, admits a claim, assigns work or starts
// anything, and each carries the shape the port declares.

type SuggestionRow = { id: string; tenant_id: string; project_id: string; batch_id: string;
  request_key: string; base_revision: string | number; base_revision_digest: string;
  proposed_by_identity_id: string; proposal: unknown; proposal_digest: string;
  suggestion_digest: string; auth_tag: string; created_at: string | Date };
type CounterRow = { failure_count: string | number; cleared_at: string | Date | null };

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
    // An exact replay is answered from the stored row, not re-inserted. The
    // unique index is the real guarantee; this read is what makes a retry cheap
    // and what turns "already stored" into the same record rather than an error.
    const existing = (await this.db.query<SuggestionRow>(`SELECT id,tenant_id,project_id,batch_id,
      request_key,base_revision,base_revision_digest,proposed_by_identity_id,proposal,proposal_digest,
      suggestion_digest,auth_tag,created_at FROM work_batch_split_suggestions
      WHERE tenant_id=$1 AND project_id=$2 AND batch_id=$3 AND request_key=$4`,
    [input.tenantId, input.projectId, input.batchId, input.requestKey])).rows[0];
    if (existing) return this.#record(existing);
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
    // DO NOTHING with a differing body is exactly the replay conflict the
    // database's own trigger raises; if the row that is there is not ours, this
    // must not be reported as a success under a different content.
    if (!stored || (stored.proposal_digest !== input.proposalDigest
      && stored.base_revision_digest !== input.baseRevisionDigest))
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
   * refusal the store cannot classify is still a refusal, never a success. */
  #refusal(error: unknown): IntakeSuggestionStoreErrorV1 {
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("work_batch_split_suggestion_replay_conflict"))
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

  async record(scopeKey: string): Promise<number> {
    const { tenantId, projectId } = this.scope(scopeKey);
    const at = this.now();
    // $4 is CAST to timestamptz in every position it appears. Without the cast
    // PostgreSQL cannot infer its type where it is only compared, and raises
    // 42P08 ("could not determine data type of parameter") instead of counting.
    const row = (await this.db.query<{ failure_count: string | number }>(
      `INSERT INTO control_planner_failure_counters AS c
         (tenant_id,project_id,scope_key,failure_count,last_failure_at,cleared_at,version,updated_at,created_at)
       VALUES($1,$2,$3,1,$4::timestamptz,NULL,1,$4::timestamptz,$4::timestamptz)
       ON CONFLICT (tenant_id,project_id,scope_key) DO UPDATE
         SET failure_count=c.failure_count+1, last_failure_at=$4::timestamptz, cleared_at=NULL,
           version=c.version+1, updated_at=$4::timestamptz
       RETURNING failure_count`,
    [tenantId, projectId, scopeKey, at])).rows[0];
    return Number(row?.failure_count ?? 0);
  }

  async clear(scopeKey: string): Promise<void> {
    const { tenantId, projectId } = this.scope(scopeKey);
    const at = this.now();
    await this.db.query(`UPDATE control_planner_failure_counters SET failure_count=0, cleared_at=$4::timestamptz,
      version=version+1, updated_at=$4::timestamptz
      WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3 AND failure_count<>0`,
    [tenantId, projectId, scopeKey, at]);
  }
}

/** The append-only Needs-you ledger behind 0202's control_planner_needs_you_items.
 * Idempotent by (tenant, project, request key): the second raise of the same
 * request is the same row, and the action-inbox item is inserted with the same
 * deterministic id, so a repeat is a no-op rather than a second Needs-you. */
export class PostgresIntakeNeedsYouStoreV1 implements IntakePlannerNeedsYouPortV1 {
  constructor(private readonly db: DatabaseClient,
    private readonly principal: () => Readonly<{ identityId: string }>,
    private readonly now: () => string) {}

  async raise(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    reasonCode: "orchestrator_failed_twice"; now: string }>): Promise<void> {
    const { tenantId, projectId } = input;
    const id = this.principal().identityId;
    // The escalation must be TRUE: the counter has to be at 2 or more and live.
    // Reading it here rather than trusting a caller's count is what makes a
    // fabricated "it failed twice" impossible at the adapter, as well as in the
    // guard trigger that would otherwise catch it.
    const counter = (await this.db.query<CounterRow>(
      `SELECT failure_count FROM control_planner_failure_counters
       WHERE tenant_id=$1 AND project_id=$2 AND failure_count>=2 AND cleared_at IS NULL
       ORDER BY failure_count DESC LIMIT 1`,
    [tenantId, projectId])).rows[0];
    if (!counter) throw new Error("planner_needs_you_not_escalated");
    await this.db.query(`INSERT INTO control_planner_needs_you_items
      (id,tenant_id,project_id,request_key,reason_code,failure_count,raised_by_identity_id,raised_at,action_item_id)
      VALUES('planner-needs-you:' || substring(md5($1 || '/' || $2 || '/' || $3) from 1 for 32),
        $1,$2,$3,'orchestrator_failed_twice',$4::bigint,$5,$6::timestamptz,
        'attention:planner:' || substring(md5($1 || '/' || $2 || '/' || $3) from 1 for 32))
      ON CONFLICT (tenant_id,project_id,request_key) DO NOTHING`,
    [tenantId, projectId, input.requestKey, Number(counter.failure_count), id, input.now]);
    await this.db.query(`INSERT INTO control_action_inbox
      (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
      VALUES('attention:planner:' || substring(md5($1 || '/' || $2 || '/' || $3) from 1 for 32),
        $1,$2,'planner:' || $3,'planner_failed','open','delivered',$4::timestamptz,NULL,
        json_build_object('id','attention:planner:' || substring(md5($1 || '/' || $2 || '/' || $3) from 1 for 32),
          'tenantId',$1,'projectId',$2,'workItemId','planner:' || $3,'kind','planner_failed','state','open',
          'requestedAction','Review the orchestrator failure','reasonCode','orchestrator_failed_twice',
          'blockedWorkItemIds','[]'::jsonb,
          'legalResponses',json_build_array(json_build_object('id','open:' || $3,'kind','open_source',
            'label','Open the failed request','requiresConfirmation',false,'available',true)),
          'evidence','[]'::jsonb,'deliveryState','delivered','createdAt',$4::timestamptz))
      ON CONFLICT (id) DO NOTHING`,
    [tenantId, projectId, input.requestKey, input.now]);
  }
}

/** TODO(s7b): the production planner-run allowance adapter.
 *
 * Plan v4.3 2.1 requires each orchestrator run to consume ONE S7b allowance,
 * idempotently, keyed by tenant, project and request key, and to retain the
 * worker, model, the `orchestrator:<model>` scorecard key and the start time.
 * The S7b allowance migrations are NOT on this branch, so this port is left
 * unwired on purpose: guessing a table name or a column would produce an adapter
 * that compiles, passes its own tests and is wrong at run time.
 *
 * When S7b merges, implement `IntakePlannerRunAllowancePortV1` against its real
 * consume operation and delete this class. The coordinator's own call site
 * (`allowance.consume(...)` in intake-coordinator.ts) needs no change. */
export class UnwiredPlannerAllowanceV1 implements IntakePlannerRunAllowancePortV1 {
  async consume(_input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    scorecardKey: string; workerId: string; model: string; now: string }>):
    Promise<Readonly<{ allowed: true } | { allowed: false; reasonCode: string }>> {
    // A refusal, not an allow. A missing allowance must never look like a spent
    // one, and "no allowance adapter" must never read as "allowed".
    return Object.freeze({ allowed: false as const, reasonCode: "planner_allowance_not_configured" });
  }
}
