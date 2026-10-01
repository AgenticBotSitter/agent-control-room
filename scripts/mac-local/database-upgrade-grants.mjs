/** Exact direct ACL comparison for the Mac-local database logins.
 * This is an offline installer component, never imported by the task host. */
import { readFile } from "node:fs/promises";
import { databaseRoleManifestV1 } from "./database-role-manifest.mjs";

export const macRolePlan = Object.freeze(Object.fromEntries(Object.entries(databaseRoleManifestV1.logins)
  .filter(([, entry]) => entry.mac).map(([login, entry]) => [login, entry.group])));

const roleFiles = Object.freeze([
  "private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
  "agent_reviewer_roles.sql", "fleet_gateway_roles.sql",
]);
const groups = new Set(Object.values(macRolePlan));
const identifier = /^[a-z][a-z0-9_]*$/u;
const privilege = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "USAGE", "EXECUTE"]);
const workIntakeIdentityFunction = "public.is_work_intake_session()";
const workIntakeIdentityRoles = new Set(["control_room_private_web", "control_room_task_coordinator",
  "control_room_native_results", "control_room_local_result_publisher", "control_room_fleet_gateway",
  "control_room_fleet_owner_authority"]);
// The reviewer's whole authority: the tenant-bound plan read and the commit.
const agentReviewFunctions = new Set(["public.read_agent_review_plan(text)",
  "public.commit_agent_review(text, jsonb, jsonb, bytea)"]);
const fleetEnrollmentFunction = "public.redeem_fleet_enrollment(text, text, text, text, timestamptz)";
const fleetClaimFunction = "public.fleet_claim_is_live(text, text, text)";
// MIG-I's push-endpoint allow list (0227). A CHECK constraint runs as its
// WRITER, so the login that INSERTs owner_web_push_subscriptions has to hold
// EXECUTE on both or the constraint is unevaluable by the very role it exists
// to constrain, and every subscribe fails 42501 instead of 204. They are the
// narrowest grant in the file: both functions are IMMUTABLE, pure SQL, own no
// object, and reach no table, so EXECUTE conveys no authority at all — it only
// makes the constraint readable. They are listed here rather than left to a
// blanket rule because EXECUTE on a function is only ever as safe as the
// function, and this one has to be named and checked.
const ownerPushEndpointFunctions = new Set(["public.owner_push_endpoint_host(text)",
  "public.owner_push_endpoint_allowed(text)"]);
const knownFunctionGrant = object => object === workIntakeIdentityFunction || object === fleetEnrollmentFunction
  || object === fleetClaimFunction || ownerPushEndpointFunctions.has(object)
  || agentReviewFunctions.has(object);
const allowedFunctionGrant = (role, object) => object === workIntakeIdentityFunction && workIntakeIdentityRoles.has(role)
  || (object === fleetEnrollmentFunction || object === fleetClaimFunction) && role === "control_room_fleet_gateway"
  || ownerPushEndpointFunctions.has(object) && role === "control_room_private_web"
  || agentReviewFunctions.has(object) && role === "control_room_agent_reviewer";
const name = value => {
  if (!identifier.test(value)) throw new Error("upgrade_grant_source_refused");
  return value;
};
const tuple = ({ role, kind, object, column = "", privilege: right, is_grantable = false }) =>
  [role, kind, object, column, right, is_grantable ? "grantable" : "plain"].join("|");

