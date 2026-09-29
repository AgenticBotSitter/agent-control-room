// Disposable real-PostgreSQL runner for tests.
//
// Every cluster this module starts is socket-only, bound to a port the caller
// names, initialised into a fresh temp directory, and destroyed afterwards —
// including when the body throws, when the body exceeds its bound, and on
// SIGINT/SIGTERM, each of which is proven by a test in tests/attack-kit.test.ts.
// It never reads a connection string from the environment, never touches the
// live application, and never reuses a cluster it did not start.
//
// Skipping is explicit rather than silent. `requiresRealPostgres()` is the
// question a CI lane with PostgreSQL installed must be able to answer "yes" to;
// a lane that has the binaries and still skips is a broken lane, so the tests
// call the helper and fail rather than reporting a green skip.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, appendFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { applyMigrations } from "../../../deploy/postgres/apply-migrations.mjs";

const exec = promisify(execFile);

/** tests/support/attack-kit -> repository root. */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const PG_CANDIDATE_BINS = Object.freeze([
  process.env.PG_BIN,
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
  "/opt/homebrew/bin",
].filter((value): value is string => typeof value === "string" && value.length > 0));

export const REPOSITORY_DATABASE_NAME = "control_room";

/** Synthetic fixture credentials. Never real credentials, never printed. */
const FIXTURE_ADMIN_PASSWORD = randomBytes(24).toString("base64url");
const ROLE_PASSWORDS = Object.freeze({
  control_room_migrator: randomBytes(24).toString("base64url"),
  control_room_app: randomBytes(24).toString("base64url"),
  control_room_scheduler: randomBytes(24).toString("base64url"),
  control_room_web: randomBytes(24).toString("base64url"),
  control_room_coordinator: randomBytes(24).toString("base64url"),
  control_room_results: randomBytes(24).toString("base64url"),
  control_room_publisher: randomBytes(24).toString("base64url"),
  control_room_queue_worker: randomBytes(24).toString("base64url"),
  control_room_intake: randomBytes(24).toString("base64url"),
  control_room_news: randomBytes(24).toString("base64url"),
});

/**
 * Role files applied after the migration ledger, in dependency order.
 *
 * The queue role files raise when their pg-boss prerequisite is missing, so
 * the runner builds the two queues those files assert on before applying any
 * of them. Every other role file is independent of the queue.
 */
const ROLE_FILES = Object.freeze([
  "production_roles.sql",
  "private_web_database.sql",
  "private_web_roles.sql",
  "task_coordinator_roles.sql",
  "native_results_roles.sql",
  "local_result_publisher_roles.sql",
  "news_ingestion_roles.sql",
  "news_coordinator_roles.sql",
  "native_queue_producer_roles.sql",
  "native_queue_worker_roles.sql",
  "native_queue_recovery_roles.sql",
  "news_queue_producer_roles.sql",
]);

const QUEUES = Object.freeze(["native-task-delivery", "news-feed-collection"]);

/**
 * Role login -> the NOLOGIN group role it inherits, mirroring
 * scripts/mac-local/narrow-role-provision.mjs. The keys are the short names a
 * test passes to `connection(role)`; the logins are the production names.
 */
export const ROLE_LOGINS = Object.freeze({
  web: Object.freeze({ login: "control_room_web", group: "control_room_private_web" }),
  coordinator: Object.freeze({ login: "control_room_coordinator", group: "control_room_task_coordinator" }),
  intake: Object.freeze({ login: "control_room_intake", group: "control_room_news_ingestion" }),
  news: Object.freeze({ login: "control_room_news", group: "control_room_news_coordinator" }),
  results: Object.freeze({ login: "control_room_results", group: "control_room_native_results" }),
  publisher: Object.freeze({ login: "control_room_publisher", group: "control_room_local_result_publisher" }),
  queueWorker: Object.freeze({ login: "control_room_queue_worker", group: "control_room_native_queue_worker" }),
  app: Object.freeze({ login: "control_room_app", group: "control_room_application" }),
  scheduler: Object.freeze({ login: "control_room_scheduler", group: "control_room_schedule_admissions" }),
  migrator: Object.freeze({ login: "control_room_migrator", group: "control_room_schema_owner" }),
  owner: Object.freeze({ login: "control_room_web", group: "control_room_private_web" }),
});

/** The short names a caller may ask for. */
export const NAMED_ROLES = Object.freeze(Object.keys(ROLE_LOGINS) as (keyof typeof ROLE_LOGINS)[]);

export type AttackRole = (typeof NAMED_ROLES)[number];

export interface ConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  application_name?: string;
}

export interface RealPostgres {
  /** Port this cluster was given. The only port the kit ever touches. */
  readonly port: number;
  readonly host: string;
  readonly database: string;
  readonly dataDirectory: string;
  readonly runDirectory: string;
  readonly socketDirectory: string;
  /** Migrations applied in this run. Zero would mean a silent no-op. */
  readonly appliedMigrations: number;
  /** Superuser connection options, for fixture seeding only. Never a product role. */
  admin(options?: { database?: string }): ConnectionOptions;
  /** A connection authenticated as the named production role. */
  connection(role: AttackRole | string, options?: { database?: string; applicationName?: string }): ConnectionOptions;
  /** Open and close a client, for a single statement. */
  query<T = Record<string, unknown>>(
    role: AttackRole | string,
    sql: string,
    params?: unknown[],
    options?: { database?: string },
  ): Promise<{ rows: T[] }>;
  /** True while the postmaster is running. Used to prove cleanup happened. */
  isRunning(): Promise<boolean>;
  /**
   * True when the runner retained the postmaster pid, false when the
   * `postmaster.pid` read did not yield one.
   *
   * A caller cannot otherwise tell the healthy path from the degraded one, so a
   * test asserting only "no cluster survived" would also pass on a run that
   * never lost the pid and proved nothing about the teardown.
   */
  readonly postmasterPidCaptured: boolean;
  /** Destroy the cluster. Idempotent, and safe to call from a finally block. */
  stop(): Promise<void>;
}

