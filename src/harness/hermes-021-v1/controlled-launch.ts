import { z } from "zod";
import {
  HERMES_021_MACOS_LOCAL_ADAPTER_V1,
  hermes021MacosLocalBindingSchemaV1,
  hermes021MacosTaskSchemaV1,
  type Hermes021MacosLocalPrivatePortV1,
  type Hermes021MacosTaskOutcomeV1,
} from "./macos-local-worker";

export const HERMES_021_MACOS_TEXT_ONLY_QUALIFICATION_V1 =
  "control-room.hermes-021-macos-text-only-qualification/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const qualificationTaskSchema = hermes021MacosTaskSchemaV1.extend({
  qualificationId: id,
  /** The first live check has no tools, one turn, and a bounded runtime. */
  mode: z.literal("text_only"),
  toolset: z.literal("bot_room"),
  maximumTurns: z.literal(1),
  maximumRunBudgetSeconds: z.literal(120),
  sourceTag: z.literal("control-room-local-qualification"),
}).strict();

export type Hermes021MacosTextOnlyQualificationTaskV1 = z.infer<typeof qualificationTaskSchema>;

export interface Hermes021MacosQualificationPrivatePortV1 {
  runTextOnlyQualification(input: Readonly<{
    localServiceId: string;
    adapterId: typeof HERMES_021_MACOS_LOCAL_ADAPTER_V1;
    sourceRevision: string;
    task: Hermes021MacosTextOnlyQualificationTaskV1;
    signal?: AbortSignal;
  }>): Promise<readonly unknown[]>;
}

const unavailable = (): never => { throw new Error("hermes_021_macos_qualification_unavailable"); };

/**
 * The only launch contract permitted before an owner enables a fuller local
 * work policy. The host owns the actual Hermes executable and login; this
 * module carries neither. It calls the injected port once, and a lost reply is
 * reported as uncertainty rather than retried.
 */
export async function runHermes021MacosTextOnlyQualificationV1(
  bindingValue: unknown,
  taskValue: unknown,
  privatePort: Hermes021MacosQualificationPrivatePortV1,
  classify: (lines: readonly unknown[]) => Hermes021MacosTaskOutcomeV1,
  signal?: AbortSignal,
): Promise<Hermes021MacosTaskOutcomeV1> {
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  const task = qualificationTaskSchema.parse(taskValue);
  if (!privatePort || typeof privatePort.runTextOnlyQualification !== "function"
    || typeof classify !== "function" || signal?.aborted) unavailable();
  try {
    const lines = await privatePort.runTextOnlyQualification(Object.freeze({
      localServiceId: binding.localServiceId,
      adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
      sourceRevision: binding.sourceRevision,
      task,
      signal,
    }));
    if (!Array.isArray(lines)) return Object.freeze({ kind: "uncertain", reason: "hermes_local_result_invalid" });
    return classify(lines);
  } catch {
    return Object.freeze({ kind: "uncertain", reason: "hermes_local_transport_unavailable" });
  }
}
