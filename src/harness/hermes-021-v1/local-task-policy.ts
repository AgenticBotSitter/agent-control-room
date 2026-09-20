import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { hermes021MacosLocalBindingSchemaV1, HERMES_021_MACOS_LOCAL_ADAPTER_V1,
  type Hermes021MacosTaskPolicyPortV1 } from "./macos-local-worker";

export const HERMES_021_MACOS_LOCAL_TASK_POLICY_V1 =
  "control-room.hermes-021-macos-local-task-policy/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const policySchema = z.object({
  schema: z.literal(HERMES_021_MACOS_LOCAL_TASK_POLICY_V1),
  policyId: z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  binding: hermes021MacosLocalBindingSchemaV1,
  /** Existing canonical task authority, never a new permission invented here. */
  authorityDigest: digest,
  /** Exact approved prompt/instruction pair, never a browser or worker claim. */
  taskInputDigest: digest,
  expiresAt: instant,
  policyDigest: digest,
}).strict().superRefine((value, context) => {
  const { policyDigest, ...material } = value;
  if (policyDigest !== sha256Digest(material)) context.addIssue({ code: "custom", message: "local Hermes task policy mismatch", path: ["policyDigest"] });
});
export type Hermes021MacosLocalTaskPolicyV1 = z.infer<typeof policySchema>;

export function createHermes021MacosLocalTaskPolicyV1(value: Omit<Hermes021MacosLocalTaskPolicyV1, "schema" | "policyDigest">): Hermes021MacosLocalTaskPolicyV1 {
  const material = z.object({ policyId: policySchema.shape.policyId, binding: hermes021MacosLocalBindingSchemaV1,
    authorityDigest: digest, taskInputDigest: digest, expiresAt: instant }).strict().parse(value);
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
      || input.binding.localServiceId !== policy.binding.localServiceId
      || input.binding.workerId !== policy.binding.workerId
      || input.binding.sourceRevision !== policy.binding.sourceRevision
      || input.delivery.worker.workerId !== policy.binding.workerId
      || input.delivery.worker.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
      || input.delivery.worker.adapterRevision !== policy.binding.sourceRevision
      || input.delivery.authorityDigest !== policy.authorityDigest
      || sha256Digest({ prompt: input.delivery.input.prompt, instructions: input.delivery.input.instructions }) !== policy.taskInputDigest
      || Date.parse(input.delivery.expiresAt) > deadline) throw new Error("hermes_021_macos_task_policy_refused");
  } });
}
