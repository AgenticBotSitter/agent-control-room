import { isAbsolute, normalize } from "node:path";
import type { OwnerTrustedLocalCliExecutionAdapterV1 } from "../v1/owner-trusted-local-cli-execution";
import type { OwnerTrustedLocalHermesExecV1 } from "./owner-trusted-local-exec";
import { MAX_TASK_RUN_OUTPUT_BYTES, MIN_TASK_RUN_OUTPUT_BYTES } from "../v1/owner-trusted-local-run-limits";

function unavailable(): never { throw new Error("owner_trusted_local_hermes_execution_unavailable"); }
const identifier = /^[A-Za-z0-9._:/-]{1,180}$/u;
const MAX_PROMPT_BYTES = 49_152;
function path(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096
  && isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value); }

function prompt(input: Readonly<{ prompt: string; instructions: string }>) {
  const value = [
    "You are completing one approved Agent Control Room task in its assigned local workspace.",
    "Use only the tools needed for this task, stay inside the current working directory, and do not retry, resume, use the network, or widen authority.",
    "Return the requested bounded result after the work is complete.",
    "", "Instructions:", input.instructions, "", "Task:", input.prompt, "",
  ].join("\n");
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES) unavailable();
  return value;
}

/** Protected configuration for one approved Hermes local worker. The chosen
 * model/provider are values, not source constants, so a normal model change
 * is a configuration/qualification event rather than a code change. */
export type OwnerTrustedLocalHermesExecutionConfigurationV1 = Readonly<{
  executablePath: string; workingDirectory: string; deadlineMs: number; outputBytes?: number;
} & ({ profile: string; model: string; provider: string } |
  { select(jobId: string): Promise<{ profile: string; model: string; provider: string }> })>;

function capture(value: unknown): OwnerTrustedLocalHermesExecutionConfigurationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const item = value as Record<string, unknown>;
  const executablePath = item.executablePath, workingDirectory = item.workingDirectory;
  const profile = item.profile, model = item.model, provider = item.provider, deadlineMs = item.deadlineMs;
  const dynamic = typeof item.select === "function";
  const expected = (dynamic ? 4 : 6) + (item.outputBytes === undefined ? 0 : 1);
  if (Object.keys(item).length !== expected || !path(executablePath) || !path(workingDirectory)
    || !dynamic && (typeof profile !== "string" || !identifier.test(profile)
    || typeof model !== "string" || !identifier.test(model)
    || typeof provider !== "string" || !identifier.test(provider))
    || typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs)
    || deadlineMs < 100 || deadlineMs > 3_600_000
    || item.outputBytes !== undefined && (typeof item.outputBytes !== "number" || !Number.isSafeInteger(item.outputBytes)
      || item.outputBytes < MIN_TASK_RUN_OUTPUT_BYTES || item.outputBytes > MAX_TASK_RUN_OUTPUT_BYTES)) return unavailable();
  return Object.freeze({ executablePath, workingDirectory, deadlineMs,
    ...(item.outputBytes === undefined ? {} : { outputBytes: item.outputBytes as number }),
    ...(dynamic ? { select: item.select as (jobId: string) => Promise<{ profile: string; model: string; provider: string }> }
      : { profile: profile as string, model: model as string, provider: provider as string }) }) as OwnerTrustedLocalHermesExecutionConfigurationV1;
}

/** Maps the proven direct Hermes runner to the one shared local CLI delivery
 * contract. This is only an adapter: receipt, current-authority checks and
 * canonical result publication remain with the existing Control Room bridge. */
export function createOwnerTrustedLocalHermesExecutionAdapterV1(executor: OwnerTrustedLocalHermesExecV1,
  configuration: unknown): OwnerTrustedLocalCliExecutionAdapterV1 {
  const fixed = capture(configuration);
  if (!executor || typeof executor.execute !== "function") unavailable();
  return Object.freeze({ async execute(input) {
    if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted) unavailable();
    const selected = "select" in fixed ? await fixed.select(input.delivery.identity.jobId) : fixed;
    const result = await executor.execute(Object.freeze({ executablePath: fixed.executablePath,
      workingDirectory: fixed.workingDirectory, deadlineMs: fixed.deadlineMs,
      ...(fixed.outputBytes === undefined ? {} : { outputBytes: fixed.outputBytes }),
      profile: selected.profile, model: selected.model, provider: selected.provider,
      prompt: prompt(input.delivery.input), signal: input.signal }));
    if (result.status === "completed") return Object.freeze({ kind: "completed" as const, text: result.text });
    return Object.freeze({ kind: "failed" as const, reason: `${result.status}:${result.reason}` });
  } });
}
