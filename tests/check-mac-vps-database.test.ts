import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMacVpsDatabase } from "../scripts/check-mac-vps-database";

const root = await mkdtemp(join(tmpdir(), "acr-db-check-"));
const digest = "a".repeat(64);
const config = { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web",
  majorVersion: 17, passwordFile: join(root, "password") };

async function secure(path: string, contents: string) { await writeFile(path, contents, { mode: 0o600 }); await chmod(path, 0o600); }
async function fixture(value: unknown, mode = 0o600) {
  const file = join(root, `config-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(file, JSON.stringify(value), { mode }); await chmod(file, mode); return file;
}
function runtime(lines: string[], options: { ledger?: unknown; roleOk?: boolean; failQuery?: boolean } = {}) {
  return {
    readFile: async (path: string, encoding: BufferEncoding) => {
      if (path.endsWith("migration-ledger.json")) return JSON.stringify(options.ledger ?? { entries: [{ file: "db/migrations/1.sql", sha256: digest, order: 1 }] });
      return await (await import("node:fs/promises")).readFile(path, encoding);
    },
    lstat: (path: string) => import("node:fs/promises").then(fs => fs.lstat(path)),
    report: (line: string) => lines.push(line),
    openDatabase: () => ({
      client: { query: async (sql: string) => {
        if (options.failQuery) throw new Error("no private detail");
        if (sql.includes("current_user")) return { rows: [{ role_ok: options.roleOk ?? true }] };
        if (sql.includes("control_room_schema_migrations")) return { rows: [{ filename: "db/migrations/1.sql", digest: `sha256:${digest}`, ledger_order: 1 }] };
        return { rows: [] };
      } }, close: async () => {}, isAvailable: () => true,
    }),
  } as never;
}

test("checks each protected role without printing its password", async () => {
  await secure(config.passwordFile, "this-is-a-secret-password");
  const path = await fixture({ schema: "control-room.mac-local-database-check/v1", roles: { web: config, coordinator: { ...config, username: "control_room_task_coordinator" } } });
  const lines: string[] = [];
  assert.equal(await checkMacVpsDatabase(path, runtime(lines)), 0);
  assert.deepEqual(lines, ["web ok (generic; web ACL check deferred to W3)", "coordinator ok"]);
  assert.equal(lines.join("\n").includes("this-is-a-secret-password"), false);
});

test("refuses an owner configuration that is readable by other users", async () => {
  const path = await fixture({ schema: "control-room.mac-local-database-check/v1", roles: { web: config } }, 0o644);
  const lines: string[] = [];
  assert.equal(await checkMacVpsDatabase(path, runtime(lines)), 1);
  assert.deepEqual(lines, ["configuration_file_insecure"]);
});

test("refuses malformed role settings and an insecure password reference", async () => {
  const lines: string[] = [];
  const malformed = await fixture({ schema: "control-room.mac-local-database-check/v1", roles: { web: { ...config, port: 0 } } });
  assert.equal(await checkMacVpsDatabase(malformed, runtime(lines)), 1);
  assert.deepEqual(lines, ["web configuration_invalid"]);
  const insecure = join(root, "insecure-password"); await writeFile(insecure, "secret", { mode: 0o644 }); await chmod(insecure, 0o644);
  const path = await fixture({ schema: "control-room.mac-local-database-check/v1", roles: { web: { ...config, passwordFile: insecure } } });
  lines.length = 0;
  assert.equal(await checkMacVpsDatabase(path, runtime(lines)), 1);
  assert.deepEqual(lines, ["web password_file_insecure"]);
});

test("refuses a migration ledger mismatch without retrying", async () => {
  const path = await fixture({ schema: "control-room.mac-local-database-check/v1", roles: { web: config } });
  const lines: string[] = [];
  assert.equal(await checkMacVpsDatabase(path, runtime(lines, { ledger: { entries: [] } })), 1);
  assert.deepEqual(lines, ["web migration_ledger_mismatch"]);
});
