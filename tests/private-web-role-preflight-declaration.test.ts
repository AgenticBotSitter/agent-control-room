// The private-web preflight decides, in code, which tables and columns the
// production web login may hold. The db/roles/*.sql files are what an operator
// actually applies, and more than one of them grants to this role: the fleet
// file adds the web role's read-only fleet tables. Nothing compared the two, so
// a migration could add a grant and the declaration could miss it. The web
// preflight then failed at startup with `private_database_preflight_failed`
// while the role was correct — exactly how the 0190 news grant broke the fleet
// lane after the fleet+MCP merge.
//
// This compares them statically, so the drift is caught without a database and
// without waiting for whichever real-PostgreSQL lane runs the preflight last. A
// real cluster still proves the declaration matches effective privileges; this
// proves the declaration tracks the role files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { privateWebReadTables, privateWebInsertColumns, privateWebReadColumns,
  privateWebInsertTables, privateWebUpdateColumns, privateWebFleetReadTables }
  from "../src/web/v1/private-database-preflight";

const ROLE_DIRECTORY = join(process.cwd(), "db/roles");
const PREFLIGHT_SOURCE = join(process.cwd(), "src/web/v1/private-database-preflight.ts");
const ROLE = "control_room_private_web";
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
type Privilege = typeof PRIVILEGES[number];
/** A granted column set, or `null` for a table-wide grant. */
type Columns = string[] | null;
/** `privilege -> table -> the columns granted, across every role file`. */
type Grants = Map<Privilege, Map<string, Columns>>;

/**
 * Combine two grants of one privilege on one table.
 *
 * `undefined` means not granted yet; `null` is a table-wide grant. A table-wide
 * grant absorbs any column list because it already covers every column, so it
 * wins in either order. Otherwise the column lists accumulate, because separate
 * statements may each name a subset: `private_web_roles.sql` grants
 * `UPDATE (web_lock)` on control_jobs and then the three stage columns.
 */
function mergeGrant(existing: Columns | undefined, granted: Columns): Columns {
  if (existing === null || granted === null) return null;
  return [...new Set([...(existing ?? []), ...granted])];
}

/** Every table `GRANT` of a table privilege to `role` in one SQL file. */
function parseGrants(sql: string, role: string): Grants {
  const grants: Grants = new Map();
  const withoutComments = sql.replace(/--[^\n]*/g, "");
  for (const raw of withoutComments.split(";")) {
    const statement = raw.trim();
    if (!/^GRANT\b/i.test(statement)) continue;
    // Role membership (`GRANT role_a TO role_b`) has no `ON` clause and is not a
    // table privilege; it is what lets the web login reach this role at all.
    // The `ON` clause is searched for case-insensitively, so `.` cannot be
    // given the dot-all flag: the demo tsconfig targets a lib without it.
    if (!/\bon\b/i.test(statement)) continue;
    // The privilege and object lists both span lines in the role files, so this
    // one match reads with `[\s\S]` in place of a dot-all flag.
    const match = /^GRANT\s+([\s\S]*?)\s+ON\s+(?:(SCHEMA|FUNCTION|TABLE)\s+)?([\s\S]*?)\s+TO\s+([\s\S]*)$/i.exec(statement);
    assert.ok(match, `unreadable GRANT statement: ${statement.slice(0, 120)}`);
    // `TO` takes a grantee list, so this role is one name among several.
    const grantees = match[4]!.split(",").map(name => name.trim());
    assert.ok(grantees.every(name => name !== ""), `unreadable grantee list: ${statement.slice(0, 120)}`);
    // A column list belongs to the PRIVILEGE, not the object list:
    // `GRANT UPDATE (a, b) ON t ...`, never `GRANT UPDATE ON t (a, b) ...`.
    const listed = /\(([^()]*)\)\s*$/i.exec(match[1]!.trim());
    const columns = listed
      ? listed[1]!.split(",").map(column => column.trim()).filter(column => column !== "")
      : null;
    const privileges = (listed ? match[1]!.trim().slice(0, listed.index) : match[1]!)
      .split(",").map(privilege => privilege.trim().toUpperCase()).filter(privilege => privilege !== "");
    if (!grantees.includes(role) || (match[2] ?? "TABLE").toUpperCase() !== "TABLE") continue;
    for (const table of match[3]!.split(",").map(name => name.trim()).filter(name => name !== "")) {
      for (const privilege of privileges) {
        if (!PRIVILEGES.includes(privilege as Privilege)) continue;
        const forPrivilege = grants.get(privilege as Privilege) ?? new Map<string, Columns>();
        forPrivilege.set(table, mergeGrant(forPrivilege.get(table), columns));
        grants.set(privilege as Privilege, forPrivilege);
      }
    }
  }
  return grants;
}