/** The `updater` schema is the UPDATER's, not this converger's, and it is not
 * the release's to converge.
 *
 * WHY. The updater owns its schema and its role end to end. Its own DDL
 * (`src/updater/v1/ddl/0002_schema.sql`) creates it, REVOKEs it from PUBLIC and
 * re-GRANTs `USAGE ON SCHEMA updater` plus `EXECUTE` on `updater.authorization_complete`
 * and `updater.bounded_transports` to `control_room_private_web`, and the loader
 * re-asserts all three on every single run. Nothing in `db/roles/*.sql` names an
 * `updater` object, so the desired set can never legitimately hold one — and
 * `control_room_deployer`, which owns the schema, is deliberately absent from the
 * role manifest, so this converger never creates, alters or revokes that role.
 *
 * WHAT WENT WRONG WITHOUT THIS, and it is worse than a failed upgrade. The
 * catalog sees those three grants, `diffMacGrantsV1` calls them `extra` (they are
 * in no desired file), and the converger emits a REVOKE for each. Two outcomes,
 * both bad:
 *
 *   1. As the MIGRATOR — the release converger's login — the REVOKE fails
 *      `permission denied for schema updater`, because the migrator holds
 *      nothing there by design. MEASURED. The whole grant transaction rolls
 *      back, so no retry past that point converges.
 *   2. As `postgres` — which is the login THIS converger actually runs as
 *      (`runMacDatabaseUpgradeCommandV1` refuses anything but the superuser) —
 *      the REVOKE SUCCEEDS. MEASURED. There is no refusal to notice: the web
 *      login silently loses USAGE on the schema and EXECUTE on the updater's own
 *      guard functions, and the next release read fails on a database the
 *      operator believes is fully upgraded. A schema-kind item has no allow-list
 *      at all (`grantSql` guards only functions), so even the one path that
 *      refuses for functions silently applies the schema one.
 *
 * So the filter cannot live at the statement generator alone, and it must not be
 * `role === "control_room_private_web"`: the updater grants to `postgres` too
 * (owner rights), and a schema can hold grants for any role. The predicate is
 * therefore on the SCHEMA of the object, and it is applied at the two places an
 * `updater` item could otherwise reach a GRANT or a REVOKE — see
 * `macGrantRowsToSetV1` and `grantSql` below, which are the two ends of the
 * pipeline.
 */
export const macUpdaterOwnedSchema = "updater";
const updaterOwned = item => {
  const object = String(item).split("|")[2] ?? "";
  // `updater.x` and the bare schema name `updater` are both updater-owned. The
  // `\.|$` anchor is what stops `updater_release_reader_roles.sql`-style names
  // and any future `updater_x.y` relation from being silently skipped: only an
  // exact `updater` schema prefix matches.
  return object === macUpdaterOwnedSchema || object.startsWith(`${macUpdaterOwnedSchema}.`);
};
/** Whether the release's converger is allowed to act on this grant at all. */
export const macReleaseOwnedGrantV1 = item => !updaterOwned(item);

function splitCommas(source) {
  let depth = 0, part = "";
  const parts = [];
  for (const char of source) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) throw new Error("upgrade_grant_source_refused");
    if (char === "," && depth === 0) { parts.push(part.trim()); part = ""; }
    else part += char;
  }
  if (depth !== 0) throw new Error("upgrade_grant_source_refused");
  parts.push(part.trim());
  return parts;
}

