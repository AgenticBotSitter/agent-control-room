/** Exact direct ACL comparison for the five Mac-local database logins.
 * This is an offline installer component, never imported by the task host. */
import { readFile } from "node:fs/promises";

export const macRolePlan = Object.freeze({
  control_room_web: "control_room_private_web",
  control_room_coordinator: "control_room_task_coordinator",
  control_room_results: "control_room_native_results",
  control_room_publisher: "control_room_local_result_publisher",
  control_room_queue_worker: "control_room_native_queue_worker",
});

const roleFiles = Object.freeze([
  "private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
]);
const groups = new Set(Object.values(macRolePlan));
const identifier = /^[a-z][a-z0-9_]*$/u;
const privilege = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "USAGE"]);
const name = value => {
  if (!identifier.test(value)) throw new Error("upgrade_grant_source_refused");
  return value;
};
const tuple = ({ role, kind, object, column = "", privilege: right, is_grantable = false }) =>
  [role, kind, object, column, right, is_grantable ? "grantable" : "plain"].join("|");

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
      const match = /^GRANT\s+([\s\S]*?)\s+ON\s+(?:(SCHEMA)\s+)?([\s\S]*?)\s+TO\s+(control_room_[a-z_]+)\s*;$/u.exec(statement.trim());
      if (!match || !groups.has(match[4])) throw new Error("upgrade_grant_source_refused");
      const [, rights, schema, objects, role] = match;
      for (const rawObject of splitCommas(objects)) {
        const object = schema ? name(rawObject) : rawObject.split(".").map(name).join(".");
        if (!schema && !object.includes(".")) {
          if (!identifier.test(object)) throw new Error("upgrade_grant_source_refused");
        }
        const qualified = schema ? object : object.includes(".") ? object : `public.${object}`;
        for (const rawRight of splitCommas(rights)) {
          const parsed = /^([A-Z]+)(?:\s*\(([^)]+)\))?$/u.exec(rawRight);
          if (!parsed || !privilege.has(parsed[1]) || (schema && (parsed[1] !== "USAGE" || parsed[2])))
            throw new Error("upgrade_grant_source_refused");
          const columns = parsed[2] ? splitCommas(parsed[2]).map(name) : [""];
          if (parsed[2] && schema) throw new Error("upgrade_grant_source_refused");
          for (const column of columns) desired.add(tuple({ role, kind: schema ? "schema" : "table",
            object: qualified, column, privilege: parsed[1] }));
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
SELECT r.rolname, 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', '', a.privilege_type, a.is_grantable
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(p.proacl) a
JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname = ANY($1::text[])`;

export async function readMacGrantCatalogV1(client) {
  const principals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
  const rows = (await client.query(macGrantCatalogSqlV1, [principals])).rows;
  return macGrantRowsToSetV1(rows);
}

export function macGrantRowsToSetV1(rows) {
  return new Set(rows.map(row => tuple(row)));
}

export function diffMacGrantsV1(actual, desired) {
  const extra = [...actual].filter(item => !desired.has(item)).sort();
  const missing = [...desired].filter(item => !actual.has(item)).sort();
  return Object.freeze({ extra, missing });
}

function grantSql(item, verb) {
  const [role, kind, object, column, right, grantable] = item.split("|");
  if (![...groups, ...Object.keys(macRolePlan)].includes(role) || !privilege.has(right))
    throw new Error("upgrade_grant_catalog_refused");
  if (grantable !== "plain" && grantable !== "grantable") throw new Error("upgrade_grant_catalog_refused");
  if (kind === "function") throw new Error("upgrade_unexpected_function_grant");
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
