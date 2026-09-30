// The real-PostgreSQL attack kit builds a Mac-local cluster and then runs the
// PRODUCTION startup preflights against its logins. `verifyPgBossApplicationPermissions`
// is exact-equality over the pg-boss queue schema, so the coordinator's queue
// privileges in that fixture have to be exactly the ones the installer grants.
//
// They were not. The kit applied `db/roles/native_queue_recovery_roles.sql`,
// which grants the coordinator UPDATE on sixteen `job`/`job_common` columns
// that no production path applies. A correctly installed Mac database therefore
// failed its own coordinator preflight, and the only lane that noticed was the
// M6 recurring PostgreSQL lane: `private_database_preflight_failed` at the
// coordinator check, after the web preflight had passed.
//
// Nothing else could have caught it without a cluster.
// `tests/private-web-role-preflight-declaration.test.ts` deliberately skips
// schema-qualified objects — "pg-boss objects live in their own schema and are
// verified by the native queue preflight" — so the queue ACL was the one
// privilege set with no offline check, and the fixture was the only definition
// of "correct" for it. This closes that gap offline.
//
// Scope: the coordinator's queue ACL only. A whole-file comparison of the kit's
// role files against the installer's is NOT asserted, because it is not true
// for reasons outside this stream and asserting it would encode one side of an
// open decision. The two known gaps are recorded here as evidence, not as
// expectations, so this file stays honest about what it does and does not prove.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_ROLE_FILES } from "./support/attack-kit/real-postgres.ts";
import { macRolePlan } from "../scripts/mac-local/database-upgrade-grants.mjs";

const ROLE_DIRECTORY = join(process.cwd(), "db/roles");
const PROVISIONER_SOURCE = join(process.cwd(), "scripts/mac-local/narrow-role-provision.mjs");
const RECOVERY_ROLE_FILE = "native_queue_recovery_roles.sql";
const COORDINATOR = "control_room_task_coordinator";
const QUEUE_SCHEMA = "control_room_queue";
/** The Mac-local group roles, read from the installer's own `macRolePlan` so
 * this guard cannot drift from the set of logins the installer provisions. */
const MAC_GROUPS = new Set<string>(Object.values(macRolePlan));
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** The role files the narrow-role installer applies to a Mac-local cluster.
 *
 * Read out of the installer's own source instead of restated: a restatement
 * would keep passing after the installer changed, which is the drift this
 * guard exists to catch. */
function productionRoleFiles(): string[] {
  const source = readFileSync(PROVISIONER_SOURCE, "utf8");
  const match = /const roleFiles = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(match, "the narrow-role provisioner no longer declares its roleFiles list where this test reads it");
  const files = [...match[1]!.matchAll(/"([^"]+\.sql)"/g)].map(entry => entry[1]!);
  assert.ok(files.length > 0, "the narrow-role provisioner's roleFiles list parsed empty");
  return files;
}

function readRoleSources(files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map(file => [file, readFileSync(join(ROLE_DIRECTORY, file), "utf8")]));
}

/** Every grant a set of role files makes to a Mac-local group role, as
 * `role|kind|object|column|privilege`.
 *
 * Both sides of the comparison below go through this one reader, so a
 * difference always means the two file sets grant differently and never that
 * two parsers disagree about the same SQL. The installer's own
 * `desiredMacGrantsV1` is deliberately not reused: it refuses any file outside
 * its seven, which is the right refusal for an operator tool and the wrong one
 * here, because the files production does NOT apply are this guard's subject. */
function macGrants(sources: Record<string, string>): Set<string> {
  const tuples = new Set<string>();
  const text = Object.values(sources).map(source => source.replace(/--[^\n]*/g, "")).join("\n");
  for (const raw of text.split(";")) {
    const statement = raw.trim();
    // Role membership (`GRANT a TO b`) has no ON clause and is not a table
    // privilege; it is what lets a login reach its group role at all.
    if (!/^GRANT\b/i.test(statement) || !/\bon\b/i.test(statement)) continue;
    const match = /^GRANT\s+([\s\S]*?)\s+ON\s+(?:(SCHEMA|FUNCTION|TABLE)\s+)?([\s\S]*?)\s+TO\s+([\s\S]*)$/i.exec(statement);
    assert.ok(match, `unreadable GRANT statement: ${statement.slice(0, 120)}`);
    // A column list belongs to the PRIVILEGE, not the object list:
    // `GRANT UPDATE (a, b) ON t ...`, never `GRANT UPDATE ON t (a, b) ...`.
    const listed = /\(([^()]*)\)\s*$/i.exec(match[1]!.trim());
    const columns = listed ? listed[1]!.split(",").map(column => column.trim()).filter(Boolean) : [""]!;
    const kind = (match[2] ?? "TABLE").toUpperCase();
    const privileges = (listed ? match[1]!.trim().slice(0, listed.index) : match[1]!)
      .split(",").map(privilege => privilege.trim().toUpperCase())
      .filter(privilege => (PRIVILEGES as readonly string[]).includes(privilege));
    for (const role of match[4]!.split(",").map(name => name.trim()).filter(Boolean)) {
      if (!MAC_GROUPS.has(role)) continue;
      for (const object of match[3]!.split(",").map(name => name.trim()).filter(Boolean)) {
        for (const privilege of privileges) {
          for (const column of columns) {
            const qualified = object.includes(".") || kind === "SCHEMA" ? object : `public.${object}`;
            tuples.add(`${role}|${kind === "SCHEMA" ? "schema" : kind === "FUNCTION" ? "function" : "table"}`
              + `|${qualified}|${column}|${privilege}`);
          }
        }
      }
    }
  }
  return tuples;
}

