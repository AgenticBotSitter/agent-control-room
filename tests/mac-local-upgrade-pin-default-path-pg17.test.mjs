import { publishLocalFixtureV1 } from "./support/publish-local-fixture.mjs";
// Default-path proof for the four Mac ports the default-path audit left
// FAKE-ONLY (audit items 4, 5, 12 and 13). Every assertion runs a production
// function with NOTHING injected for that port:
//
//   item 4  scripts/mac-local/pin-node-keys.mjs `openDatabase`
//           -> the real createPrivatePostgresDatabase opens a real pool as the
//              restricted control_room_coordinator login, over TCP, with SCRAM.
//   item 5  scripts/mac-local/pin-node-keys.mjs `checkPin`
//           -> the real checkMacLocalNodeKeyPinV1 writes, or refuses, the real
//              protected node-keys.json.
//
//   item 12 scripts/mac-local/upgrade.mjs `prepare` / `finish`
//           -> the real prepareMacLocalDatabaseUpgradeV1 and
//              finishMacLocalDatabaseUpgradeV1 run inside runMacUpgradeV1. The
//              code the VPS step needs is read back out of the OWNER-VISIBLE
//              line the command printed, then applied by the real
//              runMacDatabaseUpgradeCommandV1 --apply against the same
//              disposable cluster, exactly as `cr-db-upgrade` would.
//
//   item 13 scripts/mac-local/upgrade.mjs `readLedgerHead`
//           -> the real readMacUpgradeLedgerHeadV1 pairs this build's own ledger
//              head with the live schema digest read through the RESTRICTED
//              control_room_web login.
//
// Only the ports that cannot run unattended are stubbed: `run` (the pnpm
// install/build/mac:up commands), `wait` (a TTY prompt, used here as the point
// where the real VPS step happens) and `write` (stdout). `git` is NOT stubbed:
// the orchestration runs against a real repository with a real local
// `origin/main`.
//
// One shared pin cluster plus one disposable pre-upgrade cluster PER UPGRADE TEST,
// all loopback-only, all started and stopped here. Every port is OS-assigned
// rather than a literal: a literal lane port makes two concurrent runs of this
// lane collide, and the mutation runner invokes the lane many times over, so a
// developer running it by hand at the same time is the normal case rather than an
// edge one. (It happened: the stress case below failed to start because the
// mutation runner's own baseline run held the port.)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { applyPendingMacMigrationsV1, runMacDatabaseUpgradeCommandV1 } from "../scripts/mac-local/database-upgrade-remote.mjs";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { applyMacLocalFirstOwnerV1 } from "../scripts/mac-local/first-owner-vps.mjs";
import { pinMacLocalNodeKeysV1 } from "../scripts/mac-local/pin-node-keys.mjs";
import { captureProvisionedMacLocalConfigurationV1 } from "../scripts/mac-local/provision-database.mjs";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";
import { readMacUpgradeLedgerHeadV1, runMacUpgradeV1 } from "../scripts/mac-local/upgrade.mjs";
import { privateWebSchemaDigest, readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight.ts";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles.ts";
import { MAC_LOCAL_NODE_KEYS_V1 } from "../src/web/v1/mac-local-node-key-pin.ts";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store.ts";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { PG_BIN, findFreePort, needsPg } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const run = promisify(execFile);
// Every cluster's port is OS-assigned, so this lane is safe to run beside itself;
// the mutation runner invokes it repeatedly, and a literal port made two
// concurrent runs collide. See the header note.
const nodeIds = ["mac-1.hermes", "mac-1.claude", "mac-1.codex"];
const workers = [
  { workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" },
  { workerId: "worker:claude:mac-1", kind: "claude-code", executablePath: "/opt/claude", recordedVersion: "claude 1.2.3" },
  { workerId: "worker:hermes:mac-1", kind: "hermes", executablePath: "/opt/hermes", recordedVersion: "hermes 1.2.3" },
];
const state = { clusters: [], roots: [], pinPasswords: {} };
const exec = (file, args) => execFileSync(join(PG_BIN ?? "", file), args, { encoding: "utf8", timeout: 300_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const tcp = (port, user, secret) => `host=127.0.0.1 port=${port} dbname=control_room user=${user} password=${secret}`;
/** What a completed upgrade leaves in the protected runtime directory. The
 * descriptor lease keeps its inode on macOS (`lock.close()`) and is unlinked
 * everywhere else (`lock.release()`), because unlinking a macOS O_EXLOCK file
 * would admit a second owner on a fresh inode. Assert the product's real shape
 * on each platform, or this lane would fail in the ubuntu-latest CI job. */
const lockListing = process.platform === "darwin"
  ? ["upgrade-previous.json", "upgrade.lock"] : ["upgrade-previous.json"];

/** Starts one disposable cluster and arms its teardown BEFORE initdb, so a
 * failure anywhere in the start leaves nothing running. */
async function cluster(root, port) {
  const data = join(root, "pg"), socket = join(root, "s");
  await mkdir(socket, { recursive: true, mode: 0o700 });
  const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: root,
    socketDirectory: socket, port, pgBin: PG_BIN, removeDirectories: false });
  state.clusters.push(teardown);
  exec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  await writeFile(join(data, "pg_hba.conf"),
    "local all postgres trust\nhost all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
  exec("pg_ctl", ["-D", data, "-l", join(root, "pg.log"), "-w", "-t", "60", "-o",
    `-p ${port} -k '${socket}' -c listen_addresses=127.0.0.1`, "start"]);
  await teardown.capturePostmasterPid();
  return socket;
}

async function admin(port, socket) {
  const client = connectTarget(`host=${socket} port=${port} dbname=control_room user=postgres`);
  await client.connect();
  return client;
}

async function applyLedger(port, ledgerPath) {
  exec("psql", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f", join(repoRoot, "deploy/postgres/provision-database.sql")]);
  const migratorPassword = "m".repeat(40);
  await applyMigrations({ rootDir: repoRoot,
    ledgerPath: ledgerPath ?? join(repoRoot, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: tcp(port, "postgres", "unused"),
    migrateTarget: tcp(port, "control_room_migrator", migratorPassword),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: migratorPassword, CONTROL_ROOM_APP_PASSWORD: "a".repeat(40),
      CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(40), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "i".repeat(40) } });
}

const legacyPassword = login => `p${login.replaceAll("_", "")}`.padEnd(40, "x");

before(async () => {
  if (needsPg) return;
  state.pin = { root: await mkdtemp(join(tmpdir(), "acr-pin-default-")), port: await findFreePort() };
  state.roots.push(state.pin.root);
  state.pin.socket = await cluster(state.pin.root, state.pin.port);
  await applyLedger(state.pin.port);
  // The real offline Mac installer: the fixed queue schema, the eight narrow
  // group roles, their exact ACLs, and one LOGIN per Mac role with its password.
  const planned = {
    control_room_web: "p".repeat(40),
    control_room_coordinator: "c".repeat(40),
    control_room_results: "r".repeat(40),
    control_room_publisher: "u".repeat(40),
    control_room_agent_reviewer_login: "v".repeat(40),
    control_room_queue_worker: "q".repeat(40),
    control_room_fleet: "f".repeat(40),
    control_room_fleet_owner: "o".repeat(40),
  };
  state.pinPasswords = planned;
  const mac = await admin(state.pin.port, state.pin.socket);
  try { await provisionMacLocalNarrowRolesV1(mac, planned); } finally { await mac.end(); }
});

after(async () => {
  if (needsPg) return;
  // Every cluster this process started, in reverse start order. `stop()` is the
  // shared ladder: it proves the postmaster is gone and throws if it is not.
  for (const teardown of [...state.clusters].reverse()) {
    try { await teardown.stop(); } catch (error) { console.error(`default_path_teardown_failed: ${error.message}`); }
  }
  state.clusters = [];
  for (const root of state.roots) await rm(root, { recursive: true, force: true });
});

/** A COMPLETE, real protected install on the pin cluster: 0700 root, 0700
 * config, 0600 records, all eight logins. */
async function completedInstall(label) {
  const root = await mkdtemp(join(tmpdir(), `acr-pin-${label}-`));
  state.roots.push(root);
  const config = join(root, "config");
  await mkdir(config, { recursive: true, mode: 0o700 });
  const web = { host: "127.0.0.1", port: state.pin.port, database: "control_room", username: "control_room_web",
    password: state.pinPasswords.control_room_web, majorVersion: 17 };
  const role = username => ({ ...web, username, password: state.pinPasswords[username] });
  const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web, coordinator: role("control_room_coordinator"),
    results: role("control_room_results"), publisher: role("control_room_publisher"),
    agentReviewer: role("control_room_agent_reviewer_login"), queueWorker: role("control_room_queue_worker"),
    fleetGateway: role("control_room_fleet"), fleetOwner: role("control_room_fleet_owner") };
  const mac = captureProvisionedMacLocalConfigurationV1({ database: web, ownerCode: "owner-code",
    workers, workIntakeProjectIds: ["*"] });
  await writeFile(join(config, "mac-local.json"), `${JSON.stringify(mac)}\n`, { mode: 0o600 });
  await writeFile(join(config, "database-roles.json"), `${JSON.stringify(roles)}\n`, { mode: 0o600 });
  return { root, config, roles, web, pinFile: join(config, "node-keys.json") };
}

/** The real VPS first-owner transaction over the real cluster, by the real
 * function. The genesis key is a throwaway constant: the pin ports read the
 * tenant id and the node fingerprints, never the completion-gate tag. */
async function firstOwnerReceipt(label) {
  const install = await completedInstall(label);
  const configuration = JSON.parse(await readFile(join(install.config, "mac-local.json"), "utf8"));
  const manifest = createMacLocalFirstOwnerManifestV1(configuration, "2026-09-30T12:00:00.000Z",
    CompletionGateStoreV1.genesisIntegrityForKeyV1(configuration.localOwnerSession.tenantId, new Uint8Array(32).fill(41)));
  const vps = await admin(state.pin.port, state.pin.socket);
  let receipt;
  try { receipt = await applyMacLocalFirstOwnerV1(vps, manifest); }
  finally { await vps.end(); }
  const receiptPath = join(install.config, "first-owner-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return { ...install, manifest, receipt, receiptPath };
}

test("item 4: the pin command reads three real node keys through the production coordinator login", {
  skip: needsPg,
}, async t => {
  const install = await firstOwnerReceipt("read");
  // Only the two path arguments. No runtime object at all, so `openDatabase` is
  // createPrivatePostgresDatabase and `checkPin` is the real protected writer.
  assert.equal(await pinMacLocalNodeKeysV1(install.root, install.receiptPath), 0);

  const entry = await lstat(install.pinFile);
  assert.equal(entry.isFile(), true, "the pin is a regular file");
  assert.equal(entry.isSymbolicLink(), false);
  assert.equal(entry.mode & 0o777, 0o600, "the pin is readable by its owner only");
  assert.equal(entry.uid, process.getuid?.());
  const text = await readFile(install.pinFile, "utf8");
  const pin = JSON.parse(text);
  assert.equal(pin.schema, MAC_LOCAL_NODE_KEYS_V1);
  assert.deepEqual(Object.keys(pin).sort(), ["fingerprints", "schema"]);
  assert.deepEqual(pin, { schema: MAC_LOCAL_NODE_KEYS_V1,
    fingerprints: { ...install.receipt.fingerprints } });
  assert.deepEqual(Object.keys(pin.fingerprints).sort(), [...nodeIds].sort());
  // No signing key, and no public key material beyond the three fingerprints.
  assert.equal(/PRIVATE KEY|public_key_spki/u.test(text), false);
  assert.equal((await lstat(install.config)).mode & 0o777, 0o700);
  assert.equal((await lstat(install.root)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(install.config)).sort(), ["database-roles.json", "first-owner-receipt.json",
    "mac-local.json", "node-keys.json"], "no staging file is left beside the pin");

  // The login that read the rows really is the restricted one and nothing wider:
  // the ledger table it must not read is refused on the same cluster.
  const coordinator = connectTarget(tcp(state.pin.port, "control_room_coordinator", state.pinPasswords.control_room_coordinator));
  await coordinator.connect();
  try {
    assert.equal((await coordinator.query("SELECT current_user AS role, session_user AS session")).rows[0].role,
      "control_room_coordinator");
    await assert.rejects(coordinator.query("SELECT 1 FROM control_room_schema_migrations LIMIT 1"), /permission denied/u);
  } finally { await coordinator.end(); }
  t.diagnostic(`pinned ${Object.keys(pin.fingerprints).length} fingerprints as the production coordinator login`);
});

test("item 4 hostile: a coordinator login this database does not accept is refused before any pin exists", {
  skip: needsPg,
}, async () => {
  // A wrong password is the real failure a faked openDatabase hides: the pool
  // cannot authenticate, so the command must refuse rather than pin.
  const wrong = await firstOwnerReceipt("refuse-password");
  const rolesPath = join(wrong.config, "database-roles.json");
  const wrongRoles = JSON.parse(await readFile(rolesPath, "utf8"));
  await writeFile(rolesPath, `${JSON.stringify({ ...wrongRoles,
    coordinator: { ...wrongRoles.coordinator, password: "n".repeat(40) } })}\n`, { mode: 0o600 });
  await assert.rejects(pinMacLocalNodeKeysV1(wrong.root, wrong.receiptPath), /database_unavailable/u);
  await assert.rejects(lstat(wrong.pinFile), { code: "ENOENT" },
    "a refused pin writes no node-keys.json at all");

  // A record that names one login for two roles is refused by the loader, so
  // the command never opens a connection under an identity the file doubled up.
  const doubled = await firstOwnerReceipt("refuse-reused");
  const doubledPath = join(doubled.config, "database-roles.json");
  const doubledRoles = JSON.parse(await readFile(doubledPath, "utf8"));
  await writeFile(doubledPath, `${JSON.stringify({ ...doubledRoles,
    coordinator: { ...doubledRoles.coordinator, username: doubledRoles.web.username } })}\n`, { mode: 0o600 });
  await assert.rejects(pinMacLocalNodeKeysV1(doubled.root, doubled.receiptPath), /mac_local_database_roles_invalid/u);
  await assert.rejects(lstat(doubled.pinFile), { code: "ENOENT" });
});

test("item 5: the real protected writer refuses a symlinked pin path and leaves its target untouched", {
  skip: needsPg,
}, async () => {
  const install = await firstOwnerReceipt("symlink");
  const decoy = join(install.config, "elsewhere.json");
  await writeFile(decoy, `${JSON.stringify({ schema: MAC_LOCAL_NODE_KEYS_V1,
    fingerprints: install.receipt.fingerprints })}\n`, { mode: 0o600 });
  await symlink(decoy, install.pinFile);
  await assert.rejects(pinMacLocalNodeKeysV1(install.root, install.receiptPath), /mac_local_node_key_pin_mismatch/u);
  const link = await lstat(install.pinFile);
  assert.equal(link.isSymbolicLink(), true, "the pin path is still the link the owner put there");
  assert.equal(JSON.parse(await readFile(decoy, "utf8")).schema, MAC_LOCAL_NODE_KEYS_V1,
    "the link target is the owner's own file and was neither adopted nor rewritten");

  // A pin file that is a regular, correctly-moded file but names the WRONG
  // fingerprints must be refused rather than adopted. Without this, a decoy any
  // local process could have written becomes this Mac's own node identity, and
  // the symlink case above is caught by `isFile()` alone rather than by the
  // comparison that actually decides whether a pin is this Mac's.
  await rm(install.pinFile, { recursive: true, force: true });
  const stranger = { schema: MAC_LOCAL_NODE_KEYS_V1, fingerprints: Object.fromEntries(
    nodeIds.map(id => [id, `sha256:${"9".repeat(64)}`])) };
  await writeFile(install.pinFile, `${JSON.stringify(stranger)}\n`, { mode: 0o600 });
  await assert.rejects(pinMacLocalNodeKeysV1(install.root, install.receiptPath), /mac_local_node_key_pin_mismatch/u,
    "a pin file naming a stranger's fingerprints is refused");
  assert.deepEqual(JSON.parse(await readFile(install.pinFile, "utf8")), stranger,
    "and the refused file is left exactly as it was found");

  // A directory in the pin's place is refused, and the refusal writes nothing.
  await rm(install.pinFile, { force: true });
  await mkdir(install.pinFile, { mode: 0o700 });
  await assert.rejects(pinMacLocalNodeKeysV1(install.root, install.receiptPath), /mac_local_node_key_pin_mismatch/u);
  assert.equal((await lstat(install.pinFile)).isDirectory(), true);

  // A world-readable file is refused and is NOT tightened to 0600: a refusal
  // must not rewrite the file it refused.
  await rm(install.pinFile, { recursive: true, force: true });
  const body = `${JSON.stringify({ schema: MAC_LOCAL_NODE_KEYS_V1, fingerprints: install.receipt.fingerprints })}\n`;
  await writeFile(install.pinFile, body);
  await chmod(install.pinFile, 0o644);
  await assert.rejects(pinMacLocalNodeKeysV1(install.root, install.receiptPath), /mac_local_node_key_pin_mismatch/u);
  assert.equal((await lstat(install.pinFile)).mode & 0o777, 0o644, "a refused pin leaves the mode it found");
});

test("item 5: pinning twice is idempotent, and twenty concurrent callers converge on one exact file", {
  skip: needsPg,
}, async () => {
  const install = await firstOwnerReceipt("converge");
  assert.equal(await pinMacLocalNodeKeysV1(install.root, install.receiptPath), 0);
  const first = await lstat(install.pinFile), bytes = await readFile(install.pinFile, "utf8");
  assert.equal(await pinMacLocalNodeKeysV1(install.root, install.receiptPath), 0, "a second pin is a clean no-op");
  const second = await lstat(install.pinFile);
  assert.equal(second.ino, first.ino, "the second pin validates the existing file and does not replace it");
  assert.equal(await readFile(install.pinFile, "utf8"), bytes);
  assert.equal(second.mode & 0o777, 0o600);

  const racing = await firstOwnerReceipt("race");
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => pinMacLocalNodeKeysV1(racing.root, racing.receiptPath)));
  const refused = results.filter(result => result.status === "rejected").map(result => result.reason?.message);
  assert.deepEqual(refused, [], `every concurrent caller must converge, refused: ${JSON.stringify(refused)}`);
  const entry = await lstat(racing.pinFile);
  assert.equal(entry.isFile(), true);
  assert.equal(entry.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(racing.pinFile, "utf8")),
    { schema: MAC_LOCAL_NODE_KEYS_V1, fingerprints: { ...racing.receipt.fingerprints } });
  assert.deepEqual((await readdir(racing.config)).sort(), ["database-roles.json", "first-owner-receipt.json",
    "mac-local.json", "node-keys.json"], "twenty racing writers leave no staging file");
});

/**
 * The same convergence under the shape that actually happens on the Mac: SEPARATE
 * OS PROCESSES, because in-process `Promise.all` shares one event loop and cannot
 * interleave the way two `mac:pin-node-keys` invocations do. Each child is the
 * production CLI, with no argument but the two paths, spawned in its own process
 * group, and every one of them is waited for in a `finally` so a failure part-way
 * through cannot leave a child running.
 *
 * 50 children against one cluster is well past the point where a non-atomic writer
 * would show a half-written file, so this is where a partial write would show up.
 */
test("item 5 stress: fifty separate pin processes converge on one exact 0600 file", {
  skip: needsPg,
}, async t => {
  const install = await firstOwnerReceipt("process-race");
  const children = [];
  try {
    const attempts = Array.from({ length: 50 }, () => new Promise(resolve => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/mac-local/pin-node-keys.mjs",
        install.root, install.receiptPath], { cwd: repoRoot, env: { ...process.env, TMPDIR: process.env.TMPDIR },
        detached: true, stdio: ["ignore", "ignore", "pipe"] });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", part => { stderr += String(part); });
      child.once("error", error => resolve({ status: -1, stderr: error.message }));
      child.once("close", status => resolve({ status, stderr }));
    }));
    const results = await Promise.all(attempts);
    const failed = results.filter(result => result.status !== 0);
    assert.deepEqual(failed, [], `every process must converge, failed: ${JSON.stringify(failed.slice(0, 3))}`);
  } finally {
    // Kill only pids this test spawned, and only ones still running.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      }
    }
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("close", () => resolve());
      setTimeout(resolve, 5000);
    })));
  }
  const entry = await lstat(install.pinFile);
  assert.equal(entry.isFile(), true);
  assert.equal(entry.isSymbolicLink(), false);
  assert.equal(entry.mode & 0o777, 0o600, "fifty racing processes leave one owner-only file");
  assert.deepEqual(JSON.parse(await readFile(install.pinFile, "utf8")),
    { schema: MAC_LOCAL_NODE_KEYS_V1, fingerprints: { ...install.receipt.fingerprints } });
  assert.deepEqual((await readdir(install.config)).sort(), ["database-roles.json", "first-owner-receipt.json",
    "mac-local.json", "node-keys.json"], "no staging file survives fifty racing processes");
});

