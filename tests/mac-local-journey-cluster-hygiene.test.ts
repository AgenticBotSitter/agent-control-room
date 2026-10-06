// M14 — leak-proofing for the mac-local journey cluster.
//
// What this file proves
// ---------------------
// `tests/mac-local-browser-journeys.test.tsx` used to start its own disposable
// PostgreSQL 17 cluster on a hard-coded loopback port (65431) with the data
// directory in the system temp dir. Two jobs starting at once collided on the
// port, and an interrupted run left a postmaster running with its data dir
// outside any worktree — invisible to the cleanups meant to catch it, and one
// such run survived for an hour.
//
// This file is the acceptance suite for that fix. Each attack scenario in the
// brief is a real test here, and each drives the production helper
// (`tests/helpers/disposable-postgres-cluster.ts`) rather than a stand-in:
//
//   1. two copies of the journey lane at the same time -> both pass, distinct ports
//   2. SIGTERM mid-run -> no postgres left running, data dir removed
//   3. a failing assertion inside the journey -> cluster stopped, data dir removed
//
// Plus a fourth case that the three above all depend on: a run that is killed
// with no teardown hook at all, where only the process `exit` handler can clean
// up. And a fast, PostgreSQL-free set pinning the port resolver.
//
// Real PostgreSQL is required for the scenarios that reach initdb; they carry
// the repo's existing `needs PostgreSQL 17 binaries` skip reason. The exact
// pre-start scenario runs before the first PostgreSQL command and therefore
// remains executable without it. Every child process is killed by recorded pid
// only — never by pattern (standing rule: other jobs run the same programs).

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { findFreePort, isPostmasterAlive, isPortConflict, needsPg, requestedPort, PG_BIN, PG_PORT_ENV,
  stopClusterSync, TEST_TMP_DIRECTORY } from "./helpers/disposable-postgres-cluster";

const SCENARIO = resolve(import.meta.dirname, "fixtures/journey-cluster-scenario.ts");
const JOURNEY = resolve(import.meta.dirname, "mac-local-browser-journeys.test.tsx");
/** The port the old code hard-coded. If a copy of the lane still claims it, the
 * fix has regressed and any parallel run will collide again. */
const RETIRED_PORT = 65_431;
const TEST_TMP = resolve(import.meta.dirname, "..", TEST_TMP_DIRECTORY);

interface Spawned {
  child: ChildProcessByStdio<null, Readable, Readable>;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Recorded postmaster pid, once the scenario has reported its data dir. */
  postmaster: () => number | undefined;
  dataDir: () => string | undefined;
  /** The socket directory the postmaster was pointed at. */
  socketDir: () => string | undefined;
  /** The run directory that holds the data dir, reported by the stall mode. */
  runDir: () => string | undefined;
  /** The port the postmaster bound, as the scenario reported it. */
  port: () => number | undefined;
}

/**
 * The caller's port block, handed out one port per spawned child.
 *
 * CI never sets CONTROL_ROOM_TEST_PG_PORT, so every child asks the OS for a
 * free port and this is inert there. It matters when an operator pins a block
 * (a parallel job that must not collide with anything else on the machine):
 * the tests that deliberately start two clusters at the same time would
 * otherwise both be told to use the same pinned port and collide by
 * construction, because the helper never retries an operator-named port — a
 * named port is a decision, not a suggestion. Handing out the block in order
 * keeps those two apart while still staying inside the block the operator gave.
 */
const pinnedPorts = (() => {
  const start = Number(process.env[PG_PORT_ENV] ?? "");
  if (!Number.isSafeInteger(start) || start < 1024) return undefined;
  let next = start;
  return () => (next <= 65535 ? next++ : undefined);
})();

