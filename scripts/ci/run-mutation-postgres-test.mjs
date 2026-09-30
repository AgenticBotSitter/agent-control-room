#!/usr/bin/env node
// Runs a real-PostgreSQL test with the migration ledger re-derived first, so a
// mutation check can edit a MIGRATION and still be a fair test.
//
// Two problems this solves, both of which make a mutation check report a failure
// that is not about the guard:
//
// 1. THE LEDGER. It is content-addressed and deliberately refuses a migration file
//    whose bytes differ from the one that was applied, which is what stops a
//    tampered migration reaching a Mac that already has it. A mutation check
//    necessarily edits a migration on purpose, so the ledger's refusal would be
//    reported as a guard failing when nothing about the guard changed. The ledger
//    only ever describes files already in the tree; it grants nothing and applies
//    nothing, so re-deriving it cannot loosen a check.
//
// 2. THE PORT. Every entry in a manifest usually names the same test, so a
//    30-entry manifest runs that test 120 times, and each run's cluster has to
//    release the port before the next one binds it. When one lags by a moment the
//    next run fails with `refusing_occupied_port`, which the checker reads as the
//    guard failing. So this WAITS for a port in the assigned range to be free.
//    Rotating by a counter was the first attempt and does not work: most entries
//    name the same test, so a counter would have to be threaded through the
//    checker, and deriving the port from the arguments gives the same answer for
//    the same test - which is the case that needs it most. Waiting is bounded and
//    stays inside the range the cook-mode rules allow.
//
// The committed ledger is restored LAST, because the caller restores the mutated
// file itself once this exits: re-deriving after that point would describe a
// migration that is about to be un-mutated, and leaving a re-derived ledger behind
// would make every LATER check refuse to run on a dirty checkout.
//
// Usage: node scripts/ci/run-mutation-postgres-test.mjs <node-test-args...>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const LEDGER = resolve(root, "deploy/postgres/migration-ledger.json");
const ledgerBefore = readFileSync(LEDGER);
const args = process.argv.slice(2);

const reledger = (reason) => {
  const result = spawnSync("pnpm", ["run", "db:ledger"], { cwd: root, stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`run-mutation-postgres-test: re-ledger failed (${reason}):\n${result.stderr ?? ""}\n`);
    return false;
  }
  return true;
};

const base = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59310);
const width = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_WIDTH ?? 10);

/** The port if nothing is listening on it, or null. Binds on the loopback to
 * ask the question the way a cluster would, then closes again so the cluster can
 * take it. */
const tryFreePort = (port) => new Promise((settle) => {
  const server = createServer();
  server.once("error", () => settle(null));
  server.listen(port, "127.0.0.1", () => server.close(() => settle(port)));
});

/** Wait for a free port in the assigned range. The previous cluster is usually
 * mid-shutdown, and waiting rather than failing is the entire reason this wrapper
 * exists. */
const waitForFreePort = async () => {
  const budget = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_WAIT_MS ?? 120_000);
  const deadline = Date.now() + budget;
  for (;;) {
    for (let port = base; port < base + width; port += 1) {
      const free = await tryFreePort(port);
      if (free !== null) return free;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(`run-mutation-postgres-test: no free port in ${base}..${base + width - 1}\n`);
      process.exit(2);
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
};

process.env.CONTROL_ROOM_PG_TEST_PORT_BASE = String(await waitForFreePort());

if (!reledger("before the test")) process.exit(2);
const test = spawnSync(process.execPath, ["--import", "tsx", "--test", ...args],
  { cwd: root, stdio: "inherit", env: process.env });
writeFileSync(LEDGER, ledgerBefore);
process.exit(test.status ?? 2);
