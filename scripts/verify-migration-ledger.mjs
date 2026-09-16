// Verifies the working tree matches the committed deploy/postgres/migration-ledger.json.
// Fails on altered, missing, reordered or extra files. Run: pnpm db:verify.
// Accepts --ledger <path> and --root <dir> so tests can exercise refusal paths.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLedgerEntries, ledgerDigest } from "./generate-migration-ledger.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

/**
 * @param {{ rootDir?: string, ledgerPath?: string }} [options]
 * @returns {Promise<{ files: number, digest: string }>}
 */
export async function verifyMigrationLedger({ rootDir = root, ledgerPath } = {}) {
  const committed = JSON.parse(await readFile(ledgerPath ?? join(rootDir, "deploy/postgres/migration-ledger.json"), "utf8"));
  assert.equal(committed.version, 1, "migration_ledger_version");
  let entries;
  try {
    entries = await collectLedgerEntries(rootDir);
  } catch (error) {
    throw new Error(`migration_ledger_collect_failed: ${error.message}`, { cause: error });
  }
  assert.equal(entries.length, committed.entries.length, "migration_ledger_count");
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index], pinned = committed.entries[index];
    assert.equal(current.file, pinned.file, `migration_ledger_order:${current.file}`);
    assert.equal(current.order, pinned.order, `migration_ledger_order:${current.file}`);
    assert.equal(current.kind ?? "migrate", pinned.kind ?? "migrate", `migration_ledger_kind:${current.file}`);
    assert.equal(current.sha256, pinned.sha256, `migration_ledger_altered:${current.file}`);
  }
  assert.equal(ledgerDigest(entries), committed.digest, "migration_ledger_digest");
  return { files: entries.length, digest: committed.digest };
}

const invoked = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const result = await verifyMigrationLedger({
      rootDir: resolve(flag("--root", root)), ledgerPath: flag("--ledger", undefined),
    });
    console.log(`migration ledger verified: ${result.files} files digest=sha256:${result.digest}`);
  } catch (error) {
    console.error(`migration_ledger_invalid: ${error.message}`);
    process.exit(1);
  }
}
