/** Runs only under the PostgreSQL owner account on the VPS. The dry run issues
 * SELECTs only. Secrets arrive on stdin for the real upgrade and never appear
 * in the report, process arguments, or a remote file. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../../deploy/postgres/evidence.mjs";
import { applyMacGrantDiffV1, diffMacGrantsV1, macRolePlan, readDesiredMacGrantsV1,
  readMacGrantCatalogV1, macGrantRowsToSetV1, macGrantCatalogSqlV1 } from "./database-upgrade-grants.mjs";
import { checkedPostgresScramVerifierV1 } from "./database-upgrade-scram.mjs";
import { inspectFixedQueueSchemaV1, installFixedQueueSchemaV1 } from "./fixed-queue-schema.mjs";

const bootstrapTarget = "host=/var/run/postgresql dbname=control_room user=postgres";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const logins = Object.keys(macRolePlan);
const groups = Object.values(macRolePlan);
const principals = [...logins, ...groups];
const migrationLedger = new URL("../../deploy/postgres/migration-ledger.json", import.meta.url);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const roleAttributes = role => `${Object.hasOwn(macRolePlan, role) ? "LOGIN" : "NOLOGIN"} INHERIT `
  + "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

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
      || role.rolcanlogin !== Object.hasOwn(macRolePlan, role.rolname) || !role.rolinherit
      || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls)
      throw new Error("upgrade_role_attributes_refused");
  }
  const found = new Set(roles.map(role => role.rolname));
  for (const role of logins.filter(role => !["control_room_publisher", "control_room_agent_reviewer_login"].includes(role)))
    if (!found.has(role)) throw new Error("upgrade_existing_role_missing");
  const actual = new Set();
  for (const row of memberships) {
    if (!logins.includes(row.member)) throw new Error("upgrade_non_login_membership_refused");
    if (row.parent !== macRolePlan[row.member]
      && !(row.parent === "control_room_application" && row.member !== "control_room_publisher"))
      throw new Error("upgrade_unexpected_login_membership_refused");
    const item = `${row.member}|${row.parent}`;
    if (actual.has(item)) throw new Error("upgrade_duplicate_membership_refused");
    actual.add(item);
  }
  const desired = new Set(Object.entries(macRolePlan).map(([member, parent]) => `${member}|${parent}`));
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
    .map(role => ({ role, attributes: roleAttributes(role) })),
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
    WHERE r.rolname=ANY($1::text[])`, [principals])).rows[0].count;
  const grants = (await client.query(macGrantCatalogSqlV1, [principals])).rows;
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
  if (verb === "REVOKE" && parent === "control_room_application" && member !== "control_room_publisher")
    return parent;
  if (verb === "GRANT" && macRolePlan[member] === parent) return parent;
  throw new Error("upgrade_role_catalog_refused");
};

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

export async function applyMacDatabaseUpgradeV1({ publisherVerifier, agentReviewerVerifier, client, expectedPlanDigest, applyPending,
  onStage = () => {} }) {
  onStage("plan");
  checkedPostgresScramVerifierV1(publisherVerifier);
  checkedPostgresScramVerifierV1(agentReviewerVerifier);
  const before = await inspectMacDatabaseUpgradeV1({ client });
  if (expectedPlanDigest !== undefined && macDatabaseUpgradePlanDigestV1(before) !== expectedPlanDigest)
    throw new Error("upgrade_plan_changed_refused");
  if (before.pendingMigrations.length) {
    if (typeof applyPending !== "function") throw new Error("upgrade_pending_migrations_need_peer_runner");
    onStage("migrate");
    await applyPending();
  }
  if (before.installQueueSchema) {
    onStage("queue");
    await installFixedQueueSchemaV1(client);
  }
  onStage("roles");
  await client.query("BEGIN");
  try {
    const state = roleState(await databaseSnapshot(client));
    for (const group of groups.filter(role => !state.found.has(role)))
      await client.query(`CREATE ROLE ${group} ${roleAttributes(group)}`);
    if (!state.found.has("control_room_publisher")) {
      await client.query(`CREATE ROLE control_room_publisher ${roleAttributes("control_room_publisher")}
        PASSWORD ${client.escapeLiteral(publisherVerifier)}`);
    }
    if (!state.found.has("control_room_agent_reviewer_login")) {
      await client.query(`CREATE ROLE control_room_agent_reviewer_login ${roleAttributes("control_room_agent_reviewer_login")}
        PASSWORD ${client.escapeLiteral(agentReviewerVerifier)}`);
    }
    onStage("grants");
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
    "migration_refused_non_owner_objects"]);
  const candidate = /^(?:upgrade|migration)_[a-z0-9_]+/u.exec(message)?.[0];
  const code = candidate && known.has(candidate) ? candidate : "remote_refused";
  return `upgrade_error:${code} stage=${["plan", "migrate", "queue", "roles", "grants", "verify"].includes(stage)
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
  let verifiers;
  if (applying) {
    try { verifiers = JSON.parse((await readVerifier()).trim()); }
    catch { throw new Error("upgrade_verifier_input_refused"); }
    if (!verifiers || typeof verifiers !== "object" || Array.isArray(verifiers)
      || Object.keys(verifiers).sort().join(",") !== "agentReviewer,publisher")
      throw new Error("upgrade_verifier_input_refused");
    verifiers = { publisher: checkedPostgresScramVerifierV1(verifiers.publisher),
      agentReviewer: checkedPostgresScramVerifierV1(verifiers.agentReviewer) };
  }
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
    return await applyMacDatabaseUpgradeV1({ client, publisherVerifier: verifiers.publisher,
      agentReviewerVerifier: verifiers.agentReviewer,
      expectedPlanDigest: args[4], applyPending, onStage });
  } finally { await client.end(); }
}

async function readVerifierStdinV1() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 700) throw new Error("upgrade_verifier_input_refused");
  }
  return input;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stage = "plan";
  try {
    const result = await runMacDatabaseUpgradeCommandV1({ args: process.argv.slice(2),
      readVerifier: readVerifierStdinV1, onStage: next => { stage = next; } });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${sanitizedMacDatabaseUpgradeFailureV1(error, stage)}\n`);
    process.exitCode = 1;
  }
}
