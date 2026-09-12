import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import type { SqliteNativeRunJournal } from "./run-journal";
import { localId } from "./contracts";
import { sha256Digest } from "../../security";
import { readNativeSettlementHistory } from "./settlement-history";
import type { SqliteEffectClaimStore } from "../../node-policy/v1/effect-claim-store";

type Settlement = Parameters<typeof readNativeSettlementHistory>[1];
const fail = (): never => { throw new Error("native_restart_inventory_unavailable"); };

/** Historical, read-only restart classification. NOT a lock, fresh cleanup proof,
 * canonical allocation, permission to retry, or permission to pick up new work.
 * A lifecycle owner must still reconcile server state and serialize admission. */
export function readNativeRestartInventory(scope: { tenantId: string; nodeId: string }, deps: Settlement & {
  runs: Settlement["runs"] & Pick<SqliteNativeRunJournal, "inventory">;
  bridge: Pick<SqliteBridgeJournal, "nativeRestartInventory">;
  effects: Settlement["effects"] & Pick<SqliteEffectClaimStore, "countActive">;
}, signal: AbortSignal) {
  const tenantId = localId.parse(scope.tenantId), nodeId = localId.parse(scope.nodeId);
  const runs = deps.runs.inventory.bind(deps.runs), bridge = deps.bridge.nativeRestartInventory.bind(deps.bridge),
    count = deps.effects.countActive.bind(deps.effects), deadline = performance.now() + 5000;
  const settlement: Settlement = { runs: { load: deps.runs.load.bind(deps.runs) },
    effects: { confirmation: deps.effects.confirmation.bind(deps.effects) },
    executions: { load: deps.executions.load.bind(deps.executions), events: deps.executions.events.bind(deps.executions) } };
  const current = () => { if (!(signal instanceof AbortSignal) || signal.aborted || performance.now() >= deadline) fail(); };
  const checked = <T>(work: () => T) => { current(); const value = work(); current(); return value; };
  const read = (reverse: boolean) => {
    // Compare opposite-direction sweeps for intervening metadata changes. This remains a diagnostic,
    // not a transaction or a substitute for exclusive lifecycle ownership.
    const { native, wire, activeEffects } = reverse
      ? { activeEffects: checked(() => count(tenantId, nodeId)), wire: checked(bridge), native: checked(runs) }
      : { native: checked(runs), wire: checked(bridge), activeEffects: checked(() => count(tenantId, nodeId)) };
    if (!Number.isSafeInteger(activeEffects) || activeEffects < 0) fail();
    const pending: { runId: string; queueId: string | null; reason: "delivery_without_run" | "run_without_delivery" | "unsettled_run" }[] = [];
    const settled: { runId: string; history: ReturnType<typeof readNativeSettlementHistory> }[] = [];
    const byRun = new Map(native.map(row => [row.binding.runId, row]));
    const byAttempt = new Map(wire.deliveries.map(row => [row.attemptId, row]));
    if (byRun.size !== native.length || byAttempt.size !== wire.deliveries.length) fail();
    for (const row of native) if (row.binding.tenantId !== tenantId || row.binding.nodeId !== nodeId) fail();
    for (const delivery of wire.deliveries) {
      current(); if (delivery.tenantId !== tenantId || delivery.nodeId !== nodeId) fail();
      const run = byRun.get(delivery.runId);
      if (!run) { pending.push({ runId: delivery.runId, queueId: delivery.queueId, reason: "delivery_without_run" }); continue; }
      const binding = run.binding;
      if (sha256Digest(binding) !== delivery.bindingDigest || binding.attemptId !== delivery.attemptId
        || binding.jobId !== delivery.jobId || binding.projectId !== delivery.projectId) fail();
      byRun.delete(delivery.runId);
      let historical: ReturnType<typeof readNativeSettlementHistory> | undefined;
      if (run.state === "completed") {
        // Incomplete or corrupt settlement can only keep pickup blocked. Do not
        // turn an unavailable history record into successful cleanup.
        try { historical = readNativeSettlementHistory(binding, settlement, signal); } catch { current(); }
      }
      if (sha256Digest(settlement.runs.load(binding.runId)) !== run.snapshotDigest) fail();
      if (historical) settled.push({ runId: binding.runId, history: historical });
      else pending.push({ runId: binding.runId, queueId: delivery.queueId, reason: "unsettled_run" });
    }
    for (const row of byRun.values()) pending.push({ runId: row.binding.runId, queueId: null, reason: "run_without_delivery" });
    let unknownAttempts = 0;
    for (const attempt of wire.attempts) {
      const delivery = byAttempt.get(attempt.attemptId);
      if (!delivery) { unknownAttempts++; continue; }
      if (attempt.jobId !== delivery.jobId || attempt.leaseId !== delivery.leaseId || attempt.leaseEpoch !== delivery.leaseEpoch) fail();
    }
    const pendingWorkspaces: { runId: string; reason: "workspace_without_delivery" | "workspace_reconciliation_required"; evidenceDigest: string }[] = [];
    for (const workspace of wire.workspaces) {
      current();
      if (workspace.tenantId !== tenantId || workspace.nodeId !== nodeId) fail();
      const delivery = byAttempt.get(workspace.attemptId);
      if (delivery && (workspace.runId !== delivery.runId || workspace.projectId !== delivery.projectId
        || workspace.jobId !== delivery.jobId || workspace.leaseId !== delivery.leaseId || workspace.leaseEpoch !== delivery.leaseEpoch)) fail();
      if (workspace.state !== "historically_removed") pendingWorkspaces.push({ runId: workspace.runId,
        reason: delivery ? "workspace_reconciliation_required" : "workspace_without_delivery", evidenceDigest: workspace.evidenceDigest });
    }
    current();
    return { native, wire, activeEffects, pending, settled, unknownAttempts, pendingWorkspaces };
  };
  const before = read(false), after = read(true); current();
  if (sha256Digest(before) !== sha256Digest(after)) fail();
  return Object.freeze({ status: before.pending.length || before.unknownAttempts || before.activeEffects || before.pendingWorkspaces.length ? "reconciliation_required" as const : "no_unresolved_local_work" as const,
    pendingWorkspaces: before.pendingWorkspaces,
    pending: before.pending, settledRunIds: before.settled.map(row => row.runId), unknownAttempts: before.unknownAttempts,
    activeEffects: before.activeEffects, evidenceDigest: sha256Digest(before), grantsExecutionAuthority: false as const,
    permitsFreshPickup: false as const, currentCleanupVerified: false as const });
}
