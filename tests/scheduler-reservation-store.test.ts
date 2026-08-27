import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ResourceReservationError, ResourceReservationStore } from "../src/scheduler/v1";
import { adaptPglite } from "../src/persistence/database";

const digest = `sha256:${"a".repeat(64)}`;
const at = "2026-08-27T00:00:00.000Z";
const request = { id: "reservation.1", tenantId: "tenant:reservation", projectId: "project:one", workItemId: "work:one", routeId: "route:gpu", resourceKey: "gpu:zero", units: 1, capacityUnits: 1, decisionDigest: digest, acquiredAt: at, expiresAt: "2026-08-27T00:05:00.000Z" };

test("CR6C reservations serialize capacity, exact replay, release, and expiry without claiming a live resource", async () => {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:reservation','Reservation')`);
    const store = new ResourceReservationStore(adaptPglite(raw));
    assert.deepEqual(await store.acquire(request, at), { reservation: { ...request, state: "active" }, replayed: false });
    assert.equal((await store.acquire(request, at)).replayed, true);
    await assert.rejects(store.acquire({ ...request, id: "reservation.2", projectId: "project:two" }, at), (error: unknown) => error instanceof ResourceReservationError && error.safeCode === "resource_unavailable");
    assert.equal((await store.release({ tenantId: request.tenantId, id: request.id, releasedAt: "2026-08-27T00:01:00.000Z" })).state, "released");
    assert.equal((await store.acquire({ ...request, id: "reservation.2", projectId: "project:two" }, "2026-08-27T00:01:00.000Z")).replayed, false);
    assert.equal((await store.acquire({ ...request, id: "reservation.3", projectId: "project:three", acquiredAt: "2026-08-27T00:06:00.000Z", expiresAt: "2026-08-27T00:07:00.000Z" }, "2026-08-27T00:06:00.000Z")).replayed, false);
  } finally { await raw.close(); }
});
