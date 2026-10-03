// N1's REAL-PostgreSQL lane: the PRODUCTION first-owner port runs the BUILT release
// entry against a real cluster.
//
// WHAT IS REAL: the release build (`node scripts/build-vps.mjs`, the same command
// the attended release runs) producing `dist-vps/server/firstOwner.js`; the
// vendored PostgreSQL 17.11 runtime, `initdb`, the postmaster and the peer map as
// the server loaded them; the REAL init and release phases; and
// `firstOwnerViaScriptV1` — which spawns that built file with a pinned Node as the
// database account, writes ONE JSON request to its stdin and parses ONE line back.
// The transaction the child runs is the release's own `applyMacLocalFirstOwnerV1`.
//
// THE THREE LANE OVERRIDES, named so nobody mistakes them for production:
//   - `assertPath`: T1 demands a root-owned ancestry, which a non-root lane under
//     /private/tmp does not have (asserted below: the native port refuses at T1);
//   - `readRoleManifest`: the release's port is 5432, which the lane cannot bind;
//   - the database account is THIS uid, as in every sibling lane (no root).
// `onSpawn` only observes (and, in the kill cases, kills) the child.
//
// Skips without `PG_RUNTIME_ARCHIVE`, the sibling lanes' convention.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pgHbaPeerMapV1, planPgClusterLayoutV1 } from "../src/pg-runtime/v1/pg-cluster-layout";
import { vendorPgRuntimeV1 } from "../src/updater/v1/pg/pg-runtime-vendor";
import { initializeDatabaseV1 as initializeDatabaseV1Script } from "../src/updater/v1/pg/init-database.mjs";
import { applyReleaseSchemaV1, ledgerHeadV1, readReleaseLedgerV1 } from "../src/updater/v1/pg/apply-release-schema.mjs";
import { postgresProfileParametersV1, spawnPgFamily } from "../src/updater/v1/pg/database-phase-process.mjs";
import { readRoleManifestV1 } from "../src/updater/v1/pg/database-phase-data.mjs";
import { databaseRoleAttributesV1, databaseRoleManifestV1 } from "../scripts/mac-local/database-role-manifest.mjs";
import { firstOwnerViaScriptV1 } from "../src/updater/v1/pg/first-owner-script.mjs";
import { checkDatabaseHealthProductionV1 } from "../src/updater/v1/pg/database-health-production.mjs";
import { FIRST_OWNER_OWNER_V1, INSTALL_DATABASE_LOGINS_V1 } from "../src/updater/v1/install/install-steps.mjs";
import { sha256Digest } from "../src/security/canonical-digest";

const REPO = resolve(join(dirname(new URL(import.meta.url).pathname), ".."));
const ARCHIVE = process.env.PG_RUNTIME_ARCHIVE;
const needsArchive = ARCHIVE !== undefined && existsSync(ARCHIVE) ? false : "needs the pinned archive (PG_RUNTIME_ARCHIVE)";
const PORT = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59960);
const LANE_ROOT = "/private/tmp";
const ENTRY = join(REPO, "dist-vps", "server", "firstOwner.js");
const { Client } = await import("pg");

