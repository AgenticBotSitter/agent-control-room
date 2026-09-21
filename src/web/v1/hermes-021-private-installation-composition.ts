import { z } from "zod";
import {
  captureHermes021MacosSubprocessHostConfigurationV1,
  hermes021MacosLocalBindingSchemaV1,
  type Hermes021MacosAssignedTaskExecutionV1,
  type Hermes021MacosSubprocessHostConfigurationV1,
} from "../../harness/hermes-021-v1";
import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../../harness/v1/controller-worker-delivery";
import { hermes021LocalQueueTargetToDispatchReferenceV1 } from "./hermes-021-local-executor";
import { createHermes021LocalSubprocessQueueExecutorV1 } from "./hermes-021-local-subprocess-executor";
import type { Hermes021LocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const unavailable = (): never => { throw new Error("hermes_021_private_installation_composition_unavailable"); };
const identifier = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

/**
 * The installation-only seam for a local Hermes delivery callback. It binds
 * already-verified private runner settings to the existing queue executor and
 * exposes only `deliver` to protected operator assembly. It has no browser,
 * database-opening, worker-starting, or Hermes-invocation behavior of its own.
 */
export function createPrivateHermes021LocalInstallationDeliveryV1(input: unknown): Readonly<{
  deliver: (target: unknown, signal: AbortSignal) => Promise<void>;
}> {
  const parsed = z.object({
    tenantId: identifier,
    execution: z.unknown(),
    results: z.unknown(),
    assertAuthority: z.function(),
    subprocess: z.unknown(),
  }).strict().safeParse(input);
  const data = parsed.data;
  if (!parsed.success || data === undefined) unavailable();
  const configuration = data as Readonly<{ tenantId: string; execution: unknown; results: unknown;
    assertAuthority: unknown; subprocess: unknown }>;
  if (!configuration.execution || typeof configuration.execution !== "object"
    || !configuration.results || typeof configuration.results !== "object") unavailable();

  const execution = configuration.execution as Hermes021MacosAssignedTaskExecutionV1;
  // The outer factory must never accept an injected test host or a completed
  // private port. A production installation supplies only owner-owned fixed
  // subprocess settings; the executor creates the port internally.
  if (!execution.delivery || typeof execution.delivery !== "object" || "privatePort" in execution.delivery) unavailable();
  if (!hermes021MacosLocalBindingSchemaV1.safeParse(execution.delivery.binding).success) unavailable();
  const subprocess = (() => {
    try { return captureHermes021MacosSubprocessHostConfigurationV1(configuration.subprocess); }
    catch { return unavailable(); }
  })();
  const queueExecutor = createHermes021LocalSubprocessQueueExecutorV1({
    tenantId: configuration.tenantId,
    execution: execution as Omit<Hermes021MacosAssignedTaskExecutionV1, "delivery"> & Readonly<{
      delivery: Omit<Hermes021MacosAssignedTaskExecutionV1["delivery"], "privatePort">;
    }>,
    results: configuration.results as DurableResultPublicationConfigurationV1,
    assertAuthority: configuration.assertAuthority as (delivery: ControllerWorkerDeliveryV1) => void,
    subprocess: subprocess as Hermes021MacosSubprocessHostConfigurationV1,
  });
  return Object.freeze({ async deliver(target: unknown, signal: AbortSignal): Promise<void> {
    // Validate this public boundary before the narrower queue executor receives
    // the target. The installed runner still sees only its fixed private setup.
    hermes021LocalQueueTargetToDispatchReferenceV1(configuration.tenantId, target);
    await queueExecutor.deliver(target as Hermes021LocalQueueDeliveryTarget, signal);
  } });
}
