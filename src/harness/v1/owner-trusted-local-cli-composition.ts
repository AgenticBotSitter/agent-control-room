import type { OwnerTrustedLocalClaudeExecV1 } from "../claude-code-v1/owner-trusted-local-exec";
import type { OwnerTrustedLocalCodexExecV1 } from "../codex-v1/owner-trusted-local-exec";
import type { OwnerTrustedLocalHermesExecV1 } from "../hermes-local-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecutionAdapterV1,
  type OwnerTrustedLocalHermesExecutionConfigurationV1 } from "../hermes-local-v1/owner-trusted-local-execution";
import { createOwnerTrustedLocalClaudeExecutionAdapterV1, createOwnerTrustedLocalCodexExecutionAdapterV1 } from "./owner-trusted-local-cli-execution";
import { deliverOwnerTrustedLocalCliTaskV1, type OwnerTrustedLocalCliDeliveryV1 } from "./owner-trusted-local-cli-delivery";

type Base = Omit<OwnerTrustedLocalCliDeliveryV1, "execute">;
type Configuration = Readonly<{ executablePath: string; workingDirectory: string; deadlineMs: number }>;

function captureBase(value: unknown): Base {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("owner_trusted_local_cli_composition_unavailable");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 7 || ["db", "integrityKey", "binding", "receiptPort", "assertCurrent", "publish", "recordFailure"].some(key => !Object.hasOwn(record, key)))
    throw new Error("owner_trusted_local_cli_composition_unavailable");
  return value as Base;
}

/** Binds the existing direct Codex runner to the common durable-receipt
 * bridge. The supplied host still owns canonical authority and publication. */
export function createOwnerTrustedLocalCodexDeliveryV1(baseValue: Base, executor: OwnerTrustedLocalCodexExecV1,
  configuration: Configuration) {
  const base = Object.freeze({ ...captureBase(baseValue) });
  const execution = createOwnerTrustedLocalCodexExecutionAdapterV1(executor, configuration);
  return Object.freeze({ deliver: (delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal) =>
    deliverOwnerTrustedLocalCliTaskV1({ ...base, execute: execution.execute.bind(execution) }, delivery, route, receivedAt, signal) });
}

/** Binds the existing direct Claude runner to the same common durable-receipt
 * bridge. It deliberately inherits Claude's reviewed no-tools CLI boundary. */
export function createOwnerTrustedLocalClaudeDeliveryV1(baseValue: Base, executor: OwnerTrustedLocalClaudeExecV1,
  configuration: Configuration) {
  const base = Object.freeze({ ...captureBase(baseValue) });
  const execution = createOwnerTrustedLocalClaudeExecutionAdapterV1(executor, configuration);
  return Object.freeze({ deliver: (delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal) =>
    deliverOwnerTrustedLocalCliTaskV1({ ...base, execute: execution.execute.bind(execution) }, delivery, route, receivedAt, signal) });
}

/** Binds the current, owner-selected Hermes CLI runner to the same durable
 * receipt bridge. Profile/model/provider remain protected configuration, not
 * a task input or source-level version pin. */
export function createOwnerTrustedLocalHermesDeliveryV1(baseValue: Base, executor: OwnerTrustedLocalHermesExecV1,
  configuration: OwnerTrustedLocalHermesExecutionConfigurationV1) {
  const base = Object.freeze({ ...captureBase(baseValue) });
  const execution = createOwnerTrustedLocalHermesExecutionAdapterV1(executor, configuration);
  return Object.freeze({ deliver: (delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal) =>
    deliverOwnerTrustedLocalCliTaskV1({ ...base, execute: execution.execute.bind(execution) }, delivery, route, receivedAt, signal) });
}
