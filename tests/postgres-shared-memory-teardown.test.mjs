// Every disposable-PostgreSQL exit path, proven against a real postmaster.
//
// The symptom these tests exist for: a PostgreSQL postmaster creates one
// 56-byte SysV shared-memory segment and releases it on any shutdown that runs
// its exit path. SIGKILL cannot, so a SIGKILLed postmaster leaves the segment
// behind with a dead creator. This machine has 32 such segments in total, so
// the orphans accumulate at 1-2 per minute until `initdb` fails with `shmget`
// errors and blocks every other job.
//
// The four shapes asserted here are the four ways a test lane's teardown is
// skipped in practice:
//
//   1. SIGTERM — what the mutation helper in tests/support/attack-kit and the
//      operator's out-of-repo test-slot wrapper send FIRST
//   2. SIGINT  — what a Ctrl-C, a runner's bound, and `node --test` send
//   3. process.exit() before the lane's own teardown
//   4. the ordinary `stop()` in a `finally`
//
// Each spawns a real child that runs the SHARED lifecycle module
// (`scripts/dev/postgres-cluster-lifecycle.mjs`) — not a copy of it — against
// a real PostgreSQL 17 cluster, and each then asserts that the child's
// postmaster is gone AND that `ipcs -m` shows no new segment whose creator is
// that pid. The segment check is what makes these leak tests rather than
// process tests: a postmaster can be gone from `ps` and still be holding a
// segment, and only `ipcs` sees that.
//
// Segments are attributed by CREATOR PID, never swept. Four test slots share
// this login, so another job's cluster appears in the same `ipcs` output and
// failing on a per-user count reports someone else's leak.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SHUTDOWN_LADDER_ORDER, createClusterTeardown, shutdownLadder, pidAlive, readPostmasterPid,
  readPostmasterPidSync }
  from "../scripts/dev/postgres-cluster-lifecycle.mjs";

const exec = promisify(execFile);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const LIFECYCLE_MODULE = join(REPOSITORY_ROOT, "scripts/dev/postgres-cluster-lifecycle.mjs");

const CANDIDATE_BINS = [process.env.PG_BIN, "/opt/homebrew/bin", "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin"].filter(value => typeof value === "string" && value.length > 0);
/** The first bin directory that actually holds a PostgreSQL 17 server. */
export const PG_BIN = CANDIDATE_BINS.find(directory =>
  ["initdb", "pg_ctl", "postgres"].every(name => existsSync(join(directory, name)))) ?? null;

// Ports 56200-56209 are the block this job is authorized for.
const PORTS = [56200, 56201, 56202, 56203, 56204, 56205, 56206, 56207, 56208, 56209];
const needsPgOrFail = () => {
  if (PG_BIN !== null) return false;
  // Loud, never a silent green skip: a lane that HAS the binaries and still
  // skips is a broken lane, and a lane that does not have them must not read as
  // a pass. The skip message says the same reason a failure would.
  return `needs PostgreSQL 17 binaries (tried: ${CANDIDATE_BINS.join(", ")})`;
};

// ---------------------------------------------------------------- ipcs

/**
 * `ipcs -m -p` rows, parsed by HEADER NAME.
 *
 * The two platforms disagree completely — macOS is `T ID KEY MODE OWNER GROUP
 * CPID LPID` with rows prefixed `m `, Linux is `shmid owner cpid lpid` — so a
 * positional parse silently reads the wrong column on one of them. Returns
 * null when the output is not a recognisable table, so a caller REFUSES rather
 * than reporting a clean result it did not measure.
 */
export function parseSharedMemorySegments(stdout) {
  const lines = stdout.split("\n").map(line => line.trim()).filter(Boolean);
  const headerAt = lines.findIndex(line => /\bcpid\b/iu.test(line));
  if (headerAt === -1) return null;
  const headings = lines[headerAt].split(/\s+/u);
  const indexOf = (...names) => headings.findIndex(h => names.some(n => h.toLowerCase() === n));
  const id = indexOf("id", "shmid");
  const cpid = indexOf("cpid");
  if (id === -1 || cpid === -1) return null;
  const rows = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (/^(?:key|shared|type|size|^-+)/iu.test(line)) continue;
    const fields = line.split(/\s+/u);
    if (!/^\d+$/u.test(fields[id] ?? "") || !/^\d+$/u.test(fields[cpid] ?? "")) continue;
    rows.push({ id: fields[id], creatorPid: Number(fields[cpid]) });
  }
  return rows;
}

async function sharedMemorySegments() {
  const { stdout } = await exec("/usr/bin/ipcs", ["-m", "-p"], { encoding: "utf8", timeout: 10_000 })
    .then(value => ({ stdout: String(value.stdout ?? "") }))
    .catch(() => ({ stdout: "" }));
  return parseSharedMemorySegments(stdout);
}

// ---------------------------------------------------------------- the child

/**
 * The child program every test below runs. It is written to a file rather than
 * passed with `node -e` so the child is a real module with the same import
 * resolution the repository's own lanes have.
 */
