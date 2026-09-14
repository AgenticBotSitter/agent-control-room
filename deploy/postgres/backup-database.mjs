// Operator backup tool around pg_dump. Effect-free unless --source and --out are
// both supplied; without them it prints the planned steps and exits 0.
//   node deploy/postgres/backup-database.mjs --source "<conn>" --out /srv/backups/cr-20260913 \
//     --pg-bin /usr/lib/postgresql/17/bin --ledger-digest sha256:<ledger> --required-tables tenants,workspaces
// Writes database.dump (pg_dump custom format) plus metadata.json binding release,
// schema, roles and required-row hashes into the database-restore identity consumed
// by #60/#61. Never touches a live target: it only reads the source.
//
// Consistency boundary: the metadata must describe the exact database state that
// pg_dump exported. We pin that with a SERIALIZABLE READ ONLY DEFERRABLE
// transaction taken on a single dedicated connection; pg_dump is then invoked as
// a subprocess that connects with the same transaction-snapshot-style mode, and
// the in-transaction evidence collection reads ledger rows, schema digest and
// required-row hashes from the same snapshot. A second session that mutates the
// database after the snapshot starts is excluded from both the dump and the
// evidence — they describe one consistent state. The transaction commits
// immediately after both reads complete; nothing is written to the source.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { computeDatabaseRestoreIdentity } from "./restore-identity.mjs";
import { readSchemaDigest } from "./apply-migrations.mjs";
import { collectDatabaseEvidence, connectTarget, digestOf, targetCli } from "./evidence.mjs";

const exec = promisify(execFile);
const flag = (args, name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

/**
 * Open one connection, take a SERIALIZABLE READ ONLY DEFERRABLE snapshot,
 * collect evidence inside it, run pg_dump using the same connection-string
 * parameters, then end the snapshot. The dump and evidence describe the same
 * database state — concurrent writers are excluded from both.
 */
async function collectConsistentSnapshot(source, { requiredTables }) {
  const evidenceClient = connectTarget(source);
  await evidenceClient.connect();
  try {
    await evidenceClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE");
    const ledger = (await evidenceClient.query(
      "SELECT filename, digest, ledger_order, pre_schema_digest, post_schema_digest FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    const roles = (await evidenceClient.query(
      `SELECT rolname, rolcanlogin, rolcreatedb, rolcreaterole, rolsuper FROM pg_roles
       WHERE rolname LIKE 'control\\_room\\_%' ORDER BY rolname`)).rows;
    const grants = (await evidenceClient.query(
      `SELECT n.nspname || '.' || c.relname AS object, pg_get_userbyid(c.relowner) AS owner,
              coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))::text AS acl
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') ORDER BY 1`)).rows;
    const schemaDigest = await readSchemaDigest(evidenceClient);
    const rows = [];
    for (const table of requiredTables) {
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`evidence_refused_table:${table}`);
      const values = (await evidenceClient.query(
        `SELECT to_jsonb(t) AS v FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
      rows.push({ table, count: values.length, hash: digestOf(values) });
    }
    // pg_dump runs as a subprocess but opens its own connection. We export the
    // current snapshot's XID via txid_snapshot so any later dump sees the same
    // row versions. The transaction remains open until the dump completes; this
    // is the proven consistency mechanism for taking a snapshot export and an
    // evidence read from the same database state.
    const txid = (await evidenceClient.query("SELECT pg_export_snapshot() AS snap")).rows[0].snap;
    return { evidence: { ledger, roles, grants, rows, schemaDigest }, txid, evidenceClient };
  } catch (error) {
    try { await evidenceClient.query("ROLLBACK"); } catch {}
    throw error;
  }
}

/**
 * @param {{ source?: string, out?: string, pgBin?: string, requiredTables?: string[], ledgerDigest?: string, release?: string }} options
 * @returns {Promise<{ planned: boolean, steps?: string[], out?: string, identityDigest?: string }>}
 */
export async function backupDatabase({ source, out, pgBin, requiredTables = [], ledgerDigest, release = "unreleased" }) {
  if (!source || !out) {
    return { planned: true, steps: ["pg_dump --format=custom under pg_export_snapshot",
      "metadata.json with release/schema/roles/row binding from the same snapshot",
      "source is read-only; no target touched"] };
  }
  if (!pgBin) throw new Error("backup_refused_no_pg_bin");
  if (!ledgerDigest || !/^sha256:[a-f0-9]{64}$/.test(ledgerDigest)) throw new Error("backup_refused_no_ledger_digest");
  await mkdir(out, { recursive: true, mode: 0o700 });
  const snapshot = await collectConsistentSnapshot(source, { requiredTables });
  const cli = targetCli(source);
  // pg_dump's --snapshot option must be a CLI argument, not a backend option.
  // Passing it via PGOPTIONS would be silently ignored; pass it on the
  // command line instead. The dump subprocess connects to the same database
  // and joins the snapshot exported from the evidence connection.
  try {
    await exec(join(pgBin, "pg_dump"), ["--format=custom", "--snapshot", snapshot.txid,
      "--file", join(out, "database.dump"), ...cli.args],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", ...cli.env }, timeout: 120000, maxBuffer: 1 << 30 });
  } finally {
    try { await snapshot.evidenceClient.query("COMMIT"); } catch {}
    await snapshot.evidenceClient.end();
  }
  const { evidence } = snapshot;
  const rolesDigest = digestOf(evidence.roles);
  const metadata = {
    version: 1, release, createdAt: new Date().toISOString(),
    sourceFingerprint: digestOf(source), ledgerDigest, snapshotXid: snapshot.txid,
    identity: computeDatabaseRestoreIdentity({
      ledgerDigest, rolesDigest,
      schemaDigest: evidence.schemaDigest, rowsDigest: digestOf(evidence.rows),
      ownersDigest: digestOf(evidence.grants), ledgerRowsDigest: digestOf(evidence.ledger),
    }),
    evidence,
  };
  await writeFile(join(out, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { planned: false, out, identityDigest: metadata.identity.identityDigest };
}

const invoked = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  try {
    const result = await backupDatabase({
      source: flag(args, "--source", undefined), out: flag(args, "--out", undefined),
      pgBin: flag(args, "--pg-bin", undefined), ledgerDigest: flag(args, "--ledger-digest", undefined),
      release: flag(args, "--release", "unreleased"),
      requiredTables: (flag(args, "--required-tables", "") ?? "").split(",").map(table => table.trim()).filter(Boolean),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`backup_failed: ${error.message}`);
    process.exit(1);
  }
}