export interface WithRealPostgresOptions {
  /** Port to bind. Required: the kit never picks a port for the caller. */
  port: number;
  /** Override the database name. */
  database?: string;
  /** Skip the queue construction and the four queue-dependent role files. */
  withoutQueue?: boolean;
  /** Extra role files to apply after the standard set. */
  extraRoleFiles?: readonly string[];
  /** Override the PostgreSQL bin directory (must contain initdb + postgres). */
  pgBin?: string;
  /**
   * Fault injection for the `postmaster.pid` read, for a test that must prove
   * the teardown survives losing the pid. `read_fails` replaces the one read
   * with a function that rejects exactly as a permission or I/O failure would;
   * the production `.catch` still handles it, so the fault flows through the
   * real path rather than around it.
   *
   * It can only ever LOSE the pid, so it cannot be used to make teardown do
   * less. Absent in normal use.
   */
  pidCaptureFault?: "read_fails";
  /**
   * Fault injection for the cooperative `pg_ctl stop`, for a test that must
   * prove an unconfirmed shutdown is REFUSED rather than reported as a clean
   * teardown. `no_op` makes the command exit 0 without stopping anything,
   * which is what a `pg_ctl` reports when a postmaster will not take a fast
   * shutdown request: the caller is told the stop worked and the server is
   * still there.
   *
   * It can only ever skip a real stop, so it cannot make teardown look better
   * than it is. Absent in normal use.
   */
  stopAttemptFault?: "no_op";
  /**
   * Fault injection for the `pg_ctl start` exit code, for a test that must
   * prove a start which launched a postmaster and then FAILED leaves nothing
   * behind. `exit_non_zero_after_start` runs the real `pg_ctl start`, waits for
   * the cluster to publish its pid, and then throws exactly as a `pg_ctl`
   * exits non-zero after a fork — a `-w -t 60` "server did not start in time"
   * under load, or the 120 s exec timeout while the postmaster is still coming
   * up.
   *
   * It can only ever report a failure that really happened, so it cannot make
   * teardown look better than it is. Absent in normal use.
   */
  startAttemptFault?: "exit_non_zero_after_start";
}

export class PortOccupiedError extends Error {
  constructor(readonly port: number) {
    super(`refusing_occupied_port:${port}`);
    this.name = "PortOccupiedError";
  }
}

export class AttackKitPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttackKitPortError";
  }
}

// ---------------------------------------------------------------------------
// The teardown ladder.
//
// A postmaster creates one 56-byte SysV shared-memory segment and releases it on
// any shutdown that runs its exit path. SIGKILL cannot run an exit path, so a
// killed postmaster leaves the segment behind with a dead creator and `nattch 0`.
// MEASURED against PostgreSQL 17.11, snapshotting `ipcs -m` around each shape:
//
//   pg_ctl -m fast stop .............. released  (3/3)
//   SIGQUIT, idle ..................... released, ~4 ms  (3/3)
//   SIGQUIT, prepared xact pending ... released  (1/1)
//   SIGKILL ........................... LEAKED  (6/6)
//   SIGKILL during startup ........... LEAKED  (6/6)
//   shared_memory_type=mmap + SIGKILL  LEAKED  (5/5)
//
// `shared_memory_type=mmap` is NOT the fix, despite being PostgreSQL's answer to
// this class of leak: that GUC governs the `shared_buffers` region, and the
// 56-byte segment is created unconditionally beside it, so it leaks on every
// SIGKILL regardless. It was measured rather than assumed, and it does not work.
//
// So the ladder is ordered by what RELEASES the segment, not by what ends the
// process soonest. The order is the whole point, and it is the part a future
// edit would get wrong, so it lives in one exported function that takes its
// side effects as parameters: a test can then assert the order directly instead
// of inferring it from a leak that may never happen.
// ---------------------------------------------------------------------------

export type ShutdownAction = "cooperative" | "signal";

export interface ShutdownStep {
  /** A cooperative `pg_ctl` stop, or a signal sent to the postmaster. */
  readonly action: ShutdownAction;
  /** `fast` or `immediate`, for a cooperative step. */
  readonly mode?: "fast" | "immediate";
  /** The signal, for a signal step. */
  readonly signal?: "SIGQUIT" | "SIGKILL";
  /** True when the postmaster was gone after this step. */
  readonly stopped: boolean;
  /** The cooperative attempt failed, or the wait expired. */
  readonly failed: boolean;
}

export interface ShutdownLadderOptions {
  /** Is the postmaster still running? Asked before every step. */
  readonly alive: () => boolean;
  /**
   * Run one cooperative `pg_ctl` stop. The caller owns the error, so a refusal
   * to stop is recorded rather than thrown.
   */
  readonly cooperativeStop: (mode: "fast" | "immediate") => Promise<void>;
  /** Send a signal to the postmaster. Errors are the caller's to absorb. */
  readonly signal: (signal: "SIGQUIT" | "SIGKILL") => void;
  /** Wait up to this long for the postmaster to exit after a signal. */
  readonly graceMs?: number;
  /** Poll interval while waiting. */
  readonly tickMs?: number;
  /** Sleep, injected so a test does not spend real time waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ShutdownLadderResult {
  /** Every step attempted, in order. The order is the contract. */
  readonly steps: readonly ShutdownStep[];
  /** True when the postmaster is gone. */
  readonly stopped: boolean;
  /**
   * True when `SIGKILL` was needed, which is the one path that leaks a SysV
   * shared-memory segment. A caller reports this as a failure: a teardown that
   * had to be forced is not a clean teardown, and it cost the machine a segment.
   */
  readonly forced: boolean;
}

/**
 * Stop a postmaster, in the order that releases its shared memory.
 *
 * The order is the guarantee, and it is asserted rather than described:
 * `cooperative fast` -> `cooperative immediate` -> `SIGQUIT` -> `SIGKILL`. The
 * first step that finds the postmaster gone ends the ladder, so the common case
 * performs exactly one `pg_ctl -m fast` and never reaches a signal. `SIGKILL` is
 * reachable only by a postmaster that refused every cooperative shutdown, and
 * reaching it sets `forced`.
 */
export async function shutdownLadder(options: ShutdownLadderOptions): Promise<ShutdownLadderResult> {
  const graceMs = options.graceMs ?? 30_000;
  const tickMs = options.tickMs ?? 100;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => { setTimeout(done, ms); }));
  const steps: ShutdownStep[] = [];

  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && options.alive()) await sleep(tickMs);
    return !options.alive();
  };

  for (const mode of ["fast", "immediate"] as const) {
    if (!options.alive()) break;
    let failed = false;
    try {
      await options.cooperativeStop(mode);
    } catch {
      // Expected when the postmaster never came up, or is already gone. Whether
      // that is a failure is decided by asking whether it is still running.
      failed = true;
    }
    const stopped = !options.alive();
    steps.push({ action: "cooperative", mode, stopped, failed: failed && !stopped });
    if (stopped) return { steps, stopped: true, forced: false };
  }

  for (const signal of ["SIGQUIT", "SIGKILL"] as const) {
    if (!options.alive()) break;
    try { options.signal(signal); } catch { /* already gone */ }
    const stopped = await waitForExit();
    steps.push({ action: "signal", signal, stopped, failed: !stopped });
    if (stopped) return { steps, stopped: true, forced: signal === "SIGKILL" };
  }

  return { steps, stopped: !options.alive(), forced: steps.some(step => step.signal === "SIGKILL") };
}

/** The first bin directory that actually holds a PostgreSQL 17 server. */
export function resolvePgBin(explicit?: string): string | null {
  const candidates = explicit ? [explicit] : [...PG_CANDIDATE_BINS];
  return candidates.find(directory =>
    existsSync(join(directory, "initdb")) && existsSync(join(directory, "postgres"))) ?? null;
}

