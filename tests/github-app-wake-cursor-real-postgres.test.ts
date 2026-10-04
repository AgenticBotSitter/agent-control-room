// R5I-07, on real PostgreSQL as the production broker login.
//
// The concern: `control_github_worker_wake_hints.hint_id` is
// GENERATED ALWAYS AS IDENTITY and the reader walks it as a cursor. A sequence
// value becomes visible only at COMMIT, so two transactions can allocate
// identities in one order and commit in the other. A reader that advances past
// the higher identity then never sees the lower one again.
//
// The fix, and the ONLY mechanism for it, is the append advisory lock. It
// serialises allocation with commit, so identity order IS commit order and the
// inversion cannot happen at all. An earlier revision of this file also carried
// a backward-looking re-scan window as a second defence; it was removed because
// it re-delivered every already-delivered hint in the window on EVERY poll —
// 256 rows per idle poll, forever. "An idle poll returns nothing" is therefore a
// first-class assertion here, not an absence of coverage.
//
// Everything runs against a real cluster, as the real control_room_github_broker
// login with exactly the production grants. Nothing here uses a simulated
// database, a superuser connection, or an injected fake for the store under test.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client, type ClientConfig } from "pg";

import { PostgresGitHubWorkerWakeStore, type GitHubWorkerWakeHint } from "../src/github-app/v1";
import type { DatabaseClient, DatabaseSession, QueryResult } from "../src/persistence/database";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_BINS = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"]
  .filter((dir): dir is string => typeof dir === "string");
const BIN = CANDIDATE_BINS.find((dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
// This stream's assigned PostgreSQL port range.
const PORT = Number(process.env.CONTROL_ROOM_R5IFIX_PG_PORT ?? 59850);
const DATABASE = "r5i07_wake_cursor";

let runDirectory = "";
let socket = "";
let data = "";
let teardown: ReturnType<typeof createClusterTeardown> | null = null;

const passwords = { CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24), CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24) };
const BROKER_PASSWORD = "b".repeat(28);

const target = (database: string, user: string, password?: string): ClientConfig =>
  ({ host: socket, port: PORT, database, user, password });
const native = (name: string, args: readonly string[]) => exec(join(BIN, name), [...args],
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: runDirectory || tmpdir(), NODE_ENV: "test" },
    timeout: 60_000, maxBuffer: 1 << 26 });

const open = async (tgt: ClientConfig): Promise<Client> => {
  const client = new Client(tgt);
  await client.connect();
  return client;
};
const asAdmin = async (sql: string, params: readonly unknown[] = []) => {
  const client = await open(target(DATABASE, "fixture_admin"));
  try { return await client.query(sql, params as unknown[]); } finally { await client.end(); }
};
const asBroker = async (sql: string, params: readonly unknown[] = []) => {
  const client = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
  try { return await client.query(sql, params as unknown[]); } finally { await client.end(); }
};

/** A real DatabaseClient over one real pg connection: BEGIN/COMMIT, no fake. */
const clientFor = (conn: Client): DatabaseClient => ({
  query: async <T = Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    const result = await conn.query(statement, params);
    return { rows: result.rows as T[] };
  },
  transaction: async <T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> => {
    await conn.query("BEGIN");
    try {
      const value = await callback(clientFor(conn));
      await conn.query("COMMIT");
      return value;
    } catch (cause) {
      await conn.query("ROLLBACK").catch(() => {});
      throw cause;
    }
  },
  transactionWithPreCommitCheck: async <T>(
    callback: (session: DatabaseSession) => Promise<T>, preCommitCheck: () => void | Promise<void>): Promise<T> => {
    await conn.query("BEGIN");
    try {
      const value = await callback(clientFor(conn));
      await preCommitCheck();
      await conn.query("COMMIT");
      return value;
    } catch (cause) {
      await conn.query("ROLLBACK").catch(() => {});
      throw cause;
    }
  },
});

const hint = (deliveryId: string, observedAt = "2026-09-16T03:00:00.000Z"): GitHubWorkerWakeHint => Object.freeze({
  sequence: deliveryId, source: "github-app-webhook", repository: "example/project",
  event: "issue_comment", action: "created", issueOrPullNumber: 255, observedAt,
});

