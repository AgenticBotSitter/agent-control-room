import { z } from "zod";
import type { AuthenticatedPrincipal } from "../../security";
import { sha256Digest } from "../../security";
import { workBatchProposalDigestV1 } from "./digest";
import { computeIntakeFlagsV1, type IntakeFlagV1 } from "./intake-gate";
import { captureWorkBatchQueueCatalogV1, resolveWorkBatchQueueWorkerV1,
  type WorkBatchQueueCatalogV1, type WorkBatchQueueSelectionV1 } from "./queue-catalog";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "./schemas";
import type { WorkBatchServiceV1, WorkBatchSubmissionResultV1 } from "./service";
import { validateWorkBatchProposalV1, type WorkBatchRejectionCodeV1 } from "./validation";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const requestText = z.string().trim().min(1).max(16_000);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const plannerSelectionSchemaV1 = z.object({ workerId: id,
  workerKind: z.enum(["codex", "claude-code", "hermes"]), modelKey: z.string().min(1).max(180).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max", "default"]).optional() }).strict();

export type IntakePlannerSelectionV1 = z.infer<typeof plannerSelectionSchemaV1>;
export type IntakePlannerResolvedSelectionV1 = WorkBatchQueueSelectionV1;

export interface IntakePlannerSelectionPortV1 {
  read(projectId: string): Promise<IntakePlannerSelectionV1 | null> | IntakePlannerSelectionV1 | null;
}

export interface IntakePlannerPortV1 {
  run(input: Readonly<{ projectId: string; requestKind: "initial" | "resplit";
    requestKey: string;
    ownerRequestData: Readonly<{ classification: "untrusted_job_text"; text: string }>;
    currentProposal?: WorkBatchProposalV1; queueCatalog: WorkBatchQueueCatalogV1;
    planner: IntakePlannerResolvedSelectionV1; signal?: AbortSignal }>): Promise<Readonly<{ replyText: string }>>;
}

/** Production adapters consume the same S7b allowance used by ordinary runs.
 * Consumption is idempotent by tenant, project, and request key. A successful
 * call means the run has been counted, not that work may start. */
export interface IntakePlannerRunAllowancePortV1 {
  consume(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    scorecardKey: string; workerId: string; model: string; now: string }> ):
    Promise<Readonly<{ allowed: true } | { allowed: false; reasonCode: string }>>;
}

export interface IntakePlannerFailureStoreV1 {
  count(scopeKey: string): Promise<number> | number;
  record(scopeKey: string): Promise<number> | number;
  clear(scopeKey: string): Promise<void> | void;
  /** Whether the owner has been GRANTED one more run of this scope, which is how
   * a description that escalated stops being dead.
   *
   * It is deliberately a read of a grant and not a reset of the count. The
   * failure count is the evidence the Needs-you item and the guard both rest on,
   * so lowering it would erase the fact that this description failed twice. The
   * grant is instead CONSUMED by the clear that the run performs, so at most one
   * retry exists per escalation and the next escalation (two fresh failures) is
   * what earns the next one.
   *
   * A READ IS NOT THE DECISION. Round 4 measured twenty concurrent presses after
   * one grant producing twenty runs: every press read this as true before the
   * first clear landed. A store that implements `spendOwnerRetry` decides the
   * question with one conditional UPDATE instead, and the coordinator runs only
   * when it comes back true -- so `ownerRetryGranted` is a fast path and a hint,
   * and never the authority.
   *
   * A store that does not support the retry returns FALSE, which is the old
   * behaviour: the escalation check refuses the press, exactly as it did before
   * this method existed. An unconfigured composition therefore cannot issue a
   * free run by accident. */
  ownerRetryGranted?(scopeKey: string): Promise<boolean> | boolean;
  /** ATOMICALLY spend a granted retry on this scope, and report whether it did.
   *
   * Returns true for exactly one caller per granted retry, however many race.
   * False means either "there was no latch", or "another caller spent it first",
   * or "the counter was no longer live at >= 2" -- and the coordinator answers all
   * three the same way, with `needs_you`, so a lost race is a normal outcome
   * rather than an error.
   *
   * A store WITHOUT this method falls back to `ownerRetryGranted()` followed by
   * `clear()`, which is the round-3 behaviour: correct in sequence, and unbounded
   * under concurrency. That fallback exists so an in-memory double needs no
   * rewrite; the real stores implement it, and the production test drives one
   * grant against twenty concurrent presses through the real coordinator. */
  spendOwnerRetry?(scopeKey: string): Promise<boolean> | boolean;
}

export interface IntakePlannerNeedsYouPortV1 {
  /** Idempotent by tenant, project, and request key.
   *
   * `ownerRequest` is the description the failing request carried. The port uses
   * it to recompute the project-level failure scope, because the owner's repeat
   * mints a fresh request key and a raise that only knew the key could not tell
   * whether the counter it was escalating was the one this description reached. */
  raise(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    reasonCode: "orchestrator_failed_twice"; ownerRequest: string; now: string }> ): Promise<void> | void;
}

