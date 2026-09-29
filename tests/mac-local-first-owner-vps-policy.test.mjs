import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { applyMacLocalFirstOwnerV1, FIRST_OWNER_COLUMN_POLICY_V1, verifyFirstOwnerColumnCoverageV1 } from "../scripts/mac-local/first-owner-vps.mjs";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store.ts";

test("all first-owner columns are classified exactly once, and added columns fail closed", async () => {
  const names = Object.keys(FIRST_OWNER_COLUMN_POLICY_V1);
  assert.deepEqual(names, ["tenants", "workspaces", "control_identities", "control_role_grants",
    "adapter_registry", "control_nodes", "control_node_keys", "control_completion_gate_integrity",
    "work_intake_tenant_binding"]);
  let added = false;
  const client = { query: async (sql, [table]) => ({ rows: sql.includes("FROM pg_trigger")
    ? ["control_node_keys_identity_immutable", "control_node_keys_delete_protected"].map(tgname => ({ tgname, tgenabled: "O" }))
    : [
      ...[...FIRST_OWNER_COLUMN_POLICY_V1[table].identity, ...FIRST_OWNER_COLUMN_POLICY_V1[table].operational]
        .sort().map(column_name => ({ column_name })),
      ...(added && table === "tenants" ? [{ column_name: "new_unclassified_column" }] : []),
    ] }) };
  await verifyFirstOwnerColumnCoverageV1(client);
  added = true;
  await assert.rejects(verifyFirstOwnerColumnCoverageV1(client), /first_owner_column_policy_drift/);
});

test("first-owner setup refuses when either public-key immutability trigger is unavailable", async () => {
  const client = { query: async (sql, [table]) => ({ rows: sql.includes("FROM pg_trigger")
    ? [{ tgname: "control_node_keys_identity_immutable", tgenabled: "D" },
      { tgname: "control_node_keys_delete_protected", tgenabled: "O" }]
    : [...FIRST_OWNER_COLUMN_POLICY_V1[table].identity, ...FIRST_OWNER_COLUMN_POLICY_V1[table].operational]
      .sort().map(column_name => ({ column_name })) }) };
  await assert.rejects(verifyFirstOwnerColumnCoverageV1(client), /first_owner_key_immutability_missing/);
});

test("first-owner setup binds the intake login to its tenant and refuses to re-bind it", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  for (const file of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort())
    await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  const manifestFor = (tenant, workIntakeProjectIds = ["*"]) => {
    const tenantId = `tenant:${tenant}`;
    return createMacLocalFirstOwnerManifestV1({ workspaceId: `workspace:${tenant}`,
      localOwnerSession: { tenantId, provider: "local-owner", subject: "owner:local" },
      enablement: { nodeId: `${tenant}-1`, workers: ["hermes", "claude-code", "codex"].map(kind =>
        ({ kind, workerId: `worker:${tenant}-${kind}`, executablePath: `/private/${kind}`, recordedVersion: "test" })) },
      workIntakeProjectIds }, "2026-09-25T12:00:00.000Z",
    CompletionGateStoreV1.genesisIntegrityForKeyV1(tenantId, new Uint8Array(32).fill(41)));
  };
  const binding = async () => (await db.query("SELECT singleton,tenant_id FROM work_intake_tenant_binding")).rows;
  const manifest = manifestFor("vps-bound");

  const first = await applyMacLocalFirstOwnerV1(db, manifest);
  assert.deepEqual([first.created, first.kept], [21, 0]);
  assert.deepEqual(await binding(), [{ singleton: true, tenant_id: "tenant:vps-bound" }]);
  const repeat = await applyMacLocalFirstOwnerV1(db, manifest);
  assert.deepEqual([repeat.created, repeat.kept], [0, 21]);

  // A binding moved to any other tenant is a conflict, never silently rewritten.
  await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:elsewhere','Elsewhere')");
  await db.query("UPDATE work_intake_tenant_binding SET tenant_id='tenant:elsewhere'");
  await assert.rejects(applyMacLocalFirstOwnerV1(db, manifest), /first_owner_row_conflict/u);
  assert.deepEqual(await binding(), [{ singleton: true, tenant_id: "tenant:elsewhere" }]);
  await db.query("UPDATE work_intake_tenant_binding SET tenant_id='tenant:vps-bound'");
  assert.equal((await applyMacLocalFirstOwnerV1(db, manifest)).kept, 21);

  // A second intake tenant on the same database is refused as a whole.
  await assert.rejects(applyMacLocalFirstOwnerV1(db, manifestFor("vps-second")), /first_owner_row_conflict/u);
  assert.deepEqual(await binding(), [{ singleton: true, tenant_id: "tenant:vps-bound" }]);
  assert.deepEqual((await db.query("SELECT id FROM tenants WHERE id='tenant:vps-second'")).rows, []);
});
