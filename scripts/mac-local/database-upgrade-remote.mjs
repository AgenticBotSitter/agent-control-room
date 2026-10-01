import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
/** Runs only under the PostgreSQL owner account on the VPS. The dry run issues
 * SELECTs only. A login code (a SCRAM verifier, never a password) is read from
 * stdin only when the plan creates a new login, and never appears in the
 * report, process arguments, or a remote file. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../../deploy/postgres/evidence.mjs";
import { applyMacGrantDiffV1, diffMacGrantsV1, macRolePlan, readDesiredMacGrantsV1,
  readMacGrantCatalogV1, macGrantRowsToSetV1, macGrantCatalogSqlV1 } from "./database-upgrade-grants.mjs";
import { checkedPostgresScramVerifierV1 } from "./database-upgrade-scram.mjs";
import { databaseRoleAttributesV1, databaseRoleManifestV1 as manifest, databaseRoleNamesV1 as principals }
  from "./database-role-manifest.mjs";
import { inspectFixedQueueSchemaV1, installFixedQueueSchemaV1 } from "./fixed-queue-schema.mjs";

const bootstrapTarget = "host=/var/run/postgresql dbname=control_room user=postgres";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const logins = Object.keys(manifest.logins);
const groups = manifest.groups;
const newLogins = logins.filter(login => manifest.logins[login].newLogin);
const macPrincipals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
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
    if (!principals.includes(role.rolname)
      || role.rolcanlogin !== Object.hasOwn(manifest.logins, role.rolname) || !role.rolinherit
      || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls)
      throw new Error("upgrade_role_attributes_refused");
  }
  const found = new Set(roles.map(role => role.rolname));
  for (const role of logins.filter(role => !manifest.logins[role].newLogin))
    if (!found.has(role)) throw new Error("upgrade_existing_role_missing");
  const actual = new Set();
  for (const row of memberships) {
    if (!logins.includes(row.member)) throw new Error("upgrade_non_login_membership_refused");
    if (row.parent !== manifest.logins[row.member].group && row.parent !== manifest.logins[row.member].legacyGroup)
      throw new Error("upgrade_unexpected_login_membership_refused");
    const item = `${row.member}|${row.parent}`;
    if (actual.has(item)) throw new Error("upgrade_duplicate_membership_refused");
    actual.add(item);
  }
  const desired = new Set(logins.map(member => `${member}|${manifest.logins[member].group}`));
  if (memberships.some(row => row.admin_option || !row.inherit_option || !row.set_option))
    throw new Error("upgrade_role_membership_options_refused");
  if (defaultAcl !== 0) throw new Error("upgrade_unexpected_default_grant");
  const split = value => { const [member, parent] = value.split("|"); return { member, parent }; };
  return { found, membership: { grant: [...desired].filter(value => !actual.has(value)).sort().map(split),
    revoke: [...actual].filter(value => !desired.has(value)).sort().map(split) } };
}

export async function planMacDatabaseUpgradeSnapshotV1(snapshot) {
  const pending = await pendingMigrations(snapshot.applied);
  const roles = roleState(snapshot);
  if (snapshot.queue?.schemaExists !== false && snapshot.queue?.verified !== true)
    throw new Error("upgrade_queue_snapshot_unverified");
  const desired = await readDesiredMacGrantsV1();
  const actual = macGrantRowsToSetV1(snapshot.grants);
  const grants = diffMacGrantsV1(actual, desired);
  return { pendingMigrations: pending, installQueueSchema: snapshot.queue.schemaExists === false,
    createRoles: principals.filter(role => !roles.found.has(role)).sort()
    .map(role => ({ role, attributes: databaseRoleAttributesV1(role) })),
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
    WHERE member.rolname=ANY($1::text[]) OR parent.rolname=ANY($2::text[])
    ORDER BY member.rolname,parent.rolname`, [principals, groups])).rows;
  const defaultAcl = (await client.query(`SELECT count(*)::int AS count FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE r.rolname=ANY($1::text[])`, [macPrincipals])).rows[0].count;
  const grants = (await client.query(macGrantCatalogSqlV1, [macPrincipals])).rows;
  const queue = await inspectFixedQueueSchemaV1(client);
  return { applied, roles, memberships, defaultAcl, grants,
    queue: { ...queue, verified: queue.schemaExists } };
}

async function report(client) {
  return planMacDatabaseUpgradeSnapshotV1(await databaseSnapshot(client));
}

const safeMember = value => {
  if (!logins.includes(value)) throw new Error("upgrade_role_catalog_refused");
  return value;
};
const safeParent = (member, parent, verb) => {
  if (verb === "REVOKE" && parent === manifest.logins[member].legacyGroup) return parent;
  if (verb === "GRANT" && manifest.logins[member].group === parent) return parent;
  throw new Error("upgrade_role_catalog_refused");
};

/** Login codes: nothing, one bare verifier (the publisher, as before), or a
 * JSON object of manifest login -> verifier. */
