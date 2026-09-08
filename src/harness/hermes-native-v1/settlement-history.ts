import { sha256Digest } from "../../security";
import type { SqliteEffectClaimStore } from "../../node-policy/v1/effect-claim-store";
import type { SqliteExecutionStateStore } from "../../node-policy/v1/execution-state-store";
import { bindingSchema, snapshotSchema, type NativeRunJournal } from "./contracts";

function fail(): never { throw new Error("native_settlement_history_unavailable"); }

/** Read-only recognition of already committed local completion. Trust comes from
 * protected journal integrity, not event-name prefixes or a fresh host observation.
 * This does not re-qualify cleanup, close a runtime, change capacity or admit work. */
export function readNativeSettlementHistory(input: unknown, deps: {
  effects: Pick<SqliteEffectClaimStore, "confirmation">;
  executions: Pick<SqliteExecutionStateStore, "load" | "events">;
  runs: Pick<NativeRunJournal, "load">;
}, signal: AbortSignal) {
  const binding = bindingSchema.parse(input), bindingDigest = sha256Digest(binding), deadline = performance.now() + 5000;
  const confirm = deps.effects.confirmation.bind(deps.effects), execution = deps.executions.load.bind(deps.executions),
    events = deps.executions.events.bind(deps.executions), run = deps.runs.load.bind(deps.runs);
  const current = () => { if (!(signal instanceof AbortSignal) || signal.aborted || performance.now() >= deadline) fail(); };
  const read = () => {
    current();
    const saved = confirm(binding.effectClaimKey); if (!saved) fail();
    const effect = saved.snapshot, native = snapshotSchema.parse(run(binding.runId)), local = execution(effect.executionId);
    const identity = { tenantId: binding.tenantId, nodeId: binding.nodeId, projectId: binding.projectId,
      jobId: binding.jobId, attemptId: binding.attemptId, operationDigest: binding.operationDigest };
    if (effect.claimKey !== binding.effectClaimKey || sha256Digest(effect.identity) !== sha256Digest(identity)
      || effect.effectiveDeadline !== new Date(binding.deadline).toISOString() || !effect.markerDigest
      || native.state !== "completed" || !native.nativeRunId || native.resultText === null
      || sha256Digest(native.binding) !== bindingDigest || !local || local.state !== "completed"
      || local.executionId !== effect.executionId || local.admissionId !== effect.admissionId
      || local.authorityDigest !== effect.authorityDigest || sha256Digest(local.identity) !== sha256Digest(identity)
      || local.deadline.effectiveDeadline !== effect.effectiveDeadline) fail();
    const event = { eventId: `event:native-complete:${sha256Digest(native).slice(7)}`, kind: "completed",
      occurredAt: new Date(native.observedAt).toISOString() };
    const recorded = events(effect.executionId).at(-1);
    if (!recorded || recorded.toState !== "completed" || recorded.requestCancellation
      || sha256Digest(recorded.event) !== sha256Digest(event) || local.updatedAt !== event.occurredAt
      || saved.event.eventId !== `event:cleanup:${saved.event.destinationReceiptDigest.slice(7)}`
      || saved.event.occurredAt !== effect.updatedAt || Date.parse(saved.event.occurredAt) < native.observedAt) fail();
    current();
    return { saved, nativeDigest: sha256Digest(native), executionDigest: sha256Digest(local), eventDigest: sha256Digest(recorded) };
  };
  const before = read(), after = read(); current();
  if (sha256Digest(before) !== sha256Digest(after)) fail();
  return Object.freeze({ effectClaimKey: binding.effectClaimKey, evidenceDigest: before.saved.event.destinationReceiptDigest,
    effectSnapshotDigest: sha256Digest(before.saved.snapshot), historicalLocalCompletion: true as const,
    currentCleanupVerified: false as const, releasesCapacity: false as const, grantsExecutionAuthority: false as const,
    canonicalCapacityReleased: false as const, qualityAccepted: false as const });
}
