import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { controllerWorkerDeliveryReceiptSchemaV1 } from "./controller-worker-delivery";

/** Optional negotiated feature for generic, non-executing worker evidence. */
export const CONTROLLER_WORKER_RESULT_RETURN_FEATURE_V1 = "controller.worker.result.return.v1" as const;

export const CONTROLLER_WORKER_PROGRESS_RETURN_V1 =
  "control-room.controller-worker-progress-return/v1" as const;
export const CONTROLLER_WORKER_TERMINAL_RETURN_V1 =
  "control-room.controller-worker-terminal-return/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const identity = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id,
  runId: id, nodeId: id, workerId: id }).strict();
const common = {
  identity,
  deliveryReceipt: controllerWorkerDeliveryReceiptSchemaV1,
  enrollmentDigest: digest,
  connectionId: id,
  sequence: z.number().int().positive(),
  occurredAt: instant,
};

const progressMaterialSchemaV1 = z.object({
  schema: z.literal(CONTROLLER_WORKER_PROGRESS_RETURN_V1),
  ...common,
  progressPercent: z.number().min(0).max(100),
  evidenceDigest: digest,
}).strict();

/**
 * Progress is authenticated evidence only. It cannot complete a task, release
 * capacity, publish a result, retry delivery, or grant execution authority.
 */
export const controllerWorkerProgressReturnBodySchemaV1 = progressMaterialSchemaV1.extend({
  returnDigest: digest,
}).strict().superRefine((value, context) => {
  const { returnDigest, ...material } = value;
  if (returnDigest !== sha256Digest(material)
    || value.deliveryReceipt.deliveryId.length < 3
    || value.deliveryReceipt.deliveryDigest.length !== 71
    || value.deliveryReceipt.receiptDigest.length !== 71
    || value.deliveryReceipt.workerId !== value.identity.workerId
    || value.deliveryReceipt.route.kind !== "remote"
    || value.deliveryReceipt.route.workerId !== value.identity.workerId) {
    context.addIssue({ code: "custom", message: "controller worker progress return binding mismatch" });
  }
});
export type ControllerWorkerProgressReturnBodyV1 = z.infer<typeof controllerWorkerProgressReturnBodySchemaV1>;

const terminalMaterialSchemaV1 = z.object({
  schema: z.literal(CONTROLLER_WORKER_TERMINAL_RETURN_V1),
  ...common,
  outcome: z.enum(["completed", "failed", "cancelled"]),
  resultEvidenceDigest: digest.nullable(),
  safeReasonCode: id.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.outcome === "completed") !== (value.resultEvidenceDigest !== null)
    || (value.outcome === "completed") === (value.safeReasonCode !== null)) {
    context.addIssue({ code: "custom", message: "terminal outcome evidence mismatch" });
  }
});

/**
 * Terminal evidence deliberately stops before canonical result publication.
 * The digest can later be presented to a reviewed publisher, but this contract
 * itself changes no task, attempt, lease, result, review, or capacity record.
 */
export const controllerWorkerTerminalReturnBodySchemaV1 = terminalMaterialSchemaV1.safeExtend({
  returnDigest: digest,
}).strict().superRefine((value, context) => {
  const { returnDigest, ...material } = value;
  if (returnDigest !== sha256Digest(material)
    || value.deliveryReceipt.workerId !== value.identity.workerId
    || value.deliveryReceipt.route.kind !== "remote"
    || value.deliveryReceipt.route.workerId !== value.identity.workerId) {
    context.addIssue({ code: "custom", message: "controller worker terminal return binding mismatch" });
  }
});
export type ControllerWorkerTerminalReturnBodyV1 = z.infer<typeof controllerWorkerTerminalReturnBodySchemaV1>;
export type ControllerWorkerResultReturnBodyV1 =
  | ControllerWorkerProgressReturnBodyV1
  | ControllerWorkerTerminalReturnBodyV1;

export function createControllerWorkerProgressReturnV1(value:
Omit<ControllerWorkerProgressReturnBodyV1, "schema" | "returnDigest">): ControllerWorkerProgressReturnBodyV1 {
  const material = progressMaterialSchemaV1.parse({ schema: CONTROLLER_WORKER_PROGRESS_RETURN_V1, ...value });
  return Object.freeze(controllerWorkerProgressReturnBodySchemaV1.parse({ ...material,
    returnDigest: sha256Digest(material) }));
}

export function createControllerWorkerTerminalReturnV1(value:
Omit<ControllerWorkerTerminalReturnBodyV1, "schema" | "returnDigest">): ControllerWorkerTerminalReturnBodyV1 {
  const material = terminalMaterialSchemaV1.parse({ schema: CONTROLLER_WORKER_TERMINAL_RETURN_V1, ...value });
  return Object.freeze(controllerWorkerTerminalReturnBodySchemaV1.parse({ ...material,
    returnDigest: sha256Digest(material) }));
}

/** Frame-level checks bind the body to the authenticated signed-node session. */
export function assertControllerWorkerResultReturnFrameV1(input: Readonly<{
  tenantId: string;
  actorId: string;
  connectionId: string;
  sentAt: string;
  body: ControllerWorkerResultReturnBodyV1;
}>): void {
  const body = input.body.schema === CONTROLLER_WORKER_PROGRESS_RETURN_V1
    ? controllerWorkerProgressReturnBodySchemaV1.parse(input.body)
    : controllerWorkerTerminalReturnBodySchemaV1.parse(input.body);
  if (input.tenantId !== body.identity.tenantId || input.actorId !== body.identity.nodeId
    || input.connectionId !== body.connectionId
    || Date.parse(body.occurredAt) > Date.parse(input.sentAt)) {
    throw new Error("controller_worker_result_return_frame_mismatch");
  }
}
