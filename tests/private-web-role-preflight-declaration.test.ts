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
  privateWebInsertTables, privateWebUpdateColumns, privateWebFleetReadTables, taskCoordinatorReadTables,
  taskCoordinatorInsertColumns, taskCoordinatorInsertTables, taskCoordinatorUpdateColumns, taskCoordinatorDeleteTables,
} from "../src/web/v1/private-database-preflight";

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

/** The privileges in a GRANT's privilege list, each with its own column list.
 * Walks the text so that `INSERT (a, b), UPDATE (c)` yields two entries with the
 * right columns rather than one mangled privilege name. */
function parsePrivileges(list: string): { privilege: string; columns: string[] | null }[] {
  const found: { privilege: string; columns: string[] | null }[] = [];
  // `<priv>`, optionally followed by `(cols)`, then a separator. The column list
  // is non-greedy so the comma INSIDE it does not terminate the privilege.
  const pattern = /([A-Za-z]+)\s*(?:\(([^()]*)\))?\s*(,|$)/gu;
  let consumed = 0;
  for (const match of list.matchAll(pattern)) {
    const [, privilege, columns] = match;
    found.push({ privilege: privilege!.trim().toUpperCase(),
      columns: columns === undefined ? null
        : columns.split(",").map(column => column.trim()).filter(column => column !== "") });
    consumed = (match.index ?? 0) + match[0].length;
  }
  // Anything between matches that the pattern did not cover is unreadable rather
  // than silently dropped, because a dropped privilege becomes a phantom drift.
  const stripped = list.replace(pattern, "").replace(/[\s,]/gu, "");
  assert.equal(stripped, "", `unreadable privilege list: ${list.slice(0, 120)}`);
  void consumed;
  return found;
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
    //
    // The privilege list is walked left to right rather than split on commas,
    // because ONE GRANT may carry SEVERAL privileges and each may have its own
    // column list: `GRANT INSERT (a, b), UPDATE (c) ON t ...` is valid SQL and
    // means two different privileges on two different column sets. The earlier
    // version matched only a trailing `(...)`, so on that shape it latched onto
    // the LAST column list, read the privilege head as the literal string
    // `INSERT (tenant_id` and `correlation_key)` -- neither of which is a
    // privilege -- and silently DROPPED the INSERT. The result was a false
    // "declared, not granted" for a grant that a live database applies
    // correctly: exactly the class of drift this test exists to catch, missed
    // by the test itself.
    const privileges = parsePrivileges(match[1]!.trim());
    if (!grantees.includes(role) || (match[2] ?? "TABLE").toUpperCase() !== "TABLE") continue;
    for (const table of match[3]!.split(",").map(name => name.trim()).filter(name => name !== "")) {
      for (const { privilege, columns } of privileges) {
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
async function appliedGrants(role = ROLE): Promise<Grants> {
  const files = (await readdir(ROLE_DIRECTORY)).filter(file => file.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "no db/roles/*.sql files were found");
  const combined: Grants = new Map();
  for (const file of files) {
    const grants = parseGrants(await readFile(join(ROLE_DIRECTORY, file), "utf8"), role);
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

/**
 * Every `CREATE FUNCTION` a migration creates that a login can CALL, as
 * `signature -> the file that creates it and the two SECURITY DEFINER flags`.
 *
 * It is a named function rather than an inline loop so the grammar it reads is
 * assertable on its own: the blind spots below were real failures, and a scanner
 * whose grammar has a blind spot is exactly the kind of thing this file refuses
 * to leave unproved.
 *
 * Trigger functions are excluded, and deliberately so. A trigger function cannot
 * be invoked directly, it has no SQL-callable signature, and it executes as the
 * owner of the table it is attached to, so no login can reach it however its ACL
 * reads. THIS is the property the round-4 live preflight disagreed about: the
 * live catalog scan refuses every SECURITY DEFINER function that is not on its
 * allowlist, and it does NOT skip `prorettype='trigger'`, so a SECURITY DEFINER
 * trigger function needs a pinned allowlist entry exactly like a callable one
 * (R4-B1). The trigger exclusion here is therefore about the CALLER side only:
 * no login can invoke a trigger function, so none needs the callable allowlist.
 * The trigger functions' own entries live in `privateDatabasePreflight` and are
 * pinned there.
 *
 * THREE BLIND SPOTS, all reported in review, and all with the same shape: a
 * correct preflight entry with no migration behind it, because the scanner could
 * not SEE the function that earned it.
 *
 *   1. The optional `public.`. 0203 writes
 *      `CREATE FUNCTION public.work_intake_split_suggestion_visible(`, and a
 *      scanner written for the bare spelling could not see it.
 *   2. The file-level `SECURITY DEFINER` filter, which skipped whole files.
 *      0227's two functions are NOT security definer, they are pure immutable
 *      helpers a CHECK constraint needs EXECUTE on, so the file was skipped and
 *      both entries read as phantoms. They belong on the allowlist because the
 *      web login may CALL them, which is a reason to hold an entry to a migration
 *      whatever that function's own properties are.
 *   3. The per-FILE definer flag as the ONLY signal. That attributes SECURITY
 *      DEFINER to every function in a migration that creates both kinds -- 0106
 *      and 0093 each declare an IMMUTABLE helper beside a SECURITY DEFINER
 *      boundary function -- so the phantom set held six signatures where only
 *      four were SECURITY DEFINER.
 *
 * So BOTH flags are RECORDED rather than either being used as a filter:
 * `securityDefiner` (this function's own header) and `securityDefinerFile` (the
 * file). The comparisons below each use the one that direction needs, and the
 * third blind spot is what the per-function flag exists to close.
 */
type ShippedFunction = Readonly<{ file: string; securityDefinerFile: boolean; securityDefiner: boolean }>;

/** `name(a, b)` -> `name(2)`, the normalisation both comparisons use.
 *
 * The empty-argument case is the load-bearing one. `text.split(",")` on an empty
 * string yields `[""]`, so a naive arity counts a ZERO-argument function as
 * one-argument -- which makes `is_work_intake_session()` and any genuine
 * one-argument function share a key, so either could satisfy the other's
 * allowlist entry. It is asserted below rather than left to a comment. */
const arity = (signature: string) => {
  const args = /\(([^)]*)\)/u.exec(signature)?.[1] ?? "";
  return `(${args.split(",").map(argument => argument.trim()).filter(argument => argument !== "").length})`;
};
const shapeOf = (signature: string) => signature.replace(/\([^)]*\)/u, arity);

/**
 * `CREATE [OR REPLACE] FUNCTION name(args) <header> AS $$|'` -> the header.
 *
 * A FACTORY, not a constant, because the pattern carries the `g` flag: a shared
 * stateful regex keeps its `lastIndex` between `matchAll` calls, so a second scan
 * of a second file resumes where the first stopped and silently misses
 * everything in between. That is exactly the failure mode this file exists to
 * prevent, and it is invisible until a real trigger lands in the skipped range.
 *
 * The header runs from the CLOSING PARENTHESIS of the signature to the body
 * opener, so an attribute in it belongs to THIS function and a following
 * function's attributes cannot leak backwards into it. The `AS` opener is the
 * terminator rather than `RETURNS`, because `RETURNS` sits INSIDE the header
 * and a non-lazy `[\s\S]*?` before it would stop at the first occurrence rather
 * than at this function's.
 */
const FUNCTION_HEADERS = () => /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_0-9]+)\s*\(([^)]*)\)([\s\S]*?)AS\s+(?:(?:\$\$[A-Za-z_0-9]*)?\$\$|')/giu;

/** `RETURNS trigger` is what marks a function as a trigger function.
 *
 * The return type is on its OWN LINE in every migration that has one -- 0202,
 * 0204 and 0205 all write `RETURNS trigger\nLANGUAGE plpgsql` -- so this matches
 * `\s+` across the newline rather than a character class of letters and spaces.
 * The class version matched NONE of them, which reads downstream as "there are no
 * SECURITY DEFINER triggers": a silent pass on the very scan that exists to catch
 * R4-B1, and one this file would not have caught for the same reason. Both spellings
 * are asserted in the scanner self-test below. */
const returnsTrigger = (header: string) => /RETURNS\s+trigger\b/iu.test(header);

async function shippedSecurityDefinerFunctions(): Promise<Map<string, ShippedFunction>> {
  const shipped = new Map<string, ShippedFunction>();
  for (const file of (await readdir(join(process.cwd(), "db/migrations"))).filter(name => name.endsWith(".sql")).sort()) {
    const sql = await readFile(join(process.cwd(), "db/migrations", file), "utf8");
    const securityDefinerFile = /SECURITY\s+DEFINER/i.test(sql);
    // Both spellings are legal and both are in use, so the scanner accepts either
    // and is proved to do so below.
    for (const match of sql.matchAll(FUNCTION_HEADERS())) {
      if (returnsTrigger(match[3]!)) continue;
      const args = match[2]!.split(",").map(argument => argument.trim().split(/\s+/)[0]!.toLowerCase())
        .filter(argument => argument !== "");
      shipped.set(`${match[1]!.toLowerCase()}(${args.join(",")})`, Object.freeze({ file, securityDefinerFile,
        securityDefiner: /SECURITY\s+DEFINER/iu.test(match[3]!) }));
    }
  }
  return shipped;
}

test("the SECURITY DEFINER scanner reads both spellings and every file, not only definer files", async () => {
  // The self-test for the N-T1 fix. The failure was invisible because the scanner
  // and the migrations disagreed about SPELLING and about WHICH FILES count, so
  // nothing asserted the scanner against a known input. Revert either and a
  // correct allowlist entry reads as phantom again -- and a function nobody can
  // see is a function nobody can hold to the allowlist.
  const shipped = await shippedSecurityDefinerFunctions();
  // The scanner's keys carry SQL argument NAMES, so a signature is looked up by
  // SHAPE, which is the same normalisation the allowlist test below uses. A
  // shape maps to a SET of records, not to one: several different functions share
  // an arity (there are more than one zero-argument callable), and collapsing
  // them to a single record would hide a function behind whichever sorted last.
  const byShape = new Map<string, ShippedFunction[]>();
  for (const [signature, record] of shipped)
    byShape.set(shapeOf(signature), [...(byShape.get(shapeOf(signature)) ?? []), record]);
  const filesFor = (shape: string) => (byShape.get(shape) ?? []).map(record => record.file);
  // Schema-qualified, in a file that also declares SECURITY DEFINER (0203).
  assert.ok(filesFor("work_intake_split_suggestion_visible(3)")
    .includes("0203_work_batch_split_suggestions_tenant_bound_read.sql"),
  "a schema-qualified CREATE FUNCTION is invisible to the scanner");
  // Bare, in a definer file.
  assert.ok(filesFor("planner_failure_scope_key(2)").includes("0204_planner_needs_you_digest_scopes.sql"));
  assert.ok(filesFor("is_work_intake_session(0)").includes("0093_work_batch_intake.sql"));
  // NOT security definer, in a file with none -- the case the file-level filter
  // used to skip entirely. These are the two entries the review called phantoms.
  for (const shape of ["owner_push_endpoint_host(1)", "owner_push_endpoint_allowed(1)"]) {
    assert.ok(filesFor(shape).includes("0227_owner_push_endpoint_allow_list.sql"),
      `${shape} is invisible to the scanner, so a correct allowlist entry reads as phantom`);
    const record = (byShape.get(shape) ?? []).find(candidate => candidate.file.startsWith("0227"));
    assert.equal(record?.securityDefinerFile, false,
      `${shape} is NOT security definer, which is why a definer-only filter could not see it`);
  }
  // The arity helper, asserted directly, because a zero-argument function
  // counted as one-argument would let any one-argument function satisfy a
  // zero-argument allowlist entry, and neither side would notice.
  assert.equal(shapeOf("is_work_intake_session()"), "is_work_intake_session(0)");
  assert.equal(shapeOf("owner_push_endpoint_host(text)"), "owner_push_endpoint_host(1)");
  assert.equal(shapeOf("control_room_planner_grant_owner_retry(tenant,project,keys)"),
    "control_room_planner_grant_owner_retry(3)");
  // No shipped function may carry a `public.` in its NAME, which is what a
  // half-applied fix would produce: a qualified capture leaking into the key.
  for (const signature of shipped.keys()) assert.ok(!signature.includes("."),
    `the scanner captured a schema qualifier in ${signature}`);
  // And 0205's retry function is one of them, so the preflight allowlist has a
  // migration behind it from the first run rather than after a failure.
  assert.ok(filesFor("control_room_planner_grant_owner_retry(3)")
    .includes("0205_planner_barrier_and_owner_retry.sql"));
  // Trigger functions stay excluded from the CALLABLE set, and this is the
  // assertion for it: 0202's two guards and 0204/0205's rebuild are SECURITY
  // DEFINER trigger functions, and a trigger has no SQL-callable signature for a
  // login to reach. They are NOT thereby exempt from the LIVE preflight's
  // catalog scan -- R4-B1 measured the whole product refusing to start because
  // `guard_planner_needs_you_item_insert` had no entry there -- so the pinned
  // trigger allowlist below is what covers them.
  for (const signature of ["guard_planner_failure_counter_write()", "guard_planner_needs_you_item_insert()"]) {
    assert.equal(shipped.has(signature), false, `a trigger function was reported as callable: ${signature}`);
  }
  // THE THIRD BLIND SPOT, closed and proved: the per-function flag must not
  // inherit from the file. 0093 creates `work_intake_canonical_jsonb` -- a plain
  // IMMUTABLE helper, granted EXECUTE to the intake login in
  // production_table_grants.sql -- in the SAME file as the SECURITY DEFINER
  // `is_work_intake_session`. Reading the property per FILE called the helper a
  // definer, which would have added a phantom to cook/v1's pinned set.
  const helper = shipped.get("work_intake_canonical_jsonb(input)");
  assert.equal(helper?.file, "0093_work_batch_intake.sql", "0093's helper was not scanned");
  assert.equal(helper?.securityDefinerFile, true, "0093 does declare a SECURITY DEFINER function somewhere");
  assert.equal(helper?.securityDefiner, false,
    "a per-FILE SECURITY DEFINER flag leaked onto a function that is not one");
  // And the other direction: 0227's two helpers are in a file with NO definer, so
  // both flags are false and they are visible anyway -- N-T1's actual case.
  for (const shape of ["owner_push_endpoint_host(1)", "owner_push_endpoint_allowed(1)"]) {
    const record = [...shipped.entries()].find(([signature]) => shapeOf(signature) === shape)?.[1];
    assert.equal(record?.securityDefiner, false, `${shape} is not SECURITY DEFINER`);
  }
  // THE TRIGGER DETECTOR, asserted on its own because it failed silently. A
  // character class that excluded the newline read "there are no SECURITY DEFINER
  // triggers" -- a pass -- on a scan whose whole job is to fail when one exists.
  // Both spellings are legal, so both are pinned here.
  assert.equal(returnsTrigger(" RETURNS trigger\nLANGUAGE plpgsql "), true,
    "a trigger function with its return type on the next line was not detected");
  assert.equal(returnsTrigger(" RETURNS trigger LANGUAGE plpgsql "), true,
    "a single-line trigger function was not detected");
  assert.equal(returnsTrigger(" RETURNS trigger_table "), false,
    "a return type merely STARTING with the word trigger was treated as a trigger");
  assert.equal(returnsTrigger(" RETURNS boolean\nLANGUAGE sql IMMUTABLE "), false,
    "a plain function was treated as a trigger");
  // And the same detector over the real header grammar, which is the shape that
  // actually shipped.
  const guardHeader = " RETURNS trigger\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp ";
  assert.equal(returnsTrigger(guardHeader) && /SECURITY\s+DEFINER/iu.test(guardHeader), true,
    "0204's guard header is not recognised as a SECURITY DEFINER trigger");
});

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

test("every task-coordinator grant is exactly declared by its startup preflight", async () => {
  const role = "control_room_task_coordinator";
  const applied = await appliedGrants(role);
  // pg-boss objects live in their own schema and are verified by the native
  // queue preflight. This comparison covers the public application tables
  // accepted by verifyTaskCoordinatorDatabase.
  for (const tables of applied.values()) for (const table of [...tables.keys()])
    if (table.includes(".")) tables.delete(table);
  const wideInserts = new Set(taskCoordinatorInsertTables);
  const insertable = new Map<string, Columns>();
  for (const table of new Set([...wideInserts, ...Object.keys(taskCoordinatorInsertColumns)]))
    insertable.set(table, wideInserts.has(table) ? null : [...taskCoordinatorInsertColumns[table]!]);
  const accepted = new Map<Privilege, Map<string, Columns>>([
    ["SELECT", new Map(taskCoordinatorReadTables.map(table => [table, null] as [string, Columns]))],
    ["INSERT", insertable],
    ["UPDATE", new Map(Object.entries(taskCoordinatorUpdateColumns)
      .map(([table, columns]) => [table, [...columns]] as [string, Columns]))],
    ["DELETE", new Map([...taskCoordinatorDeleteTables].map(table => [table, null] as [string, Columns]))],
  ]);
  const disagreements: string[] = [];
  for (const privilege of PRIVILEGES) {
    const granted = applied.get(privilege) ?? new Map<string, Columns>();
    const expected = accepted.get(privilege)!;
    for (const table of granted.keys()) if (!expected.has(table))
      disagreements.push(`${role} holds ${privilege} on ${table}, undeclared`);
    for (const table of expected.keys()) if (!granted.has(table))
      disagreements.push(`${privilege} on ${table} is declared, not granted`);
    for (const [table, columns] of granted) {
      const wanted = expected.get(table);
      if (wanted === undefined) continue;
      if ((wanted === null) !== (columns === null)) disagreements.push(`${table}: ${privilege} grant shape differs`);
      else if (columns && wanted) {
        const difference = [...wanted].filter(column => !columns.includes(column))
          .concat([...columns].filter(column => !wanted.includes(column))).sort();
        if (difference.length) disagreements.push(`${table}: ${privilege} columns differ: ${difference.join(", ")}`);
      }
    }
  }
  assert.deepEqual(disagreements, [], "the task-coordinator grants and startup preflight disagree");
});

test("the web DELETE declaration is read from the preflight, not restated here", async () => {
  // A restatement of the DELETE set would pass while describing a value the
  // preflight no longer holds, so the read is asserted against the source it
  // parses, and the grants it returns are the ones the role files give.
  //
  // TWO tables as of 0241. `page_pins` joined `owner_web_push_subscriptions`
  // because "Pin this page" is a toggle and unpinning needs a DELETE — the
  // other two navigation tables deliberately have none, so this list growing is a
  // real widening of what the web login can erase and has to be a deliberate edit
  // here as well as in the preflight.
  assert.deepEqual(declaredDeletes(), ["owner_web_push_subscriptions", "page_pins"]);
  // And each one is genuinely granted, so the declaration cannot drift into
  // naming a table no role file gives the web login.
  const granted = await appliedGrants();
  for (const table of declaredDeletes())
    assert.equal(granted.get("DELETE")?.get(table), null,
      `${table} is granted DELETE to the web login by a role file`);
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

test("every SECURITY DEFINER function the preflight exempts is owned by the schema owner, unconditionally", async () => {
  // The comparison above is about TABLES. The same preflight also exempts a
  // fixed set of SECURITY DEFINER functions from its catalog scan, and that
  // allowlist has its own drift: the owner test for the two agent-review
  // boundary functions sat inside the agent-reviewer disjunct, so every other
  // kind exempted them on "this login has no EXECUTE" alone, whatever owned
  // them. Nothing here compared the allowlist with the migrations, so the gap
  // was invisible until a fixture that replays db/migrations without SET ROLE
  // produced it. The real-PostgreSQL lanes prove a correct install is accepted;
  // this proves the allowlist tracks the migrations and keeps the owner test
  // unconditional, both without a database.
  const source = readFileSync(PREFLIGHT_SOURCE, "utf8");
  // Read every OCCURRENCE of a signature, in both spellings the preflight uses:
  // `'f(args)'::regprocedure` in the catalog-scan branches, and `'f(args)'` on
  // its own inside the `'f(args)'::regprocedure[] boundary(oid)` array at the
  // end. Both matter, and reading only the suffixed form is how a rename in the
  // boundary array went unnoticed: that array is the one place the preflight
  // demands the agent-review pair be executable, so a name that no migration
  // creates there is a hole in the very check the scan exempts itself from.
  //
  // A de-duplicated set is not used either. A signature appears more than once
  // by design -- `read_agent_review_plan(text)` is named in the scan branch, in
  // the volatility CASE and again in the boundary array -- and a set hides
  // that: renaming ONE occurrence leaves the other spellings present, so a
  // set-based check passes a preflight with a hole in one of those places.
  // Every occurrence is collected and every occurrence is compared.
  const occurrences: string[] = [
    ...[...source.matchAll(/'([a-z_0-9]+\([^']*?\))'::regprocedure/gu)].map(match => match[1]!),
    // The bare form is read by anchoring on the ARRAY'S closing bracket, so the
    // match cannot run past the element before it: `commit_agent_review(...)',
    // 'read_agent_review_plan(text)']::regprocedure[]` yields only the second,
    // which is the one the suffixed regex above cannot see. Anchoring on the
    // bracket rather than looking ahead across quotes is what makes that true;
    // a lookahead would have to span the previous element's closing quote.
    ...[...source.matchAll(/'([a-z_0-9]+\([^']*?\))'\s*,?\s*\]\s*::regprocedure\[\]/gu)].map(match => match[1]!),
  ];
  assert.ok(occurrences.length >= 8,
    `only ${occurrences.length} exempted signature occurrence(s) found in the preflight; the read is too narrow to prove anything`);

  // Every SECURITY DEFINER function a migration creates that a login could CALL
  // must be an allowlist entry, and every allowlist entry must be one a
  // migration creates: an unlisted one is flagged by the scan on a correct
  // database, and a phantom one is a hole in it.
  //
  // BOTH BRANCHES' GUARANTEES ARE KEPT, because they are different and both
  // failed at least once.
  //
  // cook/orchui's guarantee is that the scan's DIRECTION is right: an allowlist
  // entry exists because a login may CALL a function, so EVERY callable
  // non-trigger function a migration creates has to be accounted for in both
  // directions whatever its own security properties are. Filtering by
  // SECURITY DEFINER was N-T1: the filter skipped whole files, so 0227's two
  // callable (non-definer) helpers were invisible and two correct allowlist
  // entries read as phantoms.
  //
  // cook/v1's guarantee is that the READ is right: SECURITY DEFINER must be read
  // PER FUNCTION from that function's own header, never per FILE. Reading it
  // per file attributes it to every function in a migration that creates both
  // kinds -- 0106 and 0093 each declare an IMMUTABLE helper next to a SECURITY
  // DEFINER boundary function -- so the phantom set held six signatures where
  // only four were SECURITY DEFINER. And that set must not drift from what
  // PostgreSQL reports, so it is pinned BY NAME below.
  //
  // So the shipped set below is built by `shippedSecurityDefinerFunctions()`, which records the
  // per-function definer property AND the per-file one, and the two are used for
  // two different assertions: the pinned definer set comes from the per-function
  // property, and the allowlist comparison runs over every callable function
  // with no filter at all. Neither guarantee is a restatement of the other.
  //
  // Trigger functions are excluded from BOTH, and deliberately so. A trigger
  // function cannot be invoked directly, it has no SQL-callable signature, and
  // it executes as the owner of the table it is attached to, so no login can
  // reach it however its ACL reads.
  const shipped = await shippedSecurityDefinerFunctions();
  const definers = [...shipped.entries()]
    .filter(([, record]) => record.securityDefiner).map(([signature]) => signature);
  assert.deepEqual([...definers].map(signature => signature.replace(/\(.*\)/u, "")).sort(),
  ["commit_agent_review", "control_room_planner_grant_owner_retry", "is_work_intake_session",
    "read_agent_review_plan", "redeem_fleet_enrollment", "updater_health_counts",
    "work_intake_split_suggestion_visible"],
    "the shipped SECURITY DEFINER function set changed; a login-callable one needs a preflight allowlist entry");
  // The shipped names carry SQL argument NAMES; the preflight carries TYPES, so
  // the two are matched by SHAPE -- the name with its arity. `shapeOf` is the
  // single normalisation both comparisons use, and it is asserted on its own in
  // the scanner self-test above so a reader cannot make it name-blind.
  // The trigger pin is compared against the TRIGGER set, not this one: the two
  // scanners exclude different things (a login cannot CALL a trigger, and a
  // SECURITY DEFINER callable is not a trigger), so a pinned signature from one
  // side is not expected in the other's set. Both sides are checked against their
  // own set, and neither set is a filter over the other.
  const shapes = new Set([...shipped.keys()].map(shapeOf));
  assert.deepEqual(occurrences.filter(signature => !shapes.has(shapeOf(signature))
    && !signature.endsWith("()")).sort(), [],
    "the preflight exempts a callable function no migration creates; a renamed or removed function is now a hole in the scan");
  // Each shipped SECURITY DEFINER function must be exempt under its OWN NAME, by
  // arity. The name-blind fallback is deliberately absent: an allowlist entry
  // that merely matched some other function's arity would be exactly the drift
  // this exists to catch.
  for (const signature of definers) {
    const name = signature.slice(0, signature.indexOf("("));
    const shipped_ = [...shipped.keys()].filter(other => other.startsWith(`${name}(`));
    assert.ok(shipped_.length >= 1, `${name} is not a shipped signature at all`);
    assert.ok(occurrences.some(other => shapeOf(other) === shapeOf(signature)),
      `${name} is a shipped SECURITY DEFINER function with no preflight allowlist entry`);
  }

  // The specific shape that broke: the owner check may not sit inside the
  // reviewer-only disjunct, or these two functions are exempt for every kind.
  const branch = /OR\s*\(p\.oid IN \('commit_agent_review[\s\S]*?NOT has_function_privilege\(p\.oid,'EXECUTE'\)\)\)\)\)/.exec(source);
  assert.ok(branch, "the agent-review allowlist branch was not found in the preflight");
  const owner = "pg_get_userbyid(p.proowner)='control_room_schema_owner'";
  const reviewerDisjunct = "$2 AND p.prosecdef";
  assert.ok(branch[0].includes(owner), "the agent-review allowlist branch no longer checks the owner at all");
  assert.ok(branch[0].includes(reviewerDisjunct),
    "the reviewer-only disjunct is gone; the ordering assertion below no longer means anything");
  assert.ok(branch[0].indexOf(owner) < branch[0].indexOf(reviewerDisjunct),
    "the owner test is inside the reviewer disjunct again, so every non-reviewer kind exempts these functions whatever owns them");
});

test("every SECURITY DEFINER trigger a migration creates is pinned in the live preflight's catalog scan", async () => {
  // R4-B1, and the reconciliation of the two scanners this stream inherited.
  //
  // The scanner above excludes trigger functions, on the ground that no login can
  // CALL one. That is true, and it is why N-T1's fix never noticed 0204: the
  // function a login cannot call is not the function that breaks the product.
  // The LIVE preflight scans `pg_proc` for every SECURITY DEFINER function and
  // exempts only the ones it pins -- with no trigger exception -- so when 0204
  // rebuilt the Needs-you guard as SECURITY DEFINER, every private login began
  // refusing a correct database. Measured: test:database 81/83 and
  // test:postgres-production #23/#25, all `private_database_preflight_failed`.
  //
  // So the trigger side needs its own scan, against the LIVE preflight's source
  // rather than its callable list, and it is a scan of TRIGGERS here rather than
  // of CALLABLES. Both scanners exist; neither is a filter over the other, and
  // this is the one that would have caught it.
  const source = readFileSync(PREFLIGHT_SOURCE, "utf8");
  const scan = /EXISTS\(SELECT 1 FROM pg_proc p JOIN pg_namespace/u.exec(source);
  assert.ok(scan, "the preflight's function catalog scan was not found in the source");
  // Every name the migration set pins must appear as a `::regprocedure` literal
  // in the scan, in its own `OR (...)` branch. Reading every OCCURRENCE (rather
  // than a de-duplicated set) is deliberate for the reason the boundary array
  // comment above gives: a signature named in two places and renamed in one is
  // still a hole, and a set hides it.
  // The pinned form carries the EMPTY argument list as written in the preflight,
  // which is `name()`; the shipped form this compares against is normalised to the
  // same arity by `shapeOf`, so the two spellings meet without either being
  // rewritten to suit the other.
  const pinned = [...source.matchAll(/'([a-z_0-9]+\(\))'::regprocedure/gu)].map(match => shapeOf(match[1]!));
  // A SECURITY DEFINER trigger in db/migrations, read the same way as the
  // callable set: per function, from its own header, and only those returning
  // `trigger`.
  const triggers: string[] = [];
  for (const file of (await readdir(join(process.cwd(), "db/migrations"))).filter(name => name.endsWith(".sql")).sort()) {
    const sql = await readFile(join(process.cwd(), "db/migrations", file), "utf8");
    for (const match of sql.matchAll(FUNCTION_HEADERS())) {
      if (!returnsTrigger(match[3]!)) continue;
      if (!/SECURITY\s+DEFINER/iu.test(match[3]!)) continue;
      // Built with `shapeOf` rather than interpolated, so this side and the pinned
      // side are normalised by the SAME helper. Writing the arity into the string by
      // hand produced `name(0)`, which `shapeOf` then re-read as a ONE-argument
      // call and normalised to `name(1)` -- so the two sides could never meet and
      // the assertion failed for a spelling reason that reads like a missing pin.
      const args = match[2]!.split(",").map(argument => argument.trim().split(/\s+/)[0]!.toLowerCase())
        .filter(argument => argument !== "");
      triggers.push(shapeOf(`${match[1]!.toLowerCase()}(${args.join(",")})`));
    }
  }
  // The set is pinned BY NAME as well as compared. A migration that adds a sixth
  // SECURITY DEFINER trigger fails here, which is the change that would
  // otherwise be discovered as a product that will not start.
  assert.deepEqual([...new Set(triggers)].sort(), ["guard_planner_needs_you_item_insert(0)"],
    "the shipped SECURITY DEFINER trigger set changed; the live preflight needs a pinned entry for each");
  for (const trigger of [...new Set(triggers)])
    assert.ok(pinned.includes(trigger),
      `${trigger} is SECURITY DEFINER and a trigger, so the live preflight's catalog scan refuses it unless it is pinned`);
  // And the pin is a real pin, not the name appearing somewhere: the branch must
  // hold the two properties that make a trigger an trigger, so a rebuild that
  // changed either fails the preflight rather than passing it.
  // The branch is read by its own opening `OR (p.oid=...)` rather than by scanning
  // to the next `))`, because the SQL is indented across many lines and a
  // character class would stop at the first newline. Both spellings of the pin's
  // tail are asserted below, so a branch that was found but says the wrong thing
  // still fails.
  // The branch is delimited by its OWN parentheses rather than by scanning to the
  // next `))`: the SQL puts several `OR (...)` branches side by side and each one
  // ends with the same two characters, so a lookahead would run into the NEXT
  // branch and the branch's own tail -- which is what the balance check below
  // needs to see -- would be outside the match. A depth-counting read from the
  // branch's opening parenthesis is the only read that gets the branch and
  // nothing else.
  const opened = source.indexOf("OR (p.oid='guard_planner_needs_you_item_insert()'::regprocedure");
  assert.ok(opened >= 0, "the Needs-you trigger's pinned branch was not found in the preflight");
  let depth = 0, end = opened;
  for (let index = opened + 3; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") { depth -= 1; if (depth === 0) { end = index + 1; break; } }
  }
  assert.ok(end > opened, "the pinned trigger branch never closes");
  const branch = source.slice(opened, end);
  // THE FUNCTION SCAN BALANCES, and this is the assertion that catches a
  // mis-balanced branch. Round 4's first attempt at this fix removed one `)` from
  // the branch tail; every string comparison still passed -- the branch was
  // present, named the right function and said the right things -- and the cost
  // was a 42601 on the WHOLE scan, reported as the same opaque
  // `private_database_preflight_failed`. Reading the branch's own tail does not
  // catch it, because a missing `)` is consumed by the next branch's `(`.
  //
  // So the balance is measured over the whole function-scan segment with SQL
  // COMMENTS STRIPPED FIRST, and pinned to the value the reviewed text produces.
  // Comments are the reason a naive count is useless here: every one of the
  // entries above is preceded by a prose block whose parentheses are not SQL, and
  // they move the count in both directions. Stripping them makes the count mean
  // something, and pinning the value means adding an unbalanced branch fails here
  // rather than in the owner's startup.
  const scanStart = source.indexOf("OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace");
  const scanEnd = source.indexOf("OR NOT has_schema_privilege('public','USAGE') AS unsafe");
  assert.ok(scanStart > 0 && scanEnd > scanStart, "the preflight's function scan segment could not be located");
  const scanSql = source.slice(scanStart, scanEnd).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/--[^\n]*/gu, "");
  assert.equal([...scanSql].reduce((count, char) => count + (char === "(" ? 1 : char === ")" ? -1 : 0), 0), 0,
    "the preflight's function scan no longer balances; an unbalanced OR branch is a 42601 at run time, "
    + "which the preflight reports as the same opaque private_database_preflight_failed");
  assert.match(branch, /p\.prorettype='trigger'::regtype/, "the pinned trigger branch no longer pins the return type");
  assert.match(branch, /p\.prosecdef/, "the pinned trigger branch no longer pins SECURITY DEFINER");
  assert.match(branch, /p\.proconfig=ARRAY\['search_path=pg_catalog, public, pg_temp'\]::text\[\]/u,
    "the pinned trigger branch no longer pins the search_path");
  assert.match(branch, /p\.prolang=\(SELECT oid FROM pg_language WHERE lanname='plpgsql'\)/u,
    "the pinned trigger branch no longer pins the language");
  assert.match(branch, /NOT has_function_privilege\('public',p\.oid,'EXECUTE'\)/u,
    "the pinned trigger branch no longer refuses an EXECUTE grant to PUBLIC");
  // The trigger branch requires NOTHING to hold EXECUTE, so its ACL test is the
  // whole guarantee -- a weakened form of it passes the `prosecdef` check above.
  assert.match(branch, /AND NOT EXISTS\(SELECT 1 FROM aclexplode/u,
    "the pinned trigger branch no longer checks that no login holds EXECUTE on it");
  assert.match(branch, /a\.privilege_type='EXECUTE' AND a\.grantee<>p\.proowner\)\)/u,
    "the pinned trigger branch's ACL test no longer admits no login at all");

  // And the OTHER entry this round narrowed: the retry function's ACL is the same
  // shape, and both halves of it are asserted because either alone passes. Round 4
  // measured that the coordinator's grant let the coordinator set the latch
  // itself, so the ACL now admits exactly one login AND requires that login to
  // hold EXECUTE -- without the requirement, a database where the grant was never
  // issued would still pass.
  const retryStart = source.indexOf("OR (p.oid='control_room_planner_grant_owner_retry(text,text,text[])'::regprocedure");
  assert.ok(retryStart > 0, "the retry function's pinned branch was not found in the preflight");
  let retryDepth = 0, retryEnd = retryStart;
  for (let index = retryStart + 3; index < source.length; index += 1) {
    if (source[index] === "(") retryDepth += 1;
    else if (source[index] === ")") { retryDepth -= 1; if (retryDepth === 0) { retryEnd = index + 1; break; } }
  }
  const retryBranch = source.slice(retryStart, retryEnd);
  assert.match(retryBranch, /has_function_privilege\('control_room_private_web',p\.oid,'EXECUTE'\)/u,
    "the retry function's pin no longer requires the owner's web login to hold EXECUTE on it");
  assert.match(retryBranch, /pg_get_userbyid\(a\.grantee\)<>'control_room_private_web'/u,
    "the retry function's ACL no longer admits exactly one login");
  assert.doesNotMatch(retryBranch, /control_room_task_coordinator/u,
    "the coordinator is back in the retry function's ACL, which round 4 measured as a way to set the latch");

  // THE THIRD PIN, and the one whose properties had to be READ rather than
  // assumed: `planner_failure_scope_key`, which 0204 grants to the coordinator and
  // which the first attempt at this fix pinned with a search_path it does not have.
  // The pin's correctness is a property of the FUNCTION, so a pin that does not
  // match it silently stops matching -- which is the failure R4-B1 itself was. So
  // every property the pin names is asserted here, in the direction that matters:
  // each one has to be what the real function IS, not what the pin would like.
  const scopeKeyStart = source.indexOf("OR (p.oid='planner_failure_scope_key(text,jsonb)'::regprocedure");
  assert.ok(scopeKeyStart > 0, "the failure-scope key's pinned branch was not found in the preflight");
  let scopeKeyDepth = 0, scopeKeyEnd = scopeKeyStart;
  for (let index = scopeKeyStart + 3; index < source.length; index += 1) {
    if (source[index] === "(") scopeKeyDepth += 1;
    else if (source[index] === ")") { scopeKeyDepth -= 1; if (scopeKeyDepth === 0) { scopeKeyEnd = index + 1; break; } }
  }
  const scopeKeyBranch = source.slice(scopeKeyStart, scopeKeyEnd);
  // NOT SECURITY DEFINER is the load-bearing one: a pin that claimed otherwise
  // would exempt a function that runs as its CALLER, which is the one thing the
  // whole allowlist exists to prevent.
  assert.match(scopeKeyBranch, /AND NOT p\.prosecdef/u,
    "the scope-key pin no longer states that the helper is NOT SECURITY DEFINER");
  // proconfig IS NULL, because 0204 created it without a SET clause. Pinning a
  // search_path it does not have refuses every correct database -- the same shape
  // of failure as R4-B1, one function over, and it is the mistake this assertion
  // was written for.
  assert.match(scopeKeyBranch, /AND p\.proconfig IS NULL/u,
    "the scope-key pin no longer pins the ABSENCE of a search_path, which is what the function has");
  assert.doesNotMatch(scopeKeyBranch, /p\.proconfig=ARRAY/u,
    "the scope-key pin demands a search_path the function does not have, which refuses every correct database");
  assert.match(scopeKeyBranch, /p\.provolatile='i'/u, "the scope-key pin no longer pins IMMUTABLE");
  assert.match(scopeKeyBranch, /p\.proparallel='u'/u,
    "the scope-key pin no longer pins the parallelism the function really has (measured: unsafe)");
  assert.match(scopeKeyBranch, /pg_get_userbyid\(a\.grantee\)<>'control_room_task_coordinator'/u,
    "the scope-key pin's ACL no longer admits exactly the one login the role file grants it to");
  assert.match(retryBranch, /has_function_privilege\('control_room_private_web',p\.oid,'EXECUTE'\)/u,
    "the retry function's pin no longer requires the owner's web login to hold EXECUTE on it");
  assert.match(retryBranch, /pg_get_userbyid\(a\.grantee\)<>'control_room_private_web'/u,
    "the retry function's ACL no longer admits exactly one login");
  assert.doesNotMatch(retryBranch, /control_room_task_coordinator/u,
    "the coordinator is back in the retry function's ACL, which round 4 measured as a way to set the latch");
  // The parenthesis balance was checked by the depth count that READ the branch
  // above, and that count is the assertion. This is the failure round 4's first
  // attempt at this fix made and did not catch: an unbalanced `OR (...)` does not
  // make the preflight refuse a database for a readable reason -- it makes the
  // whole scan un-parseable, and PostgreSQL answers 42601, which the preflight
  // reports as the same opaque `private_database_preflight_failed`. Every string
  // comparison on a mis-balanced branch still passes, because the branch is
  // present and says the right things; only its arity is wrong. So the branch is
  // read by counting parentheses rather than by a pattern, and a branch that does
  // not close is a failure here rather than a 42601 in the owner's startup.
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

  // One GRANT carrying SEVERAL privileges, each with its own column list. This is
  // the exact grammar that broke test:database: an earlier version of parseGrants
  // matched only a TRAILING `(...)`, so on
  // `GRANT INSERT (a, b), UPDATE (c) ON t ...` it read the privilege head as the
  // literal `INSERT (a` — not a privilege — and dropped the INSERT. The role file
  // is correct SQL and applies correctly on a live database, so the drift check
  // reported a false "declared, not granted" for a grant that really existed.
  //
  // The assertion below is therefore a guard on the PARSER, not on any role file:
  // if someone simplifies the privilege walk again, this fails immediately
  // instead of the failure surfacing later as a phantom drift in an unrelated
  // lane.
  const combined = parseGrants(
    `GRANT INSERT (tenant_id,correlation_key), UPDATE (next_generation) ON control_combined TO ${ROLE};`, ROLE);
  assert.deepEqual([...combined.get("INSERT")?.get("control_combined") ?? []].sort(),
    ["correlation_key", "tenant_id"], "the INSERT half of a combined GRANT is registered");
  assert.deepEqual(combined.get("UPDATE")?.get("control_combined"), ["next_generation"],
    "the UPDATE half of a combined GRANT still carries its own columns");
  // The same shape with a table-wide privilege alongside a column-scoped one.
  const mixed = parseGrants(`GRANT DELETE, INSERT (a) ON control_mixed TO ${ROLE};`, ROLE);
  assert.equal(mixed.get("DELETE")?.get("control_mixed"), null, "a bare privilege stays table-wide");
  assert.deepEqual(mixed.get("INSERT")?.get("control_mixed"), ["a"]);
  // Trailing comma and multi-line spellings parse to the same thing.
  assert.deepEqual(
    [...(parseGrants(`GRANT SELECT (a),\n  UPDATE (b)\n  ON control_multiline TO ${ROLE};`, ROLE)
      .get("SELECT")?.get("control_multiline") ?? [])], ["a"]);
  assert.deepEqual(parseGrants(`GRANT SELECT (a), UPDATE (b) ON control_multiline TO ${ROLE};`, ROLE)
    .get("UPDATE")?.get("control_multiline"), ["b"]);
});
