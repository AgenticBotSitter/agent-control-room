import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { hermes021MacosLocalBindingSchemaV1, HERMES_021_MACOS_LOCAL_ADAPTER_V1,
  type Hermes021MacosTaskPolicyPortV1 } from "./macos-local-worker";
import { controllerWorkerDeliverySchemaV1 } from "../v1/controller-worker-delivery";

export const HERMES_021_MACOS_LOCAL_TASK_POLICY_V1 =
  "control-room.hermes-021-macos-local-task-policy/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const policySchema = z.object({
  schema: z.literal(HERMES_021_MACOS_LOCAL_TASK_POLICY_V1),
  policyId: z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  binding: hermes021MacosLocalBindingSchemaV1,
  /** Existing canonical task authority, never a new permission invented here. */
  authorityDigest: digest,
  /** Exact approved prompt/instruction pair, never a browser or worker claim. */
  taskInputDigest: digest,
  /** Exact controller packet: identical text or authority never substitutes another task. */
  deliveryDigest: digest,
  expiresAt: instant,
  policyDigest: digest,
}).strict().superRefine((value, context) => {
  const { policyDigest, ...material } = value;
  if (policyDigest !== sha256Digest(material)) context.addIssue({ code: "custom", message: "local Hermes task policy mismatch", path: ["policyDigest"] });
});
export type Hermes021MacosLocalTaskPolicyV1 = z.infer<typeof policySchema>;

export function createHermes021MacosLocalTaskPolicyV1(value: Omit<Hermes021MacosLocalTaskPolicyV1, "schema" | "policyDigest">): Hermes021MacosLocalTaskPolicyV1 {
  const material = z.object({ policyId: policySchema.shape.policyId, binding: hermes021MacosLocalBindingSchemaV1,
    authorityDigest: digest, taskInputDigest: digest, deliveryDigest: digest, expiresAt: instant }).strict().parse(value);
  return Object.freeze(policySchema.parse({ schema: HERMES_021_MACOS_LOCAL_TASK_POLICY_V1, ...material,
    policyDigest: sha256Digest({ schema: HERMES_021_MACOS_LOCAL_TASK_POLICY_V1, ...material }) }));
}

/**
 * Converts one operator-provided policy record into the runner's synchronous
 * gate. It owns no workspace path, provider, login or model information and
 * cannot approve a delivery whose canonical authority differs from the one
 * the operator already selected. The application must build this record from
 * its authoritative task plan; it must never accept one from a browser or
 * worker message.
 */
export function createHermes021MacosLocalTaskPolicyPortV1(policyValue: unknown,
  clock: () => number = Date.now): Hermes021MacosTaskPolicyPortV1 {
  const policy = policySchema.parse(policyValue);
  if (typeof clock !== "function") throw new Error("hermes_021_macos_task_policy_unavailable");
  return Object.freeze({ assertAdmitted(input: Parameters<Hermes021MacosTaskPolicyPortV1["assertAdmitted"]>[0]) {
    const now = clock(), deadline = Date.parse(policy.expiresAt);
    if (!Number.isSafeInteger(now) || now < 0 || now >= deadline
      // The installation policy may have a longer lifetime than one delivery.
      // Recheck the delivery's own window at the private launch boundary so a
      // queued, future-dated, or expired packet never starts Hermes directly.
      || Date.parse(input.delivery.issuedAt) > now || Date.parse(input.delivery.expiresAt) <= now
      || input.binding.localServiceId !== policy.binding.localServiceId
      || input.binding.workerId !== policy.binding.workerId
      || input.binding.sourceRevision !== policy.binding.sourceRevision
      || input.delivery.worker.workerId !== policy.binding.workerId
      || input.delivery.worker.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
      || input.delivery.worker.adapterRevision !== policy.binding.sourceRevision
      || input.delivery.authorityDigest !== policy.authorityDigest
      || sha256Digest({ prompt: input.delivery.input.prompt, instructions: input.delivery.input.instructions }) !== policy.taskInputDigest
      || input.delivery.deliveryDigest !== policy.deliveryDigest
      || Date.parse(input.delivery.expiresAt) > deadline) throw new Error("hermes_021_macos_task_policy_refused");
  } });
}

/**
 * Derive a fresh local policy only from a controller-prepared packet and the
 * fixed installation binding.  The caller is deliberately unable to supply
 * an authority, prompt, expiry, or policy identifier of its own.  This is the
 * policy constructor used by the long-lived local queue composition: every
 * pickup gets a policy for its own canonical task instead of retaining the
 * first task's policy in process memory.
 */
export function deriveHermes021MacosLocalTaskPolicyPortV1(preparedValue: unknown,
  bindingValue: unknown, clock: () => number = Date.now): Hermes021MacosTaskPolicyPortV1 {
  const prepared = z.object({
    schema: z.literal("control-room.hermes-021-macos-dispatch-preparation/v1"),
    delivery: controllerWorkerDeliverySchemaV1,
    workflowId: id,
    route: z.object({ kind: z.literal("local"), workerId: id }).strict(),
    executionClass: z.literal("text_review"),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
  }).strict().parse(preparedValue);
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  const delivery = prepared.delivery;
  if (prepared.route.workerId !== binding.workerId || delivery.worker.workerId !== binding.workerId
    || delivery.worker.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
    || delivery.worker.adapterRevision !== binding.sourceRevision) {
    throw new Error("hermes_021_macos_task_policy_refused");
  }
  const policyId = `policy:hermes-021:${sha256Digest({ identity: delivery.identity, worker: delivery.worker,
    authorityDigest: delivery.authorityDigest, input: delivery.input, expiresAt: delivery.expiresAt }).slice(7)}`;
  return createHermes021MacosLocalTaskPolicyPortV1(createHermes021MacosLocalTaskPolicyV1({
    policyId, binding, authorityDigest: delivery.authorityDigest,
    taskInputDigest: sha256Digest({ prompt: delivery.input.prompt, instructions: delivery.input.instructions }),
    deliveryDigest: delivery.deliveryDigest,
    expiresAt: delivery.expiresAt,
  }), clock);
}
