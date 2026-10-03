import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
import { sha256BackupFileV1 as sha256File } from "../../src/installer/shared/backup-files.mjs";
// Verifies one bound backup only by restoring it into a new temp PostgreSQL 17
// cluster. The cluster is stopped and removed on every success or failure path.
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "pg";
import { restoreDatabase } from "../../deploy/postgres/restore-database.mjs";
import { DISPOSABLE_POSTGRES_MARKER } from "../dev/cleanup-test-postgres.mjs";
// The shared disposable-cluster teardown, imported with bare `node` — which is
// why it is `.mjs` and not `.ts`.
import { createClusterTeardown } from "../dev/postgres-cluster-lifecycle.mjs";
import { diffMacGrantsV1, readDesiredMacGrantsV1, readMacGrantCatalogV1 } from "../mac-local/database-upgrade-grants.mjs";
import { MAC_BACKUP_REQUIRED_TABLES_V1, VERIFIED_BACKUP_MANIFEST_V1 } from "./backup-database.mjs";

const identifier = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
const quote = value => { if (!identifier(value)) throw new Error("database_backup_role_refused"); return `"${value}"`; };

/** The disposable range the verifier accepts when nothing overrides it, and the
 * range production and CI use. It is the DEFAULT, not a constant: a caller
 * running under a different assigned range (a local helper, a rehearsal box) has
 * to be able to say so without this module's answer changing for anyone else. */
export const DEFAULT_DATABASE_BACKUP_VERIFICATION_PORT_RANGE_V1 =
  Object.freeze({ min: 15620, max: 15649 });
/** How a caller narrows or moves the range. Unset, empty or whitespace-only
 * means the default, the same reading `tests/helpers/disposable-postgres-cluster.ts`
 * gives `CONTROL_ROOM_TEST_PG_PORT`; anything else must be `MIN-MAX`. */
export const DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV =
  "CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE";
// A disposable PostgreSQL cluster never needs a privileged port, and never needs
// the whole ephemeral space: a range this wide is a typo, not an assignment.
const MIN_UNPRIVILEGED_PORT = 1024;
const MAX_PORT = 65535;
const MAX_PORT_RANGE_SPAN = 1024;
const PORT_RANGE_REFUSED = "database_backup_verification_port_range_refused";
const PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/u;

/** One accepted port block. Exported through the two functions below; the
 * bounds are `number`s here and are proved to be safe integers there, so a
 * caller reading this type learns the shape, not that the values are valid. */
/** @typedef {Readonly<{ min: number, max: number }>} DatabaseBackupVerificationPortRangeV1 */
/** @typedef {Readonly<Record<string, string | undefined>>} DatabaseBackupVerificationEnvV1 */
/** @typedef {(args: readonly string[]) => unknown} DatabaseBackupVerificationPgCtlV1 */
/** The observation seams the tests need, on top of the keys the module decides
 * for itself. The extra `Record` arm is why a caller MAY hand over
 * `dataDirectory`/`port`/`pgBin`/... — they are still ignored at runtime, by the
 * allowlist below, and the test asserts that handing them over changes nothing. */
/** @typedef {Readonly<{ pgCtl?: DatabaseBackupVerificationPgCtlV1,
 *   degradedLogger?: (line: string) => void }> & Readonly<Record<string, unknown>>}
 *   DatabaseBackupVerificationTeardownOptionsV1 */

/** @param {unknown} range
 *  @returns {DatabaseBackupVerificationPortRangeV1} */
function validatedDatabaseBackupVerificationPortRangeV1(range) {
  if (range === null || typeof range !== "object" || Array.isArray(range)) throw new Error(PORT_RANGE_REFUSED);
  const { min, max } = range;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < MIN_UNPRIVILEGED_PORT
    || max > MAX_PORT || min > max || max - min + 1 > MAX_PORT_RANGE_SPAN) throw new Error(PORT_RANGE_REFUSED);
  return Object.freeze({ min, max });
}

/** Parse one `MIN-MAX` range. Strict: two decimal integers in ascending order,
 * both inside the unprivileged port space, and a span narrow enough to be an
 * assignment rather than a mistyped `1-65535`. Everything else is refused, so a
 * bad value in CI is a loud failure instead of a silently wider blast radius.
 * @param {unknown} value
 * @returns {DatabaseBackupVerificationPortRangeV1} */