export function parseMacDatabaseLoginCodesV1(input) {
  const text = typeof input === "string" ? input.trim() : input === undefined ? "" : undefined;
  if (text === undefined) throw new Error("upgrade_verifier_input_refused");
  if (!text) return {};
  if (!text.startsWith("{")) return { control_room_publisher: checkedPostgresScramVerifierV1(text) };
  let codes;
  try { codes = JSON.parse(text); } catch { throw new Error("upgrade_verifier_input_refused"); }
  if (!codes || typeof codes !== "object" || Array.isArray(codes)
    || Object.keys(codes).some(role => !newLogins.includes(role))) throw new Error("upgrade_verifier_input_refused");
  return Object.fromEntries(Object.entries(codes).map(([role, code]) => [role, checkedPostgresScramVerifierV1(code)]));
}

export function plainMacDatabaseUpgradeRefusalV1(error) {
  const names = /^upgrade_new_login_needs_verifier:([a-z_,]+)$/u.exec(error?.message ?? "")?.[1].split(",");
  if (!names?.length || names.some(name => !newLogins.includes(name))) return undefined;
  return `Refused: this upgrade adds the new database login ${names.join(" and ")}, and each needs its login `
    + "code from the Mac. Nothing was changed. Run the upgrade again with the code on standard input.";
}

export async function inspectMacDatabaseUpgradeV1({ client }) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const plan = await report(client);
    await client.query("COMMIT");
    return plan;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export function macDatabaseUpgradePlanDigestV1(plan) {
  return `sha256:${sha256(JSON.stringify(plan))}`;
}

/** Roles first: missing manifest groups and new logins are created before any
 * migration or grant refers to them. A login code is read only when the
 * approved plan creates a login, so a repeat upgrade needs no code at all. */
