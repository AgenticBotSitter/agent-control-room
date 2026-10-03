import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
import { sha256BackupFileV1 as sha256File } from "../../src/installer/shared/backup-files.mjs";
// Operator restore tool around pg_restore. Effect-free unless --backup, --target
// and --confirm-target are all supplied; without them it prints the planned steps.
//   node deploy/postgres/restore-database.mjs --backup /srv/backups/cr-20260913 \
//     --target "<disposable conn>" --confirm-target "<same disposable conn>" \
//     --pg-bin /usr/lib/postgresql/17/bin
// --required-tables is read FROM THE BACKUP (R5B-05): the row-hash digest can
// only be satisfied by the backup's own list, so a flag naming a different one
// is refused before the target is touched rather than after it is filled.
// Refuses unless --target and --confirm-target are byte-identical, refuses any
// target that already holds objects the dump will create (emptied on request with
// --retry-into-half-restored), and verifies the restored database-restore
// identity field by field before reporting success. Rollback is restore from a
// prior backup set: same command, same check.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { computeDatabaseRestoreIdentity, verifyRestoredIdentity } from "./restore-identity.mjs";
import { collectDatabaseEvidence, connectTarget, digestOf, targetCli } from "./evidence.mjs";
import { recordedRoleNamesFromMetadataV1, readUnrecordedRoleAuthorityV1,
  scopeMembershipsToRecordedV1, scopeRolesToRecordedV1 } from "./scoped-role-evidence.mjs";
import { applyHalfRestoredCleanupV1, planHalfRestoredCleanupV1, readCleanupTargetStateV1,
  readRestoreTocV1 } from "./restore-target-cleanup.mjs";
import { retireRestoredBotCredentialsV1, restoredBotCredentialReportV1, restoredBotNoticeItemsV1,
  writeRestoredBotNoticeV1 } from "./restored-bot-credentials.mjs";

const exec = promisify(execFile);
const flag = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

/**
 * R4B-09, part one: refuse a dump whose BYTES no longer match its manifest,
 * BEFORE the target is touched at all.
 *
 * The order of operations here used to be: read `metadata.json`, connect to the
 * target, count its tables, create roles in it, revoke its database TEMPORARY,
 * and only then hand `database.dump` to `pg_restore`. A dump that had been
 * damaged after the manifest was written therefore reached `pg_restore`, and
 * the target it had already been made to modify was left half-changed by a
 * restore that could never finish. The dump was the ONE input that could be
 * checked before any of that, and nothing checked it.
 *
 * The check is exactly the documented verifier's: the manifest's digests
 * against the two real files. `verifyMacLocalDatabaseBackupV1` runs this same
 * reader before it restores, so a backup this tool refuses to restore is one
 * the verifier refuses too — the two paths cannot disagree.
 *
 * A backup with NO manifest is NOT refused here, and not even an unparsable one.
 * `pg_restore` is the documented recovery tool for exactly the case where the
 * manifest is the thing that was lost or was never written, and refusing there
 * would remove the owner's way back. The restore identity check at the end still
 * has to pass, so a dump that is not what the metadata claims is still refused —
 * after the restore, rather than before it.
 *
 * So the only thing refused HERE is a manifest that exists, parses, and does
 * not describe the bytes beside it: positive evidence of damage, not the
 * absence of evidence.
 */
async function assertBackupBytesAreIntactV1(backup) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")); }
  catch { return; }
  if (typeof manifest !== "object" || manifest === null) throw new Error("restore_refused_damaged_dump");
  const dumpDigest = await sha256File(join(backup, "database.dump"));
  const metadataDigest = await sha256File(join(backup, "metadata.json"));
  if (manifest.dumpDigest !== dumpDigest || manifest.metadataDigest !== metadataDigest)
    throw new Error("restore_refused_damaged_dump");
}
/**
 * The text of `db/roles/production_roles.sql`, read ONCE at module load.
 *
 * Both role lists below come from this one read, so they cannot disagree with
 * each other or with the file. The repository root is TWO levels above
 * `deploy/postgres/` — MEASURED, because the first version of this walked three
 * and read a path outside the worktree, which the refusal in
 * `readProductionGroupRolesV1` caught at import time rather than letting a
 * restore proceed on an empty list.
 *
 * Synchronous by necessity: both lists are module-level constants that the
 * pre-check's argument is built from, and an unparsed file must fail at import
 * rather than turn into a promise a caller can forget to await.
 */
