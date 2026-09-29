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
//      so both `with-test-slot` and `scripts/dev/cleanup-test-postgres.mjs` can
//      see and stop the cluster;
//   3. teardown stops the postmaster, proves it is gone, and only then removes
//      the directory — from an `after` hook, from `process.on("exit")`, and from
//      SIGINT/SIGTERM;
//   4. a start that loses a port race is retried on a fresh port and data
//      directory rather than being reported as an unrelated-looking failure.
//
// Loopback only: the postmaster is started with `-h 127.0.0.1` and
// `listen_addresses=127.0.0.1`, so the cluster is never reachable off-host. The
// fixture role and its password are synthetic throwaway constants.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const PG_PORT_ENV = "CONTROL_ROOM_TEST_PG_PORT";
/** Where every lane in this module keeps its cluster, relative to the cwd. */
export const TEST_TMP_DIRECTORY = ".test-tmp";
/** Attempts to win a port race before the start is declared failed. */
const PORT_ATTEMPTS = 5;

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
  if (!existsSync(target.data)) return;
  const pid = readPostmasterPidSync(target.data);
  spawnSync(target.pgCtl, ["-D", target.data, "-m", "immediate", "-w", "-t", "60", "stop"],
    { timeout: 60_000, maxBuffer: 1 << 26, encoding: "utf8" });
  if (pid !== undefined) {
    if (isLivePostmaster(pid)) {
      // Refuse to delete a live cluster's data directory: that is the failure
      // mode that leaves a postmaster running against files that no longer
      // exist. Kill the recorded postmaster, then wait for it to actually go.
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    for (let attempt = 0; attempt < 20 && isLivePostmaster(pid); attempt += 1) sleepSync(250);
    if (isLivePostmaster(pid)) return;
  }
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
  await rm(target.run, { recursive: true, force: true });
}

let stopFailure: Error | undefined;

const execOptions = { timeout: 120_000, maxBuffer: 1 << 26, encoding: "utf8" as const };

/** True when a start failed because something else already holds the port.
 * Matched on the message rather than the exit code because pg_ctl reports it
 * through the postmaster's log, not as a distinct status. */
export function isPortConflict(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}` : String(error);
  return /address already in use|EADDRINUSE|could not bind|Address already in use/u.test(text);
}

async function startOnce(port: number, run: string): Promise<Cluster> {
  const data = join(run, "data");
  const socket = join(run, "socket");
  await mkdir(socket, { mode: 0o700 });
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
  const fixturePassword = "disposable-fixture-password";
  const pgCtl = join(PG_BIN!, "pg_ctl");
  try {
    await exec(pgCtl, ["-D", data, "-o",
      `-p ${port} -k ${socket} -h 127.0.0.1 -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
      "-l", join(run, "server.log"), "-w", "-t", "60", "start"], base);
  } catch (error) {
    // pg_ctl may have failed after the postmaster bound the port; never leave
    // that process behind just because the start is being retried.
    stopClusterSync({ run, data, socket, port, pgCtl, fixturePassword });
    throw error;
  }
  // Record the port the postmaster actually bound, not the one we asked for:
  // it is the value the rest of the lane must connect to.
  const bound = await readBoundPort(data);
  if (bound === undefined) {
    stopClusterSync({ run, data, socket, port, pgCtl, fixturePassword });
    throw new Error("disposable_cluster_port_unreadable");
  }
  // Set the synthetic role password over the local socket (trust auth).
  await exec(join(PG_BIN!, "psql"), ["-h", socket, "-p", String(bound), "-U", "fixture_admin",
    "-d", "postgres", "-Atc", `ALTER ROLE fixture_admin PASSWORD '${fixturePassword}';`], execOptions);
  return { run, data, socket, port: bound, pgCtl, fixturePassword };
}

/**
 * Start a disposable cluster whose data directory is inside the worktree.
 *
 * `prefix` names the lane so a leaked directory is identifiable in `ps` and on
 * disk. Throws when every candidate port is taken.
 */
export async function startCluster(prefix = "journey-cluster-"): Promise<Cluster> {
  const root = resolvePath(process.cwd(), TEST_TMP_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const requested = requestedPort();
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = requested ?? await findFreePort();
    const run = await mkdtemp(join(root, prefix));
    try {
      return await startOnce(port, run);
    } catch (error) {
      lastError = error;
      await rm(run, { recursive: true, force: true });
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
 * Returns a function that removes the handlers again, for callers that stop
 * the cluster themselves (the `after` hook).
 */
export function installProcessTeardown(getCluster: () => Cluster | undefined): () => void {
  const onExit = () => { const current = getCluster(); if (current) stopClusterSync(current); };
  const onSignal = (code: number) => () => {
    const current = getCluster();
    if (current) {
      try { stopClusterSync(current); } catch { /* fall through to the conventional exit code */ }
    }
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
