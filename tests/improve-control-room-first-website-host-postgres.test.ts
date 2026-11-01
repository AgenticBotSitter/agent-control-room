import assert from "node:assert/strict";
import test from "node:test";
import { createHook } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { transpileModule } from "typescript";
import { assertGuardBites } from "./support/attack-kit/index";
import { databaseSqlStateV1 } from "../src/persistence/database";
import { Client, Pool } from "pg";
import { readFile, readdir, mkdir, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { withRealPostgres } from "./support/attack-kit/real-postgres";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { parseStoredProjectPresentationV1 } from "../src/config/v1/project-presentation";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createFirstWebsiteHostV1, seedFirstWebsiteDatabaseV1, withFirstWebsiteOwnerCodeV1, prepareFirstWebsiteAssemblyV1, firstWebsiteProjectPayloadV1, validateFirstWebsiteHostV1 } from "../scripts/workflow-journeys/first-website-host";
import { B5_PORTS, B5_SNAPSHOT_TABLES, b5Bytes, firstWebsiteConfigSchemaV1, loadFirstWebsiteAssemblyV1 } from "./helpers/improve-control-room-first-website";

const origin = "http://127.0.0.1:60460";
const configFile = process.env.CONTROL_ROOM_B5_CONFIG;
const requireReal = process.env.CONTROL_ROOM_B5_HOST_REQUIRE_A2 === "1";
async function resolveQualification(file?: string) {
  const input = file ? firstWebsiteConfigSchemaV1.parse(JSON.parse(await readFile(resolve(file), "utf8"))) : undefined;
  return validateFirstWebsiteHostV1(input);
}

test("B5 host-postgres missing qualification refuses before acquisition", async () => {
  let acquisitions = 0;
  const resources: string[] = [];
  const hook = createHook({ init(_id, type) {
    if (["PROCESSWRAP", "TCPSERVERWRAP", "TCPWRAP"].includes(type)) resources.push(type);
  } });
  hook.enable();
  try {
    await assert.rejects(resolveQualification().then(() => { acquisitions++; }),
      { code: "B5_A2_QUALIFICATION_REQUIRED" }, "B5 host-postgres qualification guard refuses missing packet");
  } finally { hook.disable(); }
  assert.equal(acquisitions, 0);
  assert.deepEqual(resources, [], "missing qualification creates no child, PG connection or listener");
});

test("F03a ownership inspection reports only observed cleanup facts", async () => {
  // Execute the actual inspection method with bounded local observations: a
  // closed listener/PG and empty work directory. No protected port is probed.
  const source = await readFile("scripts/workflow-journeys/first-website-host.ts", "utf8");
  const body = /async inspectOwned\(\) \{([\s\S]*?)\n          \},/u.exec(source)?.[1];
  assert.ok(body, "the host inspection method is present");
  const inspect = new Function("context", `with (context) { return (async () => {${body}})(); }`);
  const result = await inspect({ pgRef: undefined, pgClean: true, root: "/owned", join,
    readdir: async () => [], descendantPids: async () => new Set(), baselinePids: new Set(),
    closing: Promise.resolve(), bodyDone: true, cleanupFailed: false, listenerReleased: async () => true });
  assert.deepEqual(result, { processCount: 0, listenerReleased: true, postgresStopped: true, runScratchAbsent: true },
    "ownership inspection must not claim protected-listener observation from reserved constants");
});

