import { z } from "zod";
import { workBatchProposalSchemaV1, workBatchLocalIdSchemaV1 } from "./schemas";
import { workBatchQueueModelIdSchemaV1 } from "./queue-catalog";
import { INTAKE_FLAG_KINDS_V1 } from "./intake-gate";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const reason = z.string().min(3).max(64).regex(/^[a-z][a-z0-9_]*$/u);
const decision = z.object({ localId: workBatchLocalIdSchemaV1,
  decision: z.enum(["approve", "reject"]), reasonCode: reason.optional() }).strict()
  .superRefine((value, context) => {
    if (value.decision === "reject" && !value.reasonCode) context.addIssue({ code: "custom", message: "reason required" });
    if (value.decision === "approve" && value.reasonCode) context.addIssue({ code: "custom", message: "reason forbidden" });
  });

const localId = workBatchLocalIdSchemaV1;

export const workBatchOwnerCommandSchemaV1 = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("revise"), batchId: id, expectedRevision: z.number().int().min(1),
    reasonCode: reason, proposal: workBatchProposalSchemaV1 }).strict(),
  z.object({ operation: z.literal("decide"), batchId: id, expectedRevision: z.number().int().min(1),
    items: z.array(decision).min(1).max(32) }).strict(),
  z.object({ operation: z.literal("dismiss_flag"), batchId: id, expectedRevision: z.number().int().min(1),
    localId, flagKind: z.enum(INTAKE_FLAG_KINDS_V1), reasonCode: reason }).strict(),
]);
export type WorkBatchOwnerCommandV1 = z.infer<typeof workBatchOwnerCommandSchemaV1>;

export const workBatchOwnerReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.work-batch-owner-receipt/v1"), batchId: id, projectId: id,
  state: z.enum(["proposed", "approved", "partially_approved", "rejected"]),
  revision: z.number().int().min(1), jobIds: z.array(id).max(32), replayed: z.boolean(),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type WorkBatchOwnerReceiptV1 = z.infer<typeof workBatchOwnerReceiptSchemaV1>;

export const workBatchOwnerSummarySchemaV1 = z.object({ batchId: id, projectId: id,
  state: z.enum(["proposed", "approved", "partially_approved", "rejected"]), revision: z.number().int().min(1),
  proposedByIdentityId: id, proposedAt: z.string().datetime(), taskCount: z.number().int().min(1).max(32),
  approvalIdentityId: id.nullable(), decidedAt: z.string().datetime().nullable() }).strict();
export const workBatchOwnerPageSchemaV1 = z.object({ batches: z.array(workBatchOwnerSummarySchemaV1).max(100),
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict();

export const workBatchIntakeFlagSchemaV1 = z.object({ kind: z.enum(INTAKE_FLAG_KINDS_V1),
  reasonCode: reason, dismissed: z.boolean() }).strict();
export type WorkBatchIntakeFlagV1 = z.infer<typeof workBatchIntakeFlagSchemaV1>;

export const workBatchOwnerItemSchemaV1 = z.object({ localId, ordinal: z.number().int().min(0).max(31),
  role: z.enum(["builder", "checker", "validator"]), requiredCapability: id,
  dependsOnLocalIds: z.array(localId).max(31), requestedWorkerId: id.nullable(),
  requestedWorkerKind: id.nullable(), requestedModelKey: workBatchQueueModelIdSchemaV1.nullable(),
  acceptanceCriteria: z.string().min(1).max(4_000), acceptanceTests: z.string().min(1).max(4_000),
  decisionState: z.enum(["approved", "rejected"]), decisionReasonCode: reason.nullable(), jobId: id.nullable() }).strict();
export const workBatchQueueItemSchemaV1 = z.object({ localId, jobId: id, workerId: id, workerKind: id,
  nodeId: id, position: z.number().int().min(1), queueDepthLimit: z.number().int().min(1).max(20),
  selectionKey: workBatchQueueModelIdSchemaV1, model: workBatchQueueModelIdSchemaV1, effort: id,
  provider: workBatchQueueModelIdSchemaV1.nullable(), profile: workBatchQueueModelIdSchemaV1.nullable(),
  state: z.enum(["awaiting_preparation", "waiting_dependency", "waiting_turn", "ready_for_assignment",
    "assigned", "queued", "running", "completed", "failed", "uncertain"]) }).strict();
export const workBatchRoutingOptionSchemaV1 = z.object({ workerId: id, workerKind: id, nodeId: id,
  modelKeys: z.array(workBatchQueueModelIdSchemaV1).max(32) }).strict();
export type WorkBatchRoutingOptionV1 = z.infer<typeof workBatchRoutingOptionSchemaV1>;
export const workBatchOwnerViewSchemaV1 = z.object({ batchId: id, projectId: id,
  state: z.enum(["proposed", "approved", "partially_approved", "rejected"]), revision: z.number().int().min(1),
  proposedByIdentityId: id, proposedAt: z.string().datetime(), approvalIdentityId: id.nullable(),
  decidedAt: z.string().datetime().nullable(), proposal: workBatchProposalSchemaV1,
  revisions: z.array(z.object({ revision: z.number().int().min(1), editedByIdentityId: id,
    editedAt: z.string().datetime(), reasonCode: reason, proposal: workBatchProposalSchemaV1 }).strict()).max(100),
  items: z.array(workBatchOwnerItemSchemaV1).max(32), queue: z.array(workBatchQueueItemSchemaV1).max(32),
  queueDepthLimit: z.number().int().min(1).max(20),
  flagsByLocalId: z.record(z.string(), z.array(workBatchIntakeFlagSchemaV1).max(3)),
  routingOptions: z.array(workBatchRoutingOptionSchemaV1).max(64).optional(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();
export type WorkBatchOwnerViewV1 = z.infer<typeof workBatchOwnerViewSchemaV1>;
