import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Server, ServerOptions } from "node:http";
import type { Socket } from "node:net";
import test, { after } from "node:test";
import { createPrivateNodeService } from "../src/web/v1/private-serving";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1,
  type GatewayAssertionProviderProfileV1 } from "../src/web/v1/access-verifier";
import { nodeExchange } from "./helpers/web-node";
import { conformanceEmail, conformanceNow, conformanceOrigin, conformanceSubject,
  closePrivateOwnerBootstrapConformanceDatabase, privateOwnerBootstrapFixture,
  privateOwnerBootstrapPgliteInstances, syntheticAssertion,
  syntheticSigningKey } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

function genericGatewayProfile(): GatewayAssertionProviderProfileV1 {
  return Object.freeze({ schema: GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1,
    profileId: "rs256_gateway_assertion", algorithm: "RS256", assertionHeader: "x-owner-gateway-assertion",
    claimContract: "standard_gateway_subject", subjectClaim: "sub", audienceClaim: "aud", issuerClaim: "iss",
    mfaPolicy: "gateway_policy_external" });
}

async function ingressFixture(options: { gatewayAssertionProfile?: GatewayAssertionProviderProfileV1 } = {}) {
  const f = await privateOwnerBootstrapFixture();
  await createPrivateOwnerBootstrapCommand({ openDatabase: f.openDatabase(), clock: () => conformanceNow })({
    configuration: f.configuration, database: f.database, trust: f.trust, assertion: f.assertion,
    ...(options.gatewayAssertionProfile ? { gatewayAssertionProfile: options.gatewayAssertionProfile } : {}) });
  let now = conformanceNow, activeKey = f.key, outage = false, loads = 0, databaseCloses = 0;
  const application = createPrivateWebProcess({ origin: conformanceOrigin, issuer: f.trust.issuer,
    audience: f.trust.audience, tenantId: f.configuration.tenantId, workspaceId: f.configuration.workspaceId,
    maxSessionSeconds: f.trust.maxSessionSeconds, clock: () => now,
    loadKeys: async () => { loads++; if (outage) throw new Error("synthetic_key_outage"); return [activeKey.publicKey]; },
    database: { client: f.client, close: async () => { databaseCloses++; } },
    ...(options.gatewayAssertionProfile ? { gatewayAssertionProfile: options.gatewayAssertionProfile } : {}) });
  const server = new EventEmitter() as Server;
  let serverOptions: Readonly<ServerOptions> | undefined, listenOptions: Record<string, unknown> | undefined;
  server.listen = ((options: Record<string, unknown>, callback: () => void) => {
    listenOptions = options; queueMicrotask(callback); return server;
  }) as typeof server.listen;
  server.close = (callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};
  const service = createPrivateNodeService({ origin: conformanceOrigin, port: 32122,
    application: { isReady: () => true, close: () => application.close() },
    handler: request => application.handle(request, () => new Response("synthetic shell")),
    assets: { count: 0, digest: "synthetic-empty", respond: () => undefined },
    ...(options.gatewayAssertionProfile ? { gatewayAssertionProfile: options.gatewayAssertionProfile } : {}),
    createServer: options => { serverOptions = options; return server; },
    listenerTiming: { bindMs: 100, closeMs: 100 } });
  await service.start();
  async function send(options: Parameters<typeof nodeExchange>[0] = {}, host = new URL(conformanceOrigin).host) {
    const exchange = nodeExchange(options); exchange.input.rawHeaders[1] = host;
    const completed = new Promise<void>((resolve, reject) => {
      exchange.output.once("finish", resolve); exchange.output.once("error", reject);
    });
    server.emit("request", exchange.input, exchange.output); await completed; return exchange;
  }
  function connect(peer: string) {
    let destroyed = 0;
    const socket = Object.assign(new EventEmitter(), { remoteAddress: peer,
      destroy() { destroyed++; }, setTimeout() { return socket; } }) as unknown as Socket;
    server.emit("connection", socket);
    return { destroyed: () => destroyed, close: () => socket.emit("close") };
  }
  const headers = (assertion = syntheticAssertion(activeKey)) => [
    options.gatewayAssertionProfile?.assertionHeader ?? "cf-access-jwt-assertion", assertion];
  return { ...f, service, send, connect, headers, serverOptions: () => serverOptions, listenOptions: () => listenOptions,
    now: (value: number) => { now = value; },
    rotate: (key: ReturnType<typeof syntheticSigningKey>) => { activeKey = key; },
    outage: (value: boolean) => { outage = value; }, loads: () => loads, databaseCloses: () => databaseCloses,
    closeAll: async () => { await service.close(); await f.close(); } };
}

function assertJson(exchange: Awaited<ReturnType<Awaited<ReturnType<typeof ingressFixture>>["send"]>>,
  status: number, error: string) {
  assert.equal(exchange.output.statusCode, status);
  assert.deepEqual(JSON.parse(exchange.body()), { error });
}

test("actual Node boundary rejects host, peer, forwarding, duplicate, and missing assertion bypasses", async t => {
  const f = await ingressFixture(); t.after(f.closeAll);
  assert.equal(f.service.isReady(), true);
  assert.equal(f.listenOptions()?.host, "127.0.0.1");
  assert.equal(f.serverOptions()?.insecureHTTPParser, false);
  const remote = f.connect("192.0.2.1"); assert.equal(remote.destroyed(), 1);
  const local = f.connect("127.0.0.1"); assert.equal(local.destroyed(), 0); local.close();
  const valid = f.headers(f.assertion);
  assertJson(await f.send({ headers: valid }, "wrong.example.invalid"), 403, "invalid_request");
  assertJson(await f.send({ headers: valid, peer: "192.0.2.1" }), 403, "invalid_request");
  for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for"])
    assertJson(await f.send({ headers: [...valid, name, new URL(conformanceOrigin).host] },
      "wrong.example.invalid"), 403, "invalid_request");
  assertJson(await f.send({ headers: [...valid, ...valid] }), 400, "invalid_request");
  assertJson(await f.send(), 401, "authentication_required");
  assert.equal(f.loads(), 1, "only the request reaching authentication may load keys");
});

