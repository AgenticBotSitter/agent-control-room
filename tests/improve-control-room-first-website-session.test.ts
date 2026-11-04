import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule } from "typescript";
import * as controller from "../scripts/workflow-journeys/first-website-controller";
import { LocalOwnerSessionServiceV1 } from "../src/web/v1/local-owner-session";
import type { FirstWebsiteHostV1 } from "./helpers/improve-control-room-first-website";
import { createB5HostSessionOptionsV1 } from "../scripts/workflow-journeys/first-website-host";
import type { DatabaseClient } from "../src/persistence/database";

const origin = "http://127.0.0.1:60460";
const signal = () => new AbortController().signal;
const host = { origin, proof: { withOwnerCode: async (use: (code: string) => unknown) => use("synthetic-owner-code-for-session-tests") } } as FirstWebsiteHostV1;
function fixture(options: { retryAfter?: string; failure?: boolean; deleteStatus?: number; alwaysLimited?: boolean; nowMs?: number; retryAfters?: string[] } = {}) {
  let now = options.nowMs ?? Date.parse("2026-01-01T00:00:00Z"), posts = 0, deletes = 0;
  const calls: { method: string; cookie: string | null; at: number }[] = [];
  const waits: number[] = [];
  const request = async (_url: unknown, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, cookie: new Headers(init.headers).get("cookie"), at: now });
    if (method === "POST") return Response.json({ expiresAt: new Date(now + 300_000).toISOString() },
      { status: 201, headers: { "set-cookie": `local-owner=fixture-${++posts}; HttpOnly; Max-Age=300` } });
    if (method === "DELETE") {
      deletes++;
      const retryAfter = options.retryAfters?.[deletes - 1]
        ?? ((deletes === 1 || options.alwaysLimited) ? options.retryAfter : undefined);
      if (retryAfter !== undefined) return Response.json({ error: "owner_attempt_limit" },
        { status: 429, headers: { "retry-after": retryAfter } });
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

async function cleanupBoundary(options: Parameters<typeof fixture>[0], expected: {
  refused: boolean; deletes: number; waits: number[];
}) {
  const f = fixture(options);
  await f.session.exchange("/status", signal());
  const closing = f.session.close();
  assert.strictEqual(f.session.close(), closing, "cleanup shares the original close promise");
  await assert.rejects(f.session.exchange("/status", signal()), /B5_CONTROLLER_SESSION_CLOSED/);
  if (expected.refused) {
    let failure: unknown;
    await assert.rejects(closing, error => {
      assert.match(String(error), /B5_CONTROLLER_SESSION_CLEANUP/, "deadline or attempt refusal");
      failure = error; return true;
    }, "cleanup must refuse the retry at its deadline or attempt boundary");
    assert.strictEqual(f.session.close(), closing, "failed cleanup reuses its close promise");
    await assert.rejects(f.session.close(), error => error === failure, "cleanup retains the same failure");
  } else {
    await closing;
    assert.strictEqual(f.session.close(), closing, "successful cleanup reuses its close promise");
    await f.session.close();
  }
  assert.deepEqual(f.counts(), { posts: 1, deletes: expected.deletes }, "cleanup has exact DELETE attempts and no new issuance");
  assert.ok(f.counts().deletes <= 3, "cleanup must never exceed three DELETE attempts");
  assert.deepEqual(f.waits, expected.waits, "cleanup waits use exact nonnegative bounded delays");
  assert.deepEqual(f.calls.map(c => c.method), ["POST", "GET", ...Array(expected.deletes).fill("DELETE")],
    "no request follows a cleanup refusal or reuses a completed lifecycle");
}

// HTTP-date serialisation truncates milliseconds. Keep the header on an exact
// second and offset the injected clock by +1/0/-1 ms to obtain 29999/30000/30001.
for (const [offset, delay] of [[1, 29999], [0, 30000], [-1, 30001]]) {
  test(`B5 session cleanup boundary HTTP-date delay ${delay}ms`, async () => {
    await cleanupBoundary({ nowMs: Date.parse("2026-01-01T00:00:00Z") + offset,
      retryAfter: "Thu, 01 Jan 2026 00:00:30 GMT" },
    { refused: delay >= 30000, deletes: delay < 30000 ? 2 : 1, waits: delay < 30000 ? [delay] : [] });
  });
}

for (const seconds of [29, 30, 31]) test(`B5 session cleanup boundary integer Retry-After ${seconds}s`, async () => {
  await cleanupBoundary({ retryAfter: String(seconds) },
    { refused: seconds >= 30, deletes: seconds < 30 ? 2 : 1, waits: seconds < 30 ? [seconds * 1000] : [] });
});

for (const retryAfter of ["0", "Wed, 31 Dec 2025 23:59:59 GMT"]) {
  test(`B5 session cleanup boundary zero-clamped delay ${retryAfter}`, async () => {
    await cleanupBoundary({ retryAfter }, { refused: false, deletes: 2, waits: [0] });
  });
}

for (const second of ["20", "21"]) test(`B5 session cleanup boundary second retry ${second}s meets or exceeds remaining budget`, async () => {
  await cleanupBoundary({ retryAfters: ["10", second] }, { refused: true, deletes: 2, waits: [10000] });
});

test("B5 session cleanup boundary persistent limits allow exactly three DELETE attempts", async () => {
  await cleanupBoundary({ retryAfter: "1", alwaysLimited: true }, { refused: true, deletes: 3, waits: [1000, 1000] });
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

test("B5 controller session renews after a three-day idle gap before reading", async () => {
  const f = fixture();
  await f.session.exchange("/status", signal());
  f.advance(3 * 24 * 3600_000);
  await Promise.all(Array.from({ length: 8 }, () => f.session.exchange("/status", signal())));
  assert.deepEqual(f.counts(), { posts: 2, deletes: 1 });
  assert.deepEqual(f.calls.slice(2, 5).map(c => c.method), ["DELETE", "POST", "GET"]);
  assert.ok(f.calls.slice(4).every(c => c.cookie === "local-owner=fixture-2"));
  await f.session.close(); assert.deepEqual(f.counts(), { posts: 2, deletes: 2 });
  console.log("RESULT: PASS B5 client session 72h idle renews once before concurrent reads; cleanup revokes; client-only fixture");
});

async function hostOptions(db: unknown, context: {
  scope: { tenantId: string; workspaceId: string }; provider: string; ownerId: string;
  prepared: { transport?: { origin: string } };
} = {
  scope: { tenantId: "tenant:b5", workspaceId: "workspace:b5" }, provider: "b5-local", ownerId: "identity:b5-owner", prepared: {},
}) {
  return { origin, workspaceId: context.scope.workspaceId,
    ...createB5HostSessionOptionsV1({ origin, tenantId: context.scope.tenantId,
      provider: context.provider, subject: context.ownerId, ownerCode: "synthetic-owner-code-for-session-tests",
      database: db as DatabaseClient, remoteOrigin: context.prepared.transport?.origin }) };
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

import { fixture as sessionDatabase, now as sessionNow, trust as sessionTrust } from "./helpers/web-foundation";

test("B5 composed controller renews across four days with durable expired-session and cleanup revocation", async t => {
  let now = sessionNow;
  const f = await sessionDatabase(() => now);
  t.after(() => f.db.close());
  const options = await hostOptions(f.client, { scope: { tenantId: "tenant:web", workspaceId: "workspace:web" },
    provider: sessionTrust.issuer, ownerId: "test-owner", prepared: { transport: { origin: "https://fixture.ts.net:60462" } } });
  assert.equal(options.localOwnerSession.sessionSeconds, 300, "use the host's real remote-run session profile");
  const app = createMacLocalWebProcessV1({ ...options, clock: () => now,
    database: { client: f.client, close: async () => {}, isAvailable: () => true } });
  t.after(() => app.close());
  const exchanges: { method: string; status: number; cookie: string }[] = [];
  const session = controller.createB5ControllerSessionV1(host, { clock: () => now,
    fetch: async (url, init) => {
      const request = new Request(String(url), init);
      const response = await app.handle(request, () => new Response("unexpected", { status: 500 }));
      exchanges.push({ method: request.method, status: response.status, cookie: request.headers.get("cookie") ?? "" });
      return response;
    } });
  t.after(() => session.close());
  const rows = () => f.client.query<{ token_digest: string; revoked_at: string | null }>(
    "SELECT token_digest,revoked_at FROM control_web_sessions ORDER BY issued_at");
  await session.exchange("/api/v1/projects", signal());
  assert.equal((await rows()).rows.length, 1);
  const oldCookie = exchanges[1]!.cookie;
  now += 4 * 24 * 3600_000;
  const expired = await app.handle(new Request(origin + "/api/v1/projects", { headers: { cookie: oldCookie } }), () => new Response("unexpected"));
  assert.equal(expired.status, 401, "expired cookies remain unauthorized after the idle gap");
  await Promise.all(Array.from({ length: 8 }, () => session.exchange("/api/v1/projects", signal())));
  assert.deepEqual(exchanges.slice(2, 5).map(e => [e.method, e.status]), [["DELETE", 204], ["POST", 201], ["GET", 200]]);
  assert.equal(exchanges.filter(e => e.method === "POST").length, 2, "serialized return polls issue only one fresh session");
  assert.notEqual(exchanges[4]!.cookie, oldCookie);
  assert.ok(exchanges.slice(4).every(e => e.cookie === exchanges[4]!.cookie && e.status === 200));
  const renewed = (await rows()).rows;
  assert.equal(renewed.length, 2);
  assert.ok(renewed[0]!.revoked_at, "expired session must be durably revoked before issuance");
  assert.equal(renewed[1]!.revoked_at, null);
  await session.close();
  assert.ok((await rows()).rows.every(row => row.revoked_at), "cleanup durably revokes every controller session");
  console.log("RESULT: PASS B5 composed host + SQL session store renew at 96h; expired GET=401 DELETE=204 POST=201 GET=200; cleanup revoked=2");
});

test("B5 expired-session revocation preserves durable failures and rejects unissued cookies", async () => {
  let now = sessionNow, failing = true, revokes = 0;
  const options = await hostOptions({ query() {} });
  const service = new LocalOwnerSessionServiceV1(options.localOwnerSession, {
    save: async () => {}, load: async () => { throw Error("SYNTHETIC unavailable store"); },
    revoke: async () => { revokes++; if (failing) throw Error("SYNTHETIC revocation failed"); },
  });
  const request = (cookie?: string) => new Request(origin, { headers: { origin, ...(cookie ? { cookie } : {}) } });
  const issued = await service.issue(request(), "synthetic-owner-code-for-session-tests", now);
  const cookie = issued.cookie.split(";", 1)[0]!;
  now += 4 * 24 * 3600_000;
  await assert.rejects(service.revoke(request(cookie), now), /SYNTHETIC revocation failed/);
  assert.throws(() => service.verify(request(cookie), now), /authentication_required/);
  failing = false; await service.revoke(request(cookie), now);
  assert.equal(revokes, 2, "failed durable revocation retains ownership for a later retry");
  await assert.rejects(service.revoke(request("control_room_local_owner=" + "a".repeat(43)), now), /authentication_required/);
  assert.equal(revokes, 2, "an unknown cookie cannot revoke an issued session");
});
