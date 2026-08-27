import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { OPERATOR_SURFACES_CONTRACT_V1, OperatorSurfaceReadServiceV1, OperatorSurfaceStoreV1 } from "../src/operator-surfaces/v1";
import { adaptPglite } from "../src/persistence/database";
import { ServiceIncidentStore } from "../src/services/v1";

const now = "2026-08-27T12:00:00.000Z";
const inbox = {
  id: "attention:read", tenantId: "tenant:1", projectId: "project:1", kind: "incident" as const, state: "open" as const,
  requestedAction: "Review incident", reasonCode: "service_degraded", blockedWorkItemIds: ["work:1"],
  legalResponses: [{ id: "response:open", kind: "open_source" as const, label: "Open evidence", requiresConfirmation: false, available: true }],
  evidence: [{ id: "incident:1", kind: "incident" as const }], createdAt: now, deliveryState: "delivered" as const,
};

async function database(): Promise<PGlite> {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:1','One'),('tenant:2','Two')`);
  return raw;
}

test("CR6E authorized read service assembles only the bound tenant's redacted records", async () => {
  const raw = await database();
  try {
    const client = adaptPglite(raw);
    const surfaces = new OperatorSurfaceStoreV1(client);
    const incidents = new ServiceIncidentStore(client);
    await surfaces.upsertInbox(inbox);
    await incidents.apply({ tenantId: "tenant:1", serviceId: "service:1", correlationKey: "service:1:degraded", action: "open_or_update", severity: "warning", safeReasonCode: "service_degraded", safeRemedyCode: "inspect_service", observedAt: now });
    await incidents.apply({ tenantId: "tenant:2", serviceId: "service:2", correlationKey: "service:2:degraded", action: "open_or_update", severity: "critical", safeReasonCode: "service_degraded", safeRemedyCode: "inspect_service", observedAt: now });
    const calls: string[] = [];
    const reader = new OperatorSurfaceReadServiceV1(surfaces, incidents, {
      fleet: async ({ tenantId }) => { calls.push(`fleet:${tenantId}`); return [{ workerId: "worker:1", platform: "macos", state: "busy", lastObservedAt: now, availableSlots: 0, totalSlots: 1, capabilityState: "verified", telemetryState: "fresh" }]; },
      bottlenecks: async ({ tenantId }) => { calls.push(`bottlenecks:${tenantId}`); return [{ resourceKey: "gpu:1", utilizationPercent: 100, blockedWorkItemIds: ["work:1"], explanation: "Declared capacity is fully reserved." }]; },
    });
    const result = await reader.read({ scope: { tenantId: "tenant:1", actorId: "actor:owner", grantedAt: now }, now });
    assert.equal(result.snapshot.contractVersion, OPERATOR_SURFACES_CONTRACT_V1);
    assert.equal(result.snapshot.tenantId, "tenant:1");
    assert.deepEqual(result.snapshot.actionInbox.map((item) => item.id), ["attention:read"]);
    assert.deepEqual(result.serviceIncidents.map((incident) => incident.tenantId), ["tenant:1"]);
    assert.deepEqual(calls.sort(), ["bottlenecks:tenant:1", "fleet:tenant:1"]);
  } finally { await raw.close(); }
});

test("CR6E read service rejects unsafe upstream display text before it reaches a screen", async () => {
  const raw = await database();
  try {
    const client = adaptPglite(raw);
    const reader = new OperatorSurfaceReadServiceV1(new OperatorSurfaceStoreV1(client), new ServiceIncidentStore(client), {
      fleet: async () => [],
      bottlenecks: async () => [{ resourceKey: "gpu:1", utilizationPercent: 1, blockedWorkItemIds: ["work:1"], explanation: "Bearer secret-token-value" }],
    });
    await assert.rejects(reader.read({ scope: { tenantId: "tenant:1", actorId: "actor:owner", grantedAt: now }, now }));
  } finally { await raw.close(); }
});