export function parseDatabaseBackupVerificationPortRangeV1(value) {
  if (typeof value !== "string") throw new Error(PORT_RANGE_REFUSED);
  const match = PORT_RANGE_PATTERN.exec(value.trim());
  if (!match) throw new Error(PORT_RANGE_REFUSED);
  return validatedDatabaseBackupVerificationPortRangeV1({ min: Number(match[1]), max: Number(match[2]) });
}

/** The range in force for a call: the caller's `portRange` when it gave one,
 * otherwise the environment variable, otherwise the documented default.
 * @param {DatabaseBackupVerificationPortRangeV1 | string | undefined} portRange
 * @param {DatabaseBackupVerificationEnvV1} [env]
 * @returns {DatabaseBackupVerificationPortRangeV1} */
export function resolveDatabaseBackupVerificationPortRangeV1(
  portRange, env = process.env) {
  if (portRange !== undefined) {
    return typeof portRange === "string" ? parseDatabaseBackupVerificationPortRangeV1(portRange)
      : validatedDatabaseBackupVerificationPortRangeV1(portRange);
  }
  const raw = env[DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DATABASE_BACKUP_VERIFICATION_PORT_RANGE_V1;
  return parseDatabaseBackupVerificationPortRangeV1(raw);
}

export function databaseBackupVerificationRootPrefixV1(platform = process.platform, temporaryDirectory = tmpdir()) {
  return platform === "darwin" ? "/tmp/crv-" : join(temporaryDirectory, "control-room-backup-verify-");
}

/** Read the immutable binding for one backup before a disposable restore. This
 * deliberately proves only the on-disk binding; a caller must still restore it
 * before describing the backup as verified. */
export async function readBoundMacLocalDatabaseBackupV1(backup) {
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

/**
 * R5B-08. THE GRANT COMPARISON IS A NOTE, NOT A VERDICT.
 *
 * MEASURED FAILURE THIS FIXES. This function compared the RESTORED database's
 * grant catalogue with `readDesiredMacGrantsV1()` — TODAY's checkout's list — and
 * threw `database_backup_mac_grants_refused` on any difference. So a database
 * provisioned before the newest role file existed (`agent_reviewer_roles.sql`,
 * added since `main`) backed up perfectly, and verification reported FAIL listing
 * three grants "missing" that the restored copy had and the SOURCE also had,
 * exactly. `docs/BACKUP_AND_RESTORE.md` tells the owner to treat FAIL as a
 * recovery incident, so one added role file made every earlier backup look like a
 * loss.
 *
 * WHAT ALREADY ANSWERS THE REAL QUESTION. By the time this runs, the restore has
 * been verified field by field against the backup's OWN recorded identity:
 * `restoreDatabase` recomputes `ownersDigest` from the restored catalogue and
 * `verifyRestoredIdentity` refuses on any mismatch. `ownersDigest` is
 * `digestOf(evidence.grants)` — the source's own grant rows, captured inside the
 * backup's SERIALIZABLE snapshot. So "does this backup restore to what it
 * recorded" is ALREADY PROVEN here, against itself. That is the comparison
 * R5B-08 asks for, and it is the one that matters.
 *
 * WHAT IS LEFT IS NOT A VERDICT. The only remaining question is whether this
 * backup predates the CURRENT release's grant list, which is a fact about
 * release history and not a fault in the backup. So it is reported as a NAMED,
 * NON-FAILING note and the verification result stays `verified: true`.
 *
 * The old behaviour is kept callable, and kept STRICT, as
 * `macGrantsMatchCurrentReleaseV1` — so the strict question is still answerable
 * by anyone who wants it, and so removing the refusal from this path cannot be
 * confused with removing the check.
 *
 * @param {{ restored: ReadonlySet<string>, current: ReadonlySet<string> }} sets
 * @returns {{ verified: boolean, notes: readonly string[] }}
 */
export function judgeRestoredMacGrantsV1({ restored, current }) {
  if (!(restored instanceof Set) || !(current instanceof Set)) throw new Error("database_backup_grant_set_refused");
  if (current.size === 0) return Object.freeze({ verified: true, notes: Object.freeze([]) });
  const diff = diffMacGrantsV1(restored, current);
  if (diff.extra.length === 0 && diff.missing.length === 0) return Object.freeze({ verified: true, notes: Object.freeze([]) });
  return Object.freeze({
    verified: true,
    notes: Object.freeze([
      "backup_predates_current_permissions",
      `grants_differ_from_current_release:extra=${diff.extra.length}:missing=${diff.missing.length}`,
    ]),
  });
}

/**
 * The strict comparison R5B-08 removed from the verification PATH, kept as a
 * function so the check still exists and is still testable.
 *
 * @returns {{ matches: boolean, extra: readonly string[], missing: readonly string[] }}
 */
export function macGrantsMatchCurrentReleaseV1({ restored, current }) {
  if (!(restored instanceof Set) || !(current instanceof Set)) throw new Error("database_backup_grant_set_refused");
  const diff = diffMacGrantsV1(restored, current);
  return Object.freeze({ matches: diff.extra.length === 0 && diff.missing.length === 0,
    extra: Object.freeze(diff.extra), missing: Object.freeze(diff.missing) });
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

/** Re-own only restored application objects. Blanket REASSIGN OWNED would also
 * target bootstrap-owned system objects and PostgreSQL correctly refuses it. */
export async function normalizeMacApplicationOwnershipV1(client) {
  const commands = (await client.query(`SELECT command FROM (
    SELECT CASE WHEN c.relkind='S' THEN 2 ELSE 1 END AS phase,
      format('ALTER %s %I.%I OWNER TO control_room_schema_owner',
      CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      n.nspname, c.relname) AS command
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','control_room_queue') AND c.relkind IN ('r','p','S','v','m','f')
      AND NOT (c.relkind='S' AND EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.classid='pg_class'::regclass
          AND d.deptype='i' AND EXISTS (
            SELECT 1 FROM pg_attribute a WHERE a.attrelid=d.refobjid
              AND a.attidentity IN ('a','d') AND a.attnum=d.refobjsubid)))
    UNION ALL
    SELECT 3, format('ALTER %s %I.%I(%s) OWNER TO control_room_schema_owner',
      CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
      n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','control_room_queue') AND p.prokind IN ('f','p','a','w')
    UNION ALL
    SELECT 4, format('ALTER TYPE %I.%I OWNER TO control_room_schema_owner', n.nspname, t.typname)
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname IN ('public','control_room_queue') AND t.typtype IN ('d','e')
    UNION ALL
    SELECT 5, format('ALTER SCHEMA %I OWNER TO control_room_schema_owner', n.nspname)
    FROM pg_namespace n WHERE n.nspname IN ('public','control_room_queue')
  ) application_objects ORDER BY phase,command`)).rows;
  for (const row of commands) {
    if (typeof row.command !== "string" || !row.command.startsWith("ALTER "))
      throw new Error("database_backup_owner_command_refused");
    await client.query(row.command);
  }
}

/** Verify one bound backup by restoring it into a new disposable cluster, then
 * proving the restored database's identity, ownership and grants. The cluster is
 * always stopped and removed, and `PASS` is reported only for the backup's own
 * observed facts.
 *
 * `portRange`/`portRangeEnv` are the seam a caller restricted to a different
 * assigned range uses; with neither, the accepted port block is the documented
 * default and nothing else.
 * @param {{ backup: string, port: number, pgBin?: string,
 *   teardown?: DatabaseBackupVerificationTeardownOptionsV1,
 *   portRange?: DatabaseBackupVerificationPortRangeV1 | string,
 *   portRangeEnv?: DatabaseBackupVerificationEnvV1,
 *   afterRestore?: (context: Readonly<{ target: Readonly<{ host: string, port: number, database: string, user: string }>,
 *     root: string }>) => Promise<void> }} options
 * @returns {Promise<Readonly<{ verified: true, identityDigest: string,
 *   ledgerHead: Readonly<{ order: number, file: string, digest: string }> }>>} */
export async function verifyMacLocalDatabaseBackupV1({ backup, port, pgBin = "/opt/homebrew/bin",
  teardown: teardownOptions = {}, portRange = undefined, portRangeEnv = process.env, afterRestore = undefined }) {
  if (teardownOptions === null || typeof teardownOptions !== "object" || Array.isArray(teardownOptions))
    throw new Error("database_backup_verification_arguments_refused");
  if (afterRestore !== undefined && typeof afterRestore !== "function")
    throw new Error("database_backup_verification_arguments_refused");
  // The range is read from the same input as the rest of the arguments, so a
  // refused range is refused BEFORE a cluster is created — the same position the
  // port itself has always been refused from, and the same `FAIL` for the caller.
  const range = resolveDatabaseBackupVerificationPortRangeV1(portRange, portRangeEnv);
  if (!Number.isInteger(port) || port < range.min || port > range.max
    || typeof pgBin !== "string" || !isAbsolute(pgBin))
    throw new Error("database_backup_verification_arguments_refused");
  const bound = await readBoundMacLocalDatabaseBackupV1(backup);
  const root = await mkdtemp(databaseBackupVerificationRootPrefixV1());
  const data = join(root, "pg"), socket = join(root, "socket"), log = join(root, "postgres.log");
  // The shared teardown owns the signal handlers, the exit hook, the ordered
  // stop, and the directory removal.
  //
  // The previous version was the worst path in the repository for this class of
  // leak: its own `SIGINT`/`SIGTERM` handlers set `exitCode` WITHOUT stopping
  // the postmaster, its `stop()` swallowed every `pg_ctl` failure, and its
  // `finally` removed the data directory unconditionally — so a postmaster that
  // refused to stop survived with its 56-byte SysV shared-memory segment held
  // and nothing left to stop it with. This machine has 32 of those in total.
  //
  // `teardownOptions` is forwarded to the shared teardown, and ONLY the two
  // observation seams the tests need: `pgCtl`, which replaces the COMMAND while
  // the ladder and every liveness check still run, and `degradedLogger`, which
  // changes where the degraded line is written. It exists for one reason: a
  // `pg_ctl` stop that does not confirm inside its window is reachable only when
  // a real postmaster is slow, so a test that has to observe what this function
  // does with a degraded teardown has no other way in.
  //
  // An ALLOWLIST, not a spread, and deliberately so. Spreading the caller's
  // object would let `dataDirectory`, `runDirectory`, `socketDirectory`, `port`,
  // `pgBin` or `removeDirectories` be overridden — a caller could point the
  // teardown at an empty directory and the verifier would report `verified: true`
  // for a cluster it never stopped, leaving a live postmaster holding its SysV
  // segment. That is precisely the leak this function exists to prevent, so every
  // option that decides WHICH cluster is stopped is set here and cannot be
  // replaced. A test that needs another one gets a new explicit entry, not a
  // spread. The CLI below passes nothing at all.
  const { pgCtl: pgCtlSeam, degradedLogger } = teardownOptions;
  const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: root,
    socketDirectory: socket, port, pgBin,
    ...(pgCtlSeam === undefined ? {} : { pgCtl: pgCtlSeam }),
    ...(degradedLogger === undefined ? {} : { degradedLogger }) });
  let bodyFailure;
  // R5B-08: the named, non-failing notes a verification produced. Collected here
  // rather than inside the `try` because they are part of the RESULT the caller
  // gets back, and a caller that only sees `verified: true` has not been told
  // that the backup predates the current permissions.
  const notes = [];
  try {
    await mkdir(socket, { mode: 0o700, recursive: true });
    native(pgBin, "initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
    await writeFile(join(data, DISPOSABLE_POSTGRES_MARKER), `${JSON.stringify({
      schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal",
    })}\n`, { mode: 0o600, flag: "wx" });
    native(pgBin, "pg_ctl", ["-D", data, "-l", log, "-w", "-t", "30", "-o",
      `-k ${socket} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
    // Registered as soon as there is a running postmaster, and BEFORE anything
    // that can throw, so a failure after this point still has a teardown.
    await teardown.capturePostmasterPid();
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
      // the disposable administrator. Move only restored application objects
      // to the recorded schema owner before proving the owner invariant.
      await normalizeMacApplicationOwnershipV1(client);
      await verifyOwnership(client);
      // The one caller that continues after a restore is the VPS upgrade rehearsal.
      // It receives only the fresh socket target and the disposable root, never a
      // production target. Its work remains inside this try/finally so any failed
      // rehearsal follows the same owned-cluster teardown as a failed verification.
      if (afterRestore !== undefined) await afterRestore(Object.freeze({ target: Object.freeze({ ...target }), root }));
      // R5B-08. This comparison used to THROW on any difference, which made one
      // added role file turn every earlier backup into a reported FAIL — and
      // `docs/BACKUP_AND_RESTORE.md` tells the owner to treat FAIL as a recovery
      // incident. The backup's own correctness is already proven above by the
      // restore identity's `ownersDigest`, which is computed from the source's
      // recorded grants on both sides; what is left here is release history, so
      // it is a note and the verification stays `verified: true`. The strict
      // comparison is still available as `macGrantsMatchCurrentReleaseV1`.
      const verdict = judgeRestoredMacGrantsV1({ restored: await readMacGrantCatalogV1(client),
        current: await readDesiredMacGrantsV1() });
      notes.push(...verdict.notes);
      if (!verdict.verified) throw new Error("database_backup_mac_grants_refused");
    } finally { await client.end(); }
    // The notes are part of the RESULT and not just a log line: an operator who
    // gets `verified: true` and no note has been told the whole story, and this
    // is exactly the information R5B-08 says was being lost.
    return Object.freeze({ verified: true, identityDigest: restored.identityDigest,
      ledgerHead: Object.freeze({ ...bound.manifest.ledger.head }),
      notes: Object.freeze([...notes]) });
  } catch (error) {
    // The body's failure is kept, not replaced. A `throw` from a `finally`
    // REPLACES whatever was already propagating, so a teardown failure raised
    // bare would hide `database_backup_identity_refused` — the actual reason the
    // backup was rejected — behind a cleanup message.
    bodyFailure = error;
    throw error;
  } finally {
    // The teardown refuses to report success when the postmaster survives, and
    // keeps the data directory in that case so an operator can stop it by hand.
    // Its own failure is attached to the body's as a `cause` rather than raised
    // over the top of it, so a caller still has both.
    //
    // `stop()` throws for exactly two things: the postmaster SURVIVED, or the
    // ladder reached `SIGKILL` and leaked its segment. A teardown that ended
    // with the postmaster gone without reaching SIGKILL does not throw — it
    // reports through `degraded()` and stderr — and that distinction is the
    // point. It used to throw here for any non-first ladder step, so a `fast`
    // stop that missed its window after the restore and an `immediate` that did
    // not, printed `database backup verification FAIL` and set exit code 1 for
    // a backup whose digests, ledger, ownership and grants had all matched.
    // docs/BACKUP_AND_RESTORE.md:41-44 reserves `FAIL` for a mismatch and tells
    // the operator to investigate a recovery incident, so a slow shutdown must
    // not be able to produce that verdict.
    let teardownFailure;
    try { await teardown.stop(); } catch (stopError) { teardownFailure = stopError; }
    if (teardown.degraded().length > 0)
      console.error(`database backup verification: teardown degraded on port ${port}:`
        + ` ${teardown.degraded().join(",")}`);
    if (teardownFailure !== undefined) {
      if (bodyFailure === undefined) throw teardownFailure;
      throw new AggregateError([bodyFailure, teardownFailure],
        `${bodyFailure?.message ?? String(bodyFailure)}; teardown: ${teardownFailure?.message ?? String(teardownFailure)}`);
    }
  }
}

function flag(args, name) { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; }
const USAGE = `usage: verify-database-backup.mjs --backup ABSOLUTE_DIRECTORY --port ${DEFAULT_DATABASE_BACKUP_VERIFICATION_PORT_RANGE_V1.min}..${DEFAULT_DATABASE_BACKUP_VERIFICATION_PORT_RANGE_V1.max} [--pg-bin ABSOLUTE_DIRECTORY] [--port-range MIN-MAX]`
  + ` (${DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV}=MIN-MAX overrides the range for one run)`;
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  try {
    const args = process.argv.slice(2), backup = flag(args, "--backup"), pgBin = flag(args, "--pg-bin"),
      portRange = flag(args, "--port-range"), port = Number(flag(args, "--port"));
    if (!backup || !Number.isInteger(port)
      || (args.includes("--port-range") && (typeof portRange !== "string" || portRange.startsWith("--")))
      || args.some((value, index) => index % 2 === 0 && !["--backup", "--port", "--pg-bin", "--port-range"].includes(value)))
      throw new Error(USAGE);
    const result = await verifyMacLocalDatabaseBackupV1({ backup, port,
      ...(pgBin ? { pgBin } : {}), ...(portRange === undefined ? {} : { portRange }) });
    console.log(`database backup verification PASS: ${result.identityDigest}`);
  } catch (error) {
    console.error(`database backup verification FAIL: ${error instanceof Error && error.message === USAGE ? USAGE : "database_backup_verification_failed"}`);
    process.exitCode = 1;
  }
}
