import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../v1/controller-worker-delivery";
import { executeAssignedHermes021MacosTaskV1, type Hermes021MacosAssignedTaskExecutionV1 } from "./assigned-task-execution";
import type { Hermes021MacosPreparedDispatchV1, Hermes021MacosDispatchReferenceV1 } from "./dispatch-preparation";
import { publishCompletedHermes021MacosOutcomeV1, type Hermes021MacosRetainedPublicationBindingV1,
  type Hermes021MacosTerminalResultPublicationV1 } from "./result-publication";

const unavailable = (): never => { throw new Error("hermes_021_macos_completed_task_publication_unavailable"); };

/**
 * Builds the result binding solely from the controller-prepared dispatch.
 * Terminal output supplies result evidence only; it cannot select a project,
 * workflow, authority, connector, or acceptance profile.
 */
export function retainHermes021MacosResultBindingV1(prepared: Hermes021MacosPreparedDispatchV1): Hermes021MacosRetainedPublicationBindingV1 {
  if (!prepared || prepared.schema !== "control-room.hermes-021-macos-dispatch-preparation/v1") unavailable();
  const { identity, authorityDigest, connectorProfileDigest, acceptanceProfileId, acceptanceProfileDigest } = prepared.delivery;
  if (!prepared.workflowId || !authorityDigest || !connectorProfileDigest || !acceptanceProfileId || !acceptanceProfileDigest) unavailable();
  return Object.freeze({ ...identity, workflowId: prepared.workflowId, authorityDigest,
    acceptanceProfileId, acceptanceProfileDigest });
}

/**
 * One normal in-process local handoff: execute an already-assigned task then,
 * only for a completed terminal record, send that result through the existing
 * durable-result and pending-review path. It creates no queue, retry loop,
 * approval, or second authority.
 *
 * If a process stops after Hermes returned but before publication, this helper
 * deliberately reports no publication on its next call: delivery replay does
 * not invoke Hermes again. Persisting and recovering terminal bytes is a
 * separate later recovery feature, not something this composition pretends to
 * solve.
 */
export async function executeAndPublishAssignedHermes021MacosTaskV1(config: Readonly<{
  execution: Hermes021MacosAssignedTaskExecutionV1;
  results: DurableResultPublicationConfigurationV1;
  /** Host-owned, synchronous check of the exact controller packet. */
  assertAuthority: (delivery: ControllerWorkerDeliveryV1) => void;
}>, reference: Hermes021MacosDispatchReferenceV1, signal?: AbortSignal): Promise<Readonly<{
  execution: Awaited<ReturnType<typeof executeAssignedHermes021MacosTaskV1>>;
  publication?: Hermes021MacosTerminalResultPublicationV1;
  startsWork: false;
  grantsExecutionAuthority: false;
}>> {
  if (!config || !config.execution || !config.results || typeof config.assertAuthority !== "function") unavailable();
  const execution = await executeAssignedHermes021MacosTaskV1(config.execution, reference, signal);
  if (execution.delivered.state !== "completed_delivery" || execution.delivered.outcome?.kind !== "completed") {
    return Object.freeze({ execution, startsWork: false as const, grantsExecutionAuthority: false as const });
  }
  const retainedBinding = retainHermes021MacosResultBindingV1(execution.prepared);
  const publication = await publishCompletedHermes021MacosOutcomeV1(config.results, {
    retainedBinding,
    outcome: execution.delivered.outcome,
    acceptedConnectorProfileDigest: execution.prepared.delivery.connectorProfileDigest,
    // The receipt is the controller-pinned timestamp for this one delivery.
    receivedAt: execution.delivered.receipt.receivedAt,
    assertAuthority: () => config.assertAuthority(execution.prepared.delivery),
  });
  return Object.freeze({ execution, publication, startsWork: false as const, grantsExecutionAuthority: false as const });
}
