// Shared disposable-cluster lifecycle for the mac-local journey lanes.
//
// Why this file exists
// --------------------
// `tests/mac-local-browser-journeys.test.tsx` used to start its own PostgreSQL 17
// cluster on a hard-coded loopback port (65431) with the data directory in the
// system temp dir. Two jobs starting at once collided on the port, and an
// interrupted run left a postmaster running with its data dir outside any
// worktree, invisible to the cleanups that are supposed to catch it. This module
// makes the four properties that fix it explicit and reusable:
//
//   1. the listen port comes from `CONTROL_ROOM_TEST_PG_PORT` or from a port the
//      OS hands out at runtime — never a literal;
//   2. the data directory lives under `<cwd>/.test-tmp/`, which is gitignored,
//      so `with-test-slot` — which only stops postmasters whose -D is under its
//      $PWD — can still see and stop a cluster the in-process teardown missed;
//   3. teardown stops the postmaster, proves it is gone, and only then removes
//      the directory — from an `after` hook, from `process.on("exit")`, and from
//      SIGINT/SIGTERM. A run is REGISTERED BEFORE it starts, so a signal that
//      lands between the postmaster launch and the resolution of the start
//      promise still finds the cluster it has to stop;
//   4. a start that loses a port race is retried on a fresh port and data
//      directory rather than being reported as an unrelated-looking failure.
//
// What this does NOT do: `scripts/dev/cleanup-test-postgres.mjs` still will not
// see these clusters. It only treats a data directory as disposable when it is
// under `os.tmpdir()` or carries a `mac-local-rehearsal` marker, and a test
// lane writes neither. The teardown below is what stops them.
//
// Loopback only: the postmaster is started with `-h 127.0.0.1` and
// `listen_addresses=127.0.0.1`, so the cluster is never reachable off-host. The
// fixture role and its password are synthetic throwaway constants.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const PG_PORT_ENV = "CONTROL_ROOM_TEST_PG_PORT";
/** Where every lane in this module keeps its cluster, relative to the cwd. */
export const TEST_TMP_DIRECTORY = ".test-tmp";
/** Attempts to win a port race before the start is declared failed. */
const PORT_ATTEMPTS = 5;

/** The throwaway password every disposable cluster's fixture role gets. It is a
 * synthetic test constant, never a real credential. Named once so the
 * pre-start registry entry and the started cluster cannot drift apart. */
const FIXTURE_PASSWORD = "disposable-fixture-password";

/**
 * Every run this process has created and not yet finished, registered BEFORE
 * its first `exec` and removed only once it is stopped and its directories are
 * gone. Keyed by run directory, not by object identity: `startCluster` builds
 * the entry it registers and `startOnce` builds the one it returns, and a
 * caller's `stopCluster` is given the latter.
 *
 * The window this closes: `startCluster` only returns once the cluster is up, so
 * a caller that assigns its `cluster` variable from the resolved promise has
 * nothing to clean up until then. A SIGTERM landing after `pg_ctl` has launched
 * the postmaster but before that promise settles therefore saw `undefined` from
 * the getter, skipped the teardown entirely, and left a postmaster running with
 * a socket directory in the temp dir. The registry is written on the way IN,
 * which is the only moment at which the directories — and therefore the pid file
 * the postmaster will write into the data dir — are known, and it is read by the
 * exit/signal path, which is the only code that can still run once the caller
 * has been signalled away.
 */
const inProgressRuns = new Map<string, Cluster>();

function forgetRun(target: Cluster): void { inProgressRuns.delete(target.run); }

/** Stop and remove a run that has not finished starting, then forget it.
 *
 * The postmaster pid comes from the pid file on disk rather than from the
 * Cluster object, because an interrupted start may never have recorded a bound
 * port: the pid file is the only record that a postmaster was launched, and
 * `stopClusterSync` copes with its absence (a run whose postmaster never started
 * has nothing to stop, only two directories to remove). */
