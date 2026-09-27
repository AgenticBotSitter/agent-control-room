import { z } from "zod";
import { sha256Digest } from "../../security";

export const WORK_BATCH_PROPOSAL_V1 = "control-room.work-batch-proposal/v1" as const;
export const WORK_BATCH_RECEIPT_V1 = "control-room.work-batch-receipt/v1" as const;
export const WORK_BATCH_MAX_TASKS_V1 = 32;
export const WORK_BATCH_MAX_EDGES_V1 = 64;

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const localId = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const line = z.string().min(1).max(180).refine(value => !/[\r\n]/u.test(value));

export const workBatchProposalSchemaV1 = z.object({
  schema: z.literal(WORK_BATCH_PROPOSAL_V1),
  projectId: id,
  tasks: z.array(z.object({
    localId,
    title: line,
    instructions: z.string().min(1).max(4_000),
    requiredCapability: id,
    role: z.enum(["builder", "checker", "validator"]),
    requestedWorkerKind: id.optional(),
    requestedModelKey: id.optional(),
    acceptanceCriteria: z.string().min(1).max(4_000),
    acceptanceTests: z.string().min(1).max(4_000),
  }).strict()).min(1).max(WORK_BATCH_MAX_TASKS_V1),
  edges: z.array(z.object({ fromLocalId: localId, toLocalId: localId }).strict())
    .max(WORK_BATCH_MAX_EDGES_V1),
}).strict().superRefine((value, context) => {
  const locals = value.tasks.map(task => task.localId);
  if (new Set(locals).size !== locals.length)
    context.addIssue({ code: "custom", message: "duplicate local id" });
  const known = new Set(locals), seenEdges = new Set<string>(), outgoing = new Map<string, string[]>();
  for (const edge of value.edges) {
    if (edge.fromLocalId === edge.toLocalId || !known.has(edge.fromLocalId) || !known.has(edge.toLocalId))
      context.addIssue({ code: "custom", message: "invalid dependency edge" });
    const key = `${edge.fromLocalId}\u0000${edge.toLocalId}`;
    if (seenEdges.has(key)) context.addIssue({ code: "custom", message: "duplicate dependency edge" });
    seenEdges.add(key);
    outgoing.set(edge.fromLocalId, [...(outgoing.get(edge.fromLocalId) ?? []), edge.toLocalId]);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const cyclic = (node: string): boolean => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    if ((outgoing.get(node) ?? []).some(cyclic)) return true;
    state.set(node, 2); return false;
  };
  if (locals.some(cyclic)) context.addIssue({ code: "custom", message: "cyclic dependency graph" });
});

export type WorkBatchProposalV1 = z.infer<typeof workBatchProposalSchemaV1>;
export function workBatchProposalDigestV1(value: unknown): string {
  return sha256Digest(workBatchProposalSchemaV1.parse(value));
}

export const workBatchReceiptSchemaV1 = z.object({
  schema: z.literal(WORK_BATCH_RECEIPT_V1), batchId: id, projectId: id,
  state: z.literal("proposed"), proposalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  revision: z.literal(1), replayed: z.boolean(), startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();
export type WorkBatchReceiptV1 = z.infer<typeof workBatchReceiptSchemaV1>;
