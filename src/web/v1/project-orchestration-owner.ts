import { z } from "zod";
import type { AuthenticatedPrincipal } from "../../security";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "../../work-intake/v1/schemas";
import { captureWorkBatchQueueCatalogV1, type WorkBatchQueueCatalogV1 } from "../../work-intake/v1/queue-catalog";
import type { IntakeCoordinatorResultV1, IntakePlannerSelectionPortV1, IntakeSuggestionRecordV1,
  IntakeSuggestionStoreV1 } from "../../work-intake/v1/intake-coordinator";
import type { VerifiedWebIdentity } from "./access-verifier";
import { WebAccessError } from "./access-verifier";
import { projectOrchestrationDescribeSchemaV1, projectOrchestrationSettingsDraftSchemaV1,
  projectOrchestrationSettingsSchemaV1, projectOrchestrationSuggestionPageSchemaV1,
  projectOrchestrationSuggestionPrefillSchemaV1, type ProjectOrchestrationDescribeResultV1,
  type ProjectOrchestrationSettingsV1, type ProjectOrchestratorChoiceV1,
  type ProjectOrchestratorOptionV1, type ProjectOrchestrationSuggestionPageV1,
  type ProjectOrchestrationSuggestionPrefillV1 } from "./project-orchestration-wire";

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

export interface ProjectOrchestrationStoreV1 extends IntakePlannerSelectionPortV1, IntakeSuggestionStoreV1 {
  readSettings(tenantId: string, projectId: string): Promise<Readonly<{ version: number; choice: ProjectOrchestratorChoiceV1 }>>;
  saveSettings(input: Readonly<{ tenantId: string; projectId: string; expectedVersion: number;
    choice: ProjectOrchestratorChoiceV1 }>): Promise<Readonly<{ version: number; choice: ProjectOrchestratorChoiceV1 }>>;
  listSuggestions(input: Readonly<{ tenantId: string; projectId: string; batchId: string }>):
    Promise<readonly (IntakeSuggestionRecordV1 & { dismissed: boolean })[]>;
  dismissSuggestion(input: Readonly<{ tenantId: string; projectId: string; batchId: string; suggestionId: string;
    expectedRevision: number }>): Promise<void>;
}

