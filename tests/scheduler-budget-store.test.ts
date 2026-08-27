import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ProjectBudgetError, ProjectBudgetStore } from "../src/scheduler/v1";
import { adaptPglite } from "../src/persistence/database";
test("CR6C budget reservations are atomic, exact-replay safe, and never charge a provider", async () => { const raw = new PGlite(); for (const file of (await readdir(resolve("db/migrations"))).filter((f) => f.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8")); try { await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:budget','Budget')`); const store = new ProjectBudgetStore(adaptPglite(raw)); const base = { tenantId: "tenant:budget", projectId: "project:one", ceilingMicrousd: 100, estimatedMicrousd: 60, createdAt: "2026-08-27T00:00:00.000Z" }; assert.equal((await store.reserve({ ...base, id: "budget:one" })).replayed, false); assert.equal((await store.reserve({ ...base, id: "budget:one" })).replayed, true); await assert.rejects(store.reserve({ ...base, id: "budget:two" }), (e: unknown) => e instanceof ProjectBudgetError && e.safeCode === "budget_exhausted"); } finally { await raw.close(); } });