before(async () => {
  if (!PG_AVAILABLE) return;
  const directory = await mkdtemp(join(tmpdir(), "cr-r5i07-"));
  socket = join(directory, "socket");
  data = join(directory, "data");
  runDirectory = directory;
  await mkdir(socket, { mode: 0o700, recursive: true });
  // Registered BEFORE initdb so an interrupt between launch and settle still finds
  // the cluster it has to stop.
  teardown = createClusterTeardown({ dataDirectory: data, runDirectory: directory,
    socketDirectory: socket, port: PORT, pgBin: BIN });
  await native("initdb", ["-D", data, "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject",
    "--no-locale", "--encoding=UTF8"]);
  await native("pg_ctl", ["-D", data, "-l", join(directory, "server.log"), "-w", "-t", "30", "-o",
    `-k ${socket} -p ${PORT} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`,
    "start"]);
  await teardown?.capturePostmasterPid();

  const bootstrap = await open(target("postgres", "fixture_admin"));
  try { await bootstrap.query(`CREATE DATABASE "${DATABASE}" OWNER fixture_admin`); } finally { await bootstrap.end(); }

  await applyMigrations({ target: target(DATABASE, "fixture_admin"), bootstrapTarget: target(DATABASE, "fixture_admin"),
    migrateTarget: target(DATABASE, "control_room_migrator", passwords.CONTROL_ROOM_MIGRATOR_PASSWORD),
    rootDir: ROOT, ledgerPath: join(ROOT, "deploy/postgres/migration-ledger.json"),
    env: { ...process.env, ...passwords } });

  // The exact production role SQL, then a login that inherits ONLY the broker role.
  await asAdmin(await readFile(join(ROOT, "db/roles/production_roles.sql"), "utf8"));
  await asAdmin(await readFile(join(ROOT, "db/roles/production_table_grants.sql"), "utf8"));
  await asAdmin(`CREATE ROLE r5i07_broker WITH LOGIN PASSWORD '${BROKER_PASSWORD}' IN ROLE control_room_github_broker`);
});

after(async () => {
  if (!PG_AVAILABLE || !data) return;
  await teardown?.stop();
});

const needsPg = () => (PG_AVAILABLE ? false : "needs PostgreSQL 17 binaries (PG_BIN or /opt/homebrew/opt/postgresql@17/bin)");

test("the wake cursor test runs as the non-superuser production broker login",
  { skip: needsPg() }, async () => {
    const identity = await asBroker(`SELECT current_user,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
      pg_has_role(current_user,'control_room_github_broker','member') AS is_broker`);
    assert.equal(identity.rows[0].current_user, "r5i07_broker");
    assert.equal(identity.rows[0].superuser, false, "the wake store must not run as a superuser");
    assert.equal(identity.rows[0].is_broker, true);
  });

