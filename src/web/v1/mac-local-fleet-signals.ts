import type { DatabaseClient } from "../../persistence/database";
import { sha256Digest } from "../../security";
import { FleetSignalStore } from "../../node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../../node-fleet/v1/schemas";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import { measureMacLocalArtifactStorageV1 } from "./mac-local-storage-telemetry";

type Worker = Readonly<{ kind: "hermes" | "claude-code" | "codex"; workerId: string;
  nodeId: string; capabilityProbeId: string }>;

/** The host reports only facts it actually observed. A failed filesystem
 * measurement is unavailable, so the existing assignment policy refuses it. */
export async function refreshMacLocalFleetSignalsV1(input: Readonly<{
  db: DatabaseClient; tenantId: string; protectedRoot: string;
  workers: readonly Worker[]; readiness: MacLocalWorkerReadinessV1;
}>, clock: () => number = Date.now): Promise<void> {
  const store = new FleetSignalStore(input.db);
  const observedAt = new Date(clock()).toISOString();
  const storage = await measureMacLocalArtifactStorageV1(input.protectedRoot);
  for (const worker of input.workers) {
    if (!input.readiness.isReady(worker.workerId)) continue;
    for (const kind of ["telemetry", "capability"] as const) {
      const last = await input.db.query<{ signal_sequence: number }>(
        `SELECT signal_sequence FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2
         AND signal_kind=$3 ORDER BY signal_sequence DESC LIMIT 1`,
        [input.tenantId, worker.nodeId, kind]);
      const sequence = Number(last.rows[0]?.signal_sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("mac_local_fleet_signal_sequence_invalid");
      const payload = kind === "telemetry" ? {
        samplingIntervalSeconds: 30,
        cpuUtilizationPercent: { quality: "unavailable" as const },
        availableMemoryBytes: { quality: "unavailable" as const },
        availableStorageBytes: storage,
        // The successful private PostgreSQL read above proves this node has a
        // usable network path; it does not claim speed or unmetered access.
        networkClass: "limited" as const, powerState: "unknown" as const,
        thermalState: "unknown" as const,
      } : { probeId: worker.capabilityProbeId, probeVersion: "1.0.0",
        outcome: "pass" as const, reasonCode: "pinned_executable_ready" };
      const signal: FleetSignalEnvelope = {
        schemaVersion: "1.0.0", tenantId: input.tenantId, nodeId: worker.nodeId,
        sequence, observedAt, expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
        trust: "reported", fingerprint: sha256Digest({ purpose: "mac-local-fleet-signal", worker: worker.workerId, kind }),
        kind, source: kind === "telemetry" ? "telemetry_port" : "probe_runner", payload,
      } as FleetSignalEnvelope;
      await store.ingestAuthenticated(signal, observedAt, { tenantId: input.tenantId, nodeId: worker.nodeId });
    }
  }
}