const CHILD_SOURCE = `import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClusterTeardown } from ${JSON.stringify(LIFECYCLE_MODULE)};

const exec = promisify(execFile);
import { existsSync } from "node:fs";
const [pgBin, data, socket, run, port, mode, readyFile, goFile] = process.argv.slice(2);
const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" };
const native = (name, args, timeout = 120_000) =>
  exec(join(pgBin, name), args, { env, timeout, maxBuffer: 1 << 26 });

// The teardown is created BEFORE initdb. That ordering IS the fix: a start that
// fails after the postmaster forked, and a lane that exits before its own
// teardown, both used to leave a live postmaster holding a segment, because
// there was a window in which a cluster existed and nothing knew it did.
// Recursive, so the parent may have created the socket directory first.
await mkdir(socket, { recursive: true, mode: 0o700 });
const teardown = createClusterTeardown({
  dataDirectory: data, runDirectory: run, socketDirectory: socket,
  port: Number(port), pgBin,
});
await native("initdb", ["-D", data, "-U", "fixture_admin", "--auth-local=trust",
  "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "60", "-o",
  \`-k \${socket} -p \${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20\`,
  "start"]);
const postmasterPid = await teardown.capturePostmasterPid();
if (postmasterPid === undefined) throw new Error("child: the cluster came up with no postmaster pid");

// The parent's job is to learn the pid, CONFIRM the cluster is live, and only
// then release this process. Without the handshake below, a fast teardown
// (stop/exit) can finish before the parent gets to observe the live postmaster,
// and the observation would be taken after the fact.
await writeFile(readyFile, JSON.stringify({ postmasterPid, data, run, socket }) + "\\n", "utf8");
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && !existsSync(goFile)) {
  await new Promise(done => { setTimeout(done, 25); });
}
if (!existsSync(goFile)) throw new Error("child: the parent never released the lane");

if (mode === "stop") {
  await teardown.stop();
  console.log(JSON.stringify({ cleanedUp: true }));
} else if (mode === "hang") {
  setInterval(() => {}, 1 << 30);
} else if (mode === "exit") {
  // A lane that returns or calls process.exit() without reaching its own
  // teardown. The exit hook must still stop the postmaster.
  process.exit(0);
} else {
  // "sigterm" / "sigint": the parent's signal is the whole teardown.
  setInterval(() => {}, 1 << 30);
}
`;

/**
 * Ports used by the tests below, so two tests never collide.
 *
 * A live-cluster test that exhausts the block REFUSES rather than wrapping.
 * Wrapping would hand the eleventh test a port the first one is still using, and
 * the symptom would be an `EADDRINUSE` from a test that has nothing to do with
 * ports — the exact misattribution this file exists to prevent. `with-a-PG` lanes
 * are the only consumers, and there are fewer of them than ports.
 */
let nextPort = 0;
const takePort = () => {
  if (nextPort >= PORTS.length) {
    throw new Error(`disposable_test_port_block_exhausted:${PORTS.join(",")}:`
      + "add a port to the block rather than reusing one");
  }
  return PORTS[nextPort++];
};

/**
 * One running lane. `postmasterPid` is the pid whose SysV segment the leak
 * assertion attributes, so it is recorded the moment the child publishes it
 * rather than read back from a data directory the teardown may have removed.
 *
 * @typedef {{ child: import("node:child_process").ChildProcess,
 *   exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }>,
 *   childPid: number, postmasterPid?: number, data: string, run: string,
 *   goFile: string, scratch: string }} Lane
 */

/**
 * Start a lane, wait for it to publish a live postmaster, and return it.
 *
 * A SIGKILL to the child is what a bounded runner does, and it cannot be
 * simulated from inside: the child is a real process with a real cluster.
 */
async function startLane(t, mode) {
  const scratch = await mkdtemp(join(tmpdir(), "shm-teardown-"));
  const run = join(scratch, "run");
  const data = join(run, "data");
  const socket = join(scratch, "socket");
  const readyFile = join(scratch, "ready.json");
  const goFile = join(scratch, "go");
  await mkdir(run, { mode: 0o700 });
  await mkdir(socket, { mode: 0o700 });
  const childProgram = join(scratch, "lane.mjs");
  await writeFile(childProgram, CHILD_SOURCE, "utf8");

  // `detached: true` puts the child in its own process group, so this test can
  // signal the child alone — which is the point: a group signal must not be
  // what saves the cluster, because a real runner signals the process it owns.
  const child = spawn(process.execPath, [childProgram, PG_BIN, data, socket, run,
    String(takePort()), mode, readyFile, goFile], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let childLog = "";
  child.stdout.on("data", chunk => { childLog += chunk; });
  child.stderr.on("data", chunk => { childLog += chunk; });
  const exited = new Promise(resolveLane => {
    child.once("exit", (code, signal) => resolveLane({ code, signal }));
  });

  const deadline = Date.now() + 180_000;
  let ready;
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) {
      try { ready = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(readyFile, "utf8"))); } catch { /* partial */ }
      if (ready?.postmasterPid) break;
    }
    if (child.exitCode !== null) throw new Error(`lane exited before the cluster came up: ${childLog}`);
    await new Promise(done => { setTimeout(done, 100); });
  }
  if (!ready?.postmasterPid) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    throw new Error(`lane never published a postmaster pid: ${childLog}`);
  }

  const lane = { child, exited, childPid: child.pid, postmasterPid: ready.postmasterPid,
    data, run, goFile, scratch };
  // A test that fails mid-flight must not leave a postmaster behind. This is a
  // last-resort sweep of the ONE pid this test recorded; nothing is matched by
  // name and no segment is removed.
  t.after(async () => {
    try { process.kill(lane.childPid, "SIGKILL"); } catch { /* already gone */ }
    await lane.exited;
    if (lane.postmasterPid !== undefined && pidAlive(lane.postmasterPid)) {
      try {
        await exec(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "20", "stop"],
          { timeout: 30_000 });
      } catch { /* reported by the assertions below when reachable */ }
    }
    await rm(scratch, { recursive: true, force: true });
  });
  return lane;
}

/**
 * Let the lane proceed past the point where it published its pid.
 *
 * Separate from `startLane` so each test can assert the cluster is LIVE first
 * — the liveness observation is only meaningful before the teardown, and a
 * teardown that ran during `startLane` would make it unfalsifiable.
 */
