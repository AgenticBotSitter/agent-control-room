import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), guard = join(process.cwd(), "src/updater/v1/guard/guard.sh");
const digest = suffix => `sha256:${String(suffix).padStart(64, "0")}`;

async function executable(path, body) { await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o500); }

async function guardRootV1(t, suffix = "one") {
  const root = await mkdtemp(join("/private/tmp", `updater-guard-${suffix}-`)), bin = join(root, "fake-bin"), log = join(root, "launchctl.log");
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  for (const path of ["updater-state", "updater", "runtime", "releases/r0", "releases/r1", "releases/r2",
    "pg/data-p0", "pg/data-p1", "pg/data-p2", "pg/socket", "fake-bin"]) await mkdir(join(root, path), { recursive: true });
  await executable(join(bin, "launchctl"), `printf '%s\\n' "$*" >> '${log}'`);
  await executable(join(bin, "stat"), "echo 0");
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
    schema: "control-room.selfupgrade/v1", phase: "flipping", linkCount: 5,
    links: runtime.map(([path, _current, previous]) => ({ link: path, from: previous, to: _current })) }));
  return { root, bin, log, runtime };
}

async function runGuardV1(fixture, verb = "rescue", root = fixture.root) {
  return exec("/bin/sh", ["-p", guard, verb], { env: { CONTROL_ROOM_GUARD_TESTING: "1",
    CONTROL_ROOM_GUARD_ROOT: root, CONTROL_ROOM_GUARD_TEST_BIN: fixture.bin,
    CONTROL_ROOM_GUARD_ASSUME_YES: "1" } });
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
      CONTROL_ROOM_GUARD_TEST_BIN: fixture.bin },
  });
}

test("pair-aware rescue moves code and DB together, reverts all updater/runtime links, and leaves rescued.json", async t => {
  const fixture = await guardRootV1(t);
  await runGuardV1(fixture);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r1");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p1");
  for (const [path, _current, previous] of fixture.runtime)
    assert.equal(await readlink(join(fixture.root, path)), previous, `${path} was reverted`);
  const rescued = JSON.parse(await readFile(join(fixture.root, "updater-state/rescued.json"), "utf8"));
  assert.deepEqual(rescued.from, { releaseId: "r2", pgDataId: "p2", schemaDigest: digest(2) });
  assert.deepEqual(rescued.to, { releaseId: "r1", pgDataId: "p1", schemaDigest: digest(1) });
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n");
  assert.deepEqual(calls.slice(0, 4), ["bootout system/xyz.agentcontrolroom.updater",
    "bootout system/xyz.agentcontrolroom.supervisor", "bootout system/xyz.agentcontrolroom.gateway",
    "bootout system/xyz.agentcontrolroom.postgres"]);
  await runGuardV1(fixture);
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r0", "a second rescue steps farther back");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p0");
  await assert.rejects(runGuardV1(fixture), error => /guard_refused:no_older_pair/u.test(error.stderr));
});

test("rescue overrides every journal step rather than resuming it forward", async t => {
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

test("a hung updater is kickstarted at most three times an hour and a retry remains safe", async t => {
  const fixture = await guardRootV1(t);
  for (let index = 0; index < 3; index += 1) await runGuardV1(fixture, "watch");
  await assert.rejects(runGuardV1(fixture, "watch"), error => /guard_refused:restart_limit/u.test(error.stderr));
  const restarts = (await readFile(join(fixture.root, "updater-state/guard-restarts.log"), "utf8")).trim().split("\n");
  assert.equal(restarts.length, 3);
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n");
  assert.equal(calls.filter(line => line === "kickstart -k system/xyz.agentcontrolroom.updater").length, 3,
    "each bounded watch attempt performs exactly one updater kickstart");
});

test("malformed or injected known-good ids are refused before any link changes", async t => {
  const fixture = await guardRootV1(t);
  const known = JSON.parse(await readFile(join(fixture.root, "updater-state/known-good"), "utf8"));
  known.pairs[1].releaseId = "../../outside";
  await writeFile(join(fixture.root, "updater-state/known-good"), JSON.stringify(known));
  await assert.rejects(runGuardV1(fixture), error => /guard_refused:invalid_id/u.test(error.stderr));
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r2");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p2");
  await assert.rejects(readFile(fixture.log), /ENOENT/u, "malformed state is refused before any service is stopped");
});

test("declining a data-loss rescue leaves every service and link untouched", async t => {
  const fixture = await guardRootV1(t);
  await assert.rejects(declineGuardV1(fixture), error => /guard_refused:owner_declined_data_loss/u.test(error.stderr));
  assert.equal(await readlink(join(fixture.root, "current")), "releases/r2");
  assert.equal(await readlink(join(fixture.root, "pg/current")), "data-p2");
  await assert.rejects(readFile(fixture.log), /ENOENT/u, "no service command ran before consent");
});
