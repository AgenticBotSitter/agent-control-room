import { z } from "zod";
import { modelIdentifierSchemaV1 } from "../../domain/v1/model-identifier";
import { reusableSkillReferencesSchemaV1 } from "../../skills/v1/schemas";

export const WORK_BATCH_PROPOSAL_V1 = "control-room.work-batch-proposal/v1" as const;
export const WORK_BATCH_RECEIPT_V1 = "control-room.work-batch-receipt/v1" as const;
export const WORK_BATCH_MAX_TASKS_V1 = 32;
export const WORK_BATCH_MAX_EDGES_V1 = 64;
const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const workBatchLocalIdSchemaV1 = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const localId = workBatchLocalIdSchemaV1;
const line = z.string().min(1).max(180).refine((value) => !/[\r\n]/.test(value), "must be one line");

const workBatchProposalTaskSchemaV1 = z.object({
  localId,
  title: line,
  instructions: z.string().min(1).max(4_000),
  requiredCapability: id,
  recommendedRouteId: id.optional(),
  role: z.enum(["builder", "checker", "validator"]),
  requestedWorkerId: id.optional(),
  requestedWorkerKind: id.optional(),
  requestedModelKey: modelIdentifierSchemaV1.optional(),
  acceptanceCriteria: z.string().min(1).max(4_000),
  acceptanceTests: z.string().min(1).max(4_000),
  skillRefs: reusableSkillReferencesSchemaV1.optional(),
}).strict();

function validateWorkBatchProposalGraphV1(value: { tasks: readonly { localId: string }[];
  edges: readonly { fromLocalId: string; toLocalId: string }[] }, context: z.RefinementCtx) {
  const locals = value.tasks.map((task) => task.localId);
  if (new Set(locals).size !== locals.length) context.addIssue({ code: "custom", message: "task local ids must be unique" });
  const known = new Set(locals), edges = new Set<string>();
  for (const edge of value.edges) {
    if (edge.fromLocalId === edge.toLocalId) context.addIssue({ code: "custom", message: "an edge cannot be a self loop" });
    if (!known.has(edge.fromLocalId) || !known.has(edge.toLocalId))
      context.addIssue({ code: "custom", message: "edges must reference proposed tasks" });
    const key = `${edge.fromLocalId}\u0000${edge.toLocalId}`;
    if (edges.has(key)) context.addIssue({ code: "custom", message: "duplicate dependency edge" });
    edges.add(key);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of value.edges)
    outgoing.set(edge.fromLocalId, [...(outgoing.get(edge.fromLocalId) ?? []), edge.toLocalId]);
  const state = new Map<string, 0 | 1 | 2>();
  const cyclic = (node: string): boolean => {
    const seen = state.get(node);
    if (seen === 1) return true;
    if (seen === 2) return false;
    state.set(node, 1);
    for (const next of outgoing.get(node) ?? []) if (cyclic(next)) return true;
    state.set(node, 2);
    return false;
  };
  if (locals.some(cyclic)) context.addIssue({ code: "custom", message: "dependency edges must not form a cycle" });
}

export const workBatchProposalSchemaV1 = z.object({
  schema: z.literal(WORK_BATCH_PROPOSAL_V1),
  projectId: id,
  tasks: z.array(workBatchProposalTaskSchemaV1).min(1).max(WORK_BATCH_MAX_TASKS_V1),
  edges: z.array(z.object({ fromLocalId: localId, toLocalId: localId }).strict()).max(WORK_BATCH_MAX_EDGES_V1),
}).strict().superRefine(validateWorkBatchProposalGraphV1);

export type WorkBatchProposalV1 = z.infer<typeof workBatchProposalSchemaV1>;

export const workBatchReceiptSchemaV1 = z.object({
  schema: z.literal(WORK_BATCH_RECEIPT_V1), batchId: id, projectId: id,
  state: z.literal("proposed"), proposalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  revision: z.literal(1), replayed: z.boolean(), startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();
export type WorkBatchReceiptV1 = z.infer<typeof workBatchReceiptSchemaV1>;
