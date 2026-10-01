import { z } from "zod";
import type { AuthenticatedPrincipal } from "../../security";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "../../work-intake/v1/schemas";
import { captureWorkBatchQueueCatalogV1, type WorkBatchQueueCatalogV1 } from "../../work-intake/v1/queue-catalog";
import type { IntakeCoordinatorResultV1, IntakePlannerSelectionPortV1, IntakeSuggestionRecordV1,
  IntakeSuggestionStoreV1 } from "../../work-intake/v1/intake-coordinator";
import type { VerifiedWebIdentity } from "./access-verifier";
import { WebAccessError } from "./access-verifier";
import { projectOrchestrationDescribeSchemaV1, projectOrchestrationRetrySchemaV1,
  projectOrchestrationSettingsDraftSchemaV1, projectOrchestrationSettingsSchemaV1,
  projectOrchestrationSuggestionPageSchemaV1, projectOrchestrationSuggestionPrefillSchemaV1,
  type ProjectOrchestrationDescribeResultV1, type ProjectOrchestrationRetryResultV1,
  type ProjectOrchestrationSettingsV1,
  type ProjectOrchestratorChoiceV1, type ProjectOrchestratorOptionV1,
  type ProjectOrchestrationSuggestionPageV1, type ProjectOrchestrationSuggestionPrefillV1 } from "./project-orchestration-wire";

const common = Object.freeze({ startsWork: false, grantsExecutionAuthority: false } as const);
const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export interface ProjectOrchestrationAccessPortV1 {
  owner(identity: VerifiedWebIdentity, projectId: string, operation: "read" | "settings" | "describe" | "suggestion"):
    Promise<Readonly<{ tenantId: string; ownerIdentityId: string }>>;
}

export interface ProjectOrchestrationBatchRevisionPortV1 {
  read(input: Readonly<{ tenantId: string; projectId: string; batchId: string }>):
    Promise<Readonly<{ revision: number; revisionDigest: string; state: "proposed" | "not_proposed" }>>;
}

/** The durable store contract. It is EXACTLY what MIG-A's 0200/0201 shipped:
 *
 *  - `read`/`saveSettings` map to 0201's `control_project_settings` planner columns
 *    (mode, worker id, worker kind, model, effort, version). `effort` is
 *    nullable because 0201's CHECK refuses a stored 'default': the owner leaves it
 *    SQL NULL to mean the catalog's default.
 *  - `listSuggestions` maps to 0200's `work_batch_current_split_suggestions` VIEW,
 *    which is current-revision-only. The port therefore does NOT accept a stale
 *    suggestion and does not re-derive staleness; it reports what the view returns.
 *  - `dismissSuggestion` is NOT part of this contract, because no MIG-A table can
 *    hold a dismissal: 0200 is append-only, and work_batch_intake_flag_dismissals
 *    (0110) dismisses an intake FLAG on a revision, not a split suggestion. A
 *    dismissed suggestion is derived the way staleness already is -- it is not in
 *    the view -- and a composition that wants dismissal to persist supplies its
 *    own record through `dismissedSuggestionIds`, below. */
export interface ProjectOrchestrationStoreV1 extends IntakePlannerSelectionPortV1 {
  readSettings(tenantId: string, projectId: string): Promise<Readonly<{ version: number; choice: ProjectOrchestratorChoiceV1 }>>;
  saveSettings(input: Readonly<{ tenantId: string; projectId: string; expectedVersion: number;
    choice: ProjectOrchestratorChoiceV1; writtenByIdentityId: string; now: string }>):
    Promise<Readonly<{ version: number; choice: ProjectOrchestratorChoiceV1 }>>;
  listSuggestions(input: Readonly<{ tenantId: string; projectId: string; batchId: string }>):
    Promise<readonly IntakeSuggestionRecordV1[]>;
  /** Durable dismissal records for this project/batch. The adapter reads this on
   * every list, so a dismissal made in another tab hides the card here too, and a
   * gesture that was never recorded cannot be shown as if it had been. */
  dismissedSuggestionIds(input: Readonly<{ tenantId: string; projectId: string; batchId: string }>):
    Promise<readonly string[]> | readonly string[];
}

