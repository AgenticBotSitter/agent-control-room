// Explicit disposable local fixture; never attaches to an existing database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createPrivatePgDriver } from "../src/web/v1/private-pg-driver";
import { qualifyPrivatePgSession } from "../src/web/v1/private-pg-qualification";
import { boundPrivateDatabase } from "../src/web/v1/bounded-database";

const bin = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "supply the reviewed PostgreSQL 17 bin directory");
const exec = promisify(execFile);
const run = await mkdtemp(join(tmpdir(), "cr-driver-pg17-"));
const data = join(run, "data"), socket = join(run, "socket");
await mkdir(socket, { mode: 0o700 });
const native = (name: string, args: string[]) => exec(join(bin, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 20000 });
let attempted = false, stopped = false;
let db: ReturnType<typeof boundPrivateDatabase> | undefined;
let boss: PgBoss | undefined;
let queueFault = false;
try {
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_user", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
  attempted = true;
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "10", "-o",
    `-k ${socket} -p 65435 -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c shared_preload_libraries=''`, "start"]);
  const options = privatePgOptions({ host: "127.0.0.1", port: 65435, database: "postgres",
    username: "fixture_user", password: "fixture_only", majorVersion: 17 });
  // Test-only socket override; production still permits loopback TCP only.
  const pool = new Pool({ ...options, host: socket });
  db = boundPrivateDatabase(createPrivatePgDriver(pool, qualifyPrivatePgSession));
  pool.on("error", () => { void db?.close().catch(() => {}); });
  assert.equal((await db.client.query<{ listen_addresses: string }>("SHOW listen_addresses")).rows[0].listen_addresses, "");
  await db.client.query("CREATE TABLE public.fixture_values (id uuid PRIMARY KEY, body jsonb, tags text[])");
  const id = "00000000-0000-4000-8000-000000000001";
  await db.client.transactionWithPreCommitCheck(async session => {
    await session.query("INSERT INTO fixture_values VALUES ($1, $2, $3)", [id, { value: 7 }, ["a", "b"]]);
  }, () => {});
  assert.deepEqual((await db.client.query("SELECT * FROM fixture_values WHERE id=$1", [id])).rows,
    [{ id, body: { value: 7 }, tags: ["a", "b"] }]);
  await assert.rejects(db.client.transactionWithPreCommitCheck(async session => {
    await session.query("DELETE FROM fixture_values");
  }, () => { throw new Error("synthetic refusal"); }), /synthetic refusal/);
  assert.equal((await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM fixture_values")).rows[0].n, 1);
  // Schema installation is fixture-owned, not a production worker permission.
  await pool.query(getConstructionPlans("fixture_queue"));
  boss = new PgBoss({ db: { executeSql: (sql, values) => db!.client.query(sql, values) },
    schema: "fixture_queue", migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
  boss.on("error", () => { queueFault = true; });
  await boss.start();
  await boss.createQueue("fixture_task", { retryLimit: 0 });
  const jobId = await boss.send("fixture_task", { task: "synthetic", version: 1 });
  assert.ok(jobId);
  const jobs = await boss.fetch("fixture_task");
  assert.equal(jobs.length, 1); assert.equal(jobs[0].id, jobId);
  assert.deepEqual(jobs[0].data, { task: "synthetic", version: 1 });
  await boss.complete("fixture_task", jobId, { review: "pending" });
  const stored = await boss.getJobById("fixture_task", jobId);
  assert.equal(stored?.state, "completed");
  assert.deepEqual(stored?.output, { review: "pending" });
  assert.equal((await boss.fetch("fixture_task")).length, 0);
  assert.equal(queueFault, false);
  console.log(JSON.stringify({ pg17: true, tcpDisabled: true, qualification: true, values: true, preCommitRollback: true, queueRoundTrip: true }));
} finally {
  try { try { await boss?.stop({ graceful: false }); } finally { await db?.close(); } }
  finally {
    if (attempted) {
      await native("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "10", "stop"]);
      stopped = true;
    }
    if (!attempted || stopped) await rm(run, { recursive: true });
    console.log(JSON.stringify({ cleanup: !attempted || stopped }));
  }
}