function productionRolesSqlTextV1() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "roles", "production_roles.sql");
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { throw new Error(`restore_refused_no_production_roles_file:${error.code ?? "unknown"}`); }
  return text;
}
// The NOLOGIN group roles db/roles/production_roles.sql creates. Which roles
// those are is READ from that file at module load rather than restated here,
// because the restore's rule is already "create only the roles the BACKUP
// recorded" — see the long comment by the create loop below — and a restated
// list would be a second thing to keep in step with the first.
//
// DERIVED FROM THE FILE AT MODULE LOAD, not restated here. The R5B-03 fix
// (c35fb126a) passed this list to the pre-check as the set of roles the restore
// creates itself, and the list was a hand-kept copy of the SQL file's. Two
// spellings of one fact, kept in agreement by hand, is how that fix's own
// predecessor broke the documented path: the check it feeds
// (`readUnrecordedRoleAuthorityV1`) refuses a recorded role the cluster lacks,
// so any drift showed up as `restore_refused_missing_recorded_role:<role>` on a
// correctly provisioned target — the failure STEP 1 of this round is about.
//
// Reading the file cannot be wrong in that direction. A parse that finds no
// role creation at all is a REFUSAL, not an empty list, because "I did not
// understand the file" is not a list this restore may act on.
const PRODUCTION_GROUP_ROLES = readProductionGroupRolesV1(productionRolesSqlTextV1());
/**
 * The NOLOGIN group roles a role file creates, read from the file itself.
 *
 * Only the `DO $$ … IF NOT EXISTS (…) THEN CREATE ROLE <name> …` and the bare
 * `CREATE ROLE <name>` spellings these files use are read, and a dollar-quoted
 * body IS read (that is where the guarded form lives) while a bare statement
 * outside one is read too — both are what `production_roles.sql` contains today,
 * and a file that used only one of them would otherwise silently yield nothing.
 *
 * @param {string} sql
 * @returns {readonly string[]}
 */
export function readProductionGroupRolesV1(sql) {
  const roles = [];
  const created = /CREATE\s+ROLE\s+(?:"([a-z0-9_]+)"|([a-z0-9_]+))/giu;
  for (const match of sql.matchAll(created)) {
    const name = match[1] ?? match[2];
    if (typeof name === "string" && /^[a-z0-9_]+$/u.test(name) && !roles.includes(name)) roles.push(name);
  }
  if (roles.length === 0) throw new Error("restore_refused_no_production_group_roles");
  return Object.freeze(roles);
}
// The subset of those roles production_roles.sql also revokes database
// TEMPORARY from. Applied only to roles this restore actually (re)created, so
// a backup that predates one of them never sees a REVOKE against a role that
// does not exist. Also READ from the same file: a revoke list and the create
// list kept by hand is the same two-spellings defect, and this one silently
// revokes from a role the restore may not have created.
const TEMPORARY_REVOKED_ROLES = Object.freeze(readTemporaryRevokedRolesV1(productionRolesSqlTextV1()));
/**
 * The group roles the same file revokes database TEMPORARY from.
 *
 * The statements are inside `EXECUTE format('…', …)`, so the role list is the
 * FIRST argument of that call and the statement's own `;` comes after the
 * closing quote — not inside the role list. MEASURED: a pattern that ran to the
 * first `;` read the role list as `control_room_application', current_database()`
 * and matched nothing, leaving the revoke list silently EMPTY. An empty revoke
 * list is the dangerous direction (the restore stops revoking TEMPORARY at all),
 * so the pattern is anchored on the quoted argument and `PUBLIC` is dropped: the
 * restore revokes database TEMPORARY from PUBLIC unconditionally, by hand.
 *
 * @param {string} sql
 * @returns {readonly string[]}
 */
