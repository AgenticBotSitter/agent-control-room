import assert from "node:assert/strict";
import test from "node:test";
import { FIRST_OWNER_COLUMN_POLICY_V1, verifyFirstOwnerColumnCoverageV1 } from "../scripts/mac-local/first-owner-vps.mjs";

test("all first-owner columns are classified exactly once, and added columns fail closed", async () => {
  const names = Object.keys(FIRST_OWNER_COLUMN_POLICY_V1);
  assert.deepEqual(names, ["tenants", "workspaces", "control_identities", "control_role_grants",
    "adapter_registry", "control_nodes", "control_node_keys", "control_completion_gate_integrity"]);
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
