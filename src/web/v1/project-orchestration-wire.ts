import { z } from "zod";
import { catalogProjectIdSchema } from "./project-wire";
import { workBatchProposalSchemaV1 } from "../../work-intake/v1/schemas";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
/** The concrete efforts 0201's CHECK accepts. `null` means "the catalog's default" and
 * is written as SQL NULL: 0201 deliberately refuses a stored 'default' because a
 * planner selection is resolved against a model policy, and a stored 'default'
 * would name no concrete model. The owner leaves the column NULL instead. */
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const projectOrchestratorChoiceSchemaV1 = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("selected"), workerId: id,
    workerKind: z.enum(["codex", "claude-code", "hermes"]), modelKey: z.string().min(1).max(180),
    effort: effort.nullable() }).strict(),
]);
export type ProjectOrchestratorChoiceV1 = z.infer<typeof projectOrchestratorChoiceSchemaV1>;

export const projectOrchestratorOptionSchemaV1 = z.object({
  key: id, label: z.string().min(1).max(240), workerId: id,
  workerKind: z.enum(["codex", "claude-code", "hermes"]), modelKey: z.string().min(1).max(180),
  effort: effort.nullable(),
}).strict();
export type ProjectOrchestratorOptionV1 = z.infer<typeof projectOrchestratorOptionSchemaV1>;

export const projectOrchestrationSettingsSchemaV1 = z.object({
  projectId: catalogProjectIdSchema, version: z.number().int().nonnegative(),
  choice: projectOrchestratorChoiceSchemaV1,
  options: z.array(projectOrchestratorOptionSchemaV1).max(256),
  /** The stored selection names a bot and model the live catalog no longer holds.
   * The choice is still reported verbatim so the owner is told what is stored; the
   * flag says the catalog cannot resolve it, so the UI must not offer a describe
   * that cannot succeed and must not silently render the select as "None". */
  choiceStale: z.boolean(),
  /** Whether a planner host is actually composed. A settings-only composition can
   * read and store the owner's choice while describing a job is not yet possible;
   * the UI says so in plain words instead of failing every describe. */
  describeAvailable: z.boolean(),
  /** Whether a DURABLE dismissal record is composed. 0200 is append-only and
   * agent-insert-only, so it cannot hold one; without a record port the Dismiss
   * gesture would be lost on reload, so it is not offered. */
  dismissAvailable: z.boolean(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type ProjectOrchestrationSettingsV1 = z.infer<typeof projectOrchestrationSettingsSchemaV1>;

export const projectOrchestrationSettingsDraftSchemaV1 = z.object({
  expectedVersion: z.number().int().nonnegative(), choice: projectOrchestratorChoiceSchemaV1,
}).strict();

/** One owner-facing length limit, counted in UTF-16 CODE UNITS -- the same unit
 * the browser's own `maxLength` attribute counts, so the textarea cannot produce a
 * value this rejects and no legal description is refused with a message about
 * length that does not explain it. (An astral-plane character such as an emoji
 * counts as 2.) The copy in the browser says "16,000 characters" and this is that
 * number. The transport limit in project-orchestration-http.ts is DERIVED above the
 * worst-case UTF-8 encoding of this bound, so the two cannot disagree. */
export const PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 = 16_000;
export const projectOrchestrationDescribeSchemaV1 = z.object({
  description: z.string().trim().min(1).max(PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1),
}).strict();

export const projectOrchestrationDescribeResultSchemaV1 = z.discriminatedUnion("status", [
  z.object({ status: z.literal("proposal"), batchId: id, href: z.string().min(1).max(640),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  z.object({ status: z.literal("manual"), message: z.string().min(1).max(400),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  /** The planner run did not produce a proposal. `needsYou` is true ONLY when the
   * coordinator actually raised a Needs-you item (the escalated second failure),
   * and false on a first failure, where nothing has been raised. It is a real
   * flag rather than a constant true because the panel announces it, and an
   * announcement that says "Needs-you" when no item exists is a label for
   * something that did not happen. */
  z.object({ status: z.literal("failed"), needsYou: z.boolean(), message: z.string().min(1).max(400),
    /** Whether a durable owner-retry record is composed, so the panel can offer
     * the one control that clears an escalation -- and can stay silent about it
     * where there is none. The `message` already reflects it; this is what the
     * panel reads to decide whether to render the button. */
    retryAvailable: z.boolean().optional(),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  /** The planner run was refused before it started, because no allowance is
   * configured or this project's allowance is spent. `allowanceRefused` is true
   * only for an allowance refusal, and is what makes the panel announce it. */
  z.object({ status: z.literal("refused"), message: z.string().min(1).max(400),
    allowanceRefused: z.boolean(),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
  z.object({ status: z.literal("stopped"), message: z.string().min(1).max(400),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict(),
]);
export type ProjectOrchestrationDescribeResultV1 = z.infer<typeof projectOrchestrationDescribeResultSchemaV1>;

/** The owner's deliberate retry of an escalated description.
 *
 * `granted` is the whole answer, and it is deliberately a boolean rather than a
 * count: the owner needs to know whether a run was authorised, not how many
 * counters were touched. It is false where the description had not escalated --
 * nothing to retry -- which is a different sentence from "granted" and is the
 * case a second press of the retry button lands in. */
export const projectOrchestrationRetrySchemaV1 = z.object({
  projectId: catalogProjectIdSchema,
  granted: z.boolean(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type ProjectOrchestrationRetryResultV1 = z.infer<typeof projectOrchestrationRetrySchemaV1>;

export const projectOrchestrationSuggestionSchemaV1 = z.object({
  suggestionId: id, batchId: id, projectId: catalogProjectIdSchema, baseRevision: z.number().int().positive(),
  proposal: workBatchProposalSchemaV1, createdAt: z.string().datetime(), dismissed: z.boolean(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false), savesRevision: z.literal(false),
}).strict();
export type ProjectOrchestrationSuggestionV1 = z.infer<typeof projectOrchestrationSuggestionSchemaV1>;

export const projectOrchestrationSuggestionPageSchemaV1 = z.object({
  projectId: catalogProjectIdSchema, batchId: id,
  suggestions: z.array(projectOrchestrationSuggestionSchemaV1).max(64),
  /** Whether a durable dismissal record is composed. False means the Dismiss
   * gesture is not offered, because a decision that cannot be recorded must not be
   * presented as if it could. */
  dismissAvailable: z.boolean(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type ProjectOrchestrationSuggestionPageV1 = z.infer<typeof projectOrchestrationSuggestionPageSchemaV1>;

export const projectOrchestrationSuggestionPrefillSchemaV1 = z.object({
  proposal: workBatchProposalSchemaV1, startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false), savesRevision: z.literal(false),
}).strict();
export type ProjectOrchestrationSuggestionPrefillV1 = z.infer<typeof projectOrchestrationSuggestionPrefillSchemaV1>;