function stopInProgressRunSync(run: Cluster): void {
  try { stopClusterSync(run); } catch { /* an exit path must never throw */ }
  inProgressRuns.delete(run.run);
}

/** Stop every run that was started and not yet stopped, in one pass.
 *
 * The exit and signal handlers call this, so it is the path that has to cover a
 * start still in flight as well as one the caller already holds. It is exported
 * so a caller that wants belt-and-braces coverage can call it before relying on
 * its own `after` hook having run. */
export function stopUnfinishedRunsSync(): void {
  for (const run of [...inProgressRuns.values()]) stopInProgressRunSync(run);
}

/** Called by `startCluster` the moment the postmaster is running, while the
 * start is still in flight and the registry is the only record of it.
 *
 * This exists for the acceptance test, and for nothing else: a lane has no use
 * for a callback in the middle of its own start, and adding a general-purpose
 * hook to production-shaped code to make a test possible is exactly the sort of
 * seam that later gets driven by something other than the test. It is placed
 * after `pg_ctl -w start` returns, which is the first instant at which a
 * postmaster exists and the last one before `startCluster` resolves.
 *
 * The handle is the in-flight run itself, not a view of the registry: a test
 * that had to consult the registry to learn which directories to assert on
 * could not observe anything in the state this hook exists to detect, so its
 * precondition would be circular. */
export type PostmasterLaunchHook = (inFlight: Cluster) => void | Promise<void>;

/**
 * PG_BIN is how the repo's own live-cluster tests (package.json
 * `test:postgres-production`) locate PostgreSQL. Homebrew's bin directory
 * holds initdb/pg_ctl/psql directly, so probe both shapes.
 */
export function resolvePostgresBin(): string | undefined {
  const candidates = [process.env.PG_BIN, "/opt/homebrew/bin", "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin"].filter((value): value is string => !!value);
  for (const dir of candidates) {
    if (existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl")) && existsSync(join(dir, "postgres")))
      return dir;
  }
  return undefined;
}

export const PG_BIN = resolvePostgresBin();
export const PG_AVAILABLE = PG_BIN !== undefined;
// The repo's own PG tests pass this as the `skip` argument; keep the same
// convention so a missing PostgreSQL reads as a loud skip, never green.
export const needsPg = PG_AVAILABLE ? false :
  "needs PostgreSQL 17 binaries (PG_BIN, /opt/homebrew/bin, or /usr/lib/postgresql/17/bin)";

export interface Cluster {
  run: string;
  data: string;
  socket: string;
  /** The port this cluster actually bound, as reported by its own postmaster. */
  port: number;
  pgCtl: string;
  fixturePassword: string;
}

/**
 * Read the requested port from the environment, or nil to mean "find one at
 * runtime". Rejects anything that is not a usable unprivileged TCP port instead
 * of silently falling through to a random port: a typo in CI must be loud, not
 * quietly different from what the operator asked for.
 */
export function requestedPort(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = (env[PG_PORT_ENV] ?? "").trim();
  if (raw === "") return undefined;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error(`${PG_PORT_ENV}_invalid: ${JSON.stringify(raw)} must be an integer in 1024..65535`);
  return port;
}

/**
 * Ask the kernel for a free loopback port. The listener is closed before the
 * port is returned, so the value is a strong hint rather than a reservation —
 * which is why {@link startCluster} retries instead of trusting it.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("disposable_cluster_port_probe_failed")));
        return;
      }
      const { port } = address;
      probe.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

/** The port a running postmaster recorded for itself (postmaster.pid line 4). */
async function readBoundPort(data: string): Promise<number | undefined> {
  try {
    const lines = (await readFile(join(data, "postmaster.pid"), "utf8")).split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isSafeInteger(port) && port > 0 ? port : undefined;
  } catch { return undefined; }
}

async function readPostmasterPid(target: Cluster): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(join(target.data, "postmaster.pid"), "utf8")).split("\n")[0]?.trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  } catch { return undefined; }
}

