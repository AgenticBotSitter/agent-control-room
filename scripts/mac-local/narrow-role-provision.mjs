/** Offline-only setup for the six Mac-local PostgreSQL logins. Never imported
 * by application startup. Existing grants are inspected, not repaired here;
 * live membership correction is the separately reviewed step 11.C. */
import { readFile } from "node:fs/promises";
import { inspectFixedQueueSchemaV1, installFixedQueueSchemaV1 } from "./fixed-queue-schema.mjs";

const plan = Object.freeze([
  ["control_room_web", "control_room_private_web"],
  ["control_room_coordinator", "control_room_task_coordinator"],
  ["control_room_results", "control_room_native_results"],
  ["control_room_publisher", "control_room_local_result_publisher"],
  ["control_room_agent_reviewer_login", "control_room_agent_reviewer"],
  ["control_room_queue_worker", "control_room_native_queue_worker"],
]);
const roleFiles = Object.freeze([
  "private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
  "agent_reviewer_roles.sql",
]);
const roleSource = file => new URL(`../../db/roles/${file}`, import.meta.url);

async function installFixedQueue(client) {
  const queue = await inspectFixedQueueSchemaV1(client);
  if (!queue.schemaExists) await installFixedQueueSchemaV1(client);
}

async function inspectRoles(client) {
  const names = plan.map(([, role]) => role);
  const rows = (await client.query(`SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])`, [names])).rows;
  // An existing role may have gained direct or inherited privileges after
  // installation. Mere name/attribute checks do not prove ACL equivalence.
  // Until the reviewed catalog comparison exists, never adopt or rewrite it.
  if (rows.length !== 0) throw new Error("narrow_role_existing_audit_required");
}

export async function provisionMacLocalNarrowRolesV1(client, passwords) {
  if (!passwords || Object.keys(passwords).sort().join(",") !== plan.map(([login]) => login).sort().join(","))
    throw new Error("narrow_role_login_set_refused");
  await inspectRoles(client);
  for (const [login] of plan) {
    const row = (await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rows;
    // A pre-existing login may have direct ACLs even with no group membership.
    if (row.length) throw new Error("narrow_role_existing_login_audit_required");
  }
  // The migration ledger is already applied by the caller. This idempotent
  // group-role file is the first mutating step, after pre-existing identities
  // have been refused and before queue installation.
  await client.query(await readFile(roleSource("production_roles.sql"), "utf8"));
  await installFixedQueue(client);
  await client.query(await readFile(roleSource("private_web_database.sql"), "utf8"));
  for (const file of roleFiles) await client.query(await readFile(roleSource(file), "utf8"));
  for (const [login, group] of plan) {
    await client.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await client.query(`ALTER ROLE ${login} PASSWORD ${client.escapeLiteral(passwords[login])}`);
    await client.query(`GRANT ${group} TO ${login}`);
  }
  return { createdNarrowRoles: true };
}
