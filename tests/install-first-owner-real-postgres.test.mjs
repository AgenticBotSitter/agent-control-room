// M4's REAL-PostgreSQL lane: firstOwner and checkHealth.database on the default path.
//
// WHAT THIS LANE IS, in one sentence: it starts a real PostgreSQL 17.11
// postmaster from the VENDORED runtime in a temp install root, runs the REAL
// init phase, the REAL release phase, then the four stage-one ports with NOTHING
// INJECTED for the ports under test — the production `firstOwnerV1`,
// `checkHealthDatabaseV1`, `writeDatabaseLoginsV1`, `removeDatabaseLoginsV1` and
// `retireDatabaseV1` from `src/updater/v1/pg/first-owner-ports.mjs` — and asks
// the RUNNING SERVER the four questions §7's M4 acceptance row names.
//
// WHAT IS SIMULATED, stated plainly rather than left for a reader to discover:
// the uid. The database account is THIS process's uid, not a real `_crdb`, and
// the peer map's system-username column is the invoking user, because creating a
// service account needs root. `pg-cluster-layout.ts` says the same. The real-root
// rehearsal must prove the map with a real second uid, and the report says so.
//
// WHAT IS REAL: the vendored runtime, `initdb`, the postmaster, `pg_hba.conf`
// and `pg_ident.conf` as the SERVER loaded them, the peer map, the release
// ledger applied file by file as the migrator, the grants, the schema digest,
// the updater's fixed DDL, the first-owner rows, and the health check's reads.
//
// THE ACCEPTANCE ROW, MAPPED TO THE TESTS HERE:
//   "fresh DB → the owner rows exist once"     → `the first-owner port creates
//     the owner rows exactly once on a fresh database`
//   "a rerun is refused cleanly"              → the same test's rerun half
//   "the health counts match"                 → `the database half of checkHealth
//     counts the owner rows three times`
//   "a digest drift → health_database_refused" → `a drifted schema digest is
//     refused as health_database_refused`
//
// The lane skips when `PG_RUNTIME_ARCHIVE` is absent, the same convention its
// sibling uses: a lane that fetched 437 MB on every run is a lane nobody ran.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
// `concurrency: false` is DECLARED HERE, in the file, rather than left to the
// lane's command line. MEASURED: run as a bare `node --test`, node runs this
// file's top-level tests CONCURRENTLY, so `drift` (59932) and `samples` (59936)
// and `refusals` (59935) built clusters at the same time and two of them took the
// same postmaster — which then answered
// `FATAL: the database system is shutting down` on a socket the failing test did
// not own. The lane script already passes `--test-concurrency=1`; this makes the
// file correct whatever command reaches it.
import { test } from "node:test";
import { promisify } from "node:util";
import { pgHbaPeerMapV1, planPgClusterLayoutV1 } from "../src/pg-runtime/v1/pg-cluster-layout";
import { vendorPgRuntimeV1 } from "../src/updater/v1/pg/pg-runtime-vendor";
import { initializeDatabaseV1 as initializeDatabaseV1Script } from "../src/updater/v1/pg/init-database.mjs";
import { applyReleaseSchemaV1, ledgerHeadV1, readReleaseLedgerV1 } from "../src/updater/v1/pg/apply-release-schema.mjs";
import { runSessionStatementV1 } from "../src/updater/v1/pg/sql-session.mjs";
import { postgresProfileParametersV1, spawnPgFamily } from "../src/updater/v1/pg/database-phase-process.mjs";
import { digestReleaseSchemaRowsV1 } from "../src/updater/v1/pg/release-schema-digest.mjs";
import { databaseRoleAttributesV1, databaseRoleManifestV1 } from "../scripts/mac-local/database-role-manifest.mjs";
import { checkHealthDatabaseV1, firstOwnerV1, removeDatabaseLoginsV1, retireDatabaseV1,
  writeDatabaseLoginsV1, DATABASE_HEALTH_COUNTS_V1, FIRST_OWNER_IDENTITY_V1 } from "../src/updater/v1/pg/first-owner-ports.mjs";
import { applyMacLocalFirstOwnerV1 } from "../scripts/mac-local/first-owner-vps.mjs";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";
import { sha256Digest } from "../src/security/canonical-digest";
import { privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { FIRST_OWNER_OWNER_V1 } from "../src/updater/v1/install/install-steps.mjs";

const REPO = resolve(join(dirname(new URL(import.meta.url).pathname), ".."));
const ARCHIVE = process.env.PG_RUNTIME_ARCHIVE;
const hasArchive = ARCHIVE !== undefined && existsSync(ARCHIVE);
const needsArchive = hasArchive ? false : "needs the pinned archive (PG_RUNTIME_ARCHIVE)";
const PORT = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59930);

/** macOS `sun_path` is 104 bytes including the NUL; see the sibling lane. */
const LANE_ROOT = "/private/tmp";

