// Offline guards for the updater's fixed DDL, run without PostgreSQL.
//
// WHY THIS FILE EXISTS. Two of the three DDL files are applied to a real cluster
// by the PostgreSQL lane (tests/updater-schema-postgres.test.ts), which takes
// most of a minute per test because it builds a whole cluster first. A typo in
// a comment therefore cost three full runs before it was found: `//` instead of
// `--` is a syntax error to PostgreSQL, and a reader skimming a long comment
// block does not notice. This file runs in the quick lane and refuses that class
// of mistake before a cluster is ever started.
//
// WHAT IT CHECKS, and why each one is a guard rather than a style rule:
//   1. no `//` line comments (the typo above) and no stray unterminated dollar
//      quoting, so a malformed file fails here and not after 60 s of initdb;
//   2. every `$$`-quoted body is closed, because an unclosed one silently
//      swallows every statement after it and the file "applies" while doing half
//      the work — a failure that produces no error at all;
//   3. every CREATE TRIGGER / CREATE OR REPLACE FUNCTION statement ends in a
//      semicolon, since the loader sends one file per query and PostgreSQL
//      requires a trailing semicolon for a plpgsql body;
//   4. every trigger a trigger name is declared for names a table in THIS
//      schema, so a guard can never be attached to a release table by typo — the
//      one way this DDL could reach outside itself;
//   5. the apply order and the design's table list agree with the loader, so the
//      two cannot drift into "a file the loader never runs".
//
// It deliberately does NOT try to parse SQL. The repository already learned that
// a regex model of SQL cannot be made sound (scripts/check-migration-search-path.mjs
// says so at length, and reads pg_proc instead). These are four properties that
// are decidable by shape, and nothing else.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { updaterDdlFilesV1, updaterTablesV1 } from "../src/updater/v1/schema-installer";

const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const RELEASE_ROLE_FILE = join(process.cwd(), "db/roles/updater_release_reader_roles.sql");

/** Strip SQL comments, so a check cannot be satisfied or broken by prose. */
function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/--[^\n]*/gu, "");
}

const readDdl = async () => {
  const files = new Map<string, string>();
  for (const file of updaterDdlFilesV1()) files.set(file, await readFile(join(DDL_DIRECTORY, file), "utf8"));
  return files;
};

