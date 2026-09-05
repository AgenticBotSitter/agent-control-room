import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateWebProcess } from "../src/web/v1/private-process.ts";
import { WebConnectionService } from "../src/web/v1/connection-service.ts";
import { createAccessVerifier } from "../src/web/v1/access-verifier.ts";
import { fixture, now, origin, request, trust, token } from "./helpers/web-foundation.ts";
import { seedWebConnection, seedWebSignal, webConnectionKeys, webRegistryKey } from "./helpers/web-connection.ts";

const render = () => new Response("private connections shell");
const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const identity = () => createAccessVerifier(trust)(request(), now);

test("private connection API reads existing integrity-protected enrollment and signal evidence in the shared session", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const enrolled = await seedWebConnection(f.client); await seedWebSignal(f.client);
  let current = now;
  const app = createPrivateWebProcess({ origin, ...trust, ...scope, connections: webConnectionKeys,
    database: { client: f.client, close: async () => {} }, clock: () => current, loadKeys: async () => trust.keys });
  t.after(() => app.close());
  const response = await app.handle(request("/api/v1/connections"), render);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const value = await response.json(); assert.equal(value.telemetry, "configured");
  assert.equal(value.projection.summary.connectionCount, 1); assert.equal(value.projection.summary.currentSignalCount, 1);
  assert.equal(value.projection.summary.livePanelEligibleCount, 0);
  const serialized = JSON.stringify(value);
  for (const hidden of [scope.tenantId, enrolled.nodeId, enrolled.connectionId, enrolled.enrollmentId,
    enrolled.connectorRouteDigest, enrolled.profileIdentityDigest, enrolled.issuerKeyDigest]) assert.equal(serialized.includes(hidden), false, hidden);
  assert.equal((await app.handle(request("/connections"), render)).status, 200);
  current += 60_000;
  const stale = await (await app.handle(request("/api/v1/connections"), render)).json();
  assert.equal(stale.projection.summary.currentSignalCount, 0); assert.equal(stale.projection.summary.staleSignalCount, 1);
  await app.handle(request("/api/v1/session/logout", "POST"), render);
  for (const path of ["/connections", "/api/v1/connections", "/projects"])
    assert.equal((await app.handle(request(path), render)).status, 401, path);
});

test("connection reads require a tenant-wide owner grant before consulting source configuration or records", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await seedWebConnection(f.client);
  const app = createPrivateWebProcess({ origin, ...trust, ...scope, connections: webConnectionKeys,
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close());
  let renders = 0; const page = () => { renders++; return render(); };
  for (const [role, actions, projects, strong] of [
    ["operator", ["*"], ["*"], false], ["owner", ["projects.read"], ["*"], false],
    ["owner", ["connections.read"], ["project:one"], false], ["owner", ["connections.read"], ["*"], true],
  ] as const) {
    await f.db.query("UPDATE control_role_grants SET role_key=$1,allowed_actions=$2,project_ids=$3,require_strong_factor=$4 WHERE id='grant:web'", [role, actions, projects, strong]);
    for (const path of ["/connections", "/api/v1/connections"]) assert.equal((await app.handle(request(path), page)).status, 403);
  }
  assert.equal(renders, 0);
  await f.db.query("UPDATE control_role_grants SET allowed_actions=$1,project_ids=$2,require_strong_factor=false WHERE id='grant:web'", [["connections.read"], ["*"]]);
  assert.equal((await app.handle(request("/api/v1/connections"), render)).status, 200);
  assert.equal((await app.handle(request("/api/v1/projects"), render)).status, 403);
  await f.db.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
  assert.equal((await app.handle(request("/connections"), page)).status, 403);
  assert.equal((await app.handle(request("/api/v1/session/logout", "POST"), render)).status, 204);
});

