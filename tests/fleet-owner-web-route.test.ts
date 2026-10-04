// The owner's "Add a worker" path through the real Mac-local web process:
// signed-in owner only, same-origin writes only, and absent unless the host
// runs the fleet gateway.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import test, { after } from "node:test";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1, LocalOwnerSessionServiceV1,
  captureLocalOwnerSessionProfileV1 } from "../src/web/v1/local-owner-session";
import { createFleetOwnerHttpHandlerV1 } from "../src/web/v1/fleet-owner-http";
import { FleetErrorV1, type FleetOwnerServiceV1 } from "../src/fleet/v1";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { FLEET_CONNECTOR_RELEASE_SCHEMA_V1, type FleetConnectorReleaseManifestV1 } from "../src/fleet/v1/connector-release";
import { prepareMacLocalFleetGatewayV1, prepareMacLocalFleetOwnerV1 }
  from "../src/fleet/v1/mac-local-composition";
import { RELEASE_TRUST_SCHEMA_V1, releaseKeyIdV1 } from "../scripts/release-signing.mjs";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("owner offer HTTP acknowledges exact replay and preserves service refusals", { timeout: 30_000 }, async () => {
  const origin = "http://127.0.0.1:3210", ownerCode = "offer-route-owner-code-000001", now = conformanceNow;
  const sessions = new LocalOwnerSessionServiceV1(captureLocalOwnerSessionProfileV1({
    schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:offer-route", provider: "test",
    subject: "identity:owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900,
  }));
  const { cookie } = await sessions.issue(new Request(`${origin}/api/v1/local-owner-session`, {
    method: "POST", headers: { origin, "sec-fetch-site": "same-origin" },
  }), ownerCode, now);
  const offerId = `fleet-offer:${"a".repeat(32)}`;
  let replayed = false, failure: FleetErrorV1 | undefined;
  const calls: unknown[] = [];
  // This tests the HTTP acknowledgement of the service's decision. The real
  // scope comparison and production-login authority are covered in the PG lane.
  const service = { async offerTask(_identity: unknown, input: unknown) {
    calls.push(input);
    if (failure) throw failure;
    return { offerId, replayed };
  } } as unknown as FleetOwnerServiceV1;
  const handle = createFleetOwnerHttpHandlerV1({ origin, service, localOwnerSession: sessions, clock: () => now });
  const body = { projectId: "project:route", jobId: "job:route", capability: "code.change" };
  const post = (raw = JSON.stringify(body), headers: Record<string, string> = {}) => handle(new Request(
    `${origin}/api/v1/fleet/offers`, { method: "POST", headers: { origin, cookie,
      "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers }, body: raw }));
  const first = await post();
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { offerId, replayed: false });
  replayed = true;
  const retry = await post();
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), { offerId, replayed: true });
  assert.deepEqual(calls, [body, body], "the service decides whether the whole request is an exact replay");
  for (const [code, status] of [["conflict", 409], ["not_found", 404], ["invalid", 400]] as const) {
    failure = new FleetErrorV1(code);
    const refused = await post();
    assert.equal(refused.status, status);
    assert.deepEqual(await refused.json(), { error: code === "invalid" ? "invalid_request" : code });
  }
  failure = undefined;
  const beforeBadInput = calls.length;
  for (const raw of ["{", "[]", "null"]) assert.equal((await post(raw)).status, 400);
  assert.equal((await post(JSON.stringify(body), { cookie: "" })).status, 401);
  assert.equal((await post(JSON.stringify(body), { origin: "http://127.0.0.1:1" })).status, 403);
  assert.equal(calls.length, beforeBadInput, "bad input and unauthorized requests never reach the service");
  const recovered = await post();
  assert.equal(recovered.status, 201, "retry after a refusal still acknowledges the existing offer");
  assert.deepEqual(await recovered.json(), { offerId, replayed: true });
  const burst = await Promise.all(Array.from({ length: 50 }, () => post()));
  assert.ok(burst.every(response => response.status === 201));
  for (const response of burst) assert.deepEqual(await response.json(), { offerId, replayed: true });
});

const connectorRelease: FleetConnectorReleaseManifestV1 = Object.freeze({ schema: FLEET_CONNECTOR_RELEASE_SCHEMA_V1,
  version: "0.3.0", file: "connector-0.3.0.mjs", sha256: "a".repeat(64), size: 1234, builtFrom: "b".repeat(40) });
const releasePublicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const releaseTrust = Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
  keyId: releaseKeyIdV1(releasePublicKey), publicKey: releasePublicKey, versionFloor: "0.0.0", revokedKeyIds: [] });

