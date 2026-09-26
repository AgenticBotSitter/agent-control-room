import assert from "node:assert/strict";
import test from "node:test";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";

const passwords = Object.fromEntries(["control_room_web", "control_room_coordinator",
  "control_room_results", "control_room_publisher", "control_room_queue_worker"].map(name => [name, "test-only-not-a-secret"]));

test("existing narrow roles are refused before any write or password change", async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (sql.includes("rolname=ANY")) return { rows: [{ rolname: "control_room_private_web" }] };
    throw new Error("unexpected database access");
  } };
  await assert.rejects(provisionMacLocalNarrowRolesV1(client, passwords), /narrow_role_existing_audit_required/u);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^SELECT /u);
});

test("existing local logins are refused before any role-file application", async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (sql.includes("rolname=ANY")) return { rows: [] };
    if (sql.includes("WHERE rolname=$1")) return { rows: [{ present: true }] };
    throw new Error("unexpected database access");
  } };
  await assert.rejects(provisionMacLocalNarrowRolesV1(client, passwords), /narrow_role_existing_login_audit_required/u);
  assert.equal(statements.length, 2);
  assert.ok(statements.every(sql => sql.startsWith("SELECT ")));
});
