import { createOwnerTrustedLocalClaudeExecV1 } from "../../harness/claude-code-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalCodexExecV1 } from "../../harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecV1 } from "../../harness/hermes-local-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecutionAdapterV1 } from "../../harness/hermes-local-v1/owner-trusted-local-execution";
import { createOwnerTrustedLocalClaudeExecutionAdapterV1, createOwnerTrustedLocalCodexExecutionAdapterV1,
  type OwnerTrustedLocalCliExecutionAdapterV1 } from "../../harness/v1/owner-trusted-local-cli-execution";

/** The harness names a worker machine can enable in its local settings. They
 * match the fleet worker kinds the owner picks when adding the machine. */
export const FLEET_HANDOFF_HARNESSES_V1 = Object.freeze(["codex", "claude-code", "hermes"] as const);
export type FleetHandoffHarnessV1 = (typeof FLEET_HANDOFF_HARNESSES_V1)[number];

type ExecDependencies = Parameters<typeof createOwnerTrustedLocalCodexExecV1>[0];

/**
 * The adapter module the worker connector loads for `run`. It adds no second
 * contract: each harness is the existing owner-trusted local CLI runner behind
 * the one shared delivery contract (`OwnerTrustedLocalCliExecutionAdapterV1`),
 * with the configuration captured and validated by that runner's own adapter.
 * The configuration comes only from the machine owner's local settings file;
 * nothing the server sends can choose an executable, directory or model.
 */
export function createFleetHarnessAdapter(input: Readonly<{ harness: unknown; configuration: unknown }>,
  dependencies: ExecDependencies = {}): OwnerTrustedLocalCliExecutionAdapterV1 {
  if (!input || typeof input !== "object") throw new Error("fleet_harness_adapter_unavailable");
  const { harness, configuration } = input;
  if (harness === "codex")
    return createOwnerTrustedLocalCodexExecutionAdapterV1(createOwnerTrustedLocalCodexExecV1(dependencies), configuration);
  if (harness === "claude-code")
    return createOwnerTrustedLocalClaudeExecutionAdapterV1(createOwnerTrustedLocalClaudeExecV1(dependencies), configuration);
  if (harness === "hermes")
    return createOwnerTrustedLocalHermesExecutionAdapterV1(createOwnerTrustedLocalHermesExecV1(dependencies), configuration);
  throw new Error("fleet_harness_adapter_unavailable");
}