/** The durable place an owner's deliberate retry is recorded.
 *
 * It is NOT a method on the coordinator or the failure store: 0202 gives the
 * owner's web login no privilege at all on the failure counters, so the retry is a
 * separate SECURITY DEFINER call (0205's `control_room_planner_grant_owner_retry`)
 * and a composition has to supply it explicitly. Without it the retry gesture is
 * not offered, exactly as `dismissAvailable` works below. */
export interface ProjectOrchestrationRetryPortV1 {
  grant(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    ownerRequest: string }>): Promise<number>;
}

export interface ProjectOrchestrationOwnerPortV1 {
  readSettings(identity: VerifiedWebIdentity, projectId: string): Promise<ProjectOrchestrationSettingsV1>;
  saveSettings(identity: VerifiedWebIdentity, projectId: string, value: unknown): Promise<ProjectOrchestrationSettingsV1>;
  describe(identity: VerifiedWebIdentity, projectId: string, value: unknown, idempotencyKey: string,
    signal?: AbortSignal): Promise<ProjectOrchestrationDescribeResultV1>;
  /** Record that the owner wants to try an escalated description again, and say
   * whether anything was actually granted. */
  retryEscalated(identity: VerifiedWebIdentity, projectId: string, value: unknown, idempotencyKey: string):
    Promise<ProjectOrchestrationRetryResultV1>;
  listSuggestions(identity: VerifiedWebIdentity, projectId: string, batchId: string): Promise<ProjectOrchestrationSuggestionPageV1>;
  useSuggestion(identity: VerifiedWebIdentity, projectId: string, batchId: string, suggestionId: string,
    expectedRevision: number): Promise<ProjectOrchestrationSuggestionPrefillV1>;
  dismissSuggestion(identity: VerifiedWebIdentity, projectId: string, batchId: string, suggestionId: string,
    expectedRevision: number): Promise<void>;
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

/** Disposable store for component/server tests. Production must supply a durable
 * adapter -- see PostgresProjectOrchestrationStoreV1 in
 * project-orchestration-postgres-store.ts, which is the composition's default. */
export class InMemoryProjectOrchestrationStoreV1 implements ProjectOrchestrationStoreV1 {
  readonly #settings = new Map<string, { version: number; choice: ProjectOrchestratorChoiceV1 }>();
  readonly #suggestions: IntakeSuggestionRecordV1[] = [];
  readonly #dismissed = new Set<string>();
  #sequence = 0;
  constructor(private readonly tenantId: string) { id.parse(tenantId); }
  #key(projectId: string) { return `${this.tenantId}\u0000${projectId}`; }
  read(projectId: string) {
    const choice = this.#settings.get(this.#key(projectId))?.choice;
    return choice?.mode === "selected" ? Object.freeze({ workerId: choice.workerId,
      workerKind: choice.workerKind, modelKey: choice.modelKey,
      ...(choice.effort !== null ? { effort: choice.effort } : {}) }) : null;
  }
  async readSettings(tenantId: string, projectId: string) {
    if (tenantId !== this.tenantId) throw new WebAccessError("access_denied");
    return this.#settings.get(this.#key(projectId)) ?? Object.freeze({ version: 0, choice: { mode: "none" as const } });
  }
  async saveSettings(input: { tenantId: string; projectId: string; expectedVersion: number;
    choice: ProjectOrchestratorChoiceV1 }) {
    const current = await this.readSettings(input.tenantId, input.projectId);
    if (current.version !== input.expectedVersion) throw new WebAccessError("conflict");
    const saved = Object.freeze({ version: current.version + 1,
      choice: Object.freeze({ ...input.choice }) as ProjectOrchestratorChoiceV1 });
    this.#settings.set(this.#key(input.projectId), saved); return saved;
  }
  append(input: Omit<IntakeSuggestionRecordV1, "suggestionId" | "startsWork" | "grantsExecutionAuthority" | "savesRevision">) {
    if (input.tenantId !== this.tenantId) throw new Error("intake_suggestion_tenant_invalid");
    const replay = this.#suggestions.find(value => value.projectId === input.projectId && value.batchId === input.batchId
      && value.requestKey === input.requestKey);
    if (replay) {
      if (replay.baseRevision !== input.baseRevision || replay.baseRevisionDigest !== input.baseRevisionDigest
        || replay.proposalDigest !== input.proposalDigest) throw new Error("intake_suggestion_replay_conflict");
      return replay;
    }
    const value = Object.freeze({ ...input, suggestionId: `suggestion:${++this.#sequence}`,
      proposal: cloneProposal(input.proposal), startsWork: false as const, grantsExecutionAuthority: false as const,
      savesRevision: false as const });
    this.#suggestions.push(value); return value;
  }
  prefillForOwner(input: { tenantId: string; projectId: string; batchId: string; suggestionId: string;
    ownerIdentityId: string; actorType: "human"; currentRevision: number; currentRevisionDigest: string }) {
    const value = this.#find(input);
    if (input.actorType !== "human" || !id.safeParse(input.ownerIdentityId).success || this.#dismissed.has(value.suggestionId))
      throw new Error("intake_suggestion_owner_required");
    if (value.baseRevision !== input.currentRevision || value.baseRevisionDigest !== input.currentRevisionDigest)
      throw new WebAccessError("conflict");
    return Object.freeze({ proposal: cloneProposal(value.proposal), startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const });
  }
  async listSuggestions(input: { tenantId: string; projectId: string; batchId: string }) {
    if (input.tenantId !== this.tenantId) throw new WebAccessError("access_denied");
    return this.#suggestions.filter(value => value.projectId === input.projectId && value.batchId === input.batchId);
  }
  dismissedSuggestionIds(input: { tenantId: string; projectId: string; batchId: string }) {
    if (input.tenantId !== this.tenantId) throw new WebAccessError("access_denied");
    return [...this.#dismissed].filter(suggestionId =>
      this.#suggestions.some(value => value.suggestionId === suggestionId && value.projectId === input.projectId
        && value.batchId === input.batchId));
  }
  /** The in-memory double's dismissal record. Production supplies its own: see the
   * port's doc comment on why 0200 cannot hold one. */
  dismiss(input: { tenantId: string; projectId: string; batchId: string; suggestionId: string; expectedRevision: number }) {
    const value = this.#find(input);
    if (value.baseRevision !== input.expectedRevision) throw new WebAccessError("conflict");
    this.#dismissed.add(value.suggestionId);
  }
  #find(input: { tenantId: string; projectId: string; batchId: string; suggestionId: string }) {
    if (input.tenantId !== this.tenantId) throw new WebAccessError("access_denied");
    const value = this.#suggestions.find(candidate => candidate.projectId === input.projectId
      && candidate.batchId === input.batchId && candidate.suggestionId === input.suggestionId);
    if (!value) throw new WebAccessError("not_found"); return value;
  }
}