// Defence 1: with the append lock in place the inversion itself is impossible.
// A holds the lock and allocates a LOWER identity while uncommitted; B tries to
// append and must BLOCK on the lock rather than allocate above A. When A
// commits, B proceeds, so commit order matches identity order and the reader
// never has a hole to skip.
test("the append lock makes identity order and commit order the same order",
  { skip: needsPg() }, async () => {
    const slow = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
    const other = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
    try {
      // A: begin, take the append lock, allocate identity 1, hold it uncommitted.
      await slow.query("BEGIN");
      await slow.query("SELECT pg_advisory_xact_lock($1::bigint)", [String(0x0ac_70_15)]);
      const lower = (await slow.query(`INSERT INTO control_github_worker_wake_hints
        (delivery_id,source,repository,event,action,issue_or_pull_number,observed_at,expires_at)
        VALUES($1,'github-app-webhook','example/project','issue_comment','created',255,clock_timestamp(),
          clock_timestamp()+ interval '1 hour') RETURNING hint_id`, ["delivery-locklower1"])).rows[0].hint_id;

      // B: the REAL store publish() must block on the same advisory lock, not
      // proceed to allocate a higher identity while A is still open.
      let bFinished = false;
      const publishing = (async () => {
        const store = new PostgresGitHubWorkerWakeStore(clientFor(other));
        await store.publish(hint("delivery-lockhigher1"));
        bFinished = true;
      })();
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(bFinished, false,
        "a concurrent publisher must wait for the append lock, not commit above an open transaction");

      // The mid-flight poll. This is the hole R5I-07 is about. A reader that
      // polls NOW cannot see either hint (A is uncommitted, B is blocked), so its
      // cursor cannot advance past the lower identity. Without the lock, B would
      // have committed alone above it, this poll would return B, and the reader
      // would advance past a hint that did not exist yet — permanently skipping
      // it, since there is no backward-looking scan to recover it.
      const reader = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
      try {
        const store = new PostgresGitHubWorkerWakeStore(clientFor(reader));
        const start = (await reader.query(`SELECT coalesce(max(hint_id),0)::text AS top
          FROM control_github_worker_wake_hints`)).rows[0].top;
        const midFlight = await store.readAfter(start, 100);
        assert.deepEqual(midFlight.map(entry => entry.sequence), [],
          "a poll while the lower identity is still open must deliver nothing");

        await slow.query("COMMIT");
        await publishing;

        // Same cursor, after both commits: BOTH hints, in identity order. The
        // lower one is not merely visible — it is above the cursor the reader
        // held, so it was never skipped.
        const after = await store.readAfter(start, 100);
        assert.deepEqual(after.map(entry => entry.sequence),
          ["delivery-locklower1", "delivery-lockhigher1"],
          "both hints are delivered above the cursor the reader held mid-flight, in identity order");
        assert.equal(after[0]?.cursor, String(lower),
          "the lower hint carries exactly the identity allocated while it was still uncommitted");
        assert.ok(Number(after[0]?.cursor) > Number(start),
          "and it sits above the cursor the reader already held, so the cursor never passed it");
        assert.deepEqual(await store.readAfter(after.at(-1)?.cursor ?? "0", 100), [],
          "and the next poll at the new cursor is empty");
      } finally {
        await reader.end();
      }
    } finally {
      await slow.query("ROLLBACK").catch(() => {});
      await slow.end();
      await other.end();
    }
  });

// The steady state. A consumer that has caught up polls its own cursor again
// and again; every one of those polls must be empty. The removed re-scan window
// broke exactly this: it re-delivered the 256 most recent hints below the cursor
// on EVERY poll, for the whole 7-day retention, so an idle worker saw hundreds
// of phantom wake hints per poll forever. This is the regression test for that.
//
// Seeded past the old window (4096 rows) on purpose: the defect only appeared
// once the cursor was past it, which is why no earlier test could see it.
test("an idle poll at the current cursor returns nothing", { skip: needsPg(), timeout: 180_000 }, async () => {
  const admin = await open(target(DATABASE, "fixture_admin"));
  const writer = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
  const reader = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
  try {
    // Take the cursor BEFORE the padding, so the catch-up walk below sees only
    // the pad rows. Other tests in this file share the table.
    const start = (await reader.query(`SELECT coalesce(max(hint_id),0)::text AS top
      FROM control_github_worker_wake_hints`)).rows[0].top;
    // Pad the table past the old window so a cursor at the top is far above it.
    // This is fixture data, written directly; every READ below is the real
    // store on the production login with the production grants.
    await admin.query(`INSERT INTO control_github_worker_wake_hints
      (delivery_id,source,repository,event,action,issue_or_pull_number,observed_at,expires_at)
      SELECT 'delivery-pad-'||n,'github-app-webhook','example/project','issue_comment','created',255,
        clock_timestamp(),clock_timestamp()+ interval '1 hour'
      FROM generate_series(1,5000) AS n`);
    const store = new PostgresGitHubWorkerWakeStore(clientFor(reader));
    // The production poll loop, verbatim: read, advance with the last element's
    // cursor, stop on a short batch.
    const walk = async (from: string) => {
      let cursor = from;
      let seen = 0;
      for (;;) {
        const batch = await store.readAfter(cursor, 100);
        seen += batch.length;
        const next = batch.at(-1)?.cursor;
        if (next === undefined || next === cursor || batch.length < 100) return { cursor: next ?? cursor, seen };
        cursor = next;
      }
    };
    const caughtUp = await walk(start);
    assert.equal(caughtUp.seen, 5000, "the initial catch-up walk must deliver every pad hint exactly once");
    // Now the state a real consumer sits in: its cursor is the top, nothing new
    // has been published. Every subsequent poll must return nothing.
    for (let poll = 1; poll <= 4; poll += 1) {
      const idle = await store.readAfter(caughtUp.cursor, 100);
      assert.deepEqual(idle.map(entry => entry.sequence), [],
        `idle poll ${poll} at the current cursor must return no hints, not already-delivered ones`);
    }
    // A real publish through the real store is then delivered exactly once, and
    // the poll after it is empty again — so "empty when idle" is not just an
    // artifact of a stale cursor.
    const publishing = new PostgresGitHubWorkerWakeStore(clientFor(writer));
    await publishing.publish(hint("delivery-after-idle-1"));
    const delivered = await store.readAfter(caughtUp.cursor, 100);
    assert.deepEqual(delivered.map(entry => entry.sequence), ["delivery-after-idle-1"],
      "a newly published hint is delivered");
    assert.deepEqual(await store.readAfter(delivered.at(-1)?.cursor ?? caughtUp.cursor, 100), [],
      "and is never delivered a second time");
  } finally {
    await admin.end();
    await writer.end();
    await reader.end();
  }
});

