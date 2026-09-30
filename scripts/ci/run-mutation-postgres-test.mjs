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
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const ledger = ["run", "db:ledger"];

const reledger = (reason) => {
  const result = spawnSync("pnpm", ledger, { cwd: root, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`run-mutation-postgres-test: re-ledger failed (${reason}):\n${result.stderr ?? ""}\n`);
    return false;
  }
  return true;
};

if (!reledger("before the test")) process.exit(2);
const test = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" });
// The tree goes back to its committed state either way, so a failure here can
// never leave a mutated migration behind for the next command to find.
if (!reledger("after the test")) process.exit(2);
process.exit(test.status ?? 2);