test("B5 host-postgres qualification guard-off mutation fails the ordinary refusal assertion", { timeout: 120_000 }, async () => {
  const exec = promisify(execFile), root = resolve(".");
  await mkdir(join(root, ".test-tmp"), { recursive: true });
  const copy = await mkdtemp(join(root, ".test-tmp/b5-host-gate-"));
  const file = "scripts/workflow-journeys/first-website-host.ts";
  const lane = "tests/improve-control-room-first-website-host-postgres.test.ts";
  try {
    await exec("git", ["-c", "core.hooksPath=/dev/null", "clone", "--local", "--no-hardlinks", "--quiet", root, copy], { timeout: 60_000 });
    await symlink(join(root, "node_modules"), join(copy, "node_modules"), "dir");
    // Test the current working bytes, including before the fix is committed.
    for (const path of [file, lane, "scripts/workflow-journeys/first-website-device.ts", "tests/helpers/improve-control-room-first-website.ts"]) await writeFile(join(copy, path), await readFile(join(root, path)));
    const cmd = [process.execPath, "scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test",
      "--test-name-pattern=^B5 host-postgres missing qualification refuses before acquisition$", lane];
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const green = () => exec(cmd[0]!, cmd.slice(1), { cwd: copy, env, timeout: 40_000, maxBuffer: 1 << 20 });
    assert.match((await green()).stdout, /# pass 1/u);
    const original = await readFile(join(copy, file), "utf8");
    const result = await assertGuardBites({ root: copy, file, allowDirtyTree: true,
      find: '  need(input, "B5_A2_QUALIFICATION_REQUIRED");', replace: "", testCmd: cmd, boundMs: 40_000,
      because: "B5 host-postgres qualification guard refuses missing packet" });
    assert.equal(result.applied, true); assert.equal(result.exitCode, 1); assert.equal(result.signal, null);
    assert.match(result.output, /B5 host-postgres qualification guard refuses missing packet/u);
    assert.match(result.output, /ERR_ASSERTION/u); assert.match(result.output, /# fail 1/u);
    assert.doesNotMatch(result.output, /SyntaxError|# skipped [1-9]|# tests 0|timed out/iu);
    assert.equal(await readFile(join(copy, file), "utf8"), original);
    assert.match((await green()).stdout, /# pass 1/u);
    console.log("RESULT: PASS B5 host-postgres qualification mutation baseline=green guard-off=intended-assertion restored=green");
  } finally { await rm(copy, { recursive: true, force: true }); }
});

test("B5 host-postgres frozen native gate cannot skip to green", { timeout: 60_000 }, async () => {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/b5-host-packet-"));
  try {
    const invalid = join(root, "invalid.json"); await writeFile(invalid, "{}");
    for (const file of [undefined, invalid]) {
      const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ROOM_B5_HOST_REQUIRE_A2: "1" };
      delete env.NODE_TEST_CONTEXT; delete env.CONTROL_ROOM_B5_CONFIG;
      if (file) env.CONTROL_ROOM_B5_CONFIG = file;
      const result = await promisify(execFile)(process.execPath, ["scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test",
        "--test-name-pattern=^B5 real Mac-local assembly and owned restart/close$",
        "tests/improve-control-room-first-website-host-postgres.test.ts"], { env, timeout: 25_000, maxBuffer: 1 << 20 })
        .then(() => assert.fail("frozen native gate must refuse the missing/invalid packet"),
          (error: Error & { code: number; stdout: string }) => error);
      assert.equal(result.code, 1);
      assert.match(result.stdout, /# fail 1/u); assert.match(result.stdout, /# skipped 0/u);
      assert.match(result.stdout, file ? /"message": "Invalid input: expected 1"/u : /B5_A2_QUALIFICATION_REQUIRED/u);
      assert.doesNotMatch(result.stdout, /RESULT: PASS/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("F04a snapshot queries schema-derived identifiers, command evidence and candidate digests", async () => {
  const source = await readFile("scripts/workflow-journeys/first-website-host.ts", "utf8");
  const body = /readSnapshot\(\) \{ return ownedRead\(async \(\) => \{([\s\S]*?)\n          \}\); \},/u.exec(source)?.[1];
  assert.ok(body);
  const javascript = transpileModule(`async function read() {${body}}`, {}).outputText;
  // Migrations are the independent oracle: do not pin SQL copied from the host.
  const migrations = (await Promise.all([
    "0301_control_loop_improvement_lineage.sql",
    "0302_control_loop_improvement_commands.sql",
    "0303_control_loop_update_candidates.sql",
  ].map(file => readFile(join("db/migrations", file), "utf8")))).join("\n");
  const queriedTables: string[] = [];
  let transactions = 0;
  const active = { web: { client: { transaction: async (use: (tx: unknown) => Promise<unknown>) => use({
    query: async (sql: string, values?: string[]) => {
      if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        transactions++;
        return { rows: [] };
      }
      const select = /^SELECT ([a-z_,]+) FROM ([a-z_]+) WHERE tenant_id=\$1$/u.exec(sql);
      assert.ok(select, "snapshot uses an explicit tenant-scoped projection");
      const [, columns, table] = select;
      assert.deepEqual(values, ["tenant:b5"]);
      const definition = new RegExp(String.raw`CREATE TABLE ${table} \(([\s\S]*?)\n\);`, "u").exec(migrations)?.[1];
      assert.ok(definition, `${table} has a CREATE TABLE migration`);
      const schemaColumns = new Set([...definition.matchAll(/^  ([a-z_]+) (?:text|bigint|jsonb|timestamptz)\b/gmu)]
        .map(match => match[1]));
      const primaryKey = /PRIMARY KEY \(([^)]+)\)/u.exec(definition)?.[1].split(",");
      assert.ok(primaryKey, `${table} has a primary key in its migration`);
      const selected = columns!.split(",");
      for (const column of selected) {
        assert.ok(schemaColumns.has(column), `${table}.${column} must exist in its CREATE TABLE migration`);
        assert.ok(primaryKey.includes(column) || (table === "control_loop_update_candidates"
          && ["request_id", "run_link_id", "candidate_revision", "record_digest"].includes(column))
          || table === "control_loop_improvement_commands" && ["request_id", "operation", "binding", "result", "created_at"].includes(column),
          `${table}.${column} must be a key or candidate proof identifier/digest`);
      }
      for (const key of primaryKey.filter(column => column !== "tenant_id")) {
        assert.ok(selected.includes(key), `${table} projection must preserve primary key ${key}`);
      }
      if (table === "control_loop_improvement_commands") for (const field of ["request_id", "operation", "binding", "result", "created_at"])
        assert.ok(selected.includes(field), `F04a actual owner command evidence must include ${field}`);
      queriedTables.push(table!);
      // Real journal shape: claim/result share command_id but are distinct rows.
      const rows = table === "control_loop_improvement_commands"
        ? ["claim", "result"].map(entry_kind => Object.fromEntries(selected.map(column =>
          [column, ({ command_id: "loop-command:" + "a".repeat(32), entry_kind } as Record<string, string>)[column]]))) : [];
      return { rows };
    },
  }) } } };
  const inspect = new Function("context", `with (context) { ${javascript}; return read(); }`);
  const snapshot = await inspect({ current: active, closing: undefined, hooks: {}, scope: { tenantId: "tenant:b5" },
    B5_SNAPSHOT_TABLES, b5Bytes, need: assert.ok });
  assert.equal(transactions, 1);
  assert.deepEqual(queriedTables, [...B5_SNAPSHOT_TABLES], "every snapshot table is checked against its migration");
  assert.equal(snapshot.rows.length, 2);
  assert.deepEqual(snapshot.rows.map((item: { row: Record<string, unknown> }) => item.row.entry_kind), ["claim", "result"]);
  assert.notEqual(snapshot.rows[0].sha256, snapshot.rows[1].sha256, "claim and result retain distinct snapshot hashes");
});

test("F03a real PG roles, disposable seed and local sign-in prerequisites", {
  skip: !requireReal && process.env.CONTROL_ROOM_B5_ASSEMBLY_PG !== "1" ? "NOT RUN: set CONTROL_ROOM_B5_ASSEMBLY_PG=1 for real PG17" : false,
  timeout: 600_000,
}, async () => {
  if (requireReal) await resolveQualification(configFile);
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

test("B5 real Mac-local assembly and owned restart/close", {
  skip: !configFile && !requireReal ? "NOT RUN: frozen F03-0 packet and strict B5 config not supplied" : false, timeout: 600_000,
}, async () => {
  const { config } = await resolveQualification(configFile);
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
    assert.deepEqual(owned, { processCount: 0, listenerReleased: true, postgresStopped: true, runScratchAbsent: true });
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
    skip: !configFile && !requireReal ? "NOT RUN: frozen configuration required for real acquisition abort" : false, timeout: 600_000,
  }, async () => {
    const { config } = await resolveQualification(configFile);
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