async function release(lane) {
  assert.equal(pidAlive(lane.postmasterPid), true,
    "the postmaster must still be running when the lane is released, or nothing was observed");
  await writeFile(lane.goFile, "", "utf8");
}

/**
 * No segment exists whose creator is `postmasterPid`.
 *
 * The leak assertion, and the reason these tests are about `ipcs` rather than
 * about `ps`. A segment's cpid is the pid of the postmaster that created it,
 * which is exact attribution: four test slots share this login, so a per-user
 * count would report another job's postmaster as this test's leak.
 */
async function assertNoSegmentFrom(postmasterPid, note) {
  await new Promise(done => { setTimeout(done, 750); });
  const segments = await sharedMemorySegments();
  assert.notEqual(segments, null, `ipcs could not be read on this host: ${note}`);
  const mine = segments.filter(segment => segment.creatorPid === postmasterPid);
  assert.deepEqual(mine, [],
    `${note}: postmaster ${postmasterPid} left SysV segment(s) ${mine.map(s => s.id).join(", ")} behind`);
}

// ---------------------------------------------------------------- the ladder

test("the shutdown ladder is ordered by what RELEASES the segment, not by what ends the process soonest", async () => {
  // SIGKILL is the only step that leaks, because it is the only one that cannot
  // run PostgreSQL's exit path. Asserting the order directly is what makes a
  // later edit that "optimises" it to SIGKILL-first fail, rather than silently
  // costing a segment per cluster.
  //
  // `alive` is asked BEFORE each step, and again after every signal, so a stub
  // that reports "still alive" unconditionally never terminates: a signal step
  // polls until its 30 s grace expires. This one dies only on SIGKILL, which is
  // what makes the wait in the earlier steps return at once.
  const calls = [];
  let alive = true;
  const ladder = await shutdownLadder({
    alive: () => alive,
    cooperativeStop: async mode => { calls.push(`cooperative:${mode}`); },
    signal: signal => { calls.push(`signal:${signal}`); if (signal === "SIGKILL") alive = false; },
    tickMs: 1, graceMs: 1_000,
  });
  assert.deepEqual(calls, ["cooperative:fast", "cooperative:immediate", "signal:SIGQUIT", "signal:SIGKILL"]);
  assert.deepEqual(ladder.steps.map(step =>
    step.action === "cooperative" ? `cooperative:${step.mode}` : `signal:${step.signal}`), [...SHUTDOWN_LADDER_ORDER]);
  assert.equal(ladder.forced, true, "reaching SIGKILL must be reported as forced");
});

test("the ladder stops at the first step that finds the postmaster gone, and never reaches SIGKILL", async () => {
  const calls = [];
  // Alive only until the first cooperative stop completes, so the ladder ends
  // at step one and no signal is ever sent.
  const ladder = await shutdownLadder({
    alive: () => calls.length === 0,
    cooperativeStop: async mode => { calls.push(`cooperative:${mode}`); },
    signal: signal => { calls.push(`signal:${signal}`); },
  });
  assert.deepEqual(calls, ["cooperative:fast"],
    "the common case must perform exactly one pg_ctl -m fast and never send a signal");
  assert.equal(ladder.forced, false);
  assert.deepEqual(ladder.steps, [{ action: "cooperative", mode: "fast", stopped: true, failed: false }]);
});

test("a postmaster that refuses every cooperative shutdown is SIGKILLed, and that is reported as forced", async () => {
  // Reaching SIGKILL cost the machine a 56-byte segment, so it cannot be
  // reported as a clean teardown. This is the one path that still leaks, and it
  // is the last resort, not the first step.
  const calls = [];
  // Alive until SIGKILL, so every earlier step is recorded as failed. The
  // cooperative steps THROW here, because that is what a postmaster refusing a
  // shutdown request looks like from `pg_ctl`: a refusal the ladder must notice
  // rather than report as a clean stop.
  let alive = true;
  const ladder = await shutdownLadder({
    alive: () => alive,
    cooperativeStop: async mode => {
      calls.push(`cooperative:${mode}`);
      throw new Error(`pg_ctl: server does not take a ${mode} shutdown request`);
    },
    signal: signal => { calls.push(`signal:${signal}`); if (signal === "SIGKILL") alive = false; },
    tickMs: 1, graceMs: 1_000,
  });
  assert.deepEqual(calls, ["cooperative:fast", "cooperative:immediate", "signal:SIGQUIT", "signal:SIGKILL"]);
  assert.equal(ladder.forced, true);
  assert.equal(ladder.steps.filter(step => step.failed).length, 3,
    "every step that did not stop the postmaster is recorded as failed");
  // The reason is carried, not discarded: a bare "stop failed" tells an
  // operator nothing about WHICH step failed, which is the only thing that
  // distinguishes "the postmaster was already gone" from "permission denied" on
  // a machine that is out of SysV segments.
  assert.match(ladder.steps[0].error ?? "", /does not take a fast shutdown request/u);
});