/** A pid is only "alive" if it exists AND is the postgres postmaster, so a
 * recycled pid belonging to something else can never be reported as ours. */
export function isPostmasterAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  return isLivePostmaster(pid);
}

function isLivePostmaster(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return /\bpostgres\b/u.test(command);
  } catch { return false; }
}

/** The synchronous stop used from `process.on("exit")` and the signal handlers,
 * where promises would never settle. pg_ctl puts the postmaster in its own
 * process group, so this addresses the one recorded data directory and nothing
 * else.
 *
 * It also removes the run directory, because the exit path has no chance to
 * finish async work afterwards: stopping the postmaster but leaving the data
 * dir behind would hand the next run a stale directory and make the incident
 * this module exists to fix look half-fixed. Removing the directory is only safe
 * once the postmaster is confirmed gone, which is checked here explicitly. */
export function stopClusterSync(target: Cluster): void {
  // The pid file is the single authority on "is there a postmaster to stop?".
  // Reading it needs the data dir, so a run interrupted before `initdb` wrote
  // anything reads as `undefined` and there is nothing to stop — but the socket
  // dir and the run dir still have to go, and the early return this replaced
  // used to leave both behind on every signal in the pre-start window.
  //
  // That same guard keeps this fast: `pg_ctl -w stop` waits its full 60 s for a
  // postmaster that will never answer, and a data dir initdb has not finished
  // writing is exactly that. Calling pg_ctl at all in that state turned a
  // signal into a one-minute hang before the directories were removed.
  const pid = readPostmasterPidSync(target.data);
  if (pid !== undefined) {
    spawnSync(target.pgCtl, ["-D", target.data, "-m", "immediate", "-w", "-t", "60", "stop"],
      { timeout: 60_000, maxBuffer: 1 << 26, encoding: "utf8" });
    if (isLivePostmaster(pid)) {
      // Refuse to delete a live cluster's data directory: that is the failure
      // mode that leaves a postmaster running against files that no longer
      // exist. Kill the recorded postmaster, then wait for it to actually go.
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    for (let attempt = 0; attempt < 20 && isLivePostmaster(pid); attempt += 1) sleepSync(250);
    if (isLivePostmaster(pid)) return;
  }
  // The socket dir lives outside the run dir, so it is removed explicitly.
  rmSync(target.socket, { recursive: true, force: true });
  rmSync(target.run, { recursive: true, force: true });
}

function readPostmasterPidSync(data: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(data, "postmaster.pid"), "utf8").split("\n")[0]?.trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  } catch { return undefined; }
}

/** Atomics.wait is the only sleep that works while the process is exiting. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Stop the cluster and prove it is gone before the data directory is removed.
 *
 * A swallowed stop failure used to be followed by `rm` anyway, which could
 * delete the socket and data directory out from under a still-running
 * postmaster, leave an unreaped process and a bound port behind, and make the
 * next run fail with an unrelated-looking EADDRINUSE. Teardown now fails loudly
 * instead: it falls back to the recorded postmaster pid, verifies the process is
 * gone, and only then removes the directory. */
export async function stopCluster(target: Cluster): Promise<void> {
  const pid = await readPostmasterPid(target);
  const stopped = await exec(target.pgCtl, ["-D", target.data, "-m", "immediate", "-w", "-t", "60", "stop"],
    { timeout: 120_000, maxBuffer: 1 << 26, encoding: "utf8" }).then(() => true,
      (error: Error) => { stopFailure = error; return false; });
  if (!stopped) {
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    // Give the kernel a moment to release the listening socket.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isPostmasterAlive(pid)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (isPostmasterAlive(pid))
      throw new Error(`disposable_cluster_stop_failed: ${stopFailure?.message ?? "postmaster still alive"}`);
  }
  if (isPostmasterAlive(pid))
    throw new Error("disposable_cluster_survived_teardown");
  // The socket dir lives outside the run dir, so it is removed explicitly.
  await rm(target.socket, { recursive: true, force: true });
  await rm(target.run, { recursive: true, force: true });
  // Forgetting the run is what keeps a normal teardown from leaving a stale
  // entry that the exit handler would try to stop a second time.
  forgetRun(target);
}

