import { z } from "zod";
import {
  captureHermes021MacosSubprocessHostConfigurationV1,
  hermes021MacosLocalBindingSchemaV1,
  type Hermes021MacosAssignedTaskExecutionV1,
  type Hermes021MacosSubprocessHostConfigurationV1,
} from "../../harness/hermes-021-v1";
import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../../harness/v1/controller-worker-delivery";
import { createHermes021LocalSubprocessQueueExecutorV1 } from "./hermes-021-local-subprocess-executor";

const unavailable = (): never => { throw new Error("hermes_021_private_installation_composition_unavailable"); };
const identifier = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

/**
 * The installation-only seam for Marvin's local delivery callback. It binds
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
  if (!parsed.success || !parsed.data.execution || typeof parsed.data.execution !== "object"
    || !parsed.data.results || typeof parsed.data.results !== "object") unavailable();

  const execution = parsed.data.execution as Hermes021MacosAssignedTaskExecutionV1;
  // The outer factory must never accept an injected test host or a completed
  // private port. A production installation supplies only owner-owned fixed
  // subprocess settings; the executor creates the port internally.
  if (!execution.delivery || typeof execution.delivery !== "object" || "privatePort" in execution.delivery) unavailable();
  if (!hermes021MacosLocalBindingSchemaV1.safeParse(execution.delivery.binding).success) unavailable();
  let subprocess: ReturnType<typeof captureHermes021MacosSubprocessHostConfigurationV1>;
  try { subprocess = captureHermes021MacosSubprocessHostConfigurationV1(parsed.data.subprocess); } catch { unavailable(); }
  const queueExecutor = createHermes021LocalSubprocessQueueExecutorV1({
    tenantId: parsed.data.tenantId,
    execution: execution as Omit<Hermes021MacosAssignedTaskExecutionV1, "delivery"> & Readonly<{
      delivery: Omit<Hermes021MacosAssignedTaskExecutionV1["delivery"], "privatePort">;
    }>,
    results: parsed.data.results as DurableResultPublicationConfigurationV1,
    assertAuthority: parsed.data.assertAuthority as (delivery: ControllerWorkerDeliveryV1) => void,
    subprocess: subprocess as Hermes021MacosSubprocessHostConfigurationV1,
  });
  return Object.freeze({ deliver: queueExecutor.deliver.bind(queueExecutor) });
}
