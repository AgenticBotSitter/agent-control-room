import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const host = new URL("../deploy/postgres/private-owner-tool-host.mjs", import.meta.url).pathname;
const protocol = "control-room.private-postgres-owner-tool-host/v1";
const paths = ["deploy/postgres/provision-database.sql", "deploy/postgres/apply-migrations.mjs",
  "deploy/postgres/evidence.mjs", "deploy/postgres/migration-ledger.json"];
const dependencyVersions = { pg: "8.23.0", "pg-cloudflare": "1.4.0", "pg-connection-string": "2.14.0",
  "pg-int8": "1.0.1", "pg-pool": "3.14.0", "pg-protocol": "1.16.0", "pg-types": "2.2.0",
  pgpass: "1.0.5", "postgres-array": "2.0.0", "postgres-bytea": "1.0.1", "postgres-date": "1.0.7",
  "postgres-interval": "1.2.0", split2: "4.2.0", xtend: "4.0.2" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function target(application_name) {
  return { host: "127.0.0.1", port: 5432, database: "control_room", user: "control_room_migrator",
    password: "migrator-password-000000000000", ssl: false, sslnegotiation: "postgres", client_encoding: "UTF8",
    replication: "false", target_session_attrs: "primary", application_name,
    options: "-c search_path=pg_catalog,\\ public -c timezone=UTC", statement_timeout: 120000, lock_timeout: 5000,
    idle_in_transaction_session_timeout: 15000, connectionTimeoutMillis: 5000, keepAlive: true, binary: false };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-pg-host-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "deploy/postgres"), { recursive: true, mode: 0o700 });
  const contents = new Map([
    [paths[0], "-- inert fixture\n"],
    [paths[1], "export async function applyMigrations(input) { return { planned:false, applied:[], noOp:true, schemaDigest:'sha256:'+'a'.repeat(64), objects:0, logins:'applied', grants:'applied', sawRoot: typeof input.rootDir === 'string' }; }\n"],
    [paths[2], "export async function collectDatabaseEvidence(_target, options) { return { databaseOwner:'control_room_schema_owner', requiredTables:options.requiredTables }; }\n"],
    [paths[3], "{}\n"],
  ]);
  for (const [path, text] of contents) await writeFile(join(root, path), text, { mode: 0o600 });
  const files = paths.map(path => ({ path, sha256: hash(Buffer.from(contents.get(path))) }));
  const packages = [], dependencyFiles = [];
  for (const [name, version] of Object.entries(dependencyVersions)) {
    await mkdir(join(root, "node_modules", name), { recursive: true, mode: 0o700 });
    const packageJson = `${JSON.stringify({ name, version })}\n`, path = `node_modules/${name}/package.json`;
    await writeFile(join(root, path), packageJson, { mode: 0o600 });
    packages.push({ name, version }); dependencyFiles.push({ path, sha256: hash(Buffer.from(packageJson)) });
  }
  const manifest = `${JSON.stringify({ schema: "control-room.private-postgres-dependency-manifest/v1",
    packages, files: dependencyFiles })}\n`;
  const manifestPath = join(root, "deploy/postgres/private-owner-dependency-manifest.json");
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  return { root, files, manifestDigest: `sha256:${hash(Buffer.from(manifest))}` };
}

