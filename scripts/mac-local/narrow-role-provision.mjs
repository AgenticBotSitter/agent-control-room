/** Offline-only setup for the Mac-local PostgreSQL logins. Never imported
 * by application startup. Existing grants are inspected, not repaired here;
 * live membership correction is the separately reviewed step 11.C. */
import { readFile } from "node:fs/promises";
import { inspectFixedQueueSchemaV1, installFixedQueueSchemaV1 } from "./fixed-queue-schema.mjs";
import { macRolePlan } from "./database-upgrade-grants.mjs";

const plan = Object.freeze(Object.entries(macRolePlan));
const roleFiles = Object.freeze([
  "private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
  "agent_reviewer_roles.sql", "fleet_gateway_roles.sql",
  // R5B-01: the nightly backup dumps as `control_room_migrator` and `pg_dump`
  // reads every schema, so the dump login needs a read on `control_room_queue`.
  // LAST, because it is the only one here that depends on `installFixedQueue`
  // having run — the function above it — and depends on nothing any other file in
  // this list creates. The loop applies these as the client this provisioner was
  // handed, which on a Mac-local install is the queue schema's owner, and that
  // is the only role that can make the grant at all.
  //
  // DELIBERATELY NOT IN `database-upgrade-grants.mjs`'s `roleFiles`. That list is
  // the release grant CONVERGER's source, its parser requires every grantee to be
  // one of the Mac-local service groups, and `control_room_schema_owner` is
  // deliberately not one of them: it is the migrator's group, not a service
  // login's. Adding this file there would make the parser refuse the whole
  // release. It is also unnecessary — the converger only reads grants for the
  // principals in `desired-grants.json`, so a grant to `control_room_schema_owner`
  // is invisible to it and can never be revoked as extra.
  "queue_backup_read_roles.sql",
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