// The `limit` contract. `readAfter` validates limit to 1..100, so a caller asking
// for at most 100 rows must get at most 100. The removed re-scan window ran a
// second, independent query with its own fixed limit of 256 and appended the
// results, so a limit-100 call could return up to 356 rows.
//
// Self-contained: it pads its own run of hints and reads from a cursor at least
// 4200 rows below the top, so it observes the case without depending on another
// test having run first.
test("a read never returns more rows than the caller's limit", { skip: needsPg() }, async () => {
  const admin = await open(target(DATABASE, "fixture_admin"));
  const reader = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
  try {
    await admin.query(`INSERT INTO control_github_worker_wake_hints
      (delivery_id,source,repository,event,action,issue_or_pull_number,observed_at,expires_at)
      SELECT 'delivery-limitpad-'||n,'github-app-webhook','example/project','issue_comment','created',255,
        clock_timestamp(),clock_timestamp()+ interval '1 hour'
      FROM generate_series(1,4200) AS n`);
    const store = new PostgresGitHubWorkerWakeStore(clientFor(reader));
    const top = Number((await reader.query(`SELECT max(hint_id)::text AS top
      FROM control_github_worker_wake_hints`)).rows[0].top);
    // The pad added exactly 4200 rows at the top, so `top - 4200` is the last
    // pre-pad row whatever else this shared table already holds. Reading from
    // there gives a cursor whose distance below the top is exactly one window.
    const batch = await store.readAfter(String(top - 4200), 100);
    assert.ok(batch.length > 0, "there must be hints above this cursor to read");
    assert.ok(batch.length <= 100, `a limit-100 read returned ${batch.length} rows`);
    // And a read is ascending, with no delivery id repeated: the consumer
    // merges the batch into its history and must not see one hint twice.
    const cursors = batch.map((entry) => Number(entry.cursor));
    assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b), "a read is ordered by cursor");
    const ids = batch.map((entry) => entry.sequence);
    assert.equal(new Set(ids).size, ids.length, "a single read must not repeat a hint");
  } finally {
    await admin.end();
    await reader.end();
  }
});