test("missing configuration differs from verified empty inventory and absent telemetry; bad integrity never becomes empty", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const unconfigured = new WebConnectionService(f.client, scope, () => now);
  await assert.rejects(unconfigured.read(identity()), /not_configured/);
  const configured = new WebConnectionService(f.client, scope, () => now, { registryIntegrityKey: webRegistryKey });
  const empty = await configured.read(identity()); assert.equal(empty.projection.inventoryState, "empty");
  assert.equal(empty.telemetry, "not_configured");
  await seedWebConnection(f.client); await seedWebSignal(f.client);
  const missing = await configured.read(identity()); assert.equal(missing.projection.summary.missingSignalCount, 1);
  assert.equal(missing.projection.summary.currentSignalCount, 0);
  await assert.rejects(new WebConnectionService(f.client, scope, () => now,
    { registryIntegrityKey: new Uint8Array(32).fill(0x55) }).read(identity()));
  await f.db.query("UPDATE control_connection_registry_heads SET last_sequence=last_sequence+1 WHERE tenant_id='tenant:web'");
  const app = createPrivateWebProcess({ origin, ...trust, ...scope, connections: webConnectionKeys,
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close());
  const failed = await app.handle(request("/api/v1/connections"), render);
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "service_unavailable" });
});

test("tenant scope and authenticated telemetry integrity remain isolated", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:other','Other test tenant')");
  await seedWebConnection(f.client, { tenantId: "tenant:other", nodeId: "node:other", connectionId: "connection:other" });
  const service = new WebConnectionService(f.client, scope, () => now, webConnectionKeys);
  assert.equal((await service.read(identity())).projection.summary.connectionCount, 0);
  await seedWebConnection(f.client); await seedWebSignal(f.client);
  await f.db.query("UPDATE control_connection_authenticated_telemetry_receipts SET receipt_auth_tag=$1 WHERE tenant_id='tenant:web'", [`hmac-sha256:${"0".repeat(64)}`]);
  await assert.rejects(service.read(identity()));
});

test("connection authorization and source reads use one transaction and recheck grant and token deadlines before commit", async t => {
  const f = await fixture(); t.after(() => f.db.close()); await seedWebConnection(f.client);
  let current = now, transactions = 0;
  const client = { ...f.client,
    transaction: async () => { throw new Error("unexpected nested transaction"); },
    transactionWithPreCommitCheck: async <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) => {
      transactions++; return f.client.transactionWithPreCommitCheck(run, () => { current += 60_000; check(); });
    },
  };
  await f.db.query("UPDATE control_role_grants SET expires_at=$1 WHERE id='grant:web'", [new Date(now + 30_000).toISOString()]);
  const service = new WebConnectionService(client, scope, () => current, webConnectionKeys);
  await assert.rejects(service.read(identity()), /access_denied/); assert.equal(transactions, 1);
  await f.db.query("UPDATE control_role_grants SET expires_at=NULL WHERE id='grant:web'"); current = now;
  const shortIdentity = createAccessVerifier(trust)(request(undefined, "GET", undefined, undefined, token({ exp: now / 1000 + 30 })), now);
  await assert.rejects(service.read(shortIdentity), /authentication_required/); assert.equal(transactions, 2);
});

test("connection routes reject query-selected scope, writes, old endpoints and unverified header identity", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const app = createPrivateWebProcess({ origin, ...trust, ...scope,
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close());
  for (const path of ["/connections?tenantId=tenant:other", "/api/v1/connections?tenantId=tenant:other", "/api/v1/connections?after=x"])
    assert.equal((await app.handle(request(path), render)).status, 400);
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await app.handle(request("/api/v1/connections", method), render)).status, 400);
  assert.equal((await app.handle(request("/api/v1/connections/enroll", "POST"), render)).status, 404);
  assert.equal((await app.handle(new Request(`${origin}/connections`, { headers: { "oai-authenticated-user-id": "owner" } }), render)).status, 401);
  assert.equal((await app.handle(request("/api/v1/connections"), render)).status, 503);
  await f.db.query("UPDATE control_identities SET state='suspended' WHERE id='identity:web'");
  assert.equal((await app.handle(request("/connections"), render)).status, 403);
});