export interface ProjectOrchestrationOwnerPortV1 {
  readSettings(identity: VerifiedWebIdentity, projectId: string): Promise<ProjectOrchestrationSettingsV1>;
  saveSettings(identity: VerifiedWebIdentity, projectId: string, value: unknown): Promise<ProjectOrchestrationSettingsV1>;
  describe(identity: VerifiedWebIdentity, projectId: string, value: unknown, idempotencyKey: string,
    signal?: AbortSignal): Promise<ProjectOrchestrationDescribeResultV1>;
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

/** Disposable store for component/server tests. Production must supply a durable adapter. */
export class InMemoryProjectOrchestrationStoreV1 implements ProjectOrchestrationStoreV1 {
  readonly #settings = new Map<string, { version: number; choice: ProjectOrchestratorChoiceV1 }>();
  readonly #suggestions: Array<IntakeSuggestionRecordV1 & { dismissed: boolean }> = [];
  #sequence = 0;
  constructor(private readonly tenantId: string) { id.parse(tenantId); }
  #key(projectId: string) { return `${this.tenantId}\u0000${projectId}`; }
  read(projectId: string) {
    const choice = this.#settings.get(this.#key(projectId))?.choice;
    return choice?.mode === "selected" ? Object.freeze({ workerId: choice.workerId,
      workerKind: choice.workerKind, modelKey: choice.modelKey, effort: choice.effort }) : null;
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
      savesRevision: false as const, dismissed: false });
    this.#suggestions.push(value); return value;
  }
  prefillForOwner(input: { tenantId: string; projectId: string; batchId: string; suggestionId: string;
    ownerIdentityId: string; actorType: "human"; currentRevision: number; currentRevisionDigest: string }) {
    const value = this.#find(input);
    if (input.actorType !== "human" || !id.safeParse(input.ownerIdentityId).success || value.dismissed)
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
  async dismissSuggestion(input: { tenantId: string; projectId: string; batchId: string; suggestionId: string;
    expectedRevision: number }) {
    const value = this.#find(input);
    if (value.baseRevision !== input.expectedRevision) throw new WebAccessError("conflict");
    const index = this.#suggestions.indexOf(value);
    this.#suggestions[index] = Object.freeze({ ...value, dismissed: true });
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

function optionsFor(catalog: WorkBatchQueueCatalogV1): readonly ProjectOrchestratorOptionV1[] {
  let sequence = 0;
  const values: ProjectOrchestratorOptionV1[] = [];
  for (const worker of catalog) {
    const policy = worker.modelPolicy;
    if (!policy) continue;
    if ("profiles" in policy) for (const profile of policy.profiles) values.push(Object.freeze({ key: `planner:${++sequence}`,
      label: `${worker.workerId} · ${profile.name}`, workerId: worker.workerId, workerKind: worker.workerKind,
      modelKey: profile.name, effort: "default" }));
    else for (const model of policy.models) for (const workerEffort of policy.efforts) values.push(Object.freeze({
      key: `planner:${++sequence}`, label: `${worker.workerId} · ${model} · ${workerEffort}`,
      workerId: worker.workerId, workerKind: worker.workerKind, modelKey: model, effort: workerEffort }));
  }
  return Object.freeze(values);
}

export function createProjectOrchestrationOwnerAdapterV1(options: Readonly<{ tenantId: string;
  coordinatorPrincipal: AuthenticatedPrincipal; coordinator: CoordinatorPort; store: ProjectOrchestrationStoreV1;
  access: ProjectOrchestrationAccessPortV1; batches: ProjectOrchestrationBatchRevisionPortV1;
  queueCatalog: WorkBatchQueueCatalogV1; clock?: () => number }>): ProjectOrchestrationOwnerPortV1 {
  if (options.coordinatorPrincipal.actorType !== "agent" || options.coordinatorPrincipal.tenantId !== options.tenantId)
    throw new Error("project_orchestration_configuration_invalid");
  const catalog = captureWorkBatchQueueCatalogV1(options.queueCatalog), plannerOptions = optionsFor(catalog);
  const clock = options.clock ?? Date.now;
  async function owner(identity: VerifiedWebIdentity, projectId: string, operation: Parameters<ProjectOrchestrationAccessPortV1["owner"]>[2]) {
    id.parse(projectId); const result = await options.access.owner(identity, projectId, operation);
    if (result.tenantId !== options.tenantId) throw new WebAccessError("access_denied"); return result;
  }
  async function settings(identity: VerifiedWebIdentity, projectId: string, operation: "read" | "settings") {
    const actor = await owner(identity, projectId, operation), saved = await options.store.readSettings(actor.tenantId, projectId);
    return projectOrchestrationSettingsSchemaV1.parse({ projectId, ...saved, options: plannerOptions, ...common });
  }
  const service: ProjectOrchestrationOwnerPortV1 = {
    readSettings: (identity, projectId) => settings(identity, projectId, "read"),
    async saveSettings(identity, projectId, value) {
      const actor = await owner(identity, projectId, "settings");
      const draft = projectOrchestrationSettingsDraftSchemaV1.safeParse(value);
      const choice = draft.success ? draft.data.choice : undefined;
      if (!draft.success || choice?.mode === "selected" && !plannerOptions.some(candidate =>
        candidate.workerId === choice.workerId && candidate.workerKind === choice.workerKind
        && candidate.modelKey === choice.modelKey && candidate.effort === choice.effort))
        throw new WebAccessError("invalid_request");
      await options.store.saveSettings({ tenantId: actor.tenantId, projectId, ...draft.data });
      return settings(identity, projectId, "read");
    },
    async describe(identity, projectId, value, idempotencyKey, signal) {
      await owner(identity, projectId, "describe");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u.test(idempotencyKey)) throw new WebAccessError("invalid_request");
      const input = projectOrchestrationDescribeSchemaV1.safeParse(value);
      if (!input.success) throw new WebAccessError("invalid_request");
      const result = await options.coordinator.coordinateInitial({ principal: options.coordinatorPrincipal, projectId,
        ownerRequest: input.data.description, idempotencyKey, now: new Date(clock()).toISOString(), ...(signal ? { signal } : {}) });
      if (result.status === "submitted") return Object.freeze({ ...common, status: "proposal" as const,
        batchId: result.submission.batchId,
        href: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(result.submission.batchId)}` });
      if (result.status === "planner_failed" || result.status === "needs_you") return Object.freeze({ ...common,
        status: "failed" as const, needsYou: true as const,
        message: "Needs-you: the chief of staff could not prepare a proposal. Your description is still here; try again or choose another chief of staff." });
      if (result.status === "manual") return Object.freeze({ ...common, status: "manual" as const,
        message: "No chief of staff is selected. Choose one in Project settings." });
      if (result.status === "stopped") return Object.freeze({ ...common, status: "stopped" as const,
        message: "Proposal preparation stopped. No proposal was saved and no work started." });
      return Object.freeze({ ...common, status: "refused" as const,
        message: "The chief of staff could not turn that description into a safe proposal. Check the wording or settings and try again." });
    },
    async listSuggestions(identity, projectId, batchId) {
      const actor = await owner(identity, projectId, "suggestion"); id.parse(batchId);
      const current = await options.batches.read({ tenantId: actor.tenantId, projectId, batchId });
      const values = await options.store.listSuggestions({ tenantId: actor.tenantId, projectId, batchId });
      return projectOrchestrationSuggestionPageSchemaV1.parse({ projectId, batchId,
        suggestions: values.filter(value => !value.dismissed && current.state === "proposed"
          && value.baseRevision === current.revision && value.baseRevisionDigest === current.revisionDigest)
          .map(value => ({ suggestionId: value.suggestionId,
          projectId, batchId, baseRevision: value.baseRevision, proposal: value.proposal, createdAt: value.createdAt,
          dismissed: false, startsWork: false, grantsExecutionAuthority: false, savesRevision: false })), ...common });
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
      await options.store.dismissSuggestion({ tenantId: actor.tenantId, projectId, batchId, suggestionId, expectedRevision });
    },
  };
  return Object.freeze(service);
}
