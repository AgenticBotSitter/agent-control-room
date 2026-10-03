import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { execGuardV1, guardScratchV1 } from "./support/updater-guard.mjs";
import { GUARD_DATABASE_ACCOUNT_V1, guardStatStandInV1 } from
  "../src/updater/v1/rehearsal/guard-ownership-fixture.mjs";
import { recoverPairLinksV1 } from "../src/updater/v1/release-layout.mjs";
import { startUpdaterV1 } from "../src/updater/v1/updater.mjs";

const macTest = (name, fn) => test(name, { timeout: 240_000, skip: process.platform === "darwin" ? false
  : "Mac rescue guard requires launchd, plutil and BSD lockf" }, fn);
const exec = execGuardV1, guard = join(process.cwd(), "src/updater/v1/guard/guard.sh");

/** R12 custody seam: only the process identity the VAPID check reads is
 * injected, so this test still runs the DEFAULT alert sender construction. */
const ROOT_VAPID = Object.freeze({ schema: "control-room.updater-vapid/v1", subject: "mailto:owner@example.invalid",
  publicKey: "A".repeat(88), privateKey: "b".repeat(48) });
async function rootHeldVapid(root) {
  const key = join(root, "updater-state/vapid.json");
  await writeFile(key, `${JSON.stringify(ROOT_VAPID)}\n`, { mode: 0o600 });
  const { lstat } = await import("node:fs/promises");
  return { getuid: () => 0, lstat: async path => Object.assign(await lstat(path), { uid: 0 }) };
}
const digest = suffix => `sha256:${String(suffix).padStart(64, "0")}`;

async function executable(path, body) { await rm(path, { force: true }); await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o500); }