test("issuer, audience, signature, and expiry faults refuse through the actual HTTP stack", async t => {
  const f = await ingressFixture(); t.after(f.closeAll);
  const wrong = syntheticSigningKey("synthetic-http-wrong-key");
  const assertions = [
    syntheticAssertion(f.key, { iss: "https://wrong.invalid" }),
    syntheticAssertion(f.key, { aud: ["wrong-audience"] }),
    syntheticAssertion(wrong),
    syntheticAssertion(f.key, { exp: conformanceNow / 1000 }),
  ];
  for (const assertion of assertions) assertJson(await f.send({ headers: f.headers(assertion) }),
    401, "authentication_required");
  assert.equal((await f.send({ headers: f.headers(f.assertion) })).output.statusCode, 200);
});

test("a selected generic gateway profile reaches ordinary project routes through the Node boundary", async t => {
  const f = await ingressFixture({ gatewayAssertionProfile: genericGatewayProfile() }); t.after(f.closeAll);
  assert.equal((await f.send({ headers: f.headers(f.assertion) })).output.statusCode, 200);
  const projects = await f.send({ path: "/api/v1/projects", headers: f.headers(f.assertion) });
  assert.equal(projects.output.statusCode, 200);
  assert.match(projects.body(), /projects/);
  const cloudflare = await f.send({ headers: ["cf-access-jwt-assertion", f.assertion] });
  assertJson(cloudflare, 401, "authentication_required");
});

test("key rotation and outage follow bounded cache freshness with no stale fallback", async t => {
  await t.test("rotation", async t => {
    const f = await ingressFixture(); t.after(f.closeAll);
    assert.equal((await f.send({ headers: f.headers(f.assertion) })).output.statusCode, 200);
    const rotated = syntheticSigningKey("synthetic-rotated-key"); f.rotate(rotated);
    f.now(conformanceNow + 300_001);
    assertJson(await f.send({ headers: f.headers(f.assertion) }), 401, "authentication_required");
    assert.equal((await f.send({ headers: f.headers(syntheticAssertion(rotated)) })).output.statusCode, 200);
    assert.equal(f.loads(), 2);
  });
  await t.test("outage", async t => {
    const f = await ingressFixture(); t.after(f.closeAll);
    assert.equal((await f.send({ headers: f.headers(f.assertion) })).output.statusCode, 200);
    f.now(conformanceNow + 300_001); f.outage(true);
    assertJson(await f.send({ headers: f.headers(f.assertion) }), 503, "service_unavailable");
    f.outage(false);
    assertJson(await f.send({ headers: f.headers(f.assertion) }), 503, "service_unavailable");
    assert.equal(f.loads(), 2, "backoff does not turn request traffic into key retries");
    f.now(conformanceNow + 305_002);
    assert.equal((await f.send({ headers: f.headers(f.assertion) })).output.statusCode, 200);
    assert.equal(f.loads(), 3);
  });
});

test("current identity, session, and grant revocation are enforced on later requests", async t => {
  for (const mode of ["identity", "session", "grant"] as const) await t.test(mode, async t => {
    const f = await ingressFixture(); t.after(f.closeAll);
    const request = { headers: f.headers(f.assertion) };
    assert.equal((await f.send(request)).output.statusCode, 200);
    if (mode === "identity") await f.client.query("UPDATE control_identities SET state='suspended' WHERE tenant_id=$1 AND id=$2",
      [f.configuration.tenantId, f.configuration.identityId]);
    else if (mode === "grant") await f.client.query("UPDATE control_role_grants SET revoked_at=$1 WHERE tenant_id=$2 AND id=$3",
      [new Date(conformanceNow).toISOString(), f.configuration.tenantId, f.configuration.grantId]);
    else await f.client.query("UPDATE control_web_sessions SET revoked_at=$1 WHERE tenant_id=$2",
      [new Date(conformanceNow).toISOString(), f.configuration.tenantId]);
    assertJson(await f.send(request), mode === "session" ? 401 : 403,
      mode === "session" ? "authentication_required" : "access_denied");
  });
});

test("authenticated persistence and HTTP output exclude raw assertion, email, subject, and keys", async t => {
  const f = await ingressFixture(); t.after(f.closeAll);
  const response = await f.send({ headers: f.headers(f.assertion) }); assert.equal(response.output.statusCode, 200);
  const [identities, grants, sessions] = await Promise.all([
    f.client.query("SELECT * FROM control_identities WHERE tenant_id=$1", [f.configuration.tenantId]),
    f.client.query("SELECT * FROM control_role_grants WHERE tenant_id=$1", [f.configuration.tenantId]),
    f.client.query("SELECT * FROM control_web_sessions WHERE tenant_id=$1", [f.configuration.tenantId]),
  ]);
  assert.equal(sessions.rows.length, 1);
  const evidence = JSON.stringify({ body: response.body(), identities: identities.rows, grants: grants.rows, sessions: sessions.rows });
  for (const forbidden of [conformanceSubject, conformanceEmail, f.assertion, f.database.password,
    f.key.publicKey.jwk.n!, JSON.stringify(f.key.publicKey.jwk)]) assert.equal(evidence.includes(forbidden), false);
});

test("ingress cases create at most one PGlite instance in this test process", () => {
  assert.equal(privateOwnerBootstrapPgliteInstances(), 1);
});
