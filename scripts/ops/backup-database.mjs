// Mac-local database backup wrapper. It reuses the production snapshot-bound
// pg_dump implementation and adds an outer digest manifest used before restore.
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupDatabase } from "../../deploy/postgres/backup-database.mjs";

export const VERIFIED_BACKUP_MANIFEST_V1 = "control-room.verified-database-backup/v1";
export const MAC_BACKUP_REQUIRED_TABLES_V1 = Object.freeze([
  "tenants", "workspaces", "projects", "control_web_task_commands", "control_harness_runs", "control_harness_run_events",
]);
const sha256File = async path => `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;

export async function createMacLocalDatabaseBackupV1({ source, out, pgBin = "/opt/homebrew/bin",
  now = () => new Date().toISOString(), backup = backupDatabase }) {
  if ((typeof source !== "string" && (!source || typeof source !== "object")) || typeof out !== "string"
    || !isAbsolute(out) || resolve(out) !== out || typeof pgBin !== "string" || !isAbsolute(pgBin))
    throw new Error("database_backup_arguments_refused");
  const ledger = JSON.parse(await readFile(new URL("../../deploy/postgres/migration-ledger.json", import.meta.url), "utf8"));
  const result = await backup({ source, out, pgBin, requiredTables: MAC_BACKUP_REQUIRED_TABLES_V1,
    ledgerDigest: `sha256:${ledger.digest}`, release: "mac-local" });
  if (result?.planned !== false || !/^sha256:[a-f0-9]{64}$/u.test(result.identityDigest ?? ""))
    throw new Error("database_backup_incomplete");
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
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

function flag(args, name) { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), source = flag(args, "--source"), out = flag(args, "--out"), pgBin = flag(args, "--pg-bin");
    if (!source || !out || args.some((value, index) => index % 2 === 0 && !["--source", "--out", "--pg-bin"].includes(value)))
      throw new Error("usage: backup-database.mjs --source CONNECTION --out ABSOLUTE_DIRECTORY [--pg-bin ABSOLUTE_DIRECTORY]");
    const result = await createMacLocalDatabaseBackupV1({ source, out, ...(pgBin ? { pgBin } : {}) });
    console.log(`database backup created and bound: ${result.restoreIdentityDigest}`);
  } catch (error) {
    console.error(`database backup failed: ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
  }
}