export type IntakeSuggestionRecordV1 = Readonly<{ suggestionId: string; tenantId: string; projectId: string;
  batchId: string; requestKey: string; baseRevision: number; baseRevisionDigest: string; proposerIdentityId: string;
  proposal: WorkBatchProposalV1; proposalDigest: string; flagsByLocalId: Readonly<Record<string, readonly IntakeFlagV1[]>>;
  createdAt: string; startsWork: false; grantsExecutionAuthority: false; savesRevision: false }>;

export interface IntakeSuggestionStoreV1 {
  append(input: Omit<IntakeSuggestionRecordV1, "suggestionId" | "startsWork" | "grantsExecutionAuthority" | "savesRevision">):
    Promise<IntakeSuggestionRecordV1> | IntakeSuggestionRecordV1;
  prefillForOwner(input: Readonly<{ tenantId: string; projectId: string; batchId: string; suggestionId: string;
    ownerIdentityId: string; actorType: "human"; currentRevision: number; currentRevisionDigest: string }> ):
    Promise<Readonly<{ proposal: WorkBatchProposalV1; startsWork: false; grantsExecutionAuthority: false;
      savesRevision: false }>> | Readonly<{ proposal: WorkBatchProposalV1; startsWork: false;
        grantsExecutionAuthority: false; savesRevision: false }>;
}

type SubmissionPort = Pick<WorkBatchServiceV1, "submit" | "authorizeBeforeBody">;
type AcceptedSubmission = Exclude<WorkBatchSubmissionResultV1, { accepted: false }>;
type RefusalReason = WorkBatchRejectionCodeV1 | "planner_reply_route_invalid" | "planner_reply_capability_invalid"
  | "coordinator_request_conflict" | "planner_proposer_unauthorized" | "submission_refused";
type CommonResult = Readonly<{ startsWork: false; grantsExecutionAuthority: false }>;
export type IntakeCoordinatorResultV1 =
  | (CommonResult & { status: "manual"; ownerRequestData: string })
  | (CommonResult & { status: "submitted"; submission: AcceptedSubmission;
      flagsByLocalId: Readonly<Record<string, readonly IntakeFlagV1[]>> })
  | (CommonResult & { status: "suggested"; suggestion: IntakeSuggestionRecordV1 })
  | (CommonResult & { status: "refused"; reasonCode: RefusalReason })
  | (CommonResult & { status: "planner_failed"; reasonCode: "planner_run_failed"; failureCount: 1 })
  | (CommonResult & { status: "needs_you"; reasonCode: "orchestrator_failed_twice" })
  | (CommonResult & { status: "allowance_refused"; reasonCode: string })
  | (CommonResult & { status: "stopped" });

/** The durable record of an already-finished request, and the only way the
 * coordinator can answer a repeat without running a planner again.
 *
 * This exists because "one planning run per request" has to be true for the
 * WHOLE life of a request, not only while one attempt is in flight. The
 * coordinator's in-flight map covers a concurrent repeat, and it is correct: 20
 * simultaneous describes on one key produce 1 run. But a repeat that arrives
 * AFTER the first attempt finished finds no in-flight entry, and without this
 * port it would spend another planner run and then collide with its own earlier
 * work. Measured against the real coordinator before this port existed: first
 * describe submitted, then three exact retries each ran the planner again and
 * each threw `replay_conflict`, while the allowance counted the repeat as
 * allowed-but-uncounted. So the owner was told the chief of staff "could not be
 * reached" for a proposal that already existed, and every further press was a
 * free planner run.
 *
 * `null` means "no completed result under this key", and is the only answer that
 * authorises a run. Implementations must not synthesise one: a fabricated
 * receipt would hand the owner a batch id that does not exist, which is worse
 * than an extra run. */
export interface IntakeCompletionLookupPortV1 {
  /** The stored outcome of a request that has already completed, or null.
   *
   * `identityId` is part of the lookup because the durable key is per-identity:
   * 0093 scopes control_idempotency to `work-batches.propose/v1:<identityId>`,
   * so the same request key under a different identity is a different request and
   * must not be answered from the first one's receipt.
   *
   * `ownerRequest` is OPTIONAL and the coordinator DOES NOT PASS IT. That is a
   * decision, not an omission, and round 4's N8 finding -- which called the
   * refusal dead code in production -- is what forced it to be stated here rather
   * than left as an apparent gap.
   *
   * The two paths that reach this lookup need opposite answers:
   *
   *   * The RECOVERY path is the reason this port exists. The owner lost the
   *     response to a describe that succeeded, presses again, and the browser
   *     resends the RETAINED BODY under the SAME key. It must be answered from
   *     storage, or the press spends a second planner run and then collides with
   *     its own earlier work -- measured before this port existed as three exact
   *     retries each running the planner and each throwing `replay_conflict`.
   *
   *   * The N8 case is a caller that reuses a COMPLETED key for a DIFFERENT
   *     description. Answering it from storage tells that caller a job it never
   *     asked for has been prepared, and the answer to what it actually asked is
   *     never computed.
   *
   * Nothing in the request distinguishes them: both arrive as (tenant, project,
   * identity, requestKey), and the stored `request_digest` is over the planner's
   * OUTPUT, which the owner cannot compute before the planner has run. So the
   * refusal has to be the answer for one of them, and it is the DIFFERENT-description
   * one that must lose -- losing it costs a run, while losing the recovery costs a
   * false "could not be reached" for a proposal that already exists, which is the
   * failure this port was written to remove.
   *
   * WHICH MEANS THE PORT'S `ownerRequest` PARAMETER IS UNREACHABLE FROM THE
   * COORDINATOR, and an implementation that honours it must never be reached by
   * this path. It is kept because a DIRECT caller of the port is a different
   * question with a different answer, and because the honest response to "this key
   * may not be yours" is still `null`. A future wiring must arrive with the
   * distinction that makes it safe -- a caller-declared retry of a retained body,
   * not an unconditional pass-through -- and must not simply forward the
   * description, which would break recovery. */
  completed(input: Readonly<{ tenantId: string; projectId: string; identityId: string; requestKey: string;
    ownerRequest?: string }>): Promise<IntakeCoordinatorResultV1 | null> | IntakeCoordinatorResultV1 | null;
}

