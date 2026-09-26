import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProvisionedMacLocalConfigurationV1,
  upgradeMacLocalDatabaseV1 } from "../scripts/mac-local/provision-database.mjs";
import { desiredMacGrantsV1, diffMacGrantsV1, readDesiredMacGrantsV1 } from
  "../scripts/mac-local/database-upgrade-grants.mjs";
import { MAC_LOCAL_DATABASE_ROLES_V1, captureMacLocalDatabaseRolesV1 } from
  "../src/web/v1/mac-local-database-roles.ts";

test("grant plan covers the source role files and detects additions and extras exactly", async () => {
  const desired = await readDesiredMacGrantsV1();
  assert.ok(desired.size > 300);
  assert.ok([...desired].some(value => value.includes("control_room_local_result_publisher|table|public.control_harness_runs||INSERT|plain")));
  assert.ok([...desired].some(value => value.includes("control_room_task_coordinator|table|public.control_node_fleet_signals||INSERT|plain")));
  const missingOne = new Set(desired);
  const item = [...desired][0];
  missingOne.delete(item);
  missingOne.add("control_room_web|table|public.unexpected||DELETE|plain");
  assert.deepEqual(diffMacGrantsV1(missingOne, desired), {
    extra: ["control_room_web|table|public.unexpected||DELETE|plain"], missing: [item],
  });
  assert.throws(() => desiredMacGrantsV1({ fake: "GRANT ALL ON secret TO control_room_web;" }),
    /upgrade_grant_source_refused/u);
});

test("upgrade dry run changes no protected file; real convergence adds only publisher and preserves old passwords and owner config", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const roleNames = { web: "control_room_web", coordinator: "control_room_coordinator",
    results: "control_room_results", queueWorker: "control_room_queue_worker" };
  const values = Object.fromEntries(Object.values(roleNames).map((name, index) => [name, `${"p".repeat(40)}${index}`]));
  values.control_room_migrator = "m".repeat(41);
  for (const [name, value] of Object.entries(values))
    await writeFile(join(passwords, `${name}.txt`), `${value}\n`, { mode: 0o600 });
  const web = { host: "127.0.0.1", port: 15432, database: "control_room", username: roleNames.web,
    password: values[roleNames.web], majorVersion: 17 };
  const role = key => ({ ...web, username: roleNames[key], password: values[roleNames[key]] });
  const oldRoles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web, coordinator: role("coordinator"),
    results: role("results"), queueWorker: role("queueWorker") };
  const mac = captureProvisionedMacLocalConfigurationV1({ database: web, ownerCode: "owner-code",
    workers: [
      { workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" },
      { workerId: "worker:claude:mac-1", kind: "claude-code", executablePath: "/opt/claude", recordedVersion: "claude 1.2.3" },
      { workerId: "worker:hermes:mac-1", kind: "hermes", executablePath: "/opt/hermes", recordedVersion: "hermes 1.2.3" },
    ] });
  const macFile = join(config, "mac-local.json"), roleFile = join(config, "database-roles.json");
  await writeFile(macFile, JSON.stringify(mac), { mode: 0o600 });
  await writeFile(roleFile, JSON.stringify(oldRoles), { mode: 0o600 });
  const macBefore = await readFile(macFile);
  const rolesBefore = await readFile(roleFile);
  const initial = { pendingMigrations: ["db/migrations/0086_mac_local_owner_review_profile.sql"],
    createRoles: ["control_room_local_result_publisher", "control_room_publisher"],
    membership: { missing: ["control_room_publisher|control_room_local_result_publisher"], extra: [] },
    grants: { missing: [], extra: [] } };
  let live = false, calls = 0;
  const runRemote = async request => {
    calls += 1;
    assert.equal(request.sourceRef, undefined, "upgrade cannot select a review branch");
    if (request.dryRun) return live ? { pendingMigrations: [], createRoles: [],
      membership: { missing: [], extra: [] }, grants: { missing: [], extra: [] } } : initial;
    assert.equal(request.migratorPassword, values.control_room_migrator);
    assert.match(request.publisherPassword, /^[A-Za-z0-9_-]{32,}$/u);
    live = true;
    return { upgraded: true, before: initial, after: { pendingMigrations: [], createRoles: [],
      membership: { missing: [], extra: [] }, grants: { missing: [], extra: [] } } };
  };
  const options = { protectedRoot: root, sshTarget: "root@example", remoteWorktree: "/root/agent-control-room", runRemote };
  assert.deepEqual(await upgradeMacLocalDatabaseV1({ ...options, dryRun: true }), initial);
  assert.deepEqual(await readFile(roleFile), rolesBefore);
  await assert.rejects(readFile(join(passwords, "control_room_publisher.txt")), { code: "ENOENT" });
  await upgradeMacLocalDatabaseV1(options);
  const changed = JSON.parse(await readFile(roleFile, "utf8"));
  const validated = captureMacLocalDatabaseRolesV1(changed);
  assert.equal(validated.publisher.username, "control_room_publisher");
  assert.equal(validated.publisher.password, (await readFile(join(passwords, "control_room_publisher.txt"), "utf8")).trim());
  assert.equal((await stat(join(passwords, "control_room_publisher.txt"))).mode & 0o077, 0);
  for (const [key, name] of Object.entries(roleNames)) assert.deepEqual(changed[key], oldRoles[key], name);
  assert.deepEqual(await readFile(macFile), macBefore);
  await upgradeMacLocalDatabaseV1(options);
  assert.equal(calls, 5);
  assert.deepEqual(await readFile(macFile), macBefore);
});