/** A disposable cluster in the shape a real Mac install had before the five new
 * logins existed: the ledger stops at 0090, the work-intake group and login do
 * not exist, and the four Mac logins hold the broad application role. That is
 * what makes the real `--prepare`/`--finish` do real work.
 *
 * One cluster PER TEST, not one for the lane. The ledger head this lane asserts
 * is this build's head paired with that cluster's live digest, and the whole
 * point of item 13 is that the digest MOVES when the VPS step migrates — so a
 * shared cluster would let one test's migration decide another test's expected
 * value. The port is OS-assigned, so several can exist at once. */
async function preUpgradeCluster(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-upgrade-cluster-"));
  // No t.after removal here: the data directory must outlive the postmaster, and
  // the postmaster is stopped by this lane's own `after` hook. Removing the
  // directory from a per-test hook ran first, and pg_ctl then reported a missing
  // data directory on every cluster. Both orders are the lane's, never
  // concurrent with a live postmaster.
  state.roots.push(root);
  const port = await findFreePort();
  const socket = await cluster(root, port);
  const older = JSON.parse(await readFile(join(repoRoot, "deploy/postgres/migration-ledger.json"), "utf8"));
  older.entries = older.entries.filter(entry => entry.kind !== undefined && entry.kind !== "migrate"
    || entry.file < "db/migrations/0091");
  const ledgerPath = join(root, "ledger-0090.json");
  await writeFile(ledgerPath, JSON.stringify(older));
  await applyLedger(port, ledgerPath);
  const old = await admin(port, socket);
  try {
    await old.query(`DROP OWNED BY control_room_work_intake_agent, control_room_work_intake;
      DROP ROLE control_room_work_intake_agent; DROP ROLE control_room_work_intake`);
    for (const login of ["control_room_web", "control_room_coordinator", "control_room_results", "control_room_queue_worker"]) {
      await old.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD ${old.escapeLiteral(legacyPassword(login))}`);
      await old.query(`GRANT control_room_application TO ${login}`);
    }
  } finally { await old.end(); }
  return { port, socket, root };
}

/** A real repository with a real local origin/main, so the orchestration's real
 * Git port runs: fetch, fast-forward and both clean-main checks. */
async function realRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-upgrade-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git"), seed = join(root, "seed"), checkout = join(root, "checkout");
  const git = async (cwd, args) => (await run("git", args, { cwd, encoding: "utf8" })).stdout.trim();
  await mkdir(seed);
  await git(root, ["init", "--bare", origin]);
  await git(seed, ["init"]);
  await git(seed, ["config", "user.name", "Default Path Fixture"]);
  await git(seed, ["config", "user.email", "default-path@example.invalid"]);
  await git(seed, ["remote", "add", "origin", origin]);
  await writeFile(join(seed, "tracked.txt"), "before\n");
  await git(seed, ["add", "tracked.txt"]);
  await git(seed, ["commit", "-m", "before"]);
  await git(seed, ["branch", "-M", "main"]);
  await publishLocalFixtureV1(seed);
  const first = await git(seed, ["rev-parse", "HEAD"]);
  await git(root, ["clone", "--branch", "main", origin, checkout]);
  await writeFile(join(seed, "tracked.txt"), "after\n");
  await git(seed, ["commit", "-am", "after"]);
  await publishLocalFixtureV1(seed);
  const second = await git(seed, ["rev-parse", "HEAD"]);
  // The identity both commands check: HEAD and refs/remotes/origin/main are the
  // same commit, and the checkout is clean. Read from the real repository,
  // never from a fixed string. Synchronous, because the VPS command's `git` port
  // is called bare and its result is compared to a commit: an async answer made
  // it refuse with `upgrade_input_refused`.
  const sync = args => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  const port = { head: () => sync(["rev-parse", "HEAD"]),
    originMain: () => sync(["rev-parse", "refs/remotes/origin/main"]),
    porcelain: () => sync(["status", "--porcelain"]) };
  return { root, checkout, first, second, port };
}

const repositoryGit = port => params => {
  if (params[0] === "status") return port.porcelain();
  if (params[1] === "HEAD") return port.head();
  if (params[1] === "refs/remotes/origin/main") return port.originMain();
  return port.head();
};

/** A pre-upgrade protected root on the upgrade cluster: the four
 * always-present Mac logins only, with their protected password files, exactly
 * as an install from before the five new logins existed. This is the record the
 * ledger-head read has to cope with, and it is why that read needed a fix. */
async function upgradeFixture(label, target) {
  const root = await mkdtemp(join(tmpdir(), `acr-upgrade-${label}-`));
  state.roots.push(root);
  const config = join(root, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const base = { host: "127.0.0.1", port: target.port, database: "control_room", majorVersion: 17 };
  const role = username => ({ ...base, username, password: legacyPassword(username) });
  for (const username of ["control_room_web", "control_room_coordinator", "control_room_results",
    "control_room_queue_worker"])
    await writeFile(join(passwords, `${username}.txt`), `${legacyPassword(username)}\n`, { mode: 0o600 });
  const web = role("control_room_web");
  const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web, coordinator: role("control_room_coordinator"),
    results: role("control_room_results"), queueWorker: role("control_room_queue_worker") };
  const mac = captureProvisionedMacLocalConfigurationV1({ database: web, ownerCode: "owner-code", workers: [workers[0]] });
  await writeFile(join(config, "mac-local.json"), `${JSON.stringify(mac)}\n`, { mode: 0o600 });
  await writeFile(join(config, "database-roles.json"), `${JSON.stringify(roles)}\n`, { mode: 0o600 });
  return { root, config, roles, roleFile: join(config, "database-roles.json") };
}

/** The live structural digest, read by the cluster operator over the peer
 * socket, for comparison with what the restricted web login reads for itself. */
async function operatorSchemaDigest(target) {
  const client = await admin(target.port, target.socket);
  try { return await readPrivateWebSchemaDigest(client); }
  finally { await client.end(); }
}

async function currentLedgerFile() {
  const ledger = JSON.parse(await readFile(join(repoRoot, "deploy/postgres/migration-ledger.json"), "utf8"));
  const last = ledger.entries.filter(entry => (entry.kind ?? "migrate") === "migrate").at(-1);
  return { file: last.file, order: last.order };
}

/** The real VPS step, run from inside the attended wait exactly as
 * `cr-db-upgrade <short-commit>` would: plan, then apply with the code the Mac
 * printed, as the peer postgres login, with no injected client and no injected
 * migration step. */
async function realVpsStep(port, lines, target) {
  const printed = lines.find(line => line.startsWith("VPS login code"));
  assert.ok(printed, "the Mac command must print the code the VPS step needs");
  const code = printed.slice(printed.indexOf(":") + 1).trim();
  const operator = `host=${target.socket} port=${target.port} dbname=control_room user=postgres`;
  const identity = port.head();
  const { digest } = await runMacDatabaseUpgradeCommandV1({ args: ["--plan", "--expected-main", identity],
    git: repositoryGit(port), openClient: () => connectTarget(operator) });
  // The real migration runner, pointed at THIS disposable cluster. Its own
  // default is the production `/var/run/postgresql` socket, which this lane must
  // never open, so the target is supplied and the function is not replaced.
  const applied = await runMacDatabaseUpgradeCommandV1({
    args: ["--apply", "--expected-main", identity, "--expected-plan-digest", digest],
    readVerifier: async () => `${code}\n`, git: repositoryGit(port), openClient: () => connectTarget(operator),
    applyPending: () => applyPendingMacMigrationsV1(operator) });
  assert.equal(applied.upgraded, true, "the VPS step really migrated this cluster");
  return code;
}

test("item 12: the real prepare and finish ports run inside the upgrade orchestration", { skip: needsPg }, async t => {
  const repository = await realRepository(t);
  const target = await preUpgradeCluster(t);
  const install = await upgradeFixture("prepare-finish", target);
  const calls = [], lines = [];
  const digestBefore = await operatorSchemaDigest(target);
  const result = await runMacUpgradeV1({ protectedRoot: install.root, repositoryRoot: repository.checkout,
    run: async args => { calls.push(args); return 0; },
    wait: async () => { await realVpsStep(repository.port, lines, target); },
    write: line => lines.push(line) });

  assert.equal(result.upgraded, true);
  assert.equal(result.previousCommit, repository.first, "the recovery record names the commit that was on main");
  assert.equal(result.targetCommit, repository.second);
  assert.deepEqual(calls, [
    ["mac:down", "--", "--protected-root", install.root], ["install", "--frozen-lockfile"], ["build"],
    ["mac:up", "--", "--protected-root", install.root], ["mac:status", "--", "--protected-root", install.root],
  ], "the real prepare/finish did not change the owner-visible command order");

  // The one handoff covered every login the role manifest still marked as
  // missing, and the real finish authenticated each one over TCP before it
  // wrote that login's own protected record.
  const printed = lines.find(line => line.startsWith("VPS login code"));
  assert.deepEqual(Object.keys(JSON.parse(printed.slice(printed.indexOf(":") + 1).trim())).sort(),
    ["control_room_agent_reviewer_login", "control_room_fleet", "control_room_fleet_owner",
      "control_room_publisher", "control_room_work_intake_agent"]);
  const finished = JSON.parse(await readFile(install.roleFile, "utf8"));
  for (const [key, username] of Object.entries({ publisher: "control_room_publisher",
    agentReviewer: "control_room_agent_reviewer_login", fleetGateway: "control_room_fleet",
    fleetOwner: "control_room_fleet_owner" })) {
    assert.equal(finished[key]?.username, username, key);
    const secret = (await readFile(join(install.config, "database-passwords", `${username}.txt`), "utf8")).trim();
    assert.equal(finished[key].password, secret, `${key} authenticates with the password its own file holds`);
    const session = connectTarget(tcp(target.port, username, secret));
    await session.connect();
    try { assert.equal((await session.query("SELECT current_user AS role")).rows[0].role, username); }
    finally { await session.end(); }
  }
  const intake = JSON.parse(await readFile(join(install.config, "work-intake-server.json"), "utf8"));
  assert.equal(intake.database.username, "control_room_work_intake_agent");
  const intakeSession = connectTarget(tcp(target.port, "control_room_work_intake_agent", intake.database.password));
  await intakeSession.connect();
  try { assert.equal((await intakeSession.query("SELECT current_user AS role")).rows[0].role,
    "control_room_work_intake_agent"); }
  finally { await intakeSession.end(); }
  assert.equal((await lstat(join(install.config, "database-passwords"))).mode & 0o777, 0o700);
  assert.equal((await lstat(install.roleFile)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(install.config, "work-intake-server.json"))).mode & 0o777, 0o600);

  // Item 13's default path, observed from inside the same run: this build's own
  // ledger head paired with the live digest the RESTRICTED web login read.
  const head = await currentLedgerFile();
  assert.deepEqual(result.ledgerHead, { ...head, digest: `sha256:${digestBefore}` },
    "the head read through control_room_web is this build's ledger head and the pre-migration digest");
  // The digest MOVES across the VPS step, and both ends are observed by the
  // restricted web login. That movement is exactly what the recovery record
  // exists to detect: a rollback after the migration compares this head against
  // the record's and refuses, instead of reverting code against a moved schema.
  const headAfter = await readMacUpgradeLedgerHeadV1(install.root);
  assert.equal(headAfter.file, head.file, "the build's own ledger head never moves without a new commit");
  assert.equal(headAfter.order, head.order);
  assert.notEqual(headAfter.digest, result.ledgerHead.digest,
    "the live schema digest the web login reads is different after the VPS step migrated");
  assert.equal(headAfter.digest, `sha256:${await operatorSchemaDigest(target)}`,
    "and the post-migration digest the web login reads is the one the operator sees");
  assert.equal(headAfter.digest, `sha256:${privateWebSchemaDigest}`,
    "after the real VPS migration the live schema digest is the reviewed one, read by the restricted web login");
});

test("item 12: a finished install is a clean no-op, and the recovery record is private and re-readable", {
  skip: needsPg,
}, async t => {
  const repository = await realRepository(t);
  const target = await preUpgradeCluster(t);
  const install = await upgradeFixture("repeat", target);
  const digestBefore = await operatorSchemaDigest(target);
  // Bring the cluster and the install to the finished state through the same
  // real handoff, so this second run is a genuine repeat.
  const lines = [];
  await runMacUpgradeV1({ protectedRoot: install.root, repositoryRoot: repository.checkout,
    run: async () => 0, wait: async () => { await realVpsStep(repository.port, lines, target); },
    write: line => lines.push(line) });
  assert.equal(JSON.parse(await readFile(install.roleFile, "utf8")).publisher.username, "control_room_publisher");

  const digestNow = await operatorSchemaDigest(target);
  const repeatLines = [];
  let reachedWait = 0;
  // The attended wait is reached on EVERY run -- it is the prompt where the
  // owner runs the VPS command, and it is reached whether or not a login code
  // was needed. What must differ on a repeat is the CODE, not the prompt.
  const second = await runMacUpgradeV1({ protectedRoot: install.root, repositoryRoot: repository.checkout,
    run: async () => 0, wait: async () => { reachedWait += 1; }, write: line => repeatLines.push(line) });
  assert.equal(reachedWait, 1, "the owner is still asked to confirm the VPS step on a repeat");
  assert.equal(second.upgraded, true, "a finished install needs no new login code at all");
  assert.equal(repeatLines.some(line => line.startsWith("VPS login code")), false,
    "a repeat prints no login code, so no secret can reach the terminal a second time");
  assert.match(repeatLines.join("\n"), /Now run this on the VPS/u);

  const record = JSON.parse(await readFile(join(install.root, "runtime", "upgrade-previous.json"), "utf8"));
  assert.equal(record.schema, "control-room.mac-upgrade-recovery/v1");
  // The repeat's checkout is already AT origin/main, so the fast-forward moved
  // nothing. What the repeat still must preserve is the RECOVERY IDENTITY: the
  // commit that was on main before the FIRST upgrade, not the commit this repeat
  // happened to start from. If a repeat overwrote previousCommit with the
  // already-upgraded commit, the owner's rollback would have nowhere to go --
  // the way back is published once, before the checkout ever moves, and every
  // later run resumes it (R4B-03).
  assert.equal(record.previousCommit, repository.first,
    "a repeat of a completed transaction keeps the commit from before the first upgrade");
  assert.equal(record.targetCommit, repository.second);
  assert.equal(second.previousCommit, repository.first,
    "and the returned recovery identity names the same earlier commit");
  assert.equal(second.targetCommit, repository.second);
  // The phase is part of the record's shape, not an optional extra: a finished
  // repeat is durably `upgraded`, which is what lets the NEXT run tell a
  // resumable transaction from one the owner already completed.
  assert.deepEqual(Object.keys(record).sort(), ["ledgerHead", "phase", "previousCommit", "schema", "targetCommit"]);
  const head = await currentLedgerFile();
  assert.equal(record.ledgerHead.file, head.file);
  assert.equal(record.ledgerHead.order, head.order);
  // For the same reason the PRE-upgrade digest is kept: the VPS step already
  // moved the schema, so a rollback after this run must compare the live digest
  // against the pre-upgrade one and refuse rather than revert code against a
  // moved schema. A record carrying the post-migration digest here would make
  // that guard vacuous.
  assert.notEqual(record.ledgerHead.digest, `sha256:${digestNow}`,
    "a repeat keeps the PRE-upgrade digest, so rollback still refuses after a migration");
  assert.equal(record.ledgerHead.digest, `sha256:${digestBefore}`,
    "and that retained digest is the one the live web login read before the first upgrade");
  assert.equal((await lstat(join(install.root, "runtime", "upgrade-previous.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(install.root, "runtime"))).mode & 0o777, 0o700);
  // The descriptor lease keeps its inode on macOS and is unlinked elsewhere, so
  // the listing is platform-shaped -- exactly what the product does.
  assert.deepEqual((await readdir(join(install.root, "runtime"))).sort(), lockListing,
    "no staging file survives a complete run");
});

test("item 13: the ledger head is read on the pre-upgrade record a real Mac actually has", {
  skip: needsPg,
}, async t => {
  // This is the regression test for the bug this lane found. The protected
  // record above has FOUR logins -- the shape of every install that has not
  // yet run `--finish`, which is every install `mac:upgrade` exists for. The
  // full six-role loader refuses that record, so the ledger-head read used to
  // die with `mac_local_database_roles_root_invalid`, which the CLI collapsed
  // to an opaque `upgrade_failed`. It now reads, and this is the assertion that
  // fails if the narrower reader is ever removed.
  const target = await preUpgradeCluster(t);
  const install = await upgradeFixture("pre-upgrade-ledger-head", target);
  const digestNow = await operatorSchemaDigest(target);
  const head = await readMacUpgradeLedgerHeadV1(install.root);
  assert.deepEqual(head, { ...(await currentLedgerFile()), digest: `sha256:${digestNow}` });
  assert.match(head.digest, /^sha256:[a-f0-9]{64}$/u);

  // The narrower reader is not a laxer one. Every protected-file check still
  // applies, and a link, a readable-by-others file or a malformed record is
  // still refused -- with a refusal the CLI can name.
  const roleFile = install.roleFile;
  const good = JSON.parse(await readFile(roleFile, "utf8"));
  const replace = async value => writeFile(roleFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  for (const [label, mutate] of [
    ["a web login the validator refuses", roles => ({ ...roles, web: { ...roles.web, database: "other_database" } })],
    ["a username the validator refuses", roles => ({ ...roles, web: { ...roles.web, username: "NOT a login" } })],
    ["a record naming no web login at all", roles => ({ ...roles, web: undefined })],
    ["a record of the wrong schema", roles => ({ ...roles, schema: "control-room.something-else/v1" })],
    ["a record whose web login is a JSON array", roles => ({ ...roles, web: [] })],
  ]) {
    await replace(mutate(good));
    await assert.rejects(readMacUpgradeLedgerHeadV1(install.root), /upgrade_ledger_head_refused/u,
      `${label} must be refused`);
  }
  const elsewhere = join(install.config, "roles-target.json");
  await writeFile(elsewhere, `${JSON.stringify(good)}\n`, { mode: 0o600 });
  await replace(good);
  await rm(roleFile);
  await symlink(elsewhere, roleFile);
  await assert.rejects(readMacUpgradeLedgerHeadV1(install.root), /upgrade_ledger_head_refused/u,
    "a symlinked role record is refused, never followed");
  await rm(roleFile);
  await writeFile(roleFile, `${JSON.stringify(good)}\n`, { mode: 0o600 });
  await chmod(roleFile, 0o644);
  await assert.rejects(readMacUpgradeLedgerHeadV1(install.root), /upgrade_ledger_head_refused/u,
    "a world-readable role record is refused");
  await chmod(roleFile, 0o600);
  assert.deepEqual(await readMacUpgradeLedgerHeadV1(install.root), head,
    "and the same command succeeds again once the record is protected again");
});

test("item 13 hostile: an unverifiable schema blocks the upgrade before the host is stopped", {
  skip: needsPg,
}, async t => {
  const repository = await realRepository(t);
  const target = await preUpgradeCluster(t);
  const install = await upgradeFixture("digest-refused", target);
  const roleFile = install.roleFile;
  const good = JSON.parse(await readFile(roleFile, "utf8"));
  // The web login in the protected record is one this cluster does not accept.
  // The digest read must refuse, and it must refuse before mac:down.
  await writeFile(roleFile, `${JSON.stringify({ ...good, web: { ...good.web, password: "n".repeat(40) } })}\n`,
    { mode: 0o600 });
  const calls = [], lines = [];
  await assert.rejects(runMacUpgradeV1({ protectedRoot: install.root, repositoryRoot: repository.checkout,
    run: async args => { calls.push(args); return 0; }, wait: async () => { throw new Error("must not be reached"); },
    write: line => lines.push(line) }), /upgrade_ledger_head_refused/u);
  assert.deepEqual(calls, [], "nothing is stopped before the ledger head is read");
  assert.deepEqual(lines, [], "and nothing is printed, so the owner is never told to wait for a VPS step");
  await assert.rejects(lstat(join(install.root, "runtime", "upgrade-previous.json")), { code: "ENOENT" },
    "no recovery record is written for a run that never read a ledger head");
  await assert.rejects(readMacUpgradeLedgerHeadV1(install.root), /upgrade_ledger_head_refused/u);
  // The refused run fast-forwarded the checkout but wrote no protected state,
  // so the same command over the corrected record simply proceeds.
  await writeFile(roleFile, `${JSON.stringify(good)}\n`, { mode: 0o600 });
  assert.deepEqual(await readMacUpgradeLedgerHeadV1(install.root), { ...(await currentLedgerFile()),
    digest: `sha256:${await operatorSchemaDigest(target)}` });
});