type InitialInput = Readonly<{ principal: AuthenticatedPrincipal; projectId: string; ownerRequest: string;
  idempotencyKey: string; now: string; signal?: AbortSignal }>;
type ResplitInput = Readonly<{ principal: AuthenticatedPrincipal; projectId: string; ownerRequest: string;
  requestKey: string; batchId: string; baseRevision: number; baseRevisionDigest: string;
  currentProposal: WorkBatchProposalV1; now: string; signal?: AbortSignal }>;

/** What a failure has to carry to be counted and to be escalated: both scopes,
 * and the identity/project/request the raise is written for. */
type FailureInput = Readonly<{ failureScope: string; projectScope: string; principal: AuthenticatedPrincipal;
  projectId: string; requestKey: string; ownerRequest: string; now: string }>;

/** The two literal false fields every coordinator result carries. Exported so the
 * production completion adapter builds a result with the same object identity
 * rather than a second spelling of "this grants nothing". */
export const common = Object.freeze({ startsWork: false, grantsExecutionAuthority: false } as const);

export class InMemoryIntakePlannerFailureStoreV1 implements IntakePlannerFailureStoreV1 {
  readonly #counts = new Map<string, number>();
  readonly #retries = new Set<string>();
  count(scopeKey: string): number { return this.#counts.get(scopeKey) ?? 0; }

  /** Record one failure, and return the count AFTER it.
   *
   * The count is the evidence the Needs-you item and the guard both rest on, so
   * it is only ever incremented or cleared -- never lowered, and never reset by a
   * grant. The "a failed retry is failure 1 of a NEW escalation" rule lives in the
   * COORDINATOR, which clears the scope before spending a granted run; the first
   * draft put it here instead, incremented 2 -> 3, and the press after a granted
   * retry escalated again -- caught by the bounded-retry test. */
  record(scopeKey: string): number {
    const count = this.count(scopeKey) + 1;
    this.#counts.set(scopeKey, count);
    return count;
  }
  /** Zero the count and spend any latch, which is the one transition 0205's
   * guard admits and the one the store's SQL performs in a single statement.
   * The coordinator calls it after a success and, deliberately, BEFORE a run the
   * owner was granted -- so a failed retry counts as failure 1 of a new
   * escalation rather than as a third. */
  clear(scopeKey: string): void { this.#counts.delete(scopeKey); this.#retries.delete(scopeKey); }
  ownerRetryGranted(scopeKey: string): boolean { return this.#retries.has(scopeKey); }
  /** The ATOMIC spend, and it is synchronous inside one turn, which is what makes
   * it a fair double for the real store: there is no await between the check and
   * the removal, so twenty interleaved callers can never both pass the check.
   * A double that read, awaited and then removed would reproduce the very race
   * R4-M1 is about, and the in-memory suite would go green on a bug the database
   * suite catches. */
  spendOwnerRetry(scopeKey: string): boolean {
    if (!this.#retries.has(scopeKey)) return false;
    if ((this.#counts.get(scopeKey) ?? 0) < 2) return false;
    this.#retries.delete(scopeKey);
    this.#counts.delete(scopeKey);
    return true;
  }
  /** The owner's deliberate retry, for tests and for an in-process composition.
   * The real durable grant is 0205's `control_room_planner_grant_owner_retry`,
   * which the database constrains; this double has no database to constrain it,
   * so it takes the same precondition as an argument rather than assuming it. */
  grantOwnerRetry(scopeKey: string, { atLeast = 2 }: { atLeast?: number } = {}): boolean {
    if (this.count(scopeKey) < atLeast || this.#retries.has(scopeKey)) return false;
    this.#retries.add(scopeKey);
    return true;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function cloneProposal(value: WorkBatchProposalV1): WorkBatchProposalV1 {
  return deepFreeze(workBatchProposalSchemaV1.parse(structuredClone(value)));
}

export class InMemoryIntakeSuggestionStoreV1 implements IntakeSuggestionStoreV1 {
  readonly #records: IntakeSuggestionRecordV1[] = [];
  #sequence = 0;

  append(input: Omit<IntakeSuggestionRecordV1, "suggestionId" | "startsWork" | "grantsExecutionAuthority" | "savesRevision">):
    IntakeSuggestionRecordV1 {
    const proposal = cloneProposal(input.proposal);
    const replay = this.#records.find(candidate => candidate.tenantId === input.tenantId
      && candidate.projectId === input.projectId && candidate.batchId === input.batchId
      && candidate.requestKey === input.requestKey);
    if (replay) {
      if (replay.baseRevision !== input.baseRevision || replay.baseRevisionDigest !== input.baseRevisionDigest
        || replay.proposalDigest !== input.proposalDigest) throw new Error("intake_suggestion_replay_conflict");
      return replay;
    }
    // A SINGLE append, synchronised, so two concurrent appends of the same
    // request key cannot both miss the replay search above and both insert. The
    // search-and-insert was two steps in one turn, and JS does not interleave
    // turns -- but it does interleave AWAITS, and the production store awaits its
    // database between the same two steps. Doing the whole thing inside one
    // synchronous turn is what makes the double's contract the same here and
    // there, and the production unique index remains the real guarantee.
    const record = Object.freeze({ ...input, suggestionId: `suggestion:${this.#sequence + 1}`,
      proposal, flagsByLocalId: freezeFlags(input.flagsByLocalId), startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const });
    this.#records.push(record);
    this.#sequence += 1;
    return record;
  }

  prefillForOwner(input: Readonly<{ tenantId: string; projectId: string; batchId: string; suggestionId: string;
    ownerIdentityId: string; actorType: "human"; currentRevision: number; currentRevisionDigest: string }>) {
    if (input.actorType !== "human" || !id.safeParse(input.ownerIdentityId).success)
      throw new Error("intake_suggestion_owner_required");
    const record = this.#records.find(candidate => candidate.suggestionId === input.suggestionId
      && candidate.tenantId === input.tenantId && candidate.projectId === input.projectId
      && candidate.batchId === input.batchId);
    if (!record) throw new Error("intake_suggestion_not_found");
    if (record.baseRevision !== input.currentRevision || record.baseRevisionDigest !== input.currentRevisionDigest)
      throw new Error("intake_suggestion_stale");
    return Object.freeze({ proposal: cloneProposal(record.proposal), startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const });
  }
}

function freezeFlags(value: Readonly<Record<string, readonly IntakeFlagV1[]>>) {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([localId, flags]) =>
    [localId, Object.freeze(flags.map(flag => Object.freeze({ ...flag })))])));
}

function flagsFor(proposal: WorkBatchProposalV1): Readonly<Record<string, readonly IntakeFlagV1[]>> {
  return freezeFlags(Object.fromEntries(proposal.tasks.map(task => [task.localId, computeIntakeFlagsV1(task)])));
}

function stopped(): IntakeCoordinatorResultV1 { return Object.freeze({ ...common, status: "stopped" as const }); }

/** The failure scope for a single request. Exported because the needs-you
 * adapter has to recompute it to check that an escalation is earned, and two
 * spellings of the same digest is two chances to disagree. */
export function intakeRequestScopeV1(kind: "initial" | "resplit", tenantId: string, projectId: string, requestKey: string) {
  return `${kind}:${sha256Digest({ tenantId, projectId, requestKey }).slice(7)}`;
}

/** The failure scope for a project and a description. Exported for the same
 * reason as `intakeRequestScopeV1`.
 *
 * The description enters as its OWN DIGEST, not as text, and that is what makes
 * 0204's guard able to verify the scope: the trigger cannot see the description,
 * only the `owner_request_digest` column the raise carries, so the scope has to
 * be computable from the digest alone. Hashing the hash is the standard way to
 * get "a value derived from X, verifiable from a commitment to X", and it keeps
 * the two definitions byte-identical without either side holding the text. */
export function intakeProjectScopeV1(kind: "initial" | "resplit", tenantId: string, projectId: string,
  ownerRequest: string) {
  return `project:${sha256Digest({ kind, tenantId, projectId,
    ownerRequest: sha256Digest({ ownerRequest }) }).slice(7)}`;
}

/** Every counter key that may license a Needs-you raise for one request: the
 * request's own scope, and the project/description scope its owner would share
 * on a repeat press.
 *
 * This is the single definition, used by the production needs-you adapter to
 * decide whether an escalation is earned and mirrored by 0204's guard trigger in
 * the database. The two must agree or the raise is refused -- and it is refused
 * rather than passed, so a disagreement fails closed onto "no Needs-you" instead
 * of onto "a Needs-you nobody earned". */
export function plannerNeedsYouScopeKeysV1(tenantId: string, projectId: string, requestKey: string,
  ownerRequest: string) {
  return [intakeRequestScopeV1("initial", tenantId, projectId, requestKey),
    intakeRequestScopeV1("resplit", tenantId, projectId, requestKey),
    intakeProjectScopeV1("initial", tenantId, projectId, ownerRequest),
    intakeProjectScopeV1("resplit", tenantId, projectId, ownerRequest)];
}

/** Coordinates untrusted planner text. It does not expose any owner decision,
 * assignment, execution, or revision-write operation to the planner. */
export class IntakeCoordinatorV1 {
  readonly #catalog: WorkBatchQueueCatalogV1;
  readonly #capabilities: ReadonlySet<string>;
  readonly #completions: IntakeCompletionLookupPortV1 | undefined;
  readonly #inFlight = new Map<string, Readonly<{ digest: string; promise: Promise<IntakeCoordinatorResultV1> }>>();

  constructor(private readonly selections: IntakePlannerSelectionPortV1, private readonly planner: IntakePlannerPortV1,
    private readonly allowance: IntakePlannerRunAllowancePortV1, private readonly failures: IntakePlannerFailureStoreV1,
    private readonly needsYou: IntakePlannerNeedsYouPortV1, private readonly submissions: SubmissionPort,
    private readonly suggestions: IntakeSuggestionStoreV1, queueCatalog: WorkBatchQueueCatalogV1,
    allowedCapabilities: readonly string[], completions?: IntakeCompletionLookupPortV1) {
    this.#catalog = captureWorkBatchQueueCatalogV1(queueCatalog);
    const parsed = z.array(id).min(1).max(128).parse(allowedCapabilities);
    if (new Set(parsed).size !== parsed.length) throw new Error("intake_coordinator_configuration_invalid");
    this.#capabilities = new Set(parsed);
    // Optional, and absence means "cannot tell", NOT "never completed". An
    // unconfigured coordinator keeps exactly the behaviour it had before, which
    // is the safe direction: a repeat may cost a run, but it can never be
    // answered with a receipt nobody stored.
    this.#completions = completions;
  }

  coordinateInitial(input: InitialInput): Promise<IntakeCoordinatorResultV1> {
    if (input.principal.actorType !== "agent") throw new Error("intake_coordinator_input_invalid");
    const parsed = z.object({ projectId: id, ownerRequest: requestText,
      idempotencyKey: z.string().min(12).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
      now: z.string().datetime() }).strict().parse({ projectId: input.projectId,
      ownerRequest: input.ownerRequest, idempotencyKey: input.idempotencyKey, now: input.now });
    return this.#singleFlight(`initial:${input.principal.tenantId}:${parsed.projectId}:${parsed.idempotencyKey}`,
      sha256Digest({ ...parsed, identityId: input.principal.identityId }), () => this.#coordinate({ ...input, ...parsed,
        requestKind: "initial", requestKey: parsed.idempotencyKey,
        failureScope: this.#requestScope("initial", input.principal.tenantId, parsed.projectId, parsed.idempotencyKey),
        projectScope: this.#projectScope("initial", input.principal.tenantId, parsed.projectId, parsed.ownerRequest) }));
  }

  coordinateResplit(input: ResplitInput): Promise<IntakeCoordinatorResultV1> {
    const parsed = z.object({ projectId: id, ownerRequest: requestText, requestKey: id, batchId: id,
      baseRevision: z.number().int().min(1), baseRevisionDigest: digest, now: z.string().datetime(),
      currentProposal: workBatchProposalSchemaV1 }).strict().parse({ projectId: input.projectId,
      ownerRequest: input.ownerRequest, requestKey: input.requestKey, batchId: input.batchId,
      baseRevision: input.baseRevision, baseRevisionDigest: input.baseRevisionDigest, now: input.now,
      currentProposal: input.currentProposal });
    if (input.principal.actorType !== "agent" || parsed.currentProposal.projectId !== parsed.projectId
      || workBatchProposalDigestV1(parsed.currentProposal) !== parsed.baseRevisionDigest)
      throw new Error("intake_coordinator_input_invalid");
    const flightKey = `resplit:${input.principal.tenantId}:${parsed.batchId}:${parsed.baseRevision}:${parsed.requestKey}`;
    return this.#singleFlight(flightKey, sha256Digest({ ...parsed, identityId: input.principal.identityId }),
      () => this.#coordinate({ ...input, ...parsed, requestKind: "resplit",
        failureScope: this.#requestScope("resplit", input.principal.tenantId, parsed.projectId, parsed.requestKey),
        projectScope: this.#projectScope("resplit", input.principal.tenantId, parsed.projectId, parsed.ownerRequest) }));
  }

  /** The per-REQUEST failure scope, as a FIXED-LENGTH key.
   *
   * The request key is the caller's own idempotency key, and the owner adapter
   * accepts up to 180 characters of it. Spelled out as a string, `initial:` plus a
   * tenant plus a project plus a 180-character key is longer than the 180-char
   * CHECK on 0202's `scope_key`, so `record()` would raise 23514, the failure would
   * never be counted, and the second failure -- the one that is supposed to raise
   * Needs-you -- could never happen. A direct API caller reaches that; the
   * browser's 49-character keys stay inside the limit, which is why it read as
   * fine. The key is therefore a digest, which is also the right shape: the scope
   * is an internal key, and putting owner-supplied text in a database key is the
   * wrong instinct regardless of its length. */
  #requestScope(kind: "initial" | "resplit", tenantId: string, projectId: string, requestKey: string) {
    return intakeRequestScopeV1(kind, tenantId, projectId, requestKey);
  }

  /** The per-PROJECT, per-DESCRIPTION failure scope: the one the owner's repeat
   * actually shares.
   *
   * This is the reachability fix. The browser mints a fresh `orchestrator:<uuid>`
   * idempotency key on every "Prepare proposal" press, and a confirmed
   * `planner_failed` releases the retained key, so a per-request scope is a fresh
   * scope at count 1 every time. Measured against the real coordinator: four
   * presses with a fresh key gave four refusals, four planner runs and NO
   * Needs-you item, where three presses reusing one key gave the correct
   * refuse/needs_you/needs_you. So an owner facing a broken planner could press
   * forever and nothing would ever escalate.
   *
   * The owner's repeat DOES share the description, so the scope is the project
   * plus a digest of the normalised text. Two consequences worth stating: two
   * different descriptions in the same project have separate counters, so a
   * failing description cannot escalate an unrelated one; and because the digest
   * is over the request TEXT, a 16,000-character description produces a
   * 64-character key, not a 16,000-character one.
   *
   * The count is a per-project consecutive-failure count for the DESCRIPTION, and
   * it is cleared by a success on the same scope, so a working description
   * recovers. The per-request scope above is kept as well: it is what makes a
   * single stuck request escalate on its own second attempt, which is the case the
   * original counter was built for. */
  #projectScope(kind: "initial" | "resplit", tenantId: string, projectId: string, ownerRequest: string) {
    return intakeProjectScopeV1(kind, tenantId, projectId, ownerRequest);
  }

  ownerPrefill(input: Parameters<IntakeSuggestionStoreV1["prefillForOwner"]>[0]) {
    return this.suggestions.prefillForOwner(input);
  }

  #singleFlight(key: string, inputDigest: string, run: () => Promise<IntakeCoordinatorResultV1>) {
    const active = this.#inFlight.get(key);
    if (active) return active.digest === inputDigest ? active.promise : Promise.resolve(Object.freeze({ ...common,
      status: "refused" as const, reasonCode: "coordinator_request_conflict" as const }));
    const promise = run().finally(() => { if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key); });
    this.#inFlight.set(key, Object.freeze({ digest: inputDigest, promise }));
    return promise;
  }

