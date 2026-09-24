import { captureOwnerTrustedLocalEnablementV1, type OwnerTrustedLocalEnablementV1 } from "../../harness/v1/owner-trusted-local-enablements";

export type MacLocalWorkerReadinessV1 = Readonly<{
  /** Read-only display state. It neither grants delivery nor starts a worker. */
  read(): readonly Readonly<{
    kind: "codex" | "hermes-021" | "claude-code";
    state: "ready" | "unavailable";
    proof: "not_proven" | "proven";
  }>[];
  /** A failed readiness check remains unavailable until a fresh protected-host
   * startup verifies the pinned executable again. */
  recordReadinessFailure(workerId: string): void;
  /** Called only by the canonical result-publication composition after it has
   * saved a result. It is display evidence, not result authority. */
  recordPublishedResult(workerId: string): void;
  isReady(workerId: string): boolean;
}>;

const refused = (): never => { throw new Error("mac_local_worker_readiness_invalid"); };

/**
 * Holds one host generation's truthful local-worker display state.  The
 * initial worker list must exactly equal the just-verified enablement list;
 * callers cannot add a worker later or mark a failed worker healthy.  This is
 * intentionally in-memory: the durable source of task/result history remains
 * the existing canonical database, while a restart performs fresh executable
 * verification instead of trusting an old health observation.
 */
export function createMacLocalWorkerReadinessV1(enablementValue: unknown,
  verifiedValue: Readonly<{ nodeId: "mac-1"; enabledWorkerIds: readonly string[] }>): MacLocalWorkerReadinessV1 {
  const enablement = captureOwnerTrustedLocalEnablementV1(enablementValue);
  if (!verifiedValue || verifiedValue.nodeId !== "mac-1" || !Array.isArray(verifiedValue.enabledWorkerIds)
    || verifiedValue.enabledWorkerIds.length !== enablement.workers.length
    || new Set(verifiedValue.enabledWorkerIds).size !== verifiedValue.enabledWorkerIds.length
    || verifiedValue.enabledWorkerIds.some(id => !enablement.workers.some(worker => worker.workerId === id))) refused();
  const failed = new Set<string>(), proven = new Set<string>();
  const worker = (id: string) => {
    if (typeof id !== "string") refused();
    const value = enablement.workers.find(item => item.workerId === id);
    if (!value) refused();
    return value;
  };
  const ready = (id: string) => !failed.has(worker(id).workerId);
  return Object.freeze({
    read: () => Object.freeze(enablement.workers.map(value => Object.freeze({ kind: value.kind,
      state: failed.has(value.workerId) ? "unavailable" as const : "ready" as const,
      proof: proven.has(value.workerId) ? "proven" as const : "not_proven" as const,
    }))),
    recordReadinessFailure(workerId: string) { failed.add(worker(workerId).workerId); },
    recordPublishedResult(workerId: string) {
      const value = worker(workerId);
      if (!failed.has(value.workerId)) proven.add(value.workerId);
    },
    isReady: ready,
  });
}
