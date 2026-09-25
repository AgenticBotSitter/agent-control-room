import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { seedMacLocalAdapterRegistryV1 } from "../src/web/v1/mac-local-owner-bootstrap";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../src/harness/claude-code-v1/task-planning-contract";

// A dedicated, isolated database: adapter_registry.id is a genuine global
// primary key for these three fixed adapter ids, so this suite must not
// share a database with tests that create other, unrelated tenants.
const raw = new PGlite();
const client = adaptPglite(raw);
after(() => raw.close());

async function migrate() {
  for (const file of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
}
const migrated = migrate();

async function tenant(id: string) {
  await migrated;
  await client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Synthetic tenant')", [id]);
}

test("seeds one row per owner-trusted local harness adapter, and a second call is a no-op", async () => {
  await tenant("tenant:seed-a");
  await client.transaction(tx => seedMacLocalAdapterRegistryV1(tx, "tenant:seed-a"));
  await client.transaction(tx => seedMacLocalAdapterRegistryV1(tx, "tenant:seed-a"));
  const rows = await client.query<{ id: string; tenant_id: string; authority_mode: string; status: string; contract_version: string }>(
    "SELECT id,tenant_id,authority_mode,status,contract_version FROM adapter_registry WHERE tenant_id=$1 ORDER BY id", ["tenant:seed-a"]);
  assert.deepEqual(rows.rows.map(row => row.id).sort(), [
    CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, HERMES_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  ].sort());
  for (const row of rows.rows) {
    assert.equal(row.tenant_id, "tenant:seed-a");
    assert.equal(row.authority_mode, "control_room_native");
    assert.equal(row.status, "online");
    assert.equal(row.contract_version, "1.0.0");
  }
});

test("refuses a fixed adapter id that already belongs to a different tenant, and touches no other row", async () => {
  // Depends on running after the first test in this file, which already
  // claimed all three ids for "tenant:seed-a" — node:test runs tests within
  // one file in declaration order, so a genuinely different tenant here can
  // never seed them, which is exactly the scenario under test.
  await tenant("tenant:seed-b");
  await assert.rejects(client.transaction(tx => seedMacLocalAdapterRegistryV1(tx, "tenant:seed-b")),
    /mac_local_owner_bootstrap_conflict/);
  const rows = await client.query<{ id: string }>("SELECT id FROM adapter_registry WHERE tenant_id=$1", ["tenant:seed-b"]);
  assert.equal(rows.rows.length, 0, "no row was left behind for the tenant that lost the race");
});