  /** Is this request one the escalation has already stopped?
   *
   * Either scope at 2 means the same thing, and both are checked because they are
   * counted independently: the project scope is the one the owner's repeat shares,
   * and the request scope is what escalates one stuck request on its own.
   *
   * THE OWNER'S DELIBERATE RETRY IS THE WAY OUT, and it is the only one. A
   * description that hit a transient planner fault used to be dead in that
   * project forever: this check runs BEFORE the allowance and the planner, so
   * nothing could ever clear the count, the description could never succeed, and
   * the copy the owner was shown ("try again, or choose another chief of staff")
   * named two things that did not work. A grant -- issued by 0205's
   * `control_room_planner_grant_owner_retry`, on the owner's own web login, for
   * this request's own scopes -- lets exactly one more press through, and the run
   * that follows CONSUMES it. So the bound holds: one extra run per escalation,
   * never a loop, and only for an owner who asked.
   *
   * THE LATCH IS SPENT HERE AND ONLY HERE, AND IT IS SPENT ATOMICALLY (R4-M1).
   * Round 3's version read the count, read the latch, called `clear()` and
   * IGNORED whether `clear()` had cleared anything, then ran. Twenty concurrent
   * presses after one owner grant therefore all read the latch before the first
   * clear landed and ALL TWENTY ran the planner -- measured on the real
   * coordinator with the PostgreSQL stores -- and with a working planner five of
   * them then threw `planner_needs_you_not_escalated`, because a press that saw
   * the latch already spent had decided "escalated" and raised after a peer's
   * clear had zeroed the counter.
   *
   * So the decision is a SINGLE conditional UPDATE per scope (`spendOwnerRetry`),
   * which carries every precondition and reports whether a row came back. The
   * count is zeroed in the same statement, so a FAILED retry is recorded as
   * failure 1 of a NEW escalation rather than escalating again immediately. A
   * store with no `spendOwnerRetry` falls back to the read-then-clear pair, which
   * is correct in sequence and is the in-memory double's behaviour.
   *
   * The grant is checked only when the count HAS escalated, so an unconfigured
   * store (one with no `ownerRetryGranted`) answers the same way it always did. */
  async #escalated(input: Readonly<{ projectScope: string; failureScope: string }>) {
    for (const scope of [input.projectScope, input.failureScope]) {
      if (await this.failures.count(scope) < 2) continue;
      if (!(await this.#spendRetry(scope))) return true;
    }
    return false;
  }

  /** Spend this scope's owner-retry latch, and report whether this press got it.
   *
   * The atomic path first: `spendOwnerRetry` is the only call that can say yes to
   * more than one caller per grant, and it says yes to exactly one. The fallback is
   * the round-3 pair, and it is reachable only from a store that does not
   * implement the atomic form -- an in-memory double, or a composition whose
   * store predates 0205. */
  async #spendRetry(scope: string): Promise<boolean> {
    const atomic = this.failures.spendOwnerRetry?.(scope);
    if (atomic) return !!await atomic;
    if (!(await this.failures.ownerRetryGranted?.(scope))) return false;
    await this.failures.clear(scope);
    return true;
  }

