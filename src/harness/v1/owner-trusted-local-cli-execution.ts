import { isAbsolute, normalize } from "node:path";
import type { OwnerTrustedLocalClaudeExecV1 } from "../claude-code-v1/owner-trusted-local-exec";
import type { OwnerTrustedLocalCodexExecV1 } from "../codex-v1/owner-trusted-local-exec";
import type { OwnerTrustedLocalCliExecutionV1 } from "./owner-trusted-local-cli-delivery";
import { MAX_TASK_RUN_OUTPUT_BYTES, MIN_TASK_RUN_OUTPUT_BYTES, captureMacLocalTaskRunResourcesV1,
  type MacLocalTaskRunResourcesV1 } from "./owner-trusted-local-run-limits";

const MAX_PROMPT_BYTES = 49_152;
const invalid = (): never => { throw new Error("owner_trusted_local_cli_execution_unavailable"); };

type ExecutionInput = Readonly<{ delivery: Readonly<{ identity: Readonly<{ jobId: string }>;
  input: Readonly<{ prompt: string; instructions: string }> }>; signal: AbortSignal }>;
export type OwnerTrustedLocalCliExecutionAdapterV1 = Readonly<{ execute(input: ExecutionInput): Promise<OwnerTrustedLocalCliExecutionV1> }>;

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value)
    && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

type CliSelection = Readonly<{ model: string; effort: string; supportsEffort?: boolean }>;
function safeConfiguration(value: unknown, claude: boolean): value is Readonly<{
  executablePath: string; workingDirectory: string; deadlineMs: number; outputBytes?: number;
  resources?: MacLocalTaskRunResourcesV1;
  select?: (jobId: string) => Promise<CliSelection> } & Partial<CliSelection>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const dynamic = typeof record.select === "function";
  const fixedSelection = typeof record.model === "string";
  const optional = (record.outputBytes === undefined ? 0 : 1) + (record.resources === undefined ? 0 : 1);
  const expected = (dynamic ? 4 : fixedSelection ? claude ? 6 : 5 : 3) + optional;
  return keys.length === expected && keys.every(key => ["executablePath", "workingDirectory", "deadlineMs", "outputBytes", "resources", "select",
    "model", "effort", ...(claude ? ["supportsEffort"] : [])].includes(key))
    && safePath(record.executablePath) && safePath(record.workingDirectory)
    && typeof record.deadlineMs === "number" && Number.isSafeInteger(record.deadlineMs)
    && record.deadlineMs >= 100 && record.deadlineMs <= 3_600_000
    && (record.outputBytes === undefined || typeof record.outputBytes === "number" && Number.isSafeInteger(record.outputBytes)
      && record.outputBytes >= MIN_TASK_RUN_OUTPUT_BYTES && record.outputBytes <= MAX_TASK_RUN_OUTPUT_BYTES)
    && (record.resources === undefined || safeResources(record.resources))
    && (dynamic || !fixedSelection || typeof record.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/u.test(record.model)
      && typeof record.effort === "string" && /^(?:low|medium|high|xhigh|max)$/u.test(record.effort)
      && (!claude || typeof record.supportsEffort === "boolean"));
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

function safeResources(value: unknown): value is MacLocalTaskRunResourcesV1 {
  try { captureMacLocalTaskRunResourcesV1(value); return true; } catch { return false; }
}

function mapped(result: Readonly<{ status: string; text?: string; reason?: string; limit?: unknown }>): OwnerTrustedLocalCliExecutionV1 {
  if (result.status === "completed" && typeof result.text === "string") return Object.freeze({ kind: "completed" as const, text: result.text });
  if ((result.status === "failed" || result.status === "canceled" || result.status === "timed_out" || result.status === "cleanup_uncertain")
    && typeof result.reason === "string" && result.reason.length >= 1 && result.reason.length <= 240)
    return Object.freeze({ kind: "failed" as const, reason: `${result.status}:${result.reason}` });
  return invalid();
}

function capture(executor: Readonly<{ execute(input: Readonly<{ executablePath: string; prompt: string; workingDirectory: string;
  deadlineMs: number; outputBytes?: number; resources?: MacLocalTaskRunResourcesV1; model?: string; effort?: string; supportsEffort?: boolean; signal?: AbortSignal }>):
  Promise<Readonly<{ status: string; text?: string; reason?: string; limit?: unknown }>> }>,
  configuration: unknown, claude: boolean): OwnerTrustedLocalCliExecutionAdapterV1 {
  if (!executor || typeof executor.execute !== "function" || !safeConfiguration(configuration, claude)) return invalid();
  const fixed = Object.freeze({ ...configuration });
  return Object.freeze({ async execute(input: ExecutionInput) {
    if (!input || typeof input !== "object" || !(input.signal instanceof AbortSignal) || input.signal.aborted) invalid();
    const selected = fixed.select ? await fixed.select(input.delivery.identity.jobId)
      : typeof fixed.model === "string" ? fixed as CliSelection : undefined;
    if (selected && (typeof selected.model !== "string" || typeof selected.effort !== "string")) invalid();
    const result = await executor.execute(Object.freeze({ executablePath: fixed.executablePath,
      workingDirectory: fixed.workingDirectory, deadlineMs: fixed.deadlineMs,
      ...(fixed.outputBytes === undefined ? {} : { outputBytes: fixed.outputBytes }),
      ...(fixed.resources === undefined ? {} : { resources: fixed.resources }),
      ...(selected ? { model: selected.model, effort: selected.effort,
        ...(claude ? { supportsEffort: selected.supportsEffort === true } : {}) } : {}),
      prompt: ownerTrustedLocalCliPromptV1(input.delivery.input), signal: input.signal }));
    return mapped(result);
  } });
}

/** Selects the already verified direct Codex CLI runner for one owner-pinned
 * executable. It is an adapter only; queue delivery and result publication
 * remain outside this module. */
export function createOwnerTrustedLocalCodexExecutionAdapterV1(executor: OwnerTrustedLocalCodexExecV1,
  configuration: unknown): OwnerTrustedLocalCliExecutionAdapterV1 {
  return capture(executor, configuration, false);
}

/** Selects the already verified direct Claude CLI runner for one owner-pinned
 * executable. It deliberately does not choose a Claude model or enable tools. */
export function createOwnerTrustedLocalClaudeExecutionAdapterV1(executor: OwnerTrustedLocalClaudeExecV1,
  configuration: unknown): OwnerTrustedLocalCliExecutionAdapterV1 {
  return capture(executor, configuration, true);
}