export function pgBinCandidates(explicit?: string): readonly string[] {
  return explicit ? [explicit] : [...PG_CANDIDATE_BINS];
}

/** True when a lane can run the real-PostgreSQL tests. */
export function requiresRealPostgres(explicit?: string): boolean {
  return resolvePgBin(explicit) !== null;
}

/** The message to skip with, and to fail with, for the same reason. */
export function realPostgresSkipMessage(explicit?: string): string {
  return `needs PostgreSQL 17 binaries (tried: ${pgBinCandidates(explicit).join(", ")})`;
}

/** The socket file name a postmaster publishes for `port`. */
const socketName = (port: number) => `.s.PGSQL.${port}`;

/**
 * Name of the registry file that records every cluster this process started.
 *
 * The mutation helper gives its test command a PRIVATE `TMPDIR` and then
 * reaps any postmaster that published a `postmaster.pid` under it. That only
 * works if the runner says where its clusters went, because a group kill
 * cannot reach them: `pg_ctl start` runs the postmaster with `setsid`, so the
 * postmaster's PGID is its own pid with PPID 1, and signalling the test's
 * process group misses it entirely. The registry is what turns "something may
 * still be running" into a specific, reapable data directory.
 */
export const CLUSTER_REGISTRY_NAME = "attack-kit-clusters.json";

/** Record a started cluster so a supervisor can find and stop it later. */
async function registerCluster(run: string, entry: { port: number; dataDirectory: string; pgBin: string }): Promise<void> {
  const file = join(run, CLUSTER_REGISTRY_NAME);
  // Append-only as one JSON object per line: concurrent kit clusters in the
  // same process must not lose each other's entries to a read-modify-write.
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Read the registry of a run directory, ignoring any unparsable line. */
export async function readClusterRegistry(run: string): Promise<
  { port: number; dataDirectory: string; pgBin: string }[]
> {
  const text = await readFile(join(run, CLUSTER_REGISTRY_NAME), "utf8").catch(() => "");
  const entries: { port: number; dataDirectory: string; pgBin: string }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { port?: unknown; dataDirectory?: unknown; pgBin?: unknown };
      if (typeof parsed.port === "number" && typeof parsed.dataDirectory === "string" && typeof parsed.pgBin === "string") {
        entries.push({ port: parsed.port, dataDirectory: parsed.dataDirectory, pgBin: parsed.pgBin });
      }
    } catch {
      // A half-written line from a killed process is not a cluster.
    }
  }
  return entries;
}

/**
 * True when a postmaster publishes its socket for `port`.
 *
 * This is how a socket-only cluster is detected: `-h ''` publishes no TCP
 * listener at all, so the published socket is the only evidence that the port
 * is taken. Four places are scanned, because the one that matters is the one
 * that gets missed:
 *
 *  - the temp directory's own entries, for a cluster that published there;
 *  - a `socket` subdirectory of any temp-directory child, the shape the
 *    production lifecycle tests and the rehearsal use;
 *  - `SHORT_SOCKET_ROOT/ak*` — THIS KIT'S OWN sockets. The kit cannot use a
 *    `socket` subdirectory under the run directory (a macOS `tmpdir()` is 47
 *    characters and the socket path is capped at ~103), so its clusters publish
 *    into `/tmp/ak<pid>-<run>/`. A scan that looked only at the temp directory
 *    and its immediate children could not see them, so a second kit cluster
 *    would happily start on a port another kit cluster was already holding —
 *    which is exactly the port-block discipline this kit exists to enforce,
 *    and the most likely foreigner on a machine running concurrent kit jobs.
 */
export async function socketClaimed(port: number, directory?: string): Promise<boolean> {
  const name = socketName(port);
  if (directory) return existsSync(join(directory, name));
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  if (entries.some(entry => !entry.isDirectory() && entry.name === name)) return true;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // A disposable run directory from any job, not just this kit's: a foreign
    // cluster that holds the port is exactly the case that must be refused.
    if (existsSync(join(tmpdir(), entry.name, "socket", name))) return true;
  }
  for (const directory of await shortSocketDirectories()) {
    if (existsSync(join(directory, name))) return true;
  }
  return false;
}

/** Every `/tmp/ak*` socket directory the kit's own runner publishes into. */
export async function shortSocketDirectories(): Promise<string[]> {
  const entries = await readdir(SHORT_SOCKET_ROOT, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith("ak"))
    .map(entry => join(SHORT_SOCKET_ROOT, entry.name));
}

/** First line of an error message, for a one-token teardown failure summary. */
const firstLineOf = (error: unknown): string =>
  `${(error as Error)?.message ?? String(error)}`.split("\n")[0]!.slice(0, 200);

