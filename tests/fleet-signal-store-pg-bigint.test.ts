import assert from "node:assert/strict";
import test from "node:test";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import { sha256Digest } from "../src/security";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

test("fleet sequence advances when PostgreSQL returns BIGINT as a string", async () => {
  const writes: string[] = [];
  const session: DatabaseSession = { async query<T = Record<string, unknown>>(statement: string): Promise<{ rows: T[] }> {
    if (statement.includes("FROM control_nodes")) return { rows: [{ id: "node:one" } as T] };
    if (statement.includes("SELECT payload_digest")) return { rows: [] };
    if (statement.includes("SELECT signal_sequence")) return { rows: [{ signal_sequence: "1" } as T] };
    if (statement.startsWith("INSERT INTO control_node_fleet_")) { writes.push(statement); return { rows: [] }; }
    throw new Error("unexpected_query");
  } };
  const db = { ...session, transaction: async callback => callback(session) } as DatabaseClient;
  const observedAt = "2026-09-25T12:00:00.000Z";
  const signal = {
    schemaVersion: "1.0.0", tenantId: "tenant:one", nodeId: "node:one", sequence: 2,
    observedAt, expiresAt: "2026-09-25T12:02:00.000Z", trust: "reported",
    fingerprint: sha256Digest({ purpose: "test-fleet-string-sequence" }),
    kind: "telemetry", source: "telemetry_port",
    payload: { samplingIntervalSeconds: 30, cpuUtilizationPercent: { quality: "unavailable" },
      availableMemoryBytes: { quality: "unavailable" }, availableStorageBytes: { quality: "unavailable" },
      networkClass: "limited", powerState: "unknown", thermalState: "unknown" },
  } as const;
  assert.deepEqual(await new FleetSignalStore(db).ingestAuthenticated(signal, observedAt,
    { tenantId: signal.tenantId, nodeId: signal.nodeId }), { replayed: false });
  assert.equal(writes.length, 2);
});
