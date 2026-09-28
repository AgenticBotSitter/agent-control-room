// Disposable PostgreSQL 17 restart proof. This owns one temp cluster and one
// non-live loopback port; every exit path stops it and removes its data root.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPrivatePgDatabase } from "../src/web/v1/private-pg-database.ts";
import { startRecoveringMacLocalQueueWorkerV1 } from "../src/web/v1/mac-local-queue-worker-recovery.ts";
import { PrivateDatabaseError } from "../src/web/v1/bounded-database.ts";

const candidates = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"].filter(Boolean);
const bin = candidates.find(value => existsSync(join(value, "initdb")) && existsSync(join(value, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const available = existsSync(join(bin, "initdb")) && existsSync(join(bin, "postgres"));
const needsPg = available ? undefined : { skip: "needs PostgreSQL 17 binaries" };
const port = 65438;
const exec = promisify(execFile);
let root = "", data = "", socket = "", clusterMayBeRunning = false;

const native = (name, args) => exec(join(bin, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: root, NODE_ENV: "test" }, timeout: 30_000, maxBuffer: 1 << 20 });
const proveTcpReady = () => native("psql", ["-h", "127.0.0.1", "-p", String(port), "-d", "postgres",
  "-U", "fixture_recovery", "-Atqc", "SELECT 1"]);
const start = async () => {
  // Mark ownership before pg_ctl: a timeout can still leave postgres running.
  clusterMayBeRunning = true;
  await native("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-w", "-t", "20", "-o",
    `-k ${socket} -p ${port} -h 127.0.0.1 -c shared_buffers=32MB -c max_connections=20 -c shared_preload_libraries=''`, "start"]);
};
const stop = async () => {
  if (!clusterMayBeRunning) return;
  try {
    await native("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "20", "stop"]);
    clusterMayBeRunning = false;
  } catch (error) {
    // A failed stop is safe to treat as stopped only when pg_ctl independently
    // confirms no server owns this exact data directory.
    const stillRunning = await native("pg_ctl", ["-D", data, "status"]).then(() => true, () => false);
    if (stillRunning) throw error;
    clusterMayBeRunning = false;
  }
};

before(async () => {
  if (!available) return;
  root = await mkdtemp(join(tmpdir(), "cr-private-recovery-"));
  data = join(root, "data"); socket = join(root, "socket");
  await mkdir(socket, { mode: 0o700 });
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_recovery", "--auth-local=trust", "--auth-host=trust",
    "--no-locale", "--encoding=UTF8"]);
  await start();
});

after(async () => {
  if (!root) return;
  await stop();
  // Never remove a data directory until stop() has confirmed this exact
  // cluster is no longer running.
  await rm(root, { recursive: true, force: true });
});

const eventually = async (check, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("condition_not_reached");
};

const startDatabaseBackedWorker = async () => {
  const database = createPrivatePgDatabase({ host: "127.0.0.1", port, database: "postgres",
    username: "fixture_recovery", password: "fixture-only", majorVersion: 17 });
  try { await database.client.query("SELECT 1"); }
  catch (error) {
    try { await database.close(); }
    catch { throw Object.assign(new Error("native_queue_worker_start_cleanup_uncertain"), { stack: undefined }); }
    throw error;
  }
  let accepting = true, ended = false, resolveTerminal;
  const terminal = new Promise(resolve => { resolveTerminal = resolve; });
  const terminate = async cause => {
    if (ended) return terminal;
    ended = true; accepting = false;
    let cleanup = "closed";
    try { await database.close(); } catch { cleanup = "uncertain"; }
    resolveTerminal({ cause, cleanup });
    return terminal;
  };
  void (async () => {
    while (!ended) {
      try { await database.client.query("SELECT 1"); }
      catch { await terminate("fault"); return; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
  return Object.freeze({ status: () => ({ accepting }), whenTerminated: () => terminal,
    async close() {
      const outcome = await terminate("requested_close");
      if (outcome.cleanup !== "closed") throw Object.assign(new Error("native_queue_worker_close_uncertain"), { stack: undefined });
    } });
};

test("one stable private client resumes reads and writes after its PostgreSQL cluster restarts", needsPg, async () => {
  const database = createPrivatePgDatabase({ host: "127.0.0.1", port, database: "postgres",
    username: "fixture_recovery", password: "fixture-only", majorVersion: 17 });
  const stableClient = database.client;
  try {
    // Private sessions deliberately put pg_catalog first. Keep this recovery
    // fixture in the application schema instead of attempting catalog DDL.
    await stableClient.query("CREATE TABLE public.recovery_values (id integer PRIMARY KEY, value text NOT NULL)");
    await stableClient.query("INSERT INTO public.recovery_values VALUES ($1,$2)", [1, "before"]);
    assert.deepEqual((await stableClient.query("SELECT value FROM public.recovery_values WHERE id=$1", [1])).rows, [{ value: "before" }]);

    await stop();
    await assert.rejects(stableClient.query("SELECT value FROM public.recovery_values WHERE id=$1", [1]));
    assert.equal(database.client, stableClient);
    assert.equal(database.isAvailable(), false);
    await start();
    assert.equal((await proveTcpReady()).stdout.trim(), "1");

    let restored, lastRefusal = "none";
    // A bounded recovery may spend 5s retiring the old pool, then up to 5s
    // connecting and 5s closing each transient candidate plus bounded backoff.
    // Allow two complete failed candidates before requiring the ready cluster
    // to qualify, while keeping this proof finite.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try { restored = await stableClient.query("SELECT value FROM public.recovery_values WHERE id=$1", [1]); break; }
      catch (error) {
        lastRefusal = error instanceof PrivateDatabaseError ? error.code : "unexpected_refusal";
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(restored,
      `recovery_not_observed available=${database.isAvailable()} last_refusal=${lastRefusal}`);
    assert.deepEqual(restored?.rows, [{ value: "before" }]);
    assert.equal(database.client, stableClient);
    await stableClient.query("INSERT INTO public.recovery_values VALUES ($1,$2)", [2, "after"]);
    assert.deepEqual((await stableClient.query("SELECT id,value FROM public.recovery_values ORDER BY id")).rows,
      [{ id: 1, value: "before" }, { id: 2, value: "after" }]);
  } finally { await database.close(); }
});

test("the composed Mac queue supervisor returns to accepting after a real PostgreSQL restart", needsPg, async () => {
  const worker = await startRecoveringMacLocalQueueWorkerV1(startDatabaseBackedWorker, { delaysMs: [20, 50, 100] });
  try {
    assert.equal(worker.status().accepting, true);
    await stop();
    await eventually(() => !worker.status().accepting);
    assert.equal(worker.status().state, "reconnecting");
    await start();
    await eventually(() => worker.status().accepting);
    assert.deepEqual(worker.status(), { state: "running", faulted: false, accepting: true });
  } finally { await worker.close(); }
});
