// The first project-settings save never answers "unavailable" (qa-r7proj F2, database half).
//
// Two owner-facing Settings panels write ONE row, `control_project_settings`:
//   - ProjectSettingsPanel         -> WebProjectService.updateSettings (project-service.ts)
//   - ProjectOrchestrationSettings  -> PostgresProjectOrchestrationStoreV1.saveSettings
// Both compare-and-set `version`, and both begin with
//     SELECT version FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE
// which locks NOTHING when the row does not exist yet. So on a project with no settings row
// -- the state of every project that has never been touched, and therefore the FIRST thing
// an owner does in Settings -- every concurrent first save reads version 0, passes the
// check, and reaches the INSERT for the same (tenant_id, project_id). One wins; the rest
// took a primary-key violation (23505), which the installed private-postgreSQL driver
// deliberately reports to the owner as `database_unavailable` ("the database is down")
// rather than as the conflict between two of that owner's own panels it actually is.
//
// Everything here runs on REAL PostgreSQL 17 as the REAL production login
// (control_room_web, created exactly as scripts/mac-local/narrow-role-provision.mjs creates
// it: a LOGIN with membership in control_room_private_web and nothing else), against the
// real migration ledger and the real role files. The superuser connection seeds fixtures
// and asserts on stored rows; it never executes a product query.
//
// Two properties are asserted, and they are different properties:
//   1. CLASS (any adapter can prove this): the INSERT paths carry ON CONFLICT DO NOTHING
//      RETURNING and map zero rows to a named `conflict`. Proven by mutation in test 3.
//   2. MEASUREMENT (only real PostgreSQL can prove this): 20 concurrent first saves on 20
//      separate connections produce EXACTLY ONE winner, 19 named conflicts, ZERO
//      `database_unavailable`, and exactly one stored row. A fake cannot show this: the
//      defect is that PostgreSQL's primary key refused a concurrent INSERT.
//
// Neither panel's UI half is touched here: the Settings PAGE is another builder's branch.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Client } from "pg";
import { sha256Digest } from "../src/security";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { WebProjectService } from "../src/web/v1/project-service";
import { WebAccessError, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { PostgresProjectOrchestrationStoreV1 } from "../src/web/v1/project-orchestration-postgres-store";
import { assertGuardBites, GuardDidNotBiteError } from "./support/attack-kit/index";
import { REPOSITORY_ROOT } from "./support/attack-kit/real-postgres";

// The disposable-cluster lane reserved for this stream: 59200-59209, or the test
// runner's assigned block, so a concurrent run never collides with it. The brief
// assigned 59200-59219 for this job alone.
// The block this job was assigned. A port collision with a leftover cluster is retried
// across the block rather than failing outright; the bound port a test connects to is
// `PORT`, which is set to whichever member of the block actually started.
const PORT_BLOCK = Array.from({ length: Number(process.env.PROJECT_SETTINGS_RACE_PG_PORTS ?? 4) },
  (_unused, index) => Number(process.env.PROJECT_SETTINGS_RACE_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59200) + index);
let PORT = PORT_BLOCK[0]!;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);

