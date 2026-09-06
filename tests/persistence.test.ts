import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CONTRACT_VERSION } from "../src/contracts/v1/index.ts";
import { contentBloomsFixture, websiteOperationsFixture, wayfarerFixture } from "../src/fixtures/data.ts";
import { adaptPglite, createRepositorySimulationDatabaseV1 } from "../src/persistence/database.ts";
import { ProjectionStore } from "../src/persistence/projection-store.ts";

async function migratedDatabase() {
  const db = new PGlite();
  const files = (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  return db;
}

test("PGlite adapters await asynchronous precommit and roll back rejection", async t => {
  for (const exact of [false, true]) await t.test(exact ? "repository simulation" : "generic adapter", async () => {
    const raw = exact ? undefined : new PGlite();
    const simulation = exact ? await createRepositorySimulationDatabaseV1({ testOnly: true }) : undefined;
    const db = simulation?.client ?? adaptPglite(raw!);
    try {
      await db.query("CREATE TABLE async_commit_test(value integer)");
      for (const refuses of [false, true]) {
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        let settled = false;
        const running = db.transactionWithPreCommitCheck(async tx => {
          await tx.query("INSERT INTO async_commit_test VALUES ($1)", [refuses ? 2 : 1]); return 42;
        }, async () => { entered(); await gate; if (refuses) throw new Error("synthetic_check_refused"); });
        void running.then(() => { settled = true; }, () => { settled = true; });
        const outcome = refuses ? assert.rejects(running, /synthetic_check_refused/) : running;
        await started; await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, false); release(); await outcome;
      }
      assert.deepEqual((await db.query("SELECT value FROM async_commit_test")).rows, [{ value: 1 }]);
    } finally { if (simulation) await simulation.close(); else await raw!.close(); }
  });
});

function pageFor(pack: typeof wayfarerFixture) {
  return {
    contractVersion: CONTRACT_VERSION,
    adapterId: pack.manifest.adapterId,
    nextCursor: pack.changes.at(-1)?.cursor ?? `${pack.manifest.adapterId}:empty`,
    hasMore: false,
    changes: pack.changes,
  };
}

test("migrations create the CR-2 projection and allocation model", async () => {
  const db = await migratedDatabase();
  const result = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
  );
  const tables = new Set(result.rows.map((row) => row.table_name));
  for (const table of ["projects", "work_items", "worker_runtimes", "agent_identities", "projection_cursors", "projection_changes", "audit_events", "project_worker_allocations", "simulator_runs"]) {
    assert.ok(tables.has(table), `missing ${table}`);
  }
  await db.close();
});

test("cursor sync is durable, idempotent, scoped, and adapter-independent", async () => {
  const db = await migratedDatabase();
  const store = new ProjectionStore(adaptPglite(db));
  const tenantId = "tenant.owner";
  const packs = [wayfarerFixture, contentBloomsFixture, websiteOperationsFixture];

  for (const pack of packs) {
    const project = pack.projects[0];
    await store.ensureTenantWorkspace(tenantId, project.source.workspaceId, project.workspaceName);
    await store.registerAdapter(tenantId, pack.manifest);
    const first = await store.applyChangePage({ tenantId, workspaceId: project.source.workspaceId }, pageFor(pack));
    assert.equal(first, pack.changes.length);
    const repeated = await store.applyChangePage({ tenantId, workspaceId: project.source.workspaceId }, pageFor(pack));
    assert.equal(repeated, 0);
    assert.equal(await store.getCursor(tenantId, pack.manifest.adapterId), pageFor(pack).nextCursor);
  }

  const all = await store.listProjects(tenantId);
  assert.equal(all.length, 3);
  const onlyBlooms = await store.listProjects(tenantId, "workspace.content-blooms");
  assert.deepEqual(onlyBlooms.map((project) => project.id), ["project.blooms.content-ops"]);
  assert.equal((await store.listProjects("tenant.someone-else")).length, 0);
  await store.ensureTenantWorkspace("tenant.other", "workspace.other", "Other workspace");
  await assert.rejects(
    store.applyChangePage({ tenantId: "tenant.other", workspaceId: "workspace.other" }, pageFor(wayfarerFixture)),
    /not registered for this tenant/,
  );
  assert.equal(await store.getCursor("tenant.other", wayfarerFixture.manifest.adapterId), undefined);

  await db.query(`UPDATE adapter_registry SET status='offline' WHERE id=$1`, [contentBloomsFixture.manifest.adapterId]);
  const website = await store.listProjects(tenantId, "workspace.website-operations");
  assert.equal(website.length, 1, "an offline adapter must not block another project");
  await db.close();
});

test("audit history is append-only", async () => {
  const db = await migratedDatabase();
  const store = new ProjectionStore(adaptPglite(db));
  await db.query(`INSERT INTO tenants (id, display_name) VALUES ('tenant.owner','Owner')`);
  await store.appendAudit({
    id: "audit.manual.1",
    tenantId: "tenant.owner",
    actorId: "agent.owner",
    actorType: "human",
    action: "simulation_viewed",
    targetType: "simulator",
    targetId: "scenario.transcription",
    safeMetadata: { synthetic: true },
    occurredAt: "2026-08-22T17:30:00.000Z",
  });
  await assert.rejects(db.query(`UPDATE audit_events SET action='changed' WHERE id='audit.manual.1'`), /append-only/i);
  await assert.rejects(db.query(`DELETE FROM audit_events WHERE id='audit.manual.1'`), /append-only/i);
  await db.close();
});
