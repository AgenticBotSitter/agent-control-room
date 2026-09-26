/** Runs only under the PostgreSQL owner account on the VPS. The dry run issues
 * SELECTs only. Secrets arrive on stdin for the real upgrade and never appear
 * in the report, process arguments, or a remote file. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { applyMigrations } from "../../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../../deploy/postgres/evidence.mjs";
import { applyMacGrantDiffV1, diffMacGrantsV1, macRolePlan, readDesiredMacGrantsV1,
  readMacGrantCatalogV1, macGrantRowsToSetV1, macGrantCatalogSqlV1 } from "./database-upgrade-grants.mjs";

const bootstrapTarget = "host=/var/run/postgresql dbname=control_room user=postgres";
const principals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
const migrationLedger = new URL("../../deploy/postgres/migration-ledger.json", import.meta.url);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function pendingMigrations(applied) {
  const ledger = JSON.parse(await readFile(migrationLedger, "utf8"));
  const entries = ledger.entries.filter(item => (item.kind ?? "migrate") === "migrate");
  for (const item of ledger.entries) {
    const bytes = await readFile(new URL(`../../${item.file}`, import.meta.url));
    if (sha256(bytes) !== item.sha256) throw new Error("upgrade_source_ledger_refused");
  }
  if (!applied.every((row, index) => row.filename === entries[index]?.file
    && Number(row.ledger_order) === entries[index]?.order && row.digest === `sha256:${entries[index]?.sha256}`))
    throw new Error("upgrade_ledger_prefix_refused");
  return entries.slice(applied.length).map(item => item.file);
}

function roleState({ roles, memberships, defaultAcl }) {
  for (const role of roles) {
    if (role.rolcanlogin !== Object.hasOwn(macRolePlan, role.rolname) || !role.rolinherit
      || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls)
      throw new Error("upgrade_role_attributes_refused");
  }
  const found = new Set(roles.map(role => role.rolname));
  for (const role of principals.filter(role => !role.includes("publisher")))
    if (!found.has(role)) throw new Error("upgrade_existing_role_missing");
  const actual = new Set(memberships.map(row => `${row.member}|${row.parent}`));
  const desired = new Set(Object.entries(macRolePlan).map(([member, parent]) => `${member}|${parent}`));
  if (memberships.some(row => row.admin_option || !row.inherit_option || !row.set_option))
    throw new Error("upgrade_role_membership_options_refused");
  if (defaultAcl !== 0) throw new Error("upgrade_unexpected_default_grant");
  return { found, membership: { missing: [...desired].filter(value => !actual.has(value)).sort(),
    extra: [...actual].filter(value => !desired.has(value)).sort() } };
}

export async function planMacDatabaseUpgradeSnapshotV1(snapshot) {
  const pending = await pendingMigrations(snapshot.applied);
  const roles = roleState(snapshot);
  const desired = await readDesiredMacGrantsV1();
  const actual = macGrantRowsToSetV1(snapshot.grants);
  const grants = diffMacGrantsV1(actual, desired);
  return { pendingMigrations: pending, createRoles: principals.filter(role => !roles.found.has(role)).sort(),
    membership: roles.membership, grants };
}

async function databaseSnapshot(client) {
  const applied = (await client.query(`SELECT filename, digest, ledger_order FROM control_room_schema_migrations
    ORDER BY ledger_order`)).rows;
  const roles = (await client.query(`SELECT rolname, rolcanlogin, rolinherit, rolsuper,
    rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [principals])).rows;
  const memberships = (await client.query(`SELECT member.rolname AS member, parent.rolname AS parent,
      auth.admin_option, auth.inherit_option, auth.set_option
    FROM pg_auth_members auth JOIN pg_roles member ON member.oid=auth.member
      JOIN pg_roles parent ON parent.oid=auth.roleid
    WHERE member.rolname=ANY($1::text[]) ORDER BY member.rolname,parent.rolname`, [principals])).rows;
  const defaultAcl = (await client.query(`SELECT count(*)::int AS count FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE r.rolname=ANY($1::text[])`, [principals])).rows[0].count;
  const grants = (await client.query(macGrantCatalogSqlV1, [principals])).rows;
  return { applied, roles, memberships, defaultAcl, grants };
}

async function report(client) {
  return planMacDatabaseUpgradeSnapshotV1(await databaseSnapshot(client));
}

const safeRole = value => {
  if (!principals.includes(value)) throw new Error("upgrade_role_catalog_refused");
  return value;
};

export async function inspectMacDatabaseUpgradeV1({ client }) {
  return report(client);
}

export async function applyMacDatabaseUpgradeV1({ publisherPassword, migratorPassword, client,
  applyPending = applyMigrations, bootstrapConnection = bootstrapTarget,
  migrateConnection = `host=127.0.0.1 port=5432 dbname=control_room user=control_room_migrator password=${migratorPassword}` }) {
  if (typeof publisherPassword !== "string" || publisherPassword.length < 32
    || typeof migratorPassword !== "string" || migratorPassword.length < 32)
    throw new Error("upgrade_password_input_refused");
  const before = await report(client);
  // Existing logins retain their passwords. A missing publisher login is the
  // only role that may be created by this upgrade.
  if (before.createRoles.some(role => !role.includes("publisher"))) throw new Error("upgrade_existing_role_missing");
  await applyPending({ bootstrapTarget: bootstrapConnection,
    migrateTarget: migrateConnection,
    env: {} });
  await client.query("BEGIN");
  try {
    const state = roleState(await databaseSnapshot(client));
    if (!state.found.has("control_room_local_result_publisher"))
      await client.query(`CREATE ROLE control_room_local_result_publisher NOLOGIN INHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    if (!state.found.has("control_room_publisher")) {
      await client.query(`CREATE ROLE control_room_publisher LOGIN INHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(publisherPassword)}`);
    }
    const current = await readMacGrantCatalogV1(client);
    const desired = await readDesiredMacGrantsV1();
    await applyMacGrantDiffV1(client, diffMacGrantsV1(current, desired));
    for (const item of state.membership.extra) {
      const [member, parent] = item.split("|").map(safeRole);
      await client.query(`REVOKE ${parent} FROM ${member}`);
    }
    for (const item of state.membership.missing) {
      const [member, parent] = item.split("|").map(safeRole);
      await client.query(`GRANT ${parent} TO ${member}`);
    }
    const after = await report(client);
    if (after.pendingMigrations.length || after.createRoles.length || after.membership.extra.length
      || after.membership.missing.length || after.grants.extra.length || after.grants.missing.length)
      throw new Error("upgrade_convergence_refused");
    await client.query("COMMIT");
    return { upgraded: true, before, after };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let input = "";
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4096) throw new Error("upgrade_input_refused");
    }
    const request = JSON.parse(input);
    if (Object.keys(request).sort().join(",") !== (request.dryRun
      ? "dryRun" : "dryRun,migratorPassword,publisherPassword")) throw new Error("upgrade_input_refused");
    const client = connectTarget(bootstrapTarget);
    await client.connect();
    try {
      const result = request.dryRun ? await inspectMacDatabaseUpgradeV1({ client })
        : await applyMacDatabaseUpgradeV1({ client, migratorPassword: request.migratorPassword,
          publisherPassword: request.publisherPassword });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally { await client.end(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /^(upgrade_[a-z0-9_]+)/u.exec(message)?.[1]
      ?? /^(migration_[a-z0-9_]+)/u.exec(message)?.[1] ?? "remote_refused";
    process.stderr.write(`upgrade_error:${code}\n`);
    process.exitCode = 1;
  }
}
