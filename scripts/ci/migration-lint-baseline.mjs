import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ledgerDigest } from "../generate-migration-ledger.mjs";

// This is the installed backlog accepted for lint debt by the owner. Never derive
// this anchor from HEAD, the PR base, or the current ledger: all can gain new SQL.
export const APPLIED_LEDGER_REVISION = "d53b7e713af13a5af379004bfec5357953aa8a68";
export const APPLIED_LEDGER_DIGEST = "b116c38bd01e4b61549c9f2af77d0b8a049ec6ae36912f80d19e7e64fecc7a65";
export const ACCEPTED_MIGRATIONS_DIGEST = "905557785d6bb25bf5f39dff23a1d47361ce8a75c814da6fd4340ce0765fc060";
export const BASELINE_PATH = "scripts/ci/migration-lint-baseline.json";
const LEDGER_PATH = "deploy/postgres/migration-ledger.json";

function verifyLedger(ledger) {
  assert.equal(ledger.version, 1, "migration_lint_ledger_version");
  assert.equal(ledger.digest, ledgerDigest(ledger.entries), "migration_lint_ledger_digest");
}

export function validateAcceptedBaseline(baseline, currentLedger) {
  verifyLedger(currentLedger);
  assert.equal(baseline.version, 1, "migration_lint_baseline_version");
  assert.equal(baseline.appliedRevision, APPLIED_LEDGER_REVISION, "migration_lint_baseline_revision");
  assert.equal(baseline.appliedLedgerDigest, APPLIED_LEDGER_DIGEST, "migration_lint_applied_anchor");
  // Pin the exact accepted list independently of the current ledger. Reading the
  // old commit at runtime would break after a squash merge removes its ancestry.
  // Additions, substitutions, duplicates and role files all change this digest.
  const digest = createHash("sha256").update(JSON.stringify(baseline.entries)).digest("hex");
  assert.equal(digest, ACCEPTED_MIGRATIONS_DIGEST, "migration_lint_baseline_widened_or_changed");
  const accepted = baseline.entries;
  for (const entry of accepted) {
    const matches = currentLedger.entries.filter(current => current.file === entry.file);
    assert.equal(matches.length, 1, `migration_lint_baseline_ledger_entry:${entry.file}`);
    assert.equal(matches[0].kind, "migrate", `migration_lint_baseline_ledger_kind:${entry.file}`);
    assert.equal(matches[0].sha256, entry.sha256, `migration_lint_baseline_ledger_digest:${entry.file}`);
  }
  return accepted;
}

export function selectMigrationsOutsideBaseline({ cwd, baselinePath = BASELINE_PATH }) {
  const baseline = JSON.parse(readFileSync(join(cwd, baselinePath), "utf8"));
  const currentLedger = JSON.parse(readFileSync(join(cwd, LEDGER_PATH), "utf8"));
  const accepted = validateAcceptedBaseline(baseline, currentLedger);
  for (const { file, sha256 } of accepted) {
    const actual = createHash("sha256").update(readFileSync(join(cwd, file))).digest("hex");
    assert.equal(actual, sha256, `migration_lint_applied_file_changed:${file}`);
  }
  const acceptedPaths = new Set(accepted.map(entry => entry.file));
  // Scan all SQL, including uncommitted files and files already merged to main.
  // The baseline is fixed; a merge or a retry never buys a lint exemption.
  return readdirSync(join(cwd, "db/migrations"))
    .filter(name => name.endsWith(".sql"))
    .map(name => `db/migrations/${name}`)
    .filter(file => !acceptedPaths.has(file))
    .sort();
}