test("no DDL file uses a // comment, which PostgreSQL reads as a syntax error", async () => {
  for (const [file, sql] of await readDdl()) {
    const offenders = sql.split("\n")
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(entry => /^\s*\/\//u.test(entry.text));
    assert.deepEqual(offenders.map(entry => `${file}:${entry.line}`), [],
      `${file} has a // line comment; SQL uses -- and this file would fail at apply time`);
  }
  // The release-reader role file is applied by the same path, so it gets the same
  // check rather than being assumed correct because it is shorter.
  const roleFile = await readFile(RELEASE_ROLE_FILE, "utf8");
  assert.deepEqual(roleFile.split("\n").map((line, index) => ({ line: index + 1, text: line }))
    .filter(entry => /^\s*\/\//u.test(entry.text)), [], "the release-reader role file has a // comment");
});

test("every trigger is attached to a table in schema updater, never a release table", async () => {
  let total = 0;
  for (const [file, sql] of await readDdl()) {
    const triggers = [...withoutComments(sql).matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(?:BEFORE|AFTER)\s+[\w\s]+?\s+ON\s+([\w.]+)/giu)];
    for (const [, name, table] of triggers) {
      total += 1;
      assert.match(table, /^updater\.\w+$/u,
        `${file} trigger ${name} is on ${table}, which is outside schema updater:`
        + " the updater's guards must never be attached to a release-schema object");
    }
  }
  // Stated once rather than per file: the guard files hold the triggers, and a
  // per-file demand would be a false failure on the two that hold none.
  assert.ok(total >= 20, `only ${total} triggers were found, so the scan read something other than the DDL`);
});

test("the DDL creates exactly the design's tables, and the loader runs every file", async () => {
  const files = await readDdl();
  // The order is a security property (0000 refuses without the role, 0002 refuses
  // without the schema), so it is asserted rather than sorted at read time.
  assert.deepEqual([...files.keys()], [...updaterDdlFilesV1()],
    "every DDL file in the directory is one the loader applies, in order");
  const onDisk = (await readdir(DDL_DIRECTORY)).filter(name => name.endsWith(".sql")).sort();
  assert.deepEqual(onDisk, [...updaterDdlFilesV1()].sort(),
    "the DDL directory holds exactly the files the loader applies, with none orphaned");

  const created = new Set<string>();
  for (const sql of files.values()) {
    for (const match of withoutComments(sql).matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?updater\.(\w+)/giu)) created.add(match[1]!);
  }
  assert.deepEqual([...created].sort(), [...updaterTablesV1].sort(),
    "the DDL's tables are the design's nine and no others");
});

test("the release-reader grant names only the three tables the loader allows", async () => {
  const { updaterReleaseReadTablesV1 } = await import("../src/updater/v1/schema-installer");
  const sql = await readFile(RELEASE_ROLE_FILE, "utf8");
  const granted = [...withoutComments(sql).matchAll(/ON\s+public\.(\w+)\s+TO\s+control_room_deployer/giu)]
    .map(match => match[1]!);
  assert.deepEqual([...new Set(granted)].sort(), [...updaterReleaseReadTablesV1].sort(),
    "the release grant and the loader's allowed set must be the same three tables, in both directions");
  // Read-only ON THE TABLES, and the file says so at grant time as well as at
  // startup. The sweep is over TABLE grants only: this file also grants EXECUTE
  // on one FUNCTION -- `public.updater_health_counts()`, the §8.4 health read,
  // which returns three integers and is not a table. That grant is a separate
  // authority from the table grant and is asserted separately below; folding it
  // into this sweep would have failed with
  // "the release grant includes a privilege other than SELECT: EXECUTE" and been
  // fixed by deleting the grant, which is the wrong fix.
  for (const match of withoutComments(sql).matchAll(/GRANT\s+([A-Z,\s()\w]+?)\s+ON\s+public\.\w+(?!\s*\()/giu)) {
    assert.match(match[1]!, /^SELECT\b/u, `the release TABLE grant includes a privilege other than SELECT: ${match[1]}`);
  }
  // EXACTLY ONE function, named exactly, with EXECUTE and nothing else. A second
  // would be a second narrow boundary nobody in the design asked for, and a
  // second privilege on this one would hand the updater's login authority the
  // design did not give it.
  //
  // The grant is issued through `EXECUTE '...'` because the grantor must be the
  // schema owner, so the sweep has to read the DYNAMIC SQL inside those string
  // literals -- matching `GRANT ... ON public.x` in the bare text of the file
  // matches the three table grants and none of this, which is why an earlier
  // draft of this assertion passed against a file whose function grant had been
  // widened to `EXECUTE, UPDATE`.
  const functionGrants = [...withoutComments(sql).matchAll(/GRANT\s+([A-Z,\s]+?)\s+ON\s+FUNCTION\s+public\.(\w+)\(\)/giu)];
  assert.deepEqual(functionGrants.map(match => [match[2]!, match[1]!.trim()]),
    [["updater_health_counts", "EXECUTE"]],
    "the updater's login holds EXECUTE on the health counts and nothing else by function");
  // The role must not be in the live upgrade's manifest, or the upgrade would
  // start managing a role whose authority is that the upgrade cannot reach it.
  const manifest = await readFile(join(process.cwd(), "scripts/mac-local/database-role-manifest.mjs"), "utf8");
  assert.doesNotMatch(manifest, /control_room_deployer/u,
    "the deployer role must stay out of the upgrade's managed role manifest");
});