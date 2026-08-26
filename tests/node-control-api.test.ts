import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/v1/nodes/[nodeId]/operations/route.ts";

const context = { params: Promise.resolve({ nodeId: "node:test" }) };

test("node operation API rejects unauthenticated writes before reading configuration or body", async () => {
  const response = await POST(new Request("https://control-room.test/api/v1/nodes/node:test/operations", {
    method: "POST",
    body: "not-json",
  }), context);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});

test("node operation status is private to an authenticated requester", async () => {
  const response = await GET(new Request(
    "https://control-room.test/api/v1/nodes/node:test/operations?request_id=node-operation:test",
  ), context);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});