type CoordinatorPort = Readonly<{
  coordinateInitial(input: Readonly<{ principal: AuthenticatedPrincipal; projectId: string; ownerRequest: string;
    idempotencyKey: string; now: string; signal?: AbortSignal }>): Promise<IntakeCoordinatorResultV1>;
  ownerPrefill(input: Parameters<IntakeSuggestionStoreV1["prefillForOwner"]>[0]):
    ReturnType<IntakeSuggestionStoreV1["prefillForOwner"]>;
}>;

/** One option per (worker, model) the catalog actually offers.
 *
 * The effort carried by an option is the one 0201 will store. For a codex or
 * claude-code worker that is the model's own default effort -- a concrete value,
 * so the stored row is exact and readable. For a hermes worker the catalog's only
 * effort is "default", which 0201's CHECK refuses, so the option carries `null`
 * and the stored column is SQL NULL: "the catalog decides". Emitting "default"
 * here would offer the owner a selection the database cannot accept. */
function optionsFor(catalog: WorkBatchQueueCatalogV1): readonly ProjectOrchestratorOptionV1[] {
  let sequence = 0;
  const values: ProjectOrchestratorOptionV1[] = [];
  for (const worker of catalog) {
    const policy = worker.modelPolicy;
    if (!policy) continue;
    if ("profiles" in policy) for (const profile of policy.profiles) values.push(Object.freeze({ key: `planner:${++sequence}`,
      label: `${worker.workerId} · ${profile.name}`, workerId: worker.workerId, workerKind: worker.workerKind,
      modelKey: profile.name, effort: null }));
    else for (const model of policy.models) values.push(Object.freeze({ key: `planner:${++sequence}`,
      label: `${worker.workerId} · ${model} · ${policy.defaultEffort}`, workerId: worker.workerId,
      workerKind: worker.workerKind, modelKey: model, effort: policy.defaultEffort }));
  }
  return Object.freeze(values);
}