export async function applyMacDatabaseUpgradeV1({ client, expectedPlanDigest, applyPending, publisherVerifier,
  loginVerifiers, readLoginVerifiers, onStage = () => {} }) {
  onStage("plan");
  const before = await inspectMacDatabaseUpgradeV1({ client });
  if (expectedPlanDigest !== undefined && macDatabaseUpgradePlanDigestV1(before) !== expectedPlanDigest)
    throw new Error("upgrade_plan_changed_refused");
  if (before.pendingMigrations.length && typeof applyPending !== "function")
    throw new Error("upgrade_pending_migrations_need_peer_runner");
  const plannedLogins = before.createRoles.map(item => item.role).filter(role => logins.includes(role));
  let codes = {};
  if (plannedLogins.length) {
    codes = readLoginVerifiers ? parseMacDatabaseLoginCodesV1(await readLoginVerifiers()) : {
      ...(publisherVerifier === undefined ? {} : { control_room_publisher: checkedPostgresScramVerifierV1(publisherVerifier) }),
      ...parseMacDatabaseLoginCodesV1(JSON.stringify(loginVerifiers ?? {})) };
    if (plannedLogins.some(role => !codes[role]))
      throw new Error(`upgrade_new_login_needs_verifier:${plannedLogins.join(",")}`);
  }
  if (before.createRoles.length) {
    onStage("roles");
    await client.query("BEGIN");
    try {
      const state = roleState(await databaseSnapshot(client));
      for (const role of principals.filter(name => !state.found.has(name))) {
        if (logins.includes(role) && !codes[role]) throw new Error(`upgrade_new_login_needs_verifier:${role}`);
        await client.query(`CREATE ROLE ${role} ${databaseRoleAttributesV1(role)}${logins.includes(role)
          ? ` PASSWORD ${client.escapeLiteral(codes[role])}` : ""}`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }
  if (before.pendingMigrations.length) {
    onStage("migrate");
    await applyPending();
  }
  if (before.installQueueSchema) {
    onStage("queue");
    await installFixedQueueSchemaV1(client);
  }
  onStage("grants");
  await client.query("BEGIN");
  try {
    const state = roleState(await databaseSnapshot(client));
    const current = await readMacGrantCatalogV1(client);
    const desired = await readDesiredMacGrantsV1();
    await applyMacGrantDiffV1(client, diffMacGrantsV1(current, desired));
    for (const item of state.membership.revoke) {
      onStage("roles");
      const member = safeMember(item.member), parent = safeParent(member, item.parent, "REVOKE");
      await client.query(`REVOKE ${parent} FROM ${member}`);
    }
    for (const item of state.membership.grant) {
      onStage("roles");
      const member = safeMember(item.member), parent = safeParent(member, item.parent, "GRANT");
      await client.query(`GRANT ${parent} TO ${member}`);
    }
    onStage("verify");
    const after = await report(client);
    if (after.pendingMigrations.length || after.installQueueSchema || after.createRoles.length || after.membership.revoke.length
      || after.membership.grant.length || after.grants.extra.length || after.grants.missing.length)
      throw new Error("upgrade_convergence_refused");
    await client.query("COMMIT");
    return { upgraded: true, before, after };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function applyPendingMacMigrationsV1(target = bootstrapTarget) {
  return applyMigrations({ bootstrapTarget: target, migrateTarget: target,
    migrateViaLocalPeer: true, env: {} });
}

const safeCauseCode = (error, accept) => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (typeof current.code === "string" && accept(current.code)) return current.code;
    current = current.cause;
  }
  return "none";
};
const safeSqlstate = error => safeCauseCode(error, code => /^[0-9A-Z]{5}$/u.test(code));
const safeSystemCode = error => safeCauseCode(error, code => ["ENOENT", "EACCES", "EPERM", "ECONNREFUSED",
  "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code));
const safeErrorClass = error => {
  const sqlstate = safeSqlstate(error);
  if (sqlstate !== "none") return `SQLSTATE_${sqlstate.slice(0, 2)}`;
  const name = error?.constructor?.name;
  return ["DatabaseError", "Error", "TypeError", "RangeError", "SyntaxError", "AggregateError"].includes(name)
    ? name : "Unknown";
};

export function sanitizedMacDatabaseUpgradeFailureV1(error, stage) {
  const message = error instanceof Error ? error.message : "";
  const known = new Set(["upgrade_input_refused", "upgrade_main_checkout_refused",
    "upgrade_verifier_input_refused", "upgrade_scram_verifier_refused", "upgrade_operator_identity_refused",
    "upgrade_plan_changed_refused", "upgrade_pending_migrations_need_peer_runner",
    "upgrade_new_login_needs_verifier",
    "upgrade_existing_role_missing", "upgrade_role_attributes_refused", "upgrade_convergence_refused",
    "upgrade_role_catalog_refused", "upgrade_non_login_membership_refused",
    "upgrade_unexpected_login_membership_refused", "upgrade_duplicate_membership_refused",
    "upgrade_role_membership_options_refused", "upgrade_unexpected_default_grant",
    "upgrade_source_ledger_refused", "upgrade_ledger_prefix_refused", "upgrade_queue_snapshot_unverified",
    "upgrade_queue_shape_refused", "upgrade_queue_existing_refused", "upgrade_queue_cleanup_refused",
    "upgrade_grant_catalog_refused", "upgrade_grant_source_refused", "upgrade_unexpected_function_grant",
    "migration_peer_target_refused", "migration_peer_operator_refused", "migration_peer_role_refused",
    "migration_peer_identity_refused", "migration_live_schema_drift", "migration_failed",
    "migration_gap", "migration_missing", "migration_altered", "migration_ledger_digest_mismatch",
    "migration_unknown_row", "migration_unknown_rows", "migration_unknown_kind",
    "migration_refused_non_owner_objects", "upgrade_mac_login_connected", "upgrade_schema_drift_refused",
    "upgrade_disk_space_low", "upgrade_backup_failed"]);
  const candidate = /^(?:upgrade|migration)_[a-z0-9_]+/u.exec(message)?.[0];
  const code = candidate && known.has(candidate) ? candidate : "remote_refused";
  return `upgrade_error:${code} stage=${["check", "plan", "backup", "migrate", "queue", "roles", "grants", "verify"]
    .includes(stage)
    ? stage : "plan"} sqlstate=${safeSqlstate(error)} class=${safeErrorClass(error)} system=${safeSystemCode(error)}`;
}

const sourceGit = params => execFileSync("git", ["-C", repoRoot, ...params],
  { encoding: "utf8", timeout: 10_000 }).trim();

export async function runMacDatabaseUpgradeCommandV1({ args, readVerifier, git = sourceGit,
  openClient = () => connectTarget(bootstrapTarget), applyPending = applyPendingMacMigrationsV1,
  onStage = () => {} }) {
  onStage("plan");
  const planning = args.length === 3 && args[0] === "--plan" && args[1] === "--expected-main";
  const applying = args.length === 5 && args[0] === "--apply" && args[1] === "--expected-main"
    && args[3] === "--expected-plan-digest" && /^sha256:[a-f0-9]{64}$/u.test(args[4]);
  if ((!planning && !applying) || !/^[a-f0-9]{40}$/u.test(args[2])) throw new Error("upgrade_input_refused");
  if (git(["rev-parse", "HEAD"]) !== args[2]
    || git(["rev-parse", "refs/remotes/origin/main"]) !== args[2]
    || git(["status", "--porcelain"])) throw new Error("upgrade_main_checkout_refused");
  const client = openClient();
  await client.connect();
  try {
    const identity = (await client.query("SELECT current_user, session_user, rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
    if (identity?.current_user !== "postgres" || identity?.session_user !== "postgres"
      || identity?.rolsuper !== true) throw new Error("upgrade_operator_identity_refused");
    if (planning) {
      const plan = await inspectMacDatabaseUpgradeV1({ client });
      return { plan, digest: macDatabaseUpgradePlanDigestV1(plan) };
    }
    return await applyMacDatabaseUpgradeV1({ client, readLoginVerifiers: readVerifier,
      expectedPlanDigest: args[4], applyPending, onStage });
  } finally { await client.end(); }
}

async function readVerifierStdinV1() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 4096) throw new Error("upgrade_verifier_input_refused");
  }
  return input;
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  let stage = "plan";
  try {
    const result = await runMacDatabaseUpgradeCommandV1({ args: process.argv.slice(2),
      readVerifier: readVerifierStdinV1, onStage: next => { stage = next; } });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${sanitizedMacDatabaseUpgradeFailureV1(error, stage)}\n`);
    const plain = plainMacDatabaseUpgradeRefusalV1(error);
    if (plain) process.stderr.write(`${plain}\n`);
    process.exitCode = 1;
  }
}