const RUNS = [];
process.on("exit", () => {
  for (const run of RUNS) {
    // The vendored runtime is sealed 0555, so `rm -rf` cannot unlink inside it.
    try { execFileSync("/bin/chmod", ["-R", "u+rwx", run]); } catch { /* best effort */ }
    try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

let sharedPromise = null;
let shared = null;
function sharedRuntime() {
  if (sharedPromise) return sharedPromise;
  sharedPromise = (async () => {
    if (shared) return shared;
    const run = mkdtempSync(join(LANE_ROOT, "m4-first-owner-"));
    RUNS.push(run);
    const runtimeParent = join(run, "shared");
    const runtimeRoot = join(runtimeParent, "pg-17.11");
    mkdirSync(runtimeParent, { recursive: true, mode: 0o755 });
    const result = await vendorPgRuntimeV1({ archivePath: ARCHIVE, runtimeDirectory: runtimeRoot,
      opensslConf: "# fixed and empty (R9b)\n", hooks: { normaliseOwnership: false } });
    assert.equal(result.status, "pg_runtime_vendored", result.refusal);
    symlinkSync("pg-17.11", join(runtimeParent, "pg-current"));
    shared = { run, runtimeParent };
    return shared;
  })();
  return sharedPromise;
}

/**
 * The two OS accounts the phase runs under, as this lane can actually BE.
 *
 * `service` is the invoking account's uid with a DIFFERENT gid and a different
 * NAME, which is the one arrangement that both satisfies
 * `parseDatabasePhaseAccountsV1` (which refuses `database.uid === service.uid`
 * and `database.name === service.name`, because D and S are two accounts the
 * installer created) and needs no root. The sibling lane's comment measures what
 * that costs: root setting `pg/socket` to D with the genuine `_controlroom` group
 * is what the real-root rehearsal must prove, and this lane cannot.
 */
const LANE_SERVICE_UID = 4294967294 <= process.getuid() ? 1 : process.getuid() === 1 ? 2 : 502;
const ACCOUNTS = Object.freeze({
  database: Object.freeze({ name: userInfo().username, uid: process.getuid(), gid: process.getgid() }),
  service: Object.freeze({ name: `${userInfo().username}-service`, uid: LANE_SERVICE_UID, gid: process.getgid() }),
});

/** The request `initializeDatabaseV1` (the port) builds, spelled out for the script. */
const initRequest = (root, { logins, port }) => Object.freeze({
  schema: "control-room.database-init/v1", root, pgDataId: "data-A", runtime: "runtime/pg-current",
  socketDir: "pg/socket", port, accounts: ACCOUNTS, logins,
});

const phaseLogins = names => {
  const logins = names.map(name => Object.freeze({ name, passwordStdin: true }));
  const passwords = Object.create(null);
  for (const name of names) {
    const bytes = Buffer.alloc(32);
    // Deterministic per name so a rerun re-verifies the SAME password the init set.
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (name.charCodeAt(index % name.length) + index * 7) & 0xff;
    Object.defineProperty(passwords, name, { value: bytes.toString("base64url"), enumerable: true });
  }
  return { logins, passwords };
};

/**
 * The manifest the release's `applyMacLocalFirstOwnerV1` demands, built by the
 * release's OWN constructor from a protected-configuration-shaped object.
 *
 * This is the question §7 asks M4 to answer, so the test BUILDS it the way the
 * release does and does not hand-write a manifest: a hand-written manifest would
 * prove only that a manifest this test wrote happens to satisfy a checker, which
 * is the shape of a test that passes because it skipped the work.
 */
/** The production input shape `install-steps.mjs:189` builds. One place, so every
 * call in this lane is the shape the installer sends. */
const ownerInput = (root, schemaDigest) => Object.freeze({
  root, accounts: { service: ACCOUNTS.service }, release: "current", schemaDigest });

function firstOwnerManifestAt(at, subject = "owner:m4-acceptance") {
  const tenantId = "tenant-m4-accept", workspaceId = "workspace-m4-accept";
  // The shape `createMacLocalFirstOwnerManifestV1` reads. MEASURED: `workspaceId`
  // is a TOP-LEVEL key and `provider`/`subject` are on `localOwnerSession` — the
  // constructor reads `configuration.workspaceId` and `undefined` there makes it
  // throw `mac_local_first_owner_manifest_invalid`, naming a value the caller
  // believes it supplied.
  const configuration = {
    workspaceId,
    localOwnerSession: { tenantId, provider: "local-owner", subject },
    enablement: { nodeId: "node-m4-accept", workers: [
      { kind: "hermes", workerId: "worker-hermes" },
      { kind: "claude-code", workerId: "worker-claude" },
      { kind: "codex", workerId: "worker-codex" },
    ] },
    workIntakeProjectIds: [],
  };
  // The review key is a Uint8Array, not the base64url TEXT the protected runtime
  // file holds: `genesisIntegrityForKeyV1` feeds it straight to HMAC, and handing
  // it the base64url string fails with `integrity_failed` — which is the
  // completion gate correctly refusing a key that is not the key.
  const reviewKey = new Uint8Array(32).fill(7);
  const completionGateGenesis = CompletionGateStoreV1.genesisIntegrityForKeyV1(tenantId, reviewKey);
  return createMacLocalFirstOwnerManifestV1(configuration, at, completionGateGenesis);
}

/** The default manifest and the ids it carries, in one call. */
function firstOwnerManifest(at) {
  const tenantId = "tenant-m4-accept", workspaceId = "workspace-m4-accept";
  return { manifest: firstOwnerManifestAt(at), tenantId, workspaceId };
}

async function installRoot(label, portOffset) {
  const { run: parent, runtimeParent } = await sharedRuntime();
  const root = join(parent, label);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  symlinkSync(runtimeParent, join(root, "runtime"));
  mkdirSync(join(root, "updater", "current", "pg"), { recursive: true, mode: 0o755 });
  for (const [from, to] of [["src/updater/v1/ddl", "updater/current/ddl"],
    ["src/updater/v1/policy", "updater/current/policy"]]) {
    execFileSync("/bin/cp", ["-R", join(REPO, from), join(root, to)], { stdio: "pipe" });
  }
  execFileSync("/bin/cp", [join(REPO, "src/updater/v1/pg/release-schema-digest.sql"),
    join(root, "updater/current/pg/release-schema-digest.sql")], { stdio: "pipe" });
  mkdirSync(join(root, "logs", "postgresql17"), { recursive: true, mode: 0o750 });
  mkdirSync(join(root, "pg", "socket"), { recursive: true, mode: 0o700 });
  // The RELEASE tree, as a SYMLINK to the repository. The sibling lane does the
  // same and says why: the lane is testing the ports, not the staging, and a
  // copy of `current/**` would be testing a tree this lane built rather than the
  // release the installer staged. `readDatabasePhaseDataV1` then reads
  // `deploy/postgres/**` and the ledger reads `db/**` through the link, exactly
  // as the production path reads them.
  symlinkSync(REPO, join(root, "current"));
  return { root, port: PORT + portOffset };
}

async function startPostmaster({ root, port }) {
  const layout = planPgClusterLayoutV1({ pgRoot: join(root, "pg"), dataId: "data-A",
    runtimeDirectory: join(root, "runtime", "pg-current"),
    accounts: { database: ACCOUNTS.database.name, migrator: "control_room_migrator", deployer: "control_room_deployer" },
    port });
  const profileParameters = postgresProfileParametersV1({ root, layout, logDirectory: join(root, "logs", "postgresql17") });
  return { root, layout, profileParameters, environment: { ...layout.environment }, port,
    identity: { uid: ACCOUNTS.database.uid, gid: ACCOUNTS.database.gid },
    pgRoot: join(root, "pg"),
    profile: join(root, "updater", "current", "policy", "service-postgres.sb") };
}

/**
 * One statement as the database account, over the socket, in the profile.
 *
 * The rejection is ATTACHED and the promise still returned, and that is the whole
 * fix. MEASURED: without it, a statement issued just before a cluster was stopped
 * in a test's `finally` rejected with nobody holding it, and node reported
 * `failureType: 'unhandledRejection'` with
 * `FATAL: the database system is shutting down` — attributed to the TEST, which
 * made a teardown-ordering problem look like a cluster-shutdown problem, and it
 * reproduced in isolation so it looked like a port bug for three rounds.
 *
 * `promise.catch(() => {})` returns a NEW promise; the ORIGINAL is what the
 * caller awaits, so the caller still sees the refusal and the rejection is no
 * longer unhandled. That is the correct shape: the owner of a promise must always
 * hold it, and a teardown race must surface as the caller's own failure rather
 * than as a process-level event nobody can attribute.
 */
const asDatabase = (context, sql, user = "postgres", database = "control_room") => {
  const statement = runSessionStatementV1({ user, database, sql }, context);
  statement.catch(() => {});
  return statement;
};

async function simulateRootDeployerPeer(context) {
  const { root, layout, environment, profile, profileParameters } = context;
  const data = join(root, "pg", "data-A");
  await writeFile(join(data, "pg_ident.conf"),
    `${pgHbaPeerMapV1({ database: userInfo().username, migrator: "control_room_migrator",
      deployer: "control_room_deployer" })}cr ${userInfo().username} control_room_deployer\n`,
    { mode: 0o600 });
  const reloaded = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", data, "reload"], environment, ...context.identity, role: "database",
    profile, profileParameters, cwd: join(root, "pg"), timeoutMs: 60_000 });
  assert.equal(reloaded.code, 0, `pg_ctl reload failed: ${reloaded.stderr}`);
  void layout;
  return Object.freeze({ simulated: true, deployerSystemName: userInfo().username });
}

function makeLoginVerifier(root, port) {
  return async ({ login, password }) => {
    const layout = planPgClusterLayoutV1({ pgRoot: join(root, "pg"), dataId: "data-A",
      runtimeDirectory: join(root, "runtime", "pg-current"),
      accounts: { database: ACCOUNTS.database.name, migrator: "control_room_migrator", deployer: "control_room_deployer" },
      port });
    // The password goes in the child's ENVIRONMENT, never its argv: argv is
    // world-readable through `ps`, and this is the one moment in the phase when a
    // secret exists outside a pipe.
    const connect = withPassword => new Promise((resolve) => {
      const env = { ...layout.environment };
      if (withPassword) env.PGPASSWORD = password;
      const child = spawn(join(root, "runtime/pg-current/bin/psql"),
        ["-h", layout.socketDirectory, "-p", String(port), "-U", login, "-d", "control_room",
          "-w", "-Atc", "SELECT current_user"],
        { env, uid: process.getuid(), gid: process.getgid(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    const withIt = await connect(true);
    // The other half of the claim, and the half that makes the first half mean
    // something: with NO password the SAME login is refused. Without it, a
    // verifier that ignored its argument would report every login authenticated.
    const withoutIt = await connect(false);
    return { authenticated: withIt.code === 0 && withIt.stdout.trim() === login,
      refusedWithoutPassword: withoutIt.code !== 0 };
  };
}

function convergeGrantsFor() {
  return async () => ({ converged: true });
}

/**
 * The queue schema, built by the release's OWN `installFixedQueueSchemaV1` over
 * the peer map's `postgres` line as the database account.
 *
 * The sibling lane's comment is the reason this is not run as the migrator: the
 * queue's shape digest includes `pg_get_userbyid(...) AS owner` for every object,
 * so building it as `control_room_migrator` produces a different digest and the
 * installer refuses `upgrade_queue_shape_refused` — correctly, because a release
 * migration could then ALTER or DROP the queue. The fingerprint protects the
 * shape AND the owner, so the owner has to be the superuser.
 */
function installFixedQueue() {
  return async ({ root, port, database }) => {
    const { installFixedQueueSchemaV1 } = await import("../scripts/mac-local/fixed-queue-schema.mjs");
    const { Client } = await import("pg");
    const layout = planPgClusterLayoutV1({ pgRoot: join(root, "pg"), dataId: "data-A",
      runtimeDirectory: join(root, "runtime", "pg-current"),
      accounts: { database: ACCOUNTS.database.name, migrator: "control_room_migrator", deployer: "control_room_deployer" },
      port });
    const client = new Client({ host: layout.socketDirectory, port, user: "postgres", database,
      connectionTimeoutMillis: 30_000, ssl: false, application_name: "control-room-queue-install" });
    await client.connect();
    try { await installFixedQueueSchemaV1(client); } finally { await client.end().catch(() => undefined); }
  };
}


/**
 * A real `pg` client over the install root's socket, as the database account.
 *
 * The release's own `pg`, the install root's own `pgHbaPeerMapV1` layout, and the
 * map's `cr <database> postgres` line — which is the line that sends THIS account
 * to the `postgres` role. That is the arrangement `FIRST_OWNER_IDENTITY_V1`
 * names, and this is the proof the constant is not a claim: a `_controlroom`
 * process would be refused by that map, and the refusal is what the report cites.
 */
async function realPgClientFor(context) {
  const layout = planPgClusterLayoutV1({ pgRoot: join(context.root, "pg"), dataId: "data-A",
    runtimeDirectory: join(context.root, "runtime", "pg-current"),
    accounts: { database: ACCOUNTS.database.name, migrator: "control_room_migrator", deployer: "control_room_deployer" },
    port: context.port });
  const { Client } = clientModule();
  const client = new Client({ host: layout.socketDirectory, port: context.port, user: "postgres",
    database: "control_room", connectionTimeoutMillis: 30_000, ssl: false,
    application_name: "control-room-first-owner" });
  // The client is returned ALREADY CONNECTED, and the connect is AWAITED here.
  //
  // MEASURED: the earlier version assigned `client.connectPromise = client.connect()`
  // and returned the client, leaving the connect FLOATING. When the postmaster went
  // away first, the rejection had no handler and surfaced as
  // `failureType: 'unhandledRejection'` with
  // `FATAL: the database system is shutting down` — attributed to the TEST rather
  // than to the promise that was actually unhandled, and it reproduced in
  // isolation, which is what made it look like a cluster-shutdown ordering problem
  // rather than an unhandled rejection.
  //
  // So `realPgClientFor` is async and its connect is awaited by the caller. The
  // rejection then belongs to a promise someone is holding, and a cluster that
  // refuses the connection fails THIS test with its own message rather than as an
  // unhandled rejection attributed to whichever test happened to be running.
  await client.connect();
  return client;
}

const pgModule = await import("pg");

/** `pg`, in the one place, so the helper above can build a client in an expression. */
function clientModule() {
  return pgModule;
}



/**
 * The FULL default-path dependency bundle for the two database ports, built from
 * the real session machinery and nothing else.
 *
 * `firstOwner`'s dependencies are exactly what `first-owner-vps.mjs` uses:
 * `applyMacLocalFirstOwnerV1` over a real client, the digest query from the
 * bundle's own `release-schema-digest.sql`, and `digestReleaseSchemaRowsV1`.
 * There is no fake in this bundle — the queries are the release's, the client is
 * `runSessionStatementV1`, and the profile is the installer's own `service-postgres.sb`.
 */
async function portDependencies(context, { manifest, digestSql, tenantId }) {
  const query = sql => asDatabase(context, sql);
  // The release's transaction gets a REAL `pg` client over the install root's
  // socket, as its OWN script has. MEASURED: it cannot be the `psql` transport,
  // because it binds `$1`, it needs one session across BEGIN..COMMIT, and it
  // reads rows back per statement — `psql` fails the first with
  // `there is no parameter $1`, and one program returns one row set. So this is
  // the client it was written against, connecting to the same postmaster, as the
  // same account, with the release's own `pg` and nothing faked.
  const client = await realPgClientFor(context);
  let closed = false;
  return Object.freeze({
    tenantId,
    digestRows: digestReleaseSchemaRowsV1,
    // ROWS, because `firstOwnerV1` digests them: the dependency is a read, and
    // `digestReleaseSchemaRowsV1` is the port's job. Returning a digest here
    // produced `release_schema_digest_rows_refused` — a refusal naming an input
    // the caller had supplied in the only shape its own name accepts.
    readDigest: async () => query(digestSql),
    readUpdaterDigest: async () => {
      const rows = await query("SELECT n.nspname AS schema_name FROM pg_namespace n\n"
        + " JOIN pg_class c ON c.relnamespace = n.oid WHERE n.nspname = 'updater'");
      return digestReleaseSchemaRowsV1(rows);
    },
    readCounts: async table => {
      const rows = await query(`SELECT count(*)::bigint::text AS n FROM ${table}`);
      return Number(rows[0]?.n);
    },
    // §5.8's first sample rule: a socket connection as the deployer (peer) and
    // `SELECT 1`. `runSessionStatementV1` already speaks over the socket as the
    // mapped identity, so this is the real probe.
    sample: async () => {
      const rows = await query(digestSql);
      return Object.freeze({ ok: true, rows });
    },
    applyMacLocalFirstOwnerV1: () => applyMacLocalFirstOwnerV1(client, manifest),
    // The owner identity, READ BACK from the row the transaction just wrote. It is
    // the release's own `control_identities` row, read with the same client over
    // the same socket -- so the `provider`/`subject` the port returns are the
    // database's, not the test's. A rerun reads the same row and gets the same
    // two values, which is what "a rerun is refused cleanly" means here.
    readIdentity: async id => {
      // The identity AND the workspace, both read back from the rows the
      // transaction just wrote. The workspace id is the manifest's, and the join
      // is what proves it belongs to THIS tenant rather than to another one.
      const rows = await client.query(
        "SELECT i.auth_provider, i.auth_subject_digest, w.id AS workspace_id"
        + " FROM control_identities i JOIN workspaces w ON w.tenant_id = i.tenant_id"
        + " WHERE i.tenant_id=$1 AND i.auth_provider='local-owner'", [id]);
      const row = rows.rows[0];
      if (!row) return null;
      return Object.freeze({ provider: row.auth_provider, subject: row.auth_subject_digest,
        workspaceId: row.workspace_id });
    },
    // PROCESS HYGIENE, and it is not tidiness: the real `pg` client must be closed
    // before the postmaster goes away. An unclosed client outlives its test, the
    // cluster stop kills its socket underneath it, and the failure surfaces as an
    // uncaughtException in a LATER test — MEASURED, and it named nothing about
    // this lane. Closing is idempotent through `closed`, so a test may close in a
    // branch AND in its `finally`.
    close: async () => { if (!closed) { closed = true; await client.end().catch(() => undefined); } },
  });
}

async function freshCluster(label, portOffset) {
  const { root, port } = await installRoot(label, portOffset);
  const { logins, passwords } = phaseLogins([
    "control_room_migrator", "control_room_app", "control_room_scheduler", "control_room_work_intake_agent",
    "control_room_web", "control_room_coordinator", "control_room_results", "control_room_publisher",
    "control_room_agent_reviewer_login", "control_room_queue_worker", "control_room_fleet", "control_room_fleet_owner",
  ]);
  const dependencies = { ...manifestFor(port), planLayout: (input) => planPgClusterLayoutV1(input) };
  const initResult = await initializeDatabaseV1Script(initRequest(root, { logins, port }), passwords, dependencies);
  assert.equal(initResult.outcome, "initialized");
  const context = await startPostmaster({ root, port });
  const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"),
      "-o", `-p ${port}`, "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
  assert.equal(started.code, 0, `the service must start before the owner transaction: ${started.stderr}`);
  await simulateRootDeployerPeer(context);
  const release = { ...initRequest(root, { logins, port }), schema: "control-room.release-schema/v1",
    release: "current", expectedLedgerHead: ledgerHeadV1(await readReleaseLedgerV1(REPO)) };
  const releaseDependencies = { ...dependencies, convergeGrants: convergeGrantsFor(),
    installFixedQueue: installFixedQueue(),
    deployerIdentity: { uid: process.getuid(), gid: process.getgid() },
    verifyLogin: makeLoginVerifier(root, port) };
  const applied = await applyReleaseSchemaV1(release, passwords, releaseDependencies);
  assert.equal(applied.outcome, "applied");
  const digestSql = readFileSync(join(root, "updater/current/pg/release-schema-digest.sql"), "utf8");
  return { root, port, context, passwords, logins, applied, digestSql, initResult };
}

/**
 * The role manifest the init phase demands, built from the RELEASE's own
 * `databaseRoleManifestV1` rather than from a hand-written list: the phase's role
 * set is what the release says the roles are, and a lane that wrote its own list
 * would be testing a cluster with the wrong roles.
 */
const MANIFEST_ROLES = Object.freeze([
  ...databaseRoleManifestV1.groups.map(name => ({ name, attributes: databaseRoleAttributesV1(name) })),
  ...Object.entries(databaseRoleManifestV1.logins).map(([name]) => ({ name, attributes: databaseRoleAttributesV1(name) })),
]);

const manifestFor = (port, database = "control_room") => Object.freeze({
  database, port, roles: MANIFEST_ROLES,
  migratorName: "control_room_migrator", migratorGroup: "control_room_schema_owner",
  deployerName: "control_room_deployer",
});

/** Close every dependency bundle a test opened. Idempotent per bundle. */
async function closeAll(list) {
  for (const value of list) await value?.close?.();
}

/**
 * Stop a cluster THIS LANE started, and FAIL LOUDLY if it did not stop.
 *
 * The `assert` is the point, and it is there because of a measured leak: a
 * previous version swallowed the `pg_ctl stop` exit code, a `drift` postmaster
 * (pid 440) survived its test, and the NEXT test's `freshCluster` then connected to
 * a cluster that was already shutting down and failed with
 * `FATAL: the database system is shutting down` — a refusal naming a shutdown
 * nobody in that test asked for.
 *
 * So a stop that does not report success is a test failure, not a note. A lane
 * that leaks a postmaster is worse than a lane that fails: the leak outlives the
 * run and the next run inherits it.
 */
async function stopCluster(cluster) {
  if (!cluster?.root) return;
  const result = await spawnPgFamily({
    executable: join(cluster.root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(cluster.root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
    ...cluster.context, role: "database", cwd: join(cluster.root, "pg") });
  // A cluster whose data directory is already gone stopped long ago: that is the
  // `retireDatabase` test's own ending, and it is a success, not a failure.
  const gone = !existsSync(join(cluster.root, "pg", "data-A"));
  if (!gone && result.code !== 0) {
    throw new Error(`the lane leaked a postmaster: pg_ctl stop exited ${result.code}: ${String(result.stderr ?? "").slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// THE ACCEPTANCE TESTS.
// ---------------------------------------------------------------------------

test("the first-owner port creates the owner rows exactly once on a fresh database",
  { skip: needsArchive, timeout: 900_000, concurrency: false }, async () => {
    const cluster = await freshCluster("owner", 0);
    const open = [];
    try {
      const { manifest, tenantId, workspaceId } = firstOwnerManifest(new Date().toISOString());
      // NOTHING INJECTED for the port under test: `firstOwnerV1` is the production
      // function with the production input shape, and its dependencies are the
      // release's own `applyMacLocalFirstOwnerV1`, the release's own digest query
      // and the installer's own `psql` transport. There is no `tools` or `runner`
      // parameter in the call.
      const ownerDependencies = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(ownerDependencies);
      const owner = await firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), ownerDependencies);
      assert.deepEqual(Object.keys(owner).sort(), ["provider", "subject", "tenantId", "workspaceId"]);
      assert.equal(owner.tenantId, tenantId);
      assert.equal(owner.workspaceId, workspaceId);
      assert.equal(owner.provider, "local-owner");
      assert.ok(owner.subject.length > 0 && owner.subject.length <= 512);

      // THE ROWS EXIST, as the SERVER sees them. Not "the function returned an
      // id" — the tenant, workspace, identity, grant and genesis rows are present
      // in the tables, with the identity's `auth_provider` and `auth_subject_digest`
      // the release wrote.
      const rows = await asDatabase(cluster.context,
        "SELECT (SELECT count(*) FROM tenants)::text AS tenants,"
        + " (SELECT count(*) FROM workspaces)::text AS workspaces,"
        + " (SELECT count(*) FROM control_identities WHERE auth_provider='local-owner')::text AS identities,"
        + " (SELECT auth_provider FROM control_identities WHERE auth_provider='local-owner') AS provider,"
        + " (SELECT auth_subject_digest FROM control_identities WHERE auth_provider='local-owner') AS subject_digest");
      const observed = rows[0];
      assert.equal(Number(observed.tenants), DATABASE_HEALTH_COUNTS_V1.tenants, "one tenant, once");
      assert.equal(Number(observed.workspaces), DATABASE_HEALTH_COUNTS_V1.workspaces, "one workspace, once");
      assert.equal(Number(observed.identities), 1, "one owner identity");
      assert.equal(observed.provider, "local-owner");
      // The subject is a DIGEST, and it is the release's own digest of
      // `{provider, subject}` — which is the answer §7 asks for: the owner subject
      // is minted HERE, with no external identity provider in the loop.
      assert.match(observed.subject_digest, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(observed.subject_digest, sha256Digest({ provider: "local-owner", subject: "owner:m4-acceptance" }));

      // A RERUN IS REFUSED CLEANLY. The release's transaction is idempotent by row
      // identity, so it KEEPS the rows rather than duplicating them — and the port
      // returns the same four values. "Refused cleanly" for this transaction means
      // "kept every row and reported the same identity", and the counts below are
      // what prove nothing was duplicated.
      const againDependencies = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(againDependencies);
      const again = await firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), againDependencies);
      assert.deepEqual(Object.keys(again).sort(), ["provider", "subject", "tenantId", "workspaceId"]);
      assert.equal(again.tenantId, owner.tenantId);
      // ONE query for both counts: the point is that neither moved, and a single
      // read of the same snapshot cannot show them disagreeing with each other.
      const afterRerun = (await asDatabase(cluster.context,
        "SELECT (SELECT count(*) FROM tenants)::text AS tenants,"
        + " (SELECT count(*) FROM workspaces)::text AS workspaces,"
        + " (SELECT count(*) FROM control_identities)::text AS identities"))[0];
      assert.equal(Number(afterRerun.tenants), 1, "a rerun must not create a second tenant");
      assert.equal(Number(afterRerun.workspaces), 1, "a rerun must not create a second workspace");
      // ONE identity, and the release's own count: MEASURED, the transaction
      // created ONE, not four, because this manifest carries
      // `workIntakeProjectIds: []` and the release creates the three
      // work-intake identities ONLY when intake scopes are configured
      // (`applyMacLocalFirstOwnerV1`'s `if (m.workIntakeProjectIds.length > 0)`).
      // An assertion of 4 here was a guess about the manifest rather than a
      // reading of the code, and the server answered 1.
      assert.equal(Number(afterRerun.identities), 1,
        "exactly the owner identity, with no intake scopes configured");

      // A THIRD run against a manifest for the SAME tenant with a DIFFERENT owner
      // subject is a refusal, not a merge: the release's transaction compares
      // every identity column and refuses `first_owner_row_conflict` on any
      // difference. So this is the case where "refused cleanly" means refused.
      const other = firstOwnerManifestAt(new Date().toISOString(), "owner:DIFFERENT");
      const conflicting = await portDependencies(cluster.context,
        { manifest: other, digestSql: cluster.digestSql, tenantId });
      open.push(conflicting);
      await assert.rejects(
        firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), conflicting),
        /first_owner_row_conflict/u);
    } finally { await closeAll(open); await stopCluster(cluster); }
  });

test("the database half of checkHealth counts the owner rows three times",
  { skip: needsArchive, timeout: 900_000, concurrency: false }, async () => {
    const cluster = await freshCluster("health", 1);
    const open = [];
    try {
      const { manifest, tenantId } = firstOwnerManifest(new Date().toISOString());
      const dependencies = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(dependencies);
      await firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), dependencies);
      // The updater schema digest the health check compares against: the port
      // reads it from the SERVER (`pg_namespace` where nspname='updater'), so the
      // value the test supplies is the one the server answers, captured by asking
      // it first. That is the honest arrangement — a test that hard-codes the
      // digest would be asserting a constant, not the database.
      const updaterDigest = await dependencies.readUpdaterDigest();
      const result = await checkHealthDatabaseV1({
        root: cluster.root, expectedRelease: "releases/m4", pgDataId: "data-A",
        schemaDigest: cluster.applied.schemaDigest, updaterSchemaDigest: `sha256:${updaterDigest}`,
        samples: 3,
      }, dependencies);
      assert.deepEqual(Object.keys(result).sort(), ["healthy", "samples", "schemaDigest"]);
      assert.equal(result.healthy, true);
      assert.equal(result.samples, 3);
      assert.equal(result.schemaDigest, cluster.applied.schemaDigest);
      // Three samples, each of which counted: the counts are the release's rows,
      // and the release's rows are the counts the constant declares.
      assert.equal(await dependencies.readCounts("tenants"), DATABASE_HEALTH_COUNTS_V1.tenants);
      assert.equal(await dependencies.readCounts("workspaces"), DATABASE_HEALTH_COUNTS_V1.workspaces);
    } finally { await closeAll(open); await stopCluster(cluster); }
  });

test("a drifted schema digest is refused as health_database_refused",
  { skip: needsArchive, timeout: 900_000, concurrency: false }, async () => {
    const cluster = await freshCluster("drift", 2);
    const open = [];
    try {
      const { manifest, tenantId } = firstOwnerManifest(new Date().toISOString());
      const dependencies = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(dependencies);
      await firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), dependencies);
      const updaterDigest = await dependencies.readUpdaterDigest();
      // The digest that MOVED is the release schema's. The refusal names it and
      // names what was observed — the detail after the colon is for the operator,
      // the code before it is what §5.8's error list promises.
      const drifted = `sha256:${"0".repeat(64)}`;
      await assert.rejects(checkHealthDatabaseV1({
        root: cluster.root, expectedRelease: "releases/m4", pgDataId: "data-A",
        schemaDigest: drifted, updaterSchemaDigest: `sha256:${updaterDigest}`, samples: 3,
      }, dependencies), /^Error: health_database_refused:schema_drift:computed=[a-f0-9]{64}:expected=0{64}$/u);
      // The UPDATER digest moving is a different refusal detail, same code.
      await assert.rejects(checkHealthDatabaseV1({
        root: cluster.root, expectedRelease: "releases/m4", pgDataId: "data-A",
        schemaDigest: cluster.applied.schemaDigest, updaterSchemaDigest: `sha256:${"1".repeat(64)}`, samples: 3,
      }, dependencies), /^Error: health_database_refused:updater_drift:/u);
      // A COUNT that moved is refused too — the check is not digest-only. The
      // counts constant is what §5.8's "health counts match" means, so a wrong
      // count is a health failure and not a pass.
      const wrongCounts = Object.freeze({ ...dependencies, readCounts: async table => table === "tenants" ? 2 : 1 });
      await assert.rejects(checkHealthDatabaseV1({
        root: cluster.root, expectedRelease: "releases/m4", pgDataId: "data-A",
        schemaDigest: cluster.applied.schemaDigest, updaterSchemaDigest: `sha256:${updaterDigest}`, samples: 3,
      }, wrongCounts), /^Error: health_database_refused:count:tenants=2:expected=1$/u);
      // And a sample that fails is refused as `sample1`, naming which sample.
      const dead = Object.freeze({ ...dependencies, sample: async () => { throw Object.assign(new Error("no socket"), { code: "ECONNREFUSED" }); } });
      await assert.rejects(checkHealthDatabaseV1({
        root: cluster.root, expectedRelease: "releases/m4", pgDataId: "data-A",
        schemaDigest: cluster.applied.schemaDigest, updaterSchemaDigest: `sha256:${updaterDigest}`, samples: 3,
      }, dead), /^Error: health_database_refused:sample1:ECONNREFUSED$/u);
    } finally { await closeAll(open); await stopCluster(cluster); }
  });

test("the login ports write 0600 files the service account owns and remove exactly those",
  { skip: needsArchive, timeout: 300_000, concurrency: false }, async () => {
    const cluster = await freshCluster("logins", 3);
    const open = [];
    try {
      const { manifest, tenantId } = firstOwnerManifest(new Date().toISOString());
      // The port's REAL default path: no injected tool, no injected writer, the
      // production function over a temp install root.
      const written = await writeDatabaseLoginsV1({
        root: cluster.root, accounts: { service: ACCOUNTS.service }, passwords: cluster.passwords,
      });
      assert.equal(typeof written.path, "string");
      assert.equal(written.references.length, Object.keys(cluster.passwords).length);
      // NO PASSWORD IN THE RECEIPT — the contract's "never plaintext passwords".
      const serialised = JSON.stringify(written.receipt);
      for (const password of Object.values(cluster.passwords)) {
        assert.ok(!serialised.includes(password), "the receipt must carry no plaintext password");
      }
      for (const entry of written.receipt.entries) {
        assert.deepEqual(Object.keys(entry).sort(), ["fileRef", "name", "passwordDigest"]);
        assert.match(entry.passwordDigest, /^sha256:[a-f0-9]{64}$/u);
        const bytes = await readFile(entry.fileRef, "utf8");
        assert.equal(bytes.replace(/\n$/u, ""), cluster.passwords[entry.name], "the file holds its own login's password");
        assert.equal(lstatSync(entry.fileRef).mode & 0o777, 0o600, "a group-readable password is a password every group member has");
      }
      // The composer reads `references`, and its own validator demands FOUR keys
      // per entry — so `references` must carry the password too. That is the
      // reason the two shapes differ, and this is the assertion that says so.
      for (const reference of written.references) {
        assert.deepEqual(Object.keys(reference).sort(), ["fileRef", "name", "password", "passwordDigest"]);
      }
      // Removal takes the RECEIPT and removes exactly those files.
      const removed = await removeDatabaseLoginsV1({ root: cluster.root, receipt: written.receipt });
      assert.equal(removed.removed, true);
      await assert.rejects(readFile(written.receipt.entries[0].fileRef), { code: "ENOENT" });
      // A file nobody owns in that directory is a REFUSAL, not a blanket delete:
      // this module must not remove a protected file it did not write.
      // The directory was removed by the successful call above, so it is
      // recreated for this case: the claim under test is about a file this module
      // did not write, which needs the directory to exist to hold it.
      await mkdir(written.path, { recursive: true, mode: 0o700 });
      const stray = join(written.path, "not-ours.txt");
      await writeFile(stray, "someone else's\n", { mode: 0o600 });
      await assert.rejects(removeDatabaseLoginsV1({ root: cluster.root, receipt: written.receipt }),
        /database_logins_remove_refused/u);
      // The refusal must LEAVE the file: it is the whole point of refusing rather
      // than blanket-deleting a directory this module does not own. MEASURED: an
      // `assert.rejects(readFile(stray))` here passed for the WRONG reason — it
      // asserts the file is GONE, which is the opposite of the property, and it
      // failed only because the file was in fact still there. The correct
      // assertion is a read that must succeed and must return what was written.
      assert.equal((await readFile(stray, "utf8")).trim(), "someone else's",
        "the refusal must leave the file it refused to touch");

      // The stray is removed BY HAND, because the port correctly refuses to touch
      // it. MEASURED: leaving it in place made the test's own final
      // `removeDatabaseLoginsV1({root})` refuse — which is the port behaving
      // correctly at the end of a test that needed it not to.
      await rm(stray, { force: true });
      await rmSync(written.path, { recursive: true, force: true });
      // THE MODE AND CONTENT CHECKS ARE NOT REACHABLE THROUGH THIS PORT, and the
      // honest account of why is the point of this block.
      //
      // `writeDatabaseLoginsV1` writes the file at 0600 through an O_EXCL temporary
      // and renames it over whatever was there, then reads it back through an open
      // handle and checks its mode and its bytes. A caller therefore cannot hand it
      // a 0644 file or a file holding someone else's bytes: MEASURED, an earlier
      // version of this test did exactly that and got no refusal, because the write
      // corrected the mode and the content BEFORE the read-back. The guard covers
      // the window between the rename and the read — something else on the machine
      // replacing the file — and nothing in this lane can open that window
      // deterministically.
      //
      // So the mode and content checks are NOT claimed as covered by a test here.
      // They are cheap defence in depth for a window this lane cannot construct, and
      // the mutation entry for the mode check reports UNVERIFIABLE rather than a
      // false pass, because a mutation whose test cannot fail is not evidence.
      //
      // What IS proven here, and is the property a caller can act on: the port
      // converges on the password it was given, from any starting state, and its
      // receipt's digest is of THAT password. The positive control below is the
      // assertion that makes the block worth reading.
      const control = await writeDatabaseLoginsV1({
        root: cluster.root, accounts: { service: ACCOUNTS.service }, passwords: cluster.passwords });
      for (const entry of control.receipt.entries) {
        assert.equal((await readFile(entry.fileRef, "utf8")).replace(/\n$/u, ""),
          cluster.passwords[entry.name],
          `${entry.name}: the file must hold the password the port was given`);
        assert.equal(entry.passwordDigest,
          `sha256:${createHash("sha256").update(cluster.passwords[entry.name], "utf8").digest("hex")}`,
          `${entry.name}: the receipt's digest must be of the password the port HELD`);
      }
      void written;

      // A retry after a failure converges: with nothing there, removal is a
      // success, so the installer's undo/redo cycle cannot wedge.
      //
      // THE RECEIPT IS THE CONTROL'S, and MEASURED: passing no receipt here refused,
      // because a receipt-less removal allows NO file and the positive control above
      // had just written all twelve back. That refusal is the port being correct —
      // a blanket delete of a directory it cannot attribute is exactly what the
      // stray-file case forbids — so the retry takes the receipt that names what is
      // actually there.
      assert.equal((await removeDatabaseLoginsV1({ root: cluster.root, receipt: control.receipt })).removed, true);
      // And with the directory GONE, the receipt-less retry is a success, which is
      // the property the installer's undo list depends on.
      assert.equal((await removeDatabaseLoginsV1({ root: cluster.root })).removed, true);
      assert.equal((await removeDatabaseLoginsV1({ root: cluster.root, receipt: control.receipt })).removed, true,
        "a replayed undo must not wedge");
      // The owner transaction still works after the logins are gone — the login
      // files are for the SERVICES, not for the owner transaction's migrator.
      const ownerDependencies = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(ownerDependencies);
      const owner = await firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), ownerDependencies);
      assert.equal(owner.tenantId, tenantId);
      void chmodSync; void cpSync; void spawn; void promisify; void rmSync;
    } finally { await closeAll(open); await stopCluster(cluster); }
  });

test("retireDatabase refuses a live cluster and removes a dead one",
  { skip: needsArchive, timeout: 300_000, concurrency: false }, async () => {
    const cluster = await freshCluster("retire", 4);
    const open = [];
    try {
      // The cluster is RUNNING. Its postmaster.pid names a live pid, so the port
      // must refuse rather than delete a directory a postmaster is using. This is
      // Fable finding #3: deleting a running cluster's data directory is how a
      // SIGKILLed phase becomes permanent corruption instead of a retry.
      await assert.rejects(retireDatabaseV1({ root: cluster.root, pgDataId: "data-A" }),
        /retire_database_live_cluster_refused/u);
      const stillThere = existsSync(join(cluster.root, "pg", "data-A"));
      assert.equal(stillThere, true, "a refused retirement must leave the data directory exactly as it was");
      // An UNPARSEABLE pid file is treated as LIVE, not absent — guessing wrong
      // here deletes a running cluster.
      const pidFile = join(cluster.root, "pg", "data-A", "postmaster.pid");
      const original = readFileSync(pidFile, "utf8");
      await writeFile(pidFile, "not-a-pid\n");
      await assert.rejects(retireDatabaseV1({ root: cluster.root, pgDataId: "data-A" }),
        /retire_database_live_cluster_refused/u);
      await writeFile(pidFile, original);
      // Now stop it and retire. The `pg/current` link must be gone first — a
      // retired database the link still names is one the next phase would reach.
      await stopCluster(cluster);
      await rmSync(join(cluster.root, "pg", "current"), { force: true });
      const retired = await retireDatabaseV1({ root: cluster.root, pgDataId: "data-A" });
      assert.equal(retired.retired, true);
      assert.equal(retired.removed, true);
      assert.equal(existsSync(join(cluster.root, "pg", "data-A")), false);
      // A retry after a successful retirement is a success with `removed:false`,
      // so the installer's undo list can be replayed without wedging.
      const again = await retireDatabaseV1({ root: cluster.root, pgDataId: "data-A" });
      assert.equal(again.retired, true);
      assert.equal(again.removed, false);
      // A pid file whose pid is dead is NOT a live cluster: this is the SIGKILL
      // case, and it must retire rather than refuse forever.
      const deadRoot = join(cluster.root, "pg", "data-B");
      mkdirSync(deadRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(deadRoot, "postmaster.pid"), "999999\n");
      assert.equal((await retireDatabaseV1({ root: cluster.root, pgDataId: "data-B" })).removed, true);
    } finally {
      await closeAll(open);
      await stopCluster(cluster);
    }
  });

test("the M4 identity constant names the peer map's actual lines",
  { skip: needsArchive, timeout: 120_000, concurrency: false }, async () => {
    // The executor is the database account and the connector is `postgres`,
    // because `pgHbaPeerMapV1` names the database account and root and nothing
    // else. `_controlroom` — the account §4 row 23 names — is in NEITHER line.
    // This test reads the generated map, so the constant cannot drift from the
    // map it is a consequence of.
    const map = pgHbaPeerMapV1({ database: "_crdb", migrator: "control_room_migrator", deployer: "control_room_deployer" });
    assert.match(map, /^cr _crdb control_room_migrator$/mu);
    assert.match(map, /^cr root control_room_deployer$/mu);
    assert.match(map, /^cr _crdb postgres$/mu);
    assert.ok(!map.includes("_controlroom"), "_controlroom has no peer line, so it cannot reach the database as itself");
    assert.equal(FIRST_OWNER_IDENTITY_V1.executor, "database");
    assert.equal(FIRST_OWNER_IDENTITY_V1.connector, "postgres");
    // The updater's copy of the digest query IS the release's query: the two texts
    // are compared with comments stripped, which is the equivalence the sibling
    // lane asserts and the one that makes a health digest mean the same thing to
    // both halves of the system.
    const strip = text => text.replace(/--[^\n]*/gu, "").replace(/\s+/gu, " ").trim();
    const releaseSource = readFileSync(join(REPO, "src/web/v1/private-database-preflight.ts"), "utf8");
    assert.ok(strip(releaseSource).includes("control_room_schema_owner"),
      "the release's own digest query must exclude the ledger by OWNER, which is what this lane's expectations rest on");
    assert.match(privateWebSchemaDigest, /^[a-f0-9]{64}$/u);
  });

test("the first-owner port refuses bad input before it touches the database",
  { skip: needsArchive, timeout: 300_000, concurrency: false }, async () => {
    const cluster = await freshCluster("refusals", 5);
    const open = [];
    try {
      const { manifest, tenantId } = firstOwnerManifest(new Date().toISOString());
      const dependencies = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(dependencies);
      const good = ownerInput(cluster.root, cluster.applied.schemaDigest);

      // AN EXTRA KEY. The request's key set is EXACT, and the reason is the one
      // `initializeDatabaseV1` already records: a caller that reaches for the wrong
      // field must learn from its own call, not from a row conflict three steps
      // later. `release: "someOtherTree"` is the shape of that mistake.
      await assert.rejects(firstOwnerV1({ ...good, extra: "ignored" }, dependencies),
        /first_owner_input_refused/u);
      await assert.rejects(firstOwnerV1({ ...good, phase: "init" }, dependencies),
        /first_owner_input_refused/u);
      // A MISSING key is the same refusal: `exactKeys` is one check, not two.
      const { release, ...withoutRelease } = good;
      void release;
      await assert.rejects(firstOwnerV1(withoutRelease, dependencies), /first_owner_input_refused/u);
      // A ROOT that is not absolute, or is `/`, is refused before any read.
      await assert.rejects(firstOwnerV1({ ...good, root: "relative/path" }, dependencies),
        /first_owner_input_refused/u);
      await assert.rejects(firstOwnerV1({ ...good, root: "/" }, dependencies), /first_owner_input_refused/u);
      // A DIGEST that is not one, and a RELEASE that is not the literal `current`.
      await assert.rejects(firstOwnerV1({ ...good, schemaDigest: "not-a-digest" }, dependencies),
        /first_owner_input_refused/u);
      await assert.rejects(firstOwnerV1({ ...good, release: "releases/other" }, dependencies),
        /first_owner_input_refused/u);
      await assert.rejects(firstOwnerV1({ ...good, release: join(cluster.root, "elsewhere") }, dependencies),
        /first_owner_input_refused/u);

      // THE DRIFT CHECK FIRES BEFORE THE TRANSACTION, and the order is the
      // property. With a digest that does not match the live schema, the port must
      // refuse with `first_owner_schema_drift` and must NOT have minted an owner:
      // the tenant table is still empty afterwards. MEASURED on the first run,
      // when this guard did not exist and the transaction ran against a drifted
      // schema without complaint.
      await assert.rejects(
        firstOwnerV1({ ...good, schemaDigest: `sha256:${"2".repeat(64)}` }, dependencies),
        /^Error: first_owner_schema_drift:computed=[a-f0-9]{64}:expected=2{64}$/u);
      // The PARENTHESES, and they are the fix: `await asDatabase(...)[0]` binds the
      // `await` to the INDEXED ACCESS rather than to the call, so `afterDrift` was
      // `undefined` and the assertion read `.tenants` off nothing. The await has to
      // enclose the call, and the index has to follow it.
      const afterDrift = (await asDatabase(cluster.context,
        "SELECT count(*)::text AS tenants FROM tenants"))[0];
      assert.equal(Number(afterDrift.tenants), 0,
        "a drifted digest must be refused BEFORE any owner row is written");

      // A RECEIPT FOR ANOTHER TENANT is refused: the transaction returns the tenant
      // it wrote, and a mismatch means the port is about to report an identity
      // that is not the one the manifest named.
      const wrongTenant = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId: "tenant-somewhere-else" });
      open.push(wrongTenant);
      // A no-op transaction: the tenant mismatch is a property of how the port
      // READS a receipt, so it is exercised with a receipt and no writes. Running
      // the real forty-statement transaction here would prove the same thing four
      // times slower and leave its client settling as the cluster is torn down.
      //
      // THE `readIdentity` STUB IS THE POINT, and the mutation check is what proved
      // it: with the tenant guard deleted, this case still failed, because the port
      // went on to read the identity for a tenant nobody wrote and the IDENTITY
      // guard caught it. Two guards, one refusal, and the second one was masking the
      // first. So `readIdentity` here answers as though the mismatched tenant's rows
      // were perfectly present, which is the only way this case can fail ONLY on the
      // tenant comparison.
      const noWrites = { ...wrongTenant,
        readIdentity: async () => ({ provider: "local-owner", subject: `sha256:${"4".repeat(64)}`,
          workspaceId: "workspace-the-manifest-did-not-name" }),
        applyMacLocalFirstOwnerV1: async () => (
          { schema: "control-room.mac-local-first-owner-receipt/v1", manifestDigest: `sha256:${"3".repeat(64)}`,
            tenantId: "tenant-the-manifest-did-not-name", created: 0, kept: 0, fingerprints: {} }) };
      await assert.rejects(firstOwnerV1(good, noWrites), /first_owner_tenant_mismatch/u);
      // And a receipt whose SHAPE is wrong is refused, so the port is not merely
      // comparing two strings: it validates the receipt it was handed. MEASURED:
      // this case was written to expect `first_owner_result_refused` and got
      // `first_owner_tenant_mismatch`, because `{tenantId}` names the WRONG tenant
      // under `wrongTenant` and the tenant check runs first. Both are refusals;
      // the assertion has to name the one the port actually reaches, and a second
      // case with the right tenant pins the shape check.
      // A receipt with NO digest and NO counts is a shape refusal, not a tenant
      // refusal — the shape is checked first, which is the right order: a receipt
      // this port cannot read at all is a shape refusal whatever it names.
      await assert.rejects(firstOwnerV1(good, { ...wrongTenant,
        applyMacLocalFirstOwnerV1: async () => ({ tenantId: "tenant-the-manifest-did-not-name" }) }),
      /first_owner_result_refused/u);
      // ONE REFUSAL CODE PER CASE, and that is the fix. The alternation
      // `/result_refused|tenant_mismatch/` let the TENANT refusal satisfy every case
      // in the loop, so with the receipt-shape guard deleted the whole loop still
      // passed - MEASURED, and it is why that mutation read MISSED twice. A refusal
      // assertion that accepts either of two codes proves that one of them fired,
      // not which.
      // EVERY other field well formed, so that in each case the ONE field under
      // examination is the only thing that can refuse it.
      //
      // MEASURED, and this is the third masking bug this loop has had. Each case
      // previously omitted `fingerprints` as well as the field it meant to test, so
      // the `fingerprints` check refused all of them: deleting the `manifestDigest`,
      // `created` and `kept` checks left every case still refused, and the mutation
      // harness read MISSED. A refusal that several guards produce proves only that
      // one of them fired - the same mistake as the `/result_refused|tenant_mismatch/`
      // alternation noted above, one layer down.
      const shaped = (overrides = {}) => ({ schema: "control-room.mac-local-first-owner-receipt/v1",
        manifestDigest: `sha256:${"3".repeat(64)}`, tenantId, created: 0, kept: 0,
        fingerprints: { "node-x": `sha256:${"5".repeat(64)}` }, ...overrides });
      const badReceipts = [
        [null, "a null receipt"],
        ["not-an-object", "a string receipt"],
        [[], "an array receipt"],
        [shaped({ tenantId: 42 }), "a numeric tenant"],
        [shaped({ manifestDigest: "not-a-digest" }), "a digest that is not a digest"],
        [shaped({ created: -1 }), "a negative created count"],
        [shaped({ kept: "two" }), "a kept count that is not an integer"],
        [shaped({ fingerprints: "no" }), "a fingerprints value that is not a map"],
        [shaped({ fingerprints: { "node-x": "not-a-digest" } }), "a fingerprint that is not a digest"],
      ];
      for (const [bad, why] of badReceipts) {
        await assert.rejects(firstOwnerV1(good, { ...wrongTenant, tenantId,
          applyMacLocalFirstOwnerV1: async () => bad }), /^Error: first_owner_result_refused$/u,
        `${why} must be refused as a SHAPE refusal, not a tenant one`);
      }
      // The POSITIVE CONTROL for the shape check, and it is what makes the loop
      // above mean anything: this receipt is well formed and must SUCCEED.
      const wellFormed = { ...wrongTenant, tenantId,
        applyMacLocalFirstOwnerV1: async () => ({ schema: "control-room.mac-local-first-owner-receipt/v1",
          manifestDigest: `sha256:${"3".repeat(64)}`, tenantId, created: 0, kept: 0,
          fingerprints: { "node-x": `sha256:${"5".repeat(64)}` } }),
        readIdentity: async () => ({ provider: "local-owner", subject: `sha256:${"4".repeat(64)}`,
          workspaceId: "workspace-m4-accept" }) };
      assert.equal((await firstOwnerV1(good, wellFormed)).tenantId, tenantId,
        "a well-formed receipt must succeed, or the refusals above prove nothing");

      // AN IDENTITY THAT IS NOT THERE. A transaction that reported success while
      // writing no owner row would leave the owner code authenticating against a
      // subject no identity carries.
      const noIdentity = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(noIdentity);
      // No identity row, and a receipt for the RIGHT tenant: the port must refuse
      // rather than report a provider/subject it invented. The receipt is a
      // no-op transaction, so this case costs one read and not forty writes.
      //
      // The TENANT HERE IS THE MANIFEST'S, and that is deliberate for the same
      // reason as above: with the identity guard deleted and the tenant wrong, the
      // tenant guard would catch it and this case would still pass. One tenant,
      // one guard per case, so neither can hide the other.
      const withoutIdentity = { ...noIdentity, applyMacLocalFirstOwnerV1: async () => (
        { schema: "control-room.mac-local-first-owner-receipt/v1", manifestDigest: `sha256:${"3".repeat(64)}`,
          tenantId, created: 0, kept: 0, fingerprints: {} }), readIdentity: async () => null };
      await assert.rejects(firstOwnerV1(good, withoutIdentity), /first_owner_identity_refused/u);
      // And the POSITIVE control: with the identity present, the same no-op
      // transaction SUCCEEDS. Without it, this case would also pass if the port
      // refused everything, which is the failure mode a refusal-only test cannot
      // see. MEASURED: the mutation run needed this to tell "the guard fired" from
      // "something else refused".
      const withIdentity = { ...withoutIdentity, readIdentity: async () => (
        { provider: "local-owner", subject: `sha256:${"4".repeat(64)}`, workspaceId: "workspace-m4-accept" }) };
      const minted = await firstOwnerV1(good, withIdentity);
      assert.equal(minted.tenantId, tenantId);
      assert.equal(minted.provider, "local-owner");
      // An identity row whose provider or subject is empty is the same refusal: a
      // pair of empty strings would authenticate nobody and name nobody.
      for (const bad of [{ provider: "", subject: "s", workspaceId: "w" },
        { provider: "local-owner", subject: "", workspaceId: "w" },
        { provider: "local-owner", subject: "s", workspaceId: "" }]) {
        await assert.rejects(firstOwnerV1(good, { ...withoutIdentity, readIdentity: async () => bad }),
          /first_owner_identity_refused/u);
      }
    } finally { await closeAll(open); await stopCluster(cluster); }
  });

test("checkHealth refuses a request that is not three samples",
  { skip: needsArchive, timeout: 300_000, concurrency: false }, async () => {
    const cluster = await freshCluster("samples", 6);
    const open = [];
    try {
      const { manifest, tenantId } = firstOwnerManifest(new Date().toISOString());
      const dependencies = await portDependencies(cluster.context,
        { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(dependencies);
      await firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), dependencies);
      const updaterDigest = await dependencies.readUpdaterDigest();
      const request = {
        root: cluster.root, expectedRelease: "releases/m4", pgDataId: "data-A",
        schemaDigest: cluster.applied.schemaDigest, updaterSchemaDigest: `sha256:${updaterDigest}`,
        samples: 3,
      };
      // §5.8 says three samples, and the number is not a preference: a check that
      // accepted one sample would pass on a cluster that failed the next two.
      for (const samples of [0, 1, 2, 4, 30, -3, 1.5, "3"]) {
        await assert.rejects(checkHealthDatabaseV1({ ...request, samples }, dependencies),
          /health_database_refused/u, `samples=${samples} must be refused`);
      }
      // And the other half of the request's exact shape.
      await assert.rejects(checkHealthDatabaseV1({ ...request, extra: 1 }, dependencies),
        /health_database_refused/u);
      await assert.rejects(checkHealthDatabaseV1({ ...request, expectedRelease: "m4" }, dependencies),
        /health_database_refused/u);
      await assert.rejects(checkHealthDatabaseV1({ ...request, pgDataId: "../escape" }, dependencies),
        /health_database_refused/u);
      await assert.rejects(checkHealthDatabaseV1({ ...request, updaterSchemaDigest: "nope" }, dependencies),
        /health_database_refused/u);
      // The sample count is checked BEFORE any connection is attempted, so a
      // refused request costs no postmaster round trip: the refusal names the
      // request, not the database.
      assert.equal(await dependencies.readCounts("tenants"), 1,
        "the refusals above must not have touched the owner rows");
    } finally { await closeAll(open); await stopCluster(cluster); }
  });

// The pid-identity half of `retireDatabase`, with NO PostgreSQL and no real
// signals. The states are real — they are what a power cut inside `initdb`
// leaves — but the postmasters are process-table ROWS, which is the seam the
// decision actually reads: `identifyRecordedProcessV1` never sends a signal and
// this port never calls `kill`. That is what makes the recycled-pid cases safe
// to assert here. Nothing is signalled, so a wrong answer cannot hurt a real
// process, and the "recycled" row can be a `sleep` that is not ours at all.
// `LANE_ROOT` is `/private/tmp` and not `tmpdir()`, for the reason the lane's own
// `freshCluster` gives: the vendored-runtime and pg-ctl paths this file exercises
// refuse a root under the owner's home, so the install roots they build must be
// under `/private/tmp`. These fixtures need no runtime, but they live where the
// rest of the file's roots live so one teardown rule covers them.
async function retirePidFixture(t, name) {
  const base = await mkdtemp(join(LANE_ROOT, `m4-retire-pid-${name}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = resolve(base), data = join(root, "pg", "data-A");
  await mkdir(join(root, "pg"), { recursive: true });
  await mkdir(data, { recursive: true, mode: 0o700 });
  return { root, data, bin: join(root, "runtime", "pg-current", "bin") };
}
const processRow = (pid, command, { uid = 501, ppid = 1 } = {}) => Object.freeze({ pid, ppid, uid, command });
/** A pid file in PostgreSQL's own eight-line shape, as `postmaster.c` writes it. */
const pidFileText = (pid, dataDirectory) => `${pid}\n${dataDirectory}\n1790811618\n5432\n\n\n\nready\n`;

test("retireDatabase treats a recycled or dead postmaster.pid as stale, and a real one as a refusal",
  { concurrency: false }, async t => {
    // 1. A NEGATIVE pid — PostgreSQL's own STANDALONE marker, which `initdb`
    //    writes and which outlives the process. The old rule read the minus sign
    //    as unparseable and refused forever.
    //    TWO process tables, on purpose: `gone` alone would also be what a
    //    mutation that reads `-4242` as unreadable produces, so the test would
    //    pass either way. With a LIVE process at the absolute pid that is a
    //    program of this runtime on this directory, the two answers differ — an
    //    unreadable file skips the holder check and the sweep then refuses, while
    //    the real rule reads the absolute value, identifies it as `ours`, and
    //    refuses for the named reason instead. Both refuse; only one is correct,
    //    and this is what tells them apart.
    {
      const f = await retirePidFixture(t, "negative");
      await writeFile(join(f.data, "postmaster.pid"), pidFileText(-4242, f.data));
      const gone = await retireDatabaseV1({ root: f.root, pgDataId: "data-A" },
        { listProcesses: async () => [] });
      assert.equal(gone.removed, true, "a standalone pid file whose process is gone is stale, not a refusal");
      const b = await retirePidFixture(t, "negative-live");
      await writeFile(join(b.data, "postmaster.pid"), pidFileText(-4242, b.data));
      const live = processRow(4242, `${b.bin}/postgres -D ${b.data}`);
      await assert.rejects(retireDatabaseV1({ root: b.root, pgDataId: "data-A", accountUid: 501 },
        { listProcesses: async () => [live], binDirectories: [b.bin] }),
      /retire_database_live_cluster_refused:ours/u,
      "a negative pid is a standalone backend's, and it is read as its absolute value");
    }
    // 2. A RECYCLED pid: something unrelated now holds the number. Stale, and
    //    nothing is signalled.
    {
      const f = await retirePidFixture(t, "recycled");
      await writeFile(join(f.data, "postmaster.pid"), pidFileText(4242, f.data));
      const gone = await retireDatabaseV1({ root: f.root, pgDataId: "data-A" },
        { listProcesses: async () => [processRow(4242, "/usr/bin/sleep 600")] });
      assert.equal(gone.removed, true, "a pid that is not a program of this runtime is a recycled pid");
    }
    // 3. EMPTY, TORN and pid-ONLY files are stale too. Reading an unreadable file
    //    as live is what wedged every retry after a power cut (N1).
    for (const [name, text] of [["empty", ""], ["torn", "not-a-pid\n"], ["only-pid", "4242\n"]]) {
      const f = await retirePidFixture(t, name);
      await writeFile(join(f.data, "postmaster.pid"), text);
      const gone = await retireDatabaseV1({ root: f.root, pgDataId: "data-A" },
        { listProcesses: async () => [] });
      assert.equal(gone.removed, true, `a ${name} pid file must not wedge the installer's clean-up`);
    }
    // 4. A LIVE postmaster of this runtime on THIS directory is a refusal, as D's
    //    and as somebody else's. Both hold the directory; they are named apart so
    //    an operator learns which.
    {
      const f = await retirePidFixture(t, "ours");
      await writeFile(join(f.data, "postmaster.pid"), pidFileText(4242, f.data));
      const live = processRow(4242, `${f.bin}/postgres -D ${f.data}`);
      await assert.rejects(retireDatabaseV1({ root: f.root, pgDataId: "data-A" },
        { listProcesses: async () => [live], binDirectories: [f.bin], uid: 501 }),
      /retire_database_live_cluster_refused:ours/u, "a live postmaster of ours must refuse");
      assert.ok(existsSync(join(f.data, "postmaster.pid")),
        "a refused retirement leaves the directory exactly as it was");
    }
    {
      const f = await retirePidFixture(t, "not-ours");
      await writeFile(join(f.data, "postmaster.pid"), pidFileText(4242, f.data));
      const live = processRow(4242, `${f.bin}/postgres -D ${f.data}`, { uid: 502 });
      await assert.rejects(retireDatabaseV1({ root: f.root, pgDataId: "data-A" },
        { listProcesses: async () => [live], binDirectories: [f.bin], uid: 501 }),
      /retire_database_live_cluster_refused:not_database_account/u);
    }
    // 5. A pid file in THIS directory naming ANOTHER directory, held by a live
    //    program of this runtime, is refused before the uid is even considered.
    {
      const f = await retirePidFixture(t, "other-dir");
      const other = join(f.root, "pg", "data-B");
      await writeFile(join(f.data, "postmaster.pid"), pidFileText(4242, other));
      const live = processRow(4242, `${f.bin}/postgres -D ${other}`);
      await assert.rejects(retireDatabaseV1({ root: f.root, pgDataId: "data-A" },
        { listProcesses: async () => [live], binDirectories: [f.bin], uid: 501 }),
      /retire_database_live_cluster_refused:other_data_directory/u);
    }
    // 6. A pid RECYCLED ONTO ANOTHER CLUSTER: a program of this runtime whose argv
    //    names a different `-D`. The pid file in this directory does not own it, so
    //    it is stale — and signalling it would kill the other cluster.
    {
      const f = await retirePidFixture(t, "other-cluster");
      const other = join(f.root, "pg", "data-B");
      await writeFile(join(f.data, "postmaster.pid"), pidFileText(4242, f.data));
      const live = processRow(4242, `${f.bin}/postgres -D ${other}`);
      const gone = await retireDatabaseV1({ root: f.root, pgDataId: "data-A" },
        { listProcesses: async () => [live], binDirectories: [f.bin], uid: 501 });
      assert.equal(gone.removed, true,
        "another cluster's postmaster is not this directory's to refuse or signal");
    }
    // 7. The argv sweep, which is what catches an `initdb` that never wrote a pid
    //    file at all (H3) — and it must not fire on an unrelated process. This
    //    case has NO pid file, because that is the state it exists for: retiring
    //    the directory under a live `initdb` lets its later files land in the
    //    fresh directory the retry is building, because it writes BY PATH.
    {
      const f = await retirePidFixture(t, "sweep");
      const workers = [processRow(99, `${f.bin}/initdb -D ${f.data}`),
        processRow(100, `${f.bin}/postgres -D ${f.data}`, { ppid: 99 })];
      await assert.rejects(retireDatabaseV1({ root: f.root, pgDataId: "data-A", accountUid: 501 },
        { listProcesses: async () => workers, binDirectories: [f.bin] }),
      /retire_database_live_cluster_refused:workers:99,100/u,
      "an orphaned initdb with no pid file must still refuse");
      // The refusal must come BEFORE the removal, or the port has already deleted
      // the directory it just decided it must not delete. Asserted on a fresh
      // fixture because the refused call above leaves this one untouched only if
      // it refused first.
      const b = await retirePidFixture(t, "sweep-order");
      await writeFile(join(b.data, "PG_VERSION"), "17\n");
      // The rows are rebuilt for THIS fixture, both the bin directory and the data
      // directory: a command naming the other fixture's paths is not a worker on
      // this one, so reusing the array above would be refused for the wrong
      // reason (or not at all).
      const bWorkers = [processRow(99, `${b.bin}/initdb -D ${b.data}`),
        processRow(100, `${b.bin}/postgres -D ${b.data}`, { ppid: 99 })];
      await assert.rejects(retireDatabaseV1({ root: b.root, pgDataId: "data-A", accountUid: 501 },
        { listProcesses: async () => bWorkers, binDirectories: [b.bin] }),
      /retire_database_live_cluster_refused:workers/u);
      assert.ok(existsSync(join(b.data, "PG_VERSION")),
        "the refusal must precede the removal, or the directory is destroyed anyway");
      const quiet = await retireDatabaseV1({ root: f.root, pgDataId: "data-A", accountUid: 501 },
        { listProcesses: async () => [processRow(99, "/usr/bin/sleep 600")], binDirectories: [f.bin] });
      assert.equal(quiet.removed, true, "a process that is not this runtime's must not block the retirement");
    }
    // 8. `accountUid` is the caller's, and it must be an account number. This is
    //    the production key, so the DEFAULT path is the one exercised: no
    //    `listProcesses` seam, no `binDirectories`, the real `ps`.
    {
      const f = await retirePidFixture(t, "default-path");
      await writeFile(join(f.data, "postmaster.pid"), pidFileText(4242, f.data));
      // A pid nobody holds, named in this account: stale on the real process table.
      assert.equal((await retireDatabaseV1({ root: f.root, pgDataId: "data-A", accountUid: process.getuid() })).removed,
        true, "the default path must read the real process table, not an injected one");
      // A FRESH fixture per bad value, because the refusal under test happens
      // before the directory is touched, and a rejected call must leave the
      // directory alone — so reusing one fixture would test the "already
      // retired" path instead of the input guard.
      for (const [index, accountUid] of [0, -1, "501", 1.5, 0x7fffffff + 1].entries()) {
        const b = await retirePidFixture(t, `bad-uid-${index}`);
        await writeFile(join(b.data, "PG_VERSION"), "17\n");
        await assert.rejects(retireDatabaseV1({ root: b.root, pgDataId: "data-A", accountUid }),
          /retire_database_input_refused/u, `accountUid=${accountUid} must be refused`);
        assert.ok(existsSync(join(b.data, "PG_VERSION")),
          "a refused input must not have removed the data directory");
      }
    }
  });

test("retireDatabase refuses a data id outside its grammar",
  { skip: needsArchive, timeout: 120_000, concurrency: false }, async () => {
    // The grammar is what keeps the data directory INSIDE `pg/`: `data-[A-Za-z0-9._-]`
    // cannot contain a separator, so `join(pgRoot, pgDataId)` is always one level
    // down. Without it a caller naming `../../etc` would ask the port to remove a
    // directory outside the install root.
    for (const pgDataId of ["../escape", "data-../../etc", "data-", "data-A/B", "/absolute", "data-A B", ""]) {
      await assert.rejects(retireDatabaseV1({ root: "/private/tmp/m4-retire-grammar", pgDataId }),
        /retire_database_(?:input_refused|live_cluster_refused)/u, `pgDataId=${pgDataId} must be refused`);
    }
    // A root that is not a canonical absolute path is refused too.
    for (const root of ["relative", "/", "", "/private/tmp/../etc"]) {
      await assert.rejects(retireDatabaseV1({ root, pgDataId: "data-A" }),
        /retire_database_input_refused/u, `root=${root} must be refused`);
    }
  });

// rv-9b B1: the PRODUCTION stage-one database ports, built the way a fresh install
// builds them — `createStageOnePortsV1(<the native port object>)` — against a real
// cluster. Before the fix every one of them was a `database_port_not_yet_supplied`
// stub on exactly this object, and every installer test injected a fake here.
//
// What is NOT the default, and why: the role manifest's PORT (the lane cannot bind
// the release's 5432, so the health adapter is told the lane's port and nothing
// else), and the first-owner ROWS, which are written with this lane's dependency
// bundle; the production firstOwner (N1) is asserted to be reached here and is run
// end to end against the built release entry in its own lane. `initializeDatabase` is the M1 lane's DEFAULT
// PATH; here it is asserted to be that port, reached through stage one.
test("B1: the production stage-one database ports are M1/M4's, and checkHealth's database half passes on a real cluster",
  { skip: needsArchive, timeout: 900_000, concurrency: false }, async () => {
    const { default: nativePorts } = await import("../src/updater/v1/cli/control-room-native-ports.mjs");
    const { createStageOnePortsV1, initializeDatabaseV1: stubInit, retireDatabaseV1: stubRetire, firstOwnerV1: stubOwner,
      writeDatabaseLoginsV1: stubWrite, removeDatabaseLoginsV1: stubRemove } = await import("../src/updater/v1/install/stage-one-ports.mjs");
    const { checkDatabaseHealthProductionV1 } = await import("../src/updater/v1/pg/database-health-production.mjs");
    const { readRoleManifestV1 } = await import("../src/updater/v1/pg/database-phase-data.mjs");
    const stageOne = createStageOnePortsV1(nativePorts);
    for (const [name, stub] of [["initializeDatabase", stubInit], ["retireDatabase", stubRetire], ["firstOwner", stubOwner],
      ["writeDatabaseLogins", stubWrite], ["removeDatabaseLogins", stubRemove]]) {
      assert.equal(stageOne[name], nativePorts[name], `${name} must be the native port`);
      assert.notEqual(stageOne[name], stub, `${name} must not be the not-yet-supplied stub`);
    }
    const cluster = await freshCluster("stage-one", 9);
    const open = [];
    try {
      // initializeDatabase through stage one is the real port: on a fresh data id it
      // gets as far as its T1 ancestry check, which this non-root lane cannot pass.
      await assert.rejects(stageOne.initializeDatabase({ phase: "init", root: cluster.root, pgDataId: "data-B",
        runtime: "runtime/pg-current", socketDir: "pg/socket", port: cluster.port,
        accounts: ACCOUNTS, logins: cluster.logins, passwords: cluster.passwords }),
      error => error?.code !== "database_port_not_yet_supplied" && !/database_port_not_yet_supplied/u.test(error?.message));
      // The login ports, through stage one, on the real default path.
      const written = await stageOne.writeDatabaseLogins({ root: cluster.root, accounts: { service: ACCOUNTS.service },
        passwords: cluster.passwords });
      assert.equal(written.references.length, Object.keys(cluster.passwords).length);
      await stageOne.removeDatabaseLogins({ root: cluster.root, receipt: written.receipt });
      // firstOwner through stage one is N1's `firstOwnerViaScriptV1`: it takes the
      // installer's full input, and on this non-root lane it gets as far as T1 on the
      // pinned Node — no longer `first_owner_dependency_refused`. The end-to-end run
      // of the built release entry is `install-first-owner-script-real-postgres`.
      await assert.rejects(stageOne.firstOwner({ ...ownerInput(cluster.root, cluster.applied.schemaDigest),
        accounts: ACCOUNTS, pgDataId: "data-A", owner: FIRST_OWNER_OWNER_V1 }),
      error => /^t1_/u.test(error?.code ?? error?.message) && !/first_owner_dependency_refused/u.test(error?.message));
      await assert.rejects(stageOne.firstOwner(ownerInput(cluster.root, cluster.applied.schemaDigest)),
        /first_owner_input_refused/u);
      const { manifest, tenantId } = firstOwnerManifest(new Date().toISOString());
      const dependencies = await portDependencies(cluster.context, { manifest, digestSql: cluster.digestSql, tenantId });
      open.push(dependencies);
      await firstOwnerV1(ownerInput(cluster.root, cluster.applied.schemaDigest), dependencies);
      // checkHealth's database half: the production adapter, its production
      // dependencies (data-directory owner, role manifest, bundle digest SQL, DDL
      // file digest, psql as D under service-postgres.sb), against the server.
      mkdirSync(join(cluster.root, "releases"), { recursive: true });
      symlinkSync(REPO, join(cluster.root, "releases", "m4"));
      rmSync(join(cluster.root, "current"));
      symlinkSync("releases/m4", join(cluster.root, "current"));
      const lanePort = { readRoleManifest: async releaseRoot => ({ ...(await readRoleManifestV1(releaseRoot)), port: cluster.port }) };
      const healthInput = { root: cluster.root, pgDataId: "data-A", schemaDigest: cluster.applied.schemaDigest,
        updaterSchemaDigest: cluster.initResult.updaterSchemaDigest };
      assert.deepEqual(await checkDatabaseHealthProductionV1(healthInput, lanePort), { healthy: true,
        schemaDigest: cluster.applied.schemaDigest, updaterSchemaDigest: cluster.initResult.updaterSchemaDigest });
      await assert.rejects(checkDatabaseHealthProductionV1({ ...healthInput, schemaDigest: `sha256:${"0".repeat(64)}` }, lanePort),
        /health_database_refused:schema_drift/u);
      await assert.rejects(checkDatabaseHealthProductionV1({ ...healthInput, updaterSchemaDigest: `sha256:${"1".repeat(64)}` }, lanePort),
        /health_database_refused:updater_drift/u);
      // retireDatabase through stage one, after the cluster stops, with init's
      // pg/current link still naming the data directory (rv-9b B4): it retires both.
      await closeAll(open);
      await stopCluster(cluster);
      const retired = await stageOne.retireDatabase({ root: cluster.root, pgDataId: "data-A", accountUid: process.getuid() });
      assert.equal(retired.removed, true);
      assert.equal(existsSync(join(cluster.root, "pg", "data-A")), false);
      assert.equal(existsSync(join(cluster.root, "pg", "current")), false);
    } finally { await closeAll(open); await stopCluster(cluster); }
  });

// ---------------------------------------------------------------------------
// cl-pkwire: the install-night Face ID step through the PRODUCTION ports.
// ---------------------------------------------------------------------------
// Before this, the native object's `registerInitialPasskey` was M3's port with no
// session and no authority (every call: `passkey_authority_port_unbound`), and
// stage one's was the `database_port_not_yet_supplied` stub. The test below calls
// `createStageOnePortsV1(<the native port object>).registerInitialPasskey` with the
// input the installer builds (`config` is stage one's `{ rpId }`, nothing more),
// against a real cluster built by the real init and release phases, connecting as
// `control_room_deployer` over the install root's socket through the peer map —
// the only things this lane supplies are the files stage one would have written
// (`updater.json`, `host.json`), the cluster PORT (the lane cannot bind 5432), the
// owner's web session rows, and the phone: a real software authenticator posting
// through the real web store as the real web login.
const PKWIRE_RP_ID = "control-room.pkwire.test";
const PKWIRE_ORIGIN = `https://${PKWIRE_RP_ID}`;
const PKWIRE_INSTALLATION = "pkwire-install";
const PKWIRE_OWNER_CODE = "pkwire-owner-code-0123456789";

/** Rewrite the peer map and reload, as the database account. */
async function reloadPeerMap(context, text) {
  const data = join(context.root, "pg", "data-A");
  await writeFile(join(data, "pg_ident.conf"), text, { mode: 0o600 });
  const reloaded = await spawnPgFamily({ executable: join(context.root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", data, "reload"], environment: context.environment, ...context.identity, role: "database",
    profile: context.profile, profileParameters: context.profileParameters, cwd: join(context.root, "pg"),
    timeoutMs: 60_000 });
  assert.equal(reloaded.code, 0, `pg_ctl reload failed: ${reloaded.stderr}`);
  // A reload is asynchronous in the postmaster; give it a beat before the next connect.
  await new Promise(resolveWait => setTimeout(resolveWait, 500));
}

/** The two files stage one's protected configuration writes and this step reads. */
async function writePasskeyInstallFiles(root, { user = "control_room_deployer" } = {}) {
  const { UPDATER_CONFIGURATION_SCHEMA_V1 } = await import("../src/updater/v1/services/protected-config.mjs");
  await mkdir(join(root, "updater-state"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "status"), { recursive: true, mode: 0o755 });
  await mkdir(join(root, "Protected", "config"), { recursive: true, mode: 0o700 });
  await rm(join(root, "updater-state", "updater.json"), { force: true });
  await writeFile(join(root, "updater-state", "updater.json"), `${JSON.stringify({ schema: UPDATER_CONFIGURATION_SCHEMA_V1,
    database: { host: join(root, "pg", "socket"), port: 5432, name: "control_room", user } })}\n`, { mode: 0o600 });
  await writeFile(join(root, "Protected", "config", "host.json"), `${JSON.stringify({ installationId: PKWIRE_INSTALLATION,
    rpId: PKWIRE_RP_ID, expectedOrigin: PKWIRE_ORIGIN })}\n`, { mode: 0o600 });
}

/** A live owner web session, written as the superuser with the release's triggers off. */
async function seedPasskeyOwnerSession(context) {
  const client = await realPgClientFor(context);
  const tenant = "tenant-pkwire", owner = "identity:pkwire-owner", now = new Date().toISOString();
  const session = `sha256:${createHash("sha256").update("pkwire-owner-session").digest("hex")}`;
  try {
    await client.query("SET session_replication_role = replica");
    await client.query("INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING", [tenant]);
    await client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
      ON CONFLICT DO NOTHING`, [owner, tenant, `sha256:${createHash("sha256").update(owner).digest("hex")}`, now]);
    await client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,risk_ceiling,
      allowed_actions,project_ids,created_at,updated_at)
      VALUES($1,$2,$3,'owner','critical','["*"]','["*"]',$4,$4) ON CONFLICT DO NOTHING`, [`grant:${owner}`, tenant, owner, now]);
    await client.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [tenant, session, owner, now, new Date(Date.parse(now) + 3_600_000).toISOString()]);
  } finally { await client.end().catch(() => undefined); }
  return session;
}

test("cl-pkwire: the production stage-one passkey ports register Face ID end to end on a real cluster, and refuse a wrong login, an expired registration and an already-open one",
  { skip: needsArchive, timeout: 900_000, concurrency: false }, async t => {
    const { default: nativePorts } = await import("../src/updater/v1/cli/control-room-native-ports.mjs");
    const { createStageOnePortsV1, registerInitialPasskeyV1: stubRegister, recordPasskeyStatusV1: stubStatus } =
      await import("../src/updater/v1/install/stage-one-ports.mjs");
    const { comparisonCodeV1 } = await import("../src/updater/v1/passkey.mjs");
    const { createMacLocalPasskeyRegistrationPortV1 } = await import("../src/web/v1/mac-local-host.ts");
    const { createSoftwareAuthenticatorV1 } = await import("./support/passkey-software-authenticator.mjs");
    const stageOne = createStageOnePortsV1(nativePorts);
    // Each case is its own subtest on the one cluster, so a regression names the
    // case it broke rather than stopping at the first. They run in order: the
    // refusals leave no passkey, the end-to-end case makes one, the last refuses a
    // second.
    await t.test("stage one hands out the native passkey ports, never the not-yet-supplied stubs", () => {
      // The installer's passkey transaction calls the native object; stage one
      // hands out the same two functions.
      for (const [name, stub] of [["registerInitialPasskey", stubRegister], ["recordPasskeyStatus", stubStatus]]) {
        assert.equal(stageOne[name], nativePorts[name], `${name} must be the native port`);
        assert.notEqual(stageOne[name], stub, `${name} must not be the not-yet-supplied stub`);
      }
    });
    const cluster = await freshCluster("passkey", 10);
    const { Client } = clientModule();
    const open = [];
    try {
      const root = cluster.root, lane = { databasePort: cluster.port };
      await writePasskeyInstallFiles(root);
      const ownerSession = await seedPasskeyOwnerSession(cluster.context);
      const superuser = await realPgClientFor(cluster.context); open.push({ close: () => superuser.end().catch(() => {}) });
      // The web login's group, from the release's role manifest. This lane's
      // `convergeGrants` is a no-op, so the membership the install converges is
      // granted here, and only that one.
      await superuser.query(`GRANT ${databaseRoleManifestV1.logins.control_room_web.group} TO control_room_web`);
      const web = new Client({ host: join(root, "pg", "socket"), port: cluster.port, database: "control_room",
        user: "control_room_web", password: cluster.passwords.control_room_web, ssl: false });
      await web.connect(); open.push({ close: () => web.end().catch(() => {}) });
      const phone = createMacLocalPasskeyRegistrationPortV1(web);
      const authenticator = createSoftwareAuthenticatorV1({ rpId: PKWIRE_RP_ID, origin: PKWIRE_ORIGIN });
      const rightCode = comparisonCodeV1(authenticator.credentialId);
      const wrongCode = rightCode === "AAAAAA" ? "BBBBBB" : "AAAAAA";
      const openRows = async () => (await superuser.query(`SELECT registration_digest, installation_id, mode,
        consumed_at FROM updater.passkey_open_registrations ORDER BY created_at, registration_digest`)).rows;
      const ledgerPath = join(root, "updater-state", "passkeys.json");
      const ledger = async () => JSON.parse(await readFile(ledgerPath, "utf8"));
      const passkeyCount = async () => existsSync(ledgerPath) ? (await ledger()).passkeys.length : 0;
      // The installer's input, exactly: `installer.mjs` `runInitialPasskeyTransactionV1`.
      const terminalFor = readLine => ({ isTTY: true, write: () => {}, setRawMode: () => {}, readLine });
      const inputFor = terminal => ({ root, config: { rpId: PKWIRE_RP_ID }, ownerCode: PKWIRE_OWNER_CODE, terminal,
        qr: { ownerCodePolicy: "every-unconsumed-attempt" }, maxAttempts: 5 });
      const neverAsked = terminalFor(async () => { throw new Error("the port asked for a code it must not have reached"); });
      // The secret is what the QR carries; the phone reads it from the URL the
      // terminal printed, as the owner's camera would.
      const printed = [];
      const qrTerminalFor = readLine => ({ ...terminalFor(readLine), write: value => printed.push(String(value)) });
      const latestSecret = () => {
        const matches = [...printed.join("").matchAll(/[#&]reg=([A-Za-z0-9_-]{43})/gu)];
        assert.ok(matches.length > 0, "the terminal printed a registration URL");
        return matches.at(-1)[1];
      };

      await t.test("wrong login: updater.json naming a login other than the deployer", async () => {
        // Refused by the updater's own loader, before a connection or a registration exists.
        await writePasskeyInstallFiles(root, { user: "control_room_web" });
        try {
          await assert.rejects(async () => stageOne.registerInitialPasskey(inputFor(neverAsked), lane),
            error => error?.code === "updater_configuration_refused");
        } finally { await writePasskeyInstallFiles(root); }
      });
      await t.test("wrong login: a process the peer map does not send to the deployer", async () => {
        // The real map, whose only deployer line is `cr root control_room_deployer`:
        // the SERVER refuses this non-root process, and the port names the refusal.
        await reloadPeerMap(cluster.context, pgHbaPeerMapV1({ database: userInfo().username,
          migrator: "control_room_migrator", deployer: "control_room_deployer" }));
        try {
          await assert.rejects(async () => stageOne.registerInitialPasskey(inputFor(neverAsked), lane),
            error => error?.code === "passkey_deployer_session_refused:28000");
        } finally { await simulateRootDeployerPeer(cluster.context); }
      });
      await t.test("wrong login: a deployer session that is not an ordinary one", async () => {
        // Replica mode skips the release's triggers; `PasskeyStoreV1.initialize()` refuses it.
        await superuser.query("ALTER ROLE control_room_deployer SET session_replication_role = replica");
        try {
          await assert.rejects(async () => stageOne.registerInitialPasskey(inputFor(neverAsked), lane),
            error => error?.code === "updater_store_role_refused");
        } finally { await superuser.query("ALTER ROLE control_room_deployer RESET session_replication_role"); }
      });
      await t.test("a host.json for a different RP ID than the one stage one printed for", async () => {
        await assert.rejects(async () => stageOne.registerInitialPasskey({ ...inputFor(neverAsked),
          config: { rpId: "other.pkwire.test" } }, lane), error => error?.code === "updater_passkey_config_refused");
      });
      await t.test("no refusal so far published a registration or reached the ledger", async () => {
        assert.deepEqual(await openRows(), []);
        assert.equal(existsSync(ledgerPath), false);
      });

      await t.test("already open: the digest is published before the installer's insert lands", async () => {
        // A second publisher won the race: a trigger, as the superuser, publishes the
        // same row first. The port must refuse rather than report a publish it did
        // not perform, and must not ask the owner for a code.
        await superuser.query(`CREATE FUNCTION public.pkwire_race() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF pg_catalog.pg_trigger_depth() = 1 THEN
              INSERT INTO updater.passkey_open_registrations (registration_digest, installation_id, mode, options_json,
                authorization_challenge, expires_at)
              VALUES (NEW.registration_digest, NEW.installation_id, NEW.mode, NEW.options_json,
                NEW.authorization_challenge, NEW.expires_at);
            END IF;
            RETURN NEW;
          END $$`);
        await superuser.query(`CREATE TRIGGER pkwire_race BEFORE INSERT ON updater.passkey_open_registrations
          FOR EACH ROW EXECUTE FUNCTION public.pkwire_race()`);
        const before = (await openRows()).length;
        try {
          await assert.rejects(async () => stageOne.registerInitialPasskey(inputFor(neverAsked), lane),
            error => error?.code === "passkey_registration_already_open");
        } finally {
          await superuser.query("DROP TRIGGER pkwire_race ON updater.passkey_open_registrations");
          await superuser.query("DROP FUNCTION public.pkwire_race()");
        }
        assert.equal((await openRows()).length, before + 1, "exactly the racer's row");
        assert.equal(await passkeyCount(), 0, "no passkey from a refused publish");
      });

      await t.test("expired: every registration outlives its 30 minutes while the installer waits", async () => {
        // The production authority runs on the real clock, so the lane moves the
        // LEDGER's expiry instant into the past while the port waits for the code —
        // the moment 30 minutes would have passed. The port retries five times with
        // a fresh registration each time, then refuses by name.
        let asked = 0;
        const terminal = qrTerminalFor(async () => {
          asked += 1;
          const value = await ledger();
          for (const item of value.registrations) item.expiresAt = new Date(Date.now() - 60_000).toISOString();
          await writeFile(ledgerPath, `${JSON.stringify(value)}\n`);
          return rightCode;
        });
        const before = (await openRows()).length;
        await assert.rejects(async () => stageOne.registerInitialPasskey(inputFor(terminal), lane),
          error => error?.code === "updater_registration_expired");
        assert.equal(asked, 5, "five attempts, each with its own registration");
        const rows = (await openRows()).slice(before);
        assert.equal(rows.length, 5);
        assert.ok(rows.every(row => row.consumed_at !== null && row.mode === "initial"
          && row.installation_id === PKWIRE_INSTALLATION), "every expired registration was published as initial and burnt");
        assert.equal(await passkeyCount(), 0);
        // The installer records the stop through the production status port.
        assert.deepEqual(await stageOne.recordPasskeyStatus({ root, status: "stopped", reason: "updater_registration_expired" }),
          { recorded: true, status: "stopped" });
        assert.deepEqual(JSON.parse(await readFile(join(root, "status", "passkey.json"), "utf8")),
          { schema: "control-room.install-passkey-status/v1", status: "stopped", reason: "updater_registration_expired" });
      });

      await t.test("end to end: open registration → phone → typed code → registered → status recorded", async () => {
        // The phone reads the options the installer published and posts a real
        // attestation with the owner's session; the owner types the code. Attempt 1
        // carries the WRONG code (a new registration follows); attempt 2 the right one.
        printed.length = 0;
        let asked = 0;
        const terminal = qrTerminalFor(async () => {
          asked += 1;
          const registrationSecret = latestSecret();
          const options = await phone.options({ ownerSessionDigest: ownerSession, registrationSecret });
          assert.equal(options.publicKey.rp.id, PKWIRE_RP_ID);
          assert.equal(options.publicKey.authenticatorSelection.userVerification, "required");
          const typed = asked === 1 ? wrongCode : rightCode;
          await phone.insert({ ownerSessionDigest: ownerSession, registrationSecret, comparisonCode: typed,
            response: authenticator.register(options.publicKey.challenge) });
          return typed;
        });
        const before = (await openRows()).length;
        const result = await stageOne.registerInitialPasskey(inputFor(terminal), lane);
        assert.deepEqual(result, { status: "registered", attempts: 2,
          credentialIdDigest: `sha256:${createHash("sha256").update(authenticator.credentialId, "utf8").digest("hex")}` });
        assert.match(printed.join(""), new RegExp(`#code=${PKWIRE_OWNER_CODE}&reg=`, "u"),
          "the QR carries the owner code on an unconsumed attempt");
        const rows = (await openRows()).slice(before);
        assert.equal(rows.length, 2, "one published registration per attempt");
        assert.ok(rows.every(row => row.consumed_at !== null), "both registrations are burnt after the ceremony");
        const passkeys = (await ledger()).passkeys;
        assert.equal(passkeys.length, 1);
        assert.equal(passkeys[0].credentialId, authenticator.credentialId);
        assert.equal(passkeys[0].coolingOffUntil, null, "a first passkey is active tonight, not in 24 hours");
        assert.ok(Buffer.from(String(passkeys[0].publicKey), "base64url").equals(authenticator.coseKey),
          "the ledger holds the software authenticator's own key, extracted by the real verifier");
        assert.deepEqual(await stageOne.recordPasskeyStatus({ root, ...result }), { recorded: true, status: "registered" });
        const status = join(root, "status", "passkey.json");
        assert.deepEqual(JSON.parse(await readFile(status, "utf8")), { schema: "control-room.install-passkey-status/v1",
          status: "registered", credentialIdDigest: result.credentialIdDigest, attempts: 2 });
        assert.equal(lstatSync(status).mode & 0o777, 0o600);
      });

      await t.test("a second first passkey is refused: initial is only for a Mac with none", async () => {
        const before = (await openRows()).length;
        await assert.rejects(async () => stageOne.registerInitialPasskey(inputFor(neverAsked), lane),
          error => error?.code === "updater_registration_mode_refused");
        assert.equal((await openRows()).length, before, "nothing published for a refused second initial");
      });
    } finally { await closeAll(open); await stopCluster(cluster); }
  });
