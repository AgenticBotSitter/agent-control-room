#!/usr/bin/env node
// Runs a real-PostgreSQL test with the migration ledger re-derived first, so a
// mutation check can edit a MIGRATION and still be a fair test.
//
// Why this exists: the ledger is content-addressed and deliberately refuses a
// migration file whose bytes differ from the one that was applied, which is what
// stops a tampered migration from being applied to a Mac that already has it. A
// mutation check necessarily edits a migration on purpose, and the ledger's
// refusal would be reported as a guard failing when nothing about the guard
// changed.
//
// So this re-ledgers, runs the test, and re-ledgers AGAIN to put the tree back
// the way it was. The ledger only ever describes files already in the tree; it
// grants nothing and applies nothing, so re-deriving it cannot loosen a check.
// If the test fails, the exit code is the test's, which is what the mutation
// checker reads.
//
// Usage: node scripts/ci/run-mutation-postgres-test.mjs <node-test-args...>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const LEDGER = resolve(root, "deploy/postgres/migration-ledger.json");
const ledgerBefore = readFileSync(LEDGER);

const reledger = (reason) => {
  const result = spawnSync("pnpm", ["run", "db:ledger"], { cwd: root, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`run-mutation-postgres-test: re-ledger failed (${reason}):\n${result.stderr ?? ""}\n`);
    return false;
  }
  return true;
};

if (!reledger("before the test")) process.exit(2);
const test = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" });
// Restore the committed ledger, and do it LAST. The caller restores the mutated
// file itself once this exits, so re-deriving here would describe a migration
// that is about to be un-mutated. Leaving a re-derived ledger behind would
// instead make every LATER check refuse to run on a dirty checkout, and that
// would look like a failure of those checks rather than of this one.
writeFileSync(LEDGER, ledgerBefore);
process.exit(test.status ?? 2);