  async #coordinate(input: (InitialInput & { requestKind: "initial"; requestKey: string; failureScope: string; projectScope: string })
    | (ResplitInput & { requestKind: "resplit"; failureScope: string; projectScope: string })): Promise<IntakeCoordinatorResultV1> {
    if (input.signal?.aborted) return stopped();
    // THE REPEAT IS ANSWERED FROM STORAGE, BEFORE ANY RUN IS SPENT. This is the
    // first thing #coordinate does after the cancellation check, and it is before
    // the selection read, the failure count, the allowance and the planner,
    // because every one of those can cost something: a run, an allowance unit, or
    // a counted failure on a request that already succeeded.
    //
    // "Check this exact request again" is the owner's recovery from a dropped
    // response, and it is the one path that is expected to arrive after a
    // success. Without this the repeat runs the planner a second time, gets a
    // different answer (a real LLM's replies vary), and the submission then
    // refuses with replay_conflict -- which the owner adapter reports as a 503
    // "could not be reached" for a proposal that already exists.
    //
    // The stored result is returned AS IS, including `replayed: true`, so the
    // caller can tell a receipt handed back from a receipt produced now without
    // the application having to re-derive which happened.
    const stored = await this.#completions?.completed({ tenantId: input.principal.tenantId,
      projectId: input.projectId, identityId: input.principal.identityId, requestKey: input.requestKey });
    if (stored) return stored;
    const configured = await this.selections.read(input.projectId);
    if (configured === null) return Object.freeze({ ...common, status: "manual" as const,
      ownerRequestData: input.ownerRequest });
    // THE ESCALATION CHECK. EITHER scope at 2 raises Needs-you, and the check
    // runs BEFORE the allowance and before the planner, so the third press costs
    // no run and no allowance.
    //
    // The project scope is the one that makes the rule reachable from the panel:
    // it counts consecutive failures of THIS DESCRIPTION in THIS project, and
    // the owner pressing "Prepare proposal" again shares it even though every
    // press mints a fresh idempotency key. The request scope is kept alongside so
    // one stuck request still escalates on its own second attempt, which is the
    // case the counter was originally built for.
    if (await this.#escalated(input)) return this.#raiseNeedsYou(input);
    if (input.requestKind === "resplit") {
      const authority = await this.submissions.authorizeBeforeBody(input.principal, input.projectId, input.now);
      if (!authority.allowed) return Object.freeze({ ...common, status: "refused" as const,
        reasonCode: "planner_proposer_unauthorized" as const });
    }
    const selected = plannerSelectionSchemaV1.safeParse(configured);
    if (!selected.success) return this.#plannerFailure(input);
    let resolved: ReturnType<typeof resolveWorkBatchQueueWorkerV1>;
    try {
      resolved = resolveWorkBatchQueueWorkerV1(this.#catalog, { requestedWorkerId: selected.data.workerId,
        requestedWorkerKind: selected.data.workerKind, requestedModelKey: selected.data.modelKey,
        requestedEffort: selected.data.effort });
    } catch { return this.#plannerFailure(input); }
    if (!resolved) return this.#plannerFailure(input);
    const selection = Object.freeze({ workerId: resolved.worker.workerId, workerKind: resolved.worker.workerKind,
      nodeId: resolved.worker.nodeId, selectionKey: resolved.model.selectionKey, model: resolved.model.model,
      effort: resolved.model.effort, provider: resolved.model.provider ?? null, profile: resolved.model.profile ?? null });
    const allowed = await this.allowance.consume({ tenantId: input.principal.tenantId, projectId: input.projectId,
      requestKey: input.requestKey, scorecardKey: `orchestrator:${selection.model}`,
      workerId: selection.workerId, model: selection.model, now: input.now });
    if (!allowed.allowed) return Object.freeze({ ...common, status: "allowance_refused" as const,
      reasonCode: allowed.reasonCode });
    if (input.signal?.aborted) return stopped();
    let replyText: string;
    try {
      const reply = await this.planner.run({ projectId: input.projectId, requestKind: input.requestKind,
        requestKey: input.requestKey,
        ownerRequestData: Object.freeze({ classification: "untrusted_job_text", text: input.ownerRequest }),
        ...(input.requestKind === "resplit" ? { currentProposal: cloneProposal(input.currentProposal) } : {}),
        queueCatalog: this.#catalog, planner: selection, ...(input.signal ? { signal: input.signal } : {}) });
      replyText = reply.replyText;
    } catch {
      if (input.signal?.aborted) return stopped();
      return this.#plannerFailure(input);
    }
    if (input.signal?.aborted) return stopped();
    const validated = validateWorkBatchProposalV1(replyText, input.projectId);
    if (!validated.accepted) return this.#plannerReplyFailure(input, validated.safeReasonCode);
    const routeFailure = this.#validatePlannerChoices(validated.proposal);
    if (routeFailure) return this.#plannerReplyFailure(input, routeFailure);
    const flagsByLocalId = flagsFor(validated.proposal);
    // A success clears BOTH scopes. Leaving the project counter live after a
    // success would escalate a later, unrelated failure of the same description
    // on a counter that already saw a recovery.
    await this.failures.clear(input.failureScope);
    await this.failures.clear(input.projectScope);
    if (input.requestKind === "initial") {
      const submission = await this.submissions.submit({ principal: input.principal, projectId: input.projectId,
        rawProposal: replyText, idempotencyKey: input.idempotencyKey, now: input.now });
      if ("accepted" in submission)
        return Object.freeze({ ...common, status: "refused" as const, reasonCode: "submission_refused" as const });
      return Object.freeze({ ...common, status: "submitted" as const, submission, flagsByLocalId });
    }
    const suggestion = await this.suggestions.append({ tenantId: input.principal.tenantId,
      projectId: input.projectId, batchId: input.batchId, requestKey: input.requestKey, baseRevision: input.baseRevision,
      baseRevisionDigest: input.baseRevisionDigest, proposerIdentityId: input.principal.identityId,
      proposal: validated.proposal, proposalDigest: validated.proposalDigest, flagsByLocalId, createdAt: input.now });
    return Object.freeze({ ...common, status: "suggested" as const, suggestion });
  }

  #validatePlannerChoices(proposal: WorkBatchProposalV1): "planner_reply_route_invalid"
    | "planner_reply_capability_invalid" | undefined {
    for (const task of proposal.tasks) {
      // A capability that is not even a well-formed capability name is refused BY
      // RULE, not by absence from the owner's vocabulary. Without this the two
      // refusals were the same one, and "the planner invented a capability" was
      // indistinguishable from "the planner spelled one the owner did not list".
      if (!id.safeParse(task.requiredCapability).success
        || !this.#capabilities.has(task.requiredCapability)) return "planner_reply_capability_invalid";
      if (task.requestedModelKey && !task.requestedWorkerId) return "planner_reply_route_invalid";
      if (!task.requestedWorkerId) continue;
      try {
        if (!resolveWorkBatchQueueWorkerV1(this.#catalog, task)) return "planner_reply_route_invalid";
      } catch { return "planner_reply_route_invalid"; }
    }
    return undefined;
  }

  #plannerReplyFailure(input: FailureInput, reasonCode: RefusalReason) {
    return this.#recordFailure(input, Object.freeze({ ...common, status: "refused" as const, reasonCode }));
  }

  #plannerFailure(input: FailureInput) {
    return this.#recordFailure(input, Object.freeze({ ...common, status: "planner_failed" as const,
      reasonCode: "planner_run_failed" as const, failureCount: 1 as const }));
  }

  async #recordFailure(input: FailureInput, firstFailure: IntakeCoordinatorResultV1): Promise<IntakeCoordinatorResultV1> {
    // BOTH scopes are counted, and the escalation is decided by the HIGHER of the
    // two counts, not by the request scope alone. The project scope is the one
    // the owner's repeat shares, so a fresh key per press still reaches 2; the
    // request scope still escalates a single stuck request on its own. Recording
    // only one of them is what made the rule unreachable from the panel.
    //
    // `Math.max` rather than "whichever was recorded second": the two counters
    // are independent rows and either may already be higher, so the escalation
    // has to consider both regardless of order.
    const requestCount = await this.failures.record(input.failureScope);
    const projectCount = input.projectScope === input.failureScope
      ? requestCount : await this.failures.record(input.projectScope);
    if (Math.max(requestCount, projectCount) < 2) return firstFailure;
    return this.#raiseNeedsYou(input);
  }

  async #raiseNeedsYou(input: { principal: AuthenticatedPrincipal; projectId: string; requestKey: string;
    ownerRequest: string; now: string }) {
    // The description travels with the raise so the durable adapter can recompute
    // the same project scope the coordinator counted on. Without it the adapter
    // could only match the request scope, and an escalation earned by the project
    // counter (the one the owner's repeat reaches) would be refused.
    //
    // A LOST RACE IS `needs_you`, NOT A THROW (R4-M1, the second half). The
    // decision to escalate is made from a count read some statements earlier, and
    // twenty concurrent presses on one granted retry can interleave like this:
    // press A spends the latch and zeroes the counter, press B has already read
    // count 2 and decided "escalated", and by the time B's `raise()` runs the
    // counter it names is zero -- so the adapter refuses with
    // `planner_needs_you_not_escalated` and the owner gets a generic failure for a
    // press that was correctly refused. Measured: five of twenty threw.
    //
    // So the refusal that names a counter this request can no longer see is the
    // ANSWER, not an error: the counter was cleared between the check and the
    // raise, which is the same state the press was already being refused for. It
    // is caught by NAME rather than as a blanket try/catch, so a genuinely
    // unexpected store failure still propagates -- a silent needs_you for an
    // unrelated database error would be the wrong kind of fail-closed.
    try {
      await this.needsYou.raise({ tenantId: input.principal.tenantId, projectId: input.projectId,
        requestKey: input.requestKey, reasonCode: "orchestrator_failed_twice", now: input.now,
        ownerRequest: input.ownerRequest });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("planner_needs_you_not_escalated")) throw error;
    }
    return Object.freeze({ ...common, status: "needs_you" as const, reasonCode: "orchestrator_failed_twice" as const });
  }
}