test("owner fleet routes: add a worker returns a one-time install command; foreign origins and signed-out calls are refused", async t => {
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
  assert.match(value.commands.unix, / install .*--bot codex .*--i-am-the-installer$/u);
  assert.doesNotMatch(value.commands.unix, /\sjoin\s/u);
  const board = await app.handle(request("/api/v1/fleet", { headers: { cookie } }), unused);
  assert.equal(board.status, 200);
  const listed = await board.json() as { pendingCodes: { displayName: string }[]; workers: unknown[] };
  assert.deepEqual(listed.pendingCodes.map(code => code.displayName), ["Build server"]);
  assert.ok(!JSON.stringify(listed).includes(value.code), "the code is shown once and never listed again");
  const localWorkers = await app.handle(request("/api/v1/local-workers", { headers: { cookie } }), unused);
  assert.equal(localWorkers.status, 200, "connector-only Mac hosts retain their owner-visible worker route");
  assert.deepEqual(await localWorkers.json(), { taskWorkersStarted: true,
    projectSections: ["overview", "inbox", "work", "agents", "reviews", "automations", "settings"],
    workers: [] });
  // The connector-only host builds no project-event source, so its activity
  // feed is absent (404), never the permanent 503 the owner used to see.
  for (const feed of ["activity", "events"]) {
    const absent = await app.handle(request(`/api/v1/projects/${encodeURIComponent(projectId)}/${feed}`, { headers: { cookie } }), unused);
    assert.equal(absent.status, 404, `${feed}: ${await absent.clone().text()}`);
  }

  const connectBody = JSON.stringify({ botKind: "cursor", name: "desktop-cursor", operatingSystem: "windows",
    projectIds: [projectId], capabilities: ["writing"], unattended: false,
    workerModel: "", workerProfile: "", workerProvider: "" });
  const connected = await app.handle(request("/api/v1/fleet/connect-codes", { method: "POST", headers: { cookie, origin,
    "content-type": "application/json" }, body: connectBody }), unused);
  assert.equal(connected.status, 201, await connected.clone().text());
  const install = await connected.json() as { installLine: string; expiresAt: string; release: typeof connectorRelease };
  assert.deepEqual(install.release, connectorRelease);
  assert.match(install.installLine, /connector-0\.3\.0\.mjs/u);
  assert.match(install.installLine, /connector-manifest\.json/u);
  assert.match(install.installLine, / install .*--bot cursor .*--name desktop-cursor-[a-f0-9]{12} .*--i-am-the-installer$/u);
  assert.doesNotMatch(install.installLine, /\sjoin\s/u);
  assert.match(install.installLine, / a{64} 1234 b{40}/u);
  const installUrl = install.installLine.match(/https:\/\/[^ ']+/u)?.[0] ?? "";
  assert.equal(installUrl.includes("crj_"), false, "the code is never placed in the connector URL");
  const unattended = await app.handle(request("/api/v1/fleet/connect-codes", { method: "POST", headers: { cookie, origin,
    "content-type": "application/json" }, body: JSON.stringify({ ...JSON.parse(connectBody), botKind: "codex",
      name: "overnight-codex", operatingSystem: "linux", unattended: true }) }), unused);
  assert.equal(unattended.status, 201, await unattended.clone().text());
  const unattendedInstall = await unattended.json() as { unattended: boolean; installLine: string; ownerNextStep: string };
  assert.equal(unattendedInstall.unattended, true);
  assert.match(unattendedInstall.installLine, /--unattended --i-am-the-installer$/u);
  assert.match(unattendedInstall.ownerNextStep, /per-user background worker[\s\S]*approved work[\s\S]*turn it off/iu);
  const unicodeName = JSON.stringify({ botKind: "mcp-agent", name: "<owner bot> Ω", operatingSystem: "linux",
    projectIds: [projectId], capabilities: ["writing"], unattended: false,
    workerModel: "", workerProfile: "", workerProvider: "" });
  const unicode = await app.handle(request("/api/v1/fleet/connect-codes", { method: "POST", headers: { cookie, origin,
    "content-type": "application/json" }, body: unicodeName }), unused);
  assert.equal(unicode.status, 201, "HTML and Unicode names are stored as text; the UI escapes them when rendering");
  const bad = await app.handle(request("/api/v1/fleet/connect-codes", { method: "POST", headers: { cookie, origin,
    "content-type": "application/json" }, body: JSON.stringify({ ...JSON.parse(connectBody), name: "line\nbreak", extra: true }) }), unused);
  assert.equal(bad.status, 400);
  const stoppedHalfway = await app.handle(request("/api/v1/fleet/connect-codes", { method: "POST", headers: { cookie, origin,
    "content-type": "application/json" }, body: "{" }), unused);
  assert.equal(stoppedHalfway.status, 400, "a request stopped halfway creates no partial success");
  const burst = await Promise.all(Array.from({ length: 50 }, (_, index) => app.handle(request("/api/v1/fleet/connect-codes", {
    method: "POST", headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ ...JSON.parse(connectBody), name: `burst-${index}` }) }), unused)));
  assert.ok(burst.every(response => response.status === 201), "50 parallel owner callers each receive one isolated code");
  assert.equal(new Set((await Promise.all(burst.map(response => response.json() as Promise<{ workerId: string }>)))
    .map(item => item.workerId)).size, 50, "parallel calls never share a worker binding");

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
    releaseTrust,
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