let stopFailure: Error | undefined;

const execOptions = { timeout: 120_000, maxBuffer: 1 << 26, encoding: "utf8" as const };

/** True when a start failed because something else already holds the port.
 *
 * The message has to be read from the postmaster's own log, not from the
 * rejection: `pg_ctl -l` redirects postmaster output to that file, so a real
 * collision surfaces as a bare `pg_ctl: could not start server` on stderr. A
 * probe of a real collision (block the port, then start a cluster on it) shows
 * the decisive line is only ever in `server.log`:
 *
 *   LOG:  could not bind IPv4 address "127.0.0.1": Address already in use
 *   HINT: Is another postmaster already running on port 64702?
 *
 * Matching only the rejection would therefore never fire, leaving the retry
 * loop dead code and a lost race to surface as an unrelated-looking failure. */
export function isPortConflict(error: unknown, logText = ""): boolean {
  const attached = typeof error === "object" && error !== null
    ? String((error as { serverLog?: string }).serverLog ?? "")
    : "";
  const text = error instanceof Error
    ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}\n${attached}\n${logText}`
    : `${String(error)}\n${attached}\n${logText}`;
  return /address already in use|EADDRINUSE|could not bind|could not create any TCP\/IP sockets/iu.test(text);
}

/** Linux caps a Unix-domain socket path at 107 bytes (108 incl. the NUL in
 * `sun_path`). The postmaster only reports the consequence — "could not create
 * any Unix-domain sockets" — after initdb has already run, so an over-long
 * checkout path fails as a confusing server error rather than a clear one.
 *
 * The socket directory therefore lives in the system temp dir under a short
 * prefix, NOT under the worktree. That is safe because the socket is ephemeral
 * (a `.s.PGSQL.<port>` file removed with the run) and is not what any cleanup
 * identifies a cluster by: both `with-test-slot` and
 * scripts/dev/cleanup-test-postgres.mjs key off the `-D` data directory, which
 * stays in the worktree. */
const SOCKET_PREFIX = "crpg-";
/** `.s.PGSQL.<port>` is up to 16 bytes; keep room for it inside sun_path. */
const SOCKET_PATH_BUDGET = 100;

async function startOnce(port: number, run: string, socket: string,
  afterPostmasterLaunch?: PostmasterLaunchHook): Promise<Cluster> {
  const data = join(run, "data");
  const socketFile = join(socket, `.s.PGSQL.${port}`);
  if (socketFile.length > SOCKET_PATH_BUDGET)
    throw new Error(`disposable_cluster_socket_path_too_long: ${socketFile.length} bytes exceeds the ${
      SOCKET_PATH_BUDGET}-byte budget for a Unix-domain socket; the temp dir is unusually deep`);
  await mkdir(socket, { recursive: true, mode: 0o700 });
  const base = { env: { ...process.env, PATH: "/usr/bin:/bin:/opt/homebrew/bin", LC_ALL: "C", TMPDIR: run,
    NODE_ENV: "test" as const }, ...execOptions };
  // initdb into a worktree-local directory only. `-U fixture_admin` is a
  // synthetic role; the password set below is a throwaway constant, never a
  // real credential.
  await exec(join(PG_BIN!, "initdb"), ["-D", data, "-U", "fixture_admin", "-E", "UTF8", "--auth-local=trust"], base);
  // Loopback-only TCP with scram. initdb with --auth-local=trust writes a
  // stock pg_hba.conf whose loopback TCP rule is `trust` (with --auth-host=reject
  // it is `reject` instead). pg_hba is first-match-wins, so rewrite whatever the
  // stock loopback TCP rule is rather than appending a line that never applies.
  const hba = join(data, "pg_hba.conf");
  const stock = await readFile(hba, "utf8");
  const patched = stock.replace(/^(host\s+all\s+all\s+127\.0\.0\.1\/32\s+)\S+(\s*)$/m,
    "host    all             all             127.0.0.1/32            scram-sha-256$2");
  if (patched === stock)
    throw new Error("disposable_cluster_pg_hba_unpatchable: pg_hba.conf must still contain a stock loopback TCP rule");
  await writeFile(hba, patched, "utf8");
  const fixturePassword = FIXTURE_PASSWORD;
  const pgCtl = join(PG_BIN!, "pg_ctl");
  const cluster: Cluster = { run, data, socket, port, pgCtl, fixturePassword };
  try {
    await exec(pgCtl, ["-D", data, "-o",
      `-p ${port} -k ${socket} -h 127.0.0.1 -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
      "-l", join(run, "server.log"), "-w", "-t", "60", "start"], base);
    // A postmaster now exists and `startCluster` has not resolved yet. This is
    // the window a signal has to survive, so it is the window the acceptance
    // test drives from. The hook is passed the in-flight run itself, which the
    // registry already holds.
    if (afterPostmasterLaunch) await afterPostmasterLaunch(cluster);
    // Record the port the postmaster actually bound, not the one we asked for:
    // it is the value the rest of the lane must connect to.
    const bound = await readBoundPort(data);
    if (bound === undefined) throw new Error("disposable_cluster_port_unreadable");
    cluster.port = bound;
    // Set the synthetic role password over the local socket (trust auth).
    await exec(join(PG_BIN!, "psql"), ["-h", socket, "-p", String(bound), "-U", "fixture_admin",
      "-d", "postgres", "-Atc", `ALTER ROLE fixture_admin PASSWORD '${fixturePassword}';`], execOptions);
    return cluster;
  } catch (error) {
    // The guard has to span every step after initdb, not just the pg_ctl call.
    // Once the postmaster is up it owns the port and the data directory, and
    // `startCluster` removes the run directory on the way out — so a failure in
    // the port read or the psql call used to delete a live cluster's files and
    // leave an unreapable postmaster behind, the exact mode this module exists
    // to prevent. Stopping here is what makes the caller's `rm` safe.
    //
    // Read the postmaster log BEFORE stopping: the decisive "address already in
    // use" line only exists there, and stopping removes the run directory.
    const log = await readFile(join(run, "server.log"), "utf8").catch(() => "");
    stopClusterSync(cluster);
    throw withLog(error, log);
  }
}