test("parseSharedMemorySegments reads macOS and Linux ipcs by header name, and refuses anything else", () => {
  // Captured verbatim on this machine (`LC_ALL=C ipcs -m -p`). The leading `m`
  // is the VALUE of the header's leading `T` column, not an extra field:
  // shifting by one to "drop" it reads the key as the id and the mode as the
  // creator, silently, on every row.
  const mac = "T     ID     KEY        MODE       OWNER    GROUP  CPID  LPID\n"
    + "Shared Memory:\n"
    + "m 19005440 0x093a6b53 --rw------- ci-runner    staff 68830 68830\n"
    + "m 48168961 0x093a6b54 --rw------- ci-runner    staff 68831 68831\n";
  assert.deepEqual(parseSharedMemorySegments(mac), [
    { id: "19005440", creatorPid: 68830 }, { id: "48168961", creatorPid: 68831 },
  ]);
  // The real util-linux `ipcs -m -p` layout: lowercase headings, no type
  // marker, and a "Shared Memory Creator/Last-op PIDs" banner whose key/mode/
  // owner columns would be read as data by a parser that does not look for the
  // header first. A parse that assumed macOS's `m ` prefix would find no cpid
  // here at all and return nothing.
  const linux = [
    "IPC status from <running system> as of Mon Sep 28 18:30:53 UTC 2026",
    "------ Shared Memory Creator/Last-op PIDs --------",
    "key      0x00000000 0x08ad575a  -r-------  1000 someuser  78587  78587",
    "shmid      owner      cpid       lpid",
    "62455816  someuser   78587      78587",
    "12713993  someuser   5559       0",
  ].join("\n");
  assert.deepEqual(parseSharedMemorySegments(linux), [
    { id: "62455816", creatorPid: 78587 }, { id: "12713993", creatorPid: 5559 },
  ]);
  // A guard that cannot run must not read as a guard that passed.
  assert.equal(parseSharedMemorySegments("ipcs: command not found\n"), null);
  assert.equal(parseSharedMemorySegments(""), null);
});

test("readPostmasterPidSync reads what readPostmasterPid reads, without a promise", async t => {
  // The `exit` hook can only run synchronous work, so it needs a synchronous
  // read. A missing or divergent definition of that reader is invisible until a
  // process actually exits — which is the one moment nothing can report the
  // failure — so it is pinned here against the async form.
  const scratch = await mkdtemp(join(tmpdir(), "shm-pidsync-"));
  const data = join(scratch, "run", "data");
  await mkdir(data, { recursive: true });
  assert.equal(readPostmasterPidSync(data), undefined, "no postmaster.pid means no pid, not a throw");

  const child = spawn("/usr/bin/perl", ["-e", "sleep 30"], { stdio: "ignore", detached: true }).pid;
  t.after(() => { try { process.kill(child, "SIGKILL"); } catch { /* already gone */ } });
  await new Promise(r => { setTimeout(r, 250); });
  await writeFile(join(data, "postmaster.pid"), `${child}\n`, "utf8");
  assert.equal(readPostmasterPidSync(data), child);
  assert.equal(await readPostmasterPid(data), child, "both readers must agree on the same file");

  // A half-written file is what a postmaster SIGKILLed mid-start leaves behind,
  // and both readers must treat it as "no pid" rather than as a number.
  await writeFile(join(data, "postmaster.pid"), "not-a-pid\n", "utf8");
  assert.equal(readPostmasterPidSync(data), undefined);
  assert.equal(await readPostmasterPid(data), undefined);

  try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
  await rm(scratch, { recursive: true, force: true });
});

test("the real ipcs on this host parses, so a leak test here can measure rather than assume", async () => {
  const segments = await sharedMemorySegments();
  assert.notEqual(segments, null, "ipcs is readable here, so the leak assertions below will not refuse");
  assert.ok(Array.isArray(segments));
});

// ---------------------------------------------------------------- the exits

// --------------------------------------------------------------------------
// The failure paths, driven through the real teardown with its commands
// injected.
//
// These exist because the mutations that broke them all survived the
// leak tests: a postmaster that refuses every cooperative stop cannot be
// produced on demand from a healthy one, so without an injection seam the
// "refuse to report success" guards are asserted by nothing. The seam is
// narrow on purpose — it replaces the COMMAND, never the logic — so the ladder,
// the liveness checks, the directory removal and the error shapes are the ones
// that ship.
// --------------------------------------------------------------------------

/** A pg_ctl stand-in whose `stop` refuses, the way a wedged postmaster does. */
function refusingPgCtl({ statusReportsRunning = false } = {}) {
  const calls = [];
  return {
    calls,
    exec(args) {
      calls.push(args.join(" "));
      // `pg_ctl status` exits non-zero when no postmaster is running, and zero
      // when one is. Throwing is therefore how a healthy status is modelled.
      if (args.includes("status")) {
        if (statusReportsRunning) return;
        throw new Error("pg_ctl: no server running");
      }
      throw new Error("pg_ctl: PID file not found");
    },
  };
}

