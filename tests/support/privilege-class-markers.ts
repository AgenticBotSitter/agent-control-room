/**
 * Privilege-class marker tables are granted, not inherited.
 *
 * `work_intake_role_anchor` and `fleet_gateway_role_anchor` are empty relations
 * that carry a privilege class in their ACL: the guards that read them ask
 * whether the session login holds SELECT, and a member of the class does. That
 * is the whole point -- it survives a role rename and is remapped by backup and
 * restore instead of persisting a cluster-local OID -- but it also means the
 * marker is indistinguishable from the real class.
 *
 * So a fixture that says `GRANT ALL ON ALL TABLES IN SCHEMA public` to its own
 * writer login has silently promoted that writer into the fleet gateway. The
 * guard then fires on its first insert into a shared table and the test fails
 * with a message about the fleet, from a fixture that has nothing to do with
 * the fleet. That is exactly what happened to the project-activity and
 * project-coordination lanes.
 *
 * Production does not hit this: db/roles/*.sql grant the marker to one named
 * group, and a login holds it only by inheriting that group. A fixture login
 * with no such membership must be stripped back, which is what this does.
 *
 * The names are derived from the schema rather than pinned, so a third marker
 * added by a later migration is covered without another edit here.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."$]+)/gi;
const ANCHOR_NAME = /_role_anchor$/i;

/**
 * Every marker table the shipped migrations create whose ACL the guards read.
 * @param {string} root repository root containing db/migrations
 * @returns {Promise<string[]>} unqualified table names, sorted
 */
export async function privilegeClassMarkerTables(root = "."): Promise<string[]> {
  const directory = join(root, "db", "migrations");
  const found = new Set<string>();
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    const sql = (await readFile(join(directory, file), "utf8")).replace(/--[^\n]*/g, " ");
    for (const match of sql.matchAll(CREATE_TABLE)) {
      const name = match[1]!.replace(/^public\./i, "").replace(/^"|"$/g, "");
      if (ANCHOR_NAME.test(name)) found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * SQL that strips a fixture login back out of every privilege class, so the
 * markers mean what they mean in production.
 * @param {string} login the fixture's LOGIN role
 * @param {readonly string[]} markers result of {@link privilegeClassMarkerTables}
 * @returns {string} the statements to run as the schema owner
 */
export function revokeMarkerClassesSql(login: string, markers: readonly string[]) {
  return markers.map(name => `REVOKE ALL ON ${name} FROM ${login};`).join("\n");
}