export function readTemporaryRevokedRolesV1(sql) {
  const revoked = new Set();
  // Each revoke names ONE role and ends at that role's own token, inside the
  // quoted `format()` argument: `… FROM control_room_application', …`.
  //
  // Two earlier patterns were measured wrong and are recorded here because both
  // fail in the SILENT direction. One ran to the statement's `;` and read the
  // list as `control_room_application', current_database()` — no match. The
  // other ran to the first quote after `DATABASE`, and its `[^']*` crossed the
  // statement's own closing quote into the rest of the file, yielding one
  // garbage role and none of the real six. Both leave the list empty, and an
  // empty revoke list is the dangerous direction: the restore would stop
  // revoking database TEMPORARY at all. `PUBLIC` is excluded because the
  // restore revokes it from PUBLIC unconditionally, by hand.
  const statement = /REVOKE\s+TEMPORARY\s+ON\s+DATABASE[^;]*?\bFROM\s+([a-z0-9_]+)/giu;
  for (const match of sql.matchAll(statement)) {
    const name = (match[1] ?? "").trim();
    if (/^[a-z0-9_]+$/u.test(name) && name !== "PUBLIC") revoked.add(name);
  }
  return [...revoked];
}

/**
 * The documented `--required-tables` list, when the operator passes one at all.
 *
 * R5B-05. The backup records the row hashes of its own required tables in
 * `metadata.evidence.rows`, and the identity's `rowsDigest` is that list's
 * digest. Passing a DIFFERENT list therefore cannot succeed: the digest
 * compares the target's reading of the named tables against the backup's reading
 * of ITS tables, and a list that is not that one disagrees by construction. The
 * tool used to accept any list and report `restore_identity_mismatch:rowsDigest`
 * only AFTER it had filled the target (MEASURED on PostgreSQL 17: 243 tables left
 * behind, so the next attempt was refused as non-empty). Now:
 *
 *   * no flag — the list comes from the backup, so the documented command works;
 *   * the backup's own list — accepted, and it is the same answer;
 *   * any other list — REFUSED by name, before the target is touched, with the
 *     list the backup recorded.
 *
 * A backup that recorded no rows at all cannot be restored with a flag, because
 * there is nothing for the digest to compare against.
 *
 * @param {unknown} metadata
 * @param {readonly string[]} requiredTables
 */
export function resolveRequiredTablesV1(metadata, requiredTables) {
  const recorded = metadata?.evidence?.rows;
  if (!Array.isArray(recorded)) throw new Error("restore_refused_metadata_rows_shape");
  const recordedTables = recorded.map(entry => entry?.table);
  if (recordedTables.some(table => typeof table !== "string" || !/^[a-z0-9_]+$/u.test(table)))
    throw new Error("restore_refused_metadata_row_table");
  if (!Array.isArray(requiredTables)) throw new Error("restore_refused_required_tables_shape");
  if (requiredTables.length === 0) return recordedTables;
  const same = requiredTables.length === recordedTables.length
    && requiredTables.every(table => recordedTables.includes(table));
  if (!same) throw new Error(`restore_refused_required_tables_mismatch:${recordedTables.join(",")}`);
  return recordedTables;
}

/**
 * `target` and `confirmTarget` are compared by VALUE, not by reference, and each
 * may be a keyword/value connection string or a pg config object — the object
 * shape is what `connectTarget` and `targetCli` take, and it is how a caller that
 * already holds a host/port/database/user tuple avoids re-encoding it.
 * @param {{ backup?: string, target?: string | { host?: string, port?: number, database?: string, user?: string, password?: string, application_name?: string, connectionTimeoutMillis?: number },
 *   confirmTarget?: string | { host?: string, port?: number, database?: string, user?: string, password?: string, application_name?: string, connectionTimeoutMillis?: number },
 *   pgBin?: string, requiredTables?: string[], retryIntoHalfRestored?: boolean }} options
 * @returns {Promise<{ planned: boolean, steps?: string[], targetFingerprint?: string, identityDigest?: string,
 *   botCredentials?: ReturnType<typeof restoredBotCredentialReportV1>, warnings?: string[] }>}
 */
