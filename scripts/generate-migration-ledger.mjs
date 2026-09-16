// Generates deploy/postgres/migration-ledger.json from the exact ordered bytes of
// db/migrations/*.sql plus the role/provision SQL the production applier applies.
// Run: pnpm db:ledger. The committed ledger is the immutable order/checksum record;
// scripts/verify-migration-ledger.mjs (pnpm db:verify) fails on any drift.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/**
 * @param {string} [rootDir]
 */
export async function collectLedgerEntries(rootDir = root) {
  const migrationDir = join(rootDir, "db/migrations");
  const files = (await readdir(migrationDir)).filter(name => name.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("migration_ledger_empty");
  const entries = [];
  let order = 0;
  for (const file of files) {
    order += 1;
    const bytes = await readFile(join(migrationDir, file));
    entries.push({ file: `db/migrations/${file}`, order, sha256: sha256(bytes), kind: "migrate" });
  }
  for (const [file, kind] of [["db/roles/production_roles.sql", "grants"],
      ["db/roles/production_table_grants.sql", "grants"],
      ["db/roles/production_provision.sql", "provision"]]) {
    order += 1;
    const bytes = await readFile(join(rootDir, file), "utf8");
    entries.push({ file, order, sha256: sha256(bytes), kind });
  }
  return entries;
}

export function ledgerDigest(entries) {
  return sha256(JSON.stringify(entries.map(entry => [entry.file, entry.order, entry.sha256, entry.kind ?? "migrate"])));
}

const invoked = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (invoked) {
  const entries = await collectLedgerEntries();
  const ledger = { version: 1, digest: ledgerDigest(entries), entries };
  const target = join(root, "deploy/postgres/migration-ledger.json");
  await writeFile(target, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`migration ledger: ${entries.length} entries digest=sha256:${ledger.digest}`);
}
