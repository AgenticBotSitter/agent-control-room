import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionCenterReadHandlerV1 } from "../app/api/v1/connections/route.ts";
import { buildIdeaLabHermes021ConnectionRosterV1 } from "../src/idea-lab/v1/index.ts";

const request = () => new Request("http://127.0.0.1:3000/api/v1/connections");

test("CR13A-LIVE-010 authenticates before reading any connection source", async () => {
  let reads = 0, freshnessReads = 0;
  const handler = createConnectionCenterReadHandlerV1({
    ownerSession: { async verify() { throw new Error("unauthenticated"); } },
    rosterSource: { async read(input) { reads += 1; return buildIdeaLabHermes021ConnectionRosterV1({ tenantId: input.tenantId,
      evaluatedAt: input.now, connections: [] }); } },
    freshnessSource: { async read() { freshnessReads += 1;
      return { state: "missing", basis: "none", observedAt: null, expiresAt: null }; } },
  });
  const response = await handler(request());
  assert.equal(response.status, 401);
  assert.deepEqual([reads, freshnessReads], [0, 0]);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
});

test("CR13A-LIVE-010 derives tenant scope from authentication and returns a bounded protected projection", async () => {
  let seenTenant: string | undefined;
  const handler = createConnectionCenterReadHandlerV1({
    ownerSession: { async verify(_credential, now) { return { tenantId: "tenant:owner", provider: "test",
      subject: "owner", verifiedAt: now, expiresAt: "2026-09-02T18:00:00.000Z" }; } },
    rosterSource: { async read(input) { seenTenant = input.tenantId;
      return buildIdeaLabHermes021ConnectionRosterV1({ tenantId: input.tenantId, evaluatedAt: input.now, connections: [] }); } },
    freshnessSource: { async read() { return { state: "missing", basis: "none", observedAt: null, expiresAt: null }; } },
  });
  const response = await handler(request());
  const body = await response.json() as { projection: { tenantScoped: true; presentationOnly: boolean; grantsExecutionAuthority: boolean } };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual([seenTenant, body.projection.tenantScoped, body.projection.presentationOnly,
    body.projection.grantsExecutionAuthority], ["tenant:owner", true, true, false]);
});
