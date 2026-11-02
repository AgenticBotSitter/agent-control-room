import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule } from "typescript";
import * as controller from "../scripts/workflow-journeys/first-website-controller";
import { LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createPostgresLocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import { sha256Digest } from "../src/security";
import type { FirstWebsiteHostV1 } from "./helpers/improve-control-room-first-website";

const origin = "http://127.0.0.1:60460";
const signal = () => new AbortController().signal;
const host = { origin, proof: { withOwnerCode: async (use: (code: string) => unknown) => use("synthetic-owner-code-for-session-tests") } } as FirstWebsiteHostV1;
function fixture(options: { retryAfter?: string; failure?: boolean; deleteStatus?: number; alwaysLimited?: boolean } = {}) {
  let now = Date.parse("2026-01-01T00:00:00Z"), posts = 0, deletes = 0;
  const calls: { method: string; cookie: string | null; at: number }[] = [];
  const waits: number[] = [];
  const request = async (_url: unknown, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, cookie: new Headers(init.headers).get("cookie"), at: now });
    if (method === "POST") return Response.json({ expiresAt: new Date(now + 300_000).toISOString() },
      { status: 201, headers: { "set-cookie": `local-owner=fixture-${++posts}; HttpOnly; Max-Age=300` } });
    if (method === "DELETE") {
      deletes++;
      if (options.retryAfter && (deletes === 1 || options.alwaysLimited)) return Response.json({ error: "owner_attempt_limit" },
        { status: 429, headers: { "retry-after": options.retryAfter } });
      return new Response(null, { status: options.deleteStatus ?? 204 });
    }
    return Response.json({ ok: true }, { status: options.failure ? 500 : 200 });
  };
  const create = controller.createB5ControllerSessionV1;
  assert.equal(typeof create, "function", "controller must own a reusable bounded session");
  const session = create(host, { fetch: request, clock: () => now,
    wait: async (ms: number, abort: AbortSignal) => { abort.throwIfAborted(); waits.push(ms); now += ms; } });
  return { session, calls, waits, advance(ms: number) { now += ms; }, counts: () => ({ posts, deletes }) };
}

test("B5 controller session reuses one cookie for concurrent polling and revokes once at cleanup", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 24 }, () => f.session.exchange("/status", signal())));
  assert.deepEqual(f.counts(), { posts: 1, deletes: 0 });
  assert.equal(new Set(f.calls.filter(c => c.method === "GET").map(c => c.cookie)).size, 1);
  await Promise.all([f.session.close(), f.session.close()]);
  assert.deepEqual(f.counts(), { posts: 1, deletes: 1 });
  await assert.rejects(f.session.exchange("/status", signal()), /B5_CONTROLLER_SESSION_CLOSED/);
});

test("B5 controller session drains pending reads and revokes before a new restart lifecycle", async () => {
  const f = fixture();
  const read = f.session.exchange("/status", signal());
  const closing = f.session.close();
  await Promise.all([read, closing]);
  assert.deepEqual(f.calls.map(c => c.method), ["POST", "GET", "DELETE"]);
  const restarted = fixture(); await restarted.session.exchange("/status", signal()); await restarted.session.close();
  assert.deepEqual(restarted.counts(), { posts: 1, deletes: 1 });
});

for (const retryAfter of ["2", "Thu, 01 Jan 2026 00:00:03 GMT"]) test(`B5 controller cleanup respects Retry-After ${retryAfter}`, async () => {
  const f = fixture({ retryAfter }); await f.session.exchange("/status", signal()); await f.session.close();
  assert.deepEqual(f.counts(), { posts: 1, deletes: 2 });
  assert.deepEqual(f.waits, [retryAfter === "2" ? 2000 : 3000]);
});

