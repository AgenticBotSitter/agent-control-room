// Operator restore tool around pg_restore. Effect-free unless --backup, --target
// and --confirm-target are all supplied; without them it prints the planned steps.
//   node deploy/postgres/restore-database.mjs --backup /srv/backups/cr-20260913 \
//     --target "<disposable conn>" --confirm-target "<same disposable conn>" \
//     --pg-bin /usr/lib/postgresql/17/bin --required-tables tenants,workspaces
// Refuses unless --target and --confirm-target are byte-identical, refuses any
// target that already holds public-schema tables (empty it explicitly first — a
// second restore into the same database starts from DROP SCHEMA public), and
// verifies the restored database-restore identity field by field before reporting
// success. Rollback is restore from a prior backup set: same command, same check.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { computeDatabaseRestoreIdentity, verifyRestoredIdentity } from "./restore-identity.mjs";
import { collectDatabaseEvidence, connectTarget, digestOf, targetCli } from "./evidence.mjs";

const exec = promisify(execFile);
const flag = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

/**
 * @param {{ backup?: string, target?: string, confirmTarget?: string, pgBin?: string, requiredTables?: string[] }} options
 * @returns {Promise<{ planned: boolean, steps?: string[], targetFingerprint?: string, identityDigest?: string }>}
 */
export async function restoreDatabase({ backup, target, confirmTarget, pgBin, requiredTables = [] }) {
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
  const metadata = JSON.parse(await readFile(join(backup, "metadata.json"), "utf8"));
  if (metadata.version !== 1) throw new Error("restore_refused_metadata_version");
  const probe = connectTarget(target);
  await probe.connect();
  try {
    const { rows } = await probe.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'");
    if (rows[0].count > 0) throw new Error("restore_refused_nonempty_target");
  } finally {
    await probe.end();
  }
  const cli = targetCli(target);
  // Grantee roles must exist before the dump's GRANT statements replay: the
  // source's table grants reference groups (reader, backup, …) that the
  // login-provisioning script does not create. This file is CREATE-only and
  // idempotent; login roles still come from the operator's target
  // provisioning, and the membership reconcile below fails closed if one is
  // missing.
  const roleClient = connectTarget(target);
  await roleClient.connect();
  try {
    await roleClient.query(await readFile(join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "db/roles/production_roles.sql"), "utf8"));
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
              CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
              EXISTS (
                SELECT 1 FROM pg_depend d
                WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
                  AND d.refobjid <> '0'::oid AND d.deptype = 'i'
                  AND EXISTS (SELECT 1 FROM pg_attribute a
                              WHERE a.attrelid = d.refobjid AND a.attidentity IN ('a', 'd')
                                AND d.refobjsubid = a.attnum)
              ) AS is_identity_sequence
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')`)).rows;
    for (const object of objects.filter(row => row.kind !== 'SEQUENCE' || !row.is_identity_sequence)) {
      if (!/^[a-z0-9_]+$/.test(object.name)) throw new Error(`restore_refused_object:${object.name}`);
      await grantClient.query(`ALTER ${object.kind} "public"."${object.name}" OWNER TO "${canonicalOwner}"`);
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
  const evidence = await collectDatabaseEvidence(target, { requiredTables });
  // ledgerRowsDigest captures the actual control_room_schema_migrations rows
  // from the just-restored cluster — filenames, digests, orders, and the
  // post-migration schema digests they recorded. Together with the metadata's
  // ledgerDigest (which describes the ledger the backup claimed to contain),
  // this proves the restore actually reproduced the claimed migration history
  // instead of inheriting it from the backup metadata.
  const actual = computeDatabaseRestoreIdentity({
    ledgerDigest: metadata.ledgerDigest,
    rolesDigest: digestOf(evidence.roles),
    membershipsDigest: digestOf(evidence.memberships),
    schemaDigest: evidence.schemaDigest,
    rowsDigest: digestOf(evidence.rows),
    ownersDigest: digestOf(evidence.grants),
    ledgerRowsDigest: digestOf(evidence.ledger),
    databaseOwnerDigest: digestOf(evidence.databaseOwner),
  });
  verifyRestoredIdentity(metadata.identity, actual);
  return { planned: false, targetFingerprint: digestOf(target), identityDigest: actual.identityDigest };
}

const invoked = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  try {
    const result = await restoreDatabase({
      backup: flag(args, "--backup", undefined), target: flag(args, "--target", undefined),
      confirmTarget: flag(args, "--confirm-target", undefined), pgBin: flag(args, "--pg-bin", undefined),
      requiredTables: (flag(args, "--required-tables", "") ?? "").split(",").map(table => table.trim()).filter(Boolean),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`restore_failed: ${error.message}`);
    process.exit(1);
  }
}