/** Plain owner copy for each refusal the coordinator can return. The reason codes
 * are the coordinator's internal vocabulary and never reach the owner.
 *
 * The allowance refusal has its own two messages because it is the status an
 * owner will hit on EVERY describe until S7b lands: "not configured" and "spent"
 * need different words, and neither is fixed by retyping the description. */
export const describeRefusalMessageV1: Readonly<Record<string, string>> = Object.freeze({
  planner_allowance_not_configured: "No planning allowance is configured for this installation yet, so the chief of staff cannot run. This is not about your description.",
  allowance_exhausted: "This project has used its planning allowance for now. The chief of staff cannot run again until the allowance is refilled.",
  // The press found the description stopped, but another press of it succeeded
  // before anything was raised: there is no Needs-you item, and the description
  // runs normally again. Saying "Needs-you" here is what R5-B1 was about.
  planner_escalation_cleared: "Another request with this description finished while this one was waiting, so this one did not run and nothing was raised. Your description is still here; press Prepare proposal to run it.",
});
const describeRefusedMessage = (reasonCode: string) => describeRefusalMessageV1[reasonCode]
  ?? "The chief of staff could not turn that description into a safe proposal. Check the wording or settings and try again.";

/** Optional durable dismissal records.
 *
 * 0200 is append-only and its write guard admits only the batch's own agent
 * proposer, so it cannot hold an owner's dismissal. 0110's
 * work_batch_intake_flag_dismissals is a different record: the owner dismissing
 * an intake FLAG on a revision. A composition that wants Dismiss to survive a
 * reload supplies a real record here; without one the adapter refuses the gesture
 * with 404 rather than losing it. */
export interface ProjectOrchestrationDismissalPortV1 {
  record(input: Readonly<{ tenantId: string; projectId: string; batchId: string; suggestionId: string;
    baseRevision: number; baseRevisionDigest: string; ownerIdentityId: string; now: string }>): Promise<void>;
}