const CANDIDATE_BINS = ([process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"] as const)
  .filter((dir): dir is string => !!dir);
const BIN = CANDIDATE_BINS.find(dir => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined
  : { skip: `needs PostgreSQL 17 binaries (tried: ${CANDIDATE_BINS.join(", ")})` };

// Synthetic fixture values, generated per run and never printed. The cluster is
// initdb'd into a fresh temp directory: this file cannot reach an existing database.
const TOKEN = randomBytes(5).toString("hex");
const DB = `cr_r7projdb_${TOKEN}`;
const PG = { host: "127.0.0.1", port: PORT, database: DB } as const;
const ADMIN = { ...PG, user: "r7admin" } as const;
// The PRODUCTION login name. narrow-role-provision.mjs grants this role membership
// in the group and no object ownership, and that is exactly the shape here: no
// superuser, no CREATEROLE, no BYPASSRLS.
const WEB_PASSWORD = `w-${randomBytes(12).toString("hex")}`;
const WEB = { ...PG, user: "control_room_web", password: WEB_PASSWORD } as const;

const scope = { tenantId: `tenant:r7projdb-${TOKEN}`, workspaceId: `workspace:r7projdb-${TOKEN}` };
const OWNER = `identity:r7projdb-owner-${TOKEN}`;
const PROVIDER = "test";
const SESSION_ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const SESSION_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const SUBJECT = `r7projdb-owner-${TOKEN}`;
const TOKEN_DIGEST = sha256Digest({ session: SUBJECT });
const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: SUBJECT, tokenDigest: TOKEN_DIGEST,
  issuedAt: SESSION_ISSUED_AT, expiresAt: SESSION_EXPIRES_AT, verificationExpiresAt: SESSION_EXPIRES_AT };
// A SECOND live owner of the same tenant. Both hold projects.settings on every
// project, so both are entitled to write this row -- and their transactions take
// locks on DIFFERENT identity rows, so nothing serialises them before the INSERT.
// A single-owner fixture cannot see the primary-key race at all, which is why this
// identity exists: the defect is a collision between two writers, and one writer is
// not a collision.
const OWNER_TWO = `identity:r7projdb-owner-two-${TOKEN}`;
const SUBJECT_TWO = `r7projdb-owner-two-${TOKEN}`;
const TOKEN_DIGEST_TWO = sha256Digest({ session: SUBJECT_TWO });
const identityTwo: VerifiedWebIdentity = { provider: PROVIDER, subject: SUBJECT_TWO,
  tokenDigest: TOKEN_DIGEST_TWO, issuedAt: SESSION_ISSUED_AT, expiresAt: SESSION_EXPIRES_AT,
  verificationExpiresAt: SESSION_EXPIRES_AT };
/** The Settings draft with every optional column absent, which is what an untouched panel sends. */
const NO_SETTINGS = { eligibleWorkerKinds: null, maxConcurrentTasks: null, defaultWorkerKind: null,
  defaultModel: null, defaultEffort: null } as const;

/**
 * Every refusal class the two Settings writers can produce, as a stable short name.
 *
 * The PostgreSQL detail is carried in the name on purpose. A CI failure that says
 * only "not_a_web_access_error" leaves the next person with nothing to act on, and
 * the two ways a save can lose a race here -- a unique violation (23505) and a
 * deadlock (40P01) -- have completely different fixes.
 */
const refusalName = (error: unknown): string => {
  if (error instanceof WebAccessError) return error.code;
  const failure = error as { sqlState?: unknown; code?: unknown; detail?: unknown; table?: unknown; where?: unknown };
  const sqlState = typeof failure.sqlState === "string" ? failure.sqlState : String(failure.sqlState);
  const detail = typeof failure.detail === "string" ? failure.detail.replace(/\s+/g, " ").slice(0, 120) : "";
  const table = typeof failure.table === "string" ? failure.table : "";
  return `not_a_web_access_error:${sqlState}:${code2(failure.code)}${table ? `:table=${table}` : ""}${detail ? `:${detail}` : ""}`;
};
const code2 = (value: unknown): string => (typeof value === "string" ? value : String(value));

let run: string | undefined;
let socketDirectory: string | undefined;
let started = false;
let admin: Client | undefined;
const native = (name: string, args: string[]) => exec(join(BIN, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: run ?? tmpdir(), NODE_ENV: "test" },
    timeout: 120_000, maxBuffer: 1 << 26 });

/**
 * The socket lives in a SHORT directory, not beside the data directory.
 *
 * A Unix-domain socket path is capped at ~103 bytes on macOS (104 with the NUL), and
 * `mkdtemp(tmpdir())` is already 47 characters here. `assertGuardBites` hands its child
 * a private TMPDIR and sets ATTACK_KIT_RUN_ROOT to the same place, which pushes
 * `<TMPDIR>/cr-r7projdb-XXXXXX/.s.PGSQL.59203` to 113 bytes -- and the postmaster then
 * fails with "could not start server" for a reason that has nothing to do with the guard
 * under test. Both the shared disposable runner and the attack kit solve this the same
 * way, for the same reason: the socket is ephemeral and is not what any cleanup
 * identifies a cluster by, so it goes in /tmp under a short prefix while the data
 * directory stays where the run can find it.
 */
const SOCKET_PREFIX = "cr-r7pdb-";
/** Longest socket path this will create, including a 5-digit port. */
const MAX_SOCKET_PATH_BYTES = 100;
/**
 * Where the short socket directory is created.
 *
 * `/tmp`, NOT `tmpdir()`: on macOS `tmpdir()` resolves through `confstr` to
 * /var/folders/... and does NOT honour TMPDIR, so a child that was handed a private
 * TMPDIR still gets the 47-character system path here and the socket lands at 110
 * bytes. The attack kit's own runner hard-codes `/tmp` for the same reason and lets
 * ATTACK_KIT_SOCKET_ROOT override it. There is no secret in this path -- it holds one
 * ephemeral socket file, removed with the run.
 */
const SOCKET_ROOT = "/tmp";
/**
 * Where this file's run directories are created.
 *
 * `ATTACK_KIT_RUN_ROOT` when set, `tmpdir()` otherwise. This is not tidiness. The attack
 * kit's mutation helper reaps the clusters its test command started by scanning for
 * `attack-kit-pg-*` directories UNDER the run root it passed in, and its `reap()` only
 * ever looks there. A fixture that puts its data directory somewhere else leaves every
 * cluster it started running after the command exits.
 *
 * Measured cost: the mutation baseline's cluster survived, the mutated run then found its
 * port held, moved to the next port in the block, and produced a result that had nothing
 * to do with the mutation -- which surfaced as "the guard did not bite" for a guard that
 * bites three times out of three. macOS `tmpdir()` ignores TMPDIR, so a fixture cannot
 * rely on the private TMPDIR the helper sets either; the run root is the channel that
 * actually works, and the kit sets it for exactly this reason.
 */
const runRoot = (): string => process.env.ATTACK_KIT_RUN_ROOT?.trim() || tmpdir();
/**
 * The run-directory PREFIX, and why it is the kit's own.
 *
 * `reapKitClusters(parent)` looks for `attack-kit-pg-*` directories directly under
 * `parent`, and for each one reads a cluster registry file to learn the data directory and
 * port of the postmaster it started. This fixture therefore uses the kit's prefix and
 * writes the same registry entry, so the mutation helper's existing reap covers it -- the
 * same way `tests/project-activity-postgres.test.ts` and the mac-local lanes are covered.
 *
 * A private prefix looked tidier and cost the whole mutation lane: nothing reaped the
 * clusters, the baseline's cluster held the port, the mutated run silently moved to the
 * next one, and the result had nothing to do with the mutation. The symptom was
 * "the guard did not bite" for a guard that bites three times out of three.
 */
const RUN_PREFIX = "attack-kit-pg-";
/** The registry file the kit's reaper reads. Same name, same one-object-per-line shape. */
const CLUSTER_REGISTRY = "attack-kit-clusters.json";

const projectId = (label: string) => `project:r7projdb-${label}-${TOKEN}`;
/** One per test, so no test's winner can be another's conflict. */
const PROJECTS = {
  panelRace: projectId("panel-race"),
  singleRace: projectId("single-race"),
  versionOne: projectId("version-one"),
  reload: projectId("reload"),
  backstop: projectId("backstop"),
  twoOwners: projectId("two-owners"),
  twoOwnersChief: projectId("two-owners-chief"),
  panelColumns: projectId("panel-columns"),
  chiefColumns: projectId("chief-columns"),
};

/**
 * The DatabaseClient shape the services take, over ONE already-authenticated client.
 *
 * `beforeStatement` is a test seam and runs BEFORE a statement reaches the server. It is
 * used for exactly one thing -- holding callers at a rendezvous -- and it is here rather
 * than in production code because production has no business knowing a test wants to
 * schedule it. Everything the SQL actually does is untouched: the same connection, the
 * same `control_room_web` login, the same statement, the same grants.
 */
function over(client: Client, beforeStatement?: (sql: string) => Promise<void>): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, values?: unknown[]) => {
    await beforeStatement?.(sql);
    return { rows: (await client.query(sql, values as never[])).rows as T[] };
  } };
  return { query: session.query,
    // Both shapes: the orchestration store writes through transactionWithPreCommitCheck
    // and the project service through the same wrapper. A helper missing one of them
    // would report a TypeError where the product would report a refusal.
    transaction: async <T,>(work: (tx: DatabaseSession) => Promise<T>): Promise<T> => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
    transactionWithPreCommitCheck: async <T,>(work: (tx: DatabaseSession) => Promise<T>): Promise<T> => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    } };
}

/**
 * Hold every caller at the same statement until all of them have arrived.
 *
 * Without it the concurrency proofs are FLAKY, which was measured rather than assumed:
 * under the mutation, 20 callers with two owners failed the proof twice out of three runs,
 * because whether two owners' first saves actually overlapped depends on when their
 * connections happened to connect. A guard whose test is flaky cannot be trusted to
 * report "unpinned", which is the whole question a mutation asks.
 *
 * The barrier changes TIMING only. The statement is then executed for real, on the real
 * connection, under the real login, so what is being measured is still the race between
 * two live transactions and nothing else.
 */
