// Verifies one bound backup only by restoring it into a new temp PostgreSQL 17
// cluster. The cluster is stopped and removed on every success or failure path.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { restoreDatabase } from "../../deploy/postgres/restore-database.mjs";
import { DISPOSABLE_POSTGRES_MARKER } from "../dev/cleanup-test-postgres.mjs";
import { diffMacGrantsV1, readDesiredMacGrantsV1, readMacGrantCatalogV1 } from "../mac-local/database-upgrade-grants.mjs";
import { MAC_BACKUP_REQUIRED_TABLES_V1, VERIFIED_BACKUP_MANIFEST_V1 } from "./backup-database.mjs";

const sha256File = async path => `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
const identifier = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const quote = value => { if (!identifier(value)) throw new Error("database_backup_role_refused"); return `"${value}"`; };

async function readBoundBackup(backup) {
  if (typeof backup !== "string" || !isAbsolute(backup) || resolve(backup) !== backup)
    throw new Error("database_backup_path_refused");
  const paths = { dump: join(backup, "database.dump"), metadata: join(backup, "metadata.json"), manifest: join(backup, "manifest.json") };
  for (const path of Object.values(paths)) {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1) throw new Error("database_backup_file_refused");
  }
  const [manifest, metadata] = await Promise.all([
    readFile(paths.manifest, "utf8").then(JSON.parse), readFile(paths.metadata, "utf8").then(JSON.parse),
  ]);
  if (manifest.schema !== VERIFIED_BACKUP_MANIFEST_V1 || manifest.dumpDigest !== await sha256File(paths.dump)
    || manifest.metadataDigest !== await sha256File(paths.metadata)
    || manifest.restoreIdentityDigest !== metadata.identity?.identityDigest
    || manifest.ledger?.digest !== metadata.ledgerDigest
    || JSON.stringify(manifest.requiredTables) !== JSON.stringify(MAC_BACKUP_REQUIRED_TABLES_V1))
    throw new Error("database_backup_digest_refused");
  const head = metadata.evidence?.ledger?.at(-1);
  if (!head || manifest.ledger.head.order !== head.ledger_order || manifest.ledger.head.file !== head.filename
    || manifest.ledger.head.digest !== head.digest) throw new Error("database_backup_ledger_head_refused");
  if (!Array.isArray(metadata.evidence?.roles) || metadata.evidence.roles.length < 1)
    throw new Error("database_backup_roles_refused");
  return { manifest, metadata };
}

function native(pgBin, name, args, options = {}) {
  return execFileSync(join(pgBin, name), args, { encoding: "utf8", timeout: 180_000,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", ...options.env }, ...options });
}

async function createRecordedRoles(client, roles) {
  for (const role of roles) {
    if (!identifier(role?.rolname) || ["rolcanlogin", "rolcreatedb", "rolcreaterole", "rolsuper", "rolreplication", "rolbypassrls"]
      .some(key => typeof role[key] !== "boolean")) throw new Error("database_backup_roles_refused");
    await client.query(`CREATE ROLE ${quote(role.rolname)} ${role.rolcanlogin ? "LOGIN" : "NOLOGIN"} INHERIT `
      + `${role.rolsuper ? "SUPERUSER" : "NOSUPERUSER"} ${role.rolcreatedb ? "CREATEDB" : "NOCREATEDB"} `
      + `${role.rolcreaterole ? "CREATEROLE" : "NOCREATEROLE"} ${role.rolreplication ? "REPLICATION" : "NOREPLICATION"} `
      + `${role.rolbypassrls ? "BYPASSRLS" : "NOBYPASSRLS"}`);
  }
}

async function verifyOwnership(client) {
  const { rows } = await client.query(`
    SELECT kind,name,owner FROM (
      SELECT 'relation' AS kind,n.nspname||'.'||c.relname AS name,pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','control_room_queue') AND c.relkind IN ('r','p','S','v','m','f')
      UNION ALL
      SELECT 'function',n.nspname||'.'||p.proname,pg_get_userbyid(p.proowner)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','control_room_queue')
      UNION ALL
      SELECT 'schema',n.nspname,pg_get_userbyid(n.nspowner)
        FROM pg_namespace n WHERE n.nspname IN ('public','control_room_queue')
    ) objects WHERE owner <> 'control_room_schema_owner' ORDER BY kind,name`);
  if (rows.length > 0) throw new Error("database_backup_owner_refused");
}

export async function verifyMacLocalDatabaseBackupV1({ backup, port, pgBin = "/opt/homebrew/bin" }) {
  if (!Number.isInteger(port) || port < 15620 || port > 15649 || typeof pgBin !== "string" || !isAbsolute(pgBin))
    throw new Error("database_backup_verification_arguments_refused");
  const bound = await readBoundBackup(backup);
  const root = await mkdtemp(join(tmpdir(), "control-room-backup-verify-"));
  const data = join(root, "pg"), socket = join(root, "socket"), log = join(root, "postgres.log");
  let started = false;
  const stop = () => {
    if (!started) return;
    try { native(pgBin, "pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]); } catch {}
    started = false;
  };
  const onSignal = () => { stop(); process.exitCode = 1; };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    await mkdir(socket, { mode: 0o700 });
    native(pgBin, "initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
    await writeFile(join(data, DISPOSABLE_POSTGRES_MARKER), `${JSON.stringify({
      schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal",
    })}\n`, { mode: 0o600, flag: "wx" });
    native(pgBin, "pg_ctl", ["-D", data, "-l", log, "-w", "-t", "30", "-o",
      `-k ${socket} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
    started = true;
    const admin = new Client({ host: socket, port, database: "postgres", user: "postgres" });
    await admin.connect();
    try {
      await createRecordedRoles(admin, bound.metadata.evidence.roles);
      await admin.query("CREATE DATABASE control_room");
    } finally { await admin.end(); }
    const target = { host: socket, port, database: "control_room", user: "postgres" };
    const restored = await restoreDatabase({ backup, target, confirmTarget: { ...target }, pgBin,
      requiredTables: MAC_BACKUP_REQUIRED_TABLES_V1 });
    if (restored.identityDigest !== bound.manifest.restoreIdentityDigest) throw new Error("database_backup_identity_refused");
    const client = new Client(target); await client.connect();
    try {
      // pg_restore --no-owner intentionally creates non-relation objects as
      // the disposable administrator. Move those restored objects to the one
      // recorded schema owner before proving the owner invariant.
      await client.query("REASSIGN OWNED BY postgres TO control_room_schema_owner");
      await client.query("ALTER SCHEMA public OWNER TO control_room_schema_owner");
      await client.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='control_room_queue') THEN
          ALTER SCHEMA control_room_queue OWNER TO control_room_schema_owner;
        END IF;
      END $$`);
      await verifyOwnership(client);
      const diff = diffMacGrantsV1(await readMacGrantCatalogV1(client), await readDesiredMacGrantsV1());
      if (diff.extra.length > 0 || diff.missing.length > 0) throw new Error("database_backup_mac_grants_refused");
    } finally { await client.end(); }
    return Object.freeze({ verified: true, identityDigest: restored.identityDigest,
      ledgerHead: Object.freeze({ ...bound.manifest.ledger.head }) });
  } finally {
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    stop();
    await rm(root, { recursive: true, force: true });
  }
}

function flag(args, name) { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), backup = flag(args, "--backup"), pgBin = flag(args, "--pg-bin"), port = Number(flag(args, "--port"));
    if (!backup || !Number.isInteger(port) || args.some((value, index) => index % 2 === 0 && !["--backup", "--port", "--pg-bin"].includes(value)))
      throw new Error("usage: verify-database-backup.mjs --backup ABSOLUTE_DIRECTORY --port 15620..15649 [--pg-bin ABSOLUTE_DIRECTORY]");
    const result = await verifyMacLocalDatabaseBackupV1({ backup, port, ...(pgBin ? { pgBin } : {}) });
    console.log(`database backup verification PASS: ${result.identityDigest}`);
  } catch (error) {
    console.error(`database backup verification FAIL: ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
  }
}