function encode(value) {
  const payload = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
function decode(bytes) {
  const frames = []; let offset = 0;
  while (offset < bytes.length) { const length = bytes.readUInt32BE(offset); offset += 4;
    frames.push(JSON.parse(bytes.subarray(offset, offset + length).toString("utf8"))); offset += length; }
  return frames;
}
async function invoke(root, manifestDigest, request) {
  const child = spawn(process.execPath, [host, "--dependency-manifest-sha256", manifestDigest], { shell: false, cwd: root,
    env: { NODE_ENV: "production", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk))); child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  child.stdin.end(encode({ protocol, request }));
  const [code, signal] = await new Promise(resolve => child.once("close", (code, signal) => resolve([code, signal])));
  return { code, signal, frames: decode(Buffer.concat(stdout)), stderr: Buffer.concat(stderr).toString("utf8") };
}

test("private owner tool host frames entry before the fixed migration export and returns only its result", async t => {
  const f = await fixture(t), secret = "migrator-password-000000000000";
  const request = { schema: "control-room.private-postgres-owner-adapter/v1", releaseDigest: `sha256:${"b".repeat(64)}`,
    requestDigest: `sha256:${"c".repeat(64)}`, files: f.files, operation: "apply_migrations",
    module: paths[1], exportName: "applyMigrations", environmentMode: "replace",
    bootstrapTarget: target("control-room-owner-bootstrap"), migrateTarget: target("control-room-owner-migrate"),
    ledgerPath: paths[3], env: { CONTROL_ROOM_MIGRATOR_PASSWORD: secret,
      CONTROL_ROOM_APP_PASSWORD: "application-password-0000000000",
      CONTROL_ROOM_SCHEDULER_PASSWORD: "scheduler-password-000000000000" } };
  const result = await invoke(f.root, f.manifestDigest, request);
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.stderr, "");
  assert.deepEqual(result.frames.map(frame => frame.type), ["entered", "result"]);
  assert.equal(result.frames[1].result.sawRoot, true);
  assert.doesNotMatch(JSON.stringify(result.frames), new RegExp(secret));
});

test("release drift is an explicit pre-entry refusal and never imports the changed module", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, paths[1]), "throw new Error('must not import');\n", { mode: 0o600 });
  const request = { schema: "control-room.private-postgres-owner-adapter/v1", releaseDigest: `sha256:${"b".repeat(64)}`,
    requestDigest: `sha256:${"c".repeat(64)}`, files: f.files, operation: "collect_evidence",
    module: paths[2], exportName: "collectDatabaseEvidence", environmentMode: "replace", env: {},
    target: target("control-room-owner-evidence"), requiredTables: ["tenants"] };
  const result = await invoke(f.root, f.manifestDigest, request);
  assert.equal(result.code, 2); assert.deepEqual(result.frames.map(frame => frame.type), ["refused_before_entry"]);
  assert.equal(result.stderr, "");
});

test("dependency drift is refused before the production module import can run", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "node_modules/pg/package.json"), "{}\n", { mode: 0o600 });
  const request = { schema: "control-room.private-postgres-owner-adapter/v1", releaseDigest: `sha256:${"b".repeat(64)}`,
    requestDigest: `sha256:${"c".repeat(64)}`, files: f.files, operation: "collect_evidence",
    module: paths[2], exportName: "collectDatabaseEvidence", environmentMode: "replace", env: {},
    target: target("control-room-owner-evidence"), requiredTables: ["tenants"] };
  const result = await invoke(f.root, f.manifestDigest, request);
  assert.equal(result.code, 2); assert.deepEqual(result.frames.map(frame => frame.type), ["refused_before_entry"]);
  assert.equal(result.stderr, "");
});

test("a failure after the fixed export is entered is framed only as uncertainty", async t => {
  const f = await fixture(t), privateText = "database error contains private-password-000000";
  const throwing = `export async function collectDatabaseEvidence() { throw new Error(${JSON.stringify(privateText)}); }\n`;
  await writeFile(join(f.root, paths[2]), throwing, { mode: 0o600 });
  f.files[2] = { path: paths[2], sha256: hash(Buffer.from(throwing)) };
  const request = { schema: "control-room.private-postgres-owner-adapter/v1", releaseDigest: `sha256:${"b".repeat(64)}`,
    requestDigest: `sha256:${"c".repeat(64)}`, files: f.files, operation: "collect_evidence",
    module: paths[2], exportName: "collectDatabaseEvidence", environmentMode: "replace", env: {},
    target: target("control-room-owner-evidence"), requiredTables: ["tenants"] };
  const result = await invoke(f.root, f.manifestDigest, request);
  assert.equal(result.code, 1); assert.deepEqual(result.frames.map(frame => frame.type), ["entered", "uncertain"]);
  assert.doesNotMatch(JSON.stringify(result), /private-password|database error/u);
});