async function guardRootV1(t, suffix = "one") {
  const root = await guardScratchV1(t, suffix), bin = join(root, "fake-bin"), log = join(root, "launchctl.log");
  for (const path of ["updater-state", "updater", "runtime", "releases/r0", "releases/r1", "releases/r2",
    "pg/data-p0", "pg/data-p1", "pg/data-p2", "pg/socket", "fake-bin"]) await mkdir(join(root, path), { recursive: true });
  await executable(join(bin, "uname"), "echo Darwin");
  await executable(join(bin, "lockf"), 'exec /usr/bin/lockf "$@"');
  await executable(join(bin, "launchctl"), 'printf "%s\\n" "$*" >> "$CONTROL_ROOM_GUARD_ROOT/launchctl.log"; echo "state = running"; echo "pid = 123"');
  // The OWNERSHIP THE PRODUCT WRITES, not a constant that makes this guard's own
  // expectation true. `pg/` is the arm that matters: it belongs to the DATABASE
  // ACCOUNT (`chownOwnershipV1`), so a stand-in that answered 0 for it asserted
  // the opposite of production and the guard could not be caught being wrong.
  await executable(join(bin, "stat"), guardStatStandInV1());
  await executable(join(bin, "id"), "echo 123");
  await executable(join(bin, "clock"), 'echo "${GUARD_BOOT:-test-boot} ${GUARD_ELAPSED:-20000}"');
  await mkdir(join(root, "fake-plists"));
  await writeFile(join(root, `fake-plists/xyz.agentcontrolroom.rehearsal.test.postgres.plist`),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>UserName</key><string>${GUARD_DATABASE_ACCOUNT_V1}</string></dict></plist>`);
  for (const id of [0, 1, 2]) {
    await writeFile(join(root, `releases/r${id}/RELEASE_MANIFEST.json`), '{"schema":"control-room.attended-build-manifest/v1"}');
    await writeFile(join(root, `releases/r${id}/package.json`), '{}');
    for (const dir of ["scripts/mac-local", "dist-vps/server"]) await mkdir(join(root, `releases/r${id}/${dir}`), { recursive: true });
    for (const file of ["scripts/mac-local/task-host-supervisor.mjs", "dist-vps/server/fleetGateway.js", "dist-vps/server/nightlyBackup.js"])
      await writeFile(join(root, `releases/r${id}/${file}`), 'fixture');
    for (const dir of ["base", "global", "pg_wal", "pg_wal/archive_status"]) await mkdir(join(root, `pg/data-p${id}/${dir}`), { recursive: true });
    for (const file of ["PG_VERSION", "global/pg_control", "pg_hba.conf", "pg_ident.conf", "postgresql.conf"])
      await writeFile(join(root, `pg/data-p${id}/${file}`), 'fixture');
  }
  await writeFile(join(root, "updater-state/guard-heartbeat-observed"), 'test-boot 19800 0\n');
  await executable(join(bin, "date"), "case \"$1\" in -u) echo 2026-09-30T12:00:00Z ;; *) echo 20000 ;; esac");
  await executable(join(bin, "sleep"), "exit 0");
  await executable(join(bin, "pg_controldata"), "echo 'Database cluster state: shut down'");
  await symlink("releases/r2", join(root, "current")); await symlink("data-p2", join(root, "pg/current"));
  const runtime = [["updater/current", "u2", "u1"], ["runtime/node-current", "node-2", "node-1"],
    ["runtime/pnpm-current", "pnpm-2", "pnpm-1"], ["runtime/pg-current", "pg-2", "pg-1"],
    ["runtime/esbuild-current", "esbuild-2", "esbuild-1"]];
  for (const [path, current] of runtime) await symlink(current, join(root, path));
  await writeFile(join(root, "updater-state/heartbeat"), "stale");
  await writeFile(join(root, "updater-state/known-good"), JSON.stringify({ schema: "control-room.known-good/v1", count: 3,
    pairs: [{ releaseId: "r0", pgDataId: "p0", schemaDigest: digest(0) },
      { releaseId: "r1", pgDataId: "p1", schemaDigest: digest(1) },
      { releaseId: "r2", pgDataId: "p2", schemaDigest: digest(2) }] }));
  await writeFile(join(root, "updater-state/selfupgrade.json"), JSON.stringify({
    schema: "control-room.selfupgrade/v1", phase: "done", linkCount: 5,
    links: runtime.map(([path, _current, previous]) => ({ link: path, from: previous, to: _current })) }));
  return { root, bin, log, runtime };
}

async function runGuardV1(fixture, verb = "rescue", root = fixture.root, timeoutMs = 30_000, extra = {}) {
  return exec("/bin/sh", ["-p", guard, verb], { timeout: timeoutMs, env: { CONTROL_ROOM_GUARD_TESTING: "1",
    CONTROL_ROOM_GUARD_ROOT: root, CONTROL_ROOM_GUARD_TEST_BIN: fixture.bin, CONTROL_ROOM_GUARD_TEST_PATH: fixture.bin,
    CONTROL_ROOM_GUARD_ASSUME_YES: "1", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1",
    CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX: "xyz.agentcontrolroom.rehearsal.test", ...extra } });
}

test("the test-only guard root rejects traversal before running a fake command", async t => {
  const fixture = await guardRootV1(t);
  const traversed = `${fixture.root}/../${basename(fixture.root)}`;
  await assert.rejects(runGuardV1(fixture, "rescue", traversed), error => error.code === 70);
  await assert.rejects(readFile(fixture.log), /ENOENT/u);
});

async function declineGuardV1(fixture) {
  return exec("/bin/sh", ["-c", "printf 'NO\\n' | /bin/sh -p \"$1\" rescue", "guard-test", guard], {
    env: { CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: fixture.root,
      CONTROL_ROOM_GUARD_TEST_BIN: fixture.bin, CONTROL_ROOM_GUARD_TEST_PATH: fixture.bin, CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX: "xyz.agentcontrolroom.rehearsal.test" },
  });
}

macTest("pair-aware rescue moves code and DB together, reverts all updater/runtime links, and leaves rescued.json", async t => {
  const fixture = await guardRootV1(t);
  await writeFile(join(fixture.root, "updater-state/selfupgrade-attempt.json"), JSON.stringify({
    schema: "control-room.selfupgrade-attempt/v1", attemptId: "attempt-one", bootId: "test-boot", startedMono: 19800 }));
  const recordPath = join(fixture.root, "updater-state/selfupgrade.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, JSON.stringify({ ...record, phase: "flipping", attemptId: "attempt-one",
    bootId: "test-boot", startedMono: 19800, healthPassed: false }));
  await assert.rejects(runGuardV1(fixture), error => error.code === 1 && /previous runtime/u.test(error.stderr));
  assert.equal(JSON.parse(await readFile(recordPath, "utf8")).state, "needs_attention");
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r1");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p1");
  for (const [path, _current, previous] of fixture.runtime)
    assert.equal(await readlink(join(fixture.root, path)), previous, `${path} was reverted`);
  const rescued = JSON.parse(await readFile(join(fixture.root, "updater-state/rescued.json"), "utf8"));
  assert.deepEqual(rescued.from, { releaseId: "r2", pgDataId: "p2", schemaDigest: digest(2) });
  assert.deepEqual(rescued.to, { releaseId: "r1", pgDataId: "p1", schemaDigest: digest(1) });
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n");
  assert.deepEqual(calls.slice(0, 6), ["bootout system/xyz.agentcontrolroom.rehearsal.test.updater-guard",
    "bootout system/xyz.agentcontrolroom.rehearsal.test.updater", "bootout system/xyz.agentcontrolroom.rehearsal.test.nightly-backup",
    "bootout system/xyz.agentcontrolroom.rehearsal.test.gateway", "bootout system/xyz.agentcontrolroom.rehearsal.test.supervisor",
    "bootout system/xyz.agentcontrolroom.rehearsal.test.postgres"]);
  await runGuardV1(fixture);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r0", "a second rescue steps farther back");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p0");
  await assert.rejects(runGuardV1(fixture), error => /guard_refused:no_older_pair/u.test(error.stderr));
});

macTest("rescue overrides every journal step rather than resuming it forward", async t => {
  const steps = ["approved", "prechecked", "staged", "quick_backup", "draining", "quiesced", "backup_verified",
    "preimage_taken", "migrating", "migrated", "switched", "restarted", "healthy", "rollback_started", "restore_started"];
  for (const [index, step] of steps.entries()) {
    const fixture = await guardRootV1(t, String(index));
    await writeFile(join(fixture.root, "updater-state/journal.jsonl"), `${JSON.stringify({ step })}\n`);
    await runGuardV1(fixture);
    assert.equal(JSON.parse(await readFile(join(fixture.root, "updater-state/rescued.json"), "utf8")).to.releaseId, "r1",
      `rescue at ${step}`);
  }
});

macTest("rescue tombstones a stale link switch and boot cannot undo the rescued pair", async t => {
  const fixture = await guardRootV1(t, "stale-switch");
  await mkdir(join(fixture.root, "releases/r3"));
  const stale = { schema: "control-room.pair-link-switch/v1", operationId: "stale-before-rescue",
    phase: "previous_done", from: { releaseId: "r2", pgDataId: "p2", schemaDigest: digest(2) },
    to: { releaseId: "r3", pgDataId: "p2", schemaDigest: digest(2) }, previousReleaseId: "r2" };
  await writeFile(join(fixture.root, "updater-state/link-switch.json"), `${JSON.stringify(stale)}\n`);
  await runGuardV1(fixture);
  await assert.rejects(readFile(join(fixture.root, "updater-state/link-switch.json")), /ENOENT/u);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.root, "updater-state/link-switch.rescued.json"), "utf8")), stale,
    "the stale switch is retained as rescue evidence, outside the recovery path");
  await writeFile(join(fixture.root, "pg/data-p1/postmaster.pid"), "live");
  await mkdir(join(fixture.root, "status"));
  await writeFile(join(fixture.root, "updater-state/self-update"), "Off\n");
  let proofs = 0, recovered;
  const store = { async unhandledOwnerRequests() { return []; }, async liveRun() { return null; },
    async heartbeat() {},
    // The four R12 alert ports, so the DEFAULT sender constructs against this
    // store exactly as it does against the real PostgreSQL one.
    async subscriptions() { return []; }, async pending() { return []; },
    async begin() { return false; }, async finish() {}, async queue() {} };
  const updater = await startUpdaterV1({ root: fixture.root, store, effects: { async recover() {
    recovered = await recoverPairLinksV1(fixture.root, { databaseStopped: async () => {
      proofs += 1; return true;
    } });
    return recovered;
  } }, alertRuntime: await rootHeldVapid(fixture.root) });
  await updater.stop();
  assert.deepEqual(recovered, { status: "uncertain", reason: "rescue_marker" });
  assert.equal(JSON.parse(await readFile(join(fixture.root, "status/status.json"), "utf8")).state, "uncertain");
  assert.equal(proofs, 0);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r1");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p1");

  // Recreate the crash window in which rescued.json was durable but the stale
  // record had not yet been tombstoned. Recovery must still defer to the owner.
  await writeFile(join(fixture.root, "updater-state/link-switch.json"), `${JSON.stringify(stale)}\n`);
  assert.deepEqual(await recoverPairLinksV1(fixture.root, { databaseStopped: async () => {
    proofs += 1; return true;
  } }), { status: "uncertain", reason: "rescue_marker" });
  assert.equal(proofs, 0);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r1");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p1");
});

macTest("a hung updater is kickstarted at most three times an hour and a retry remains safe", async t => {
  const fixture = await guardRootV1(t);
  for (let index = 0; index < 3; index += 1) await runGuardV1(fixture, "watch");
  await assert.rejects(runGuardV1(fixture, "watch"), error => /guard_refused:restart_limit/u.test(error.stderr));
  const restarts = (await readFile(join(fixture.root, "updater-state/guard-restarts.log"), "utf8")).trim().split("\n");
  assert.equal(restarts.length, 3);
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n");
  assert.equal(calls.filter(line => line === "kickstart -k system/xyz.agentcontrolroom.rehearsal.test.updater").length, 3,
    "each bounded watch attempt performs exactly one updater kickstart");
});

macTest("malformed or injected known-good ids are refused before any link changes", async t => {
  const fixture = await guardRootV1(t);
  const known = JSON.parse(await readFile(join(fixture.root, "updater-state/known-good"), "utf8"));
  known.pairs[1].releaseId = "../../outside";
  await writeFile(join(fixture.root, "updater-state/known-good"), JSON.stringify(known));
  await assert.rejects(runGuardV1(fixture), error => /guard_refused:invalid_id/u.test(error.stderr));
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r2");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p2");
  await assert.rejects(readFile(fixture.log), /ENOENT/u, "malformed state is refused before any service is stopped");
});

macTest("declining a data-loss rescue leaves every service and link untouched", async t => {
  const fixture = await guardRootV1(t);
  await assert.rejects(declineGuardV1(fixture), error => /guard_refused:owner_declined_data_loss/u.test(error.stderr));
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r2");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p2");
  await assert.rejects(readFile(fixture.log), /ENOENT/u, "no service command ran before consent");
});

test("missing lockf refuses by name even with a stand-in flock in PATH; retry requires lockf", async t => {
  const fixture = await guardRootV1(t, "no-lockf");
  await rm(join(fixture.bin, "lockf"));
  await executable(join(fixture.bin, "flock"), 'printf called > "$CONTROL_ROOM_GUARD_ROOT/flock.log"');
  for (const verb of ["watch", "rescue"]) {
    await assert.rejects(runGuardV1(fixture, verb), error => error.code === 1
      && error.stderr.trim() === "guard_refused:lock_tool_missing");
  }
  for (const path of [fixture.log, join(fixture.root, "flock.log"),
    join(fixture.root, "updater-state/guard-status.json"), join(fixture.root, "updater-state/rescue-intent.json")])
    await assert.rejects(readFile(path), /ENOENT/u);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r2");
  // Command-contract stand-in: records BSD argv, without claiming kernel locking.
  await executable(join(fixture.bin, "lockf"), 'printf "%s\\n" "$@" > "$CONTROL_ROOM_GUARD_ROOT/lockf.log"\nexit 0');
  await runGuardV1(fixture, "watch");
  assert.deepEqual((await readFile(join(fixture.root, "lockf.log"), "utf8")).trim().split("\n"),
    ["-k", "-s", "-t", "0", join(fixture.root, "updater-state/guard.lock"), "/bin/sh", "-p", guard, "watch-locked"]);
  await assert.rejects(readFile(join(fixture.root, "flock.log")), /ENOENT/u);
});

test("Linux platform refuses by name before a stand-in flock or any service command", async t => {
  const fixture = await guardRootV1(t, "linux");
  await executable(join(fixture.bin, "uname"), "echo Linux");
  await executable(join(fixture.bin, "flock"), 'printf called > "$CONTROL_ROOM_GUARD_ROOT/flock.log"');
  await executable(join(fixture.bin, "lockf"), 'printf called > "$CONTROL_ROOM_GUARD_ROOT/lockf.log"');
  await assert.rejects(runGuardV1(fixture, "watch"), error => error.code === 1
    && error.stderr.trim() === "guard_refused:unsupported_platform");
  for (const name of ["flock.log", "lockf.log", "launchctl.log", "updater-state/guard-status.json"])
    await assert.rejects(readFile(join(fixture.root, name)), /ENOENT/u);
});

test("the worktree test-root gate rejects outside-prefix, traversal, aliases and escaped command bins", async t => {
  const fixture = await guardRootV1(t, "gate");
  const outside = join(process.cwd(), ".test-tmp", `outside-${basename(fixture.root)}`);
  await mkdir(outside); t.after(() => rm(outside, { recursive: true, force: true }));
  const alias = join(fixture.root, "alias"); await symlink(fixture.root, alias);
  for (const root of [outside, alias, `${fixture.root}/../${basename(fixture.root)}`, join(fixture.root, "missing")]) {
    await assert.rejects(runGuardV1(fixture, "watch", root), error => error.code === 70);
    // Use an invalid verb without command overrides as well: another gate must
    // not conceal an accidental widening of the root prefix.
    await assert.rejects(execGuardV1("/bin/sh", ["-p", guard, "bad-verb"], { env: {
      CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: root,
    } }), error => error.code === 70);
  }
  await assert.rejects(readFile(fixture.log), /ENOENT/u);
  // An escaped legacy test-bin override must be ignored.
  const binAlias = join(fixture.root, "bin-alias"); await symlink(fixture.bin, binAlias);
  for (const path of [outside, binAlias, `${fixture.bin}/../fake-bin`, join(fixture.bin, "missing")]) {
    await assert.rejects(execGuardV1("/bin/sh", ["-p", guard, "watch"], { env: {
      CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: fixture.root,
      CONTROL_ROOM_GUARD_TEST_BIN: fixture.bin, CONTROL_ROOM_GUARD_TEST_PATH: path,
    } }), error => error.code === 70);
  }
  const result = await execGuardV1("/bin/sh", ["-p", guard, "bad-verb"], { env: {
    CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: fixture.root,
    CONTROL_ROOM_GUARD_TEST_BIN: outside,
  } }).catch(error => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /guard_refused:(invalid_verb|unsupported_platform)/u);
});

macTest("the native lock excludes a fifty-caller burst and releases after a stopped holder", async t => {
  const fixture = await guardRootV1(t, "burst");
  await executable(join(fixture.bin, "clock"), 'printf entered > "$CONTROL_ROOM_GUARD_ROOT/entered"\n/bin/sleep 0.5\necho "test-boot 20000"');
  const settled = await Promise.allSettled(Array.from({ length: 50 }, () => runGuardV1(fixture, "watch")));
  assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
  const rejected = settled.filter(result => result.status === "rejected");
  assert.equal(rejected.length, 49);
  assert.ok(rejected.every(result => result.reason.code === 75), `lockf contention exits EX_TEMPFAIL: ${JSON.stringify(rejected.map(result => ({ code: result.reason.code, message: result.reason.message })))}`);
  assert.equal((await readFile(fixture.log, "utf8")).trim().split("\n").length, 1);
  // A timed-out holder must lose its entire group and its kernel lock.
  await executable(join(fixture.bin, "clock"), '/bin/sleep 30\necho "test-boot 20000"');
  await assert.rejects(runGuardV1(fixture, "watch", fixture.root, 5_000), error => error.killed === true);
  await executable(join(fixture.bin, "clock"), 'echo "test-boot 20000"');
  await runGuardV1(fixture, "watch");
  assert.equal((await readFile(fixture.log, "utf8")).trim().split("\n").length, 2);
});

test("an unavailable platform probe refuses by name without touching state", async t => {
  const fixture = await guardRootV1(t, "uname");
  await executable(join(fixture.bin, "uname"), "exit 2");
  await assert.rejects(runGuardV1(fixture, "watch"), error => error.code === 1
    && error.stderr.trim() === "guard_refused:platform_unknown");
  await assert.rejects(readFile(fixture.log), /ENOENT/u);
  await assert.rejects(readFile(join(fixture.root, "updater-state/guard-status.json")), /ENOENT/u);
});

test("the worktree scratch exception belongs only to the source guard layout", async t => {
  const fixture = await guardRootV1(t, "copy");
  const directory = join(fixture.root, "a/b/c/d");
  const root = join(fixture.root, ".test-tmp/guard-inner");
  await mkdir(directory, { recursive: true }); await mkdir(root, { recursive: true });
  const copied = join(directory, "guard.sh"); await writeFile(copied, await readFile(guard));
  await assert.rejects(execGuardV1("/bin/sh", ["-p", copied, "bad-verb"], { env: {
    CONTROL_ROOM_GUARD_TESTING: "1", CONTROL_ROOM_GUARD_ROOT: root,
  } }), error => error.code === 70);
});

// Each damage names the refusal it must produce. The old suite asserted one
// message for all of them — "the backup copy is missing or incomplete" — which
// is exactly why a wrong OWNERSHIP expectation could ship with every case green:
// the message did not distinguish the cause, so a test could not either.
const REFUSAL_STATUS = /rescue stopped nothing and changed no selected version or database; current service state was not checked/u;

const RESCUE_DAMAGE_V1 = Object.freeze({
  "missing-release": "releases/r1 is missing",
  "missing-db": "pg/data-p1 is missing",
  "release-symlink": "releases/r1 is a link, not a real directory",
  "db-symlink": "pg/data-p1 is a link, not a real directory",
  "missing-package": "releases/r1/package.json is missing or empty",
  "missing-control": "pg/data-p1/global/pg_control is missing or empty",
  "missing-program": "releases/r1/dist-vps/server/fleetGateway.js is missing or empty",
  "program-parent-symlink": "releases/r1/dist-vps is a link, not a real directory",
  "bad-release-owner": "releases/r1 is owned by uid 999, but it must be owned by root",
  "bad-db-owner": "pg/data-p1 is owned by uid 999, but it must be owned by the database account",
  "writable-release": "releases/r1 is mode 770",
  "symlink-parent": "releases is a link, not a real directory",
  // `pg/`, `pg/socket` and `pg_wal/archive_status` were not enumerated at all,
  // so a link planted in any of them was accepted. Three cases the earlier
  // enumeration did not list.
  "socket-link": "pg/socket is a link, not a real directory",
  "archive-status-link": "pg/data-p1/pg_wal/archive_status is a link, not a real directory",
  "archive-status-missing": "pg/data-p1/pg_wal/archive_status is missing",
  "db-account-unresolvable": "the database account named in the postgres service definition could not be resolved",
  // The SAME message as the case above, on purpose: `id -u -- -r` exits 1 and a
  // failing `id` exits 1, so both are honestly "that account could not be resolved
  // to a uid" and the guard says so once. What separates the two cases is the
  // OUTCOME without the `--`, which is the thing the mutation tests: without it,
  // `id -u -r` exits 0 and PRINTS 0 — the invoking uid, which under root is root
  // — so the guard would demand that `pg/` be root-owned (the exact inversion this
  // slice removes), accepting a stranger's cluster and refusing the real one.
  "db-account-looks-like-a-flag": "the database account named in the postgres service definition could not be resolved",
});

async function damageRescueFixtureV1(t, damage) {
  const f = await guardRootV1(t, damage);
  const plist = join(f.root, "fake-plists/xyz.agentcontrolroom.rehearsal.test.postgres.plist");
  const rename = await import("node:fs/promises").then(fs => fs.rename);
  if (damage === "missing-release") await rm(join(f.root, "releases/r1"), { recursive: true });
  if (damage === "missing-db") await rm(join(f.root, "pg/data-p1"), { recursive: true });
  if (damage === "release-symlink" || damage === "db-symlink") {
    const path = damage === "release-symlink" ? "releases/r1" : "pg/data-p1";
    await rm(join(f.root, path), { recursive: true });
    await symlink(damage === "release-symlink" ? "r0" : "data-p0", join(f.root, path));
  }
  if (damage === "socket-link") {
    await rm(join(f.root, "pg/socket"), { recursive: true });
    await symlink("data-p1", join(f.root, "pg/socket"));
  }
  if (damage === "archive-status-link") {
    await rm(join(f.root, "pg/data-p1/pg_wal/archive_status"), { recursive: true });
    await symlink("../../data-p0", join(f.root, "pg/data-p1/pg_wal/archive_status"));
  }
  if (damage === "archive-status-missing") await rm(join(f.root, "pg/data-p1/pg_wal/archive_status"), { recursive: true });
  if (damage === "missing-package") await rm(join(f.root, "releases/r1/package.json"));
  if (damage === "missing-program") await rm(join(f.root, "releases/r1/dist-vps/server/fleetGateway.js"));
  if (damage === "program-parent-symlink") {
    await rm(join(f.root, "releases/r1/dist-vps"), { recursive: true });
    await symlink("../r0/dist-vps", join(f.root, "releases/r1/dist-vps"));
  }
  if (damage === "missing-control") await rm(join(f.root, "pg/data-p1/global/pg_control"));
  if (damage === "symlink-parent") { await rename(join(f.root, "releases"), join(f.root, "saved-releases")); await symlink("saved-releases", join(f.root, "releases")); }
  if (damage === "db-account-unresolvable") await executable(join(f.bin, "id"), "exit 1");
  if (damage === "db-account-looks-like-a-flag") {
    await writeFile(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>UserName</key><string>-r</string></dict></plist>');
    // The REAL /usr/bin/id contract, not a stand-in shaped to the fix. MEASURED
    // on this Mac: `id -u -r` and `id -u -n` both EXIT 0 printing the invoking uid
    // / login name, while `id -u -- -r` exits 1 ("no such user"). So without the
    // `--` the guard resolves a flag-shaped UserName to uid 0 and then DEMANDS
    // that `pg/` be root-owned - the exact inversion this fix removes - and with
    // it the same plist refuses honestly instead.
    await executable(join(f.bin, "id"), [
      'case "$1" in -u) shift ;; esac',
      'if [ "$1" = "--" ]; then [ "${2#-}" = "$2" ] || exit 1; echo 123; exit 0; fi',
      'case "$1" in -*) echo 0 ;; *) echo 123 ;; esac'].join("\n"));
  }
  if (["bad-release-owner", "bad-db-owner", "writable-release"].includes(damage)) {
    const target = damage === "bad-db-owner" ? "*/pg/data-p1" : "*/releases/r1";
    await executable(join(f.bin, "stat"), guardStatStandInV1({ overrides: [
      { match: target, uid: damage === "writable-release" ? "0" : "999", mode: damage === "writable-release" ? "770" : "700" }] }));
  }
  return f;
}

macTest("R6U-01: missing, incomplete and substituted rescue artifacts preserve the selected pair without claiming service health", async t => {
  for (const [damage, reason] of Object.entries(RESCUE_DAMAGE_V1)) {
    const f = await damageRescueFixtureV1(t, damage);
    await assert.rejects(runGuardV1(f), error => REFUSAL_STATUS.test(error.stderr)
      && error.stderr.includes(`rescue cannot continue: ${reason}`),
    `${damage}: ${JSON.stringify(RESCUE_DAMAGE_V1[damage])}`);
    assert.equal(await readlink(join(f.root, "current")), "releases/r2");
    assert.equal(await readlink(join(f.root, "pg/current")), "data-p2");
    for (const file of [f.log, join(f.root, "updater-state/rescue-intent.json")]) await assert.rejects(readFile(file), /ENOENT/);
  }
});

macTest("R6U-06: rescue succeeds under the ownership the product writes, and refuses pg/ owned by anyone else", async t => {
  // THE REGRESSION THIS FIX EXISTS FOR. On the previous commit the guard required
  // `pg/` to be owned by root while `chownOwnershipV1` hands it to the database
  // account, so every rescue on a real Mac refused with a message about a missing
  // backup copy. Here the fixture answers with the product's own ownership table
  // and the rescue must COMPLETE.
  const f = await guardRootV1(t, "product-ownership");
  await runGuardV1(f);
  assert.equal(await readlink(join(f.root, "current")), "releases/r1");
  assert.equal(await readlink(join(f.root, "pg/current")), "data-p1");
  assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescued.json"), "utf8")).serviceState, "completed");

  // And the same tree with `pg/` owned by root — the ownership that never occurs
  // in production, and the one the old guard demanded — is refused, with the real
  // reason named rather than a generic missing-backup notice.
  const wrong = await guardRootV1(t, "root-owned-pg");
  await executable(join(wrong.bin, "stat"), guardStatStandInV1({ overrides: [{ match: "*/pg", uid: "0", mode: "700" }] }));
  await assert.rejects(runGuardV1(wrong), error => REFUSAL_STATUS.test(error.stderr)
    && error.stderr.includes("rescue cannot continue: pg is owned by uid 0, "
      + "but it must be owned by the database account (test-database, uid 123)"));
  assert.equal(await readlink(join(wrong.root, "current")), "releases/r2");
  assert.equal(await readlink(join(wrong.root, "pg/current")), "data-p2");
  await assert.rejects(readFile(wrong.log), /ENOENT/, "no service is touched by a custody refusal");
});

macTest("R6U-02: each failed service start or health probe retains the same rescue for retry", async t => {
  for (const service of ["postgres", "supervisor", "gateway", "updater", "nightly-backup", "updater-guard"]) {
    for (const phase of ["bootstrap", "print", ...(service === "postgres" ? ["idle", "no-pid"] : [])]) {
      const f = await guardRootV1(t, service);
      const good = await readFile(join(f.bin, "launchctl"), "utf8");
      await executable(join(f.bin, "launchctl"), `printf '%s\\n' "$*" >> "$CONTROL_ROOM_GUARD_ROOT/launchctl.log"; case "$1:$*" in ${phase}:*rehearsal.test.${service}*) exit 1 ;; esac; echo 'state = ${phase === "idle" ? "waiting" : "running"}'; echo 'pid = ${phase === "no-pid" ? "0" : "123"}'`);
      await assert.rejects(runGuardV1(f), e => e.code === 1 && e.stderr.includes(service) && e.stderr.includes("the same rescue can be retried"));
      assert.equal(await readlink(join(f.root, "current")), "releases/r1");
      assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescue-intent.json"))).to.releaseId, "r1");
      assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescued.json"))).serviceState, "starting_services");
      await executable(join(f.bin, "launchctl"), good.replace(/^#!.*\n/u, ""));
      await runGuardV1(f);
      assert.equal(await readlink(join(f.root, "current")), "releases/r1", "retry must not fall back to r0");
      await assert.rejects(readFile(join(f.root, "updater-state/rescue-intent.json")), /ENOENT/);
    }
  }
});

macTest("R6U-05: wall-clock jumps never roll back a newly observed heartbeat or spend the budget", async t => {
  for (const wall of ["1000", "9000000"]) {
    const f = await guardRootV1(t, "clock");
    await writeFile(join(f.root, "updater-state/selfupgrade-attempt.json"), JSON.stringify({
      schema: "control-room.selfupgrade-attempt/v1", attemptId: "attempt-clock", bootId: "test-boot", startedMono: 20000 }));
    const recordPath = join(f.root, "updater-state/selfupgrade.json"), record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...record, phase: "flipping", attemptId: "attempt-clock", bootId: "test-boot",
      startedMono: 20000, healthPassed: false }));
    await executable(join(f.bin, "date"), `echo ${wall}`);
    for (let i = 0; i < 5; i++) await runGuardV1(f, "watch", f.root, 15000, { GUARD_MTIME: "23600", GUARD_ELAPSED: String(20000 + i) });
    assert.equal(await readlink(join(f.root, "updater/current")), "u2");
    await assert.rejects(readFile(f.log), /ENOENT/);
    await assert.rejects(readFile(join(f.root, "updater-state/guard-restarts.log")), /ENOENT/);
    await assert.rejects(runGuardV1(f, "watch", f.root, 15000, { GUARD_MTIME: "23600", GUARD_ELAPSED: "20181" }),
      error => error.code === 1 && /previous runtime/u.test(error.stderr));
    assert.equal(await readlink(join(f.root, "updater/current")), "u1", "a genuinely missed heartbeat eventually restarts");
    await runGuardV1(f, "watch", f.root, 15000, { GUARD_MTIME: "23601", GUARD_ELAPSED: "20182" });
    assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1);
    await runGuardV1(f, "watch", f.root, 15000, { GUARD_BOOT: "new-boot", GUARD_ELAPSED: "50000" });
    assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1, "new boot starts a new observation window");
  }
});

macTest("R6U-02: stopping halfway through service restart preserves the exact rescue on retry", async t => {
  const f = await guardRootV1(t, "cut");
  const good = await readFile(join(f.bin, "launchctl"), "utf8");
  await executable(join(f.bin, "launchctl"), 'case "$1:$*" in bootstrap:*rehearsal.test.updater.plist*) /bin/sleep 30 ;; esac; echo "state = running"; echo "pid = 123"');
  await assert.rejects(runGuardV1(f, "rescue", f.root, 6000), error => error.killed === true);
  assert.equal(await readlink(join(f.root, "current")), "releases/r1");
  assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescue-intent.json"))).to.releaseId, "r1");
  await executable(join(f.bin, "launchctl"), good.replace(/^#!.*\n/u, ""));
  await runGuardV1(f);
  assert.equal(await readlink(join(f.root, "current")), "releases/r1");
  assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescued.json"))).serviceState, "completed");
});

macTest("R6U-02: a dropped health probe is bounded and cannot clear rescue intent", async t => {
  const f = await guardRootV1(t, "slow");
  await executable(join(f.bin, "launchctl"), 'case "$1:$*" in print:*rehearsal.test.postgres*) /bin/sleep 30 ;; esac; echo "state = running"; echo "pid = 123"');
  const started = performance.now();
  await assert.rejects(runGuardV1(f, "rescue", f.root, 30000), error => error.code === 1 && /postgres.*the same rescue can be retried/.test(error.stderr));
  assert(performance.now() - started < 28000);
  assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescue-intent.json"))).to.releaseId, "r1");
});

macTest("guard timeout interpreter ignores inherited Perl startup options", async t => {
  const f = await guardRootV1(t, "env");
  await runGuardV1(f, "rescue", f.root, 15000, { PERL5OPT: '-MNoSuchGuardStartupModule' });
  assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescued.json"))).serviceState, "completed");
});

macTest("R6U-05: missing heartbeat, bad elapsed input, reboot and an expired restart budget stay bounded", async t => {
  const f = await guardRootV1(t, "missing");
  await rm(join(f.root, "updater-state/heartbeat"));
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20000" });
  await assert.rejects(readFile(f.log), /ENOENT/);
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20181" });
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1);
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20182" });
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20183" });
  await assert.rejects(runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20184" }), e => /restart_limit/.test(e.stderr));
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "23784" });
  await assert.rejects(runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "invalid" }), e => /elapsed_clock_unavailable/.test(e.stderr));
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "100" });
  assert.match(await readFile(join(f.root, "updater-state/guard-heartbeat-observed"), "utf8"), /^test-boot 100 missing/);
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_BOOT: "next-boot", GUARD_ELAPSED: "50000" });
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 4);
});

// cook-hard6 #33 ("future restart records cannot exhaust the limit") lost its only
// killing test when the guard moved to the boot-scoped elapsed clock. Same boot,
// elapsed clock reset: the three earlier restarts are now dated in its future, so
// they must not spend the allowance of the window that follows.
macTest("R6U-05: restart records dated after an elapsed-clock reset do not spend the restart allowance", async t => {
  const f = await guardRootV1(t, "reset");
  await rm(join(f.root, "updater-state/heartbeat"));
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20000" });
  for (const elapsed of ["20181", "20182", "20183"]) await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: elapsed });
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 3);
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "100" });
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 3, "a reset starts a new observation window");
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "281" });
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 4,
    "records from before the reset are in the clock's future and are not counted");
});

// cook-hard6 #36 ("a first installation has one bounded missing heartbeat grace"):
// every other guard fixture pre-writes an observation, so none covered the very
// first watch, where neither the heartbeat nor any observation exists yet.
macTest("R6U-05: a first installation with no observation gets one bounded heartbeat grace", async t => {
  const f = await guardRootV1(t, "first");
  await rm(join(f.root, "updater-state/heartbeat"));
  await rm(join(f.root, "updater-state/guard-heartbeat-observed"));
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20000" });
  await assert.rejects(readFile(f.log), /ENOENT/, "the first watch only records its observation");
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20180" });
  await assert.rejects(readFile(f.log), /ENOENT/, "the grace lasts the whole heartbeat window");
  await runGuardV1(f, "watch", f.root, 15000, { GUARD_ELAPSED: "20181" });
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1, "and is bounded: a dead updater is restarted");
});

macTest("new rescue custody seams refuse failed metadata reads and malformed modes before shutdown", async t => {
  // Each seam names its own reason, for the same reason the damage table does: a
  // single expected message cannot tell a wrong ownership apart from an
  // unreadable mode, which is how the wrong-owner regression stayed invisible.
  const seams = { plist: "the postgres service definition "
    + "fake-plists/xyz.agentcontrolroom.rehearsal.test.postgres.plist could not be read",
    id: "the database account named in the postgres service definition could not be resolved to a uid",
    stat: "the owner and permissions of . could not be read",
    mode: "the permissions of pg/data-p1/pg_hba.conf could not be read",
    "empty-file": "releases/r1/package.json is not a regular file with content in it",
    "file-symlink": "releases/r1/package.json is a link, not a real file",
    "ordinary-directory": "pg/data-p1/base is a file, but a folder is required" };
  for (const [seam, reason] of Object.entries(seams)) {
    const f = await guardRootV1(t, seam);
    if (seam === "plist") await rm(join(f.root, "fake-plists/xyz.agentcontrolroom.rehearsal.test.postgres.plist"));
    if (seam === "id") await executable(join(f.bin, "id"), "exit 1");
    if (seam === "stat") await executable(join(f.bin, "stat"), "exit 1");
    if (seam === "mode") await executable(join(f.bin, "stat"),
      guardStatStandInV1({ overrides: [{ match: "*/pg/data-p1/pg_hba.conf", uid: "123", mode: "invalid" }] }));
    if (seam === "empty-file") await writeFile(join(f.root, "releases/r1/package.json"), "");
    if (seam === "file-symlink") { await rm(join(f.root, "releases/r1/package.json")); await symlink("../r0/package.json", join(f.root, "releases/r1/package.json")); }
    if (seam === "ordinary-directory") { await rm(join(f.root, "pg/data-p1/base"), { recursive: true }); await writeFile(join(f.root, "pg/data-p1/base"), "ordinary"); }
    const refused = await runGuardV1(f).catch(error => error);
    assert.equal(refused.code, 1, seam);
    assert.match(refused.stderr, REFUSAL_STATUS, `${seam}: ${refused.stderr}`);
    assert.ok(refused.stderr.includes(`rescue cannot continue: ${reason}`),
      `${seam}: expected ${reason} in ${JSON.stringify(refused.stderr)}`);
    await assert.rejects(readFile(f.log), /ENOENT/);
    await assert.rejects(readFile(join(f.root, "updater-state/rescue-intent.json")), /ENOENT/);
  }
});

macTest("new watch checks refuse failed clocks and malformed heartbeat observations without restarting", async t => {
  for (const seam of ["clock", "heartbeat-stat", "heartbeat-value", "observation"]) {
    const f = await guardRootV1(t, seam);
    if (seam === "clock") await executable(join(f.bin, "clock"), "exit 1");
    if (seam === "heartbeat-stat") await executable(join(f.bin, "stat"), "exit 1");
    if (seam === "heartbeat-value") await executable(join(f.bin, "stat"), "echo invalid");
    if (seam === "observation") await writeFile(join(f.root, "updater-state/guard-heartbeat-observed"), "test-boot invalid 0\n");
    await assert.rejects(runGuardV1(f, "watch"), e => /elapsed_clock_unavailable|heartbeat_stat_failed|invalid_heartbeat_time|invalid_heartbeat_observation/.test(e.stderr));
    await assert.rejects(readFile(f.log), /ENOENT/);
  }
});

macTest("R6U-02: a killed deadline parent cannot leave its command group running", async t => {
  const f = await guardRootV1(t, "parent-cut"), probe = join(f.root, "kill-deadline-parent.py");
  await writeFile(probe, `import ctypes, os, signal, time
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
class BSD(ctypes.Structure):
 _fields_=[(k,ctypes.c_uint32) for k in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','rfu']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(k,ctypes.c_uint32) for k in ['nfiles','pgid','jobc','tdev','tpgid','nice']]+[('sec',ctypes.c_uint64),('usec',ctypes.c_uint64)]
guardian=BSD(); assert lib.proc_pidinfo(os.getppid(),3,0,ctypes.byref(guardian),ctypes.sizeof(guardian))
assert guardian.pgid==guardian.pid
parent=BSD(); assert lib.proc_pidinfo(guardian.ppid,3,0,ctypes.byref(parent),ctypes.sizeof(parent))
assert parent.name.decode().lower().startswith('perl')
os.kill(parent.pid,signal.SIGKILL)
with open(os.environ['CONTROL_ROOM_GUARD_ROOT']+'/deadline-parent-cut','w') as out:out.write('owned deadline parent killed')
time.sleep(30)
`);
  await executable(join(f.bin, "launchctl"), 'case "$1:$*" in print:*rehearsal.test.postgres*) [ ! -f "$CONTROL_ROOM_GUARD_ROOT/deadline-parent-cut" ] || exit 1; exec /usr/bin/python3 "$CONTROL_ROOM_GUARD_ROOT/kill-deadline-parent.py" ;; esac; echo "state = running"; echo "pid = 123"');
  const started = performance.now();
  await assert.rejects(runGuardV1(f, "rescue", f.root, 15000), e => e.code === 1 && /postgres.*the same rescue can be retried/.test(e.stderr));
  assert(performance.now() - started < 12000);
  assert.match(await readFile(join(f.root, "deadline-parent-cut"), "utf8"), /owned deadline parent killed/);
  assert.equal(JSON.parse(await readFile(join(f.root, "updater-state/rescue-intent.json"))).to.releaseId, "r1");
});
