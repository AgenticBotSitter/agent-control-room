import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const functionStatement = /CREATE(?: OR REPLACE)? FUNCTION\s+([a-z0-9_]+)\s*\([^)]*\)\s+RETURNS[\s\S]*?\$\$[\s\S]*?\$\$\s*;/giu;
const hardenedSearchPath = /SET\s+search_path\s*=\s*pg_catalog\s*,\s*public\s*,\s*pg_temp(?=\s+(?:AS|\$\$))/iu;

test("self-hosting SECURITY DEFINER and trigger functions put pg_temp last", async () => {
  const names = (await readdir("db/migrations"))
    .filter(name => /^0(?:09[3-9]|1\d{2})_.*\.sql$/u.test(name))
    .sort();
  const missing = [];
  for (const name of names) {
    const source = await readFile(`db/migrations/${name}`, "utf8");
    for (const match of source.matchAll(functionStatement)) {
      const statement = match[0];
      if (/RETURNS\s+trigger\b/iu.test(statement) || /SECURITY\s+DEFINER/iu.test(statement)) {
        if (!hardenedSearchPath.test(statement)) missing.push(`${name}:${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `unsafe function search_path: ${missing.join(", ")}`);
});

test("production restricted roles cannot create temporary database objects", async () => {
  const [provision, roles, databaseAcl] = await Promise.all([
    readFile("db/roles/production_provision.sql", "utf8"),
    readFile("db/roles/production_roles.sql", "utf8"),
    readFile("db/roles/private_web_database.sql", "utf8")]);
  for (const source of [provision, roles, databaseAcl]) {
    assert.match(source, /REVOKE\s+(?:CREATE,\s*)?TEMPORARY\s+ON\s+DATABASE\s+%I\s+FROM\s+PUBLIC/iu);
  }
  for (const role of ["control_room_application", "control_room_app", "control_room_schedule_admissions",
    "control_room_scheduler", "control_room_github_broker", "control_room_work_intake",
    "control_room_work_intake_agent"]) {
    assert.match(provision, new RegExp(`REVOKE\\s+TEMPORARY\\s+ON\\s+DATABASE\\s+%I\\s+FROM\\s+${role}\\b`, "u"));
  }
});