/** Only the coordinator's grants inside the pg-boss queue schema, which is
 * exactly the set `verifyPgBossApplicationPermissions` compares by equality. */
function coordinatorQueueGrants(sources: Record<string, string>): Set<string> {
  return new Set([...macGrants(sources)].filter(item =>
    item.startsWith(`${COORDINATOR}|`) && item.includes(QUEUE_SCHEMA)));
}

test("the coordinator's pg-boss queue grants equal the installer's exactly", () => {
  // Extra is the failure that happened: a fixture privilege production never
  // grants, which rejects a correctly installed database at startup. Missing is
  // the same drift the other way, which would let a real queue grant stop being
  // proven at all.
  const production = coordinatorQueueGrants(readRoleSources(productionRoleFiles()));
  const kit = coordinatorQueueGrants(readRoleSources(DEFAULT_ROLE_FILES));
  const extra = [...kit].filter(item => !production.has(item)).sort();
  const missing = [...production].filter(item => !kit.has(item)).sort();
  assert.deepEqual({ extra, missing }, { extra: [], missing: [] },
    "the attack kit's coordinator pg-boss queue ACLs differ from the installer's, so a correctly"
    + " installed Mac database fails its own coordinator preflight (or stops proving a real grant)");
});

test("the kit does not apply the queue-recovery grants production never grants", async () => {
  // Named separately so the regression reads as the specific authority it is
  // rather than an anonymous diff entry. That role file is an offline candidate
  // an owner must grant explicitly; a fixture that inherits it gives every
  // real-PostgreSQL lane sixteen UPDATE privileges the coordinator does not
  // have in production.
  assert.equal(DEFAULT_ROLE_FILES.includes(RECOVERY_ROLE_FILE), false,
    `${RECOVERY_ROLE_FILE} is an owner-granted authority, not a fixture default`);
  // And it still exists, so an owner can grant it deliberately through
  // `extraRoleFiles` rather than every test inheriting it.
  await readFile(join(ROLE_DIRECTORY, RECOVERY_ROLE_FILE), "utf8");
});

test("the comparison above reads the exact queue ACL the preflight checks", () => {
  // A test of the test. A reader that silently matched nothing would make the
  // two-way comparison above vacuously equal, so the expected shape is proved
  // present instead of an empty diff being read as parity. These are the grants
  // the non-recovery profile requires: read the queue metadata, one column of
  // UPDATE for row locking, and INSERT on the job tables to enqueue.
  const kit = coordinatorQueueGrants(readRoleSources(DEFAULT_ROLE_FILES));
  assert.ok(kit.size > 0, "the kit grants the coordinator no pg-boss queue privilege at all");
  for (const expected of [
    `${COORDINATOR}|table|${QUEUE_SCHEMA}.version||SELECT`,
    `${COORDINATOR}|table|${QUEUE_SCHEMA}.queue||SELECT`,
    `${COORDINATOR}|table|${QUEUE_SCHEMA}.queue|name|UPDATE`,
    `${COORDINATOR}|table|${QUEUE_SCHEMA}.job||INSERT`,
  ]) assert.ok(kit.has(expected), `the parsed coordinator queue ACLs lack ${expected}`);
  // The schema USAGE grant the preflight also requires, read from the source
  // so it is proved present without widening this reader to non-table
  // privileges (which would widen the parity comparison above too).
  assert.match(readRoleSources(DEFAULT_ROLE_FILES)["native_queue_producer_roles.sql"]!,
    new RegExp(`GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO ${COORDINATOR};`));
  // And the sixteen recovery columns must NOT be among them: this is the exact
  // set that made the fixture fail a correct production database.
  for (const column of ["state", "data", "priority", "retry_delay", "dead_letter"]) {
    assert.equal(kit.has(`${COORDINATOR}|table|${QUEUE_SCHEMA}.job|${column}|UPDATE`), false,
      `the coordinator unexpectedly holds UPDATE on job.${column}`);
  }
});
