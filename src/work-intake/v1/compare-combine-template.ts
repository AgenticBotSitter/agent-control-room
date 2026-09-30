// Tango Tier 1 / research/tango/06-tiers-vs-control-room.md: "Compare N bots,
// then a different bot synthesises" pipeline template. It builds an ordinary
// work-batch proposal (S1, startsWork: false) with 2-4 independent "answerer"
// tasks (role builder), one "combiner" task (role checker) that depends on
// every answerer, and an optional "presenter" task (role validator) that
// depends on the combiner. It reuses the existing arbitrary-DAG proposal
// schema and per-task worker/model choice untouched; no new database surface.
// The owner still approves the batch before any task starts (S2), exactly as
// for any other work-batch proposal.
import type { AuthenticatedPrincipal } from "../../security";
import { z } from "zod";
import { WORK_BATCH_PROPOSAL_V1, workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "./schemas";
import type { WorkBatchServiceV1, WorkBatchSubmissionResultV1 } from "./service";

export const COMPARE_AND_COMBINE_TEMPLATE_V1 = "control-room.compare-and-combine-template/v1" as const;
export const COMPARE_AND_COMBINE_MIN_ANSWERERS_V1 = 2;
export const COMPARE_AND_COMBINE_MAX_ANSWERERS_V1 = 4;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const line = z.string().min(1).max(180).refine(value => !/[\r\n]/.test(value), "must be one line");
const longText = z.string().min(1).max(4_000);

/** One pipeline step, with its bot/model choice pinned. `requestedWorkerId`
 * may further pin an exact worker; `requestedWorkerKind` and
 * `requestedModelKey` are required here (unlike the general work-batch
 * schema) because the combiner/answerer distinctness check below is defined
 * over them — an unpinned step could not be proven distinct from another. */
const compareStepSchemaV1 = z.object({
  title: line, instructions: longText, requiredCapability: id,
  requestedWorkerId: id.optional(), requestedWorkerKind: id, requestedModelKey: id,
  acceptanceCriteria: longText, acceptanceTests: longText,
}).strict();
export type CompareAndCombineStepV1 = z.infer<typeof compareStepSchemaV1>;

function stepIdentityV1(step: CompareAndCombineStepV1): string {
  return `${step.requestedWorkerId ?? "*"}\u0000${step.requestedWorkerKind}\u0000${step.requestedModelKey}`;
}

export const compareAndCombineTemplateInputSchemaV1 = z.object({
  schema: z.literal(COMPARE_AND_COMBINE_TEMPLATE_V1),
  projectId: id,
  question: longText,
  answerers: z.array(compareStepSchemaV1).min(COMPARE_AND_COMBINE_MIN_ANSWERERS_V1).max(COMPARE_AND_COMBINE_MAX_ANSWERERS_V1),
  combiner: compareStepSchemaV1,
  presenter: compareStepSchemaV1.optional(),
}).strict().superRefine((value, context) => {
  const answererIdentities = value.answerers.map(stepIdentityV1);
  if (new Set(answererIdentities).size !== answererIdentities.length)
    context.addIssue({ code: "custom", message: "each answerer must use a distinct bot/model identity", path: ["answerers"] });
  if (answererIdentities.includes(stepIdentityV1(value.combiner)))
    context.addIssue({ code: "custom", message: "the combiner must not be one of the answerers", path: ["combiner"] });
  if (value.presenter) {
    if (answererIdentities.includes(stepIdentityV1(value.presenter)))
      context.addIssue({ code: "custom", message: "the presenter must not be one of the answerers", path: ["presenter"] });
    if (stepIdentityV1(value.presenter) === stepIdentityV1(value.combiner))
      context.addIssue({ code: "custom", message: "the presenter must not be the combiner", path: ["presenter"] });
  }
});
export type CompareAndCombineTemplateInputV1 = z.infer<typeof compareAndCombineTemplateInputSchemaV1>;

const stepTask = (localId: string, step: CompareAndCombineStepV1, role: "builder" | "checker" | "validator", instructions: string) => ({
  localId, title: step.title, instructions, requiredCapability: step.requiredCapability, role,
  ...(step.requestedWorkerId ? { requestedWorkerId: step.requestedWorkerId } : {}),
  requestedWorkerKind: step.requestedWorkerKind, requestedModelKey: step.requestedModelKey,
  acceptanceCriteria: step.acceptanceCriteria, acceptanceTests: step.acceptanceTests,
});

/** Builds the ordinary work-batch proposal for this template. Throws on any
 * schema violation, including a combiner or presenter that reuses an
 * answerer's exact bot/model identity — the caller never receives a proposal
 * that would silently let one bot mark its own answer as the synthesis. */
export function buildCompareAndCombineProposalV1(input: unknown): WorkBatchProposalV1 {
  const value = compareAndCombineTemplateInputSchemaV1.parse(input);
  const answererLocalIds = value.answerers.map((_, index) => `answer-${index + 1}`);
  const tasks = [
    ...value.answerers.map((step, index) => stepTask(answererLocalIds[index]!, step, "builder",
      `${value.question}\n\n${step.instructions}`)),
    stepTask("combine", value.combiner, "checker",
      `Combine the ${value.answerers.length} independent answers above into one answer to: ${value.question}\n\n${value.combiner.instructions}`),
    ...(value.presenter ? [stepTask("present", value.presenter, "validator",
      `Present the combined answer to: ${value.question}\n\n${value.presenter.instructions}`)] : []),
  ];
  const edges = [
    ...answererLocalIds.map(fromLocalId => ({ fromLocalId, toLocalId: "combine" })),
    ...(value.presenter ? [{ fromLocalId: "combine", toLocalId: "present" }] : []),
  ];
  return workBatchProposalSchemaV1.parse({ schema: WORK_BATCH_PROPOSAL_V1, projectId: value.projectId, tasks, edges });
}

/** Submits the template through the ordinary, already-authorized work-batch
 * path. This is the only place the template touches the database: everything
 * else (authority, idempotency, queue depth, owner approval) is exactly the
 * shared work-batch machinery. Never starts a task by itself. */
export async function submitCompareAndCombineTemplateV1(service: Pick<WorkBatchServiceV1, "submit">,
  input: { principal: AuthenticatedPrincipal; template: unknown; idempotencyKey: string; now: string }):
  Promise<WorkBatchSubmissionResultV1> {
  const proposal = buildCompareAndCombineProposalV1(input.template);
  return service.submit({ principal: input.principal, projectId: proposal.projectId,
    rawProposal: JSON.stringify(proposal), idempotencyKey: input.idempotencyKey, now: input.now });
}
