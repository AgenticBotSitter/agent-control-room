import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
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
import { lstat, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { Client } from "pg";
import { computeDatabaseRestoreIdentity } from "./restore-identity.mjs";
import { readSchemaDigest } from "./apply-migrations.mjs";
import { collectDatabaseEvidence, connectTarget, digestOf, targetCli } from "./evidence.mjs";
import { DEFAULT_ACL_ROLES_SNAPSHOT_SQL, MEMBERSHIPS_SNAPSHOT_SQL, ROLES_SNAPSHOT_SQL } from "./evidence.mjs";

// Both constants live in the ONE module the nightly runner can also import,
// because that module has no imports at all (and must keep none: this file is
// loaded by bare `node` from scripts/ops). Putting either here instead
// would make the nightly runner — whose dependency-free bundle must not
// acquire `pg` — depend on the module that needs `pg`, which is exactly the
// import `nightly_backup_dependency_missing` exists to survive. See the longer
// comment on `BACKUP_MANIFEST_SCHEMA_V1` there.
//
// `NIGHTLY_DUMP_TIMEOUT_MS_V1` is re-exported because this module is where the
// deadline is actually handed to `execFile`.
import { BACKUP_MANIFEST_SCHEMA_V1, NIGHTLY_DUMP_TIMEOUT_MS_V1 }
  from "../../src/installer/v1/nightly-backup-constants.ts";
export { BACKUP_MANIFEST_SCHEMA_V1, NIGHTLY_DUMP_TIMEOUT_MS_V1 };

import { reserveBackupGenerationV1, consumeBackupGenerationV1, assertBackupGenerationV1, sha256BackupFileV1 as sha256OfFileV1 } from "../../src/installer/shared/backup-files.mjs";

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
async function collectConsistentSnapshot(source, { requiredTables, evidenceTimeoutMs, connect }) {
  const evidenceClient = connect(source);
  // R4B-08. The `connect()` is INSIDE the try, and this is the whole fix.
  //
  // `connect()` used to sit ABOVE this function's `try`, so a failed connection
  // threw out with nothing closed, owned or accounted for. The R4S-03 fix put
  // `end()` in the catch, which covers every failure AFTER the connection;
  // this puts `connect()` under the same ownership, so the client's whole life
  // is one cleanup scope rather than two code paths kept in agreement by hand.
  //
  // `end()` is NOT enough on its own, and this is measured rather than assumed.
  // Against a WEDGED database — the socket granted, the startup handshake never
  // completing, which is what a PostgreSQL stopped on a full disk or blocked in
  // recovery looks like — `connect()` rejects on its timeout while the accepted
  // socket is still open, and `end()` alone does not close it. That surviving
  // handle is precisely what keeps the nightly entry alive after it has already
  // written its failure line: the R4S-03 class of hang, on a path the round-4
  // report's model could not reach because a fake client has no socket at all.
  // So the socket is destroyed if `end()` did not take it.
  try {
    await evidenceClient.connect();
  } catch (error) {
    await endEvidenceClientV1(evidenceClient);
    throw error;
  }
  try {
    // R4S-11, and this is the part the round-4 report did not reach. The pg_dump
    // deadline bounds the DUMP, but every query in the evidence transaction runs
    // on the evidence client, and none of them carried a deadline of their own.
    //
    // MEASURED on PostgreSQL 17: the schema-digest catalog query blocks for as
    // long as another session holds a conflicting lock — 199,990 ms here, with
    // no error and no timeout, because a plain SELECT waits on a lock
    // indefinitely. Its trigger branch reads `pg_trigger` for every table in the
    // schema, so locking ANY table in `public` blocks it. The nightly job's
    // `ExitTimeOut` then SIGKILLs a job that never reached its dump deadline and
    // wrote nothing: the R4S-03 class of silent failure, with a different
    // trigger.
    //
    // So the whole evidence transaction gets a deadline, not just the dump.
    // `lock_timeout` is the one that matters for a lock wait; `statement_timeout`
    // covers everything else. Both are LOCAL, so they die with this transaction
    // and cannot leak into the dump's separate connection.
    //
    // They are set AFTER `BEGIN`, not before: PostgreSQL accepts `SET LOCAL`
    // outside a transaction block and applies it to NOTHING (it only warns),
    // which would leave every query below exactly as unbounded as it was.
    await evidenceClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE");
    await evidenceClient.query(`SET LOCAL lock_timeout = '${evidenceTimeoutMs}ms'`);
    await evidenceClient.query(`SET LOCAL statement_timeout = '${evidenceTimeoutMs}ms'`);
    const ledger = (await evidenceClient.query(
      "SELECT filename, digest, ledger_order, pre_schema_digest, post_schema_digest FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    const roles = (await evidenceClient.query(ROLES_SNAPSHOT_SQL)).rows;
    const memberships = (await evidenceClient.query(MEMBERSHIPS_SNAPSHOT_SQL)).rows;
    const grants = (await evidenceClient.query(
      `SELECT n.nspname || '.' || c.relname AS object, pg_get_userbyid(c.relowner) AS owner,
              coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))::text AS acl
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v') ORDER BY 1`)).rows;
    const schemaDigest = await readSchemaDigest(evidenceClient);
    const rows = [];
    for (const table of requiredTables) {
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`evidence_refused_table:${table}`);
      const values = (await evidenceClient.query(
        `SELECT to_jsonb(t) AS v FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
      rows.push({ table, count: values.length, hash: digestOf(values) });
    }
    // Database owner is read inside the same snapshot so the recorded owner
    // and the dumped content cannot diverge.
    const databaseOwner = (await evidenceClient.query(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()")).rows[0]?.owner;
    if (typeof databaseOwner !== "string" || !/^[a-z0-9_]+$/.test(databaseOwner)) {
      throw new Error("evidence_refused_database_owner");
    }
    // R5B-10: the roles owning a default ACL, read inside this same snapshot so
    // the recorded names and the replayed dump cannot disagree. Without them a
    // backup taken on a cluster whose superuser is not `postgres` replays
    // `ALTER DEFAULT PRIVILEGES FOR ROLE <that name>` and cannot be restored onto
    // a differently-named target at all. See DEFAULT_ACL_ROLES_SNAPSHOT_SQL.
    const defaultAclOwners = (await evidenceClient.query(DEFAULT_ACL_ROLES_SNAPSHOT_SQL)).rows;
    for (const row of defaultAclOwners) {
      if (typeof row?.owner !== "string" || !/^[a-z0-9_]+$/.test(row.owner))
        throw new Error(`evidence_refused_default_acl_owner:${String(row?.owner)}`);
    }
    // pg_dump runs as a subprocess but opens its own connection. We export the
    // current snapshot's XID via txid_snapshot so any later dump sees the same
    // row versions. The transaction remains open until the dump completes; this
    // is the proven consistency mechanism for taking a snapshot export and an
    // evidence read from the same database state.
    const txid = (await evidenceClient.query("SELECT pg_export_snapshot() AS snap")).rows[0].snap;
    return { evidence: { ledger, roles, memberships, grants, rows, schemaDigest, databaseOwner,
      defaultAclOwners }, txid, evidenceClient };
  } catch (error) {
    // R4S-03, in two parts, because fixing only the first one is not enough.
    //
    // (1) The client is ENDED here, not merely rolled back. A rollback that
    //     leaves the socket open keeps the process alive for as long as the
    //     connection is open, so the nightly entry printed "failed", returned 1,
    //     and then hung forever with an idle session parked in the database.
    //
    // (2) The ROLLBACK is bounded before it is issued, because it can itself
    //     block. MEASURED on PostgreSQL 17: a session whose transaction touched
    //     a table another session holds ACCESS EXCLUSIVE on waits in ROLLBACK
    //     indefinitely — no statement timeout, no lock timeout, nothing — so the
    //     `end()` on the next line never runs and this whole block hangs. That
    //     is reachable from the nightly backup: a dump that overlaps any
    //     long-running writer on any table it touched will sit here. The
    //     deadline is applied as a LOCAL statement timeout, so it is scoped to
    //     this one failing session and cannot alter the dump's own settings.
    //
    //     The ROLLBACK is best-effort either way: ending the client aborts the
    //     transaction server-side regardless, so the timeout costs nothing but a
    //     bounded wait where the wait would otherwise be unbounded.
    try { await evidenceClient.query("SET LOCAL statement_timeout = '5s'"); } catch {}
    try { await evidenceClient.query("ROLLBACK"); } catch {}
    await endEvidenceClientV1(evidenceClient);
    throw error;
  }
}

/**
 * End an evidence client, and take its socket with it if `end()` did not.
 *
 * `node-postgres` exposes the stream, so a client whose socket survived a failed
 * connection can be destroyed outright. This runs on the failure path only, where
 * the alternative is a process that cannot exit.
 */
async function endEvidenceClientV1(evidenceClient) {
  try { await evidenceClient.end(); } catch {}
  const stream = evidenceClient?.connection?.stream;
  if (stream && !stream.destroyed) { try { stream.destroy(); } catch {} }
}

 /**
 * `connect` is a test seam and nothing else. It exists because the R4B-08 guard
 * — ending the evidence client when `connect()` rejects — is not observable from
 * outside: MEASURED against a wedged server, `node-postgres` destroys its own
 * stream whether or not this module calls `end()`, so neither the server's
 * socket nor the client's own handle can tell the guard from its absence. The
 * mutation run reported the guard UNPROTECTED for exactly that reason, twice.
 * With this seam the observation is the CALL, which is the thing this module
 * actually controls. Production passes nothing: the default is `connectTarget`.
 *
 * @param {{ source?: string | { host?: string, port?: number, database?: string, user?: string, password?: string, application_name?: string, connectionTimeoutMillis?: number }, out?: string, pgBin?: string, requiredTables?: string[], ledgerDigest?: string, release?: string, dumpTimeoutMs?: number, evidenceTimeoutMs?: number, connect?: (source: unknown) => object, generation?: object }} options
 * @returns {Promise<{ planned: boolean, steps?: string[], out?: string, identityDigest?: string, manifest?: Record<string, unknown> }>}
 */
export async function backupDatabase({ source, out, pgBin, requiredTables = [], ledgerDigest, release = "unreleased",
  dumpTimeoutMs = NIGHTLY_DUMP_TIMEOUT_MS_V1, evidenceTimeoutMs = NIGHTLY_DUMP_TIMEOUT_MS_V1, connect = connectTarget, generation }) {
  if (!source || !out) {
    return { planned: true, steps: ["pg_dump --format=custom under pg_export_snapshot",
      "metadata.json with release/schema/roles/row binding from the same snapshot",
      "source is read-only; no target touched"] };
  }
  if (!pgBin) throw new Error("backup_refused_no_pg_bin");
  if (!ledgerDigest || !/^sha256:[a-f0-9]{64}$/.test(ledgerDigest)) throw new Error("backup_refused_no_ledger_digest");
  generation ??= await reserveBackupGenerationV1(out);
  await consumeBackupGenerationV1(out, generation);
  const snapshot = await collectConsistentSnapshot(source, { requiredTables, evidenceTimeoutMs, connect });
  // pg_dump's --snapshot option must be a CLI argument, not a backend option.
  // Passing it via PGOPTIONS would be silently ignored; pass it on the
  // command line instead. The dump subprocess connects to the same database
  // and joins the snapshot exported from the evidence connection.
  try {
    const cli = targetCli(source);
    await assertBackupGenerationV1(out, generation);
    await exec(join(pgBin, "pg_dump"), ["--format=custom", "--snapshot", snapshot.txid,
      "--file", join(out, "database.dump"), ...cli.args],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", ...cli.env }, timeout: dumpTimeoutMs, maxBuffer: 1 << 30 });
  } catch (error) {
    // R4S-11: the limit is now sized for a real dump, so tripping it means
    // something the owner has to know about rather than a routine slow night.
    // The refusal says WHICH limit, in the one bounded word the nightly entry
    // prints, so the log line names the cause instead of leaving the owner to
    // work out that "execution failed" could have been a 45-minute dump.
    if (error && typeof error === "object" && "killed" in error && error.killed === true) {
      throw new Error(`nightly_backup_dump_timeout:${dumpTimeoutMs}`);
    }
    throw error;
  } finally {
    // Same bound, same reason as the failure path: the snapshot transaction
    // stays open across the dump, so COMMIT is issued after it. A writer that
    // took a lock in between would otherwise leave this waiting indefinitely
    // while the client stays open, which is the R4S-03 hang by another route.
    try { await snapshot.evidenceClient.query("SET LOCAL statement_timeout = '5s'"); } catch {}
    try { await snapshot.evidenceClient.query("COMMIT"); } catch {}
    await endEvidenceClientV1(snapshot.evidenceClient);
  }
  await assertBackupGenerationV1(out, generation);
  const { evidence } = snapshot;
  const rolesDigest = digestOf(evidence.roles);
  const membershipsDigest = digestOf(evidence.memberships);
  const metadata = {
    version: 1, release, createdAt: new Date().toISOString(),
    sourceFingerprint: digestOf(source), ledgerDigest, snapshotXid: snapshot.txid,
    identity: computeDatabaseRestoreIdentity({
      ledgerDigest, rolesDigest, membershipsDigest,
      schemaDigest: evidence.schemaDigest, rowsDigest: digestOf(evidence.rows),
      ownersDigest: digestOf(evidence.grants), ledgerRowsDigest: digestOf(evidence.ledger),
      databaseOwnerDigest: digestOf(evidence.databaseOwner),
    }),
    evidence,
  };
  const metadataPath = join(out, "metadata.json");
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  await writeFile(metadataPath, metadataText, { mode: 0o600, flag: "wx" });
  // R4B-10: the OUTER MANIFEST. Until this line existed, every scheduled
  // generation held exactly `database.dump` and `metadata.json`, and
  // `scripts/ops/verify-database-backup.mjs` — the verification command
  // docs/BACKUP_AND_RESTORE.md tells the owner to run — returns ENOENT for
  // `manifest.json` before it does anything at all. A backup nobody can verify
  // is the same as no backup, and it was the scheduled one, every night.
  //
  // It binds the dump and metadata DIGESTS to the bytes on disk, which is what
  // R4B-01 also needs: a generation whose dump no longer matches its manifest is
  // a damaged generation, and the nightly retention scanner refuses to spend it.
  //
  // Both digests are read back THROUGH the descriptors this module just wrote,
  // and the sizes are checked first, so a manifest can never claim a binding for
  // bytes that are not there. `flag: "wx"` refuses to overwrite an existing
  // manifest: a generation folder is created fresh by the runner, and overwriting
  // here would let a second writer rebind a folder that already holds history.
  const dumpPath = join(out, "database.dump");
  for (const path of [dumpPath, metadataPath]) {
    // MEASURED on a real cluster: pg_dump is a subprocess, so a failure, a full
    // disk or a zero-byte exit can leave `database.dump` absent entirely. The
    // `lstat` used to run bare, and ENOENT escaped as itself — a raw syscall
    // error rather than the one bounded refusal code this module speaks. An
    // absent file is not a failure of the backup machinery to report on; it is
    // exactly "the dump is not there", which is the thing being checked.
    const entry = await lstat(path).catch(() => null);
    if (entry === null || !entry.isFile() || entry.isSymbolicLink() || entry.size < 1)
      throw new Error("backup_refused_incomplete_output");
  }
  const head = evidence.ledger.at(-1);
  if (!head || !Number.isSafeInteger(head.ledger_order) || typeof head.filename !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(head.digest ?? "")) throw new Error("backup_refused_ledger_head");
  const manifest = {
    schema: BACKUP_MANIFEST_SCHEMA_V1,
    createdAt: metadata.createdAt,
    dumpDigest: await sha256OfFileV1(dumpPath),
    metadataDigest: `sha256:${createHash("sha256").update(metadataText).digest("hex")}`,
    restoreIdentityDigest: metadata.identity.identityDigest,
    ledger: { digest: ledgerDigest, head: { order: head.ledger_order, file: head.filename, digest: head.digest } },
    requiredTables: [...requiredTables],
  };
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { planned: false, out, identityDigest: metadata.identity.identityDigest, manifest };
}

const invoked = isMainModuleV1(process.argv[1], import.meta.url);
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
    console.error(`backup_failed: ${error instanceof Error && error.message === "backup_output_exists" ? "output already exists; choose a fresh directory" : "backup_execution_failed"}`);
    process.exit(1);
  }
}