/** Attach the postmaster log to the error so the retry decision in
 * `startCluster` can see a port conflict after the run directory is gone. */
function withLog(error: unknown, log: string): unknown {
  if (!log || typeof error !== "object" || error === null) return error;
  (error as { serverLog?: string }).serverLog = log;
  return error;
}

/**
 * Start a disposable cluster whose data directory is inside the worktree.
 *
 * `prefix` names the lane so a leaked directory is identifiable in `ps` and on
 * disk. Throws when every candidate port is taken.
 *
 * Known trade-off, accepted deliberately: because the data directory is now
 * under the worktree, `with-test-slot` will stop this cluster on the way out if
 * a run is interrupted — it reaps any postmaster whose -D is under its $PWD
 * that appeared since it took its snapshot, regardless of which process started
 * it. Two jobs sharing one worktree and running this lane simultaneously can
 * therefore have one job's reaper stop the other job's cluster. The brief
 * requires the worktree location (it is what makes the reaper able to see the
 * cluster at all), so this is inherent to the fix rather than a bug in it. Jobs
 * that need isolation should use separate worktrees.
 */
export interface StartClusterOptions {
  /** Runs inside the start, after the postmaster has been launched and before
   * the returned promise resolves. Used only by the acceptance test that drives
   * a signal through that window; a lane has no reason to pass it. */
  afterPostmasterLaunch?: PostmasterLaunchHook;
}

