import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
import { reserveBackupGenerationV1, assertBackupGenerationV1, sha256BackupFileV1 as sha256File } from "../../src/installer/shared/backup-files.mjs";
// Mac-local database backup wrapper. It reuses the production snapshot-bound
// pg_dump implementation and adds an outer digest manifest used before restore.
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BACKUP_MANIFEST_SCHEMA_V1, backupDatabase } from "../../deploy/postgres/backup-database.mjs";

// Re-exported rather than re-declared: the schema string is one constant, owned
// by the module that WRITES the manifest, and the verifier reads it from here.
// Two literals that happen to agree today are two literals that can stop
// agreeing without anything noticing.
//
// Imported AND exported under the historical name, because a bare
// `export { X as Y }` creates no local binding and this module uses the name
// below as well as publishing it.
export { BACKUP_MANIFEST_SCHEMA_V1 as VERIFIED_BACKUP_MANIFEST_V1 };
const VERIFIED_BACKUP_MANIFEST_V1 = BACKUP_MANIFEST_SCHEMA_V1;
export const MAC_BACKUP_REQUIRED_TABLES_V1 = Object.freeze([
  "tenants", "workspaces", "projects", "control_web_task_commands", "control_harness_runs", "control_harness_run_events",
]);

export async function createMacLocalDatabaseBackupV1({ source, out, pgBin = "/opt/homebrew/bin",
  now = () => new Date().toISOString(), backup = backupDatabase, generation = undefined }) {
  if ((typeof source !== "string" && (!source || typeof source !== "object")) || typeof out !== "string"
    || !isAbsolute(out) || resolve(out) !== out || typeof pgBin !== "string" || !isAbsolute(pgBin))
    throw new Error("database_backup_arguments_refused");
  generation ??= await reserveBackupGenerationV1(out);
  await assertBackupGenerationV1(out, generation);
  const ledger = JSON.parse(await readFile(new URL("../../deploy/postgres/migration-ledger.json", import.meta.url), "utf8"));
  const result = await backup({ source, out, pgBin, generation, requiredTables: MAC_BACKUP_REQUIRED_TABLES_V1,
    ledgerDigest: `sha256:${ledger.digest}`, release: "mac-local" });
  if (result?.planned !== false || !/^sha256:[a-f0-9]{64}$/u.test(result.identityDigest ?? ""))
    throw new Error("database_backup_incomplete");
  await assertBackupGenerationV1(out, generation);
  const dumpPath = join(out, "database.dump"), metadataPath = join(out, "metadata.json");
  for (const path of [dumpPath, metadataPath]) {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1) throw new Error("database_backup_output_refused");
  }
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const head = metadata.evidence?.ledger?.at(-1);
  if (!head || !Number.isSafeInteger(head.ledger_order) || typeof head.filename !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(head.digest ?? "")) throw new Error("database_backup_ledger_head_refused");
  const createdAt = now();
  if (typeof createdAt !== "string" || new Date(createdAt).toISOString() !== createdAt)
    throw new Error("database_backup_timestamp_refused");
  const manifest = Object.freeze({ schema: VERIFIED_BACKUP_MANIFEST_V1, createdAt,
    dumpDigest: await sha256File(dumpPath), metadataDigest: await sha256File(metadataPath),
    restoreIdentityDigest: result.identityDigest, ledger: Object.freeze({ digest: `sha256:${ledger.digest}`,
      head: Object.freeze({ order: head.ledger_order, file: head.filename, digest: head.digest }) }),
    requiredTables: MAC_BACKUP_REQUIRED_TABLES_V1 });
  // The producer may have written its own manifest (R4B-10 — the scheduled
  // nightly path always does now). It is REPLACED by this one, which is the
  // Mac-local wrapper's authority: same digests, `mac-local` required-table
  // list, and the ledger this checkout pins. `rm` first because the producer
  // writes with `flag: "wx"`, which would otherwise refuse.
  const manifestPath = join(out, "manifest.json");
  await rm(manifestPath, { force: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

function flag(args, name) { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; }
const USAGE = "usage: backup-database.mjs --source CONNECTION --out ABSOLUTE_DIRECTORY [--pg-bin ABSOLUTE_DIRECTORY]";
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  try {
    const args = process.argv.slice(2), source = flag(args, "--source"), out = flag(args, "--out"), pgBin = flag(args, "--pg-bin");
    if (!source || !out || args.some((value, index) => index % 2 === 0 && !["--source", "--out", "--pg-bin"].includes(value)))
      throw new Error(USAGE);
    const result = await createMacLocalDatabaseBackupV1({ source, out, ...(pgBin ? { pgBin } : {}) });
    console.log(`database backup created and bound: ${result.restoreIdentityDigest}`);
  } catch (error) {
    console.error(`database backup failed: ${error instanceof Error && error.message === USAGE ? USAGE : error instanceof Error && error.message === "backup_output_exists" ? "output already exists; choose a fresh directory" : "database_backup_execution_failed"}`);
    process.exitCode = 1;
  }
}
