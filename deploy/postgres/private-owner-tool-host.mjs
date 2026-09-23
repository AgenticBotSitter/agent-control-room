// Private child host for the two existing JavaScript PostgreSQL tools. The
// parent supplies one length-prefixed JSON request on stdin. This host verifies
// every reviewed release file again, writes an `entered` frame before invoking
// either fixed export, and returns only a bounded result frame. It never reads
// configuration from argv or mutates process.env.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PROTOCOL = "control-room.private-postgres-owner-tool-host/v1";
const MAXIMUM_INPUT_BYTES = 256 * 1024;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEPENDENCY_MANIFEST = "deploy/postgres/private-owner-dependency-manifest.json";
const FILES = Object.freeze([
  "deploy/postgres/provision-database.sql",
  "deploy/postgres/apply-migrations.mjs",
  "deploy/postgres/evidence.mjs",
  "deploy/postgres/migration-ledger.json",
]);
const digestPattern = /^[a-f0-9]{64}$/u;
const fullDigestPattern = /^sha256:[a-f0-9]{64}$/u;
const DEPENDENCY_VERSIONS = Object.freeze({ pg: "8.23.0", "pg-cloudflare": "1.4.0",
  "pg-connection-string": "2.14.0", "pg-int8": "1.0.1", "pg-pool": "3.14.0", "pg-protocol": "1.16.0",
  "pg-types": "2.2.0", pgpass: "1.0.5", "postgres-array": "2.0.0", "postgres-bytea": "1.0.1",
  "postgres-date": "1.0.7", "postgres-interval": "1.2.0", split2: "4.2.0", xtend: "4.0.2" });

function exact(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) throw new Error();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))
    || keys.some(name => !names.includes(name) || Object.getOwnPropertyDescriptor(value, name)?.enumerable !== true
      || !("value" in Object.getOwnPropertyDescriptor(value, name)))) throw new Error();
  return value;
}

function exactArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Object.getOwnPropertySymbols(value).length !== 0) throw new Error();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names[value.length] !== "length") throw new Error();
  return value.map((entry, index) => {
    if (names[index] !== String(index)) throw new Error();
    return entry;
  });
}

function fixedRelativePath(value, expected) {
  if (value !== expected || isAbsolute(value) || normalize(value) !== value || value.startsWith("..")
    || value.includes(`..${sep}`) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error();
  return value;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function capturedBytes(root, relativePath, expectedDigest, maximum = 32 * 1024 * 1024) {
  const path = join(root, relativePath), canonicalRoot = await realpath(root);
  if (!inside(root, path) || await realpath(path) !== join(canonicalRoot, relativePath)) throw new Error();
  let handle, bytes;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat(), named = await stat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum
      || before.uid !== process.geteuid() || (before.mode & 0o777) !== 0o600
      || before.dev !== named.dev || before.ino !== named.ino) throw new Error();
    bytes = Buffer.alloc(before.size); let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(bytes, position, Math.min(64 * 1024, before.size - position), position);
      if (bytesRead < 1) throw new Error();
      position += bytesRead;
    }
    const after = await handle.stat(), namedAfter = await stat(path);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.dev !== namedAfter.dev || before.ino !== namedAfter.ino || before.size !== namedAfter.size
      || await realpath(path) !== join(canonicalRoot, relativePath) || digest !== expectedDigest) throw new Error();
    const result = bytes; bytes = undefined; return result;
  } finally { bytes?.fill(0); await handle?.close(); }
}

async function hashReviewedFile(root, binding) {
  const record = exact(binding, ["path", "sha256"]);
  if (!FILES.includes(record.path) || typeof record.sha256 !== "string" || !digestPattern.test(record.sha256)) throw new Error();
  const bytes = await capturedBytes(root, record.path, `sha256:${record.sha256}`);
  bytes.fill(0);
}

async function verifyRelease(root, files) {
  if (!isAbsolute(root) || normalize(root) !== root || !(await stat(root)).isDirectory()) throw new Error();
  const bindings = exactArray(files, FILES.length);
  if (bindings.length !== FILES.length) throw new Error();
  for (let index = 0; index < FILES.length; index += 1) {
    if (bindings[index]?.path !== FILES[index]) throw new Error();
    await hashReviewedFile(root, bindings[index]);
  }
}