/** True when `dataDirectory` holds a postmaster pid that is still running. */
async function postmasterAlive(dataDirectory: string): Promise<boolean> {
  const pid = (await readFile(join(dataDirectory, "postmaster.pid"), "utf8").catch(() => "")).split("\n")[0]?.trim();
  if (!pid || !/^\d+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to another user.
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * True when something already holds `port` in a way that would collide.
 *
 * Three signals, because one is not enough on its own:
 *  - a live `postmaster.pid`, which catches a socket-only cluster in a known
 *    data directory — the very shape this kit creates, and the one a TCP probe
 *    cannot see because `-h ''` publishes no listener at all;
 *  - a published `.s.PGSQL.<port>` socket, which catches a foreign socket-only
 *    cluster in a run directory this kit never created;
 *  - a TCP connect, which catches a foreign listener that is not PostgreSQL.
 */
export async function portIsOccupied(port: number, dataDirectory?: string, socketDirectory?: string): Promise<boolean> {
  if (dataDirectory && await postmasterAlive(dataDirectory)) return true;
  if (await socketClaimed(port, socketDirectory)) return true;
  if (socketDirectory) return false;
  return new Promise(resolveOccupied => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (occupied: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOccupied(occupied);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Refuse a port that already answers, and refuse one that is not a number the
 * caller is entitled to use. A reused foreign cluster would make every grant
 * assertion in the test meaningless, so this is checked before `initdb`.
 *
 * The allowlist is REQUIRED and must be non-empty. Making it optional meant a
 * caller that forgot it (or mistyped the option name) silently lost the
 * boundary: the check passed on ANY port, so a typo could probe and start a
 * cluster somewhere outside the block this job was authorized for. Refusing
 * here happens before any socket or TCP probe, so an unauthorized port is
 * never even touched.
 */
export async function assertPortAvailable(
  port: number,
  allowed: readonly number[],
  probe: { dataDirectory?: string; socketDirectory?: string } = {},
): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AttackKitPortError(`attack_kit_port_invalid:${String(port)}`);
  }
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new AttackKitPortError("attack_kit_allowed_ports_required");
  }
  if (!allowed.includes(port)) {
    throw new AttackKitPortError(`attack_kit_port_outside_block:${port}`);
  }
  if (await portIsOccupied(port, probe.dataDirectory, probe.socketDirectory)) throw new PortOccupiedError(port);
}

const ROOT_UID = 0;
const POSTGRES_UID = 102;
const POSTGRES_GID = 105;

/**
 * initdb/pg_ctl/postgres refuse to run as root. On a root dev box the calls are
 * de-escalated to the postgres pseudo-user, the same defaults the Debian and
 * Ubuntu packages use. Any non-root environment needs no special handling.
 */
function nativeCommand(pgBin: string, run: string, name: string, args: string[]): [string, string[]] {
  const binary = join(pgBin, name);
  const asPostgres = process.getuid?.() === ROOT_UID;
  if (asPostgres && ["initdb", "pg_ctl", "postgres"].includes(name)) {
    return ["setpriv", [`--reuid=${POSTGRES_UID}`, `--regid=${POSTGRES_GID}`, "--clear-groups", binary, ...args]];
  }
  return [binary, args];
}

function native(pgBin: string, run: string, name: string, args: string[]) {
  const [file, argv] = nativeCommand(pgBin, run, name, args);
  return exec(file, argv, {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" },
    timeout: 120_000, maxBuffer: 1 << 26,
  });
}

async function client(options: ConnectionOptions): Promise<Client> {
  const connection = new Client(options);
  await connection.connect();
  return connection;
}

async function oneShot<T = Record<string, unknown>>(
  options: ConnectionOptions, sql: string, params: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  const connection = await client(options);
  try {
    const result = await connection.query(sql, params as never[]);
    return { rows: result.rows as T[] };
  } finally {
    await connection.end();
  }
}

async function buildQueues(admin: ConnectionOptions): Promise<void> {
  const { getConstructionPlans, PgBoss } = await import("pg-boss");
  const connection = await client(admin);
  try {
    await connection.query(getConstructionPlans("control_room_queue"));
    const boss = new PgBoss({
      db: { executeSql: (sql: string, values: unknown[]) => connection.query(sql, values as never[]) },
      schema: "control_room_queue", backend: "postgres", migrate: false, createSchema: false,
      supervise: false, schedule: false, useListenNotify: false,
    });
    await boss.start();
    try {
      for (const queue of QUEUES) await boss.createQueue(queue, { retryLimit: 0 });
    } finally {
      await boss.stop({ graceful: false });
    }
  } finally {
    await connection.end();
  }
}

/**
 * A Unix-domain socket path is capped at ~103 bytes, and PostgreSQL's is
 * `<socket dir>/.s.PGSQL.<port>`. macOS's `tmpdir()` is
 * `/var/folders/qb/llfk_qh163d9rlt2zvhgdncc0000gn/T`, which is 47 characters, so
 * a run directory named under it pushed the path past the cap and every start
 * failed with "could not create any Unix-domain sockets". The run directory
 * stays where `disposableRunDirectories()` looks for it; only the SOCKET lives
 * in a short path, and it is removed with the run directory's teardown.
 */
const SHORT_SOCKET_ROOT = "/tmp";

/** Longest socket path this will create, including a 5-digit port. */
const MAX_SOCKET_PATH_BYTES = 100;

function shortSocketDirectory(run: string, port: number): string {
  const candidate = join(SHORT_SOCKET_ROOT, `ak${process.pid}-${basename(run)}`);
  // `.s.PGSQL.` plus the port is 13-14 bytes; leave headroom under the cap.
  if (Buffer.byteLength(candidate) + 16 > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`attack_kit_socket_path_too_long:${candidate}`);
  }
  return candidate;
}

/**
 * Where run directories are created.
 *
 * `tmpdir()` is the default, and on macOS it resolves through `confstr` to
 * `/var/folders/...` — it does NOT honour `TMPDIR`. That matters for the
 * mutation helper, which gives the command it runs a private `TMPDIR` and then
 * scans that directory for the clusters the command started. A run directory
 * that ignores `TMPDIR` lands outside the scan, so a postmaster a timed-out
 * command started would survive the reap. `ATTACK_KIT_RUN_ROOT` lets a caller
 * put every run directory somewhere it can enumerate, and the helper sets it.
 */
const runRoot = (): string => process.env.ATTACK_KIT_RUN_ROOT?.trim() || tmpdir();

/** One start/stop cycle, from `initdb` to a migrated, role-provisioned database. */
async function startCluster(options: WithRealPostgresOptions & { pgBin: string }): Promise<RealPostgres> {
  const { pgBin, port } = options;
  const database = options.database ?? REPOSITORY_DATABASE_NAME;
  const run = await mkdtemp(join(runRoot(), "attack-kit-pg-"));
  const socketDirectory = shortSocketDirectory(run, port);
  const dataDirectory = join(run, "data");
  let started = false;
  // The postmaster pid is RETAINED, because it is the only piece of cleanup
  // evidence that survives deleting the data directory. `pg_ctl status` and a
  // `postmaster.pid` read both need files that `stop` removes, so a check made
  // after teardown could not tell "the postmaster is gone" from "the evidence
  // was deleted". Holding the pid lets liveness be asked directly, and it is
  // what makes a failed stop detectable instead of silently erased.
  let postmasterPid: number | undefined;
  // Set once `stop` has completed. The pid itself is deliberately RETAINED
  // after a successful stop so the post-teardown liveness check stays
  // authoritative; this flag is what makes a second `stop` a no-op.
  let stopped = false;
  const asPostgres = process.getuid?.() === ROOT_UID;

  const pidAlive = (pid: number | undefined): boolean => {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists and belongs to another user.
      return (error as { code?: string }).code === "EPERM";
    }
  };

  /**
   * Stop the postmaster and prove it is gone, or throw.
   *
   * Every failure is propagated. The previous version cleared `started`,
   * swallowed every `pg_ctl stop` error and deleted the run directory
   * unconditionally, so a postmaster that refused to stop survived with its
   * data directory already removed — and the later `isRunning()` check, which
   * needed that directory, reported "not running" and the caller was told
   * `cleanedUp: true`. This machine has only 32 SysV shared-memory segments, so
   * exactly that leak blocks every other job.
   *
   * The shutdown attempt is keyed on `started`, NOT on a retained pid. A
   * transient or malformed `postmaster.pid` read leaves the pid undefined even
   * though `pg_ctl start` succeeded, and the old `if (pid !== undefined)` guard
   * then skipped shutdown entirely and deleted both the data and the socket
   * directory — destroying the only means of stopping or diagnosing a postmaster
   * that was still running. Without a pid the confirmation is made from evidence
   * that still exists because nothing has been deleted yet: no live
   * `postmaster.pid` in the data directory AND `pg_ctl status` reporting that
   * there is no server. If either check fails, both directories are kept and the
   * failure is reported with their paths.
   */
  const stop = async (): Promise<void> => {
    // A previous stop already completed. The run directory is removed exactly
    // once, on every other path: an early return here would leak the directory
    // whenever `initdb` succeeded but the postmaster never started.
    if (stopped) return;
    const wasStarted = started;
    started = false;
    const pid = postmasterPid;
    const failures: string[] = [];
    if (wasStarted) {
      // A cooperative fast shutdown first, whether or not the pid was captured.
      try {
        if (options.stopAttemptFault === "no_op") {
          // Report success without stopping anything, as a `pg_ctl` does when a
          // postmaster will not take the shutdown request. The confirmation
          // below is what must catch it.
        } else {
          await native(pgBin, run, "pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "-t", "30", "stop"]);
        }
      } catch (error) {
        // Expected when the postmaster never came up, or is already gone; the
        // confirmation below is what decides whether that is a failure.
        failures.push(`pg_ctl_stop_failed:${firstLineOf(error)}`);
      }
    }
    if (pid !== undefined) {
      if (pidAlive(pid)) {
        // The ladder's order is the whole fix, and it is asserted in
        // tests/attack-kit.test.ts; see `shutdownLadder` for the measurements
        // behind it. In short: every cooperative shutdown releases the
        // postmaster's SysV shared-memory segment and SIGKILL never does, so the
        // ladder is ordered by what RELEASES the segment rather than by what
        // ends the process soonest.
        const ladder = await shutdownLadder({
          alive: () => pidAlive(pid!),
          cooperativeStop: async (mode) => {
            if (options.stopAttemptFault === "no_op" && mode === "fast") {
              // Report success without stopping anything, as a `pg_ctl` does when
              // a postmaster will not take the shutdown request. The ladder's own
              // liveness check is what must notice.
              return;
            }
            await native(pgBin, run, "pg_ctl", ["-D", dataDirectory, "-m", mode, "-w", "-t", "60", "stop"]);
          },
          signal: (signal) => { process.kill(pid!, signal); },
        });
        for (const step of ladder.steps) {
          if (step.failed) {
            failures.push(step.action === "cooperative"
              ? `pg_ctl_stop_${step.mode}_failed`
              : `${step.signal ?? "signal"}_did_not_stop_the_postmaster`);
          }
        }
        if (ladder.forced) {
          // Recorded as a failure, because it is one: a postmaster that refused
          // every cooperative shutdown had to be SIGKILLed, and that SIGKILL is
          // the only path that leaves its 56-byte SysV segment behind with a dead
          // creator. Reporting a clean teardown here would hide both.
          failures.push("postmaster_required_sigkill_which_leaks_its_shared_memory_segment");
        }
      }
      if (pidAlive(pid)) {
        // Refuse to delete the evidence and refuse to report success. The
        // caller gets the pid so the cluster can be reaped by hand.
        throw new Error(`attack_kit_postmaster_would_not_stop:${port}:pid=${pid}`
          + `:${[...failures, "postmaster_still_alive"].join(",")}`
          + `:data_directory_preserved=${dataDirectory}`);
      }
      // `postmasterPid` is intentionally NOT cleared: it is the evidence the
      // post-teardown liveness check needs, and the process is confirmed gone.
    } else if (wasStarted) {
      // Started, but the pid was never captured. Nothing has been deleted yet,
      // so the data directory is still there to be read: a `postmaster.pid` that
      // is absent or non-numeric is a stopped postmaster (PostgreSQL removes
      // the file on clean shutdown), and `pg_ctl status` exits non-zero when
      // there is no server in that data directory. Only BOTH agreeing counts as
      // a confirmed shutdown.
      const stillRecorded = await postmasterAlive(dataDirectory);
      let statusReportsRunning = false;
      try {
        await native(pgBin, run, "pg_ctl", ["-D", dataDirectory, "status"]);
        statusReportsRunning = true;
      } catch {
        // pg_ctl status exits non-zero when no postmaster is running.
      }
      if (stillRecorded || statusReportsRunning) {
        // The evidence is what an operator needs to stop this cluster by hand,
        // so it is preserved and the failure is reported with both paths.
        throw new Error(`attack_kit_postmaster_shutdown_unconfirmed:${port}`
          + `:pid_not_captured:postmaster_pid_alive=${stillRecorded}`
          + `:pg_ctl_status_running=${statusReportsRunning}`
          + `:${failures.join(",")}`
          + `:data_directory_preserved=${dataDirectory}:run_directory_preserved=${run}`
          + `:socket_directory_preserved=${socketDirectory}`);
      }
    }
    // Both paths are removed: the run directory holds the data directory, and
    // the short socket directory lives outside it, so removing `run` alone
    // would leave a `/tmp/ak<pid>-<run>` directory behind on every cluster.
    await Promise.all([
      rm(run, { recursive: true, force: true }),
      rm(socketDirectory, { recursive: true, force: true }),
    ]);
    stopped = true;
    if (failures.length > 0) {
      // The postmaster is confirmed gone, so this is not a leak, but the
      // cooperative path did fail and that is worth surfacing rather than
      // swallowing.
      throw new Error(`attack_kit_cluster_stop_degraded:${port}:${failures.join(",")}`);
    }
  };

  // A signal must not leave a postmaster behind. This machine has 32 SysV
  // shared-memory segments in total, so one orphaned cluster blocks every other
  // job; `scripts/dev/cleanup-test-postgres.mjs` can reclaim an unattached one,
  // but only after the damage. The handler is installed before initdb, removed
  // once `stop` has run, and re-raises the signal's conventional exit code so
  // the surrounding runner still sees a signalled failure.
  const onSignal = (signal: NodeJS.Signals) => {
    void stop().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) process.once(signal, onSignal);
  const releaseSignals = () => {
    for (const signal of signals) process.removeListener(signal, onSignal);
  };
  // The teardown every path shares: release the handlers first, so a signal
  // arriving during an ordinary stop does not re-enter `stop`, then stop.
  const teardown = async () => {
    releaseSignals();
    await stop();
  };

  try {
    await mkdir(socketDirectory, { mode: 0o700 });
    if (asPostgres) await exec("chown", ["-R", `${POSTGRES_UID}:${POSTGRES_GID}`, run], { timeout: 30_000 });
    await native(pgBin, run, "initdb", ["-D", dataDirectory, "-U", "fixture_admin",
      "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
    // Retained for the lifetime of the cluster so the teardown can prove the
    // postmaster is gone without reading files it is about to delete. The read
    // is behind a function so a test can inject the one failure that used to
    // orphan a postmaster: a start that succeeded, followed by a pid read that
    // did not. `stop` does not depend on the outcome of this read.
    const readPostmasterPid = async (): Promise<string> => {
      if (options.pidCaptureFault === "read_fails") {
        throw Object.assign(new Error(`attack_kit_injected_pid_read_failure:${dataDirectory}`),
          { code: "EACCES" });
      }
      return await readFile(join(dataDirectory, "postmaster.pid"), "utf8");
    };
    const recordedPid = (text: string): number | undefined => {
      const first = text.split("\n")[0]?.trim();
      return first && /^\d+$/.test(first) ? Number(first) : undefined;
    };
    // `started` is set BEFORE `pg_ctl start` is invoked, not after it returns
    // zero. A start that fails after the postmaster has forked — `-w -t 60`
    // "server did not start in time" under load, or the 120 s exec timeout
    // while the postmaster is still coming up — leaves a LIVE server behind, and
    // the old code skipped the shutdown entirely because `started` was still
    // false, then deleted the data directory and the socket directory. The
    // orphan survived with a SysV segment held: on a machine with 32 of them,
    // that blocks every other job. So from here on "may have started" is the
    // state `stop` acts on, and the pid is read from the data directory before
    // anything is deleted.
    started = true;
    let startFailure: unknown;
    try {
      // Socket-only: `-h ''` publishes no TCP listener at all, so the cluster is
      // reachable only through the run directory even if a port were forwarded.
      await native(pgBin, run, "pg_ctl", ["-D", dataDirectory, "-l", join(run, "server.log"),
        "-w", "-t", "60", "-o",
        `-k ${socketDirectory} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=60`,
        "start"]);
      if (options.startAttemptFault === "exit_non_zero_after_start") {
        // The injected failure is raised only after the cluster is REALLY up —
        // the pid is polled from disk first — so the teardown this test
        // exercises is the teardown of a live postmaster whose start reported a
        // failure. Raising it without a running postmaster would prove nothing.
        const deadline = Date.now() + 60_000;
        while (postmasterPid === undefined && Date.now() < deadline) {
          await new Promise(done => { setTimeout(done, 100); });
          postmasterPid = recordedPid(await readPostmasterPid().catch(() => ""));
        }
        if (postmasterPid === undefined) {
          throw new Error("attack_kit_injected_start_failure_without_a_live_postmaster");
        }
        startFailure = new Error("attack_kit_injected_start_failure_after_launch");
      }
    } catch (error) {
      // Re-read the pid from disk BEFORE the teardown deletes the data
      // directory. A failed start is exactly the case where no pid has been
      // captured yet, and this read is the only handle on a postmaster that
      // may nonetheless be running.
      postmasterPid ??= recordedPid(await readPostmasterPid().catch(() => ""));
      startFailure ??= error;
    }
    if (startFailure !== undefined) {
      // The postmaster's own log is the only diagnostic a start failure has,
      // and `stop` is about to delete the run directory that holds it, so it is
      // surfaced in the error rather than discarded with the directory.
      const log = (await readFile(join(run, "server.log"), "utf8").catch(() => "")).trim();
      const tail = log.split("\n").slice(-8).join(" | ").slice(0, 800);
      throw new Error(`attack_kit_cluster_start_failed:${port}`
        + `:${firstLineOf(startFailure)}`
        + `:postmaster_pid=${postmasterPid ?? "none"}`
        + `:${tail === "" ? "no_server_log" : `server_log=${tail}`}`);
    }
    // Registered as soon as there is a running postmaster, and BEFORE the pid
    // is read: the registry is what a supervisor reaps from, and a run whose
    // pid read fails still leaves a registered, reapable data directory. It is
    // removed with the run directory, so it cannot outlive the cluster.
    await registerCluster(run, { port, dataDirectory, pgBin });
    postmasterPid = recordedPid(await readPostmasterPid().catch(() => ""));

    const adminOptions = (name = "postgres"): ConnectionOptions => ({
      host: socketDirectory, port, database: name, user: "fixture_admin", password: FIXTURE_ADMIN_PASSWORD,
    });
    // The production connection descriptors are libpq keyword/value strings, the
    // same shape the operator CLI and the rehearsal pass to the applier.
    const conninfo = (name: string, user: string, password: string) =>
      `host=${socketDirectory} port=${port} dbname=${name} user=${user} password=${password}`;
    const admin = adminOptions();
    await oneShot(admin, `CREATE DATABASE "${database.replaceAll('"', '""')}" OWNER fixture_admin`);

    const migrationResult = await applyMigrations({
      // `target` is the legacy plan-mode flag the applier's JSDoc marks
      // required; the two phase connections below are what actually run.
      target: conninfo(database, "fixture_admin", FIXTURE_ADMIN_PASSWORD),
      rootDir: REPOSITORY_ROOT,
      ledgerPath: join(REPOSITORY_ROOT, "deploy/postgres/migration-ledger.json"),
      bootstrapTarget: conninfo(database, "fixture_admin", FIXTURE_ADMIN_PASSWORD),
      migrateTarget: conninfo(database, "control_room_migrator", ROLE_PASSWORDS.control_room_migrator),
      env: {
        CONTROL_ROOM_MIGRATOR_PASSWORD: ROLE_PASSWORDS.control_room_migrator,
        CONTROL_ROOM_APP_PASSWORD: ROLE_PASSWORDS.control_room_app,
        CONTROL_ROOM_SCHEDULER_PASSWORD: ROLE_PASSWORDS.control_room_scheduler,
        NODE_ENV: "test",
      },
    });
    const appliedMigrations = migrationResult.applied?.length ?? 0;
    if (migrationResult.planned || appliedMigrations === 0) {
      throw new Error("attack_kit_migrations_not_applied");
    }

    if (!options.withoutQueue) await buildQueues(adminOptions(database));

    const databaseAdmin = adminOptions(database);
    const roleFiles = ROLE_FILES.filter(file => options.withoutQueue
      ? !/queue/.test(file)
      : true);
    for (const file of [...roleFiles, ...(options.extraRoleFiles ?? [])]) {
      const sql = await readFile(join(REPOSITORY_ROOT, "db/roles", file), "utf8");
      await oneShot(databaseAdmin, sql);
    }
    // Create one LOGIN per production role name, inheriting exactly its group.
    // The short names ("web") are kit vocabulary; the logins
    // ("control_room_web") are the production names, so a privilege assertion
    // is about the real role. Two short names may share a login ("owner" and
    // "web" are both the private-web login), so the login is the dedup key.
    const existing = new Set((await oneShot<{ rolname: string }>(databaseAdmin,
      "SELECT rolname FROM pg_roles WHERE rolcanlogin")).rows.map(row => row.rolname));
    const created = new Set<string>();
    for (const { login, group } of Object.values(ROLE_LOGINS)) {
      if (created.has(login)) continue;
      if (existing.has(login)) {
        // Already a login (the migration applier creates the app, scheduler and
        // migrator logins with these same fixture passwords). Only membership
        // is added, and re-granting is idempotent.
        await oneShot(databaseAdmin, `GRANT "${group}" TO "${login}"`);
        created.add(login);
        continue;
      }
      const password = ROLE_PASSWORDS[login as keyof typeof ROLE_PASSWORDS];
      if (!password) continue;
      await oneShot(databaseAdmin, `CREATE ROLE "${login}" LOGIN INHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await oneShot(databaseAdmin, `GRANT "${group}" TO "${login}"`);
      created.add(login);
    }
    // db/roles/private_web_database.sql revokes the database-wide CREATE and
    // TEMPORARY privileges from PUBLIC. The role file runs in a transaction
    // that its own connecting role cannot commit without database ownership, so
    // the runner applies the same statement as the database owner. This is the
    // privilege that roleCan/roleCannot check with the database form.
    await oneShot(databaseAdmin,
      `REVOKE CREATE, TEMPORARY ON DATABASE "${database.replaceAll('"', '""')}" FROM PUBLIC`);

    // Resolve a role name ("web") to a production login ("control_room_web")
    // and its fixture password. An unknown name is refused rather than passed
    // through, so a typo in a test cannot silently connect as something else.
    const connectionFor = (role: string, name = database): ConnectionOptions => {
      const login = (ROLE_LOGINS as Record<string, { login: string }>)[role]?.login ?? role;
      const password = ROLE_PASSWORDS[login as keyof typeof ROLE_PASSWORDS];
      if (!password) throw new AttackKitPortError(`attack_kit_unknown_role:${String(role)}`);
      return { host: socketDirectory, port, database: name, user: login, password };
    };

    return {
      port, host: socketDirectory, database, dataDirectory, runDirectory: run,
      socketDirectory, appliedMigrations,
      postmasterPidCaptured: postmasterPid !== undefined,
      admin: ({ database: name } = {}) => adminOptions(name ?? database),
      connection(role, { database: name, applicationName } = {}) {
        const options = connectionFor(String(role), name ?? database);
        return applicationName === undefined
          ? options
          : { ...options, application_name: applicationName };
      },
      async query(role, sql, params = [], { database: name } = {}) {
        return oneShot(connectionFor(role, name ?? database), sql, params);
      },
      async isRunning() {
        // The RETAINED pid is authoritative, and it is checked FIRST. The old
        // implementation asked `pg_ctl status` against a data directory that
        // teardown had already deleted, so it necessarily reported false and a
        // surviving postmaster was read as "gone". The data-directory probe
        // remains as a fallback for a cluster whose pid was never captured.
        if (postmasterPid !== undefined) return pidAlive(postmasterPid);
        if (await postmasterAlive(dataDirectory)) return true;
        try {
          await native(pgBin, run, "pg_ctl", ["-D", dataDirectory, "status"]);
          return true;
        } catch {
          return false;
        }
      },
      stop: teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

export type WithRealPostgresBody<T> = (postgres: RealPostgres) => Promise<T>;

export interface WithRealPostgresResult<T> {
  readonly value: T;
  readonly port: number;
  readonly dataDirectory: string;
  readonly appliedMigrations: number;
  readonly elapsedMs: number;
  /** After teardown: the postmaster is gone and the data directory removed. */
  readonly cleanedUp: boolean;
  readonly leftovers: readonly string[];
}

export interface WithRealPostgresFullOptions extends WithRealPostgresOptions {
  /**
   * Ports the caller is entitled to use. Any other port is refused.
   *
   * Required and non-empty: an omitted allowlist used to be accepted, which
   * silently removed the boundary and let a mistyped port reach a probe and an
   * `initdb`. `withRealPostgres` refuses before touching the port.
   */
  allowedPorts: readonly number[];
  /** Wall-clock bound for the body. */
  boundMs?: number;
}

/**
 * Start a disposable cluster, run `body`, and destroy the cluster — whatever
 * the body does.
 *
 * The cleanup contract is the reason this wrapper exists: the teardown runs in
 * a `finally` after the body's own `finally`, so a body that throws, a body
 * that leaves a rejected promise behind, and a body that exceeds `boundMs` all
 * reach the same stop-and-remove path. The result reports `cleanedUp` and
 * `leftovers` so a caller can assert the teardown rather than trust it.
 */
export async function withRealPostgres<T>(
  body: WithRealPostgresBody<T>,
  options: WithRealPostgresFullOptions,
): Promise<WithRealPostgresResult<T>> {
  if (typeof body !== "function") throw new Error("attack_kit_body_required");
  const { port, allowedPorts, boundMs, ...rest } = options ?? ({} as WithRealPostgresOptions);
  if (port === undefined) throw new Error("attack_kit_port_required");
  await assertPortAvailable(port, allowedPorts);
  const pgBin = resolvePgBin(rest.pgBin);
  if (pgBin === null) throw new Error(`attack_kit_postgres_unavailable:${realPostgresSkipMessage(rest.pgBin)}`);

  const startedAt = Date.now();
  const postgres = await startCluster({ ...rest, port, pgBin });
  let timer: NodeJS.Timeout | undefined;
  // The teardown evidence is OBSERVED, not assumed. A hard-coded
  // `cleanedUp: true` would be unfalsifiable, and the whole point of this
  // helper is that a caller can trust or refute the cleanup. The result is
  // built after the `finally` has run, from the filesystem and the postmaster.
  let outcome: Omit<WithRealPostgresResult<T>, "cleanedUp" | "leftovers"> | undefined;
  let failure: { error: unknown; stack?: string } | undefined;
  try {
    let value!: T;
    if (boundMs === undefined) {
      value = await body(postgres);
    } else {
      const work = body(postgres).then(v => ({ value: v }) as const);
      const expiry = new Promise<"timeout">(resolve => {
        // Not unref'd: a body that overruns must hit the bound so the cluster
        // is torn down, not let the process exit with a live postmaster.
        timer = setTimeout(() => resolve("timeout"), boundMs);
      });
      work.catch(() => {});
      const settled = await Promise.race([work, expiry]);
      if (settled === "timeout") {
        throw new Error(`attack_kit_body_timed_out_after_${boundMs}ms`);
      }
      value = settled.value;
    }
    outcome = {
      value, port, dataDirectory: postgres.dataDirectory,
      appliedMigrations: postgres.appliedMigrations,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    // The body's own failure is re-raised after teardown; the teardown
    // observation below is reported by the thrown error's own message if the
    // cluster leaked, so a leak is never silently paired with a body error.
    failure = { error };
  } finally {
    if (timer) clearTimeout(timer);
    await postgres.stop();
  }

  const leftovers: string[] = [];
  if (await postgres.isRunning()) leftovers.push("postmaster_still_running");
  if (existsSync(postgres.dataDirectory)) leftovers.push(`data_directory:${postgres.dataDirectory}`);
  if (existsSync(postgres.runDirectory)) leftovers.push(`run_directory:${postgres.runDirectory}`);
  if (leftovers.length > 0) {
    throw new Error(`attack_kit_cluster_leaked:${port}:${leftovers.join(",")}`
      + (failure === undefined ? "" : `:body_also_failed:${(failure.error as Error)?.message ?? "unknown"}`),
    { cause: failure?.error });
  }
  if (failure) throw failure.error;
  return { ...outcome!, cleanedUp: true, leftovers };
}

/**
 * Post-teardown evidence for a caller that must PROVE the cluster is gone
 * rather than assume it: the postmaster is not running and the run directory
 * no longer exists.
 */
export async function assertClusterDestroyed(
  postgres: RealPostgres,
  result: WithRealPostgresResult<unknown>,
): Promise<{ running: boolean; dataDirectoryExists: boolean; runDirectoryExists: boolean }> {
  const running = await postgres.isRunning();
  const [dataDirectoryExists, runDirectoryExists] = await Promise.all([
    existsSync(postgres.dataDirectory),
    existsSync(postgres.runDirectory),
  ]);
  if (running || dataDirectoryExists || runDirectoryExists) {
    throw new Error(`attack_kit_cluster_leaked:${result.port}:running=${running}:data=${dataDirectoryExists}:run=${runDirectoryExists}`);
  }
  return { running, dataDirectoryExists, runDirectoryExists };
}

/** Every disposable run directory this process created, for a leak sweep. */
export async function disposableRunDirectories(pattern = /^attack-kit-pg-/): Promise<string[]> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[]);
  return entries.filter(entry => pattern.test(entry)).map(entry => join(tmpdir(), entry));
}

// ---------------------------------------------------------------------------
// SysV shared-memory accounting.
//
// A PostgreSQL postmaster creates one 56-byte SysV shared-memory segment, and
// releases it on any shutdown that runs its exit path. SIGKILL cannot, so a
// killed postmaster leaves the segment behind with a dead creator and `nattch 0`
// — MEASURED 6/6, while `pg_ctl stop` and `SIGQUIT` released it every time (see
// the ladder in `stop`). This machine has 32 such segments in total, so every
// orphan is a resource another job needs, and a test that starts clusters
// without checking for them is the reason the machine fills up.
//
// `ipcs -m` is the only account of this that is not the kit's own opinion of
// itself, so it is what the suite's leak guard uses.
// ---------------------------------------------------------------------------

/**
 * The ids of the SysV shared-memory segments owned by this user, each attributed
 * to this suite when its creator's command line says so.
 *
 * `ipcs -m -p` columns are T ID KEY MODE OWNER GROUP CPID LPID, so the owner is
 * field 5 (1-based), the creator field 7, and the last-attaching pid field 8.
 * `nattch` is NOT in `ipcs -m`'s default output — it is in `ipcs -m -a -p` — so
 * this cannot see it, and a leak is identified by a DEAD creator instead, which
 * is the same signature the orphaned segments on this machine show.
 *
 * Returns null when `ipcs` is unavailable or its output cannot be read, so a
 * caller can REFUSE rather than report a clean result it did not measure. This
 * is the same rule the rest of the kit follows: a guard that cannot run must not
 * read as a guard that passed.
 */
export async function sharedMemorySegments(
  ports?: readonly number[],
): Promise<SharedMemorySegment[] | null> {
  const { stdout } = await exec("/usr/bin/ipcs", ["-m", "-p"], { timeout: 10_000 })
    .then(value => ({ stdout: String(value.stdout ?? "") }))
    .catch(() => ({ stdout: "" }));
  // `-p` adds CPID/LPID to the header, so its presence is the proof that this
  // output carries the creator pids. Without it the parse below would be
  // reading the wrong columns, which is the silent-wrong-answer this function
  // returns null to avoid.
  if (!/\bCPID\b/u.test(stdout)) return null;
  const rows = stdout.split("\n")
    .map(line => line.trim().split(/\s+/u))
    .filter(fields => fields.length > 7 && fields[0] === "m" && /^\d+$/u.test(fields[1] ?? ""));
  // Only this user's segments: the count has to be comparable with the count
  // taken before the suite, and another user's are not ours to account for.
  // `USER` is the name `ipcs` prints; with no name available every segment is
  // returned rather than silently none.
  const user = process.env.USER;
  const mine = user === undefined || user === "" ? rows : rows.filter(fields => fields[4] === user);
  const commands = await readCommands([...new Set(mine.map(fields =>
    /^\d+$/u.test(fields[6] ?? "") ? fields[6]! : ""))].filter(Boolean));
  const pattern = oursPattern(ports);
  return mine.map(fields => {
    const creatorPid = /^\d+$/u.test(fields[6] ?? "") ? Number(fields[6]) : 0;
    return {
      id: fields[1]!,
      owner: fields[4]!,
      creatorPid,
      lastPid: /^\d+$/u.test(fields[7] ?? "") ? Number(fields[7]) : 0,
      // A dead creator has no command line left, so it is never attributed by
      // inspection. The leak guard treats a dead creator as a leak whatever its
      // attribution, because only `ipcrm` frees such a segment and nothing here
      // may run that.
      ours: pattern !== null && pattern.test(commands.get(creatorPid) ?? ""),
    };
  });
}

export interface SharedMemorySegment {
  readonly id: string;
  readonly owner: string;
  readonly creatorPid: number;
  readonly lastPid: number;
  /**
   * True when the creator's command line shows a cluster belonging to THIS
   * suite: a data directory under a run root with this kit's `attack-kit-pg-`
   * prefix, on a port inside the caller's port block.
   *
   * This exists because a strict per-user count is not enforceable on this Mac.
   * Four test slots run concurrently under one login, so a reviewer or a sibling
   * job starts and stops its own PostgreSQL during the run, and its segments
   * appear in `ipcs` with this suite having had nothing to do with them. Failing
   * on the raw count therefore reports another job's cluster as this suite's
   * leak. Attribution is by the creator's own command line, so what is asserted
   * is the count of segments this suite is responsible for.
   */
  readonly ours: boolean;
}

/** The pattern a creator's command line must match to be this suite's. */
const oursPattern = (ports: readonly number[] | undefined): RegExp | null => {
  if (ports === undefined || ports.length === 0) return null;
  const alternation = ports.map(port => String(port)).join("|");
  return new RegExp(`attack-kit-pg-[^/\\s]*/.*-p\\s(?:${alternation})(?:\\s|$)`
    + `|-p\\s(?:${alternation})\\s.*attack-kit-pg-`);
};

const readCommands = async (pids: readonly string[]): Promise<Map<number, string>> => {
  const commands = new Map<number, string>();
  if (pids.length === 0) return commands;
  const { stdout } = await exec("/bin/ps", ["-o", "pid=,command=", "-p", pids.join(",")], { timeout: 10_000 })
    .then(value => ({ stdout: String(value.stdout ?? "") }))
    .catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!);
  }
  return commands;
};

/** Segment ids now present that were not in `before`. */
export function newSharedMemorySegments(
  before: readonly SharedMemorySegment[],
  after: readonly SharedMemorySegment[] | null,
): SharedMemorySegment[] {
  if (after === null) return [];
  const known = new Set(before.map(segment => segment.id));
  return after.filter(segment => !known.has(segment.id));
}
