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

  // Every SECURITY DEFINER function a migration creates that a login could
  // CALL must be an allowlist entry, and every allowlist entry must be one a
  // migration creates: an unlisted one is flagged by the scan on a correct
  // database, and a phantom one is a hole in it.
  //
  // Trigger functions are excluded, and deliberately so. A trigger function
  // cannot be invoked directly — it has no SQL-callable signature — and it
  // executes as the owner of the table it is attached to, so the web login can
  // never reach it however its ACL reads.
  //
  // SECURITY DEFINER is read PER FUNCTION, from each function's own header.
  // It used to be read per FILE — `if (!/SECURITY\s+DEFINER/i.test(sql)) continue`
  // — and that is wrong for every migration that creates both kinds, because
  // 0106 (and 0093) declare an IMMUTABLE helper next to a SECURITY DEFINER
  // boundary function and one `test()` over the file body attributes SECURITY
  // DEFINER to all of them. The consequence was not cosmetic: the phantom
  // set then held six signatures where only four are SECURITY DEFINER, and
  // 0227's two pure SQL helpers were not in it at all even though the
  // preflight exempts them. The four below were read off a live PostgreSQL 17
  // (`SELECT proname, prosecdef FROM pg_proc WHERE prorettype<>'trigger'`),
  // which is the authority this check is standing in for: the required set is
  // exactly the four names that query returns.
  const shipped = new Map<string, string>();
  // Every non-trigger function a migration creates, whether or not it is
  // SECURITY DEFINER. The phantom check below has to run against THIS set: an
  // allowlist entry naming a function no migration creates is a hole whatever
  // kind the phantom would have been, so restricting the set to the SECURITY
  // DEFINER ones would have made that check unable to see 0227 at all.
  const created = new Map<string, string>();
  for (const file of (await readdir(join(process.cwd(), "db/migrations"))).filter(name => name.endsWith(".sql")).sort()) {
    const sql = await readFile(join(process.cwd(), "db/migrations", file), "utf8");
    // The header runs from the signature to the body opener (`AS $$` or
    // `AS '...'`), so attributes in the header belong to THIS function and a
    // following function's attributes cannot leak backwards into it.
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_0-9]+)\s*\(([^)]*)\)([\s\S]*?)AS\s+(?:\$\$|')/giu)) {
      const header = match[3]!;
      // `RETURNS trigger` is what marks a function as a trigger function.
      const returned = /RETURNS\s+([a-z ]+)/iu.exec(header);
      if (returned && returned[1]!.trim().toLowerCase() === "trigger") continue;
      const args = match[2]!.split(",").map(argument => argument.trim().split(/\s+/)[0]!.toLowerCase())
        .filter(argument => argument !== "");
      const signature = `${match[1]!.toLowerCase()}(${args.join(",")})`;
      created.set(signature, file);
      if (!/SECURITY\s+DEFINER/iu.test(header)) continue;
      shipped.set(signature, file);
    }
  }
  // The set is not allowed to drift from what PostgreSQL actually reports, so
  // it is pinned by name. A migration that adds a fifth SECURITY DEFINER
  // function a login can call fails here, and has to add its allowlist entry at
  // the same time — which is the change that would otherwise be forgotten.
  assert.deepEqual([...shipped.keys()].map(signature =>
    signature.replace(/\(.*\)/u, "")).sort(),
  ["commit_agent_review", "is_work_intake_session", "read_agent_review_plan", "redeem_fleet_enrollment"],
    "the shipped SECURITY DEFINER function set changed; a login-callable one needs a preflight allowlist entry");
  // The shipped names carry SQL argument NAMES; the preflight carries TYPES, so
  // the two are matched by ARITY, not by text. `shape` therefore drops the
  // argument text but KEEPS the name, which is what makes the phantom check
  // above a real check: an allowlist entry for a function no migration creates
  // has a name no created signature carries, so it cannot match. It is NOT a
  // name-blind arity comparison, and a future reader must not make it one --
  // that would make this assertion vacuously true for every signature.
  const shape = (signature: string) => signature.replace(/\(([^)]*)\)/u, (all, args: string) =>
    `${signature.slice(0, signature.indexOf("("))}(${args.split(",").length})`);
  const shapes = new Set([...created.keys()].map(shape));
  assert.deepEqual(occurrences.filter(signature => !shapes.has(shape(signature))).sort(), [],
    "the preflight exempts a function no migration creates; a renamed or removed function is now a hole in the scan");
  // Each of the four must be exempt under its OWN NAME, by arity. The
  // name-blind fallback is deliberately absent: a fifth allowlist entry that
  // merely matched some other function's arity would be exactly the drift this
  // exists to catch.
  for (const name of ["commit_agent_review", "is_work_intake_session", "read_agent_review_plan",
    "redeem_fleet_enrollment"]) {
    const signatures = [...shipped.keys()].filter(signature => signature.startsWith(`${name}(`));
    assert.equal(signatures.length, 1, `${name} has ${signatures.length} shipped signatures, not one`);
    assert.ok(occurrences.some(signature => shape(signature) === shape(signatures[0]!)),
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
