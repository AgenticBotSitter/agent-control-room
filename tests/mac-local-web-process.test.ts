import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createMacLocalNodeHandler } from "../src/web/v1/private-node-handler";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";
import { nodeExchange } from "./helpers/web-node";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("the real Mac-local wrapper signs in locally and reaches the existing project service", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-web" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow });
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  assert.equal((await app.handle(request("/api/v1/projects"), () => new Response("unused"))).status, 401);
  const signedIn = await app.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.get("set-cookie"); assert.ok(cookie);
  const projects = await app.handle(request("/api/v1/projects", { headers: { cookie: cookie! } }), () => new Response("unused"));
  assert.equal(projects.status, 200);
  assert.match(await projects.text(), /projects/);
  const shell = await app.handle(request("/projects", { headers: { cookie: cookie! } }), () => new Response("real shell"));
  assert.equal(shell.status, 200); assert.equal(await shell.text(), "real shell");
  await app.close();
});

test("the Mac-local wrapper does not accept a forwarded or foreign request", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-reject" }); t.after(fixture.close);
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow });
  const response = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin, forwarded: "for=192.0.2.1", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  assert.equal(response.status, 403);
  await app.close();
});

test("the Mac-local transport is loopback-only and is the only transport that relays its session cookie", async () => {
  const origin = "http://127.0.0.1:3210";
  assert.throws(() => createMacLocalNodeHandler({ origin: "https://private.example.invalid", application: {
    isReady: () => true, close: async () => {},
  }, handler: async () => new Response("unused"), assets: { count: 0, digest: "empty", respond: () => undefined } }),
  /mac_local_serving_config_invalid/);
  const handler = createMacLocalNodeHandler({ origin, application: { isReady: () => true, close: async () => {} },
    handler: async () => new Response("ok", { headers: { "set-cookie": "control_room_local_owner=value; HttpOnly" } }),
    assets: { count: 0, digest: "empty", respond: () => undefined } });
  const exchange = nodeExchange({ path: "/session" }); exchange.input.rawHeaders[1] = "127.0.0.1:3210";
  const done = new Promise<void>((resolve, reject) => { exchange.output.once("finish", resolve); exchange.output.once("error", reject); });
  void handler.handle(exchange.input, exchange.output); await done;
  assert.equal(exchange.headers.get("set-cookie"), "control_room_local_owner=value; HttpOnly");
});
