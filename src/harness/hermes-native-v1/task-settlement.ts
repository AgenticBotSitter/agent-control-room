import { sha256Digest } from "../../security";
import { boundedCheckpointCall } from "../../completion-gate/v1/bounded-checkpoint-call";
import type { SqliteExecutionStateStore } from "../../node-policy/v1/execution-state-store";
import type { SqliteEffectClaimStore } from "../../node-policy/v1/effect-claim-store";
import type { createNativeNodeRuntime } from "./node-runtime";
import { bindingSchema } from "./contracts";
import { createNativeCleanupEvidence } from "./cleanup-evidence";

type CleanupDependencies = Parameters<typeof createNativeCleanupEvidence>[1];
type Runtime = Pick<ReturnType<typeof createNativeNodeRuntime>, "closeForSettlement">;
function fail(): never { throw new Error("native_task_settlement_unavailable"); }

/** Local success settlement only. Does not acknowledge a canonical result, release
 * a server lease, accept quality, select work or enable another native start. */
export function createNativeTaskSettlement(config: Parameters<typeof createNativeCleanupEvidence>[0], deps: CleanupDependencies & {
  effects: Pick<SqliteEffectClaimStore, "load" | "applyChecked">;
  executions: Pick<SqliteExecutionStateStore, "load" | "apply">;
  runtime: Runtime;
}) {
  const binding = bindingSchema.parse(config.binding), bindingDigest = sha256Digest(binding);
  const evidence = createNativeCleanupEvidence(config, deps), lifetime = new AbortController();
  const closeRuntime = deps.runtime.closeForSettlement.bind(deps.runtime), load = deps.executions.load.bind(deps.executions),
    complete = deps.executions.apply.bind(deps.executions), confirm = deps.effects.applyChecked.bind(deps.effects);
  let closed = false, busy = false;
  const close = () => { closed = true; lifetime.abort(); evidence.close(); };
  return Object.freeze({ close, async settle(input: AbortSignal) {
    if (closed || busy || !(input instanceof AbortSignal) || input.aborted) { close(); return fail(); }
    busy = true;
    const signal = AbortSignal.any([input, lifetime.signal]), deadline = performance.now() + 15_000;
    const current = () => { if (closed || signal.aborted || performance.now() >= deadline) fail(); };
    try {
      // Reuse the existing bounded unary-call helper. Cancellation does not claim
      // that close stopped; a late close outcome cannot continue into settlement.
      const drained = await boundedCheckpointCall<Awaited<ReturnType<Runtime["closeForSettlement"]>>>({
        signal, timeoutMs: 10_000, dispatch(_deadline, callback) {
          const pending = Promise.resolve().then(() => { current(); return closeRuntime(bindingDigest); });
          void pending.then(value => callback(null, value), error => callback(error));
          return { cancel() { /* Runtime close remains owned by the runtime. */ } };
        },
      });
      current(); if (drained.bindingDigest !== bindingDigest) fail();
      const readDrained = drained.assertClosed.bind(drained);
      const assertDrained = () => {
        const result: unknown = readDrained();
        if (result instanceof Promise) Promise.prototype.then.call(result, undefined, () => undefined);
        if (result !== undefined) fail();
      };
      assertDrained(); current();
      const proof = await evidence.verify(signal), confirmation = proof.confirmation;
      current(); assertDrained(); proof.assertFresh();
      const assertExecution = (execution: ReturnType<typeof load>) => {
        if (!execution || execution.executionId !== confirmation.executionId
          || execution.admissionId !== confirmation.admissionId || execution.authorityDigest !== confirmation.authorityDigest
          || sha256Digest(execution.identity) !== confirmation.identityDigest
          || execution.deadline.effectiveDeadline !== confirmation.effectiveDeadline) fail();
      };
      assertExecution(load(confirmation.executionId));
      current(); assertDrained(); proof.assertFresh();
      // Separate SQLite files cannot share a transaction. Complete execution first;
      // any later failure leaves the effect active. Exact stored event replay allows
      // reconstruction after that crash window without repeating native execution.
      const completed = complete(confirmation.executionId, confirmation.executionEvent);
      assertExecution(completed.snapshot);
      if (completed.snapshot.state !== "completed" || completed.requestCancellation) fail();
      const executionDigest = sha256Digest(completed.snapshot);
      const settled = confirm(binding.effectClaimKey, confirmation.event, {
        expectedSnapshotDigest: confirmation.expectedSnapshotDigest,
        verifyCurrent(expected): true {
          current(); assertDrained();
          if (sha256Digest(load(confirmation.executionId)) !== executionDigest) fail();
          confirmation.verifyCurrent(expected); assertDrained(); current();
          return true;
        },
      });
      return Object.freeze({ effectClaimKey: binding.effectClaimKey, evidenceDigest: proof.evidenceDigest,
        effectSnapshotDigest: sha256Digest(settled.snapshot), localEffectSettled: true as const,
        canonicalCapacityReleased: false as const, qualityAccepted: false as const, grantsExecutionAuthority: false as const });
    } catch { return fail(); }
    finally { close(); }
  } });
}
