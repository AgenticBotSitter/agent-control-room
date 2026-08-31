import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { chooseAllocationV1, ResourceReservationError, ResourceReservationStore } from "../src/scheduler/v1";
import { cr6cAllocationScenarios } from "./fixtures/cr6c-allocation-scenarios";

const at = "2026-08-27T00:00:00.000Z";
const digest = `sha256:${"c".repeat(64)}`;

test("CR6C acceptance catalogue covers deterministic selection and every declared failure family", () => {
  for (const scenario of cr6cAllocationScenarios) {
    const decision = chooseAllocationV1(scenario.candidates);
    assert.equal(decision.selected?.workItemId, scenario.selectedWorkItemId, scenario.name);
    if (scenario.rejectedWorkItemId && scenario.rejection) {
      const rejected = decision.rejected.find((value) => value.workItemId === scenario.rejectedWorkItemId);
      assert.equal(rejected?.reasons.includes(scenario.rejection), true, scenario.name);
    }
    assert.match(decision.explanation.join(" "), /not an execution grant or resource reservation/i, scenario.name);
  }
});

test("CR6C concurrent reservation claims never exceed declared capacity", async () => {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:contention','Contention')`);
    const store = new ResourceReservationStore(adaptPglite(raw));
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => store.acquire({
      id: `reservation.${index}`, tenantId: "tenant:contention", projectId: `project.${index}`, workItemId: `work.${index}`,
      routeId: "route.gpu", resourceKey: "gpu.zero", units: 1, capacityUnits: 1, decisionDigest: digest,
      acquiredAt: at, expiresAt: "2026-08-27T00:05:00.000Z",
    }, at)));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(rejected.length, 15);
    assert.equal(rejected.every((result) => result.reason instanceof ResourceReservationError && result.reason.safeCode === "resource_unavailable"), true);
    assert.equal((await store.reconcile({ tenantId: "tenant:contention", now: "2026-08-27T00:01:00.000Z" })).activeReservations.length, 1);
  } finally { await raw.close(); }
});
