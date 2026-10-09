import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createECDH } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import test from "node:test";
import { Client, Pool } from "pg";
import { withRealPostgres, requiresRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createMacLocalNodeHandler } from "../src/web/v1/private-node-handler";
import { createPostgresLocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { applyMacLocalFirstOwnerV1 } from "../scripts/mac-local/first-owner-vps.mjs";
import { bootstrapMacLocalOwnerV1 } from "../src/web/v1/mac-local-owner-bootstrap";
import type { MacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import type { DatabaseClient } from "../src/persistence/database";
import type { OwnerPushSubscriptionRecordV1 } from "../src/web-push/v1/types";

// Synthetic push-service inputs; no real provider-delivery claim. Expectations
// are the literal inputs, not a digest or a result manufactured by the store.
const TENANT = "tenant:subscribe-proof";
const WORKSPACE = "workspace:subscribe-proof";
const SUBJECT = "subscription-proof-owner";
const CODE = "subscription-proof-sign-in-code-0001";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/subscribe-proof";
const INPUT: OwnerPushSubscriptionRecordV1 = { id: "", tenantId: TENANT, endpoint: ENDPOINT,
  p256dh: "A".repeat(87), auth: "B".repeat(22), expiresAt: null };
const BASE = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59720);
const PORTS = Array.from({ length: 12 }, (_, index) => BASE + index);
const AT = new Date(Date.now() - 1_000).toISOString();

async function owner(admin: Client, tenantId = TENANT, workspaceId = WORKSPACE) {
  const manifest = createMacLocalFirstOwnerManifestV1({ workspaceId,
    localOwnerSession: { tenantId, provider: "local-owner", subject: SUBJECT },
    enablement: { nodeId: `node:${tenantId}`, workers: [
      { kind: "hermes", workerId: "worker:subscribe-h" },
      { kind: "claude-code", workerId: "worker:subscribe-c" },
      { kind: "codex", workerId: "worker:subscribe-x" }] }, workIntakeProjectIds: [] }, AT,
  CompletionGateStoreV1.genesisIntegrityForKeyV1(tenantId, new Uint8Array(32).fill(7)));
  await applyMacLocalFirstOwnerV1(admin, manifest);
  return manifest.identity.id as string;
}
async function secondOwner(admin: Client) {
  const query = admin.query.bind(admin) as unknown as DatabaseClient["query"];
  const database: DatabaseClient = { query, transaction: async work => {
    await admin.query("BEGIN");
    try { const value = await work({ query }); await admin.query("COMMIT"); return value; }
    catch (error) { await admin.query("ROLLBACK"); throw error; }
  }, transactionWithPreCommitCheck: async (work, check) => database.transaction(async tx => {
    const result = await work(tx); await check(); return result;
  }) };
  const config = { workspaceId: "workspace:subscribe-second", workIntakeProjectIds: [],
    localOwnerSession: { tenantId: "tenant:subscribe-second", provider: "local-owner", subject: SUBJECT } } as unknown as MacLocalProtectedConfigurationV1;
  assert.equal(await bootstrapMacLocalOwnerV1(database, config), "created");
}
function binding(pg: RealPostgres, max?: number) {
  const c = pg.connection("web");
  const config = { host: "127.0.0.1", port: c.port, database: c.database, username: c.user, password: c.password, majorVersion: 17 as const };
  const options = privatePgOptions(config);
  const pool = new Pool({ ...options, host: c.host, ...(max === undefined ? {} : { max }) });
  const db = bindPrivatePgPool(pool);
  return { db, pool, config, store: new PostgresOwnerPushStoreV1(db.client) };
}
async function fixture(index: number, body: (f: { pg: RealPostgres; admin: Client; live: ReturnType<typeof binding>; ownerId: string }) => Promise<void>) {
  assert.ok(requiresRealPostgres(), "CR-E075 requires real PostgreSQL 17; missing binaries are not a skip");
  const scratchRoot = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(scratchRoot, "subscribe-grant-"));
  const previousRoot = process.env.ATTACK_KIT_RUN_ROOT;
  process.env.ATTACK_KIT_RUN_ROOT = scratch;
  try {
  const result = await withRealPostgres(async pg => {
    const admin = new Client(pg.admin()); admin.on("error", () => {}); await admin.connect();
    let live: ReturnType<typeof binding> | undefined;
    try {
      live = binding(pg);
      const ownerId = await owner(admin);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM owner_web_push_subscriptions")).rows[0].n, 0);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM owner_web_push_deliveries")).rows[0].n, 0);
      const identity = (await live.db.client.query<{ current_user: string; session_user: string; version: number }>(
        "SELECT current_user,session_user,current_setting('server_version_num')::int AS version")).rows[0]!;
      assert.equal(identity.current_user, "control_room_web"); assert.equal(identity.session_user, "control_room_web");
      assert.ok(identity.version >= 170000 && identity.version < 180000);
      await body({ pg, admin, live, ownerId });
    } finally { await live?.db.close(); await admin.end(); }
  }, { port: BASE + index, allowedPorts: PORTS, boundMs: 180_000 });
  assert.equal(result.cleanedUp, true, "CR-E075 owned PostgreSQL cleanup completed");
  assert.deepEqual(result.leftovers, []);
  } finally {
    if (previousRoot === undefined) delete process.env.ATTACK_KIT_RUN_ROOT; else process.env.ATTACK_KIT_RUN_ROOT = previousRoot;
    await rm(scratch, { recursive: true, force: true });
  }
}
async function subscribe(live: ReturnType<typeof binding>, input = INPUT) {
  try { await live.store.subscribe(input); }
  catch (error) { assert.fail(`CR-E075 production-login subscribe must succeed: ${(error as { sqlState?: string }).sqlState ?? (error as { code?: string }).code ?? (error as Error).message}`); }
}
function fields(row: OwnerPushSubscriptionRecordV1) {
  return { tenantId: row.tenantId, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, expiresAt: row.expiresAt };
}
async function row(admin: Client) {
  return (await admin.query("SELECT id,created_at,p256dh,auth,expires_at FROM owner_web_push_subscriptions WHERE tenant_id=$1 AND endpoint=$2", [TENANT, ENDPOINT])).rows[0];
}
async function history(live: ReturnType<typeof binding>) {
  const saved = (await live.store.list(TENANT))[0]!;
  assert.equal(await live.store.reserve(TENANT, saved.id, "test:history", AT), "reserved");
  await live.store.delivered(TENANT, saved.id, "test:history", AT);
  return saved.id;
}
async function http(live: ReturnType<typeof binding>, run: (call: (path: string, body: unknown, cookie?: string, origin?: string, method?: string) => Promise<Response>, cookie: string) => Promise<void>, tenantId = TENANT, workspaceId = WORKSPACE) {
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId, provider: "local-owner", subject: SUBJECT,
    ownerCodeDigest: sha256Digest({ ownerCode: CODE }), sessionSeconds: 900 };
  const key = createECDH("prime256v1"); key.generateKeys();
  try {
  const app = createMacLocalWebProcessV1({ origin, workspaceId, localOwnerSession: profile,
    localOwnerSessionStore: createPostgresLocalOwnerSessionStoreV1(live.db.client, profile), database: live.db,
    ownerWebPush: { subject: "https://fixture.ts.net", publicKey: key.getPublicKey().toString("base64url"), privateKey: key.getPrivateKey().toString("base64url") } });
  const render = async () => new Response("unused");
  const transport = createMacLocalNodeHandler({ origin, application: app, handler: request => app.handle(request, render),
    assets: { count: 0, digest: "empty", respond: () => undefined } });
  server.on("request", (request, response) => { void transport.handle(request, response); });
  const call = (path: string, body: unknown, cookie = "", suppliedOrigin = origin, method = "POST") => fetch(`${origin}${path}`, {
    method, headers: { origin: suppliedOrigin, "content-type": "application/json", cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const signIn = await call("/api/v1/local-owner-session", { ownerCode: CODE });
    assert.equal(signIn.status, 201, "real sign-in creates the production session");
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    await signIn.arrayBuffer();
    await run(call, cookie);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const payload = (input = INPUT) => ({ endpoint: input.endpoint, expirationTime: input.expiresAt === null ? null : Date.parse(input.expiresAt),
  keys: { p256dh: input.p256dh, auth: input.auth } });

// Children receive credentials over stdin, remain attached and emit readiness
// only after authenticating. All50 READY lines precede the shared go signal.
const CHILD = `import {Client} from 'pg'; import {createInterface} from 'node:readline';
import {PostgresOwnerPushStoreV1} from './src/web-push/v1/postgres-store.ts';
const lines=createInterface({input:process.stdin}); const iterator=lines[Symbol.asyncIterator]();
const {options,input}=JSON.parse((await iterator.next()).value); const db=new Client(options); db.on('error',()=>{});
try { await db.connect(); console.log('READY'); if((await iterator.next()).value!=='GO') throw Error('missing barrier');
 await new PostgresOwnerPushStoreV1(db).subscribe(input); console.log('SAVED');
} finally {lines.close(); await db.end();}`;
function child(pg: RealPostgres, input: OwnerPushSubscriptionRecordV1, name: string, productionTimeouts = false) {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  process.stdout.on("data", chunk => { output += String(chunk); }); process.stderr.on("data", chunk => { errors += String(chunk); });
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: process.stdout });
    lines.on("line", line => { if (line === "READY") { lines.close(); resolve(); } });
    process.once("close", code => { if (!output.includes("READY")) reject(new Error(`child_not_ready:${code}:${errors}`)); });
  });
  const closed = new Promise<{ code: number | null; output: string; errors: string }>(resolve => process.once("close", code => resolve({ code, output, errors })));
  const connection = pg.connection("web", { applicationName: name });
  const options = productionTimeouts ? { ...privatePgOptions({ host: "127.0.0.1", port: connection.port,
    database: connection.database, username: connection.user, password: connection.password, majorVersion: 17 }),
    host: connection.host, application_name: name } : connection;
  process.stdin.write(JSON.stringify({ options, input }) + "\n");
  return { process, ready, closed };
}
async function stop(children: { process: ChildProcessWithoutNullStreams; closed: Promise<unknown> }[]) {
  for (const c of children) { c.process.stdin.end(); if (c.process.exitCode === null) c.process.kill("SIGTERM"); }
  await Promise.all(children.map(c => c.closed));
}
async function waitFor(admin: Client, sql: string, params: unknown[], expected: number) {
  const until = performance.now() + 10_000;
  for (;;) {
    if (Number((await admin.query(sql, params)).rows[0].n) >= expected) return;
    assert.ok(performance.now() < until, "CR-E075 expected server-observable lock wait before deadline");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const waits = "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name LIKE $1 AND wait_event_type='Lock'";
const counters = async (admin: Client) => (await admin.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks;

test("CR-E075 first-use", () => fixture(0, async ({ live, ownerId }) => {
  try { await subscribe(live); } catch (error) {
    assert.deepEqual(await live.store.list(TENANT), [], "refused first use leaves zero subscriptions"); throw error;
  }
  assert.deepEqual((await live.store.list(TENANT)).map(fields), [fields(INPUT)], "literal first subscription read-back");
  await verifyPrivateDatabase(live.db.client, live.config, { tenantId: TENANT, workspaceId: WORKSPACE, ownerIdentityId: ownerId, issuer: "local-owner" }, Date.now(), { nativeQueue: true });
  await http(live, async (call, cookie) => {
    const saved = await call("/api/v1/owner-web-push", payload(), cookie); assert.equal(saved.status, 204);
    const status = await call("/api/v1/owner-web-push/status", { endpoint: ENDPOINT }, cookie);
    assert.equal(status.status, 200); assert.deepEqual(await status.json(), { subscribed: true });
  });
}));
test("CR-E075 duplicate-endpoint", () => fixture(1, async ({ live, admin }) => {
  await subscribe(live); await history(live); const before = await row(admin);
  const renewed = { ...INPUT, p256dh: "C".repeat(87), auth: "D".repeat(22), expiresAt: "2099-01-01T00:00:00.000Z" };
  await subscribe(live, renewed);
  assert.deepEqual((await live.store.list(TENANT)).map(fields), [fields(renewed)]);
  const after = await row(admin); assert.equal(after.id, before.id); assert.deepEqual(after.created_at, before.created_at);
  assert.equal(await live.store.reserve(TENANT, before.id, "test:history", AT), "already_delivered");
}));
test("CR-E075 adjacent-endpoint", () => fixture(2, async ({ live }) => {
  const adjacent = { ...INPUT, endpoint: ENDPOINT + "x", p256dh: "E".repeat(87), auth: "F".repeat(22) };
  await subscribe(live); await subscribe(live, adjacent);
  assert.deepEqual((await live.store.list(TENANT)).map(fields).sort((a,b) => a.endpoint.localeCompare(b.endpoint)), [fields(INPUT), fields(adjacent)]);
}));
test("CR-E075 repeat and retry", () => fixture(3, async ({ live, admin }) => {
  await subscribe(live); const original = await row(admin); await subscribe(live);
  await assert.rejects(live.store.subscribe({ ...INPUT, p256dh: "CHANGED", auth: "!" }));
  assert.deepEqual((await live.store.list(TENANT)).map(fields), [fields(INPUT)], "refused write retains both original keys");
  await subscribe(live, { ...INPUT, expiresAt: "2099-01-01T00:00:00.000Z" });
  assert.equal((await row(admin)).id, original.id); assert.equal((await live.store.list(TENANT))[0]!.expiresAt, "2099-01-01T00:00:00.000Z");
}));
test("CR-E075 narrow authority", () => fixture(4, async ({ live, pg }) => {
  await subscribe(live);
  const web = new Client(pg.connection("web")); const other = new Client(pg.connection("coordinator"));
  await web.connect(); await other.connect();
  try {
    for (const column of ["id", "tenant_id", "endpoint", "created_at"])
      await assert.rejects(web.query(`UPDATE owner_web_push_subscriptions SET ${column}=${column} WHERE tenant_id=$1`, [TENANT]),
        { code: "42501" }, `forbidden ${column} UPDATE must be refused`);
    await assert.rejects(new PostgresOwnerPushStoreV1(other as never).subscribe(INPUT), { code: "42501" });
    const acl = (await web.query("SELECT has_table_privilege('owner_web_push_subscriptions','UPDATE') broad, has_column_privilege('owner_web_push_subscriptions',$1,'UPDATE') narrow", ["p256dh"])).rows[0];
    assert.deepEqual(acl, { broad: false, narrow: true });
    for (const column of ["p256dh", "auth", "expires_at", "updated_at"])
      assert.equal((await web.query("SELECT has_column_privilege('owner_web_push_subscriptions',$1,'UPDATE') ok", [column])).rows[0].ok, true);
    assert.equal((await web.query("SELECT owner_push_endpoint_allowed($1) ok", [ENDPOINT])).rows[0].ok, true);
  } finally { await web.end(); await other.end(); }
}));
test("CR-E075 real owner HTTP", () => fixture(5, async ({ live, admin }) => {
  await secondOwner(admin);
  await http(live, async (call, cookie) => {
    assert.equal((await call("/api/v1/owner-web-push", payload())).status, 401);
    assert.equal((await call("/api/v1/owner-web-push", payload(), cookie, "https://hostile.example.invalid")).status, 403);
    assert.equal((await call("/api/v1/owner-web-push", { ...payload(), tenantId: "tenant:subscribe-second" }, cookie)).status, 204);
    assert.deepEqual((await live.store.list(TENANT)).map(fields), [fields(INPUT)]);
    assert.deepEqual(await live.store.list("tenant:subscribe-second"), []);
    await subscribe(live, { ...INPUT, tenantId: "tenant:subscribe-second" });
    assert.equal((await call("/api/v1/owner-web-push", { endpoint: ENDPOINT }, cookie, undefined, "DELETE")).status, 204);
    assert.deepEqual(await live.store.list(TENANT), []);
    assert.deepEqual((await live.store.list("tenant:subscribe-second")).map(fields), [fields({ ...INPUT, tenantId: "tenant:subscribe-second" })]);
  });
}));
test("CR-E075 cross-process burst", () => fixture(6, async ({ live, admin, pg }) => {
  // Seeded first: racing 50 first inserts of one endpoint hits a separate store defect (CR-E075 B04, primary-key 23505) that is not part of this grant.
  await subscribe(live);
  const before = await counters(admin); const started = performance.now();
  const inputs = Array.from({ length: 50 }, (_, n) => ({ ...INPUT, p256dh: `Key_${n}`, auth: `Auth_${n}` }));
  const children = inputs.map((input,n) => child(pg, input, `subscribe-burst-${n}`));
  try {
    await Promise.all(children.map(c => c.ready));
    for (const c of children) c.process.stdin.write("GO\n");
    const results = await Promise.all(children.map(c => c.closed));
    assert.equal(results.filter(r => r.code === 0 && r.output.includes("SAVED")).length, 50, JSON.stringify(results.filter(r=>r.code!==0)));
    const saved = await live.store.list(TENANT); assert.equal(saved.length, 1);
    assert.ok(inputs.some(input => input.p256dh === saved[0]!.p256dh && input.auth === saved[0]!.auth), "final keys belong to one complete submitted pair");
    assert.equal(await counters(admin), before, "no server deadlocks");
    console.log(`CR-E075 burst:50 completed; milliseconds=${Math.round(performance.now()-started)}; deadlocks_delta=0`);
  } finally { await stop(children); }
}));
test("CR-E075 slow and dropped connection", () => fixture(7, async ({ live, admin, pg }) => {
  await subscribe(live); const id = await history(live); const before = await counters(admin);
  const slow = binding(pg); const lock = new Client(pg.admin()); await lock.connect();
  // Open all eight pooled sessions first so every waiter starts together and the held lock stays inside the production two-second lock_timeout (CR-E075 D09).
  await Promise.all(Array.from({ length: 8 }, () => slow.db.client.query("SELECT pg_sleep(0.2)")));
  await lock.query("BEGIN"); await lock.query("SELECT id FROM owner_web_push_subscriptions WHERE tenant_id=$1 FOR UPDATE", [TENANT]);
  const start = performance.now();
  const calls = Array.from({ length: 20 }, (_,n) => slow.store.subscribe({ ...INPUT, p256dh: `Slow_${n}`, auth: `SlowAuth_${n}` }));
  const settled = Promise.allSettled(calls);
  try {
    await waitFor(admin, waits, ["control-room-private-web"], 8);
    assert.equal(slow.pool.totalCount, 8, "production pool limit independently specified as eight");
    await lock.query("ROLLBACK");
    const results = await settled;
    // Independent policy literals: eight active plus eight queued, four refused.
    assert.equal(results.filter(x => x.status === "fulfilled").length, 16, JSON.stringify(results.map(x => x.status === "fulfilled" ? "ok" : `${x.reason.code}:${x.reason.sqlState}`)));
    const refused = results.filter(x => x.status === "rejected");
    assert.equal(refused.length, 4);
    for (const result of refused) if (result.status === "rejected") {
      assert.equal(result.reason.code, "database_unavailable");
      assert.equal(result.reason.sqlState, undefined, "admission refusal is not a SQL failure");
    }
    console.log(`CR-E075 slow:20 settled;16 completed;4 admission refusals; pool_limit=8; milliseconds=${Math.round(performance.now()-start)}`);
  } finally { await lock.query("ROLLBACK"); await settled; await slow.db.close(); await lock.end(); }
  const dropped = child(pg, { ...INPUT, p256dh: "Drop", auth: "DropAuth" }, "subscribe-drop");
  try {
    await dropped.ready; const lock2 = new Client(pg.admin()); await lock2.connect();
    try {
      await lock2.query("BEGIN"); await lock2.query("SELECT id FROM owner_web_push_subscriptions WHERE tenant_id=$1 FOR UPDATE", [TENANT]);
      dropped.process.stdin.write("GO\n"); await waitFor(admin, waits, ["subscribe-drop"], 1);
      assert.equal((await admin.query("SELECT pg_terminate_backend(pid) ok FROM pg_stat_activity WHERE application_name=$1", ["subscribe-drop"])).rows[0].ok, true);
      assert.notEqual((await dropped.closed).code, 0, "dropped connection reaches the failing caller");
      await lock2.query("ROLLBACK");
    } finally { await lock2.query("ROLLBACK"); await lock2.end(); }
    await subscribe(live); assert.equal((await row(admin)).id, id);
    assert.equal(await live.store.reserve(TENANT,id,"test:history",AT),"already_delivered"); assert.equal(await counters(admin),before);
  } finally { await stop([dropped]); }
}));
test("CR-E075 stop halfway", () => fixture(8, async ({ live, admin, pg }) => {
  await subscribe(live); const id = await history(live); const lock = new Client(pg.admin()); await lock.connect();
  const caller = child(pg, { ...INPUT, p256dh: "Next", auth: "NextAuth" }, "subscribe-stop", true);
  try {
    await caller.ready; await lock.query("BEGIN"); await lock.query("SELECT id FROM owner_web_push_subscriptions WHERE tenant_id=$1 FOR UPDATE", [TENANT]);
    caller.process.stdin.write("GO\n"); await waitFor(admin, waits, ["subscribe-stop"], 1);
    caller.process.kill("SIGTERM"); await caller.closed;
    // EOF alone cannot cancel an in-flight server statement. Keep the lock until
    // production lock_timeout aborts it and the owned backend observably exits.
    const deadline = performance.now() + 10_000;
    while ((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1", ["subscribe-stop"])).rows[0].n) {
      assert.ok(performance.now() < deadline, "interrupted production backend exits before lock release");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await lock.query("ROLLBACK");
    assert.deepEqual((await live.store.list(TENANT)).map(fields), [fields(INPUT)], "killed pending write leaves the old complete row");
    const next = { ...INPUT, p256dh: "Next", auth: "NextAuth" }; await subscribe(live,next); await subscribe(live,next);
    assert.deepEqual((await live.store.list(TENANT)).map(fields), [fields(next)]); assert.equal((await row(admin)).id,id);
    assert.equal(await live.store.reserve(TENANT,id,"test:history",AT),"already_delivered");
  } finally { await lock.query("ROLLBACK"); await lock.end(); await stop([caller]); }
}));
test("CR-E075 invalid and expiry", () => fixture(9, async ({ live }) => {
  await subscribe(live);
  for (const bad of [{ ...INPUT, p256dh: "" }, { ...INPUT, auth: null }, { ...INPUT, auth: undefined },
    { ...INPUT, p256dh: "!" }, { ...INPUT, endpoint: "https://off-list.example.invalid/push" }])
    await assert.rejects(live.store.subscribe(bad as unknown as OwnerPushSubscriptionRecordV1));
  assert.deepEqual((await live.store.list(TENANT)).map(fields), [fields(INPUT)]);
  await http(live, async (call,cookie) => {
    for (const bad of [null, {}, { ...payload(), keys: {} }, { ...payload(), keys: { p256dh: "!", auth: "B" } },
      { ...payload(), endpoint: "https://off-list.example.invalid" }, { ...payload(), keys: { p256dh: "A".repeat(5000), auth: "B" } }])
      assert.equal((await call("/api/v1/owner-web-push",bad,cookie)).status,400);
  });
  await subscribe(live,{ ...INPUT, expiresAt: "2000-01-01T00:00:00.000Z" }); assert.deepEqual(await live.store.list(TENANT),[]);
}));
