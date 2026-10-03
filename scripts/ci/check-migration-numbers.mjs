import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
// Refuses two files in db/migrations/ that claim the same 4-digit migration number.
//
// Migration numbers are an ordering, and the applier orders by filename, so a shared
// number is not a cosmetic clash: `0100_a.sql` and `0100_b.sql` have a defined order but
// no defined intent, and two pull requests can each be correct against main and wrong
// together. That is exactly what happened on this repository — two open pull requests
// both added 0100_*, three added 0093_* — and nothing refused either.
//
// This reads the directory rather than the git index, because the directory is what the
// production applier reads (scripts/generate-migration-ledger.mjs), and a guard that
// watches a different source than the thing it guards watches the wrong thing.
//
// Four digits exactly. `00931_x.sql` is not a member of `0093`'s collision group: the
// ledger still orders it distinctly from `0093_y.sql`, so treating it as a duplicate
// would report a state it does not describe. See the decision log; the scope here is
// duplicate numbers, not the numbering convention.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIRECTORY = join("db", "migrations");

// Exactly four digits, then a character that is not a digit. The lookahead is what keeps
// a five-digit name out of a four-digit collision group.
const MIGRATION_NUMBER = /^(?<number>[0-9]{4})(?![0-9])/u;

export function migrationNumber(name) {
  return MIGRATION_NUMBER.exec(name)?.groups?.number ?? null;
}

export function listMigrationNames(directory) {
  // Every non-directory entry, not just .sql. The ledger happens to apply only .sql
  // today, so a .sql-only filter would make the cheapest possible bypass — add a
  // colliding file with another extension — while a human still reads the clash as a
  // duplicate number. A symlink is deliberately not excluded: counting it is the safe
  // direction, and scripts/check-migration-changes.mjs already refuses non-regular
  // files in this directory.
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

export function findDuplicateMigrationNumbers(names) {
  const byNumber = new Map();
  for (const name of names) {
    const number = migrationNumber(name);
    if (number === null) continue;
    const group = byNumber.get(number) ?? [];
    group.push(name);
    byNumber.set(number, group);
  }
  return [...byNumber.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([number, group]) => ({ number, files: group }));
}

export function checkMigrationNumbers({ root = process.cwd(), directory = MIGRATIONS_DIRECTORY } = {}) {
  let names;
  try {
    names = listMigrationNames(join(root, directory));
  } catch (error) {
    return { ok: false, duplicates: [], scanned: 0, error: `cannot read ${directory}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const duplicates = findDuplicateMigrationNumbers(names);
  return {
    ok: duplicates.length === 0,
    duplicates,
    scanned: names.length,
    error: null,
  };
}

function main() {
  const result = checkMigrationNumbers();
  if (result.error !== null) {
    console.error(`migration number check failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    console.error(`migration number check failed: ${result.duplicates.length} duplicated 4-digit number(s) in db/migrations/:`);
    for (const { number, files } of result.duplicates) {
      console.error(`  ${number}_: ${files.join(", ")}`);
    }
    console.error("Migrations are applied in filename order, so a shared number has an order but no intent. Renumber the later file; a shipped migration must not be edited (scripts/check-migration-changes.mjs).");
    process.exitCode = 1;
    return;
  }
  console.log(`migration number check passed: ${result.scanned} migration file(s), no duplicated 4-digit number`);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