/** The web role's table privileges across every role file an operator applies. */
async function appliedGrants(): Promise<Grants> {
  const files = (await readdir(ROLE_DIRECTORY)).filter(file => file.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "no db/roles/*.sql files were found");
  const combined: Grants = new Map();
  for (const file of files) {
    const grants = parseGrants(await readFile(join(ROLE_DIRECTORY, file), "utf8"), ROLE);
    for (const [privilege, tables] of grants) {
      const target = combined.get(privilege) ?? new Map<string, Columns>();
      for (const [table, columns] of tables) target.set(table, mergeGrant(target.get(table), columns));
      combined.set(privilege, target);
    }
  }
  return combined;
}

/**
 * What the preflight accepts, in the same `columns | null` shape.
 *
 * It mirrors the preflight's own per-column test rather than restating it: a
 * column is expected readable when the table is in the table-wide read set OR
 * the column is in the column-scoped read map, and likewise for INSERT. So a
 * table in BOTH sets is expected to be entirely readable, which is what the
 * role files' two overlapping grants on `control_job_dependencies` — a
 * table-wide one and a three-column one — actually produce.
 *
 * The conditional read set is the fully-applied one: `privateWebFleetReadTables`
 * is folded in unconditionally here because this comparison is static and
 * asserts the declaration a FULL production install must hold. A Mac-local
 * cluster does not apply `fleet_gateway_roles.sql`, so it legitimately holds
 * none of them — the preflight asks for them only when
 * `control_room_fleet_gateway` exists, which the real-PostgreSQL lanes prove.
 * What matters statically is that the tables are declared at all, and declared
 * exactly, so they are added here.
 */
function acceptedGrants(): Grants {
  const wideReads = new Set<string>([...privateWebReadTables, ...privateWebFleetReadTables]);
  const selectable = new Map<string, Columns>();
  for (const table of new Set([...wideReads, ...Object.keys(privateWebReadColumns)])) {
    if (wideReads.has(table)) { selectable.set(table, null); continue; }
    const columns = privateWebReadColumns[table];
    if (columns) selectable.set(table, [...columns]);
  }
  const wideInserts = new Set<string>(privateWebInsertTables);
  const insertable = new Map<string, Columns>();
  for (const table of new Set([...wideInserts, ...Object.keys(privateWebInsertColumns)])) {
    if (wideInserts.has(table)) { insertable.set(table, null); continue; }
    const columns = privateWebInsertColumns[table];
    if (columns) insertable.set(table, [...columns]);
  }
  return new Map<Privilege, Map<string, Columns>>([
    ["SELECT", selectable],
    ["INSERT", insertable],
    ["UPDATE", new Map(Object.entries(privateWebUpdateColumns)
      .map(([table, columns]) => [table, [...columns]] as [string, Columns]))],
    // DELETE is declared at its single use site rather than in a set of its own,
    // so it is restated here and asserted below rather than read.
    ["DELETE", new Map(declaredDeletes().map(table => [table, null] as [string, Columns]))],
  ]);
}

/**
 * The one DELETE grant the preflight accepts, read out of the source.
 *
 * The DELETE set is the only web privilege that is not a module-level
 * declaration, so it cannot be imported. A source-level read means that if the
 * use site is ever widened or narrowed, this restatement fails loudly instead of
 * quietly comparing against a value that has stopped being the real one.
 */