test("release() disarms the signal handlers and the exit hook, and stop() disarms them too", async () => {
  // The rehearsal deliberately hands a LIVE cluster to the owner's session, so it
  // calls `release()` instead of `stop()`. If `release()` were a no-op, a Ctrl-C
  // in the owner's shell would stop a database the rehearsal was asked to leave
  // running — the exact failure the `release` seam exists to prevent, and the
  // reason it needs a test rather than a comment.
  //
  // Listener counts are the observable: the hooks are `process` listeners, so a
  // teardown that failed to remove its own is measurable from outside, and
  // another teardown's listeners must not be taken with it.
  const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM"), exit: process.listenerCount("exit") };
  const scratch = await mkdtemp(join(tmpdir(), "shm-release-"));
  const data = join(scratch, "run", "data");
  await mkdir(data, { recursive: true });

  // A healthy cluster: `stop` succeeds, and `status` reports no server, which is
  // how a `pg_ctl status` reads when nothing is running. Throwing from `status`
  // is that signal, so the stub must do it or the teardown is right to refuse.
  const healthyPgCtl = args => {
    if (args.includes("status")) throw new Error("pg_ctl: no server running");
  };
  const released = createClusterTeardown({ dataDirectory: data, runDirectory: join(scratch, "run"),
    socketDirectory: join(scratch, "socket"), port: 56206, pgCtl: healthyPgCtl });
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1, "arming must add a SIGINT handler");
  assert.equal(process.listenerCount("exit"), before.exit + 1, "arming must add an exit hook");
  released.release();
  assert.deepEqual(
    { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM"), exit: process.listenerCount("exit") },
    before,
    "release() must remove every hook it added, or a released cluster is still stoppable by a signal");

  const stopped = createClusterTeardown({ dataDirectory: data, runDirectory: join(scratch, "run"),
    socketDirectory: join(scratch, "socket"), port: 56207, pgCtl: healthyPgCtl });
  assert.equal(process.listenerCount("exit"), before.exit + 1);
  await stopped.stop();
  assert.deepEqual(
    { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM"), exit: process.listenerCount("exit") },
    before,
    "stop() must release the hooks too, so a long test file does not accumulate one per cluster");
  await rm(scratch, { recursive: true, force: true });
});

test("a released teardown is a no-op that leaves its cluster alone", async () => {
  // The other half of the rehearsal contract: `release()` must disarm WITHOUT
  // stopping. A process that is still running and recorded in postmaster.pid is
  // the observable — if `release()` stopped anything, this process would be
  // gone, and a test process ending there would be a spectacularly confusing
  // failure rather than a clear assertion failure.
  const scratch = await mkdtemp(join(tmpdir(), "shm-release-live-"));
  const data = join(scratch, "run", "data");
  await mkdir(data, { recursive: true });
  let stops = 0;
  const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: join(scratch, "run"),
    socketDirectory: join(scratch, "socket"), port: 56208, pgCtl: () => { stops += 1; } });
  teardown.release();
  teardown.release();
  assert.equal(stops, 0, "release() must not run a stop, and must be safe to call twice");
  assert.equal(existsSync(data), true, "release() must not remove the data directory");
  await rm(scratch, { recursive: true, force: true });
});

test("a teardown whose postmaster is confirmed gone reports degraded, and does NOT throw",
  async t => {
    // Review finding 1 (PR #438). A postmaster that is GONE, whose every
    // `pg_ctl stop` nevertheless failed. The postmaster being gone is what
    // releases its 56-byte SysV segment, so a teardown that ends with it gone
    // leaked nothing.
    //
    // It used to THROW `disposable_postgres_stop_degraded` here, and
    // `scripts/ops/verify-database-backup.mjs` re-raised that out of its
    // `finally` when the body had already succeeded — so a backup whose digests,
    // ledger, ownership and grants all matched printed `FAIL` and exited 1,
    // which is the "investigate this as a recovery incident" response
    // docs/BACKUP_AND_RESTORE.md:41-44 reserves for a mismatch. Only a teardown
    // that was actually FORCED, or that left the postmaster running, may do
    // that.
    //
    // The reason is not swallowed: it is on stderr, and on `degraded()`.
    const scratch = await mkdtemp(join(tmpdir(), "shm-degraded-"));
    const data = join(scratch, "run", "data");
    await mkdir(data, { recursive: true });
    const logged = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = originalWrite; });
    const pgCtl = refusingPgCtl();
    // No `degradedLogger`: the DEFAULT sink is what an operator sees, so the
    // default is what is asserted.
    const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: join(scratch, "run"),
      socketDirectory: join(scratch, "socket"), port: 56203, pgCtl: pgCtl.exec });

    // No postmaster.pid and a `pg_ctl status` that reports no server: both
    // agree, so the shutdown IS confirmed.
    await teardown.stop();
    assert.equal(teardown.degraded().length, 1,
      "the failed stop must still be reported, just not by throwing");
    assert.match(teardown.degraded()[0], /pg_ctl_stop_failed/u);
    assert.match(logged.join("\n"), /pg_ctl_stop_failed/u,
      "an operator running this by hand must still see WHY the stop degraded");
    assert.equal(pgCtl.calls.filter(call => call.includes("status")).length, 1,
      "with no captured pid, pg_ctl status is the only evidence a shutdown happened, so it is asked for");
    // The directory IS removed here, and that is right: the postmaster is
    // confirmed gone, so keeping its data directory would be litter rather than
    // evidence. The directories are kept only when a postmaster SURVIVED, which
    // is the case the operator has to act on.
    assert.equal(existsSync(data), false,
      "a confirmed shutdown removes the data directory");
    await rm(scratch, { recursive: true, force: true });
  });

test("a teardown that reaches SIGKILL reports it, because SIGKILL is the one path that leaks a segment",
  async t => {
    const scratch = await mkdtemp(join(tmpdir(), "shm-forced-"));
    const data = join(scratch, "run", "data");
    await mkdir(data, { recursive: true });
    // A real process that this test started and owns, that IGNORES SIGQUIT, so
    // the ladder is forced all the way to SIGKILL. Without the ignore, a plain
    // SIGQUIT would end it at the third step and the forced-teardown guard would
    // never be reached — which is exactly the case where the branch matters.
    // The process must have INSTALLED its SIGQUIT disposition before the ladder
    // signals it: a default-disposition SIGQUIT kills it outright, and a
    // fixture that races its own readiness tests the wrong thing. `exec 1` is
    // emitted the moment the trap is in place, so waiting for it is a real
    // readiness signal rather than a sleep.
    const child = spawn("/usr/bin/perl",
      ["-e", '$SIG{QUIT} = "IGNORE"; $| = 1; print "ready\\n"; sleep 30'],
      { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const sleeper = child.pid;
    t.after(() => { try { process.kill(sleeper, "SIGKILL"); } catch { /* the ladder already ended it */ } });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      setTimeout(() => reject(new Error("the wedged process never became ready")), 10_000);
    });
    await writeFile(join(data, "postmaster.pid"), `${sleeper}\n`, "utf8");
    const pgCtl = refusingPgCtl();
    const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: join(scratch, "run"),
      socketDirectory: join(scratch, "socket"), port: 56204, pgCtl: pgCtl.exec,
      graceMs: 1_000, tickMs: 50 });

    await assert.rejects(teardown.stop(),
      /disposable_postgres_stop_degraded:[^:]*:.*postmaster_required_sigkill_which_leaks_its_shared_memory_segment/,
      "a forced teardown cost the machine a 56-byte segment and must be reported as a failure");
    assert.equal(pidAlive(sleeper), false, "the ladder's last step must have actually ended the process");
    await rm(scratch, { recursive: true, force: true });
  });

