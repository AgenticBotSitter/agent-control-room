import { z } from "zod";
import { deliverHermes021MacosLocalTaskV1, type Hermes021MacosLocalDeliveryCompositionV1 } from "./local-delivery-composition";
import { Hermes021MacosDispatchPreparationV1, type Hermes021MacosDispatchReferenceV1 } from "./dispatch-preparation";
import { Hermes021MacosLocalRunRegistrationV1 } from "./local-run-registration";
import { HarnessRunStoreV1 } from "../v1/store";
import type { HarnessEventPayloadV1, HarnessRunEventV1 } from "../v1/types";
import { sha256Digest } from "../../security/canonical-digest";

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
  // The initial preparation is what binds this execution to the queue pickup.
  // Recheck that same binding directly before we create a run record or contact
  // the private launcher so a late revoke cannot start Marvin in the gap.
  await config.preparation.assertCurrent(referenceValue, prepared);
  const receivedAt = new Date(clock()).toISOString();
  if (!z.string().datetime().safeParse(receivedAt).success || Date.parse(receivedAt) > Date.parse(prepared.delivery.expiresAt)) unavailable();
  const candidate = Hermes021MacosLocalRunRegistrationV1(prepared.delivery, receivedAt);
  const existing = await config.runs.get(candidate.tenantId, candidate.id);
  // A restart after a completed delivery must reach the durable receipt
  // without trying to recreate the now-terminal run. Compare every stable
  // controller binding before accepting that historical run as the replay.
  if (existing && (existing.projectId !== candidate.projectId || existing.jobId !== candidate.jobId
    || existing.attemptId !== candidate.attemptId || existing.nodeId !== candidate.nodeId
    || existing.adapterId !== candidate.adapterId || existing.harness !== candidate.harness
    || existing.nativeSessionKeyDigest !== candidate.nativeSessionKeyDigest
    || existing.connectorProfileDigest !== candidate.connectorProfileDigest
    || existing.authorityDigest !== candidate.authorityDigest)) unavailable();
  const registered = existing ? { run: existing, replayed: true } : await config.runs.create(candidate);
  let nextSequence = (await config.runs.inspect(candidate.tenantId, candidate.id))?.events.length ?? 0;
  // The ordinary harness history—not a separate local queue—is the visible
  // record of this controlled invocation. An exact delivery replay leaves the
  // original history untouched because it must not start Hermes a second time.
  const lifecycle: HarnessRunEventV1[] = [];
  const append = async (payload: HarnessEventPayloadV1) => {
    const sequence = ++nextSequence;
    const event: HarnessRunEventV1 = { schemaVersion: "control-room-harness-event/v1",
      tenantId: prepared.delivery.identity.tenantId, runId: registered.run.id, sequence, occurredAt: receivedAt,
      source: "control_room", sourceEventKeyDigest: sha256Digest({ purpose: "hermes-021-macos-local-lifecycle/v1",
        deliveryDigest: prepared.delivery.deliveryDigest, sequence, payload }), payload };
    await config.runs.append(event);
    lifecycle.push(event);
  };
  if (registered.run.state === "discovered") await append({ category: "lifecycle", state: "starting" });
  const delivered = await deliverHermes021MacosLocalTaskV1(config.delivery, prepared.delivery,
    prepared.route, receivedAt, signal);
  if (delivered.state === "completed_delivery" || delivered.state === "recovered_terminal_result") {
    const outcome = delivered.outcome;
    if (outcome?.kind === "completed") {
      await append({ category: "lifecycle", state: "running" });
      await append({ category: "usage", inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
        cachedInputTokens: 0, reasoningTokens: 0 });
      await append({ category: "lifecycle", state: "succeeded" });
    } else if (outcome?.kind === "failed") {
      await append({ category: "lifecycle", state: "failed", reasonCode: outcome.reason });
    } else {
      await append({ category: "transport", state: "disconnected", reasonCode: outcome?.reason ?? "hermes_local_outcome_missing" });
    }
  }
  return Object.freeze({ schema: HERMES_021_MACOS_ASSIGNED_TASK_EXECUTION_V1, prepared, registered, delivered,
    lifecycle: Object.freeze(lifecycle), startsWork: false as const, grantsExecutionAuthority: false as const });
}