function spawnScript(script: string, args: string[], environment?: Readonly<Record<string, string | undefined>>): Spawned {
  // Only override the environment when a block is pinned; with nothing pinned,
  // the child inherits an unset variable and resolves its own port.
  const port = pinnedPorts?.();
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    stdio: ["ignore", "pipe", "pipe"], cwd: resolve(import.meta.dirname, ".."),
    ...(environment === undefined && port === undefined ? {}
      : { env: { ...process.env, ...environment, ...(port === undefined ? {} : { [PG_PORT_ENV]: String(port) }) } }),
  });
  let buffer = "";
  child.stdout.on("data", chunk => { buffer += String(chunk); });
  child.stderr.on("data", chunk => { buffer += String(chunk); });
  const read = (key: string) => new RegExp(`^${key}=(.*)$`, "mu").exec(buffer)?.[1]?.trim();
  return {
    child,
    output: () => buffer,
    exited: new Promise(resolveExit => child.once("close", (code, signal) => resolveExit({ code, signal }))),
    postmaster: () => {
      const data = read("SCENARIO_DATA_DIR");
      if (!data) return undefined;
      try {
        const pid = Number(readFileSync(join(data, "postmaster.pid"), "utf8").split("\n")[0]?.trim());
        return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
      } catch { return undefined; }
    },
    dataDir: () => read("SCENARIO_DATA_DIR"),
    socketDir: () => read("SCENARIO_SOCKET_DIR"),
    runDir: () => read("SCENARIO_RUN_DIR"),
    port: () => { const value = Number(read("SCENARIO_PORT")); return Number.isSafeInteger(value) ? value : undefined; },
  };
}

/** Last-resort cleanup for a scenario this test started: stop the postmaster it
 * reported, by recorded pid only, then remove its run directory.
 *
 * This exists because a failing assertion in the middle of a test would
 * otherwise skip the cleanup and leak two clusters — the very failure mode this
 * file exists to catch. Call it from a `finally`, never after an assertion. */
async function stopRun(run: Spawned): Promise<void> {
  const pid = run.postmaster();
  if (pid !== undefined && isPostmasterAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  await run.exited.catch(() => undefined);
  const dataDir = run.dataDir();
  if (dataDir) await rm(join(dataDir, ".."), { recursive: true, force: true });
}

/** Wait for a condition, polling cheaply. Returns false on timeout rather than
 * throwing, so each scenario can assert on the failure itself. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await delay(100);
  }
}

/** True when a postmaster is still running against this data directory. This is
 * the `pgrep -f <datadir>` check from the brief, scoped to the directory the run
 * recorded.
 *
 * A missing pid file does NOT mean "stopped". Teardown that removes the data dir
 * out from under a live postmaster is the single worst outcome here — the
 * process survives with its files gone — and a pid-file-only check would report
 * that as clean. So a missing pid file falls through to a process scan for any
 * postmaster whose command line still names this directory. */
async function postmasterStillRunning(dataDir: string): Promise<boolean> {
  const pidFile = join(dataDir, "postmaster.pid");
  if (existsSync(pidFile)) {
    const pid = Number((await readFile(pidFile, "utf8")).split("\n")[0]?.trim());
    return isPostmasterAlive(Number.isSafeInteger(pid) ? pid : undefined);
  }
  return postmasterReferencesDir(dataDir);
}

/** The port the running postmaster recorded for itself (postmaster.pid line 4).
 * Undefined when there is no pid file to read it from. */
function boundPortInPidFile(dataDir: string): number | undefined {
  try {
    const port = Number((readFileSync(join(dataDir, "postmaster.pid"), "utf8")).split("\n")[3]?.trim());
    return Number.isSafeInteger(port) && port > 0 ? port : undefined;
  } catch { return undefined; }
}

/** Any live postmaster whose command line still names this data directory. */
function postmasterReferencesDir(dataDir: string): boolean {
  try {
    const listing = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 1 << 24 });
    return listing.split("\n").some(line => {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      return match !== null && /(?:\/|^)postgres(?:\s|$)/u.test(match[2]) && match[2].includes(dataDir);
    });
  } catch { return false; }
}

/** Wait until the scenario has reported both a data dir with a live postmaster
 * and its bound port. Waiting for the port *inside* the loop is what stops this
 * racing the child's stdout flush: the port line is written immediately after the
 * data dir line, so requiring both means the buffer has been read. */