test("B5 controller cleanup refuses a Retry-After beyond its bounded cleanup window", async () => {
  const f = fixture({ retryAfter: "60" }); await f.session.exchange("/status", signal());
  await assert.rejects(f.session.close(), /B5_CONTROLLER_SESSION_CLEANUP/);
  assert.deepEqual(f.counts(), { posts: 1, deletes: 1 }); assert.deepEqual(f.waits, []);
});

test("B5 controller cleanup retains failure for missing Retry-After and persistent rate limits", async () => {
  for (const options of [{ deleteStatus: 429 }, { deleteStatus: 500 }, { retryAfter: "bad-date" }, { retryAfter: "1", alwaysLimited: true }]) {
    const f = fixture(options); await f.session.exchange("/status", signal());
    await assert.rejects(f.session.close(), /B5_CONTROLLER_SESSION_CLEANUP/);
    assert.equal(f.counts().deletes, options.alwaysLimited ? 3 : 1);
  }
});

test("B5 controller does not issue a session for aborted work or an unused lifecycle", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort(new Error("synthetic-abort"));
  await assert.rejects(f.session.exchange("/status", abort.signal), /synthetic-abort/);
  await f.session.close(); assert.deepEqual(f.counts(), { posts: 0, deletes: 0 });
});

test("B5 controller refreshes an expiring session and keeps service failures visible", async () => {
  const f = fixture(); await f.session.exchange("/status", signal()); f.advance(299_000);
  await f.session.exchange("/status", signal()); await f.session.close();
  assert.deepEqual(f.counts(), { posts: 2, deletes: 2 });
  const failed = fixture({ failure: true });
  await assert.rejects(failed.session.exchange("/status", signal()), /B5_CONTROLLER_SERVICE/);
  await failed.session.close(); assert.deepEqual(failed.counts(), { posts: 1, deletes: 1 });
});

async function hostOptions(db: unknown) {
  const source = await readFile("scripts/workflow-journeys/first-website-host.ts", "utf8");
  const body = source.slice(source.indexOf('      ownerCode = randomBytes(32)'), source.indexOf('      const recoveryService ='));
  assert.ok(body.includes("createMacLocalWebProcessV1"));
  const javascript = transpileModule(body, { compilerOptions: { target: 99 } }).outputText;
  let options: Parameters<typeof createMacLocalWebProcessV1>[0] | undefined;
  const compose = new Function("context", `with(context) { ${javascript} }`);
  compose({ ownerCode: "", application: undefined, randomBytes: () => ({ toString: () => "synthetic-owner-code-for-session-tests" }),
    origin, scope: { tenantId: "tenant:b5", workspaceId: "workspace:b5" }, provider: "b5-local", ownerId: "identity:b5-owner",
    web: { client: db }, prepared: {}, LOCAL_OWNER_SESSION_PROFILE_V1, sha256Digest, loopBridge: undefined,
    createPostgresLocalOwnerSessionStoreV1, createMacLocalWebProcessV1: (value: Parameters<typeof createMacLocalWebProcessV1>[0]) => { options = value; } });
  assert.ok(options);
  return options;
}

test("B5 host composition durably registers a fresh session before any status read", async () => {
  const rows: unknown[][] = [];
  const db = { query: async (sql: string, values: unknown[]) => {
    if (sql.includes("SELECT id FROM control_identities")) return { rows: [{ id: "identity:b5-owner" }] };
    if (sql.includes("INSERT INTO control_web_sessions")) rows.push(values);
    return { rows: [] };
  } };
  const options = await hostOptions(db);
  const service = new LocalOwnerSessionServiceV1(options.localOwnerSession, options.localOwnerSessionStore);
  await service.issue(new Request(origin, { headers: { origin } }), "synthetic-owner-code-for-session-tests", Date.now());
  assert.equal(rows.length, 1, "freshly issued B5 session must already exist in the durable store");
  assert.match(String(rows[0][1]), /^sha256:/); assert.ok(!JSON.stringify(rows).includes("synthetic-owner-code-for-session-tests"));
});

