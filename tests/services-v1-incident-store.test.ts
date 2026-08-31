import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { ServiceIncidentStore } from "../src/services/v1";

async function setup(): Promise<PGlite> { const raw = new PGlite(); for (const file of (await readdir(resolve("db/migrations"))).filter((f) => f.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8")); await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:incident','Incident')`); return raw; }
const open = { tenantId: "tenant:incident", serviceId: "service.worker", correlationKey: "service:service.worker:service_not_running", action: "open_or_update" as const, severity: "critical" as const, safeReasonCode: "service_not_running", safeRemedyCode: "inspect_service", observedAt: "2026-08-27T00:00:00.000Z" };

test("CR6D incident correlation updates one open record, resolves it, and creates a new generation after recovery", async () => {
  const raw = await setup();
  try {
    const store = new ServiceIncidentStore(adaptPglite(raw));
    const first = await store.apply(open);
    assert.equal(first.incident?.generation, 1);
    assert.equal(first.incident?.safeRemedyCode, "inspect_service");
    assert.equal((await store.apply({ ...open, severity: "warning", observedAt: "2026-08-27T00:01:00.000Z" })).replayed, true);
    const resolved = await store.apply({ tenantId: open.tenantId, serviceId: open.serviceId, correlationKey: open.correlationKey, action: "resolve", observedAt: "2026-08-27T00:02:00.000Z" });
    assert.equal(resolved.incident?.state, "resolved");
    assert.equal((await store.apply({ ...open, observedAt: "2026-08-27T00:03:00.000Z" })).incident?.generation, 2);
    assert.equal((await raw.query(`SELECT * FROM control_outbox WHERE tenant_id='tenant:incident'`)).rows.length, 3);
  } finally { await raw.close(); }
});