const RUNS = [];
process.on("exit", () => {
  for (const run of RUNS) {
    try { execFileSync("/bin/chmod", ["-R", "u+rwx", run]); } catch { /* best effort */ }
    try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const ACCOUNTS = Object.freeze({
  database: Object.freeze({ name: userInfo().username, uid: process.getuid(), gid: process.getgid() }),
  service: Object.freeze({ name: `${userInfo().username}-service`, uid: process.getuid() === 502 ? 503 : 502, gid: process.getgid() }),
});

let builtPromise = null;
/** The release build, once per run, exactly as the attended release builds it. */
function buildRelease() {
  builtPromise ??= (async () => {
    assert.match(readFileSync(join(REPO, "vite.vps.config.ts"), "utf8"),
      /firstOwner: "src\/installer\/v1\/first-owner-entry\.ts",/u, "the release must name the entry");
    rmSync(ENTRY, { force: true });
    execFileSync(process.execPath, [join(REPO, "scripts", "build-vps.mjs")], { cwd: REPO, stdio: "pipe",
      env: { ...process.env, CONTROL_ROOM_BUILD_TARGET: "vps-node" }, timeout: 600_000 });
    assert.ok(lstatSync(ENTRY).isFile(), "the build must emit dist-vps/server/firstOwner.js");
  })();
  return builtPromise;
}

let sharedPromise = null;
function sharedRuntime() {
  sharedPromise ??= (async () => {
    const run = mkdtempSync(join(LANE_ROOT, "n1-first-owner-"));
    RUNS.push(run);
    const runtimeParent = join(run, "shared");
    mkdirSync(runtimeParent, { recursive: true, mode: 0o755 });
    const result = await vendorPgRuntimeV1({ archivePath: ARCHIVE, runtimeDirectory: join(runtimeParent, "pg-17.11"),
      opensslConf: "# fixed and empty (R9b)\n", hooks: { normaliseOwnership: false } });
    assert.equal(result.status, "pg_runtime_vendored", result.refusal);
    symlinkSync("pg-17.11", join(runtimeParent, "pg-current"));
    // The release's pinned Node, as `runtime/node-current/bin/node`: this lane's own.
    mkdirSync(join(runtimeParent, "node-current", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(runtimeParent, "node-current", "bin", "node"));
    return { run, runtimeParent };
  })();
  return sharedPromise;
}

const MANIFEST_ROLES = Object.freeze([
  ...databaseRoleManifestV1.groups.map(name => ({ name, attributes: databaseRoleAttributesV1(name) })),
  ...Object.keys(databaseRoleManifestV1.logins).map(name => ({ name, attributes: databaseRoleAttributesV1(name) })),
]);
const roleData = port => Object.freeze({ database: "control_room", port, roles: MANIFEST_ROLES,
  migratorName: "control_room_migrator", migratorGroup: "control_room_schema_owner", deployerName: "control_room_deployer" });

const phaseLogins = () => {
  const passwords = Object.create(null);
  for (const name of INSTALL_DATABASE_LOGINS_V1) {
    const bytes = Buffer.alloc(32);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (name.charCodeAt(index % name.length) + index * 7) & 0xff;
    Object.defineProperty(passwords, name, { value: bytes.toString("base64url"), enumerable: true });
  }
  return { logins: INSTALL_DATABASE_LOGINS_V1.map(name => ({ name, passwordStdin: true })), passwords };
};

function layoutFor(root, port) {
  return planPgClusterLayoutV1({ pgRoot: join(root, "pg"), dataId: "data-A",
    runtimeDirectory: join(root, "runtime", "pg-current"),
    accounts: { database: ACCOUNTS.database.name, migrator: "control_room_migrator", deployer: "control_room_deployer" },
    port });
}

/** A fresh install root with the release staged as `current -> releases/n1`, then
 * the REAL init and release phases and a running postmaster. */
async function freshCluster(label, portOffset) {
  await buildRelease();
  const { run, runtimeParent } = await sharedRuntime();
  const root = join(run, label), port = PORT + portOffset;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  symlinkSync(runtimeParent, join(root, "runtime"));
  mkdirSync(join(root, "updater", "current", "pg"), { recursive: true, mode: 0o755 });
  for (const [from, to] of [["src/updater/v1/ddl", "updater/current/ddl"], ["src/updater/v1/policy", "updater/current/policy"]]) {
    execFileSync("/bin/cp", ["-R", join(REPO, from), join(root, to)], { stdio: "pipe" });
  }
  execFileSync("/bin/cp", [join(REPO, "src/updater/v1/pg/release-schema-digest.sql"),
    join(root, "updater/current/pg/release-schema-digest.sql")], { stdio: "pipe" });
  mkdirSync(join(root, "logs", "postgresql17"), { recursive: true, mode: 0o750 });
  mkdirSync(join(root, "pg", "socket"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "releases"));
  symlinkSync(REPO, join(root, "releases", "n1"));
  symlinkSync("releases/n1", join(root, "current"));
  const { logins, passwords } = phaseLogins();
  const dependencies = { ...roleData(port), planLayout: input => planPgClusterLayoutV1(input) };
  const request = Object.freeze({ schema: "control-room.database-init/v1", root, pgDataId: "data-A",
    runtime: "runtime/pg-current", socketDir: "pg/socket", port, accounts: ACCOUNTS, logins });
  const initResult = await initializeDatabaseV1Script(request, passwords, dependencies);
  assert.equal(initResult.outcome, "initialized");
  const layout = layoutFor(root, port);
  const context = { root, layout, port, environment: { ...layout.environment }, pgRoot: join(root, "pg"),
    identity: { uid: ACCOUNTS.database.uid, gid: ACCOUNTS.database.gid },
    profile: join(root, "updater", "current", "policy", "service-postgres.sb"),
    profileParameters: postgresProfileParametersV1({ root, layout, logDirectory: join(root, "logs", "postgresql17") }) };
  const cluster = { root, port, context, initResult, layout };
  const started = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(root, "pg", "data-A"), "-l", join(root, "logs/postgresql17/out.log"), "-o", `-p ${port}`,
      "-w", "-t", "60", "start"], ...context, role: "database", cwd: join(root, "pg") });
  assert.equal(started.code, 0, `postmaster start failed: ${started.stderr}`);
  cluster.started = true;
  try {
    // The sibling lanes' deployer simulation: root's `cr root control_room_deployer`
    // line, spelled for this uid, because the lane cannot be root.
    const data = join(root, "pg", "data-A");
    writeFileSync(join(data, "pg_ident.conf"), `${pgHbaPeerMapV1({ database: userInfo().username,
      migrator: "control_room_migrator", deployer: "control_room_deployer" })}cr ${userInfo().username} control_room_deployer\n`,
    { mode: 0o600 });
    const reloaded = await spawnPgFamily({ executable: join(root, "runtime/pg-current/bin/pg_ctl"),
      args: ["-D", data, "reload"], ...context, role: "database", cwd: join(root, "pg"), timeoutMs: 60_000 });
    assert.equal(reloaded.code, 0, `pg_ctl reload failed: ${reloaded.stderr}`);
    const applied = await applyReleaseSchemaV1({ ...request, schema: "control-room.release-schema/v1", release: "current",
      expectedLedgerHead: ledgerHeadV1(await readReleaseLedgerV1(REPO)) }, passwords, { ...dependencies,
      convergeGrants: async () => ({ converged: true }),
      installFixedQueue: async ({ database }) => {
        const { installFixedQueueSchemaV1 } = await import("../scripts/mac-local/fixed-queue-schema.mjs");
        const client = new Client({ host: layout.socketDirectory, port, user: "postgres", database, ssl: false });
        await client.connect();
        try { await installFixedQueueSchemaV1(client); } finally { await client.end().catch(() => undefined); }
      },
      deployerIdentity: { uid: process.getuid(), gid: process.getgid() },
      verifyLogin: async () => ({ authenticated: true, refusedWithoutPassword: true }) });
    assert.equal(applied.outcome, "applied");
    cluster.applied = applied;
  } catch (error) { await stopCluster(cluster); throw error; }
  return cluster;
}

async function stopCluster(cluster) {
  if (!cluster?.started) return;
  cluster.started = false;
  const result = await spawnPgFamily({ executable: join(cluster.root, "runtime/pg-current/bin/pg_ctl"),
    args: ["-D", join(cluster.root, "pg", "data-A"), "-m", "fast", "-w", "-t", "60", "stop"],
    ...cluster.context, role: "database", cwd: join(cluster.root, "pg") });
  if (result.code !== 0) throw new Error(`the lane leaked a postmaster: pg_ctl stop exited ${result.code}`);
}

async function superuser(cluster) {
  const client = new Client({ host: cluster.layout.socketDirectory, port: cluster.port, user: "postgres",
    database: "control_room", ssl: false, application_name: "n1-lane-observer" });
  await client.connect();
  return client;
}

/** The three lane overrides, and nothing else. */
const laneRuntime = (cluster, extra = {}) => ({
  assertPath: async path => realpath(path),
  readRoleManifest: async releaseRoot => ({ ...(await readRoleManifestV1(releaseRoot)), port: cluster.port }),
  ...extra,
});

/** The EXACT input `install-steps.mjs` sends at the `first-owner` step. */
const installerInput = cluster => Object.freeze({ root: cluster.root, accounts: ACCOUNTS, release: "current",
  schemaDigest: cluster.applied.schemaDigest, pgDataId: "data-A", owner: FIRST_OWNER_OWNER_V1 });

const EXPECTED_RESULT = Object.freeze({ tenantId: "tenant:mac-local", workspaceId: "workspace:mac-local",
  provider: "local-owner", subject: "owner:local" });

async function ownerRows(client) {
  const count = async table => Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const keys = (await client.query("SELECT node_id, fingerprint FROM control_node_keys ORDER BY node_id")).rows;
  return { tenants: await count("tenants"), workspaces: await count("workspaces"), identities: await count("control_identities"),
    grants: await count("control_role_grants"), adapters: await count("adapter_registry"), nodes: await count("control_nodes"),
    gate: await count("control_completion_gate_integrity"), keys };
}

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(next => setTimeout(next, 20)); }
  throw new Error(`timed out waiting for ${label}`);
};
const childBackends = async client => Number((await client.query(
  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'control-room-first-owner'")).rows[0].n);

test("the production first-owner port runs the BUILT release entry and creates the owner once",
  { skip: needsArchive, timeout: 900_000 }, async () => {
    const cluster = await freshCluster("owner", 0);
    let observer;
    try {
      // The native port object's firstOwner IS this port: on the lane's non-root
      // ancestry it refuses at T1, before any spawn — not `first_owner_dependency_refused`.
      const { default: nativePorts } = await import("../src/updater/v1/cli/control-room-native-ports.mjs");
      const { createStageOnePortsV1 } = await import("../src/updater/v1/install/stage-one-ports.mjs");
      assert.equal(createStageOnePortsV1(nativePorts).firstOwner, nativePorts.firstOwner);
      await assert.rejects(nativePorts.firstOwner({ ...installerInput(cluster) }),
        error => /^t1_|first_owner_database_refused/u.test(error?.code ?? error?.message)
          && !/first_owner_dependency_refused/u.test(error?.message));

      const spawned = [];
      const owner = await firstOwnerViaScriptV1(installerInput(cluster), laneRuntime(cluster, { onSpawn: child => spawned.push(child) }));
      assert.deepEqual(owner, EXPECTED_RESULT, "the four keys install-steps demands, with the subject PRE-IMAGE");
      assert.equal(spawned.length, 1);
      // argv is exactly the pinned node and the built entry: no request, no secret.
      assert.deepEqual(spawned[0].spawnargs, [await realpath(join(cluster.root, "runtime/node-current/bin/node")),
        await realpath(join(cluster.root, "current/dist-vps/server/firstOwner.js"))]);
      assert.equal(spawned[0].spawnargs[1], await realpath(ENTRY), "the child ran the BUILT release file");
      const state = JSON.parse(readFileSync(join(cluster.root, "updater-state", "first-owner.json"), "utf8"));
      assert.equal(lstatSync(join(cluster.root, "updater-state", "first-owner.json")).mode & 0o777, 0o600);
      assert.ok(!spawned[0].spawnargs.join(" ").includes(state.reviewKey));

      observer = await superuser(cluster);
      const rows = await ownerRows(observer);
      assert.deepEqual({ ...rows, keys: rows.keys.length },
        { tenants: 1, workspaces: 1, identities: 1, grants: 1, adapters: 3, nodes: 3, gate: 1, keys: 3 });
      const identity = (await observer.query("SELECT id, auth_provider, auth_subject_digest, created_at FROM control_identities")).rows[0];
      assert.equal(identity.id, "identity:tenant:mac-local:owner");
      assert.equal(identity.auth_subject_digest, sha256Digest({ provider: "local-owner", subject: "owner:local" }),
        "the owner row signs in as exactly the values composed into local-owner-session.json");
      assert.equal(new Date(identity.created_at).toISOString(), state.createdAt);
      assert.deepEqual(rows.keys.map(row => row.node_id), ["mac-1.claude", "mac-1.codex", "mac-1.hermes"]);

      // §5.8's database half on the production adapter: counts 1/1 three times.
      const health = await checkDatabaseHealthProductionV1({ root: cluster.root, pgDataId: "data-A",
        schemaDigest: cluster.applied.schemaDigest, updaterSchemaDigest: cluster.initResult.updaterSchemaDigest },
      { readRoleManifest: laneRuntime(cluster).readRoleManifest });
      assert.equal(health.healthy, true);

      // A re-run recognises the done owner: same answer, every row kept, keys unchanged.
      assert.deepEqual(await firstOwnerViaScriptV1(installerInput(cluster), laneRuntime(cluster)), EXPECTED_RESULT);
      assert.deepEqual(await ownerRows(observer), rows);

      // A schema that drifted after step 22 is refused BEFORE the child is spawned.
      let drifted = false;
      await assert.rejects(firstOwnerViaScriptV1({ ...installerInput(cluster), schemaDigest: `sha256:${"0".repeat(64)}` },
        laneRuntime(cluster, { onSpawn: () => { drifted = true; } })), /first_owner_schema_drift/u);
      assert.equal(drifted, false);
      // The child runs as the data directory's owner and nobody else.
      await assert.rejects(firstOwnerViaScriptV1({ ...installerInput(cluster),
        accounts: { ...ACCOUNTS, database: { ...ACCOUNTS.database, uid: ACCOUNTS.database.uid + 1 } } }, laneRuntime(cluster)),
      /first_owner_database_account_refused/u);
    } finally { await observer?.end().catch(() => undefined); await stopCluster(cluster); }
  });

test("a first-owner child SIGKILLed mid-transaction rolls back, and the retry creates the owner",
  { skip: needsArchive, timeout: 900_000 }, async () => {
    const cluster = await freshCluster("kill-mid", 1);
    let observer, locker;
    try {
      observer = await superuser(cluster);
      locker = await superuser(cluster);
      // Hold the LAST table the transaction touches, so the child has written its
      // tenant, workspace, identity, grant, adapter, node and key rows (uncommitted)
      // and is blocked inside the transaction when it is killed.
      // The lock is taken when the child is SPAWNED, not before the port runs: the
      // port's own pre-spawn digest check reads the catalog for that table too, and
      // MEASURED, a lock taken earlier blocked the digest's psql instead of the child.
      // The child needs far longer to load Node and connect than the lock takes.
      await locker.query("BEGIN");
      let child, locked;
      const run = firstOwnerViaScriptV1(installerInput(cluster), laneRuntime(cluster, { onSpawn: value => {
        child = value;
        locked = locker.query("LOCK TABLE control_completion_gate_integrity IN ACCESS EXCLUSIVE MODE");
      } }));
      let settled = false;
      run.then(() => { settled = true; }, error => { settled = error; });
      await waitFor(async () => locked !== undefined, 60_000, "the child to be spawned");
      await locked;
      await waitFor(async () => Number((await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity"
        + " WHERE application_name = 'control-room-first-owner' AND wait_event_type = 'Lock'")).rows[0].n) === 1
        || (settled && Promise.reject(new Error(`the port settled first (${settled?.message ?? settled}): ${JSON.stringify((await observer.query(
          "SELECT application_name, usename, state, wait_event_type, left(query, 120) AS query FROM pg_stat_activity"
          + " WHERE backend_type = 'client backend'")).rows)}`))),
      // Generous overall: the port first checks the digest and the child loads, and
      // only then blocks; the release's 2 s lock_timeout runs from the block, and
      // the 20 ms poll sees it well inside that.
      60_000, "the child to block inside its transaction").catch(async error => {
        throw new Error(`${error.message}: ${JSON.stringify((await observer.query("SELECT application_name, usename,"
          + " state, wait_event_type, left(query, 160) AS query FROM pg_stat_activity WHERE backend_type = 'client backend'")).rows)}`);
      });
      child.kill("SIGKILL");
      await assert.rejects(run, /first_owner_script_failed:SIGKILL/u);
      await locker.query("ROLLBACK");
      await waitFor(async () => await childBackends(observer) === 0, 30_000, "the killed child's backend to end");
      const after = await ownerRows(observer);
      assert.deepEqual({ ...after, keys: after.keys.length },
        { tenants: 0, workspaces: 0, identities: 0, grants: 0, adapters: 0, nodes: 0, gate: 0, keys: 0 },
        "nothing of the killed transaction may survive");
      // The retry reuses the once-written state and succeeds.
      assert.deepEqual(await firstOwnerViaScriptV1(installerInput(cluster), laneRuntime(cluster)), EXPECTED_RESULT);
      const rows = await ownerRows(observer);
      assert.deepEqual({ ...rows, keys: rows.keys.length },
        { tenants: 1, workspaces: 1, identities: 1, grants: 1, adapters: 3, nodes: 3, gate: 1, keys: 3 });
    } finally {
      await locker?.query("ROLLBACK").catch(() => undefined);
      await locker?.end().catch(() => undefined);
      await observer?.end().catch(() => undefined);
      await stopCluster(cluster);
    }
  });

test("a first-owner run whose answer is lost after COMMIT is refused, and the retry recognises the done owner",
  { skip: needsArchive, timeout: 900_000 }, async () => {
    const cluster = await freshCluster("lost-answer", 2);
    let observer;
    try {
      observer = await superuser(cluster);
      // The installer never hears the answer (as when it is killed between the
      // child's COMMIT and reading stdout): the port must refuse, not guess.
      const swallow = child => setImmediate(() => { child.stdout.removeAllListeners("data"); child.stdout.resume(); });
      await assert.rejects(firstOwnerViaScriptV1(installerInput(cluster), laneRuntime(cluster, { onSpawn: swallow })),
        /first_owner_result_refused/u);
      const committed = await ownerRows(observer);
      assert.equal(committed.tenants, 1, "the transaction did commit");
      // The retry keeps every row, including the node keys, and answers the same owner.
      assert.deepEqual(await firstOwnerViaScriptV1(installerInput(cluster), laneRuntime(cluster)), EXPECTED_RESULT);
      assert.deepEqual(await ownerRows(observer), committed);
      // A changed review key would sign a different genesis row: refused, not overwritten.
      const statePath = join(cluster.root, "updater-state", "first-owner.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      rmSync(statePath);
      writeFileSync(statePath, `${JSON.stringify({ ...state, reviewKey: Buffer.alloc(32, 9).toString("base64url") })}\n`, { mode: 0o600 });
      await assert.rejects(firstOwnerViaScriptV1(installerInput(cluster), laneRuntime(cluster)),
        /first_owner_script_failed:1:first_owner_row_conflict/u);
      assert.deepEqual(await ownerRows(observer), committed);
    } finally { await observer?.end().catch(() => undefined); await stopCluster(cluster); }
  });

test("the built entry refuses a malformed request with a fixed code and no output",
  { skip: needsArchive, timeout: 600_000 }, async () => {
    await buildRelease();
    const { spawnSync } = await import("node:child_process");
    for (const input of ["", "not json", JSON.stringify({ schema: "control-room.first-owner-request/v1" }),
      JSON.stringify({ schema: "control-room.first-owner-request/v1", database: { host: "db.example", port: 5432,
        name: "control_room", user: "postgres" }, owner: FIRST_OWNER_OWNER_V1, createdAt: "2026-10-01T00:00:00.000Z",
      reviewKey: Buffer.alloc(32, 1).toString("base64url") })]) {
      const result = spawnSync(process.execPath, [ENTRY], { input, env: { LANG: "C" }, timeout: 60_000 });
      assert.equal(result.status, 1, String(result.stderr));
      assert.equal(String(result.stdout), "");
      assert.equal(String(result.stderr), "first-owner failed: first_owner_request_refused\n");
    }
    const usage = spawnSync(process.execPath, [ENTRY, "--manifest", "/x"], { input: "", timeout: 60_000 });
    assert.equal(usage.status, 64);
  });