test("B5 controller resource cleanup revokes before closing the serving host", async () => {
  const owner = controller.createFirstWebsiteControllerOwnerV1();
  const f = fixture(), events: string[] = [];
  try {
    await f.session.exchange("/status", signal());
    owner.registerResource(async () => { await f.session.close(); events.push("revoked"); });
    owner.registerCloseHost(async () => { assert.deepEqual(f.counts(), { posts: 1, deletes: 1 }); events.push("host-closed"); });
    const result = await owner.cleanup();
    assert.deepEqual(result.failures, []); assert.deepEqual(events, ["revoked", "host-closed"]);
  } finally { owner.dispose(); }
});

test("B5 controller restart revokes the old session before restarting serving", async () => {
  const source = await readFile("scripts/workflow-journeys/first-website-controller.ts", "utf8");
  const body = /const restart = async \(\) => \{([\s\S]*?)\n    \};/u.exec(source)?.[1];
  assert.ok(body);
  const javascript = transpileModule(body, { compilerOptions: { target: 99 } }).outputText;
  const f = fixture(); await f.session.exchange("/status", signal());
  const events: string[] = [];
  const restart = new Function("context", `with(context) { return (async () => { ${javascript} })(); }`);
  await restart({ watching: true, watcher: Promise.resolve(), workSignal: signal(), controllerSession: f.session,
    host: { proof: { restart: async () => { assert.deepEqual(f.counts(), { posts: 1, deletes: 1 }); events.push("restarted"); } } },
    createB5ControllerSessionV1: () => { events.push("new-session-owner"); return fixture().session; }, observe: () => Promise.resolve() });
  assert.deepEqual(events, ["restarted", "new-session-owner"]);
});

import { withRealPostgres } from "./support/attack-kit/real-postgres";
import { seedFirstWebsiteDatabaseV1 } from "../scripts/workflow-journeys/first-website-host";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { Pool } from "pg";

test("B5 host fresh session is durable under real web-role grants before any authenticated GET", {
  skip: process.env.CONTROL_ROOM_B5_ASSEMBLY_PG !== "1" ? "requires disposable PG17" : false, timeout: 600_000,
}, async () => {
  const result = await withRealPostgres(async pg => {
    await seedFirstWebsiteDatabaseV1(pg);
    const login = pg.connection("web");
    const web = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: pg.port, database: pg.database,
      username: login.user, password: login.password, majorVersion: 17 }), host: login.host }));
    const options = await hostOptions(web.client);
    const app = createMacLocalWebProcessV1({ ...options, database: web });
    try {
      const issued = await app.handle(new Request(origin + "/api/v1/local-owner-session", { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode: "synthetic-owner-code-for-session-tests" }) }), () => new Response("unexpected"));
      assert.equal(issued.status, 201);
      const rows = await web.client.query<{ token_digest: string }>("SELECT token_digest FROM control_web_sessions WHERE tenant_id=$1 AND revoked_at IS NULL", ["tenant:b5"]);
      assert.equal(rows.rows.length, 1, "issuance itself durably registers the fresh session");
      assert.match(rows.rows[0].token_digest, /^sha256:/);
      const revoked = await app.handle(new Request(origin + "/api/v1/local-owner-session", { method: "DELETE",
        headers: { origin, cookie: issued.headers.getSetCookie()[0].split(";", 1)[0] } }), () => new Response("unexpected"));
      assert.equal(revoked.status, 204);
      const after = await web.client.query("SELECT token_digest FROM control_web_sessions WHERE tenant_id=$1 AND revoked_at IS NULL", ["tenant:b5"]);
      assert.equal(after.rows.length, 0);
      console.log("RESULT: PASS B5 fresh session registered and revoked under real web-role grants before any GET");
    } finally { await app.close(); }
  }, { port: 60536, allowedPorts: [60536], pgBin: process.env.PG_BIN, boundMs: 600_000 });
  assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []);
});
