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
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
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
 * True when a postmaster publishes its socket for `port`.
 *
 * This is how a socket-only cluster is detected: `-h ''` publishes no TCP
 * listener at all, so the published socket is the only evidence that the port
 * is taken. Every disposable cluster in this repository — this kit's, the
 * production lifecycle tests', the rehearsal's — places its socket in a
 * `socket` directory inside a `mkdtemp` directory, so the scan is the temp
 * directory plus its immediate children. That is bounded, and it is what makes
 * a foreign cluster from another job visible instead of silently reused.
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
  return false;
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

/** One start/stop cycle, from `initdb` to a migrated, role-provisioned database. */
async function startCluster(options: WithRealPostgresOptions & { pgBin: string }): Promise<RealPostgres> {
  const { pgBin, port } = options;
  const database = options.database ?? REPOSITORY_DATABASE_NAME;
  const run = await mkdtemp(join(tmpdir(), "attack-kit-pg-"));
  const socketDirectory = join(run, "socket");
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
   */
  const stop = async (): Promise<void> => {
    // Nothing was ever started, or a previous stop already completed.
    if (stopped || (!started && postmasterPid === undefined)) return;
    started = false;
    const pid = postmasterPid;
    const failures: string[] = [];
    if (pid !== undefined) {
      // A cooperative fast shutdown first.
      try {
        await native(pgBin, run, "pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "-t", "30", "stop"]);
      } catch (error) {
        failures.push(`pg_ctl_stop_failed:${firstLineOf(error)}`);
      }
      if (pidAlive(pid)) {
        // Escalate: SIGQUIT is PostgreSQL's immediate shutdown, SIGKILL the
        // last resort. A disposable fixture cluster is ours to end.
        for (const signal of ["SIGQUIT", "SIGKILL"] as const) {
          try { process.kill(pid, signal); } catch { /* already gone */ }
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline && pidAlive(pid)) {
            await new Promise(resolve => { setTimeout(resolve, 100); });
          }
          if (!pidAlive(pid)) break;
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
    }
    await rm(run, { recursive: true, force: true });
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
    // Socket-only: `-h ''` publishes no TCP listener at all, so the cluster is
    // reachable only through the run directory even if a port were forwarded.
    await native(pgBin, run, "pg_ctl", ["-D", dataDirectory, "-l", join(run, "server.log"),
      "-w", "-t", "60", "-o",
      `-k ${socketDirectory} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=60`,
      "start"]);
    started = true;
    // Retained for the lifetime of the cluster so the teardown can prove the
    // postmaster is gone without reading files it is about to delete.
    const recordedPid = (await readFile(join(dataDirectory, "postmaster.pid"), "utf8")
      .catch(() => "")).split("\n")[0]?.trim();
    postmasterPid = recordedPid && /^\d+$/.test(recordedPid) ? Number(recordedPid) : undefined;

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