// Stress: many concurrent publishers must all land, and a single-pass cursor
// walk must not miss any of them. This is the load the append lock is meant to
// absorb, so it is the case where the lock's absence would show up as a hole.
//
// The walk starts from a cursor taken BEFORE the burst, and the assertion is
// that no hint is missing from the result — with no re-scan window, there is no
// second chance, so a single inversion would lose a hint permanently. This is
// R5I-07's property under real concurrency.
test("fifty concurrent publishers all become visible to one ordered cursor walk",
  { skip: needsPg(), timeout: 180_000 }, async () => {
    // Fifty deliveries across a bounded number of real connections. Concurrency
    // on the advisory lock is the number of CONNECTIONS, because a pg connection
    // serialises its own queries and runs one transaction at a time; each
    // connection therefore publishes its own share sequentially while all of them
    // run at once. Twelve connections is genuine cross-connection contention and
    // still fits the connection slots PostgreSQL reserves from non-superusers.
    const deliveryIds = Array.from({ length: 50 }, (_, index) => `delivery-stress-${String(index).padStart(3, "0")}`);
    const CONCURRENCY = 12;
    const shares: string[][] = Array.from({ length: CONCURRENCY }, () => []);
    deliveryIds.forEach((id, index) => shares[index % CONCURRENCY].push(id));
    const pool: Client[] = [];
    try {
      // Take the starting cursor BEFORE the burst, so the walk below must see
      // every concurrently published hint to pass.
      const start = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
      let startCursor: string;
      try {
        startCursor = (await start.query(`SELECT coalesce(max(hint_id),0)::text AS top
          FROM control_github_worker_wake_hints`)).rows[0].top;
      } finally { await start.end(); }
      // One real connection per lane, each with the REAL store on it.
      const lanes = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        const conn = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
        pool.push(conn);
        return new PostgresGitHubWorkerWakeStore(clientFor(conn));
      }));
      // Every lane publishes concurrently; within a lane the appends are ordered
      // by that one connection, exactly as a single webhook receiver would.
      await Promise.all(lanes.map((store, index) =>
        shares[index].reduce((chain, id) => chain.then(() => store.publish(hint(id))),
          Promise.resolve())));
      // Walk the table once from the pre-burst cursor exactly as the poll loop
      // does, and require every concurrently published hint to be observable.
      // Counted, not just collected: a Set would hide a re-delivery.
      const seen = new Map<string, number>();
      let cursor = startCursor;
      const reader = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
      try {
        const poll = new PostgresGitHubWorkerWakeStore(clientFor(reader));
        for (;;) {
          const batch = await poll.readAfter(cursor, 100);
          for (const entry of batch) seen.set(entry.sequence, (seen.get(entry.sequence) ?? 0) + 1);
          // The consumer's advance rule: the last element is the highest cursor.
          const next = batch.at(-1)?.cursor;
          if (next === undefined || next === cursor) break;
          cursor = next;
          if (batch.length < 100) break;
        }
      } finally { await reader.end(); }
      for (const id of deliveryIds) {
        assert.ok(seen.has(id), `every concurrently published hint must be observable: ${id} missing`);
        assert.equal(seen.get(id), 1, `${id} must be delivered exactly once`);
      }
    } finally {
      // Close every connection even if a publish is still in flight, so a
      // failure cannot leak sessions into the next test or the cluster teardown.
      await Promise.all(pool.map((conn) => conn.end().catch(() => {})));
    }
  });

// Regression: the consumer advances with `cursor = hints.at(-1).cursor`, so the
// last element of a read must be its highest cursor. The removed re-scan window
// made this non-obvious (its rows were spliced in ahead of the forward rows and
// the ordering had to be argued in a comment); a forward-only read is trivially
// ordered, and the invariant is asserted here anyway because getting it wrong
// hangs the wake loop in production.
test("the last element of a read is always the highest cursor", { skip: needsPg() }, async () => {
  const reader = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
  try {
    const store = new PostgresGitHubWorkerWakeStore(clientFor(reader));
    const top = Number((await reader.query(`SELECT max(hint_id)::text AS top
      FROM control_github_worker_wake_hints`)).rows[0].top);
    const batch = await store.readAfter(String(Math.max(0, top - 100)), 100);
    assert.ok(batch.length > 0);
    const cursors = batch.map((entry) => Number(entry.cursor));
    assert.equal(cursors.at(-1), Math.max(...cursors),
      "the last element must be the highest cursor or the poll loop never advances");
    // And the array is sorted, so a caller merging it into history keeps order.
    assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b),
      "a single read must be ordered by cursor");
  } finally { await reader.end(); }
});

