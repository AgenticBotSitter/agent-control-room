import { createHermes021MacosStreamJsonPrivatePortV1, createHermes021MacosSubprocessStreamJsonHostV1,
  type Hermes021MacosLocalDeliveryCompositionV1, type Hermes021MacosStreamJsonHostV1,
  type Hermes021MacosSubprocessHostConfigurationV1 } from "../../harness/hermes-021-v1";
import type { Hermes021MacosAssignedTaskExecutionV1 } from "../../harness/hermes-021-v1/assigned-task-execution";
import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../../harness/v1/controller-worker-delivery";
import { createHermes021LocalQueueExecutorV1 } from "./hermes-021-local-executor";

const unavailable = (): never => { throw new Error("hermes_021_local_subprocess_executor_unavailable"); };

type DeliveryWithoutRunner = Omit<Hermes021MacosLocalDeliveryCompositionV1, "privatePort">;
type ExecutionWithoutRunner = Omit<Hermes021MacosAssignedTaskExecutionV1, "delivery"> & Readonly<{ delivery: DeliveryWithoutRunner }>;

/**
 * Connects the fixed, installation-owned Hermes subprocess wrapper to the
 * existing local queue executor. It constructs no queue, database, policy, or
 * result store. The caller must provide all of those established components.
 *
 * A test may inject an already-owned stream host. A real installer supplies
 * the private subprocess settings instead. Exactly one is permitted, keeping
 * the public queue and browser away from command, profile and workspace data.
 */
export function createHermes021LocalSubprocessQueueExecutorV1(input: Readonly<{
  tenantId: string;
  execution: ExecutionWithoutRunner;
  results: DurableResultPublicationConfigurationV1;
  assertAuthority: (delivery: ControllerWorkerDeliveryV1) => void;
  host?: Hermes021MacosStreamJsonHostV1;
  subprocess?: Hermes021MacosSubprocessHostConfigurationV1;
  clock?: () => number;
}>) {
  if (!input || !input.execution || !input.execution.delivery || !input.results || typeof input.assertAuthority !== "function"
    || (input.host === undefined) === (input.subprocess === undefined)) unavailable();
  const delivery = input.execution.delivery;
  const host = input.host ?? createHermes021MacosSubprocessStreamJsonHostV1(input.subprocess);
  if (!host || typeof host.execute !== "function") unavailable();
  const privatePort = createHermes021MacosStreamJsonPrivatePortV1(delivery.binding, host, input.clock);
  const execution: Hermes021MacosAssignedTaskExecutionV1 = Object.freeze({ ...input.execution,
    delivery: Object.freeze({ ...delivery, privatePort }) });
  const queueExecutor = createHermes021LocalQueueExecutorV1({ tenantId: input.tenantId, execution, results: input.results,
    assertAuthority: input.assertAuthority });
  // Retain this private, already-composed execution value for the surrounding
  // installation's restart reconciliation. It is not a browser response.
  return Object.freeze({ ...queueExecutor, execution });
}