function declaredDeletes(): string[] {
  const source = readFileSync(PREFLIGHT_SOURCE, "utf8");
  const match = /kind === "web"\s*\?\s*new Set\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(match, "the private-web preflight no longer declares its DELETE set where this test reads it");
  // The use site names its tables as string literals, so they are unquoted here.
  return match[1]!.split(",").map(table => table.trim().replace(/^["']|["']$/g, ""))
    .filter(table => table !== "");
}

test("every table the role files grant the web login is one the private-web preflight accepts", async () => {
  const applied = await appliedGrants();
  const accepted = acceptedGrants();
  const disagreements: string[] = [];

  for (const privilege of PRIVILEGES) {
    const granted = applied.get(privilege) ?? new Map<string, Columns>();
    const expected = accepted.get(privilege)!;
    // A table granted in the role files but not accepted is the failure this
    // test exists for: the real login holds a privilege the preflight refuses,
    // so a correct production database fails its own startup preflight.
    for (const table of granted.keys()) {
      if (!expected.has(table)) disagreements.push(`${ROLE} holds ${privilege} on ${table}, undeclared`);
    }
    // The reverse: a declared privilege the role files do not grant is stale,
    // and it would let a later widening pass unnoticed, because the two lists
    // would look reconciled.
    for (const table of expected.keys()) {
      if (!granted.has(table)) disagreements.push(`${privilege} on ${table} is declared, not granted`);
    }
    // A column set that is a subset, a superset, or the wrong shape changes what
    // the login can reach, so the columns are compared as well as the table.
    for (const [table, columns] of granted) {
      if (!expected.has(table)) continue;
      const wanted = expected.get(table)!;
      if ((wanted === null) !== (columns === null)) {
        disagreements.push(`${table}: ${privilege} is ${columns ? "column-scoped" : "table-wide"} in the role files`
          + ` but ${wanted ? "column-scoped" : "table-wide"} in the preflight`);
        continue;
      }
      if (columns && wanted) {
        const difference = [...wanted].filter(column => !columns.includes(column))
          .concat([...columns].filter(column => !wanted.includes(column))).sort();
        if (difference.length > 0) {
          disagreements.push(`${table}: ${privilege} columns differ from the role files: ${difference.join(", ")}`);
        }
      }
    }
  }

  assert.deepEqual(disagreements, [],
    "the private-web preflight and the db/roles files disagree; a correct database would fail startup");
});

test("the web DELETE declaration is read from the preflight, not restated here", () => {
  // A restatement of the DELETE set would pass while describing a value the
  // preflight no longer holds, so the read is asserted against the source it
  // parses, and the single grant it returns is the one the role files give.
  assert.deepEqual(declaredDeletes(), ["owner_web_push_subscriptions"]);
});

test("the fleet read tables come only from the fleet role file, and the preflight gates them on that role", async () => {
  // The eleven fleet tables are declared separately precisely because
  // db/roles/fleet_gateway_roles.sql is the ONLY file granting them to the web
  // role, and a Mac-local cluster never applies it. Two things have to stay
  // true together, or the preflight is wrong on some cluster:
  //   1. every one of them really is granted by the fleet file and by nothing
  //      else, so a Mac-local cluster holds none of them;
  //   2. the preflight still demands them whenever the fleet gateway role is
  //      present, so a full production install stays fully checked.
  const fleetFile = await readFile(join(ROLE_DIRECTORY, "fleet_gateway_roles.sql"), "utf8");
  const others = (await readdir(ROLE_DIRECTORY)).filter(file => file.endsWith(".sql") && file !== "fleet_gateway_roles.sql");
  for (const table of privateWebFleetReadTables) {
    assert.ok(parseGrants(fleetFile, ROLE).get("SELECT")?.has(table), `${table} is not granted by the fleet file`);
    // No non-fleet role file may also grant it: if one did, the conditional
    // would be wrong in the other direction, dropping the demand on a
    // Mac-local cluster that does hold the privilege. `parseGrants` returns
    // undefined for a role the file never grants to, which is the case here.
    for (const file of others) {
      const granted = parseGrants(await readFile(join(ROLE_DIRECTORY, file), "utf8"), ROLE).get("SELECT");
      assert.ok(granted === undefined || !granted.has(table),
        `${file} also grants ${table}; the conditional demand would be wrong`);
    }
  }
  // The gate is the role's existence, and it is the fleet file that creates it.
  assert.match(fleetFile, /CREATE ROLE control_room_fleet_gateway\b/);
  const source = readFileSync(PREFLIGHT_SOURCE, "utf8");
  assert.ok(source.includes("rolname='control_room_fleet_gateway'"),
    "the preflight no longer gates the fleet read tables on the gateway role's existence");
  // And the tables must not have crept back into the unconditional set, which
  // is what broke every Mac-local preflight in the first place.
  for (const table of privateWebFleetReadTables)
    assert.ok(!(privateWebReadTables as readonly string[]).includes(table),
      `${table} is back in the unconditional read set`);
});

test("the comparison above reads role files it has to be able to read", () => {
  // A test of the test: a parser that silently matched nothing would make the
  // comparison above vacuously pass, so the grammar it must read is asserted
  // directly. A role file that grows a statement this cannot parse fails here
  // rather than quietly dropping a grant from the comparison.
  const drift = parseGrants(
    `GRANT SELECT, INSERT ON control_widget_links TO ${ROLE};\n`
    + `GRANT UPDATE (state) ON control_widget_links TO ${ROLE};\n`
    + `GRANT SELECT ON control_widget_links TO control_room_task_coordinator;\n`
    + `-- GRANT SELECT ON control_commented_out TO ${ROLE};\n`
    + `GRANT control_room_schema_owner TO control_room_migrator;\n`
    + `GRANT USAGE ON SCHEMA public TO control_room_application, ${ROLE};\n`
    + `GRANT SELECT (alpha) ON control_two_statements TO ${ROLE};\n`
    + `GRANT SELECT (beta) ON control_two_statements TO ${ROLE};\n`, ROLE);
  assert.deepEqual([...(drift.get("SELECT")?.keys() ?? [])].sort(),
    ["control_two_statements", "control_widget_links"]);
  // Two statements naming different columns accumulate into one set, but only
  // while neither is table-wide.
  assert.deepEqual([...(drift.get("SELECT")?.get("control_two_statements") ?? [])].sort(), ["alpha", "beta"]);
  assert.deepEqual([...(drift.get("INSERT")?.keys() ?? [])], ["control_widget_links"]);
  assert.deepEqual(drift.get("UPDATE")?.get("control_widget_links"), ["state"]);
  assert.equal(drift.get("DELETE"), undefined);
  // A table-wide grant absorbs a column list seen in the same or an earlier file.
  assert.equal(parseGrants(
    `GRANT SELECT ON control_wide TO ${ROLE};\nGRANT SELECT (only_one) ON control_wide TO ${ROLE};`, ROLE)
    .get("SELECT")?.get("control_wide"), null);
});