async function waitForDataDir(run: Spawned, timeoutMs = 120_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = run.dataDir();
    if (value !== undefined && run.port() !== undefined && existsSync(join(value, "postmaster.pid"))) return value;
    if (Date.now() > deadline) return undefined;
    await delay(100);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: two copies of the lane at the same time.
// ---------------------------------------------------------------------------

test("two copies of the journey lane run at once on distinct ports, and both pass", { skip: needsPg, timeout: 600_000 }, async () => {
  // Two independent copies of the real journey file, started together. Each
  // resolves its own port; neither may fall back to a literal.
  const first = spawnScript(JOURNEY, []);
  const second = spawnScript(JOURNEY, []);
  try {
    const [a, b] = await Promise.all([first.exited, second.exited]);
    assert.equal(a.code, 0, `first copy failed:\n${first.output().slice(-4000)}`);
    assert.equal(b.code, 0, `second copy failed:\n${second.output().slice(-4000)}`);

    // Both green is not the whole claim: a fixed port would also let two runs
    // pass if the first finished before the second started. Assert neither copy
    // ever bound the retired constant, which is what a regression to a literal
    // looks like.
    for (const [label, output] of [["first", first.output()], ["second", second.output()]] as const) {
      assert.doesNotMatch(output, new RegExp(`\\b${RETIRED_PORT}\\b`),
        `${label} copy must not use the retired fixed port ${RETIRED_PORT}`);
    }
    // Nothing of either run may survive.
    for (const run of [first, second]) {
      const dataDir = run.dataDir();
      if (dataDir) assert.equal(existsSync(dataDir), false, `run data dir survived: ${dataDir}`);
    }
  } finally {
    // A regression to a fixed port leaves the *first* copy holding 65431 and
    // still running, which is exactly the M1 mutation failure. Reap both by
    // recorded pid so a red run does not also leak the cluster it found.
    await Promise.all([stopRun(first), stopRun(second)]);
  }
});

test("two clusters started at the same time bind different ports", { skip: needsPg, timeout: 300_000 }, async () => {
  // The direct form of scenario 1: the two lanes' `before` hooks, overlapped.
  // Reading each postmaster's recorded port is stronger than reading the source,
  // because it is what the server actually bound.
  const first = spawnScript(SCENARIO, ["hold"]);
  const second = spawnScript(SCENARIO, ["hold"]);
  try {
    const [firstDir, secondDir] = await Promise.all([waitForDataDir(first), waitForDataDir(second)]);
    assert.ok(firstDir && secondDir, `both clusters must start concurrently:\n${first.output()}\n${second.output()}`);
    const firstPort = first.port()!;
    const secondPort = second.port()!;
    assert.ok(firstPort > 1024 && secondPort > 1024, `both ports must be unprivileged: ${firstPort}, ${secondPort}`);
    assert.notEqual(firstPort, secondPort, "concurrent clusters must not share a port");
    for (const [label, port] of [["first", firstPort], ["second", secondPort]] as const)
      assert.notEqual(port, RETIRED_PORT, `${label} cluster must not bind the retired port`);
  } finally {
    // Cleanup runs even when an assertion above throws: skipping it on the
    // failure path would leak two clusters, which is the defect under test.
    await Promise.all([stopRun(first), stopRun(second)]);
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: SIGTERM mid-run.
// ---------------------------------------------------------------------------

test("a SIGTERM mid-run leaves no postgres running and removes the data dir", { skip: needsPg, timeout: 300_000 }, async () => {
  const run = spawnScript(SCENARIO, ["hold"]);
  try {
    const dataDir = await waitForDataDir(run);
    assert.ok(dataDir, `the scenario must reach a running cluster:\n${run.output()}`);
    const pid = run.postmaster();
    assert.ok(pid !== undefined && pid > 1, "the scenario must report its postmaster pid");
    assert.equal(await postmasterStillRunning(dataDir), true, "precondition: the cluster is running");

    // Signal only the child we spawned, by its recorded pid.
    run.child.kill("SIGTERM");
    const result = await run.exited;
    assert.ok(result.code !== null || result.signal !== null, "the child must actually terminate");

    // The cluster must be gone, and gone for the reason we claim: not merely
    // reaped, but stopped by our own teardown.
    assert.equal(await waitFor(() => !isPostmasterAlive(pid), 30_000), true,
      `the postmaster ${pid} survived SIGTERM; leftover output:\n${run.output()}`);
    assert.equal(await waitFor(() => !existsSync(dataDir), 30_000), true,
      `the data dir survived SIGTERM: ${dataDir}`);
    // The run directory is the parent of the data dir and must be removed too.
    assert.equal(existsSync(join(dataDir, "..")), false, "the run directory survived SIGTERM");
  } finally {
    // If any assertion above threw, the child may still be holding a cluster.
    // Clean it up by recorded pid, so a red run cannot leak a second cluster.
    await stopRun(run);
  }
});

// ---------------------------------------------------------------------------
// Scenario 2b: SIGTERM delivered DURING startup, after the postmaster launch.
//
// This is the window the review found: `startCluster` resolves only once the
// cluster is up, so a caller that assigns its `cluster` variable from the
// resolved promise has nothing for the signal handler to stop. Before the fix
// the handler saw `undefined`, skipped cleanup, and the postmaster survived.
// ---------------------------------------------------------------------------

test("a SIGTERM between the postmaster launch and the start resolving leaves no postmaster and no directories",
  { skip: needsPg, timeout: 300_000 }, async () => {
    const run = spawnScript(SCENARIO, ["stall"]);
    try {
      // The stall mode reports its directories from inside the hook that runs
      // after `pg_ctl start` and before `startCluster` resolves, so by the time
      // these are visible the postmaster is up and the start has NOT returned.
      assert.ok(await waitFor(() => {
        const data = run.dataDir();
        const socket = run.socketDir();
        return data !== undefined && data !== "" && socket !== undefined && socket !== ""
          && (run.runDir() ?? "") !== "";
      }, 180_000), `the stalled start must report its directories:\n${run.output()}`);
      const dataPath = run.dataDir() as string;
      const socketDir = run.socketDir() as string;
      const runDir = run.runDir() as string;
      assert.notEqual(runDir, "", "the stalled start must report its run dir");

      // Preconditions, stated rather than assumed. Both are the defect:
      // a postmaster really is running, and the start really has not resolved.
      assert.equal(existsSync(join(dataPath, "postmaster.pid")), true,
        "precondition: the postmaster was launched before the signal");
      const pid = run.postmaster();
      assert.ok(pid !== undefined && pid > 1, `precondition: a postmaster pid must be readable: ${run.output()}`);
      assert.equal(await postmasterStillRunning(dataPath), true, "precondition: the cluster is running");
      // A resolved start would have finished the psql step that sets the fixture
      // role's password, and would have logged SCENARIO_RESOLVED. Neither has
      // happened, so the start is still in flight. The directory-based checks
      // above already prove a postmaster is up; this proves the PROMISE has not
      // settled, which is the distinction the whole scenario turns on.
      assert.doesNotMatch(run.output(), /SCENARIO_RESOLVED/u,
        "precondition: startCluster must not have resolved yet");
      // The port is reported from inside the launch hook, so it is the requested
      // one. It must be a real port: a scenario that reported nothing here would
      // make every precondition below vacuous.
      const reported = run.port() as number;
      assert.ok(Number.isSafeInteger(reported) && reported > 0,
        `precondition: the stalled start must report its requested port: ${run.output()}`);
      assert.equal(boundPortInPidFile(dataPath), reported,
        "precondition: the postmaster must be up and listening on the requested port");

      // Signal only the child we spawned, by its recorded pid, in the window.
      run.child.kill("SIGTERM");
      const result = await run.exited;
      assert.ok(result.code !== null || result.signal !== null, "the child must actually terminate");

      // No postmaster for this data dir. A missing pid file is not enough on its
      // own, so this also scans for any postmaster still naming the directory.
      assert.equal(await waitFor(async () => !(await postmasterStillRunning(dataPath)), 30_000), true,
        `a postmaster survived a SIGTERM during startup; leftover output:\n${run.output()}`);
      // Both directories. The socket dir is the one the old code could not
      // reach at all, because the signal path skipped cleanup entirely.
      assert.equal(await waitFor(() => !existsSync(dataPath), 30_000), true,
        `the data dir survived a SIGTERM during startup: ${dataPath}`);
      assert.equal(await waitFor(() => !existsSync(runDir), 30_000), true,
        `the run dir survived a SIGTERM during startup: ${runDir}`);
      assert.equal(await waitFor(() => !existsSync(socketDir), 30_000), true,
        `the socket dir survived a SIGTERM during startup: ${socketDir}`);
    } finally {
      await stopRun(run);
    }
  });

// ---------------------------------------------------------------------------
// Scenario 2c: SIGTERM in the pre-start window, before anything is running.
// ---------------------------------------------------------------------------

test("a SIGTERM right after the run directory is created removes the run directory",
  { timeout: 180_000 }, async () => {
    // The window between the run dir existing and the socket dir existing. No
    // postmaster has been launched, so this cannot be about a surviving process:
    // it is about the two directories, which survive unless the run is
    // registered the moment it is created. The helper pauses at its own exact
    // post-registration checkpoint, so the fixture can self-signal before the
    // socket operation or any PostgreSQL child begins.
    // The checkpoint is before the first PostgreSQL command, so three marker
    // files are enough for the child module's availability probe. This keeps
    // the regression executable even on hosts without PostgreSQL and proves no
    // database process is needed for this pre-start case.
    const pgBin = await mkdtemp(join(tmpdir(), "crpg-early-bin-"));
    await Promise.all(["initdb", "pg_ctl", "postgres"].map(name => writeFile(join(pgBin, name), "", "utf8")));
    const run = spawnScript(SCENARIO, ["early"], { PG_BIN: pgBin });
    try {
      const result = await run.exited;
      assert.deepEqual(result, { code: 143, signal: null },
        "the installed SIGTERM handler must perform cleanup and exit conventionally");
      const runDir = run.runDir();
      assert.ok(runDir, `the early scenario must report its run dir:\n${run.output()}`);
      assert.equal(run.socketDir(), "", "precondition: the socket directory must not have been assigned");
      assert.equal(await waitFor(() => !existsSync(runDir!), 30_000), true,
        `the run dir survived a SIGTERM in the pre-start window: ${runDir}`);
    } finally {
      await stopRun(run);
      await rm(pgBin, { recursive: true, force: true });
    }
  });

// ---------------------------------------------------------------------------
// Scenario 3: a failing assertion inside the journey.
// ---------------------------------------------------------------------------

test("a failing assertion still stops the cluster and removes the data dir", { skip: needsPg, timeout: 300_000 }, async () => {
  const run = spawnScript(SCENARIO, ["fail"]);
  try {
    const result = await run.exited;
    assert.notEqual(result.code, 0, "the deliberately failing scenario must exit non-zero");
    const dataDir = run.dataDir();
    assert.ok(dataDir, `the scenario must have started a cluster:\n${run.output()}`);
    // No postmaster, and the data dir is gone: a teardown that ran because the
    // runner reached `after`, not in spite of the failure.
    assert.equal(await postmasterStillRunning(dataDir), false, "a failed run must not leave its postmaster running");
    assert.equal(existsSync(join(dataDir, "..")), false, `a failed run must remove its data dir: ${dataDir}`);
  } finally {
    // If the scenario's own teardown is what regressed, this is where its
    // leaked cluster gets reaped — otherwise the failing test would leave the
    // very leak it is complaining about behind.
    await stopRun(run);
  }
});

test("a run with no teardown hook at all is still cleaned up by the exit handler", { skip: needsPg, timeout: 300_000 }, async () => {
  // The interrupted-run case the incident describes: the process goes away with
  // no `after` to run. The `process.on("exit")` handler is the only teardown
  // that can fire, and the data dir must not be left in the system temp dir.
  const run = spawnScript(SCENARIO, ["idle"]);
  try {
    const result = await run.exited;
    assert.equal(result.code, 0, `the idle scenario must exit cleanly:\n${run.output()}`);
    const dataDir = run.dataDir();
    assert.ok(dataDir, `the scenario must have started a cluster:\n${run.output()}`);
    assert.equal(existsSync(join(dataDir, "..")), false, "the exit handler must remove the data dir");
    // The data dir is what identifies the cluster to every cleanup, so it must be
    // the worktree-local one. The socket dir is deliberately elsewhere: see
    // SOCKET_PREFIX in the helper.
    assert.ok(dataDir.startsWith(TEST_TMP), `the data dir must live in the worktree, not the temp dir: ${dataDir}`);
  } finally {
    await stopRun(run);
  }
});

test("the socket directory stays inside the platform's Unix-socket path budget", async () => {
  // Regression guard for a bug this file's own CI run found: the socket
  // directory used to live under the worktree, and Linux caps a Unix-domain
  // socket path at 107 bytes (sun_path). At the CI checkout path
  // (/home/runner/work/agent-control-room/agent-control-room/...) the resulting
  // path was 116 bytes, so every scenario failed with the postmaster's
  // "could not create any Unix-domain sockets" — while passing on macOS, where
  // the limit is not hit. The data dir must stay in the worktree (that is what
  // `with-test-slot` identifies a cluster by); the socket dir must not.
  const run = spawnScript(SCENARIO, ["hold"]);
  try {
    const dataDir = await waitForDataDir(run);
    assert.ok(dataDir, `the scenario must reach a running cluster:\n${run.output()}`);
    const socketDir = run.socketDir();
    assert.ok(socketDir, `the scenario must report its socket dir:\n${run.output()}`);
    // The real bound: the postmaster appends `/.s.PGSQL.<port>`, up to 16 bytes.
    const budget = 107;
    const worstCase = join(socketDir, ".s.PGSQL.65535");
    assert.ok(worstCase.length <= budget,
      `the socket path must fit sun_path on Linux, got ${worstCase.length} > ${budget}: ${worstCase}`);
    // And the data dir is still the worktree-local one the cleanup depends on.
    assert.ok(dataDir.startsWith(TEST_TMP), `the data dir must stay in the worktree: ${dataDir}`);
  } finally {
    await stopRun(run);
  }
});

// ---------------------------------------------------------------------------
// The port resolver, which all of the above depend on. No PostgreSQL needed.
// ---------------------------------------------------------------------------

test("stopping a run with no data directory still removes the run and socket directories", async () => {
  // The exit path's own contract, checked directly rather than only through a
  // signalled child. A run interrupted before `initdb` has no data dir, so
  // `stopClusterSync` cannot stop anything — but it must still remove both
  // directories, and the pid-file branch must not run `pg_ctl` against a
  // directory that holds no cluster (which would block for its full timeout).
  const runRoot = TEST_TMP;
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(join(runRoot, "stop-unit-"));
  const socket = await mkdtemp(join(tmpdir(), "crpg-unit-"));
  const stoppedAt = Date.now();
  stopClusterSync({ run, data: join(run, "data"), socket, port: 56180,
    pgCtl: join(PG_BIN ?? "", "pg_ctl"), fixturePassword: "disposable-fixture-password" });
  assert.equal(existsSync(run), false, "the run directory must be removed even with no data dir");
  assert.equal(existsSync(socket), false, "the socket directory must be removed even with no data dir");
  // The guard that keeps this fast: no pg_ctl wait against an absent cluster.
  assert.ok(Date.now() - stoppedAt < 5_000,
    `stopping an unstarted run must not block on pg_ctl (took ${Date.now() - stoppedAt}ms)`);
});

test("the port comes from the environment variable, and a bad one is refused loudly", () => {
  assert.equal(requestedPort({}), undefined, "an unset variable must mean 'find a port at runtime'");
  assert.equal(requestedPort({ CONTROL_ROOM_TEST_PG_PORT: "" }), undefined, "an empty value means 'find one'");
  assert.equal(requestedPort({ CONTROL_ROOM_TEST_PG_PORT: "  " }), undefined, "whitespace means 'find one'");
  assert.equal(requestedPort({ CONTROL_ROOM_TEST_PG_PORT: "56181" }), 56181, "an explicit port is honoured");
  // A typo in CI must fail loudly rather than silently becoming a random port.
  for (const bad of ["0", "80", "1023", "65536", "-1", "56180.5", "postgres", "56_180", "" + RETIRED_PORT + "x"]) {
    assert.throws(() => requestedPort({ CONTROL_ROOM_TEST_PG_PORT: bad }),
      /CONTROL_ROOM_TEST_PG_PORT_invalid/u, `the value ${JSON.stringify(bad)} must be refused`);
  }
});

test("a runtime port is unprivileged, loopback-safe, and really free", async () => {
  const port = await findFreePort();
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535,
    `a runtime port must be an unprivileged TCP port, got ${port}`);
  // It is a hint, not a reservation, so the only honest claim is that it was
  // free when the kernel handed it out — which the second probe demonstrates.
  const second = await findFreePort();
  assert.notEqual(port, second, "each probe must ask the kernel for a fresh port");
  // The retired constant must not be handed out as a default.
  assert.notEqual(port, RETIRED_PORT, "the retired fixed port must not be special-cased anywhere");
});

test("port conflicts are recognised so a start can be retried on a fresh port", () => {
  assert.equal(isPortConflict(new Error("pg_ctl: could not start server\naddress already in use")), true);
  assert.equal(isPortConflict(Object.assign(new Error("boom"), { stderr: "FATAL:  bind: Address already in use" })), true);
  // The case that matters and that a hand-written string missed: `pg_ctl -l`
  // sends the postmaster's complaint to server.log, so the rejection carries
  // only "could not start server" and the decisive line is in the attached log.
  // Captured verbatim from a real collision on this machine.
  const realLog = [
    "2026-09-28 20:34:43.161 MDT [85057] LOG:  starting PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0",
    '2026-09-28 20:34:43.161 MDT [85057] LOG:  could not bind IPv4 address "127.0.0.1": Address already in use',
    "2026-09-28 20:34:43.161 MDT [85057] HINT:  Is another postmaster already running on port 64702? If not, wait a few seconds and retry.",
    "2026-09-28 20:34:43.161 MDT [85057] FATAL:  could not create any TCP/IP sockets",
  ].join("\n");
  const bareRejection = Object.assign(new Error("Command failed: /opt/homebrew/bin/pg_ctl -D <data> -o -p 64702 ... start\npg_ctl: could not start server\nExamine the log output.\n"), { stderr: "pg_ctl: could not start server\nExamine the log output.\n" });
  assert.equal(isPortConflict(bareRejection), false,
    "the rejection alone is not enough — it never carries the reason");
  assert.equal(isPortConflict(Object.assign(bareRejection, { serverLog: realLog })), true,
    "the real postmaster log must be what identifies a port conflict");
  // An unrelated failure must not be mistaken for a race, or a genuine defect
  // would be retried five times and still reported as a port problem.
  assert.equal(isPortConflict(new Error('pg_hba.conf must still contain a stock loopback TCP rule')), false,
    "an unrelated failure must not be mistaken for a port race and retried");
  assert.equal(isPortConflict(new Error("initdb: directory exists but is not empty")), false);
  assert.equal(isPortConflict(new Error("initdb: could not create shared memory segment")), false);
});

test("the journey lane no longer hard-codes a PostgreSQL port", async () => {
  // A source-level guard for the literal the incident was found on: the fix must
  // not be undone by someone re-adding a constant "for stability".
  const source = await readFile(JOURNEY, "utf8");
  assert.doesNotMatch(source, /\b65_?431\b/u, "the retired fixed port must not reappear in the journey lane");
  assert.doesNotMatch(source, /\btmpdir\(\)/u, "the journey lane must not put its cluster in the system temp dir");
  assert.match(source, /disposable-postgres-cluster/u, "the journey lane must use the shared cluster helper");
});
