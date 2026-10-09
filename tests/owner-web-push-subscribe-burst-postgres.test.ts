// CR-E076 red reproducer (NOT wired into any CI lane on purpose).
// Mechanism (CR-E076 B04): PostgresOwnerPushStoreV1.subscribe arbitrates its INSERT on
// (tenant_id, endpoint), but the id primary key (a hash of the endpoint) is checked first in
// speculative insertion, so concurrent callers of one endpoint can get a raw 23505 on
// owner_web_push_subscriptions_pkey. It reproduces with the admin role on main, so it is not a grant fault.
// Both bodies are expected to FAIL until CR-E076 fixes the store; run by hand:
//   node --import tsx --test --test-concurrency=1 tests/owner-web-push-subscribe-burst-postgres.test.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import test from "node:test";
import { Client, Pool } from "pg";
import { withRealPostgres, requiresRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { applyMacLocalFirstOwnerV1 } from "../scripts/mac-local/first-owner-vps.mjs";
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
function binding(pg: RealPostgres, max?: number) {
  const c = pg.connection("web");
  const config = { host: "127.0.0.1", port: c.port, database: c.database, username: c.user, password: c.password, majorVersion: 17 as const };
  const options = privatePgOptions(config);
  const pool = new Pool({ ...options, host: c.host, ...(max === undefined ? {} : { max }) });
  const db = bindPrivatePgPool(pool);
  return { db, pool, config, store: new PostgresOwnerPushStoreV1(db.client) };
}
async function fixture(index: number, body: (f: { pg: RealPostgres; admin: Client; live: ReturnType<typeof binding>; ownerId: string }) => Promise<void>) {
  assert.ok(requiresRealPostgres(), "CR-E076 requires real PostgreSQL 17; missing binaries are not a skip");
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
  assert.equal(result.cleanedUp, true, "CR-E076 owned PostgreSQL cleanup completed");
  assert.deepEqual(result.leftovers, []);
  } finally {
    if (previousRoot === undefined) delete process.env.ATTACK_KIT_RUN_ROOT; else process.env.ATTACK_KIT_RUN_ROOT = previousRoot;
    await rm(scratch, { recursive: true, force: true });
  }
}
async function subscribe(live: ReturnType<typeof binding>, input = INPUT) {
  try { await live.store.subscribe(input); }
  catch (error) { assert.fail(`CR-E076 production-login subscribe must succeed: ${(error as { sqlState?: string }).sqlState ?? (error as { code?: string }).code ?? (error as Error).message}`); }
}
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
const counters = async (admin: Client) => (await admin.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks;
test("CR-E076 cross-process burst (seeded first)", () => fixture(6, async ({ live, admin, pg }) => {
  // Seeded first: racing 50 first inserts of one endpoint hits a separate store defect (CR-E076, from CR-E075 B04, primary-key 23505).
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
    console.log(`CR-E076 burst:50 completed; milliseconds=${Math.round(performance.now()-started)}; deadlocks_delta=0`);
  } finally { await stop(children); }
}));
test("CR-E076 cross-process burst (first insert)", () => fixture(7, async ({ live, admin, pg }) => {
  const before = await counters(admin);
  const inputs = Array.from({ length: 50 }, (_, n) => ({ ...INPUT, p256dh: `Key_${n}`, auth: `Auth_${n}` }));
  const children = inputs.map((input,n) => child(pg, input, `subscribe-first-${n}`));
  try {
    await Promise.all(children.map(c => c.ready));
    for (const c of children) c.process.stdin.write("GO\n");
    const results = await Promise.all(children.map(c => c.closed));
    assert.equal(results.filter(r => r.code === 0 && r.output.includes("SAVED")).length, 50, JSON.stringify(results.filter(r=>r.code!==0)));
    assert.equal((await live.store.list(TENANT)).length, 1);
    assert.equal(await counters(admin), before, "no server deadlocks");
  } finally { await stop(children); }
}));