export async function restoreDatabase({ backup, target, confirmTarget, pgBin, requiredTables = [],
  retryIntoHalfRestored = false }) {
  if (!backup || !target || !confirmTarget) {
    return { planned: true, steps: ["refuse unless --target equals --confirm-target", "refuse non-empty target", "pg_restore --no-owner into explicit target only", "verify restore identity field by field"] };
  }
  // Value comparison, not reference identity: callers build separate but equal
  // connection descriptors for --target and --confirm-target.
  const fingerprint = (endpoint) => typeof endpoint === "object" && endpoint !== null
    ? JSON.stringify([endpoint.host, endpoint.port, endpoint.database, endpoint.user])
    : JSON.stringify(endpoint);
  if (fingerprint(target) !== fingerprint(confirmTarget)) throw new Error("restore_refused_unconfirmed_target");
  if (!pgBin) throw new Error("restore_refused_no_pg_bin");
  // R4B-09: the dump's own integrity is settled before ANY connection is opened,
  // so a damaged backup cannot reach, and cannot leave changes on, a target.
  await assertBackupBytesAreIntactV1(backup);
  const metadata = JSON.parse(await readFile(join(backup, "metadata.json"), "utf8"));
  if (metadata.version !== 1) throw new Error("restore_refused_metadata_version");
  // R5B-05: the table list is settled before the target is opened at all, so a
  // flag that cannot succeed is refused by name rather than after a restore.
  const tables = resolveRequiredTablesV1(metadata, requiredTables);
  // R5B-03: the identity compares the roles and memberships the backup RECORDED.
  // The recorded set is every `control_room_%` role the source held, not a
  // sample, so scoping to it is exact — and an extra role the source did not
  // have (what an update that adds a login leaves on the cluster) is reported
  // rather than folded into the comparison that then fails on it.
  const recordedRoleNames = recordedRoleNamesFromMetadataV1(metadata);
  const warnings = [];
  // Every check that needs no data on the target runs before `pg_restore`.
  // `pg_restore` is not transactional, so anything learned after it starts is
  // learned too late to protect the target.
  const authority = await readUnrecordedRoleAuthorityV1(target, recordedRoleNames,
    new Set(PRODUCTION_GROUP_ROLES.filter(name => recordedRoleNames.has(name))));
  if (authority.wiredMemberships.length > 0) {
    const { member, role } = authority.wiredMemberships[0];
    throw new Error(`restore_refused_unrecorded_role_authority:${member}:${role}`);
  }
  if (authority.extraRoles.length > 0)
    warnings.push(`restore_warning_role_added_since_backup:${authority.extraRoles.join(",")}`);
  const probe = connectTarget(target);
  await probe.connect();
  try {
    // R5B-04: the emptiness check covers EVERY non-system schema, not just
    // `public` tables. A half-restored target keeps `control_room_queue`, so a
    // `public`-only check passed it and the retry then died inside pg_restore.
    const { rows } = await probe.query(
      `SELECT count(*)::int AS count FROM pg_tables
        WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname <> 'information_schema'`);
    // R4B-09, part two: the refusal NAMES THE DATABASE and says what to do.
    //
    // The refusal itself is unchanged and is still correct — an unrelated
    // nonempty database must never be silently emptied. What was missing was
    // the way forward: `pg_restore` is not transactional, so an interrupted
    // restore leaves the target dirty, the same command then refuses that
    // dirty target, and the operator is holding a half-restored database and a
    // refusal with no instruction. The database NAME is what makes the
    // instruction safe — "drop this one and retry" is only actionable if the
    // refusal says which database.
    //
    // Deliberately not a command. This tool never drops anything on its own
    // initiative: the caller decides whether the named target is disposable, the
    // operator is the one who knows whether an interrupted restore owns it, and
    // the cleanup that makes a retry possible is asked for by name.
    if (rows[0].count > 0) {
      const name = typeof target === "object" && target !== null ? target.database : undefined;
      if (typeof name !== "string" || !/^[a-z0-9_]+$/u.test(name))
        throw new Error("restore_refused_nonempty_target");
      if (!retryIntoHalfRestored) throw new Error(`restore_refused_nonempty_target:${name}`);
      const toc = await readRestoreTocV1(pgBin, join(backup, "database.dump"));
      const plan = planHalfRestoredCleanupV1(toc, await readCleanupTargetStateV1(probe));
      if (plan.refusal) throw new Error(plan.refusal);
      if (plan.dropSchemas.length === 0 && plan.relations.length === 0 && plan.routines.length === 0
        && plan.types.length === 0)
        throw new Error(`restore_refused_nonempty_target:${name}`);
      await applyHalfRestoredCleanupV1(probe, plan);
    }
  } finally {
    await probe.end();
  }
  const cli = targetCli(target);
  // Grantee roles must exist before the dump's GRANT statements replay: the
  // source's table grants reference groups (reader, backup, …) that the
  // login-provisioning script does not create. This used to run the CURRENT
  // commit's db/roles/production_roles.sql unconditionally, which creates
  // every group role production defines TODAY — including one a backup taken
  // before that role existed never recorded. The invented role then showed up
  // in the post-restore role snapshot with nothing on the backup side to
  // match, failing the restore identity check for a perfectly good backup.
  // Creating only the group roles this backup's own role snapshot recorded
  // reproduces the source exactly; login roles are untouched here, exactly as
  // before — they still come from the operator's target provisioning.
  const roleClient = connectTarget(target);
  await roleClient.connect();
  try {
    // R5B-10: the roles that own a DEFAULT ACL must exist before `pg_restore`
    // replays the dump's `ALTER DEFAULT PRIVILEGES FOR ROLE <name>`.
    //
    // MEASURED on PostgreSQL 17: the release's privilege files are applied as the
    // BOOTSTRAP SUPERUSER, so a bare `ALTER DEFAULT PRIVILEGES … FROM PUBLIC`
    // records THAT superuser as the default ACL's owner and the dump replays it
    // under `FOR ROLE`. On a target whose superuser has another name, pg_restore
    // answers `role "fixture_admin" does not exist`, and the target has already
    // been filled by then — the half-restored state R5B-04 exists to clean up.
    //
    // So the role is created here, from the backup's OWN record, before the dump
    // runs: the same rule the restore already follows for the canonical owner and
    // the recorded database owner. It is created NOLOGIN and WITHOUT SUPERUSER,
    // because the dump only needs the name to exist — it must not hand the target
    // an escalation the source's role may or may not have had. An existing role
    // is left exactly as it is.
    for (const row of metadata.evidence?.defaultAclOwners ?? []) {
      const owner = row?.owner;
      if (typeof owner !== "string" || !/^[a-z0-9_]+$/.test(owner))
        throw new Error(`restore_refused_default_acl_owner_shape:${String(owner)}`);
      await roleClient.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN
        CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END; $$;`);
    }
    for (const name of PRODUCTION_GROUP_ROLES) {
      if (!recordedRoleNames.has(name)) continue;
      await roleClient.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
        CREATE ROLE ${name} NOLOGIN; END IF; END; $$;`);
    }
    await roleClient.query("DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END; $$;");
    for (const name of TEMPORARY_REVOKED_ROLES) {
      if (!recordedRoleNames.has(name)) continue;
      await roleClient.query(`DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), '${name}'); END; $$;`);
    }
  } finally {
    await roleClient.end();
  }
  await exec(join(pgBin, "pg_restore"), ["--no-owner", ...cli.args, join(backup, "database.dump")],
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", ...cli.env }, timeout: 180000, maxBuffer: 1 << 30 });
  // Owners and grants do not survive pg_restore --no-owner: re-apply the recorded
  // owner (deterministic provisioning, like the grants file) so the identity check
  // verifies restored *content* — rows, schema and ACLs — instead of cluster-local
  // role state. A corrupted or partial dump still fails the digest comparison below.
  const owners = metadata.evidence.grants.map(entry => entry.owner).filter(name => /^[a-z0-9_]+$/.test(name ?? ""));
  const counts = new Map();
  for (const owner of owners) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  const canonicalOwner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!canonicalOwner) throw new Error("restore_refused_no_recorded_owner");
  const grantClient = connectTarget(target);
  await grantClient.connect();
  try {
    await grantClient.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${canonicalOwner}') THEN
      CREATE ROLE "${canonicalOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END; $$;`);
    // Filter IDENTITY-generated sequences out of the explicit ALTER loop:
    // their ownership follows the table automatically. Only sequences that are
    // not IDENTITY-backed (regular SERIAL nextval sequences, custom sequences)
    // need an explicit ALTER SEQUENCE OWNER TO. IDENTITY sequences are linked
    // to their table via pg_depend — we identify them by looking for a
    // dependency that points to a pg_class entry with an 'a' (always) or 'd'
    // (default) identity column. Sequences that are not referenced by an
    // identity column need their own ALTER.
    const objects = (await grantClient.query(
      `SELECT n.nspname AS schema, c.relname AS name,
              CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END AS kind,
              EXISTS (
                SELECT 1 FROM pg_depend d
                WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
                  AND d.refobjid <> '0'::oid AND d.deptype = 'i'
                  AND EXISTS (SELECT 1 FROM pg_attribute a
                              WHERE a.attrelid = d.refobjid AND a.attidentity IN ('a', 'd')
                                AND d.refobjsubid = a.attnum)
              ) AS is_identity_sequence
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v')`)).rows;
    for (const object of objects.filter(row => row.kind !== 'SEQUENCE' || !row.is_identity_sequence)) {
      if (!/^[a-z0-9_]+$/.test(object.name)) throw new Error(`restore_refused_object:${object.name}`);
      await grantClient.query(`ALTER ${object.kind} "public"."${object.name}" OWNER TO "${canonicalOwner}"`);
    }
    // FUNCTIONS TOO, and this is not a tidiness fix. `pg_restore --no-owner`
    // creates every function owned by the role that ran the restore, so a restored
    // database left every function owned by the operator's SUPERUSER instead of the
    // schema owner — seven of them SECURITY DEFINER, so their effective authority
    // was the superuser's rather than the reviewed schema owner's. Two consequences
    // were observed on a real restore: `applyMigrations` then failed outright with
    // `permission denied for function ...` because the migrator is IN ROLE the
    // schema owner and no longer owned them, and the SECURITY DEFINER surface the
    // preflight reviews was no longer the one anybody had reviewed. pg_proc is walked
    // with the same shape as the relation loop above, and each signature is
    // name-guarded exactly like a relation name.
    const functions = (await grantClient.query(
      `SELECT p.oid::regprocedure::text AS signature
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' ORDER BY 1`)).rows;
    for (const entry of functions) {
      const signature = String(entry.signature ?? "");
      // A signature is `name(arg,type,...)`: the name may be schema-qualified and
      // the argument types carry commas, brackets, quotes and spaces. Every
      // character outside that set is refused rather than interpolated.
      if (!/^[-A-Za-z0-9_.,()"'[\]$* :]+$/u.test(signature) || !signature.includes("("))
        throw new Error(`restore_refused_object:${signature}`);
      await grantClient.query(`ALTER FUNCTION ${signature} OWNER TO "${canonicalOwner}"`);
    }
    // Memberships do not survive pg_restore --no-owner either: reconcile the
    // exact memberships recorded at backup time. Login roles must already exist
    // (the operator provisions the target with production_provision.sql first);
    // a missing login fails closed with the repair instruction instead of
    // silently verifying a weaker role model. GRANT is idempotent, and recorded
    // administration rights (WITH ADMIN OPTION) are reproduced faithfully so the
    // target-observed comparison below sees the backup's real authority.
    const recorded = Array.isArray(metadata.evidence?.memberships) ? metadata.evidence.memberships : [];
    for (const entry of recorded) {
      const member = entry?.member, role = entry?.role;
      if (typeof member !== "string" || typeof role !== "string" ||
        !/^[a-z0-9_]+$/.test(member) || !/^[a-z0-9_]+$/.test(role)) {
        throw new Error("restore_refused_membership_shape");
      }
      const { rows } = await grantClient.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [member]);
      if (rows.length === 0) throw new Error(`restore_refused_missing_login_role:${member}`);
      await grantClient.query(`GRANT "${role}" TO "${member}"${entry.admin_option === true ? " WITH ADMIN OPTION" : ""}`);
    }
    // Database ownership must match the source: pg_restore --no-owner leaves
    // objects re-owned above but the database itself stays with the invoking
    // administrator. The recorded owner is shape-validated and ensured before
    // the transfer; any later mismatch then fails the identity check below.
    const recordedOwner = metadata.evidence?.databaseOwner;
    if (typeof recordedOwner !== "string" || !/^[a-z0-9_]+$/.test(recordedOwner)) {
      throw new Error("restore_refused_database_owner_shape");
    }
    await grantClient.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${recordedOwner}') THEN
      CREATE ROLE "${recordedOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END; $$;`);
    await grantClient.query(
      `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO %I', current_database(), '${recordedOwner}'); END; $$;`);
  } finally {
    await grantClient.end();
  }
  const evidence = await collectDatabaseEvidence(target, { requiredTables: tables });
  // R5B-03: the two digests that must compare only what the backup could
  // reproduce are computed from the SCOPED projection of the target's observed
  // state. `collectDatabaseEvidence` still reads the whole cluster, because the
  // unscoped list is what the extra-role report above is built from; the scoping
  // happens here, against the recorded set, and preserves the snapshot's own
  // order so the digest is byte-comparable with the backup's.
  const actual = computeDatabaseRestoreIdentity({
    ledgerDigest: metadata.ledgerDigest,
    rolesDigest: digestOf(scopeRolesToRecordedV1(evidence.roles, recordedRoleNames)),
    membershipsDigest: digestOf(scopeMembershipsToRecordedV1(evidence.memberships, recordedRoleNames)),
    schemaDigest: evidence.schemaDigest,
    rowsDigest: digestOf(evidence.rows),
    ownersDigest: digestOf(evidence.grants),
    ledgerRowsDigest: digestOf(evidence.ledger),
    databaseOwnerDigest: digestOf(evidence.databaseOwner),
  });
  verifyRestoredIdentity(metadata.identity, actual);
  // R5B-06: the identity is verified, and only then are the bot credentials the
  // restore brought back retired. Order matters in both directions — retiring
  // first would leave a restore that then fails its identity check with the bots
  // already locked out of a database that was not the right one; the owner is
  // told AFTER, because a notice written into a database whose restore failed is
  // a notice about the wrong database.
  const bots = await retireRestoredBotCredentialsV1(target);
  const noticeItems = restoredBotNoticeItemsV1(bots.retired, bots.revokedByBackup, actual.identityDigest);
  await writeRestoredBotNoticeV1(target, noticeItems);
  return { planned: false, targetFingerprint: digestOf(target), identityDigest: actual.identityDigest,
    botCredentials: restoredBotCredentialReportV1(bots), warnings };
}

const invoked = isMainModuleV1(process.argv[1], import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  try {
    const result = await restoreDatabase({
      backup: flag(args, "--backup", undefined), target: flag(args, "--target", undefined),
      confirmTarget: flag(args, "--confirm-target", undefined), pgBin: flag(args, "--pg-bin", undefined),
      requiredTables: (flag(args, "--required-tables", "") ?? "").split(",").map(table => table.trim()).filter(Boolean),
      // Retry into a target an interrupted restore left half-filled. This
      // DESTROYS objects, so it is only ever done when the operator asks for it
      // by name and the target is the one they said it was.
      retryIntoHalfRestored: args.includes("--retry-into-half-restored"),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error("restore_failed: restore_execution_failed");
    process.exit(1);
  }
}