function rendezvous(parties: number, marker: RegExp, boundMs = 60_000): (sql: string) => Promise<void> {
  let arrived = 0, released = false;
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  // ONE release path, so `released` cannot disagree with the gate. A flag set beside a
  // separate resolve is two facts that can drift, and a test reporting "N of 20 arrived"
  // from a flag the gate ignored is worse than no report at all.
  const release = () => { if (released) return; released = true; open(); };
  return async sql => {
    if (!marker.test(sql)) return;
    arrived += 1;
    const allArrived = arrived >= parties;
    if (allArrived) release();
    // A BOUNDED wait, so a caller that never arrives fails with a number rather than
    // hanging the run: one caller refused by its own authorization, or one that took a
    // different branch, would otherwise leave nineteen promises unsettled. Releasing on
    // expiry means the others proceed and report their own results instead of all hanging.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<void>(resolve => { timer = setTimeout(release, boundMs); });
    try { await Promise.race([gate, expiry]); }
    finally { clearTimeout(timer); }
    // The arrival that COMPLETED the party is not late, so it is never reported as one.
    // Reporting on `allArrived` rather than on a timer flag is what makes that true: an
    // earlier version keyed the report on a flag the completing caller could not observe,
    // so a correct 20-of-20 rendezvous still failed every caller.
    if (released && !allArrived && arrived < parties)
      throw new Error(`r7projdb_rendezvous_never_completed:${arrived}_of_${parties}_arrived_within_${boundMs}ms`);
  };
}

const panelSave = (db: DatabaseClient, id: string, expectedVersion: number, cap = 2) =>
  new WebProjectService(db, scope, Date.now).updateSettings(identity, id, { expectedVersion, ...NO_SETTINGS, maxConcurrentTasks: cap });
const chiefSave = (db: DatabaseClient, id: string, expectedVersion: number) =>
  new PostgresProjectOrchestrationStoreV1(db, scope, Date.now).saveSettings({ tenantId: scope.tenantId,
    projectId: id, expectedVersion, choice: { mode: "none" }, writtenByIdentityId: OWNER, now: new Date().toISOString() });
/** The same two writes, performed by the SECOND owner. */
const panelSaveTwo = (db: DatabaseClient, id: string, expectedVersion: number, cap = 2) =>
  new WebProjectService(db, scope, Date.now).updateSettings(identityTwo, id, { expectedVersion, ...NO_SETTINGS, maxConcurrentTasks: cap });
const chiefSaveTwo = (db: DatabaseClient, id: string, expectedVersion: number) =>
  new PostgresProjectOrchestrationStoreV1(db, scope, Date.now).saveSettings({ tenantId: scope.tenantId,
    projectId: id, expectedVersion, choice: { mode: "none" }, writtenByIdentityId: OWNER_TWO, now: new Date().toISOString() });

async function openWeb(): Promise<Client> {
  const client = new Client({ ...WEB, application_name: "control-room-private-web" });
  await client.connect();
  return client;
}

/** Seed every row this file's fixtures need, on the superuser connection only.
 *
 * The superuser seeds and later asserts on stored rows; it never executes a product
 * query. Every behavioural assertion in this file runs through the
 * `control_room_web` login created above, and the first test asserts that
 * explicitly rather than trusting the fixture.
 */
