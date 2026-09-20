import { z } from "zod";
import { deliverHermes021MacosLocalTaskV1, type Hermes021MacosLocalDeliveryCompositionV1 } from "./local-delivery-composition";
import { Hermes021MacosDispatchPreparationV1, type Hermes021MacosDispatchReferenceV1 } from "./dispatch-preparation";
import { Hermes021MacosLocalRunRegistrationV1 } from "./local-run-registration";
import { HarnessRunStoreV1 } from "../v1/store";

const unavailable = (): never => { throw new Error("hermes_021_macos_assigned_task_execution_unavailable"); };

export const HERMES_021_MACOS_ASSIGNED_TASK_EXECUTION_V1 =
  "control-room.hermes-021-macos-assigned-task-execution/v1" as const;

/**
 * The application composition for an already-assigned Marvin task. It joins
 * the canonical assignment reader to the local delivery composition; neither
 * side supplies a browser-controlled task, queue, authority, or runner. The
 * host must still inject the Mac-owned policy and private Hermes runner.
 */
export type Hermes021MacosAssignedTaskExecutionV1 = Readonly<{
  preparation: Hermes021MacosDispatchPreparationV1;
  delivery: Hermes021MacosLocalDeliveryCompositionV1;
  runs: HarnessRunStoreV1;
  clock?: () => number;
}>;

export async function executeAssignedHermes021MacosTaskV1(config: Hermes021MacosAssignedTaskExecutionV1,
  referenceValue: Hermes021MacosDispatchReferenceV1, signal?: AbortSignal) {
  if (!config || !(config.preparation instanceof Hermes021MacosDispatchPreparationV1)
    || !(config.runs instanceof HarnessRunStoreV1) || !config.delivery || typeof config.delivery !== "object" || signal?.aborted) unavailable();
  const clock = config.clock ?? Date.now;
  if (typeof clock !== "function") unavailable();
  const prepared = await config.preparation.prepare(referenceValue);
  const receivedAt = new Date(clock()).toISOString();
  if (!z.string().datetime().safeParse(receivedAt).success || Date.parse(receivedAt) > Date.parse(prepared.delivery.expiresAt)) unavailable();
  const registered = await config.runs.create(Hermes021MacosLocalRunRegistrationV1(prepared.delivery, receivedAt));
  const delivered = await deliverHermes021MacosLocalTaskV1(config.delivery, prepared.delivery,
    prepared.route, receivedAt, signal);
  return Object.freeze({ schema: HERMES_021_MACOS_ASSIGNED_TASK_EXECUTION_V1, prepared, registered, delivered,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}
