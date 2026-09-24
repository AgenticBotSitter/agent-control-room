import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAC_LOCAL_DATABASE_ROLES_V1, captureMacLocalDatabaseRolesV1 } from "../src/web/v1/mac-local-database-roles";
import { loadMacLocalDatabaseRolesFromRootV1 } from "../scripts/mac-local/load-protected-configuration";

const connection = (username: string) => ({ host: "127.0.0.1", port: 5432, database: "control_room",
  username, password: `${username}-test-password`, majorVersion: 17 as const });
const roles = Object.freeze({ schema: MAC_LOCAL_DATABASE_ROLES_V1,
  web: connection("control_room_web"), coordinator: connection("control_room_coordinator"),
  results: connection("control_room_results"), queueWorker: connection("control_room_queue_worker") });

test("captures restricted roles for exactly one authority database", () => {
  const captured = captureMacLocalDatabaseRolesV1(roles);
  assert.equal(captured.web.database, "control_room");
  assert.equal(captured.coordinator.username, "control_room_coordinator");
});

test("refuses role reuse and a second database endpoint", () => {
  assert.throws(() => captureMacLocalDatabaseRolesV1({ ...roles, queueWorker: { ...roles.queueWorker, username: roles.coordinator.username } }));
  assert.throws(() => captureMacLocalDatabaseRolesV1({ ...roles, results: { ...roles.results, database: "other_control_room" } }));
});

test("loads the fixed owner-only database-role file", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-mac-local-roles-"));
  t.after(async () => { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); });
  const config = join(root, "config");
  await mkdir(config, { mode: 0o700 });
  const path = join(config, "database-roles.json");
  await writeFile(path, JSON.stringify(roles), { mode: 0o600 }); await chmod(path, 0o600);
  const loaded = await loadMacLocalDatabaseRolesFromRootV1(root);
  assert.equal(loaded.results.username, "control_room_results");
  await chmod(path, 0o644);
  await assert.rejects(loadMacLocalDatabaseRolesFromRootV1(root));
});