async function seedFixture(): Promise<void> {
    const bootstrap = new Client({ host: PG.host, port: PORT, database: "postgres", user: ADMIN.user });
    await bootstrap.connect();
    try { await bootstrap.query(`CREATE DATABASE ${DB}`); } finally { await bootstrap.end(); }
    admin = new Client(ADMIN);
    await admin.connect();
    // The real ledger and the real role files, in the real order.
    for (const file of (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort())
      await admin.query(await readFile(join(ROOT, "db/migrations", file), "utf8"));
    for (const file of ["production_roles.sql", "private_web_database.sql", "private_web_roles.sql"])
      await admin.query(await readFile(join(ROOT, "db/roles", file), "utf8"));
    // The production login: membership only, exactly as narrow-role-provision.mjs grants it.
    await admin.query(`CREATE ROLE control_room_web LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS PASSWORD '${WEB_PASSWORD}' IN ROLE control_room_private_web`);
    // One tenant, workspace, adapter, owner identity, owner grant and live session. The
    // adapter id is sha256Digest(scope).slice(7,39), which is what WebProjectService's own
    // manualAdapterId() computes -- a fixture id that did not match would be "not found".
    const adapter = `adapter:manual:${sha256Digest(scope).slice(7, 39)}`;
    await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'r7projdb')", [scope.tenantId]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'r7projdb')",
      [scope.workspaceId, scope.tenantId]);
    // 0200's write guard resolves the intake login's tenant through
    // is_work_intake_session() -> work_intake_tenant_binding, so the binding row needs
    // its tenant to EXIST first: it carries a foreign key to tenants(id).
    await admin.query("DELETE FROM work_intake_tenant_binding");
    await admin.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)", [scope.tenantId]);
    await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,
      status,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapter, scope.tenantId]);
    for (const id of Object.values(PROJECTS)) {
      await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
        title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
        VALUES($1,$2,$3,$4,$1,'1','r7projdb project','planned','manual_project_active','healthy',
        'control_room_native',$5,'{}')`, [id, scope.tenantId, scope.workspaceId, adapter, SESSION_ISSUED_AT]);
      await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
        VALUES($1,$2,'active',1,$3,$3)`, [scope.tenantId, id, SESSION_ISSUED_AT]);
    }
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','r7projdb owner',$3,$4,'active',$5,$5)`,
    [OWNER, scope.tenantId, PROVIDER, sha256Digest({ provider: PROVIDER, subject: SUBJECT }), SESSION_ISSUED_AT]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,'owner','["*"]'::jsonb,'["*"]'::jsonb,'critical',true,false,$4,$4)`,
    [`grant:${OWNER}`, scope.tenantId, OWNER, SESSION_ISSUED_AT]);
    await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [scope.tenantId, TOKEN_DIGEST, OWNER, SESSION_ISSUED_AT, SESSION_EXPIRES_AT]);
    // The second owner: an ordinary second identity, granted the same owner role over the
    // same projects. Nothing about it is unusual -- it is what a second person on one
    // installation looks like.
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','r7projdb owner two',$3,$4,'active',$5,$5)`,
    [OWNER_TWO, scope.tenantId, PROVIDER, sha256Digest({ provider: PROVIDER, subject: SUBJECT_TWO }), SESSION_ISSUED_AT]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,'owner','["*"]'::jsonb,'["*"]'::jsonb,'critical',true,false,$4,$4)`,
    [`grant:${OWNER_TWO}`, scope.tenantId, OWNER_TWO, SESSION_ISSUED_AT]);
    await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [scope.tenantId, TOKEN_DIGEST_TWO, OWNER_TWO, SESSION_ISSUED_AT, SESSION_EXPIRES_AT]);
}

/** One start attempt: a fresh data directory, a fresh short socket dir, one port. */
async function startClusterOn(port: number): Promise<void> {
  run = await mkdtemp(join(runRoot(), RUN_PREFIX));
  await mkdir(join(run, "data"), { recursive: true, mode: 0o700 });
  socketDirectory = await mkdtemp(join(SOCKET_ROOT, SOCKET_PREFIX));
  const socketPath = join(socketDirectory, `.s.PGSQL.${port}`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES)
    throw new Error(`r7projdb_socket_path_too_long:${socketPath.length} bytes exceeds the `
      + `${MAX_SOCKET_PATH_BYTES}-byte budget; the temp dir is unusually deep`);
  await native("initdb", ["-D", join(run, "data"), "-U", "r7admin", "--auth-local=trust",
    "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
  // `started` is set AFTER initdb but BEFORE pg_ctl, exactly like the shared disposable
  // runner's: a start that fails after the postmaster has forked leaves a LIVE server
  // behind, and a guard that still reads false would skip the shutdown and hand the next
  // run a bound port plus a data directory with no cluster identity.
  started = true;
  await native("pg_ctl", ["-D", join(run, "data"), "-l", join(run, "server.log"), "-w", "-t", "60", "-o",
    `-p ${port} -k '${socketDirectory}' -c listen_addresses=127.0.0.1 -c shared_buffers=32MB -c max_connections=60 -c fsync=off`,
    "start"]);
  // Registered the moment the postmaster is up, which is what the attack kit's reaper
  // reads after a command is killed: it needs the data directory and port, and a
  // postmaster's pid file is inside the very directory a group kill may already have
  // removed. Append-only, one object per line, for the same reason.
  await appendFile(join(run, CLUSTER_REGISTRY),
    `${JSON.stringify({ port, dataDirectory: join(run, "data"), pgBin: BIN })}\n`, "utf8");
}

/** True when a start failed because something else already holds the port. */
function isPortConflict(error: unknown, log: string): boolean {
  const attached = (error as { serverLog?: string } | null)?.serverLog ?? "";
  return /address already in use|EADDRINUSE|could not bind|could not create any TCP\/IP sockets/iu
    .test(`${String((error as Error)?.message ?? error)}\n${String((error as { stderr?: string } | null)?.stderr ?? "")}\n${attached}\n${log}`);
}

/** Stop whatever this attempt started and remove BOTH of its directories. */
async function discardAttempt(): Promise<void> {
  if (started && run) {
    try { await native("pg_ctl", ["-D", join(run, "data"), "-m", "fast", "-w", "-t", "30", "stop"]); }
    catch {
      // A start that never reached a running state leaves no pid file, which is exactly
      // why pg_ctl refuses. Only a LIVE postmaster is worth escalating.
      const pid = Number((await readFile(join(run, "data", "postmaster.pid"), "utf8").catch(() => "")).split("\n")[0]?.trim());
      if (Number.isSafeInteger(pid) && pid > 1) {
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
        if (alive) throw new Error(`r7projdb_leaked_postmaster:port=${PORT}:pid=${pid}:${run}`);
      }
    }
    started = false;
  }
  // BOTH directories, on every path: the data directory is in `run` and the socket
  // directory is outside it, so removing `run` alone leaves a /tmp entry per attempt.
  await Promise.all([...[run, socketDirectory]
    .filter((path): path is string => typeof path === "string")
    .map(path => rm(path, { recursive: true, force: true }))]);
  run = undefined; socketDirectory = undefined;
}

before(async () => {
  if (!PG_AVAILABLE) return;
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  // ONE cluster for this file, on the first free port of the block this job was assigned.
  // The port is retried rather than hard-failing because a leaked postmaster from an
  // interrupted run holds exactly one port, and the alternative -- failing with
  // "could not start server" -- reports a fixture problem where the real answer is "that
  // port is busy". Every failed attempt is discarded, so a collision costs a directory,
  // not a leak. The shared disposable runner retries the same way for the same reason.
  let lastError: unknown;
  for (const port of PORT_BLOCK) {
    try { await startClusterOn(port); PORT = port; await seedFixture(); return; }
    catch (error) {
      const log = await readFile(join(run ?? "", "server.log"), "utf8").catch(() => "");
      lastError = error;
      await discardAttempt();
      if (!isPortConflict(error, log)) throw error;
    }
  }
  throw new Error(`r7projdb_no_free_port_in_${PORT_BLOCK[0]}-${PORT_BLOCK[PORT_BLOCK.length - 1]}:`
    + `${String((lastError as Error)?.message ?? lastError)}`);
});


after(async () => {
  await admin?.end().catch(() => {});
  // ONE teardown path, shared with the failed-start retry, because two copies of this
  // logic is how they drift. A failed stop is REPORTED rather than swallowed: an earlier
  // version wrote it to stderr and carried on, which let a genuinely leaked postmaster
  // keep its port while the run moved on. A leak here blocks the next run of this lane
  // with "could not start server", which reads as a fixture bug rather than as the mess.
  await discardAttempt();
});

test("20 concurrent FIRST saves across both Settings panels: one winner, named conflicts, zero unavailable",
  { timeout: 240_000 }, async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  const web = await openWeb();
  try {
    assert.equal((await web.query("SELECT current_user AS u")).rows[0].u, "control_room_web",
      "the proof must run as the production login, not the superuser that seeded it");
    // Start from no settings row at all: this is the state of every project the owner
    // has not touched, and the state the empty SELECT ... FOR UPDATE cannot lock.
    assert.equal((await admin!.query("SELECT count(*)::int AS n FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.panelRace])).rows[0].n, 0);

    // TWENTY SEPARATE CONNECTIONS. One client cannot run twenty concurrent
    // transactions -- they would interleave inside a single BEGIN, which tests
    // nothing about the race. Each caller below is its own authenticated connection,
    // which is what "concurrent" means to a connection pool.
    const WRITERS = 20;
    const results = await Promise.allSettled(Array.from({ length: WRITERS }, async (_unused, index) => {
      const client = await openWeb();
      try {
        // Half from each panel, which is the real shape: the owner has both mounted.
        return index % 2 === 0
          ? await panelSave(over(client), PROJECTS.panelRace, 0, 1 + (index % 5))
          : await chiefSave(over(client), PROJECTS.panelRace, 0);
      } finally { await client.end(); }
    }));

    const won = results.filter(result => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const names = lost.map(result => refusalName(result.reason));
    const tally = names.reduce<Record<string, number>>((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1; return acc; }, {});

    assert.equal(won.length, 1, `exactly one of ${WRITERS} first-row writers may win; got ${won.length}`);
    assert.equal(lost.length, WRITERS - 1);
    // The whole point: nothing reached the owner as an outage. `database_unavailable`
    // is what the installed driver calls a 23505, and what the browser client turns
    // into "Project settings are not connected or are unavailable."
    assert.equal(tally.database_unavailable ?? 0, 0,
      `no first-row save may be reported as unavailable; refusals were ${JSON.stringify(tally)}`);
    // Every loser is a NAMED refusal. A refusal this file cannot name is a class
    // change, not a tolerated variation.
    assert.deepEqual(Object.keys(tally), ["conflict"],
      `every losing first save must be the named conflict; got ${JSON.stringify(tally)}`);

    // The stored row is exactly one, and its version is exactly one increment: the
    // twenty callers between them may add one version, never twenty.
    const rows = (await admin!.query("SELECT count(*)::int AS n, coalesce(max(version),0)::int AS v FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.panelRace])).rows[0];
    assert.equal(rows.n, 1);
    assert.equal(rows.v, 1);
    // And the winner's own values are the ones stored, so the loser wrote nothing.
    const stored = (await admin!.query("SELECT max_concurrent_tasks, planner_mode FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.panelRace])).rows[0];
    if (stored.planner_mode === "none") assert.equal(stored.max_concurrent_tasks, null,
      "the chief-of-staff panel created this row, so it left the worker-settings columns unset");
    else assert.ok(typeof stored.max_concurrent_tasks === "number");
  } finally { await web.end(); }
});

test("20 concurrent FIRST saves by TWO different owners: still one winner, still no unavailable",
  { timeout: 240_000 }, async t => {
    if (needsPg) { t.skip(needsPg.skip); return; }
    // THE TEST THAT PINS THE FIX, and the one the single-owner case above cannot
    // replace. Both writers lock their OWN identity row, so two different owners are
    // not serialised before the INSERT and both reach it for one (tenant_id,
    // project_id). One owner per installation would make every first save trivially
    // safe -- and the fix would look pinned while proving nothing.
    //
    // Measured on this cluster, real login, 8 rounds x 20 callers, alternating
    // identities: with the INSERT carrying DO NOTHING, 8 winners and 152 named
    // conflicts; with it removed, 8 winners and 50 raw 23505 unique violations. That
    // is the difference between a conflict the owner can act on and an outage they
    // cannot.
    const WRITERS = 20;
    // Every caller passes the settings version read on its way to the INSERT, so holding
    // them there makes "all twenty read version 0 and then insert" a certainty rather than
    // a scheduling accident -- which is the precondition the race is about.
    // NO BARRIER HERE, and the reason is worth more than the barrier would have been.
    // A rendezvous is only usable when EVERY caller issues the marked statement, and half
    // of these callers never do: the chief-of-staff calls go straight to the store, which
    // takes no session and so issues no identity read. Measured with the barrier in place:
    // 2 of 20 arrived, the other 18 waited out a 60-second bound and failed with no
    // SQLSTATE at all. The chief-only test below is where the arrival is guaranteed, and
    // the mixed race is measured by repetition there instead.
    // REPEATED over fresh projects rather than gated on a barrier. Without a rendezvous
    // the overlap between two owners' first saves depends on connection timing, which was
    // measured to be flaky under mutation -- the proof failed twice out of three runs. A
    // barrier is the better tool where it applies (the chief-only test below), but it
    // cannot apply here because half these callers issue no session read at all. Eight
    // rounds of twenty is 160 racing callers, and a defect that can only appear when two
    // writers overlap is not one that survives sixteen independent attempts to overlap.
    const ROUNDS = 8;
    for (let round = 0; round < ROUNDS; round += 1) {
      const project = `${PROJECTS.twoOwners}-round${round}`;
      await admin!.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,
        source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
        VALUES($1,$2,$3,$4,$1,'1','r7projdb round','planned','manual_project_active','healthy',
        'control_room_native',$5,'{}')`,
      [project, scope.tenantId, scope.workspaceId,
        `adapter:manual:${sha256Digest(scope).slice(7, 39)}`, SESSION_ISSUED_AT]);
      await admin!.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
        VALUES($1,$2,'active',1,$3,$3)`, [scope.tenantId, project, SESSION_ISSUED_AT]);

      const results = await Promise.allSettled(Array.from({ length: WRITERS }, async (_unused, index) => {
        const client = await openWeb();
        // Alternating identities, so half the callers hold a different identity lock.
        const second = index % 2 === 1;
        try {
          return index % 4 < 2
            ? await (second ? panelSaveTwo : panelSave)(over(client), project, 0, 1 + (index % 5))
            : await (second ? chiefSaveTwo : chiefSave)(over(client), project, 0);
        } finally { await client.end(); }
      }));
      const won = results.filter(result => result.status === "fulfilled");
      const names = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => refusalName(result.reason));
      const tally = names.reduce<Record<string, number>>((acc, name) => {
        acc[name] = (acc[name] ?? 0) + 1; return acc; }, {});
      assert.equal(won.length, 1,
        `exactly one of ${WRITERS} first-row writers may win in round ${round}; got ${won.length}: ${JSON.stringify(tally)}`);
      assert.equal(tally.database_unavailable ?? 0, 0,
        `two owners must not turn a first save into an outage; refusals in round ${round}: ${JSON.stringify(tally)}`);
      assert.deepEqual(Object.keys(tally), ["conflict"],
        `every losing first save must be the named conflict; round ${round} gave ${JSON.stringify(tally)}`);
      const stored = (await admin!.query("SELECT count(*)::int AS n, coalesce(max(version),0)::int AS v FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
        [scope.tenantId, project])).rows[0];
      assert.deepEqual({ n: stored.n, v: stored.v }, { n: 1, v: 1 }, `round ${round} stored ${stored.n} rows at version ${stored.v}`);
    }
  });

test("a single panel's 20 concurrent first saves reach the same answer", { timeout: 240_000 }, async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // The finding described the collision as happening between the two panels, but the
  // primary key is on (tenant_id, project_id) alone: ONE panel firing twenty first
  // saves is the same defect, so it gets its own measurement rather than being
  // assumed to follow from the mixed one above.
  const results = await Promise.allSettled(Array.from({ length: 20 }, async (_unused, index) => {
    const client = await openWeb();
    try { return await panelSave(over(client), PROJECTS.singleRace, 0, 1 + (index % 5)); }
    finally { await client.end(); }
  }));
  const won = results.filter(result => result.status === "fulfilled");
  const names = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => refusalName(result.reason));
  assert.equal(won.length, 1, `exactly one single-panel first-row writer may win; got ${won.length}`);
  assert.ok(names.length === 19 && names.every(name => name === "conflict"),
    `all 19 losing single-panel saves must be conflicts; got ${JSON.stringify(names.reduce<Record<string, number>>(
      (acc, name) => { acc[name] = (acc[name] ?? 0) + 1; return acc; }, {}))}`);
  const stored = (await admin!.query("SELECT version::int AS v FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
    [scope.tenantId, PROJECTS.singleRace])).rows[0];
  assert.equal(stored.v, 1);
});

test("20 concurrent FIRST chief-of-staff saves by TWO owners: the orchestration INSERT needs its own guard",
  { timeout: 240_000 }, async t => {
    if (needsPg) { t.skip(needsPg.skip); return; }
    // The mixed two-owner test above CANNOT see this. Mixing the panels means each
    // identity's worker-settings saves and chief-of-staff saves serialise through the
    // same identity row lock, and whichever arrives first creates the row -- so the
    // other panel's INSERT is never reached and deleting the orchestration guard
    // changes nothing. It is a separate INSERT in a separate file, so it needs a race
    // of its own.
    //
    // Measured with this shape and the guard removed, on this cluster and this login:
    // 50 raw 23505 unique violations across 160 callers. With the guard, 8 winners and
    // 152 named conflicts.
    // The same rendezvous, for the same reason: twenty callers, two identities, all of them
    // reading version 0 before any of them inserts.
    const hold = rendezvous(20, /SELECT version FROM control_project_settings\s+WHERE tenant_id=\$1 AND project_id=\$2 FOR UPDATE/);
    const results = await Promise.allSettled(Array.from({ length: 20 }, async (_unused, index) => {
      const client = await openWeb();
      try {
        return await (index % 2 === 1 ? chiefSaveTwo : chiefSave)(over(client, hold), PROJECTS.twoOwnersChief, 0);
      } finally { await client.end(); }
    }));
    const won = results.filter(result => result.status === "fulfilled");
    const names = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => refusalName(result.reason));
    const tally = names.reduce<Record<string, number>>((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1; return acc; }, {});
    assert.equal(won.length, 1, `exactly one of 20 first-row chief-of-staff writers may win; got ${won.length}: ${JSON.stringify(tally)}`);
    assert.equal(tally.database_unavailable ?? 0, 0,
      `two owners must not turn a first chief-of-staff save into an outage; refusals were ${JSON.stringify(tally)}`);
    assert.deepEqual(Object.keys(tally), ["conflict"],
      `every losing chief-of-staff save must be the named conflict; got ${JSON.stringify(tally)}`);
    const stored = (await admin!.query("SELECT count(*)::int AS n, coalesce(max(version),0)::int AS v FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.twoOwnersChief])).rows[0];
    assert.deepEqual({ n: stored.n, v: stored.v }, { n: 1, v: 1 });
  });

test("each panel's first save leaves the OTHER panel's columns alone", { timeout: 240_000 }, async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // The shared first-row statement names its columns per CALLER, and that is load-bearing
  // rather than tidiness. 0201's planner_mode is NOT NULL DEFAULT 'inherit': a writer that
  // does not mention it inherits 'inherit', and a writer that names it NULL is refused. So
  // the worker-settings panel must not name any planner column, and the chief-of-staff
  // panel must name planner_mode explicitly.
  //
  // This was a real regression, caught by the concurrency test the moment the two
  // statements were merged: one shared column list made a worker-settings first save store
  // planner_mode = NULL, which 0201's coherence CHECK refuses outright and which would
  // have left the row unreadable. A test that only checked the race would have shipped it.
  const web = await openWeb();
  try {
    const db = over(web);
    await panelSave(db, PROJECTS.panelColumns, 0, 5);
    const afterPanel = (await admin!.query(
      "SELECT planner_mode,planner_worker_id,planner_worker_kind,planner_model,planner_effort,version,max_concurrent_tasks FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.panelColumns])).rows[0];
    // 'inherit', the column default: this panel said nothing about a chief of staff, and
    // 0201's own default is the honest value for "no opinion".
    assert.deepEqual(afterPanel, { planner_mode: "inherit", planner_worker_id: null, planner_worker_kind: null,
      planner_model: null, planner_effort: null, version: 1, max_concurrent_tasks: 5 },
      "a worker-settings first save must not write any planner column");

    await chiefSave(db, PROJECTS.chiefColumns, 0);
    const afterChief = (await admin!.query(
      "SELECT planner_mode,planner_worker_id,planner_worker_kind,max_concurrent_tasks FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.chiefColumns])).rows[0];
    // 'none' is the deliberate owner choice this panel stores, and it cleared every
    // selected column, as 0201's coherence CHECK requires.
    assert.deepEqual(afterChief, { planner_mode: "none", planner_worker_id: null, planner_worker_kind: null,
      max_concurrent_tasks: null },
      "a chief-of-staff first save writes planner_mode explicitly and leaves the worker columns unset");
  } finally { await web.end(); }
});

test("after the row exists, the UPDATE path still refuses a stale version and still increments by one",
  { timeout: 240_000 }, async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // The fix is scoped to the INSERT branch. This asserts the other half of the
  // contract still holds on the same real login: a row that exists is locked by
  // SELECT ... FOR UPDATE, so the compare-and-set is exact and the loser is a conflict.
  const web = await openWeb();
  try {
    const db = over(web);
    assert.equal((await panelSave(db, PROJECTS.versionOne, 0, 2)).version, 1);
    await assert.rejects(panelSave(db, PROJECTS.versionOne, 0, 3),
      (error: unknown) => error instanceof WebAccessError && error.code === "conflict",
      "a stale expectedVersion on an existing row is still refused, not silently overwritten");
    // 20 concurrent saves at the SAME expectedVersion: one winner, nineteen conflicts.
    const results = await Promise.allSettled(Array.from({ length: 20 }, async (_unused, index) => {
      const client = await openWeb();
      try { return await panelSave(over(client), PROJECTS.versionOne, 1, 1 + (index % 5)); }
      finally { await client.end(); }
    }));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const names = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => refusalName(result.reason));
    assert.ok(names.every(name => name === "conflict"), `expected only conflicts; got ${names.join(",")}`);
    const stored = (await admin!.query("SELECT version::int AS v FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.versionOne])).rows[0];
    assert.equal(stored.v, 2, "one increment, not twenty");
  } finally { await web.end(); }
});

test("a first save rejected as a conflict leaves nothing behind, and the next save reads the winner's version",
  { timeout: 240_000 }, async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // The unhappy path a caller actually hits: press Save twice. The second press must
  // not create a row, must not bump the version, and must leave the row readable at the
  // version the winner committed -- otherwise a retry has nothing to be a retry OF.
  const web = await openWeb();
  try {
    const db = over(web);
    const first = await panelSave(db, PROJECTS.reload, 0, 4);
    assert.equal(first.version, 1);
    await assert.rejects(panelSave(db, PROJECTS.reload, 0, 9), (error: unknown) =>
      error instanceof WebAccessError && error.code === "conflict");
    const after = (await admin!.query("SELECT count(*)::int AS n, coalesce(max(version),0)::int AS v, coalesce(max(max_concurrent_tasks),-1)::int AS cap FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, PROJECTS.reload])).rows[0];
    assert.deepEqual(after, { n: 1, v: 1, cap: 4 }, "the rejected save wrote nothing at all");
    // The owner's retry: re-read, then save at the version the winner left.
    const reread = await new WebProjectService(db, scope, Date.now).readSettings(identity, PROJECTS.reload);
    assert.equal(reread.version, 1);
    assert.equal((await panelSave(db, PROJECTS.reload, reread.version, 7)).version, 2);
  } finally { await web.end(); }
});

test("every guard on the first-row path is real: mutation-proved on the working tree",
  { timeout: 900_000 }, async () => {
    // CLASS, by mutation rather than by inspection. Each guard is deleted on the REAL
    // working tree and the concurrency proof above must go RED. `assertGuardBites`
    // refuses a dirty tree, restores the file in every exit path, and verifies the
    // restore by digest.
    //
    // The child command re-runs THIS file, so each mutation names the specific tests it
    // must break: a broken INSERT still leaves the purely sequential tests green, so
    // without the concurrency proof in the child's scope this whole check would pass
    // vacuously.
    //
    // The child needs its OWN port block. This process's cluster still holds PORT while
    // the child runs, and a child that failed to bind would be reported as "the guard
    // did not bite" -- a fixture collision read as evidence about the guard. The
    // helper has no per-command `env` option (it builds the child environment from
    // `process.env`, see its commandEnv()), so the port travels through the environment
    // for the duration of the call and is restored afterwards.
    // Every first-row guard now lives in ONE file, so every mutation targets that file.
    // Two panels with two near-identical statements is what let one of them carry a
    // guard the other lacked.
    const SHARED = "src/web/v1/project-settings-first-row.ts";
    // The refusal-mapping test, which needs no PostgreSQL and runs in a second, so it is
    // the scope that can actually observe the 23505 backstop being deleted.
    const refusalTest = "nothing else is swallowed";
    const childPort = String(PORT + 1);
    const concurrencyTests = ["concurrent FIRST saves across both Settings panels",
      "single panel's 20 concurrent first saves", "the UPDATE path still refuses a stale version",
      "leaves nothing behind"];
    // The two-owner test is the FIRST name in every mutation scope, and it is first for
    // a reason that cost a full mutation run to establish: the identity lock in the fix
    // serialises two saves by the SAME owner before either reaches the INSERT, so with
    // one owner a bare INSERT is unreachable and deleting DO NOTHING changes nothing the
    // single-owner test can see. Two owners lock two different identity rows, so the
    // primary-key race is live again and the guard is the only thing standing between it
    // and the owner's "unavailable". A mutation scope that omitted it would have
    // reported this guard as unpinned while the guard was perfectly well pinned.
    const twoOwnerTest = "TWO different owners";
    // The chief-of-staff-only race. A separate substring from the mixed two-owner test
    // above, so `--test-name-pattern` can select it alone: the mixed test lets one
    // identity's worker-settings save create the row first, which makes the
    // orchestration INSERT unreachable and the guard invisible.
    const chiefRaceTest = "TWO owners: the orchestration INSERT";
    const firstRowTests = [twoOwnerTest, ...concurrencyTests];
    const runChild = (names: readonly string[]) => ["node", "--import", "tsx", "--test",
      "--test-concurrency=1", ...names.flatMap(name => ["--test-name-pattern", name]),
      "tests/project-settings-first-row-race-postgres.test.ts"];

    const previousPort = process.env.PROJECT_SETTINGS_RACE_PG_PORT;
    process.env.PROJECT_SETTINGS_RACE_PG_PORT = childPort;
    try {
      const bites = async (file: string, find: string, replace: string, names: readonly string[],
        because: string, label: string) => {
        try {
          await assertGuardBites({ root: REPOSITORY_ROOT, file, find, replace,
            testCmd: runChild(names), boundMs: 300_000, baselineBoundMs: 300_000, because });
        } catch (error) {
          if (error instanceof GuardDidNotBiteError) assert.fail(
            `the ${label} guard is unpinned: removing it left the concurrency proof green.\n${error.message}`);
          throw error;
        }
      };
      // TWO mechanisms answer a lost first-row race, and this file MEASURES which of them
      // is load-bearing rather than assuming it. That question was not academic. The two
      // panels each carried one of them, which is why the first mutation run reported this
      // guard "unpinned" while it was pinned, and why no single-deletion check could bite.
      //
      //   * DO NOTHING alone: deleting the clause leaves the 23505 translation below to
      //     catch the violation, so the concurrency tests stay GREEN. Measured.
      //   * the 23505 translation alone: deleting it leaves DO NOTHING to prevent the
      //     violation, so those same tests stay GREEN. Measured.
      //   * BOTH together: this bites. The concurrency tests go red with 18 raw
      //     `23505 ... already exists` refusals among 19 losers, which is the whole
      //     owner-facing defect. A single-deletion check would have called one half
      //     unpinned while the other quietly held the line.
      // THE WHOLE PROTECTED REGION, which is contiguous in the file: the DO NOTHING clause,
      // the RETURNING row count, and the 23505 translation.
      //
      // It has to be all three, and that was MEASURED rather than assumed, at the cost of
      // several false "unpinned" reports. Removing the DO NOTHING clause alone leaves the
      // 23505 translation to catch the violation and answer `conflict`; removing the
      // translation alone leaves the DO NOTHING to prevent it. Either half holds the line
      // on its own, so either single-deletion mutation leaves the concurrency proof green
      // -- which is exactly what a mutation harness reports as "the guard did not bite".
      //
      // Only removing all three lets the raw 23505 reach the owner, and that is the state
      // this measures: 18 raw `23505 ... already exists` refusals among 19 losers.
      //
      // The `find` text is COPIED FROM THE FILE rather than retyped. assertGuardBites
      // refuses an absent target outright, which is right, and a retyped indentation is
      // the most expensive possible typo: the run reports mutation_target_absent and says
      // nothing whatever about whether the guard is pinned.
      await bites(SHARED,
        "ON CONFLICT (tenant_id,project_id) DO NOTHING RETURNING version`,\n"
        + "      [...values]);\n"
        + '    if (inserted.rows.length !== 1) throw new WebAccessError("conflict");\n'
        + "  } catch (error) {\n"
        + "    // The conflict thrown just above is this class already and must not be re-read as a\n"
        + "    // database refusal. `conflict` is eight characters and so never matches the SQLSTATE\n"
        + "    // shape, but being explicit keeps the ordering from mattering to a reader.\n"
        + "    if (error instanceof WebAccessError) throw error;\n"
        + '    if (databaseSqlStateIsAnyV1(error, ["23505"])) throw new WebAccessError("conflict");',
        "RETURNING version`,\n"
        + "      [...values]);\n"
        + "  } catch (error) {",
        firstRowTests,
        "a lost first-row save must be a named conflict: DO NOTHING avoids the violation and the 23505 "
        + "translation catches what it cannot, and neither half is the whole answer",
        "both first-row mechanisms");
      // The RETURNING row count, deleted ENTIRELY. This is what stops a loser reporting
      // the winner's save as its own: without it the inserted row count is never read, so
      // every caller returns version 1 and several callers believe they wrote this row. It
      // is independent of the two above, so this mutation bites on its own.
      await bites(SHARED,
        "if (inserted.rows.length !== 1) throw new WebAccessError(\"conflict\");",
        "if (inserted.rows.length !== 99) void 0;",
        firstRowTests,
        "reading one row back is what distinguishes the writer that created the row from the one that lost the race",
        "RETURNING row count");
      // The 23503 translation, which is NOT part of the race defence: a foreign key here
      // means the project or identity is gone, which is `not_found` and not `conflict`.
      // Deleting it must make that reading wrong, so it is proved on the pure refusal test
      // rather than on a cluster -- a real cluster cannot produce a concurrent DELETE of the
      // project mid-save without racing the FK check, so a cluster test would be vacuous.
      await bites(SHARED,
        'if (databaseSqlStateIsAnyV1(error, ["23503"])) throw new WebAccessError("not_found");\n', "",
        [refusalTest],
        "a foreign key here means the project or identity is gone, which is not available rather than changed",
        "23503 translation");
      // THE LOCK ORDER. The guard this file's stress test found by measurement, and the one
      // a reviewer is most likely to call unnecessary: without it 12 of the 19 losers are
      // killed by PostgreSQL's deadlock detector with 40P01, which the bounded driver
      // reports as `database_unavailable` exactly as it reported the 23505 did. Deleting it
      // must reproduce the deadlocks, not merely fail a check.
      await bites("src/web/v1/project-orchestration-postgres-store.ts",
        "await tx.query(`SELECT id FROM control_identities WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE`,\n"
        + "        [input.tenantId, input.writtenByIdentityId]);\n",
        "",
        ["concurrent FIRST saves across both Settings panels"],
        "the two Settings writers must take the identity lock in one order; the reverse order deadlocks and is still an outage to the owner",
        "lock order");
    } finally {
      if (previousPort === undefined) delete process.env.PROJECT_SETTINGS_RACE_PG_PORT;
      else process.env.PROJECT_SETTINGS_RACE_PG_PORT = previousPort;
    }
  });

