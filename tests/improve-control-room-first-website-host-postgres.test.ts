import assert from "node:assert/strict";
import test from "node:test";
import { databaseSqlStateV1 } from "../src/persistence/database";
import { Client, Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { withRealPostgres } from "./support/attack-kit/real-postgres";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { parseStoredProjectPresentationV1 } from "../src/config/v1/project-presentation";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createFirstWebsiteHostV1, seedFirstWebsiteDatabaseV1, withFirstWebsiteOwnerCodeV1, prepareFirstWebsiteAssemblyV1, firstWebsiteProjectPayloadV1 } from "../scripts/workflow-journeys/first-website-host";
import { B5_PORTS, firstWebsiteConfigSchemaV1, loadFirstWebsiteAssemblyV1 } from "./helpers/improve-control-room-first-website";

const origin = "http://127.0.0.1:60460";
const configFile = process.env.CONTROL_ROOM_B5_ASSEMBLY_CONFIG;
const requireReal = process.env.CONTROL_ROOM_B5_ASSEMBLY_REQUIRE_REAL === "1";
test("F03a native gate requires an explicit frozen configuration", () => {
  if (requireReal) assert.ok(configFile, "NOT RUN: CONTROL_ROOM_B5_ASSEMBLY_CONFIG must name a prepared frozen F03-0 packet");
});

test("F03a real PG roles, disposable seed and local sign-in prerequisites", {
  skip: process.env.CONTROL_ROOM_B5_ASSEMBLY_PG !== "1" ? "NOT RUN: set CONTROL_ROOM_B5_ASSEMBLY_PG=1 for real PG17" : false,
  timeout: 600_000,
}, async () => {
  const result = await withRealPostgres(async pg => {
    await seedFirstWebsiteDatabaseV1(pg);
    const login = pg.connection("web");
    const web = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: pg.port, database: pg.database,
      username: login.user, password: login.password, majorVersion: 17 }), host: login.host }));
    const admin = new Client(pg.admin()); await admin.connect();
    const code = "disposable-assembly-prerequisite-code";
    const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:b5", database: web,
      localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:b5", provider: "b5-local",
        subject: "identity:b5-owner", ownerCodeDigest: sha256Digest({ ownerCode: code }), sessionSeconds: 900 } });
    try {
      assert.equal((await web.client.query<{ role: string }>("SELECT current_user AS role")).rows[0]?.role, login.user);
      await assert.rejects(web.client.query("INSERT INTO tenants(id,display_name) VALUES('tenant:denied','Denied')"),
        (error: unknown) => databaseSqlStateV1(error) === "42501");
      assert.equal((await pg.query<{ role: string }>("coordinator", "SELECT current_user AS role")).rows[0]?.role, pg.connection("coordinator").user);
      const response = await app.handle(new Request(origin + "/api/v1/local-owner-session", { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode: code }) }), () => { throw new Error("unexpected renderer"); });
      assert.equal(response.status, 201);
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      const catalog = await app.handle(new Request(origin + "/api/v1/projects", { headers: { cookie } }), () => { throw new Error("unexpected renderer"); });
      assert.equal(catalog.status, 200);
      assert.match(await catalog.text(), /Disposable B5 website/);
      assert.equal((await admin.query("SELECT 1 FROM tenants WHERE id='tenant:denied'")).rowCount, 0);
      console.log("RESULT: PASS F03a real PG17 role/denied-write/local-session prerequisites (not assembly qualification)");
    } finally { await app.close(); await admin.end(); }
  }, { port: B5_PORTS.postgresBase, allowedPorts: [B5_PORTS.postgresBase], pgBin: process.env.PG_BIN, boundMs: 600_000 });
  assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []);
});

