// The owner's "Add a worker" path through the real Mac-local web process:
// signed-in owner only, same-origin writes only, and absent unless the host
// runs the fleet gateway.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { after } from "node:test";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { FLEET_CONNECTOR_RELEASE_SCHEMA_V1, type FleetConnectorReleaseManifestV1 } from "../src/fleet/v1/connector-release";
import { prepareMacLocalFleetGatewayV1, prepareMacLocalFleetOwnerV1 }
  from "../src/fleet/v1/mac-local-composition";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

const connectorRelease: FleetConnectorReleaseManifestV1 = Object.freeze({ schema: FLEET_CONNECTOR_RELEASE_SCHEMA_V1,
  version: "0.3.0", file: "connector-0.3.0.mjs", sha256: "a".repeat(64), size: 1234, builtFrom: "b".repeat(40) });

test("owner fleet routes: add a worker returns a one-time join command; foreign origins and signed-out calls are refused", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "fleet-owner-web" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  // The fleet tables enforce expiry with the database clock, so this route uses real time.
  const make = (fleet?: { gatewayOrigin: string; connectorRelease: FleetConnectorReleaseManifestV1;
    ownerAuthority: typeof fixture.client }) => createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {}, isAvailable: () => true }, ...(fleet ? { fleet } : {}) });
  const app = make({ gatewayOrigin: "https://control.example.ts.net", connectorRelease, ownerAuthority: fixture.client });
  const request = (path: string, init: RequestInit = {}) => new Request(`${origin}${path}`, init);
  const unused = () => new Response("unused");
  assert.equal((await app.handle(request("/api/v1/fleet"), unused)).status, 401);
  const signedIn = await app.handle(request("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), unused);
  assert.equal(signedIn.status, 201);
  const cookie = signedIn.headers.get("set-cookie")!;
  const created = await app.handle(request("/api/v1/projects", { method: "POST", headers: { cookie, origin,
    "content-type": "application/json", "idempotency-key": "fleet-owner-project-001" },
  body: JSON.stringify({ title: "Fleet project", summary: "Remote worker proof" }) }), unused);
  assert.equal(created.status, 201, await created.clone().text());
  const projectId = (await created.json() as { project: { projectId: string } }).project.projectId;

  const body = JSON.stringify({ displayName: "Build server", workerKind: "codex", projectIds: [projectId],
    capabilities: ["code.change"], maxConcurrent: 1 });
  const foreign = await app.handle(request("/api/v1/fleet/enrollment-codes", { method: "POST", headers: { cookie,
    origin: "http://127.0.0.1:1", "content-type": "application/json" }, body }), unused);
  assert.equal(foreign.status, 403);
  const issued = await app.handle(request("/api/v1/fleet/enrollment-codes", { method: "POST", headers: { cookie, origin,
    "content-type": "application/json" }, body }), unused);
  assert.equal(issued.status, 201, await issued.clone().text());
  const value = await issued.json() as { code: string; commands: { unix: string } };
  assert.match(value.code, /^crj_[A-Za-z0-9_-]{43}$/u);
  assert.match(value.commands.unix, /connector-0\.3\.0\.mjs/u);
  assert.match(value.commands.unix, /connector-manifest\.json/u);
  assert.match(value.commands.unix, /--bot codex$/u);
  const board = await app.handle(request("/api/v1/fleet", { headers: { cookie } }), unused);
  assert.equal(board.status, 200);
  const listed = await board.json() as { pendingCodes: { displayName: string }[]; workers: unknown[] };
  assert.deepEqual(listed.pendingCodes.map(code => code.displayName), ["Build server"]);
  assert.ok(!JSON.stringify(listed).includes(value.code), "the code is shown once and never listed again");
  const localWorkers = await app.handle(request("/api/v1/local-workers", { headers: { cookie } }), unused);
  assert.equal(localWorkers.status, 200, "connector-only Mac hosts retain their owner-visible worker route");
  assert.deepEqual(await localWorkers.json(), { taskWorkersStarted: true,
    projectSections: ["overview", "inbox", "work", "agents", "reviews", "activity", "automations", "settings"],
    workers: [] });

  const without = make();
  assert.equal((await without.handle(request("/api/v1/fleet", { headers: { cookie } }), unused)).status, 401,
    "a process without the fleet option has no fleet routes (and its own sessions)");
});

test("the Mac fleet composition refuses a remote owner origin before opening a database", () => {
  let opened = 0;
  assert.throws(() => prepareMacLocalFleetOwnerV1({
    configuration: { localOwnerSession: { tenantId: "tenant:test" } } as never,
    databaseRoles: { fleetGateway: {}, fleetOwner: {} } as never,
    gatewayOrigin: "http://0.0.0.0:3212",
    openDatabase() { opened += 1; return { client: {} as never, async close() {} }; },
  }), /mac_local_fleet_owner_invalid/);
  assert.equal(opened, 0);
});

test("the Mac fleet composition binds its independently owned listener to loopback only", async () => {
  const opened: unknown[] = [], closed: unknown[] = [], listened: unknown[] = [];
  class FakeServer extends EventEmitter {
    listen(port: number, host: string, callback: () => void) { listened.push([port, host]); callback(); return this; }
    close(callback: (error?: Error) => void) { callback(); return this; }
  }
  const service = await prepareMacLocalFleetGatewayV1({
    configuration: { localOwnerSession: { tenantId: "tenant:test" } } as never,
    databaseRoles: { fleetGateway: { role: "gateway" }, fleetOwner: { role: "owner" } } as never,
    openDatabase(role) {
      opened.push(role);
      return { client: { async query() { return { rows: [], rowCount: 0 }; } } as never,
        async close() { closed.push(role); } };
    },
    createServer: () => new FakeServer() as never,
    port: 43212,
  });
  assert.deepEqual(opened, [{ role: "gateway" }]);
  assert.equal(service.origin, "http://127.0.0.1:43212");
  await service.start();
  assert.deepEqual(listened, [[43212, "127.0.0.1"]]);
  await service.close();
  assert.deepEqual(closed, [{ role: "gateway" }]);
});
