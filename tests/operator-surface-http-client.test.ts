import assert from "node:assert/strict";
import test from "node:test";
import { fetchOperatorSurfaceSnapshotV1, OPERATOR_SURFACES_CONTRACT_V1, saveOwnerFocusV1 } from "../src/operator-surfaces/v1";

const snapshot = {
  contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant:1", generatedAt: "2026-08-27T12:00:00.000Z",
  fleet: [], bottlenecks: [], activeWork: [], services: [], schedules: [], serviceIncidents: [], actionInbox: [], ownerFocus: [],
};

test("CR6E browser reader requests the protected route without a tenant parameter", async () => {
  let receivedInput: RequestInfo | URL | undefined;
  let receivedInit: RequestInit | undefined;
  const result = await fetchOperatorSurfaceSnapshotV1(async (input, init) => {
    receivedInput = input;
    receivedInit = init;
    return Response.json({ snapshot });
  });
  assert.equal(receivedInput, "/api/v1/operator-surface");
  assert.deepEqual(receivedInit, { credentials: "same-origin", cache: "no-store" });
  assert.deepEqual(result, { state: "available", snapshot });
});

test("CR6E browser reader fails closed when the response projection is invalid", async () => {
  const result = await fetchOperatorSurfaceSnapshotV1(async () => Response.json({ snapshot: { ...snapshot, tenantId: "Bearer secret-value" } }));
  assert.deepEqual(result, { state: "unavailable", code: "invalid_response" });
});

test("CR6E browser reader reports only safe unavailable states", async () => {
  assert.deepEqual(await fetchOperatorSurfaceSnapshotV1(async () => Response.json({ error: "anything" }, { status: 401 })), { state: "unavailable", code: "authentication_required" });
  assert.deepEqual(await fetchOperatorSurfaceSnapshotV1(async () => Response.json({ error: "anything" }, { status: 503 })), { state: "unavailable", code: "operator_surface_unavailable" });
  assert.deepEqual(await fetchOperatorSurfaceSnapshotV1(async () => { throw new Error("private network details"); }), { state: "unavailable", code: "request_failed" });
});

test("CR6E Owner Focus browser writer omits tenant and scheduling fields", async () => {
  let request: RequestInit | undefined;
  const identifiers = ["command:focus:browser", "idempotency-key-browser-001"];
  const result = await saveOwnerFocusV1({ operation: "set_owner_focus", projectId: "project:1", level: "p0", reason: "Keep it visible" }, {
    idFactory: () => identifiers.shift()!,
    fetcher: async (_input, init) => { request = init; return Response.json({ state: "recorded" }, { status: 201 }); },
  });
  assert.deepEqual(result, { state: "recorded" });
  assert.equal(request?.credentials, "same-origin");
  assert.equal((request?.headers as Record<string, string>)["idempotency-key"], "idempotency-key-browser-001");
  assert.deepEqual(JSON.parse(request?.body as string), { commandId: "command:focus:browser", operation: "set_owner_focus", projectId: "project:1", level: "p0", reason: "Keep it visible" });
});
