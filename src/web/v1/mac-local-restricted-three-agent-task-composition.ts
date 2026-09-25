import { createHermes021LocalSubprocessQueueExecutorV1 } from "./hermes-021-local-subprocess-executor";
import { createMacLocalRestrictedTaskApplicationV1 } from "./mac-local-restricted-task-composition";
import { createMacLocalTaskApplicationV1 } from "./mac-local-task-application";
import type { TaskCoordinatorConfiguration } from "./task-coordinator-lifecycle";

type HermesDeliveryInput = Parameters<typeof createHermes021LocalSubprocessQueueExecutorV1>[0];

/**
 * Combines the three owner-trusted Mac worker routes into one existing,
 * role-separated Control Room task lifecycle. Each adapter still has its own
 * fixed process policy and durable queue record; this function adds neither a
 * new scheduler nor any second source of task/result authority.
 */
export async function createMacLocalRestrictedThreeAgentTaskApplicationV1(
  input: Parameters<typeof createMacLocalRestrictedTaskApplicationV1>[0] & Readonly<{
    hermes: HermesDeliveryInput;
    claude: NonNullable<TaskCoordinatorConfiguration["claudeCodeLocal"]>;
    codex: NonNullable<TaskCoordinatorConfiguration["codexOwnerTrustedLocal"]>;
  }>,
) {
  if (!input?.hermes || !input.claude || !input.codex || typeof input.claude.deliver !== "function"
    || typeof input.codex.deliver !== "function")
    throw new Error("mac_local_restricted_three_agent_task_composition_invalid");
  const { hermes, claude, codex, ...restricted } = input;
  const legacyHermes = hermes as Record<string, unknown>;
  if (hermes.tenantId !== restricted.web?.tenantId || hermes.tenantId !== restricted.coordinator?.scope?.tenantId
    || restricted.coordinator?.hermes021Local !== undefined || restricted.coordinator?.claudeCodeLocal !== undefined
    || restricted.coordinator?.codexOwnerTrustedLocal !== undefined
    // The Mac path owns a fixed local subprocess configuration. Do not revive
    // the older admission/runner handoff here: it adds a second custody path
    // and prevents the installed provider from reconstructing after restart.
    || "runner" in legacyHermes || "admission" in legacyHermes)
    throw new Error("mac_local_restricted_three_agent_task_composition_invalid");
  const hermesDelivery = createHermes021LocalSubprocessQueueExecutorV1(hermes);
  return createMacLocalRestrictedTaskApplicationV1(restricted, {
    createTaskApplication: value => createMacLocalTaskApplicationV1({ ...value,
      coordinator: Object.freeze({ ...value.coordinator, hermes021Local: hermesDelivery,
        claudeCodeLocal: claude, codexOwnerTrustedLocal: codex }),
    }),
  });
}
