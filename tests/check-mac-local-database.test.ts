import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { checkMacLocalDatabaseV1 } from "../scripts/mac-local/check-database";

const connection = (username: string) => ({ host: "127.0.0.1", port: 5432, database: "control_room", username,
  password: `${username}-test-password`, majorVersion: 17 as const });
const roles = Object.freeze({ schema: MAC_LOCAL_DATABASE_ROLES_V1, web: connection("control_room_web"),
  coordinator: connection("control_room_coordinator"), results: connection("control_room_results"),
  queueWorker: connection("control_room_queue_worker") });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acr-mac-local-check-"));
  const config = join(root, "config");
  await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, "database-roles.json"), JSON.stringify(roles), { mode: 0o600 });
  await chmod(join(config, "database-roles.json"), 0o600);
  return root;
}

function runtime(lines: string[], options: { roleOk?: boolean; fail?: boolean } = {}) {
  return {
    loadRoles: async () => roles,
    report: (line: string) => lines.push(line),
    openDatabase: () => ({
      client: { query: async (sql: string) => {
        if (options.fail) throw new Error("private detail");
        if (sql.includes("current_user")) return { rows: [{ role_ok: options.roleOk ?? true }] };
        return { rows: [] };
      } }, close: async () => {}, isAvailable: () => true,
    }),
  } as never;
}

test("checks each fixed Mac-local role without printing any protected connection value", async () => {
  const lines: string[] = [];
  assert.equal(await checkMacLocalDatabaseV1("/protected", runtime(lines)), 0);
  assert.deepEqual(lines, ["web", "coordinator", "results", "queueWorker"].map(name =>
    `${name} connectivity ok (privilege isolation not checked)`));
  assert.equal(lines.join("\n").includes("test-password"), false);
});

test("reports a single refusal for an unreadable protected role map", async () => {
  const lines: string[] = [];
  assert.equal(await checkMacLocalDatabaseV1("/protected", { ...runtime(lines), loadRoles: async () => { throw new Error("detail"); } }), 1);
  assert.deepEqual(lines, ["database_check_refused"]);
});

test("continues checking other roles after one read-only connection refusal", async () => {
  const lines: string[] = [], opened: string[] = [];
  const testRuntime = runtime(lines);
  testRuntime.openDatabase = (configuration: typeof roles.web) => {
    opened.push(configuration.username);
    return {
      client: { query: async (sql: string) => {
        if (configuration.username === "control_room_results") throw new Error("private detail");
        if (sql.includes("current_user")) return { rows: [{ role_ok: true }] };
        return { rows: [] };
      } }, close: async () => {}, isAvailable: () => true,
    } as never;
  };
  assert.equal(await checkMacLocalDatabaseV1("/protected", testRuntime), 1);
  assert.deepEqual(opened, ["control_room_web", "control_room_coordinator", "control_room_results", "control_room_queue_worker"]);
  assert.deepEqual(lines, ["web", "coordinator", "results", "queueWorker"].map(name =>
    name === "results" ? "results database_check_refused" : `${name} connectivity ok (privilege isolation not checked)`));
});

test("the protected role file remains loadable only with owner-only permissions", async t => {
  const root = await fixture();
  t.after(async () => { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); });
  const lines: string[] = [];
  const productionLike = { ...runtime(lines), loadRoles: (path: string) => import("../scripts/mac-local/load-protected-configuration")
    .then(module => module.loadMacLocalDatabaseRolesFromRootV1(path)) };
  assert.equal(await checkMacLocalDatabaseV1(root, productionLike), 0);
  await chmod(join(root, "config", "database-roles.json"), 0o644);
  lines.length = 0;
  assert.equal(await checkMacLocalDatabaseV1(root, productionLike), 1);
  assert.deepEqual(lines, ["database_check_refused"]);
});
