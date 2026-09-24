import { createMacLocalHermesOwnerRunnerQueueDeliveryV1 } from "./mac-local-hermes-owner-runner";
import { createMacLocalRestrictedTaskApplicationV1 } from "./mac-local-restricted-task-composition";
import { createMacLocalTaskApplicationV1 } from "./mac-local-task-application";
import type { TaskCoordinatorConfiguration } from "./task-coordinator-lifecycle";

type HermesDeliveryInput = Parameters<typeof createMacLocalHermesOwnerRunnerQueueDeliveryV1>[0];

/**
 * Composes the first two real Mac-local worker routes into one existing task
 * lifecycle.  Hermes still receives its established owner-authorized queue
 * bridge; Claude still receives only an already-qualified, text-only delivery
 * capability.  This module is intentionally inert: it opens no queue, starts
 * no process, and cannot turn either worker on by itself.
 */
export async function createMacLocalRestrictedHermesClaudeTaskApplicationV1(
  input: Parameters<typeof createMacLocalRestrictedTaskApplicationV1>[0] & Readonly<{
    hermes: HermesDeliveryInput;
    claude: NonNullable<TaskCoordinatorConfiguration["claudeCodeLocal"]>;
  }>,
) {
  if (!input?.hermes || !input.claude || typeof input.claude.deliver !== "function")
    throw new Error("mac_local_restricted_hermes_claude_task_composition_invalid");
  const { hermes, claude, ...restricted } = input;
  if (hermes.tenantId !== restricted.web?.tenantId || hermes.tenantId !== restricted.coordinator?.scope?.tenantId
    || restricted.coordinator?.hermes021Local !== undefined || restricted.coordinator?.claudeCodeLocal !== undefined)
    throw new Error("mac_local_restricted_hermes_claude_task_composition_invalid");
  const hermesDelivery = createMacLocalHermesOwnerRunnerQueueDeliveryV1(hermes);
  return createMacLocalRestrictedTaskApplicationV1(restricted, {
    createTaskApplication: value => createMacLocalTaskApplicationV1({ ...value,
      coordinator: Object.freeze({ ...value.coordinator, hermes021Local: hermesDelivery, claudeCodeLocal: claude }),
    }),
  });
}