test("a REAL postmaster stopped cooperatively-then-SIGQUIT resolves, and leaks no segment",
  needsPgOrFail(), async t => {
    // Review finding 1 (PR #438), against a real PostgreSQL 17 postmaster.
    //
    // The reported scenario: `pg_ctl -m fast` does not confirm inside its window
    // (a slow checkpoint after the write-heavy restore this module is used to
    // clean up), and the ladder falls through to `immediate`, or here to
    // `SIGQUIT`, which does stop the postmaster. `forced` is false, so nothing
    // leaked. The old code still threw `disposable_postgres_stop_degraded` on the
    // recorded `fast` failure, and `scripts/ops/verify-database-backup.mjs` turned
    // that into a `FAIL` for a backup that had verified.
    //
    // Driven through the real production composition — a real postmaster, the
    // real ladder, the real teardown, the real `ipcs` — with only the `pg_ctl`
    // COMMAND replaced, which is the seam the module already documents. The
    // refusal is a real shutdown's shape: a `fast` stop that has not finished
    // reports failure while the postmaster is still up.
    const scratch = await mkdtemp(join(tmpdir(), "shm-fasttimeout-"));
    const run = join(scratch, "run"), data = join(run, "data"), socket = join(scratch, "socket");
    await mkdir(socket, { recursive: true, mode: 0o700 });
    const port = takePort();
    const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: run,
      socketDirectory: socket, port, pgBin: PG_BIN,
      pgCtl: args => {
        // The stop requests refuse, as they do while a real `fast` shutdown is
        // still finishing. `pg_ctl status` and the started-cluster answers are
        // the real thing, so only the STOP is stubbed.
        if (args.includes("stop")) throw new Error("pg_ctl: server does not take a fast shutdown request");
        return execFileSync(join(PG_BIN, "pg_ctl"), args, { encoding: "utf8", timeout: 90_000 });
      } });
    t.after(async () => {
      if (pidAlive(teardown.postmasterPid() ?? -1)) {
        try { await exec(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "-t", "20", "stop"], { timeout: 30_000 }); }
        catch { /* reported by the assertions below */ }
      }
      await rm(scratch, { recursive: true, force: true });
    });

    // `LC_ALL` is not optional: without a valid locale PostgreSQL aborts
    // startup with "postmaster became multithreaded during startup", which reads
    // as a port or permission problem and sends you looking in the wrong place.
    const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
    await exec(join(PG_BIN, "initdb"), ["-D", data, "-U", "postgres", "--auth-local=trust",
      "--auth-host=reject", "--no-locale", "--encoding=UTF8"], { timeout: 120_000, env });
    await exec(join(PG_BIN, "pg_ctl"), ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "60", "-o",
      `-k ${socket} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`,
      "start"], { timeout: 120_000, env });
    const postmasterPid = await teardown.capturePostmasterPid();
    assert.ok(postmasterPid, "the cluster must be up before anything is torn down");
    assert.equal(pidAlive(postmasterPid), true);

    const logged = [];
    // The DEFAULT sink is asserted here, not an injected one: this is the line an
    // operator sees when they run the verifier or a lane by hand, so proving that
    // the default path writes it is the claim that matters. `process.stderr.write`
    // is what the module uses, and the test runner's own TAP output goes to stdout,
    // so capturing it here does not swallow the run's report.
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = originalWrite; });
    // The whole assertion of the fix: this RESOLVES. A postmaster that is gone
    // and leaked nothing did not turn a verified backup into a FAIL.
    await teardown.stop();
    assert.equal(pidAlive(postmasterPid), false, "the ladder must actually have stopped the postmaster");
    await assertNoSegmentFrom(postmasterPid, "fast-timeout then SIGQUIT");
    assert.ok(teardown.degraded().length >= 1,
      "the refused `fast` step must still be reported as the reason it degraded");
    assert.ok(teardown.degraded().some(reason => /pg_ctl_stop_fast_failed/u.test(reason)),
      `the degraded reason must name the refused step: ${teardown.degraded().join(", ")}`);
    assert.ok(teardown.degraded().every(reason => !/postmaster_required_sigkill/u.test(reason)),
      "a postmaster that stopped on SIGQUIT did not require SIGKILL");
    assert.match(logged.join(""), /disposable_postgres_stop_degraded/u,
      "the degraded teardown is logged on stderr by default, not silently swallowed");
  });

