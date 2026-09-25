import { createHermesLocalQueueExecutorV1 } from "./hermes-local-executor";
import { createMacLocalRestrictedTaskApplicationV1 } from "./mac-local-restricted-task-composition";
import { createMacLocalTaskApplicationV1 } from "./mac-local-task-application";
import type { TaskCoordinatorConfiguration } from "./task-coordinator-lifecycle";

type HermesDeliveryInput = Parameters<typeof createHermesLocalQueueExecutorV1>[0];

/**
 * Composes the current local Hermes connector with the existing Claude and
 * Codex routes. This is one local Control Room lifecycle: it adds no worker,
 * scheduler, database, or process start. The protected host supplies the
 * already-qualified runner and exact queue-preparation bridge separately.
 */
export async function createMacLocalCurrentThreeAgentTaskApplicationV1(
  input: Parameters<typeof createMacLocalRestrictedTaskApplicationV1>[0] & Readonly<{
    hermes: HermesDeliveryInput;
    claude: NonNullable<TaskCoordinatorConfiguration["claudeCodeLocal"]>;
    codex: NonNullable<TaskCoordinatorConfiguration["codexOwnerTrustedLocal"]>;
  }>,
) {
  if (!input?.hermes || !input.claude || !input.codex || typeof input.claude.deliver !== "function"
    || typeof input.codex.deliver !== "function")
    throw new Error("mac_local_current_three_agent_task_composition_invalid");
  const { hermes, claude, codex, ...restricted } = input;
  if (hermes.tenantId !== restricted.web?.tenantId || hermes.tenantId !== restricted.coordinator?.scope?.tenantId
    || restricted.coordinator?.hermes021Local !== undefined || restricted.coordinator?.hermesLocal !== undefined
    || restricted.coordinator?.claudeCodeLocal !== undefined || restricted.coordinator?.codexOwnerTrustedLocal !== undefined)
    throw new Error("mac_local_current_three_agent_task_composition_invalid");
  const hermesLocal = createHermesLocalQueueExecutorV1(hermes);
  return createMacLocalRestrictedTaskApplicationV1(restricted, {
    createTaskApplication: value => createMacLocalTaskApplicationV1({ ...value,
      coordinator: Object.freeze({ ...value.coordinator, hermesLocal, claudeCodeLocal: claude,
        codexOwnerTrustedLocal: codex }),
    }),
  });
}
