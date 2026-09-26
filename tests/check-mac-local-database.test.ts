import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles";
import { checkMacLocalDatabaseV1, type MacLocalDatabaseCheckRuntimeV1 } from "../scripts/mac-local/check-database";

const connection = (username: string) => ({ host: "127.0.0.1", port: 5432, database: "control_room", username,
  password: `${username}-test-password`, majorVersion: 17 as const });
const roles = Object.freeze({ schema: MAC_LOCAL_DATABASE_ROLES_V1, web: connection("control_room_web"),
  coordinator: connection("control_room_coordinator"), results: connection("control_room_results"),
  publisher: connection("control_room_publisher"), queueWorker: connection("control_room_queue_worker") });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acr-mac-local-check-"));
  const config = join(root, "config");
  await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, "database-roles.json"), JSON.stringify(roles), { mode: 0o600 });
  await chmod(join(config, "database-roles.json"), 0o600);
  return root;
}

function runtime(lines: string[], options: { roleOk?: boolean; fail?: boolean; failUsername?: string;
  onOpen?: (username: string) => void } = {}): MacLocalDatabaseCheckRuntimeV1 {
  const verify: MacLocalDatabaseCheckRuntimeV1["verify"] = {
    web: async () => {}, coordinator: async () => {}, results: async () => {}, publisher: async () => {}, queueWorker: async () => {},
  };
  return {
    deniedWrite: async () => "denied" as const,
    loadRoles: async () => roles,
    loadConfiguration: async () => ({ localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1,
      origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local", provider: "local-owner", subject: "owner:local",
      ownerCodeDigest: sha256Digest({ fixture: "owner-code" }), sessionSeconds: 900 },
      workspaceId: "workspace:mac-local" }),
    verify,
    report: (line: string) => lines.push(line),
    openDatabase: configuration => {
      options.onOpen?.(configuration.username);
      const client: DatabaseClient = {
        query: async <T = Record<string, unknown>>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> => {
        if (options.fail) throw new Error("private detail");
        if (configuration.username === options.failUsername) throw new Error("private detail");
        if (sql === "SELECT current_user=$1 AND session_user=$1 AS role_ok") {
          // The check's only projected row is the explicit role_ok alias.
          const row = { role_ok: options.roleOk ?? true };
          return { rows: [row as T] };
        }
        return { rows: [] };
      },
        async transaction<T>(work: (tx: DatabaseSession) => Promise<T>) { return work(client); },
        async transactionWithPreCommitCheck<T>(work: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) {
          const result = await work(client); await check(); return result;
        },
      };
      return { client, close: async () => {}, isAvailable: () => true };
    },
  };
}

test("checks each fixed Mac-local role without printing any protected connection value", async () => {
  const lines: string[] = [];
  assert.equal(await checkMacLocalDatabaseV1("/protected", runtime(lines)), 0);
  assert.deepEqual(lines, ["web", "coordinator", "results", "publisher", "queueWorker"].map(name =>
    `${name} least privilege: ok`));
  assert.equal(lines.join("\n").includes("test-password"), false);
});

test("reports a single refusal for an unreadable protected role map", async () => {
  const lines: string[] = [];
  assert.equal(await checkMacLocalDatabaseV1("/protected", { ...runtime(lines), loadRoles: async () => { throw new Error("detail"); } }), 1);
  assert.deepEqual(lines, ["database_check_refused"]);
});

test("continues checking other roles after one read-only connection refusal", async () => {
  const lines: string[] = [], opened: string[] = [];
  const testRuntime = runtime(lines, { failUsername: "control_room_results", onOpen: username => opened.push(username) });
  assert.equal(await checkMacLocalDatabaseV1("/protected", testRuntime), 1);
  assert.deepEqual(opened, ["control_room_web", "control_room_coordinator", "control_room_results", "control_room_publisher", "control_room_queue_worker"]);
  assert.deepEqual(lines, ["web", "coordinator", "results", "publisher", "queueWorker"].map(name =>
    name === "results" ? "results database_check_refused" : `${name} least privilege: ok`));
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

test("refuses a newly allowed forbidden write even when the privilege checker is mocked green", async () => {
  const lines: string[] = [];
  const value = { ...runtime(lines), deniedWrite: async () => "allowed" as const };
  assert.equal(await checkMacLocalDatabaseV1("/protected", value), 1);
  assert.deepEqual(lines, ["web", "coordinator", "results", "publisher", "queueWorker"].map(name => `${name} database_check_refused`));
});

test("each role's probe is a write outside its grants, sent with that role's own connection", async () => {
  const lines: string[] = [], probes: string[] = [];
  const value = { ...runtime(lines), deniedWrite: async (configuration: typeof roles.web, statement: string) => {
    probes.push(`${configuration.username}: ${statement}`); return "denied" as const; } };
  assert.equal(await checkMacLocalDatabaseV1("/protected", value), 0);
  assert.deepEqual(probes, [
    "control_room_web: DELETE FROM tenants WHERE false",
    "control_room_coordinator: UPDATE control_jobs SET result_lock=result_lock WHERE false",
    "control_room_results: UPDATE control_jobs SET state=state WHERE false",
    "control_room_publisher: UPDATE control_harness_runs SET native_session_key_digest=native_session_key_digest WHERE false",
    "control_room_queue_worker: UPDATE control_room_queue.queue SET name=name WHERE false"]);
});

test("refuses when the denied-write probe cannot reach a verdict", async () => {
  const lines: string[] = [];
  assert.equal(await checkMacLocalDatabaseV1("/protected", { ...runtime(lines), deniedWrite: async () => "error" as const }), 1);
  assert.deepEqual(lines, ["web", "coordinator", "results", "publisher", "queueWorker"].map(name => `${name} database_check_refused`));
});