async function verifyDependencies(root, expectedDigest) {
  if (!fullDigestPattern.test(expectedDigest)) throw new Error();
  const bytes = await capturedBytes(root, DEPENDENCY_MANIFEST, expectedDigest, 4 * 1024 * 1024);
  try {
    const manifest = exact(JSON.parse(bytes.toString("utf8")), ["schema", "packages", "files"]);
    if (manifest.schema !== "control-room.private-postgres-dependency-manifest/v1") throw new Error();
    const packages = exactArray(manifest.packages, 256), packageNames = new Set();
    for (const value of packages) {
      const record = exact(value, ["name", "version"]);
      if (typeof record.name !== "string" || record.version !== DEPENDENCY_VERSIONS[record.name]
        || packageNames.has(record.name)) throw new Error();
      packageNames.add(record.name);
    }
    if (packageNames.size !== Object.keys(DEPENDENCY_VERSIONS).length) throw new Error();
    const files = exactArray(manifest.files, 10_000), paths = new Set();
    for (const value of files) {
      const record = exact(value, ["path", "sha256"]);
      if (typeof record.path !== "string" || !record.path.startsWith("node_modules/")
        || isAbsolute(record.path) || normalize(record.path) !== record.path || record.path.startsWith("..")
        || typeof record.sha256 !== "string" || !digestPattern.test(record.sha256) || paths.has(record.path)) throw new Error();
      paths.add(record.path);
      const dependencyBytes = await capturedBytes(root, record.path, `sha256:${record.sha256}`);
      dependencyBytes.fill(0);
    }
    for (const name of packageNames) if (!paths.has(`node_modules/${name}/package.json`)) throw new Error();
  } finally { bytes.fill(0); }
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAXIMUM_OUTPUT_BYTES) throw new Error();
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

async function writeFrame(value) {
  const bytes = frame(value);
  await new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
}

async function readFrame() {
  const chunks = []; let count = 0;
  for await (const chunk of process.stdin) {
    count += chunk.length;
    if (count > MAXIMUM_INPUT_BYTES + 4) throw new Error();
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== bytes.length - 4 || bytes.length - 4 > MAXIMUM_INPUT_BYTES) throw new Error();
  const payload = bytes.subarray(4), text = payload.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(payload) || text.includes("\0")) throw new Error();
  return JSON.parse(text);
}

function target(value) {
  const input = exact(value, ["host", "port", "database", "user", "password", "ssl", "sslnegotiation",
    "client_encoding", "replication", "target_session_attrs", "application_name", "options", "statement_timeout",
    "lock_timeout", "idle_in_transaction_session_timeout", "connectionTimeoutMillis", "keepAlive", "binary"]);
  if (input.host !== "127.0.0.1" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535
    || input.ssl !== false || input.sslnegotiation !== "postgres" || input.client_encoding !== "UTF8"
    || input.replication !== "false" || input.target_session_attrs !== "primary" || input.keepAlive !== true
    || input.binary !== false || input.options !== "-c search_path=pg_catalog,\\ public -c timezone=UTC"
    || input.statement_timeout !== 120000 || input.lock_timeout !== 5000
    || input.idle_in_transaction_session_timeout !== 15000 || input.connectionTimeoutMillis !== 5000) throw new Error();
  for (const name of ["database", "user"]) if (typeof input[name] !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(input[name])) throw new Error();
  if (typeof input.password !== "string" || input.password.length < 24 || input.password.length > 4096 || input.password.includes("\0")) throw new Error();
  return Object.freeze({ ...input });
}