test("F03a real carrier, built loopback browser, cold restart and close", {
  skip: !configFile ? "NOT RUN: frozen F03-0 packet and strict B5 config not supplied" : false, timeout: 600_000,
}, async () => {
  const config = firstWebsiteConfigSchemaV1.parse(JSON.parse(await readFile(resolve(configFile!), "utf8")));
  const { chromium } = await import("@playwright/test");
  const abort = new AbortController();
  let host: Awaited<ReturnType<typeof createFirstWebsiteHostV1>> | undefined;
  const browser = await chromium.launch({ headless: true });
  let holdClose = false, closingEntered!: () => void, releaseClose!: () => void;
  let holdRead = false, readEntered!: () => void, releaseRead!: () => void;
  const readingEntered = new Promise<void>(yes => { readEntered = yes; });
  const readBarrier = new Promise<void>(yes => { releaseRead = yes; });
  const closing = new Promise<void>(yes => { closingEntered = yes; });
  const closeBarrier = new Promise<void>(yes => { releaseClose = yes; });
  try {
    const factory = await loadFirstWebsiteAssemblyV1(config) as typeof createFirstWebsiteHostV1;
    host = await factory(config, abort.signal, { async at(stage) {
      if (stage === "closing" && holdClose) { closingEntered(); await closeBarrier; }
      if (stage === "proof-read" && holdRead) { readEntered(); await readBarrier; }
    } });
    assert.equal(host.origin, origin); assert.equal(host.startup.isReady(), true);
    assert.equal(Object.isFrozen(host.a2Entry), true, "the exposed A2 entry cannot swap interpreter pins");
    assert.deepEqual(Object.keys(host.startup).sort(), ["close", "isReady"], "startup exports no pool, signing key or mutable adapter");
    const signIn = async () => {
      const context = await browser.newContext(); const page = await context.newPage();
      await page.goto(origin + "/session");
      await withFirstWebsiteOwnerCodeV1(host!, async code => {
        try {
          await page.getByLabel("Owner code").fill(code);
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
          await page.waitForURL(origin + "/projects");
        } catch { throw new Error("B5_BROWSER_SIGN_IN"); } // Do not export Playwright's fill(value) call log.
      });
      await page.goto(origin + "/projects");
      await page.getByText("Disposable B5 website", { exact: true }).waitFor();
      assert.equal(await page.locator('script[src*="/_next/static/"]').count() > 0, true);
      return { context, page };
    };
    const before = await host.proof.readSnapshot();
    const runsBefore = (await readdir(join(config.scratchRoot, "runs"))).sort();
    const refused = await fetch(origin + `/api/v1/projects/${encodeURIComponent(host.proof.project.projectId)}/improvements/loop/intake`, {
      method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": "b5-unauthorized-post-0001" }, body: JSON.stringify({ description: config.requestText }) });
    assert.ok([401, 403].includes(refused.status));
    assert.deepEqual((await host.proof.readSnapshot()).rows, before.rows, "unauthorized POST has no partial rows");
    assert.deepEqual((await readdir(join(config.scratchRoot, "runs"))).sort(), runsBefore, "unauthorized POST creates no engine run");
    const first = await signIn();
    const candidateList = await first.context.request.get(origin + "/api/v1/loop-update-candidates");
    assert.equal(candidateList.status(), 200, "the same real app must own candidate reads through the built registry");
    const oldCookies = await first.context.cookies();
    const previous = host.startup;
    await first.context.close();
    await host.proof.restart(abort.signal);
    assert.notEqual(host.startup, previous); assert.equal(previous.isReady(), false);
    const coldContext = await browser.newContext(); await coldContext.addCookies(oldCookies);
    assert.equal((await coldContext.request.get(origin + "/api/v1/loop-update-candidates")).status(), 401, "restart requires ordinary fresh sign-in");
    await coldContext.close();
    const second = await signIn(); await second.context.close(); await browser.close();
    holdRead = true;
    const reading = host.proof.readSnapshot(); await readingEntered;
    holdClose = true;
    const close = host.close(); await closing;
    assert.equal(host.close(), close, "concurrent close at the acquired-resource barrier shares one promise");
    releaseClose(); let closed = false; void close.then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false, "close must await the owned proof-read barrier");
    releaseRead(); await assert.rejects(reading, /B5_HOST_CLOSED/u); await close;
    const owned = await host.proof.inspectOwned();
    assert.deepEqual(owned, { processCount: 0, listenerReleased: true, postgresStopped: true, runScratchAbsent: true, protectedListenersUntouched: true });
    console.log("RESULT: PASS F03a loopback browser/restart/close (assembly evidence only; no device qualification)");
  } finally { releaseClose(); releaseRead(); if (browser.isConnected()) await browser.close(); await host?.close(); }
});


test("F03a host refuses pre-aborted acquisition before inspecting configuration", async () => {
  await assert.rejects(createFirstWebsiteHostV1({} as never, AbortSignal.abort()), /abort/iu);
});

test("F03a preparation refuses an unconfined root before effects", async () => {
  await assert.rejects(prepareFirstWebsiteAssemblyV1("relative-root"), /B5_HOST_PATH/u);
});

for (const stage of ["pool-open", "listener-bind", "ready"] as const) {
  test(`F03a native abort during ${stage} owns late resolution`, {
    skip: !configFile ? "NOT RUN: frozen configuration required for real acquisition abort" : false, timeout: 600_000,
  }, async () => {
    const config = firstWebsiteConfigSchemaV1.parse(JSON.parse(await readFile(resolve(configFile!), "utf8")));
    const abort = new AbortController(); let reached = false;
    const factory = await loadFirstWebsiteAssemblyV1(config) as typeof createFirstWebsiteHostV1;
    await assert.rejects(factory(config, abort.signal, { async at(value) {
      if (value === stage) { reached = true; abort.abort(); }
    } }), /abort/iu);
    assert.equal(reached, true, "the real acquisition barrier must execute");
    console.log(`RESULT: PASS F03a native abort ${stage}`);
  });
}


test("F03a seeded catalog presentation passes the real stored-presentation decoder", () => {
  const presentation = parseStoredProjectPresentationV1(firstWebsiteProjectPayloadV1());
  assert.equal(presentation?.templateId, "control-room");
  assert.equal(presentation?.templateDisplayName, "Control Room");
  assert.deepEqual(presentation?.enabledModules, []);
});
