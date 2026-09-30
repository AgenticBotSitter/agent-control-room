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
}

export interface IntakePlannerNeedsYouPortV1 {
  /** Idempotent by tenant, project, and request key. */
  raise(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    reasonCode: "orchestrator_failed_twice"; now: string }> ): Promise<void> | void;
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

type InitialInput = Readonly<{ principal: AuthenticatedPrincipal; projectId: string; ownerRequest: string;
  idempotencyKey: string; now: string; signal?: AbortSignal }>;
type ResplitInput = Readonly<{ principal: AuthenticatedPrincipal; projectId: string; ownerRequest: string;
  requestKey: string; batchId: string; baseRevision: number; baseRevisionDigest: string;
  currentProposal: WorkBatchProposalV1; now: string; signal?: AbortSignal }>;

const common = Object.freeze({ startsWork: false, grantsExecutionAuthority: false } as const);

export class InMemoryIntakePlannerFailureStoreV1 implements IntakePlannerFailureStoreV1 {
  readonly #counts = new Map<string, number>();
  count(scopeKey: string): number { return this.#counts.get(scopeKey) ?? 0; }
  record(scopeKey: string): number {
    const count = this.count(scopeKey) + 1;
    this.#counts.set(scopeKey, count);
    return count;
  }
  clear(scopeKey: string): void { this.#counts.delete(scopeKey); }
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
    const record = Object.freeze({ ...input, suggestionId: `suggestion:${++this.#sequence}`,
      proposal, flagsByLocalId: freezeFlags(input.flagsByLocalId), startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const });
    this.#records.push(record);
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

/** Coordinates untrusted planner text. It does not expose any owner decision,
 * assignment, execution, or revision-write operation to the planner. */
export class IntakeCoordinatorV1 {
  readonly #catalog: WorkBatchQueueCatalogV1;
  readonly #capabilities: ReadonlySet<string>;
  readonly #inFlight = new Map<string, Readonly<{ digest: string; promise: Promise<IntakeCoordinatorResultV1> }>>();

  constructor(private readonly selections: IntakePlannerSelectionPortV1, private readonly planner: IntakePlannerPortV1,
    private readonly allowance: IntakePlannerRunAllowancePortV1, private readonly failures: IntakePlannerFailureStoreV1,
    private readonly needsYou: IntakePlannerNeedsYouPortV1, private readonly submissions: SubmissionPort,
    private readonly suggestions: IntakeSuggestionStoreV1, queueCatalog: WorkBatchQueueCatalogV1,
    allowedCapabilities: readonly string[]) {
    this.#catalog = captureWorkBatchQueueCatalogV1(queueCatalog);
    const parsed = z.array(id).min(1).max(128).parse(allowedCapabilities);
    if (new Set(parsed).size !== parsed.length) throw new Error("intake_coordinator_configuration_invalid");
    this.#capabilities = new Set(parsed);
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
        failureScope: `initial:${input.principal.tenantId}:${parsed.projectId}:${parsed.idempotencyKey}` }));
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
      () => this.#coordinate({ ...input, ...parsed, requestKind: "resplit", failureScope: flightKey }));
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

  async #coordinate(input: (InitialInput & { requestKind: "initial"; requestKey: string; failureScope: string })
    | (ResplitInput & { requestKind: "resplit"; failureScope: string })): Promise<IntakeCoordinatorResultV1> {
    if (input.signal?.aborted) return stopped();
    const configured = await this.selections.read(input.projectId);
    if (configured === null) return Object.freeze({ ...common, status: "manual" as const,
      ownerRequestData: input.ownerRequest });
    if (await this.failures.count(input.failureScope) >= 2) return this.#raiseNeedsYou(input);
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
    await this.failures.clear(input.failureScope);
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
      if (!this.#capabilities.has(task.requiredCapability)) return "planner_reply_capability_invalid";
      if (task.requestedModelKey && !task.requestedWorkerId) return "planner_reply_route_invalid";
      if (!task.requestedWorkerId) continue;
      try {
        if (!resolveWorkBatchQueueWorkerV1(this.#catalog, task)) return "planner_reply_route_invalid";
      } catch { return "planner_reply_route_invalid"; }
    }
    return undefined;
  }

  #plannerReplyFailure(input: { failureScope: string; principal: AuthenticatedPrincipal; projectId: string;
    requestKey: string; now: string }, reasonCode: RefusalReason) {
    return this.#recordFailure(input, Object.freeze({ ...common, status: "refused" as const, reasonCode }));
  }

  #plannerFailure(input: { failureScope: string; principal: AuthenticatedPrincipal; projectId: string;
    requestKey: string; now: string }) {
    return this.#recordFailure(input, Object.freeze({ ...common, status: "planner_failed" as const,
      reasonCode: "planner_run_failed" as const, failureCount: 1 as const }));
  }

  async #recordFailure(input: { failureScope: string; principal: AuthenticatedPrincipal; projectId: string;
    requestKey: string; now: string }, firstFailure: IntakeCoordinatorResultV1): Promise<IntakeCoordinatorResultV1> {
    const count = await this.failures.record(input.failureScope);
    if (count < 2) return firstFailure;
    return this.#raiseNeedsYou(input);
  }

  async #raiseNeedsYou(input: { principal: AuthenticatedPrincipal; projectId: string; requestKey: string; now: string }) {
    await this.needsYou.raise({ tenantId: input.principal.tenantId, projectId: input.projectId,
      requestKey: input.requestKey, reasonCode: "orchestrator_failed_twice", now: input.now });
    return Object.freeze({ ...common, status: "needs_you" as const, reasonCode: "orchestrator_failed_twice" as const });
  }
}
