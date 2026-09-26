import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server, ServerOptions } from "node:http";
import test, { after } from "node:test";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalControlRoomServiceV1 } from "../src/web/v1/mac-local-serving";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { handlePrivateWebRequest } from "../src/web/v1/private-process";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("Mac-local service is inert until explicit start and binds only its selected loopback port", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-serving" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  type ObservedListenOptions = Readonly<{ host?: string; port?: number; exclusive?: boolean; backlog?: number; signal?: AbortSignal }>;
  const capture = new class {
    #value: ObservedListenOptions | undefined;
    set(value: ObservedListenOptions) { this.#value = value; }
    read(): ObservedListenOptions | undefined { return this.#value; }
  }();
  const server = new EventEmitter() as Server;
  server.listen = ((input: ObservedListenOptions, callback?: () => void) => {
    capture.set(input);
    if (callback) queueMicrotask(callback);
    return server;
  }) as Server["listen"];
  server.close = (callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const service = createMacLocalControlRoomServiceV1({ origin, port: 3210, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, assets: { count: 0, digest: "empty", respond: () => undefined },
    render: () => new Response("shell"), createServer: (_options: Readonly<ServerOptions>) => server,
    listenerTiming: { bindMs: 100, closeMs: 100 } });
  assert.equal(service.isReady(), false); assert.equal(capture.read(), undefined);
  await service.start();
  const observed = (): ObservedListenOptions | undefined => capture.read();
  assert.equal(observed()?.host, "127.0.0.1"); assert.equal(observed()?.port, 3210);
  assert.equal(observed()?.exclusive, true); assert.equal(observed()?.backlog, 64); assert.ok(observed()?.signal instanceof AbortSignal);
  assert.equal(service.isReady(), true);

  // The page middleware path: nothing renders without a verified owner session.
  let rendered = 0;
  const render = () => { rendered++; return new Response("page"); };
  const anonymous = await handlePrivateWebRequest(new Request(`${origin}/projects`), render);
  assert.equal(anonymous.status, 401); assert.equal(rendered, 0);
  const wrong = await handlePrivateWebRequest(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST",
    headers: { "content-type": "application/json", origin }, body: JSON.stringify({ ownerCode: `${ownerCode}x` }) }), render);
  assert.equal(wrong.status, 401); assert.equal(wrong.headers.get("set-cookie"), null);
  const signed = await handlePrivateWebRequest(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST",
    headers: { "content-type": "application/json", origin }, body: JSON.stringify({ ownerCode }) }), render);
  assert.equal(signed.status, 201);
  const cookie = (signed.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  const page = await handlePrivateWebRequest(new Request(`${origin}/projects`, { headers: { cookie } }), render);
  assert.equal(page.status, 200); assert.equal(rendered, 1);
  assert.equal(await page.text(), "page");

  await service.close(); assert.equal(service.isReady(), false);
});
