import { z } from "zod";
import { sha256Digest } from "../../security";
import { PROJECT_COORDINATION_MAX_EDGES_V1, PROJECT_COORDINATION_MAX_TASKS_V1,
  projectCoordinationProposalSchemaV1, projectCoordinationProposalTaskSchemaV1,
  validateProjectCoordinationProposalGraphV1 } from
  "../../project-coordination/v1/schemas";

export const WORK_BATCH_PROPOSAL_V1 = "control-room.work-batch-proposal/v1" as const;
export const WORK_BATCH_RECEIPT_V1 = "control-room.work-batch-receipt/v1" as const;
export const WORK_BATCH_MAX_TASKS_V1 = PROJECT_COORDINATION_MAX_TASKS_V1;
export const WORK_BATCH_MAX_EDGES_V1 = PROJECT_COORDINATION_MAX_EDGES_V1;
const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const workBatchProposalSchemaV1 = projectCoordinationProposalSchemaV1.omit({schema:true}).safeExtend({
  schema: z.literal(WORK_BATCH_PROPOSAL_V1),
  tasks: z.array(projectCoordinationProposalTaskSchemaV1.extend({
    role: z.enum(["builder", "checker", "validator"]),
    requestedWorkerKind: id.optional(),
    requestedModelKey: id.optional(),
    acceptanceCriteria: z.string().min(1).max(4_000),
    acceptanceTests: z.string().min(1).max(4_000),
  }).strict()).min(1).max(WORK_BATCH_MAX_TASKS_V1),
}).strict().superRefine(validateProjectCoordinationProposalGraphV1);

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