// The PRODUCTION admission path. `acceptVerified` also inserts a hint, so it
// carries the same append lock; this proves concurrent admissions cannot commit
// out of identity order either, which the publish-only test cannot show.
test("concurrent verified admissions stay in identity order and every hint is readable",
  { skip: needsPg(), timeout: 120_000 }, async () => {
    const COUNT = 12;
    const pool: Client[] = [];
    try {
      const before = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
      const startCursor = (await before.query(`SELECT coalesce(max(hint_id),0)::text AS top
        FROM control_github_worker_wake_hints`)).rows[0].top;
      await before.end();
      // Each admission is a real store call with its own replay keys, on its own
      // connection, all issued at once.
      const stores = await Promise.all(Array.from({ length: COUNT }, async (_, index) => {
        const conn = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
        pool.push(conn);
        return { conn, index, store: new PostgresGitHubWorkerWakeStore(clientFor(conn)) };
      }));
      const nowMs = Date.parse("2026-09-16T03:00:00.000Z");
      const outcomes = await Promise.all(stores.map(({ index, store }) => store.acceptVerified({
        event: { deliveryId: `delivery-admit-${String(index).padStart(2, "0")}`, repository: "example/project",
          event: "issue_comment", action: "created", issueOrPullNumber: 255 } as never,
        replayKeys: [`delivery:delivery-admit-${String(index).padStart(2, "0")}`,
          `signature:sha256=${String(index).repeat(8).padEnd(64, "0")}`],
        nowMs, replayExpiresAtMs: nowMs + 3_600_000,
      })));
      assert.deepEqual(outcomes, Array.from({ length: COUNT }, () => true),
        "every distinct delivery is admitted exactly once");
      // Read them back through the real store from the pre-burst cursor.
      const reader = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
      try {
        const poll = new PostgresGitHubWorkerWakeStore(clientFor(reader));
        const seen = new Set<string>();
        let cursor = startCursor;
        for (;;) {
          const batch = await poll.readAfter(cursor, 100);
          for (const entry of batch) seen.add(entry.sequence);
          const next = batch.at(-1)?.cursor;
          if (next === undefined || next === cursor) break;
          cursor = next;
          if (batch.length < 100) break;
        }
        for (const { index } of stores) {
          const id = `delivery-admit-${String(index).padStart(2, "0")}`;
          assert.ok(seen.has(id), `an admitted delivery must be readable: ${id} missing`);
        }
      } finally { await reader.end(); }
    } finally {
      await Promise.all(pool.map((conn) => conn.end().catch(() => {})));
    }
  });

// Proves the lock in acceptVerified is load-bearing: hold the append lock in one
// session, start an admission in another, and require it to WAIT rather than
// commit above the open transaction. Removing the lock from this path makes the
// admission finish immediately — that is the inversion the lock prevents.
test("an admission waits for the append lock instead of committing above an open writer",
  { skip: needsPg(), timeout: 60_000 }, async () => {
    const holder = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
    const other = await open(target(DATABASE, "r5i07_broker", BROKER_PASSWORD));
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [String(0x0ac_70_15)]);
      await holder.query(`INSERT INTO control_github_worker_wake_hints
        (delivery_id,source,repository,event,action,issue_or_pull_number,observed_at,expires_at)
        VALUES('delivery-admit-open','github-app-webhook','example/project','issue_comment','created',255,
          clock_timestamp(),clock_timestamp()+ interval '1 hour')`);
      let admitted = false;
      const admission = (async () => {
        const store = new PostgresGitHubWorkerWakeStore(clientFor(other));
        await store.acceptVerified({ event: { deliveryId: "delivery-admit-waiter", repository: "example/project",
          event: "issue_comment", action: "created", issueOrPullNumber: 255 } as never,
        replayKeys: ["delivery:delivery-admit-waiter", `signature:sha256=${"7".repeat(32)}`],
        nowMs: Date.parse("2026-09-16T03:00:00.000Z"), replayExpiresAtMs: Date.parse("2026-09-16T04:00:00.000Z") });
        admitted = true;
      })();
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(admitted, false,
        "an admission must queue on the append lock, not commit above an open writer");
      await holder.query("COMMIT");
      await admission;
      assert.equal(admitted, true, "the admission completes once the lock is released");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
      await other.end();
    }
  });
