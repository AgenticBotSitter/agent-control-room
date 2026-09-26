import { createMacLocalHermesOwnerRunnerQueueDeliveryV1 } from "./mac-local-hermes-owner-runner";
import { createMacLocalTaskApplicationV1, type MacLocalTaskApplicationInputV1 } from "./mac-local-task-application";
import type { TaskCoordinatorConfiguration } from "./task-coordinator-lifecycle";

type HermesDeliveryInput = Parameters<typeof createMacLocalHermesOwnerRunnerQueueDeliveryV1>[0];
type TaskApplication = Awaited<ReturnType<typeof createMacLocalTaskApplicationV1>>;

/**
 * Adds the already-reviewed local Hermes delivery bridge to the ordinary
 * Mac-local task application.  This is composition only: it neither opens a
 * database nor invokes Hermes.  The caller still owns the protected runner,
 * canonical authority recheck, result publisher and queue-worker startup.
 */
export async function createMacLocalHermesTaskApplicationV1(input: Omit<MacLocalTaskApplicationInputV1, "coordinator"> & Readonly<{
  coordinator: TaskCoordinatorConfiguration;
  hermes: HermesDeliveryInput;
}>, dependencies: Readonly<{
  createTaskApplication?: (value: MacLocalTaskApplicationInputV1) => Promise<TaskApplication>;
}> = {}) {
  if (!input?.coordinator || !input.hermes || input.coordinator.hermes021Local !== undefined)
    throw new Error("mac_local_hermes_task_application_config_invalid");
  if (input.hermes.tenantId !== input.web?.tenantId || input.hermes.tenantId !== input.coordinator.scope?.tenantId)
    throw new Error("mac_local_hermes_task_application_config_invalid");
  const delivery = createMacLocalHermesOwnerRunnerQueueDeliveryV1(input.hermes);
  const voidDelivery = Object.freeze({ async deliver(target: Parameters<typeof delivery.deliver>[0], signal: AbortSignal): Promise<void> {
    await delivery.deliver(target, signal);
  } });
  const create = dependencies.createTaskApplication ?? createMacLocalTaskApplicationV1;
  return create({ web: input.web, clock: input.clock,
    coordinator: Object.freeze({ ...input.coordinator, hermes021Local: voidDelivery }),
  });
}
