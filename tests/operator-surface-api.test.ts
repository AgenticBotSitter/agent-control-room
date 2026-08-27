import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/v1/operator-surface/route";
import { POST as postOwnerFocus } from "../app/api/v1/operator-surface/owner-focus/route";

test("CR6E operator surface endpoint requires an authenticated actor", async () => {
  const response = await GET(new Request("https://control-room.invalid/api/v1/operator-surface"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});

test("CR6E operator surface endpoint stays unavailable without private server configuration", async () => {
  const priorTenant = process.env.CONTROL_ROOM_TENANT_ID;
  const priorDatabase = process.env.DATABASE_URL;
  delete process.env.CONTROL_ROOM_TENANT_ID;
  delete process.env.DATABASE_URL;
  try {
    const response = await GET(new Request("https://control-room.invalid/api/v1/operator-surface", { headers: { "oai-authenticated-user-id": "actor:owner" } }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "operator_surface_unavailable" });
  } finally {
    if (priorTenant === undefined) delete process.env.CONTROL_ROOM_TENANT_ID; else process.env.CONTROL_ROOM_TENANT_ID = priorTenant;
    if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
  }
});

test("CR6E operator surface endpoint rejects an invalid filter before opening a database", async () => {
  const priorTenant = process.env.CONTROL_ROOM_TENANT_ID;
  const priorDatabase = process.env.DATABASE_URL;
  process.env.CONTROL_ROOM_TENANT_ID = "tenant:1";
  process.env.DATABASE_URL = "postgres://not-used.invalid/control_room";
  try {
    const response = await GET(new Request("https://control-room.invalid/api/v1/operator-surface?state=invalid", { headers: { "oai-authenticated-user-id": "actor:owner" } }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_filter" });
  } finally {
    if (priorTenant === undefined) delete process.env.CONTROL_ROOM_TENANT_ID; else process.env.CONTROL_ROOM_TENANT_ID = priorTenant;
    if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
  }
});

test("CR6E Owner Focus endpoint requires authentication and rejects client tenant fields", async () => {
  const unauthenticated = await postOwnerFocus(new Request("https://control-room.invalid/api/v1/operator-surface/owner-focus", { method: "POST" }));
  assert.equal(unauthenticated.status, 401);
  const priorTenant = process.env.CONTROL_ROOM_TENANT_ID;
  const priorDatabase = process.env.DATABASE_URL;
  process.env.CONTROL_ROOM_TENANT_ID = "tenant:1";
  process.env.DATABASE_URL = "postgres://not-used.invalid/control_room";
  try {
    const response = await postOwnerFocus(new Request("https://control-room.invalid/api/v1/operator-surface/owner-focus", { method: "POST", headers: { "oai-authenticated-user-id": "actor:owner", "idempotency-key": "owner-focus-idempotency-001" }, body: JSON.stringify({ commandId: "command:focus:1", tenantId: "tenant:other", operation: "set_owner_focus", projectId: "project:1", level: "p0", reason: "Keep it visible" }) }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_owner_focus_command" });
  } finally {
    if (priorTenant === undefined) delete process.env.CONTROL_ROOM_TENANT_ID; else process.env.CONTROL_ROOM_TENANT_ID = priorTenant;
    if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
  }
});
