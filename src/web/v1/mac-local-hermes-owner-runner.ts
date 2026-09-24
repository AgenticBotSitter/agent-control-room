import { admitHermes021MacosOwnerAuthorizedLocalOnlyTaskV1,
  createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1,
  hermes021MacosLocalBindingSchemaV1,
  type Hermes021MacosAssignedTaskExecutionV1,
  type Hermes021MacosLocalDeliveryCompositionV1,
  type Hermes021MacosLocalPrivatePortV1,
  type Hermes021MacosTaskV1 } from "../../harness/hermes-021-v1";
import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../../harness/v1/controller-worker-delivery";
import { createHermes021LocalQueueExecutorV1 } from "./hermes-021-local-executor";

const unavailable = (): never => { throw new Error("mac_local_hermes_owner_runner_unavailable"); };

type DeliveryWithoutPrivatePort = Omit<Hermes021MacosLocalDeliveryCompositionV1, "privatePort" | "createPrivatePort">;
type ExecutionWithoutPrivatePort = Omit<Hermes021MacosAssignedTaskExecutionV1, "delivery"> & Readonly<{
  delivery: DeliveryWithoutPrivatePort;
}>;

type OwnerRunnerAdmission = Readonly<{
  installationId: string;
  installationPlanDigest: string;
  topologyPlanDigest: string;
  releaseDigest: string;
  workerBinding: unknown;
}>;

/**
 * Converts an already-created owner-authorized Hermes runner into a private
 * port factory. The runner itself validates the installation binding and burns
 * the exact task admission before it can invoke the process. This adapter has
 * no database, queue, browser, model, provider, or executable configuration.
 */
export function createMacLocalHermesOwnerRunnerPortFactoryV1(input: Readonly<{
  runner: unknown;
  admission: OwnerRunnerAdmission;
}>): Readonly<{ createPrivatePort(input: Readonly<{ task: Hermes021MacosTaskV1 }>): Hermes021MacosLocalPrivatePortV1 }> {
  if (!input || !input.runner || !input.admission) unavailable();
  const admission = input.admission;
  const workerBinding = hermes021MacosLocalBindingSchemaV1.parse(admission.workerBinding);
  if (typeof admission.installationId !== "string" || typeof admission.installationPlanDigest !== "string"
    || typeof admission.topologyPlanDigest !== "string" || typeof admission.releaseDigest !== "string") unavailable();
  const runner = input.runner;
  return Object.freeze({ createPrivatePort(value) {
    const task = value?.task;
    if (!task) unavailable();
    const gate = admitHermes021MacosOwnerAuthorizedLocalOnlyTaskV1(runner, {
      installationId: admission.installationId,
      installationPlanDigest: admission.installationPlanDigest,
      topologyPlanDigest: admission.topologyPlanDigest,
      releaseDigest: admission.releaseDigest,
      workerBinding,
      task,
    });
    return createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(runner, gate);
  } });
}

/**
 * The installation-owned queue callback for the one local Hermes worker.
 * It enriches the established executor with a one-use private-port factory;
 * all canonical task lookup, receipt persistence, final recheck, result
 * publication, and replay behavior stay in the existing queue executor.
 */
export function createMacLocalHermesOwnerRunnerQueueDeliveryV1(input: Readonly<{
  tenantId: string;
  execution: ExecutionWithoutPrivatePort;
  results: DurableResultPublicationConfigurationV1;
  assertAuthority: (delivery: ControllerWorkerDeliveryV1) => void;
  runner: unknown;
  admission: OwnerRunnerAdmission;
}>) {
  if (!input || !input.execution?.delivery || !input.results || typeof input.assertAuthority !== "function") unavailable();
  const factory = createMacLocalHermesOwnerRunnerPortFactoryV1({ runner: input.runner, admission: input.admission });
  const execution: Hermes021MacosAssignedTaskExecutionV1 = Object.freeze({ ...input.execution,
    delivery: Object.freeze({ ...input.execution.delivery, createPrivatePort: ({ task }) => factory.createPrivatePort({ task }) }),
  });
  return createHermes021LocalQueueExecutorV1({ tenantId: input.tenantId, execution, results: input.results,
    assertAuthority: input.assertAuthority });
}
