import { isAbsolute, normalize } from "node:path";
import type { OwnerTrustedLocalClaudeExecV1 } from "../claude-code-v1/owner-trusted-local-exec";
import type { OwnerTrustedLocalCodexExecV1 } from "../codex-v1/owner-trusted-local-exec";
import type { OwnerTrustedLocalCliExecutionV1 } from "./owner-trusted-local-cli-delivery";

const MAX_PROMPT_BYTES = 49_152;
const invalid = (): never => { throw new Error("owner_trusted_local_cli_execution_unavailable"); };

type ExecutionInput = Readonly<{ delivery: Readonly<{ input: Readonly<{ prompt: string; instructions: string }> }>; signal: AbortSignal }>;
export type OwnerTrustedLocalCliExecutionAdapterV1 = Readonly<{ execute(input: ExecutionInput): Promise<OwnerTrustedLocalCliExecutionV1> }>;

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value)
    && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeConfiguration(value: unknown): value is Readonly<{ executablePath: string; workingDirectory: string; deadlineMs: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && safePath(record.executablePath) && safePath(record.workingDirectory)
    && Number.isSafeInteger(record.deadlineMs) && typeof record.deadlineMs === "number"
    && record.deadlineMs >= 100 && record.deadlineMs <= 3_600_000;
}

/** A fixed plain-text envelope. The packet remains the task authority; this
 * only translates it for a preselected local CLI and cannot add tools, model
 * settings, credentials, a workspace, or a second task lifecycle. */
export function ownerTrustedLocalCliPromptV1(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>, instructions = value.instructions, task = value.prompt;
  if (typeof instructions !== "string" || typeof task !== "string") invalid();
  const prompt = [
    "You are completing one approved Agent Control Room text-only task.",
    "Return only the requested bounded result. Do not use tools, retry, resume, or widen authority.",
    "",
    "Instructions:", instructions, "", "Task:", task, "",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") < 1 || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) invalid();
  return prompt;
}

function mapped(result: Readonly<{ status: string; text?: string; reason?: string }>): OwnerTrustedLocalCliExecutionV1 {
  if (result.status === "completed" && typeof result.text === "string") return Object.freeze({ kind: "completed" as const, text: result.text });
  if ((result.status === "failed" || result.status === "canceled" || result.status === "timed_out" || result.status === "cleanup_uncertain")
    && typeof result.reason === "string" && result.reason.length >= 1 && result.reason.length <= 240)
    return Object.freeze({ kind: "failed" as const, reason: `${result.status}:${result.reason}` });
  invalid();
}

function capture(executor: Readonly<{ execute(input: Readonly<{ executablePath: string; prompt: string; workingDirectory: string;
  deadlineMs: number; signal: AbortSignal }>): Promise<Readonly<{ status: string; text?: string; reason?: string }>> }>,
  configuration: unknown): OwnerTrustedLocalCliExecutionAdapterV1 {
  if (!executor || typeof executor.execute !== "function" || !safeConfiguration(configuration)) invalid();
  const fixed = Object.freeze({ ...configuration });
  return Object.freeze({ async execute(input: ExecutionInput) {
    if (!input || typeof input !== "object" || !(input.signal instanceof AbortSignal) || input.signal.aborted) invalid();
    const result = await executor.execute(Object.freeze({ executablePath: fixed.executablePath,
      workingDirectory: fixed.workingDirectory, deadlineMs: fixed.deadlineMs,
      prompt: ownerTrustedLocalCliPromptV1(input.delivery.input), signal: input.signal }));
    return mapped(result);
  } });
}

/** Selects the already verified direct Codex CLI runner for one owner-pinned
 * executable. It is an adapter only; queue delivery and result publication
 * remain outside this module. */
export function createOwnerTrustedLocalCodexExecutionAdapterV1(executor: OwnerTrustedLocalCodexExecV1,
  configuration: unknown): OwnerTrustedLocalCliExecutionAdapterV1 {
  return capture(executor, configuration);
}

/** Selects the already verified direct Claude CLI runner for one owner-pinned
 * executable. It deliberately does not choose a Claude model or enable tools. */
export function createOwnerTrustedLocalClaudeExecutionAdapterV1(executor: OwnerTrustedLocalClaudeExecV1,
  configuration: unknown): OwnerTrustedLocalCliExecutionAdapterV1 {
  return capture(executor, configuration);
}
