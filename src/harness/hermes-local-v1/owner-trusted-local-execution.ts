import { isAbsolute, normalize } from "node:path";
import type { OwnerTrustedLocalCliExecutionAdapterV1 } from "../v1/owner-trusted-local-cli-execution";
import { ownerTrustedLocalCliPromptV1 } from "../v1/owner-trusted-local-cli-execution";
import type { OwnerTrustedLocalHermesExecV1 } from "./owner-trusted-local-exec";

function unavailable(): never { throw new Error("owner_trusted_local_hermes_execution_unavailable"); }
const identifier = /^[A-Za-z0-9._:/-]{1,180}$/u;
function path(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096
  && isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value); }

/** Protected configuration for one approved Hermes local worker. The chosen
 * model/provider are values, not source constants, so a normal model change
 * is a configuration/qualification event rather than a code change. */
export type OwnerTrustedLocalHermesExecutionConfigurationV1 = Readonly<{
  executablePath: string; profile: string; model: string; provider: string; workingDirectory: string; deadlineMs: number;
}>;

function capture(value: unknown): OwnerTrustedLocalHermesExecutionConfigurationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const item = value as Record<string, unknown>;
  const executablePath = item.executablePath, workingDirectory = item.workingDirectory;
  const profile = item.profile, model = item.model, provider = item.provider, deadlineMs = item.deadlineMs;
  if (Object.keys(item).length !== 6 || !path(executablePath) || !path(workingDirectory)
    || typeof profile !== "string" || !identifier.test(profile)
    || typeof model !== "string" || !identifier.test(model)
    || typeof provider !== "string" || !identifier.test(provider)
    || typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs)
    || deadlineMs < 100 || deadlineMs > 3_600_000) return unavailable();
  return Object.freeze({ executablePath, profile, model, provider, workingDirectory, deadlineMs });
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
    const result = await executor.execute(Object.freeze({ ...fixed, prompt: ownerTrustedLocalCliPromptV1(input.delivery.input), signal: input.signal }));
    if (result.status === "completed") return Object.freeze({ kind: "completed" as const, text: result.text });
    return Object.freeze({ kind: "failed" as const, reason: `${result.status}:${result.reason}` });
  } });
}