export function createProjectOrchestrationOwnerAdapterV1(options: Readonly<{ tenantId: string;
  coordinatorPrincipal: AuthenticatedPrincipal; coordinator: CoordinatorPort; store: ProjectOrchestrationStoreV1;
  access: ProjectOrchestrationAccessPortV1; batches: ProjectOrchestrationBatchRevisionPortV1;
  queueCatalog: WorkBatchQueueCatalogV1; /** Whether a planner host is composed. False makes
   * describing a job unavailable rather than failing it; see F6. */
  describeAvailable: boolean; dismissals?: ProjectOrchestrationDismissalPortV1;
  retry?: ProjectOrchestrationRetryPortV1; clock?: () => number }>):
  ProjectOrchestrationOwnerPortV1 {
  if (options.coordinatorPrincipal.actorType !== "agent" || options.coordinatorPrincipal.tenantId !== options.tenantId)
    throw new Error("project_orchestration_configuration_invalid");
  const catalog = captureWorkBatchQueueCatalogV1(options.queueCatalog), plannerOptions = optionsFor(catalog);
  const clock = options.clock ?? Date.now;
  const offered = (choice: ProjectOrchestratorChoiceV1) => choice.mode === "none" || plannerOptions.some(candidate =>
    candidate.workerId === choice.workerId && candidate.workerKind === choice.workerKind
    && candidate.modelKey === choice.modelKey && candidate.effort === choice.effort);
  async function owner(identity: VerifiedWebIdentity, projectId: string, operation: Parameters<ProjectOrchestrationAccessPortV1["owner"]>[2]) {
    id.parse(projectId); const result = await options.access.owner(identity, projectId, operation);
    if (result.tenantId !== options.tenantId) throw new WebAccessError("access_denied"); return result;
  }
  async function settings(identity: VerifiedWebIdentity, projectId: string, operation: "read" | "settings") {
    const actor = await owner(identity, projectId, operation), saved = await options.store.readSettings(actor.tenantId, projectId);
    return projectOrchestrationSettingsSchemaV1.parse({ projectId, ...saved, options: plannerOptions,
      choiceStale: !offered(saved.choice), describeAvailable: options.describeAvailable,
      dismissAvailable: typeof options.dismissals?.record === "function", ...common });
  }
  const service: ProjectOrchestrationOwnerPortV1 = {
    readSettings: (identity, projectId) => settings(identity, projectId, "read"),
    async saveSettings(identity, projectId, value) {
      const actor = await owner(identity, projectId, "settings");
      const draft = projectOrchestrationSettingsDraftSchemaV1.safeParse(value);
      // The exact-catalog check runs against the same effort value the store will
      // persist, so a selection the database would refuse is refused here first.
      if (!draft.success || !offered(draft.data.choice)) throw new WebAccessError("invalid_request");
      await options.store.saveSettings({ tenantId: actor.tenantId, projectId, ...draft.data,
        writtenByIdentityId: actor.ownerIdentityId, now: new Date(clock()).toISOString() });
      return settings(identity, projectId, "read");
    },
    async describe(identity, projectId, value, idempotencyKey, signal) {
      await owner(identity, projectId, "describe");
      if (!options.describeAvailable) throw new WebAccessError("not_found");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(idempotencyKey)) throw new WebAccessError("invalid_request");
      const input = projectOrchestrationDescribeSchemaV1.safeParse(value);
      if (!input.success) throw new WebAccessError("invalid_request");
      const result = await options.coordinator.coordinateInitial({ principal: options.coordinatorPrincipal, projectId,
        ownerRequest: input.data.description, idempotencyKey, now: new Date(clock()).toISOString(), ...(signal ? { signal } : {}) });
      if (result.status === "submitted") return Object.freeze({ ...common, status: "proposal" as const,
        batchId: result.submission.batchId,
        href: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(result.submission.batchId)}` });
      // B3: "Needs-you" is said only when a Needs-you item EXISTS.
      //
      // `needs_you` is the escalated outcome: the coordinator has raised one item
      // and refuses to run a third time, so naming it is accurate. `planner_failed`
      // is the FIRST failure: the counter is at 1, nothing has been raised, and
      // the owner is being told to try again. It used to be announced with a
      // message that began "Needs-you:", which described something that had not
      // happened -- and on a permanently broken planner that label is what the
      // owner reads on every single press, forever, with no item behind it. The
      // two states get different sentences and different roles, so the panel
      // announces only the one that raised something.
      // The `needs_you` copy now NAMES THE WAY OUT, because the two things it
      // used to suggest did not work. It said "try again, or choose another chief
      // of staff" on a description the coordinator refuses before the planner
      // runs, so neither was true: a third press was refused at the same count,
      // and a new selection does not touch a counter keyed on (project,
      // description). The sentence below says what is actually true and points at
      // the one control that exists. `retryAvailable` is false where no durable
      // retry record is composed, and then the copy does not offer it.
      //
      // The item this names EXISTS: the coordinator returns `needs_you` only when
      // the Needs-you port resolved, and the production port resolves only when an
      // item stands for the request (R5-B1, where round 4 said this with no item).
      if (result.status === "needs_you") return Object.freeze({ ...common, status: "failed" as const,
        needsYou: true as const, retryAvailable: typeof options.retry?.grant === "function",
        message: typeof options.retry?.grant === "function"
          ? "Needs-you: the chief of staff failed twice on this description, so it has stopped and raised an item for you. Your description is still here. You can ask it to try this description once more."
          : "Needs-you: the chief of staff failed twice on this description, so it has stopped and raised an item for you. Your description is still here." });
      if (result.status === "planner_failed") return Object.freeze({ ...common, status: "failed" as const,
        needsYou: false as const,
        message: "The chief of staff could not prepare a proposal this time. Your description is still here; try again, or choose another chief of staff." });
      if (result.status === "manual") return Object.freeze({ ...common, status: "manual" as const,
        message: "No chief of staff is selected. Choose one in Project settings." });
      if (result.status === "stopped") return Object.freeze({ ...common, status: "stopped" as const,
        message: "Proposal preparation stopped. No proposal was saved and no work started." });
      // An allowance refusal is its own outcome, not the catch-all: it names the
      // cause and the panel announces it, because the owner cannot fix it by
      // rewording and the run never started.
      if (result.status === "allowance_refused") return Object.freeze({ ...common, status: "refused" as const,
        allowanceRefused: true as const, message: describeRefusedMessage(result.reasonCode) });
      // `suggested` belongs to the re-split path, which describe never reaches. It
      // is refused rather than rendered as a proposal it did not produce.
      if (result.status === "suggested") throw new WebAccessError("invalid_request");
      return Object.freeze({ ...common, status: "refused" as const, allowanceRefused: false as const,
        message: describeRefusedMessage(result.reasonCode) });
    },
    async retryEscalated(identity, projectId, value, idempotencyKey) {
      const actor = await owner(identity, projectId, "describe");
      // The same three refusals the press itself has, so a retry cannot be a
      // wider door than the thing it retries: an unconnected service, a malformed
      // key, a malformed description, or a body that is not one description.
      if (!options.describeAvailable) throw new WebAccessError("not_found");
      if (typeof options.retry?.grant !== "function") throw new WebAccessError("not_found");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(idempotencyKey)) throw new WebAccessError("invalid_request");
      const input = projectOrchestrationDescribeSchemaV1.safeParse(value);
      if (!input.success) throw new WebAccessError("invalid_request");
      // The grant is scoped to THIS request's own scopes, so it can only clear a
      // counter this description reached. Zero grants is not an error: it is the
      // "there was nothing to retry" case, and it is reported as such rather than
      // as a success, so the panel does not promise a run that was not authorised.
      const granted = await options.retry.grant({ tenantId: actor.tenantId, projectId,
        requestKey: idempotencyKey, ownerRequest: input.data.description });
      return deepFreeze(projectOrchestrationRetrySchemaV1.parse({ projectId,
        granted: Number.isSafeInteger(granted) && granted > 0, ...common }));
    },
    async listSuggestions(identity, projectId, batchId) {
      const actor = await owner(identity, projectId, "suggestion"); id.parse(batchId);
      // The batch's current revision and the suggestions the store will return are
      // one read each. The store is 0200's current-revision view, so staleness and
      // the decided state are the VIEW's filter; this re-check is what makes a
      // store that does not filter (an in-memory double, a future adapter) behave
      // the same as the one production runs on.
      const [current, values, dismissed] = await Promise.all([
        options.batches.read({ tenantId: actor.tenantId, projectId, batchId }),
        options.store.listSuggestions({ tenantId: actor.tenantId, projectId, batchId }),
        options.store.dismissedSuggestionIds({ tenantId: actor.tenantId, projectId, batchId })]);
      const hidden = new Set(dismissed);
      // The page is frozen AFTER the schema parse, not before. zod's `.parse`
      // rebuilds every object it validates, so freezing the inputs freezes copies
      // that are then thrown away, and the page the caller holds comes back
      // mutable. This is the F9 finding, mutation-proved as M8b.
      const page = projectOrchestrationSuggestionPageSchemaV1.parse({ projectId, batchId,
        suggestions: values.filter(value => !hidden.has(value.suggestionId) && current.state === "proposed"
          && value.baseRevision === current.revision && value.baseRevisionDigest === current.revisionDigest)
          .map(value => ({ suggestionId: value.suggestionId,
          projectId, batchId, baseRevision: value.baseRevision, proposal: deepFreeze(cloneProposal(value.proposal)),
          createdAt: value.createdAt, dismissed: false, startsWork: false, grantsExecutionAuthority: false, savesRevision: false })),
        dismissAvailable: typeof options.dismissals?.record === "function", ...common });
      return deepFreeze(page);
    },
    async useSuggestion(identity, projectId, batchId, suggestionId, expectedRevision) {
      const actor = await owner(identity, projectId, "suggestion");
      const current = await options.batches.read({ tenantId: actor.tenantId, projectId, batchId });
      if (current.state !== "proposed" || current.revision !== expectedRevision) throw new WebAccessError("conflict");
      return deepFreeze(projectOrchestrationSuggestionPrefillSchemaV1.parse(await options.coordinator.ownerPrefill({
        tenantId: actor.tenantId, projectId, batchId, suggestionId, ownerIdentityId: actor.ownerIdentityId,
        actorType: "human", currentRevision: current.revision, currentRevisionDigest: current.revisionDigest })));
    },
    async dismissSuggestion(identity, projectId, batchId, suggestionId, expectedRevision) {
      const actor = await owner(identity, projectId, "suggestion");
      const current = await options.batches.read({ tenantId: actor.tenantId, projectId, batchId });
      if (current.state !== "proposed" || current.revision !== expectedRevision) throw new WebAccessError("conflict");
      const dismissed = await options.store.dismissedSuggestionIds({ tenantId: actor.tenantId, projectId, batchId });
      // A suggestion the owner already dismissed is a no-op, never a second write,
      // and one the current revision does not hold is refused rather than recorded.
      if (dismissed.includes(suggestionId)) return;
      const values = await options.store.listSuggestions({ tenantId: actor.tenantId, projectId, batchId });
      const value = values.find(candidate => candidate.suggestionId === suggestionId);
      if (!value || value.baseRevision !== current.revision || value.baseRevisionDigest !== current.revisionDigest)
        throw new WebAccessError("not_found");
      await recordDismissal({ tenantId: actor.tenantId, projectId, batchId, suggestionId,
        baseRevision: current.revision, baseRevisionDigest: current.revisionDigest,
        ownerIdentityId: actor.ownerIdentityId, now: new Date(clock()).toISOString() });
    },
  };
  return Object.freeze(service);

  /** Supplied by the composition: the one durable place a dismissal is written.
   * It is NOT 0200 (append-only, agent-insert-only) and NOT 0110's intake-flag
   * dismissals, which are a different record. Without it the Dismiss button is not
   * composed at all, and the HTTP route answers 404 rather than pretending. */
  async function recordDismissal(input: Readonly<{ tenantId: string; projectId: string; batchId: string;
    suggestionId: string; baseRevision: number; baseRevisionDigest: string; ownerIdentityId: string; now: string }>): Promise<void> {
    if (typeof options.dismissals?.record !== "function") throw new WebAccessError("not_found");
    await options.dismissals.record(input);
  }
}