export async function startCluster(prefix = "journey-cluster-",
  options: StartClusterOptions = {}): Promise<Cluster> {
  const root = resolvePath(process.cwd(), TEST_TMP_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const requested = requestedPort();
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = requested ?? await findFreePort();
    const run = await mkdtemp(join(root, prefix));
    // REGISTER THE MOMENT THE RUN DIRECTORY EXISTS — before the socket
    // `mkdtemp` below, which is an `await` and therefore a point at which a
    // SIGTERM can be delivered. A signal landing in that gap used to leave an
    // empty run dir and an empty socket dir behind on every single run, because
    // neither path had been recorded anywhere yet. Registering after the socket
    // dir, as this did at first, is exactly the sub-window that leak lived in.
    //
    // The socket path is a sibling of the data dir, in the system temp dir, so
    // its path stays inside the platform's sun_path budget on a deep checkout.
    // It is created next, and the same registered entry — mutated in place
    // rather than replaced, so a signal handler holding this exact object still
    // sees the socket dir once it exists — picks it up.
    const started: Cluster = { run, data: join(run, "data"), socket: "", port, pgCtl: join(PG_BIN!, "pg_ctl"),
      fixturePassword: FIXTURE_PASSWORD };
    inProgressRuns.set(run, started);
    let socket: string;
    try {
      socket = await mkdtemp(join(tmpdir(), SOCKET_PREFIX));
    } catch (error) {
      // The run dir already exists and is registered, so the exit path can still
      // clean it; forgetting it here would hand the next run a stale directory.
      inProgressRuns.delete(run);
      await rm(run, { recursive: true, force: true });
      throw error;
    }
    started.socket = socket;
    try {
      const cluster = await startOnce(port, run, socket, options.afterPostmasterLaunch);
      // Still registered: the caller's `after` hook and the process teardown
      // must both be able to stop it until the caller has stopped it itself.
      // `stopCluster` forgets the run by its run directory, so a caller that
      // tears down normally does not leave a stale entry for the exit handler
      // to stop a second time.
      return cluster;
    } catch (error) {
      lastError = error;
      inProgressRuns.delete(run);
      await rm(run, { recursive: true, force: true });
      await rm(socket, { recursive: true, force: true });
      // An operator-named port is a decision, not a suggestion: retrying it
      // would just burn attempts on the same collision.
      if (requested !== undefined || !isPortConflict(error)) throw error;
    }
  }
  throw new Error(`disposable_cluster_start_failed: no free port after ${PORT_ATTEMPTS} attempts: ${
    lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Install the process-level teardown for a cluster: a synchronous stop on
 * `exit`, and SIGINT/SIGTERM handlers that stop the cluster and then re-raise
 * with the conventional code so the parent still sees a signal death.
 *
 * Every path drains the in-progress registry as well as the caller's getter.
 * That is the whole point: the getter is `undefined` for the entire window
 * between `pg_ctl` launching the postmaster and the caller's `await` resolving,
 * and a signal arriving in that window used to skip cleanup and leave the
 * postmaster running. The registry is populated before startup begins, so the
 * registry — not the getter — is what makes an interrupted start recoverable.
 *
 * Returns a function that removes the handlers again, for callers that stop
 * the cluster themselves (the `after` hook).
 */
export function installProcessTeardown(getCluster: () => Cluster | undefined): () => void {
  const onExit = () => {
    const current = getCluster();
    if (current) stopClusterSync(current);
    // Registered-before-start runs, and any the getter no longer covers.
    stopUnfinishedRunsSync();
  };
  const onSignal = (code: number) => () => {
    const current = getCluster();
    if (current) {
      try { stopClusterSync(current); } catch { /* fall through to the conventional exit code */ }
    }
    try { stopUnfinishedRunsSync(); } catch { /* fall through to the conventional exit code */ }
    process.exit(code);
  };
  const onSigint = onSignal(130);
  const onSigterm = onSignal(143);
  process.on("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}