test("a unique violation reaching the orchestration INSERT is the named conflict, and nothing else is swallowed",
  async () => {
    // NO PostgreSQL, and deliberately so: this branch is unreachable while DO NOTHING
    // stands, so a real cluster can never drive it. It exists for a DIFFERENT writer
    // class -- a unique index added to control_project_settings later -- and it is
    // proved with the refusal itself, which is the only honest input available.
    //
    // Three classes, three answers, all through the real store method:
    //   23505 -> conflict   (another writer, one row: the conflict it is)
    //   23503 -> not_found  (the project went away under the caller's feet)
    //   42P01 -> rethrown   (a genuinely foreign failure must not be relabelled)
    // Asserting all three matters because a branch written as "if 23505 conflict"
    // would also pass a two-class test; it is the `throw error` arm that proves the
    // mapping is a classification rather than a catch-all.
    const storeWith = async (insertFailure: unknown) => new PostgresProjectOrchestrationStoreV1({
      query: async () => { throw new Error("only the transaction path may run"); },
      transaction: async () => { throw new Error("only the transaction path may run"); },
      transactionWithPreCommitCheck: async (work: (tx: DatabaseSession) => Promise<unknown>) => {
        // Only the INSERT is refused. The version SELECT succeeds and reports no row,
        // which is exactly what an absent settings row looks like, so the caller is
        // on the first-save branch.
        await work({ query: async <T>(sql: string) => {
          if (/^\s*INSERT/i.test(sql)) throw insertFailure;
          return { rows: [] as T[] };
        } });
      },
    } as unknown as DatabaseClient, scope, Date.now);
    const save = (store: PostgresProjectOrchestrationStoreV1) => store.saveSettings({
      tenantId: scope.tenantId, projectId: PROJECTS.backstop, expectedVersion: 0, choice: { mode: "none" },
      writtenByIdentityId: OWNER, now: "2026-10-03T00:00:00.000Z" });

    await assert.rejects(save(await storeWith({ sqlState: "23505", message: "synthetic unique violation" })),
      (error: unknown) => error instanceof WebAccessError && error.code === "conflict",
      "a unique violation from another writer is the conflict class, not an outage");
    await assert.rejects(save(await storeWith({ sqlState: "23503", message: "synthetic foreign key violation" })),
      (error: unknown) => error instanceof WebAccessError && error.code === "not_found",
      "the pre-existing 23503 reading is unchanged: the project is not there any more");
    await assert.rejects(save(await storeWith({ sqlState: "42P01", message: "synthetic undefined column" })),
      (error: unknown) => !(error instanceof WebAccessError),
      "a refusal outside both classes must travel unchanged rather than be relabelled");
    // The raw `code` shape as well as `sqlState`: the installed driver puts the state on
    // `sqlState` and its own wrapper code on `code`, and this mapping must not depend
    // on which one carried it.
    await assert.rejects(save(await storeWith({ code: "23505", message: "synthetic unique violation by code" })),
      (error: unknown) => error instanceof WebAccessError && error.code === "conflict",
      "the refusal is read through the one SQLSTATE reader, so the driver's own code field works too");
  });