import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabHermes021ConnectionRosterV1 } from "../src/idea-lab/v1/index.ts";
import { buildConnectionCenterProjectionV1, fetchConnectionCenterV1 } from "../src/connection-center/v1/index.ts";

const projection = buildConnectionCenterProjectionV1(buildIdeaLabHermes021ConnectionRosterV1({
  tenantId: "tenant:browser", evaluatedAt: "2026-09-01T18:00:00.000Z", connections: [],
}));

test("CR13A-LIVE-010 browser client accepts only the digest-bound protected projection", async () => {
  const accepted = await fetchConnectionCenterV1(async () => Response.json({ projection }));
  assert.deepEqual(accepted, { state: "available", projection });
  const changed = { ...projection, safeStatusCode: "enrollment_present_qualification_required" };
  const rejected = await fetchConnectionCenterV1(async () => Response.json({ projection: changed }));
  assert.deepEqual(rejected, { state: "unavailable", code: "invalid_response" });
  const extra = await fetchConnectionCenterV1(async () => Response.json({ projection, extra: true }));
  assert.deepEqual(extra, { state: "unavailable", code: "invalid_response" });
});

test("CR13A-LIVE-010 browser client distinguishes authentication, server, and network failure", async () => {
  assert.deepEqual(await fetchConnectionCenterV1(async () => Response.json({}, { status: 401 })),
    { state: "unavailable", code: "authentication_required" });
  assert.deepEqual(await fetchConnectionCenterV1(async () => Response.json({}, { status: 503 })),
    { state: "unavailable", code: "connection_center_unavailable" });
  assert.deepEqual(await fetchConnectionCenterV1(async () => { throw new Error("offline"); }),
    { state: "unavailable", code: "request_failed" });
});
