import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/v1/project-workspace/[projectId]/route.ts";

const known = "project.wayfarer.lazy-river";
const context = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

test("CR12A protected project endpoint requires authentication before project or configuration reads", async () => {
  const response = await GET(new Request(`http://localhost/api/v1/project-workspace/${known}`), context(known));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});

test("CR12A protected project endpoint rejects malformed authenticated identity before configuration reads", async () => {
  const response = await GET(new Request(`http://localhost/api/v1/project-workspace/${known}`, { headers: { "oai-authenticated-user-id": "../owner" } }), context(known));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});

test("CR12A protected project endpoint rejects unknown projects without opening a database", async () => {
  const response = await GET(new Request("http://localhost/api/v1/project-workspace/project.unknown", { headers: { "oai-authenticated-user-id": "actor.owner" } }), context("project.unknown"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "project_not_found" });
});

test("CR12A protected project endpoint stays honestly unavailable without private server configuration", async () => {
  const priorTenant = process.env.CONTROL_ROOM_TENANT_ID, priorDatabase = process.env.DATABASE_URL;
  delete process.env.CONTROL_ROOM_TENANT_ID;
  delete process.env.DATABASE_URL;
  try {
    const response = await GET(new Request(`http://localhost/api/v1/project-workspace/${known}`, { headers: { "oai-authenticated-user-id": "actor.owner" } }), context(known));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "protected_source_unavailable" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    if (priorTenant === undefined) delete process.env.CONTROL_ROOM_TENANT_ID; else process.env.CONTROL_ROOM_TENANT_ID = priorTenant;
    if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
  }
});
