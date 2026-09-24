import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server, ServerOptions } from "node:http";
import test, { after } from "node:test";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalControlRoomServiceV1 } from "../src/web/v1/mac-local-serving";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("Mac-local service is inert until explicit start and binds only its selected loopback port", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-serving" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  let bound: Record<string, unknown> | undefined;
  const server = new EventEmitter() as Server;
  server.listen = ((input: Record<string, unknown>, callback: () => void) => { bound = input; queueMicrotask(callback); return server; }) as Server["listen"];
  server.close = (callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const service = createMacLocalControlRoomServiceV1({ origin, port: 3210, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, assets: { count: 0, digest: "empty", respond: () => undefined },
    render: () => new Response("shell"), createServer: (_options: Readonly<ServerOptions>) => server,
    listenerTiming: { bindMs: 100, closeMs: 100 } });
  assert.equal(service.isReady(), false); assert.equal(bound, undefined);
  await service.start();
  assert.equal(bound?.host, "127.0.0.1"); assert.equal(bound?.port, 3210);
  assert.equal(bound?.exclusive, true); assert.equal(bound?.backlog, 64); assert.ok(bound?.signal instanceof AbortSignal);
  assert.equal(service.isReady(), true);
  await service.close(); assert.equal(service.isReady(), false);
});
