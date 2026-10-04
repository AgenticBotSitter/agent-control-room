import assert from "node:assert/strict";
import test from "node:test";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";

const passwords = Object.fromEntries(["control_room_web", "control_room_coordinator",
  "control_room_results", "control_room_publisher", "control_room_agent_reviewer_login",
  "control_room_queue_worker"].map(name => [name, "test-only-not-a-secret"]));

test("an incomplete narrow-login set is refused before any database access", async () => {
  const statements = [];
  const client = { query: async sql => {
    statements.push(sql);
    throw new Error("unexpected database access");
  } };
  await assert.rejects(provisionMacLocalNarrowRolesV1(client, passwords), /narrow_role_login_set_refused/u);
  assert.equal(statements.length, 0);
});