function requestEnvelope(value) {
  const envelope = exact(value, ["protocol", "request"]);
  if (envelope.protocol !== PROTOCOL) throw new Error();
  const operation = envelope.request?.operation;
  if (operation === "apply_migrations") {
    const request = exact(envelope.request, ["schema", "releaseDigest", "requestDigest", "files", "operation", "module",
      "exportName", "environmentMode", "bootstrapTarget", "migrateTarget", "ledgerPath", "env"]);
    if (request.schema !== "control-room.private-postgres-owner-adapter/v1"
      || request.module !== "deploy/postgres/apply-migrations.mjs" || request.exportName !== "applyMigrations"
      || request.environmentMode !== "replace" || request.ledgerPath !== "deploy/postgres/migration-ledger.json"
      || typeof request.releaseDigest !== "string" || !fullDigestPattern.test(request.releaseDigest)
      || typeof request.requestDigest !== "string" || !fullDigestPattern.test(request.requestDigest)) throw new Error();
    const env = exact(request.env, ["CONTROL_ROOM_MIGRATOR_PASSWORD", "CONTROL_ROOM_APP_PASSWORD", "CONTROL_ROOM_SCHEDULER_PASSWORD"]);
    for (const name of Object.keys(env)) if (typeof env[name] !== "string" || env[name].length < 24
      || env[name].length > 4096 || env[name].includes("\0")) throw new Error();
    const bootstrapTarget = target(request.bootstrapTarget), migrateTarget = target(request.migrateTarget);
    if (bootstrapTarget.application_name !== "control-room-owner-bootstrap"
      || migrateTarget.application_name !== "control-room-owner-migrate" || migrateTarget.user !== "control_room_migrator"
      || bootstrapTarget.host !== migrateTarget.host || bootstrapTarget.port !== migrateTarget.port
      || bootstrapTarget.database !== migrateTarget.database
      || env.CONTROL_ROOM_MIGRATOR_PASSWORD !== migrateTarget.password) throw new Error();
    return { operation, request, bootstrapTarget, migrateTarget, env };
  }
  if (operation === "collect_evidence") {
    const request = exact(envelope.request, ["schema", "releaseDigest", "requestDigest", "files", "operation", "module",
      "exportName", "environmentMode", "env", "target", "requiredTables"]);
    if (request.schema !== "control-room.private-postgres-owner-adapter/v1"
      || request.module !== "deploy/postgres/evidence.mjs" || request.exportName !== "collectDatabaseEvidence"
      || request.environmentMode !== "replace" || Object.keys(exact(request.env, [])).length !== 0
      || typeof request.releaseDigest !== "string" || !fullDigestPattern.test(request.releaseDigest)
      || typeof request.requestDigest !== "string" || !fullDigestPattern.test(request.requestDigest)) throw new Error();
    const requiredTables = exactArray(request.requiredTables, 64);
    if (requiredTables.length < 1 || requiredTables.some(table => typeof table !== "string"
      || !/^[a-z][a-z0-9_]{0,62}$/u.test(table)) || new Set(requiredTables).size !== requiredTables.length) throw new Error();
    const evidenceTarget = target(request.target);
    if (evidenceTarget.application_name !== "control-room-owner-evidence"
      || evidenceTarget.user !== "control_room_migrator") throw new Error();
    return { operation, request, target: evidenceTarget, requiredTables };
  }
  throw new Error();
}

async function main() {
  let entered = false;
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--dependency-manifest-sha256"
      || !fullDigestPattern.test(process.argv[3])) throw new Error();
    const captured = requestEnvelope(await readFrame()), root = process.cwd();
    await verifyRelease(root, captured.request.files);
    await verifyDependencies(root, process.argv[3]);
    const modulePath = fixedRelativePath(captured.request.module,
      captured.operation === "apply_migrations" ? FILES[1] : FILES[2]);
    // The callback fires only after the frame has been accepted by stdout. The
    // parent can therefore classify every module import or dependency-loader
    // side effect as post-entry uncertainty.
    await writeFrame({ protocol: PROTOCOL, type: "entered", operation: captured.operation });
    entered = true;
    const loaded = await import(pathToFileURL(join(root, modulePath)).href);
    const callable = loaded[captured.request.exportName];
    if (typeof callable !== "function") throw new Error();
    const result = captured.operation === "apply_migrations"
      ? await callable({ bootstrapTarget: captured.bootstrapTarget, migrateTarget: captured.migrateTarget,
        rootDir: root, ledgerPath: captured.request.ledgerPath, env: captured.env })
      : await callable(captured.target, { requiredTables: captured.requiredTables });
    await writeFrame({ protocol: PROTOCOL, type: "result", operation: captured.operation, result });
  } catch {
    try { await writeFrame({ protocol: PROTOCOL, type: entered ? "uncertain" : "refused_before_entry" }); }
    catch { /* parent classifies a missing reply conservatively */ }
    process.exitCode = entered ? 1 : 2;
  }
}

await main();