test("a teardown that reaches SIGKILL against a REAL wedged process still throws",
  needsPgOrFail(), async t => {
    // The other half of the pair, and the reason the fix is not "never throw".
    //
    // A real PostgreSQL postmaster cannot be made to ignore SIGQUIT — the signal
    // handler is installed by `InitPostgresDeathWatchHandle` and cannot be
    // replaced — so a real postmaster always stops at the ladder's third step.
    // SIGKILL is therefore reachable only from a process that genuinely traps
    // SIGQUIT, which is what this fixture is: a real process this test started
    // and recorded, with `SIGQUIT` set to `IGNORE` before it announces itself
    // ready. The module's own LOST-EXIT-PATH reasoning (`cooperativeStopSync` and
    // the `exit` hook) is defended the same way, and the file already uses this
    // exact fixture for the `pgCtl`-seam variant above.
    //
    // What makes it a GUARD and not a restatement: the neighbouring test proves
    // the same ladder RESOLVES when the postmaster stops, so a mutation that
    // stopped the throw from depending on `ladder.forced` fails this one and
    // passes that one. Neither direction survives alone.
    const scratch = await mkdtemp(join(tmpdir(), "shm-forced-real-"));
    const data = join(scratch, "run", "data");
    await mkdir(data, { recursive: true });
    const child = spawn("/usr/bin/perl",
      ["-e", '$SIG{QUIT} = "IGNORE"; $| = 1; print "ready\\n"; sleep 30'],
      { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const wedgedPid = child.pid;
    t.after(() => { try { process.kill(wedgedPid, "SIGKILL"); } catch { /* the ladder ended it */ } });
    // Readiness is the fixture's own announcement, not a sleep: a default
    // disposition would make SIGQUIT fatal and the test would then be testing
    // the wrong branch.
    await new Promise((resolveReady, reject) => {
      child.stdout.once("data", resolveReady);
      child.once("error", reject);
      setTimeout(() => reject(new Error("the wedged process never became ready")), 10_000);
    });
    await writeFile(join(data, "postmaster.pid"), `${wedgedPid}\n`, "utf8");
    const logged = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = originalWrite; });
    const pgCtl = refusingPgCtl();
    const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: join(scratch, "run"),
      socketDirectory: join(scratch, "socket"), port: 56204, pgBin: PG_BIN, pgCtl: pgCtl.exec,
      graceMs: 1_000, tickMs: 50 });

    await assert.rejects(teardown.stop(),
      /disposable_postgres_stop_degraded:[^:]*:.*postmaster_required_sigkill_which_leaks_its_shared_memory_segment/u,
      "a teardown that reached SIGKILL leaked a segment and must still be a failure");
    assert.equal(pidAlive(wedgedPid), false, "the ladder's last step must have actually ended the process");
    assert.ok(teardown.degraded().some(reason => /postmaster_required_sigkill/u.test(reason)),
      "the leak itself must be the reported reason, not a cooperative step");
    assert.match(logged.join("\n"), /disposable_postgres_stop_degraded/u);
    await rm(scratch, { recursive: true, force: true });
  });

test("a teardown whose postmaster.pid is unreadable refuses to report success while pg_ctl status says a server runs",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "shm-nopid-"));
    const data = join(scratch, "run", "data");
    await mkdir(data, { recursive: true });
    // A postmaster.pid whose first line is NOT a number, and a pg_ctl that
    // refuses every stop and reports a running server.
    //
    // This is the one path where the teardown has no pid to signal, and it is a
    // real shape: a postmaster.pid half-written by a postmaster that was killed
    // mid-start reads as garbage rather than as a pid. The only evidence left is
    // the file plus `pg_ctl status`, and `pg_ctl status` reporting a running
    // server must not read as a stopped cluster.
    //
    // Both evidence sources matter, which is the point of the fixture: a
    // mutation that trusts either one alone passes, so the file is present and
    // the status reports running.
    await writeFile(join(data, "postmaster.pid"), "not-a-pid\n", "utf8");
    const pgCtl = refusingPgCtl({ statusReportsRunning: true });
    const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: join(scratch, "run"),
      socketDirectory: join(scratch, "socket"), port: 56205, pgCtl: pgCtl.exec });
    await assert.rejects(teardown.stop(), /disposable_postgres_shutdown_unconfirmed/,
      "with no pid and no confirmable status, a teardown must not report success");
    await rm(scratch, { recursive: true, force: true });
  });

test("a lane stopped with stop() releases its SysV shared-memory segment", needsPgOrFail(), async t => {
  const lane = await startLane(t, "stop");
  await release(lane);
  const exit = await lane.exited;
  assert.equal(exit.code, 0, `the lane should have completed cleanly: ${JSON.stringify(exit)}`);
  assert.equal(pidAlive(lane.postmasterPid), false, "the postmaster must be gone after stop()");
  await assertNoSegmentFrom(lane.postmasterPid, "ordinary stop()");
});

test("a lane SIGTERMed by a runner releases its SysV shared-memory segment", needsPgOrFail(), async t => {
  // The mutation helper in tests/support/attack-kit, and the operator's
  // out-of-repo test-slot wrapper, both send SIGTERM first and SIGKILL
  // two seconds later. This lane has no teardown of its own after the signal:
  // the lifecycle module's handler is the whole shutdown path.
  const lane = await startLane(t, "sigterm");
  assert.equal(pidAlive(lane.postmasterPid), true, "the cluster must be live before the signal is sent");
  process.kill(lane.childPid, "SIGTERM");
  const exit = await lane.exited;
  // The leak is asserted FIRST, and deliberately so. With the handlers removed
  // the exit code goes to null, and an exit-code assertion placed first fires
  // and ends the test before the segment is ever measured — so the test would
  // fail for a reason other than the one it exists to detect. `ipcs` is the only
  // account of this that is not the kit's opinion of itself.
  assert.equal(pidAlive(lane.postmasterPid), false,
    "a postmaster that ignored SIGTERM is exactly the orphan this machine cannot afford");
  await assertNoSegmentFrom(lane.postmasterPid, "SIGTERM");
  // The handler re-raises the signal's CONVENTIONAL EXIT CODE, so the runner
  // sees a non-zero code rather than a signalled death. Either would fail a
  // lane; what must not happen is a clean zero, which would read as a lane that
  // finished its work.
  assert.equal(exit.code, 143, "SIGTERM must still read as a failure, not a clean exit");
});

