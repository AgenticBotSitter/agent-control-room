import type { OwnerTrustedLocalClaudeExecV1 } from "../claude-code-v1/owner-trusted-local-exec";
import type { OwnerTrustedLocalCodexExecV1 } from "../codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalClaudeExecutionAdapterV1, createOwnerTrustedLocalCodexExecutionAdapterV1 } from "./owner-trusted-local-cli-execution";
import { deliverOwnerTrustedLocalCliTaskV1, type OwnerTrustedLocalCliDeliveryV1 } from "./owner-trusted-local-cli-delivery";

type Base = Omit<OwnerTrustedLocalCliDeliveryV1, "execute">;
type Configuration = Readonly<{ executablePath: string; workingDirectory: string; deadlineMs: number }>;

function captureBase(value: unknown): Base {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("owner_trusted_local_cli_composition_unavailable");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 6 || ["db", "integrityKey", "binding", "receiptPort", "assertCurrent", "publish"].some(key => !Object.hasOwn(record, key)))
    throw new Error("owner_trusted_local_cli_composition_unavailable");
  return value as Base;
}

/** Binds the existing direct Codex runner to the common durable-receipt
 * bridge. The supplied host still owns canonical authority and publication. */
export function createOwnerTrustedLocalCodexDeliveryV1(baseValue: Base, executor: OwnerTrustedLocalCodexExecV1,
  configuration: Configuration) {
  const base = captureBase(baseValue);
  const execution = createOwnerTrustedLocalCodexExecutionAdapterV1(executor, configuration);
  return Object.freeze({ deliver: (delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal) =>
    deliverOwnerTrustedLocalCliTaskV1({ ...base, execute: execution.execute.bind(execution) }, delivery, route, receivedAt, signal) });
}

/** Binds the existing direct Claude runner to the same common durable-receipt
 * bridge. It deliberately inherits Claude's reviewed no-tools CLI boundary. */
export function createOwnerTrustedLocalClaudeDeliveryV1(baseValue: Base, executor: OwnerTrustedLocalClaudeExecV1,
  configuration: Configuration) {
  const base = captureBase(baseValue);
  const execution = createOwnerTrustedLocalClaudeExecutionAdapterV1(executor, configuration);
  return Object.freeze({ deliver: (delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal) =>
    deliverOwnerTrustedLocalCliTaskV1({ ...base, execute: execution.execute.bind(execution) }, delivery, route, receivedAt, signal) });
}