export function desiredMacGrantsV1(sources) {
  const desired = new Set();
  for (const [file, text] of Object.entries(sources)) {
    if (!roleFiles.includes(file)) throw new Error("upgrade_grant_source_refused");
    const uncommented = text.replace(/--[^\n]*/gu, "");
    const statements = [...uncommented.matchAll(/(?:^|\n)\s*(GRANT\s+[\s\S]*?;)/gmu)].map(match => match[1]);
    if (statements.length !== [...uncommented.matchAll(/\bGRANT\b/gu)].length)
      throw new Error("upgrade_grant_source_refused");
    for (const statement of statements) {
      const match = /^GRANT\s+([\s\S]*?)\s+ON\s+(?:(SCHEMA|FUNCTION)\s+)?([\s\S]*?)\s+TO\s+(control_room_[a-z_]+)\s*;$/u.exec(statement.trim());
      if (!match || !groups.has(match[4])) throw new Error("upgrade_grant_source_refused");
      const [, rights, objectKind, objects, role] = match;
      for (const rawObject of splitCommas(objects)) {
        const functionMatch = objectKind === "FUNCTION"
          ? /^([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?\(([^()]*)\)$/u.exec(rawObject)
          : null;
        if (objectKind === "FUNCTION" && !functionMatch) throw new Error("upgrade_grant_source_refused");
        const object = objectKind === "FUNCTION"
          ? `${functionMatch[2] ? `${name(functionMatch[1])}.${name(functionMatch[2])}` : `public.${name(functionMatch[1])}`}(${functionMatch[3].trim() ? splitCommas(functionMatch[3]).map(name).join(", ") : ""})`
          : objectKind === "SCHEMA" ? name(rawObject) : rawObject.split(".").map(name).join(".");
        if (!objectKind && !object.includes(".")) {
          if (!identifier.test(object)) throw new Error("upgrade_grant_source_refused");
        }
        const qualified = objectKind ? object : object.includes(".") ? object : `public.${object}`;
        for (const rawRight of splitCommas(rights)) {
          const parsed = /^([A-Z]+)(?:\s*\(([^)]+)\))?$/u.exec(rawRight);
          if (!parsed || !privilege.has(parsed[1])
            || (objectKind === "SCHEMA" && (parsed[1] !== "USAGE" || parsed[2]))
            || (objectKind === "FUNCTION" && (parsed[1] !== "EXECUTE" || parsed[2]
              || !allowedFunctionGrant(role, qualified))))
            throw new Error("upgrade_grant_source_refused");
          const columns = parsed[2] ? splitCommas(parsed[2]).map(name) : [""];
          if (parsed[2] && objectKind) throw new Error("upgrade_grant_source_refused");
          for (const column of columns) {
            const item = tuple({ role, kind: objectKind === "SCHEMA" ? "schema"
              : objectKind === "FUNCTION" ? "function" : "table",
              object: qualified, column, privilege: parsed[1] });
            if (desired.has(item)) throw new Error("upgrade_grant_source_duplicate");
            desired.add(item);
          }
        }
      }
    }
  }
  if (Object.keys(sources).length !== roleFiles.length || desired.size < 150)
    throw new Error("upgrade_grant_source_refused");
  return desired;
}

export async function readDesiredMacGrantsV1() {
  const sources = Object.fromEntries(await Promise.all(roleFiles.map(async file =>
    [file, await readFile(new URL(`../../db/roles/${file}`, import.meta.url), "utf8")])));
  return desiredMacGrantsV1(sources);
}

export const macGrantCatalogSqlV1 = `
SELECT r.rolname AS role, CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'table' END AS kind,
  n.nspname || '.' || c.relname AS object,
  '' AS column, a.privilege_type AS privilege, a.is_grantable
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
JOIN pg_roles r ON r.oid=a.grantee
WHERE r.rolname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f','S')
UNION ALL
SELECT r.rolname, 'table', n.nspname || '.' || c.relname, att.attname, a.privilege_type, a.is_grantable
FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL aclexplode(att.attacl) a
JOIN pg_roles r ON r.oid=a.grantee
WHERE r.rolname = ANY($1::text[]) AND att.attnum > 0 AND NOT att.attisdropped
UNION ALL
SELECT r.rolname, 'schema', n.nspname, '', a.privilege_type, a.is_grantable
FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname = ANY($1::text[])
UNION ALL
SELECT r.rolname, 'database', d.datname, '', a.privilege_type, a.is_grantable
FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname = ANY($1::text[])
UNION ALL
-- The argument types must be spelled the way db/roles/*.sql spells them, which
-- is pg_type.typname (timestamptz), not the SQL-standard expansion
-- oidvectortypes prints (timestamp with time zone). Comparing an expanded
-- spelling against a compact one can never match, so a function whose signature
-- contains an alias would stay permanently "missing" and refuse convergence
-- after its grant had in fact been applied. quote_ident covers a type that has
-- to be quoted; COALESCE keeps the zero-argument case rendering as empty.
SELECT r.rolname, 'function', n.nspname || '.' || p.proname || '(' || COALESCE((SELECT string_agg(
  pg_catalog.quote_ident(t.typname), ', ' ORDER BY u.ord)
  FROM unnest(p.proargtypes) WITH ORDINALITY AS u(oid, ord)
  JOIN pg_type t ON t.oid = u.oid), '') || ')', '', a.privilege_type, a.is_grantable
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(p.proacl) a
JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname = ANY($1::text[])`;

export async function readMacGrantCatalogV1(client) {
  const principals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
  const rows = (await client.query(macGrantCatalogSqlV1, [principals])).rows;
  return macGrantRowsToSetV1(rows);
}

/** THE first of the two ends of the filter, and the one every path crosses:
 * every path from catalogue rows to compared tuples goes through here — the live
 * `readMacGrantCatalogV1`, and `planMacDatabaseUpgradeSnapshotV1`, which is handed
 * a captured snapshot's rows directly and never calls the live reader. Filtering
 * in either caller instead would have left the other one offering `updater` rows
 * to `diffMacGrantsV1` as EXTRA. MEASURED: that is what made the whole upgrade
 * path answer `upgrade_convergence_refused` while the `grantSql` refusal below
 * was already in place. */
export function macGrantRowsToSetV1(rows) {
  return new Set(rows.map(row => tuple(row)).filter(macReleaseOwnedGrantV1));
}

export function diffMacGrantsV1(actual, desired) {
  const extra = [...actual].filter(item => !desired.has(item)).sort();
  const missing = [...desired].filter(item => !actual.has(item)).sort();
  return Object.freeze({ extra, missing });
}

function grantSql(item, verb) {
  const [role, kind, object, column, right, grantable] = item.split("|");
  // THE SECOND root of the filter: the statement itself. Reached when an
  // `updater` item arrives from a route that never built a set through
  // `macGrantRowsToSetV1` — a caller assembling a diff by hand. A REFUSAL and
  // not a skip: the caller passed in a grant set this converger is not allowed
  // to act on, and silently dropping one of a pair of statements would report a
  // convergence it did not perform.
  if (updaterOwned(item)) throw new Error("upgrade_updater_grant_refused");
  if (![...groups, ...Object.keys(macRolePlan)].includes(role) || !privilege.has(right))
    throw new Error("upgrade_grant_catalog_refused");
  if (grantable !== "plain" && grantable !== "grantable") throw new Error("upgrade_grant_catalog_refused");
  if (kind === "function") {
    if (!knownFunctionGrant(object) || verb === "GRANT" && !allowedFunctionGrant(role, object)
      || column || right !== "EXECUTE")
      throw new Error("upgrade_unexpected_function_grant");
    return `${verb} EXECUTE ON FUNCTION ${object} ${verb === "GRANT" ? "TO" : "FROM"} ${role}`;
  }
  if (kind === "database") {
    name(object);
    return `${verb} ${right} ON DATABASE ${object} ${verb === "GRANT" ? "TO" : "FROM"} ${role}`;
  }
  if (kind === "schema") {
    name(object);
    return `${verb} ${right} ON SCHEMA ${object} ${verb === "GRANT" ? "TO" : "FROM"} ${role}`;
  }
  if (kind !== "table" && kind !== "sequence") throw new Error("upgrade_grant_catalog_refused");
  const parts = object.split(".");
  if (parts.length !== 2) throw new Error("upgrade_grant_catalog_refused");
  parts.forEach(name);
  if (column) name(column);
  return `${verb} ${right}${column ? ` (${column})` : ""} ON ${kind === "sequence" ? "SEQUENCE " : ""}${object} ${verb === "GRANT" ? "TO" : "FROM"} ${role}`;
}

export async function applyMacGrantDiffV1(client, diff) {
  for (const item of diff.extra) await client.query(grantSql(item, "REVOKE"));
  for (const item of diff.missing) await client.query(grantSql(item, "GRANT"));
}
