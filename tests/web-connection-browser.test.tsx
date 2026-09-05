import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readPrivateConnections, ConnectionBrowserError } from "../src/web/v1/connection-browser-client.ts";
import { PrivateConnectionView } from "../private-app/app/connections/workspace.tsx";
import { buildConnectionCenterProjectionV1 } from "../src/connection-center/v1/service.ts";
import { buildIdeaLabHermes021ConnectionRosterV1 } from "../src/idea-lab/v1/index.ts";
import { safeWebConnection } from "./helpers/web-connection.ts";
import { now } from "./helpers/web-foundation.ts";

const projection = buildConnectionCenterProjectionV1(buildIdeaLabHermes021ConnectionRosterV1({
  tenantId: "tenant:web", evaluatedAt: new Date(now).toISOString(), connections: [safeWebConnection()],
}));
const snapshot = { projection, telemetry: "not_configured" as const };
test("private connection client uses only bounded same-origin read requests and validates its exact envelope", async () => {
  let calls = 0;
  assert.deepEqual(await readPrivateConnections(async (path, options) => {
    calls++; assert.equal(path, "/api/v1/connections"); assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    assert.equal(options?.credentials, "same-origin"); assert.ok(options?.signal);
    assert.equal(new Headers(options?.headers).get("x-requested-with"), "XMLHttpRequest");
    assert.equal(options?.body, undefined); return Response.json(snapshot);
  }), snapshot);
  assert.equal(calls, 1);
  for (const body of [{ projection }, { ...snapshot, token: "not-accepted" },
    { ...snapshot, projection: { ...projection, inventoryState: "empty" } },
    { ...snapshot, telemetry: "unknown" }]) {
    await assert.rejects(readPrivateConnections(async () => Response.json(body)), /unavailable/);
  }
  const current = buildConnectionCenterProjectionV1(buildIdeaLabHermes021ConnectionRosterV1({
    tenantId: "tenant:web", evaluatedAt: new Date(now).toISOString(), connections: [safeWebConnection()],
  }), [{ state: "current", basis: "authenticated_telemetry", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }]);
  await assert.rejects(readPrivateConnections(async () => Response.json({ projection: current, telemetry: "not_configured" })), /unavailable/);
});

test("private connection client surfaces authentication, permission and availability without raw errors or retries", async () => {
  for (const [status, code] of [[401, "authentication_required"], [403, "access_denied"], [503, "unavailable"]] as const) {
    let calls = 0;
    await assert.rejects(readPrivateConnections(async () => { calls++; return Response.json({ detail: "private server failure" }, { status }); }),
      error => error instanceof ConnectionBrowserError && error.code === code && error.message === code);
    assert.equal(calls, 1);
  }
  await assert.rejects(readPrivateConnections(async () => { throw new Error("private transport failure"); }), /unavailable/);
});

test("private connection presentation exposes observation scope, setup limits and navigation without actions", () => {
  const html = renderToStaticMarkup(<PrivateConnectionView data={{ state: "ready", snapshot }} onRefresh={() => {}} />);
  assert.match(html, /Connections/); assert.match(html, /Last checked/); assert.match(html, /not a live fleet monitor/);
  assert.match(html, /covers all workspaces in this Control Room account/);
  assert.match(html, /Signal verification is not configured/); assert.match(html, /Refresh connections/);
  assert.match(html, /href="\/projects"/); assert.match(html, /href="\/session"/);
  assert.match(html, /Read only · no connect action/);
  assert.doesNotMatch(html, /Connect now|<input|<form|Start Hermes|node:private-test|connection:private-test/);
});

test("loading, missing configuration and revoked sessions never display a previous inventory", () => {
  const loading = renderToStaticMarkup(<PrivateConnectionView data={{ state: "loading" }} onRefresh={() => {}} />);
  assert.match(loading, /Loading protected connection inventory/); assert.match(loading, /disabled/);
  for (const code of ["authentication_required", "access_denied", "unavailable"] as const) {
    const html = renderToStaticMarkup(<PrivateConnectionView data={{ state: "unavailable", code }} onRefresh={() => {}} />);
    assert.doesNotMatch(html, /connection:inventory:001|Last checked|No enrolled connections yet/);
    assert.match(html, /role="alert"/);
    if (code === "authentication_required") assert.match(html, /also ends Access sessions for other protected applications/);
    if (code === "unavailable") assert.match(html, /No sample or old connection data is shown/);
  }
});