test("a lane SIGINTed releases its SysV shared-memory segment", needsPgOrFail(), async t => {
  // What a Ctrl-C, a runner's bound and `node --test` send.
  const lane = await startLane(t, "sigint");
  assert.equal(pidAlive(lane.postmasterPid), true, "the cluster must be live before the signal is sent");
  process.kill(lane.childPid, "SIGINT");
  const exit = await lane.exited;
  // The leak first, for the reason given in the SIGTERM test above.
  assert.equal(pidAlive(lane.postmasterPid), false);
  await assertNoSegmentFrom(lane.postmasterPid, "SIGINT");
  assert.equal(exit.code, 130, "SIGINT must still read as a signalled failure, not a clean exit");
});

test("a lane SIGTERMed and then SIGKILLed two seconds later still releases its SysV segment", needsPgOrFail(), async t => {
  // The shape of a real bounded runner: the operator's out-of-repo test-slot
  // wrapper and the
  // mutation helper both send SIGTERM, wait a 2 s grace, and then SIGKILL the
  // process group. `pg_ctl start` runs the postmaster with `setsid`, so it is
  // its own session leader with PPID 1 and the group signal does not reach it.
  //
  // What makes this a GUARD rather than a restatement: the lane is not sitting
  // in a tight `setInterval`. A signal handler whose first action is
  // `void stop().finally(...)` yields the event loop at its first `await`, and
  // if the cooperative stop has not completed by the time SIGKILL arrives the
  // postmaster is orphaned with its 56-byte segment. The handler therefore runs
  // the stop SYNCHRONOUSLY, before it yields, and this test is what would notice
  // if that were removed.
  const lane = await startLane(t, "hang");
  assert.equal(pidAlive(lane.postmasterPid), true, "the cluster must be live before the signal is sent");
  process.kill(lane.childPid, "SIGTERM");
  // The runner's grace, then the escalation.
  await new Promise(done => { setTimeout(done, 2_000); });
  // ESRCH means the lane finished its teardown inside the grace, which is the
  // outcome this guard exists to produce rather than a test failure. A harness
  // that escalates blindly signals a group that may already be empty; both must
  // be survivable.
  try { process.kill(lane.childPid, "SIGKILL"); } catch (error) {
    assert.equal(error.code, "ESRCH", `escalation failed for an unexpected reason: ${error.message}`);
  }
  await lane.exited;
  assert.equal(pidAlive(lane.postmasterPid), false,
    "the postmaster must be gone even though its parent was SIGKILLed mid-teardown");
  await assertNoSegmentFrom(lane.postmasterPid, "SIGTERM then SIGKILL after 2s");
});

test("the signal handler runs its cooperative stop before it defers, not after", needsPgOrFail(), async t => {
  // A handler whose first action is `void stop().finally(...)` returns to the
  // event loop at the ladder's first `await`, so the process is killable while
  // the teardown is still in flight. The mutation helper and the operator's
  // test-slot wrapper
  // give a lane exactly two seconds before SIGKILL, and `pg_ctl start` runs the
  // postmaster with `setsid`, so the group signal cannot reach it: a teardown
  // interrupted that way orphans a postmaster and its 56-byte segment.
  //
  // The handler therefore runs `pg_ctl -m fast` through `execFileSync` FIRST.
  //
  // What is asserted here is the ORDER, and it is asserted the only way that
  // does not depend on a stopwatch: a real `pg_ctl -m fast` of a real postmaster
  // completes in well under a second on this machine, so "the postmaster is
  // already gone when the process has exited" is consistent with both orders,
  // and a timing threshold cannot tell them apart. The property that DOES
  // distinguish them is that the stop has happened by the time the handler
  // returns, which is what the segment check below measures — and the mutation
  // recorded in the report is what shows the alternative does not satisfy it.
  //
  // In short: this test proves the leak does not happen, and the mutation log
  // proves the test is not blind. What it does NOT prove is that the stop is
  // synchronous rather than merely fast enough, and that is recorded as
  // uncertain rather than claimed.
  const lane = await startLane(t, "hang");
  assert.equal(pidAlive(lane.postmasterPid), true, "the cluster must be live before the signal is sent");
  process.kill(lane.childPid, "SIGTERM");
  const exit = await lane.exited;
  assert.equal(exit.code, 143, "SIGTERM must still read as a failure, not a clean exit");
  assert.equal(pidAlive(lane.postmasterPid), false,
    "the postmaster must be gone before the process exits, so a SIGKILL after it cannot orphan it");
  await assertNoSegmentFrom(lane.postmasterPid, "signal-handler stop order");
});

test("a lane that calls process.exit() before its own teardown releases its SysV shared-memory segment",
  needsPgOrFail(), async t => {
    // A test runner that fails hard, and any test whose `before` hook returns
    // without reaching `after`, takes this path. The postmaster is started
    // before the exit, and the exit hook is the only thing that can stop it.
    const lane = await startLane(t, "exit");
    await release(lane);
    const exit = await lane.exited;
    assert.equal(exit.code, 0);
    assert.equal(pidAlive(lane.postmasterPid), false,
      "process.on(\"exit\") only runs synchronous work, so the stop must be synchronous too");
    await assertNoSegmentFrom(lane.postmasterPid, "process.exit()");
  });
