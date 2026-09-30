import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, mkdir, readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureProvisionedMacLocalConfigurationV1,
  prepareMacLocalDatabaseUpgradeV1, finishMacLocalDatabaseUpgradeV1,
  prepareProvisionedWorkIntakeConfigurationV1,
  planMacDatabaseUpgradeFromFileV1, provisionMacLocalDatabaseV1,
  macLocalRouteFromTailscaleStatusV1 } from "../scripts/mac-local/provision-database.mjs";
import { startMacLocalWebHost } from "../scripts/mac-local/start-web-host.mjs";
import * as macLocalProtectedLoader from "../src/web/v1/mac-local-protected-loader.ts";
import { captureMacUpgradeSnapshotV1 } from "../scripts/mac-local/database-upgrade-snapshot.mjs";
import { checkedPostgresScramVerifierV1, postgresScramVerifierV1 } from
  "../scripts/mac-local/database-upgrade-scram.mjs";
import { applyMacGrantDiffV1, desiredMacGrantsV1, diffMacGrantsV1, macGrantCatalogSqlV1, macRolePlan,
  readDesiredMacGrantsV1 } from
  "../scripts/mac-local/database-upgrade-grants.mjs";
import { MAC_LOCAL_DATABASE_ROLES_V1, captureMacLocalDatabaseRolesV1 } from
  "../src/web/v1/mac-local-database-roles.ts";
import { sha256Digest } from "../src/security/canonical-digest";
import { captureWorkIntakeClientConfigurationV1, captureWorkIntakeServerConfigurationV1,
  workIntakeClientFileNameV1 } from "../src/work-intake/v1/installed-configuration.ts";
import { createMappedWorkIntakeCredentialVerifierV1 } from "../src/work-intake/v1/machine-auth.ts";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { parseMacDatabaseLoginCodesV1, planMacDatabaseUpgradeSnapshotV1, sanitizedMacDatabaseUpgradeFailureV1 } from
  "../scripts/mac-local/database-upgrade-remote.mjs";

const newUpgradeLogins = ["control_room_agent_reviewer_login", "control_room_fleet",
  "control_room_fleet_owner", "control_room_publisher", "control_room_work_intake_agent"];

test("upgrade failure reports only the bounded stage, SQLSTATE and error class", () => {
  const secret = "SCRAM-SHA-256$secret-material";
  const error = Object.assign(new Error(`permission denied ${secret}`), {
    code: "42501", detail: secret, hint: secret,
  });
  const report = sanitizedMacDatabaseUpgradeFailureV1(error, "grants");
  assert.equal(report, "upgrade_error:remote_refused stage=grants sqlstate=42501 class=SQLSTATE_42 system=none");
  assert.equal(report.includes(secret), false);
  assert.equal(sanitizedMacDatabaseUpgradeFailureV1(new TypeError(secret), "migrate"),
    "upgrade_error:remote_refused stage=migrate sqlstate=none class=TypeError system=none");
  assert.equal(sanitizedMacDatabaseUpgradeFailureV1(new Error("upgrade_plan_changed_refused " + secret), "plan"),
    "upgrade_error:upgrade_plan_changed_refused stage=plan sqlstate=none class=Error system=none");
  assert.equal(sanitizedMacDatabaseUpgradeFailureV1(Object.assign(new Error(secret), { code: "ENOENT" }), "migrate"),
    "upgrade_error:remote_refused stage=migrate sqlstate=none class=Error system=ENOENT");
  const wrapped = new Error(`migration_failed:0086_example.sql:${secret}`, { cause: error });
  assert.equal(sanitizedMacDatabaseUpgradeFailureV1(wrapped, "migrate"),
    "upgrade_error:migration_failed stage=migrate sqlstate=42501 class=SQLSTATE_42 system=none");
  assert.equal(sanitizedMacDatabaseUpgradeFailureV1(new Error("upgrade_secret_material"), "roles"),
    "upgrade_error:remote_refused stage=roles sqlstate=none class=Error system=none");
});

test("peer migration mode refuses TCP or a different bootstrap connection before DB contact", async () => {
  await assert.rejects(applyMigrations({ bootstrapTarget: "host=127.0.0.1 dbname=control_room user=postgres",
    migrateTarget: "host=127.0.0.1 dbname=control_room user=postgres", migrateViaLocalPeer: true }),
  /migration_peer_target_refused/u);
  await assert.rejects(applyMigrations({ bootstrapTarget: "host=/var/run/postgresql dbname=control_room user=postgres",
    migrateTarget: "host=/tmp/other dbname=control_room user=postgres", migrateViaLocalPeer: true }),
  /migration_peer_target_refused/u);
});

test("grant plan covers the source role files and detects additions and extras exactly", async () => {
  const desired = await readDesiredMacGrantsV1();
  assert.ok(desired.size > 300);
  assert.ok([...desired].some(value => value.includes("control_room_local_result_publisher|table|public.control_harness_runs||INSERT|plain")));
  assert.ok([...desired].some(value => value.includes("control_room_task_coordinator|table|public.control_node_fleet_signals||INSERT|plain")));
  for (const role of ["control_room_private_web", "control_room_task_coordinator",
    "control_room_native_results", "control_room_local_result_publisher", "control_room_fleet_gateway",
    "control_room_fleet_owner_authority"])
    assert.ok(desired.has(`${role}|function|public.is_work_intake_session()||EXECUTE|plain`));
  assert.ok(desired.has("control_room_agent_reviewer|function|public.commit_agent_review(text, jsonb, jsonb, bytea)||EXECUTE|plain"));
  assert.ok(desired.has("control_room_fleet_gateway|function|public.redeem_fleet_enrollment(text, text, text, text, timestamptz)||EXECUTE|plain"));
  // MIG-I's allow-list pair, for the reason the allow-list itself records: a
  // CHECK runs as its writer, so without EXECUTE here every subscribe on the
  // role the constraint constrains fails 42501 instead of 204. Named rather
  // than left implicit so a change to either role shows up in this diff.
  assert.ok(desired.has("control_room_private_web|function|public.owner_push_endpoint_host(text)||EXECUTE|plain"));
  assert.ok(desired.has("control_room_private_web|function|public.owner_push_endpoint_allowed(text)||EXECUTE|plain"));
  assert.ok(desired.has("control_room_fleet_owner_authority|table|public.fleet_result_reviews||INSERT|plain"));
  for (const item of [
    "control_room_private_web|table|public.control_leases||SELECT|plain",
    "control_room_private_web|table|public.control_task_execution_plans||SELECT|plain",
    "control_room_private_web|table|public.control_task_model_selections||SELECT|plain",
    "control_room_private_web|table|public.control_task_model_selections||INSERT|plain",
    "control_room_private_web|table|public.control_task_declared_scopes||SELECT|plain",
    "control_room_private_web|table|public.control_task_declared_scopes||INSERT|plain",
    "control_room_private_web|table|public.control_assignment_lease_scopes||SELECT|plain",
    "control_room_task_coordinator|table|public.control_task_model_selections||SELECT|plain",
    "control_room_task_coordinator|table|public.control_task_model_selections||INSERT|plain",
    "control_room_task_coordinator|table|public.control_task_declared_scopes||SELECT|plain",
    "control_room_task_coordinator|table|public.control_task_declared_scopes||INSERT|plain",
    "control_room_task_coordinator|table|public.control_assignment_lease_scopes||SELECT|plain",
    "control_room_task_coordinator|table|public.control_assignment_lease_scopes||INSERT|plain",
    "control_room_local_result_publisher|table|public.control_task_model_selections||SELECT|plain",
  ]) assert.ok(desired.has(item), `missing stacked grant: ${item}`);
  const missingOne = new Set(desired);
  const item = [...desired][0];
  missingOne.delete(item);
  missingOne.add("control_room_web|table|public.unexpected||DELETE|plain");
  assert.deepEqual(diffMacGrantsV1(missingOne, desired), {
    extra: ["control_room_web|table|public.unexpected||DELETE|plain"], missing: [item],
  });
  assert.throws(() => desiredMacGrantsV1({ fake: "GRANT ALL ON secret TO control_room_web;" }),
    /upgrade_grant_source_refused/u);
  const sources = Object.fromEntries(await Promise.all([
    "private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
    "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
    "agent_reviewer_roles.sql", "fleet_gateway_roles.sql",
  ].map(async file => [file, await readFile(new URL(`../db/roles/${file}`, import.meta.url), "utf8")])));
  sources["private_web_roles.sql"] += "\nGRANT SELECT ON control_leases TO control_room_private_web;\n";
  assert.throws(() => desiredMacGrantsV1(sources), /upgrade_grant_source_duplicate/u);
});

test("grant convergence applies only the pinned function boundaries", async () => {
  const calls = [];
  const client = { query: async sql => { calls.push(sql); } };
  const signature = "public.commit_agent_review(text, jsonb, jsonb, bytea)";
  await applyMacGrantDiffV1(client, {
    extra: [`control_room_private_web|function|${signature}||EXECUTE|grantable`],
    missing: [`control_room_agent_reviewer|function|${signature}||EXECUTE|plain`],
  });
  assert.deepEqual(calls, [
    `REVOKE EXECUTE ON FUNCTION ${signature} FROM control_room_private_web`,
    `GRANT EXECUTE ON FUNCTION ${signature} TO control_room_agent_reviewer`,
  ]);
  await applyMacGrantDiffV1(client, { extra: [],
    missing: ["control_room_private_web|function|public.is_work_intake_session()||EXECUTE|plain"] });
  assert.equal(calls.at(-1),
    "GRANT EXECUTE ON FUNCTION public.is_work_intake_session() TO control_room_private_web");
  await applyMacGrantDiffV1(client, { extra: [],
    missing: ["control_room_fleet_gateway|function|public.redeem_fleet_enrollment(text, text, text, text, timestamptz)||EXECUTE|plain"] });
  assert.equal(calls.at(-1), "GRANT EXECUTE ON FUNCTION public.redeem_fleet_enrollment(text, text, text, text, timestamptz) TO control_room_fleet_gateway");
  await assert.rejects(applyMacGrantDiffV1(client, { extra: [],
    missing: ["control_room_queue_worker|function|public.is_work_intake_session()||EXECUTE|plain"] }),
  /upgrade_unexpected_function_grant/u);
  await assert.rejects(applyMacGrantDiffV1(client, {
    extra: ["control_room_private_web|function|public.other_function(text)||EXECUTE|plain"], missing: [],
  }), /upgrade_unexpected_function_grant/u);
  // MIG-I's pair converges to exactly one role, and the convergence path is
  // refused for any other. The REFUSAL is the part that matters: a blanket rule
  // would have let a wider role hold EXECUTE on the function a CHECK runs as,
  // which is how a grant meant to make a constraint readable turns into a
  // callable authority. Asserted on the generator, and proved end to end on a
  // live cluster in the lifecycle lane.
  await applyMacGrantDiffV1(client, { extra: [],
    missing: ["control_room_private_web|function|public.owner_push_endpoint_allowed(text)||EXECUTE|plain"] });
  assert.equal(calls.at(-1),
    "GRANT EXECUTE ON FUNCTION public.owner_push_endpoint_allowed(text) TO control_room_private_web");
  for (const role of ["control_room_agent_reviewer", "control_room_fleet_gateway", "control_room_queue_worker"])
    await assert.rejects(applyMacGrantDiffV1(client, { extra: [],
      missing: [`${role}|function|public.owner_push_endpoint_allowed(text)||EXECUTE|plain`] }),
    /upgrade_unexpected_function_grant/u,
    `${role} must not be granted EXECUTE on the push-endpoint allow list`);
  // A revoke of a role's grant is always allowed: convergence has to be able to
  // take a privilege back, or a once-widened grant could never be undone.
  await applyMacGrantDiffV1(client, { extra: [
    "control_room_agent_reviewer|function|public.owner_push_endpoint_allowed(text)||EXECUTE|grantable"], missing: [] });
  assert.equal(calls.at(-1),
    "REVOKE EXECUTE ON FUNCTION public.owner_push_endpoint_allowed(text) FROM control_room_agent_reviewer");
  // The catalog must spell argument types the way db/roles/*.sql spells them
  // (pg_type.typname, e.g. timestamptz). oidvectortypes() expands to the
  // SQL-standard form (timestamp with time zone), which can never equal the
  // spelling in the role files, so such a grant would never converge. The
  // zero-argument form must still render as `()` rather than a NULL.
  // The comment above names the function this replaced, so assert against the
  // query with its own `--` comments stripped out.
  const catalogQuery = macGrantCatalogSqlV1.replace(/--[^\n]*/gu, " ");
  assert.match(catalogQuery, /pg_type t ON t\.oid = u\.oid/u,
    "catalog signatures use the compact type name the role files spell");
  assert.match(catalogQuery, /string_agg\(\s*pg_catalog\.quote_ident\(t\.typname\), ', ' ORDER BY u\.ord\)/u,
    "argument types keep their declared order and quoting");
  assert.match(catalogQuery, /COALESCE\(\(SELECT string_agg/u,
    "a zero-argument function still renders an empty argument list");
  assert.doesNotMatch(catalogQuery, /oidvectortypes/u,
    "oidvectortypes expands type aliases and would never match the role files");
  assert.doesNotMatch(macGrantCatalogSqlV1, /pg_get_function_identity_arguments/u);
});

test("a database already at main plans exactly the migrations this branch adds beyond main", async () => {
  // main's tip is still the owner-approval migration (merged as part of S2): main's
  // applied ledger is this ledger truncated right after that entry, numbered in
  // filename order exactly as main's generator numbered it. Everything after it in
  // ledger order is what this branch adds beyond main, and a database already at main
  // must plan exactly that set, in ledger order, and nothing else.
  const ledger = JSON.parse(await readFile("deploy/postgres/migration-ledger.json", "utf8"));
  const migrations = ledger.entries.filter(entry => entry.kind === "migrate");
  const mainTip = migrations.filter(entry => entry.file.endsWith("_work_batch_owner_approval.sql"));
  assert.equal(mainTip.length, 1);
  const mainTipIndex = migrations.indexOf(mainTip[0]);
  const onMain = migrations.slice(0, mainTipIndex + 1);
  const beyondMain = migrations.slice(mainTipIndex + 1);
  assert.ok(beyondMain.length > 0);
  const applied = onMain.map((entry, index) =>
    ({ filename: entry.file, digest: `sha256:${entry.sha256}`, ledger_order: index + 1 }));
  assert.deepEqual(applied.at(-1), { filename: mainTip[0].file,
    digest: applied.at(-1).digest, ledger_order: onMain.length });
  const { databaseRoleManifestV1: manifest, databaseRoleNamesV1 } =
    await import("../scripts/mac-local/database-role-manifest.mjs");
  const roles = databaseRoleNamesV1.map(rolname => ({ rolname,
    rolcanlogin: Object.hasOwn(manifest.logins, rolname), rolinherit: true, rolsuper: false, rolcreatedb: false,
    rolcreaterole: false, rolreplication: false, rolbypassrls: false }));
  const memberships = Object.entries(manifest.logins).map(([member, { group: parent }]) =>
    ({ member, parent, admin_option: false, inherit_option: true, set_option: true }));
  const plan = await planMacDatabaseUpgradeSnapshotV1({ applied, roles, memberships, defaultAcl: 0, grants: [],
    queue: { schemaExists: true, verified: true } });
  assert.deepEqual(plan.pendingMigrations, beyondMain.map(entry => entry.file));
  for (const entry of beyondMain) assert.ok(entry.order > mainTip[0].order);
});

test("offline plan rejects a mismatched main commit and malformed snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "snapshot.json"), commit = "a".repeat(40);
  await writeFile(path, JSON.stringify(captureMacUpgradeSnapshotV1(commit, "{}\n")));
  await assert.rejects(planMacDatabaseUpgradeFromFileV1(path, "b".repeat(40)), /upgrade_snapshot_commit_refused/u);
  await assert.rejects(planMacDatabaseUpgradeFromFileV1(path, commit), /upgrade_snapshot_content_refused/u);
});

/** Builds a protected root with only the four always-present Mac logins
 * configured (no publisher, no work-intake-server.json): the shape of an
 * install made before either new login existed. Returns the paths and
 * pre-upgrade file contents so a test can assert nothing unrelated changed. */
async function baseUpgradeFixture(root) {
  const config = join(root, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const roleNames = { web: "control_room_web", coordinator: "control_room_coordinator",
    results: "control_room_results", queueWorker: "control_room_queue_worker" };
  const values = Object.fromEntries(Object.values(roleNames).map((name, index) => [name, `${"p".repeat(40)}${index}`]));
  values.control_room_migrator = "m".repeat(41);
  for (const [name, value] of Object.entries(values))
    await writeFile(join(passwords, `${name}.txt`), `${value}\n`, { mode: 0o600 });
  const web = { host: "127.0.0.1", port: 15432, database: "control_room", username: roleNames.web,
    password: values[roleNames.web], majorVersion: 17 };
  const role = key => ({ ...web, username: roleNames[key], password: values[roleNames[key]] });
  const oldRoles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web, coordinator: role("coordinator"),
    results: role("results"), queueWorker: role("queueWorker") };
  const mac = captureProvisionedMacLocalConfigurationV1({ database: web, ownerCode: "owner-code",
    workers: [
      { workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" },
      { workerId: "worker:claude:mac-1", kind: "claude-code", executablePath: "/opt/claude", recordedVersion: "claude 1.2.3" },
      { workerId: "worker:hermes:mac-1", kind: "hermes", executablePath: "/opt/hermes", recordedVersion: "hermes 1.2.3" },
    ] });
  const macFile = join(config, "mac-local.json"), roleFile = join(config, "database-roles.json");
  await writeFile(macFile, JSON.stringify(mac), { mode: 0o600 });
  await writeFile(roleFile, JSON.stringify(oldRoles), { mode: 0o600 });
  return { config, passwords, roleNames, oldRoles, macFile, roleFile,
    macBefore: await readFile(macFile), rolesBefore: await readFile(roleFile) };
}

test("prepare bundles one code for every missing login, and finish adds only the verified ones", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { passwords, roleNames, oldRoles, macFile, roleFile, macBefore, rolesBefore } = await baseUpgradeFixture(root);
  const intakeFile = join(root, "config", "work-intake-server.json");
  const mainCommit = "a".repeat(40), options = { protectedRoot: root, mainCommit };
  await assert.rejects(readFile(join(passwords, "control_room_publisher.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(passwords, "control_room_work_intake_agent.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(passwords, "control_room_fleet.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(passwords, "control_room_fleet_owner.txt")), { code: "ENOENT" });
  const prepared = await prepareMacLocalDatabaseUpgradeV1(options);
  assert.equal(prepared.mainCommit, mainCommit);
  const codes = JSON.parse(prepared.code);
  assert.deepEqual(Object.keys(codes).sort(), newUpgradeLogins);
  for (const verifier of Object.values(codes)) checkedPostgresScramVerifierV1(verifier);
  assert.deepEqual(parseMacDatabaseLoginCodesV1(prepared.code), codes, "the VPS upgrade reads the code as-is");
  assert.deepEqual(await readFile(roleFile), rolesBefore, "prepare writes no role file");
  await assert.rejects(readFile(intakeFile), { code: "ENOENT" }, "prepare writes no work-intake record");
  for (const name of newUpgradeLogins)
    assert.equal((await stat(join(passwords, `${name}.txt`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "config", "database-upgrade-prepare.json"))).mode & 0o777, 0o600);

  const verifiedFor = [];
  await assert.rejects(finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async (_configuration, role) => {
    throw new Error(`${role}_not_live`);
  } }), /control_room_(?:publisher|agent_reviewer_login|work_intake_agent)_not_live/u);
  assert.deepEqual(await readFile(roleFile), rolesBefore, "a failed verification writes nothing");
  await assert.rejects(readFile(intakeFile), { code: "ENOENT" });

  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async (configuration, role) => {
    verifiedFor.push(role);
    assert.equal(configuration.username, role);
    assert.equal(configuration.password, (await readFile(join(passwords, `${role}.txt`), "utf8")).trim());
  } });
  assert.deepEqual(verifiedFor.sort(), newUpgradeLogins);

  const changedRoles = JSON.parse(await readFile(roleFile, "utf8"));
  const validated = captureMacLocalDatabaseRolesV1(changedRoles);
  assert.equal(validated.publisher.username, "control_room_publisher");
  assert.equal(validated.publisher.password, (await readFile(join(passwords, "control_room_publisher.txt"), "utf8")).trim());
  assert.equal(validated.agentReviewer.username, "control_room_agent_reviewer_login");
  assert.equal(validated.agentReviewer.password,
    (await readFile(join(passwords, "control_room_agent_reviewer_login.txt"), "utf8")).trim());
  assert.equal(validated.fleetGateway?.username, "control_room_fleet");
  assert.equal(validated.fleetGateway?.password,
    (await readFile(join(passwords, "control_room_fleet.txt"), "utf8")).trim());
  assert.equal(validated.fleetOwner?.username, "control_room_fleet_owner");
  assert.equal(validated.fleetOwner?.password,
    (await readFile(join(passwords, "control_room_fleet_owner.txt"), "utf8")).trim());
  const { fleetOwner: _fleetOwner, ...unpairedFleet } = changedRoles;
  assert.throws(() => captureMacLocalDatabaseRolesV1(unpairedFleet), /mac_local_database_roles_invalid/u);
  assert.throws(() => captureMacLocalDatabaseRolesV1({ ...changedRoles,
    fleetGateway: { ...changedRoles.fleetGateway, port: changedRoles.fleetGateway.port + 1 } }),
  /mac_local_database_roles_invalid/u);
  for (const [key, name] of Object.entries(roleNames)) assert.deepEqual(changedRoles[key], oldRoles[key], name);
  assert.deepEqual(await readFile(macFile), macBefore);

  const intake = captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  assert.equal(intake.database.username, "control_room_work_intake_agent");
  assert.equal(intake.database.password, (await readFile(join(passwords, "control_room_work_intake_agent.txt"), "utf8")).trim());
  // The host refuses to start unless the intake record's credentials match the
  // Mac's enabled-worker roster exactly: one mapping per worker, no more, no less.
  assert.deepEqual(intake.credentials.map(entry => ({ workerId: entry.workerId, workerKind: entry.workerKind })).sort(
    (a, b) => a.workerId.localeCompare(b.workerId)), [
    { workerId: "worker:claude:mac-1", workerKind: "claude-code" },
    { workerId: "worker:codex:mac-1", workerKind: "codex" },
    { workerId: "worker:hermes:mac-1", workerKind: "hermes" },
  ]);
  assert.equal(new Set(intake.credentials.map(entry => entry.credentialDigest)).size, 3);
  assert.equal((await stat(intakeFile)).mode & 0o777, 0o600);
  const clientRoot = join(root, "config", "work-intake-clients");
  for (const workerId of ["worker:codex:mac-1", "worker:claude:mac-1", "worker:hermes:mac-1"]) {
    const clientPath = join(clientRoot, workIntakeClientFileNameV1(workerId));
    assert.equal((await stat(clientPath)).mode & 0o777, 0o600);
  }

  // Both logins now exist: a repeat prepare/finish is a clean no-op, not a refusal.
  assert.deepEqual(await prepareMacLocalDatabaseUpgradeV1(options), { mainCommit, nothingToPrepare: true });
  let verifiedAgain = 0;
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ ...options,
    verifyLogin: async () => { verifiedAgain += 1; } }), { finished: true, mainCommit, nothingToFinish: true });
  assert.equal(verifiedAgain, 0);
  assert.deepEqual(await readFile(macFile), macBefore);
});

test("concurrent prepare callers converge on one reusable fleet handoff", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await baseUpgradeFixture(root);
  const options = { protectedRoot: root, mainCommit: "f".repeat(40) };
  const [first, second] = await Promise.all([
    prepareMacLocalDatabaseUpgradeV1(options), prepareMacLocalDatabaseUpgradeV1(options),
  ]);
  assert.equal(first.code, second.code, "both callers receive the handoff retained for finish");
  assert.deepEqual(Object.keys(JSON.parse(first.code)).sort(), newUpgradeLogins);
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} });
  assert.deepEqual(await prepareMacLocalDatabaseUpgradeV1(options),
    { mainCommit: options.mainCommit, nothingToPrepare: true });
});

test("finish refuses a code from a different prepare and a tampered code, and writes nothing", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { roleFile, rolesBefore } = await baseUpgradeFixture(root);
  const intakeFile = join(root, "config", "work-intake-server.json");
  const preparedFile = join(root, "config", "database-upgrade-prepare.json");
  const mainCommit = "b".repeat(40), options = { protectedRoot: root, mainCommit,
    verifyLogin: async () => { throw new Error("must not verify a refused code"); } };
  const assertUntouched = async () => {
    assert.deepEqual(await readFile(roleFile), rolesBefore);
    await assert.rejects(readFile(intakeFile), { code: "ENOENT" });
  };

  // No prepare has ever run: there is nothing to finish from.
  await assert.rejects(finishMacLocalDatabaseUpgradeV1(options), /upgrade_prepare_record_refused/u);
  await assertUntouched();

  await prepareMacLocalDatabaseUpgradeV1(options);
  const record = JSON.parse(await readFile(preparedFile, "utf8"));

  // Stale: the record is for a different commit than the one being finished.
  await writeFile(preparedFile, JSON.stringify({ ...record, mainCommit: "c".repeat(40) }), { mode: 0o600 });
  await assert.rejects(finishMacLocalDatabaseUpgradeV1(options), /upgrade_prepare_record_refused/u);
  await assertUntouched();

  // From a different prepare: the record is missing one of the codes this run needs.
  const { control_room_publisher: _publisherEntry, ...partial } = record.logins;
  await writeFile(preparedFile, JSON.stringify({ ...record, logins: partial }), { mode: 0o600 });
  await assert.rejects(finishMacLocalDatabaseUpgradeV1(options), /upgrade_prepare_record_refused/u);
  await assertUntouched();

  // Tampered: the stored verifier digest no longer matches the local password.
  await writeFile(preparedFile, JSON.stringify({ ...record,
    logins: { ...record.logins, control_room_publisher: { ...record.logins.control_room_publisher,
      verifierDigest: "0".repeat(64) } } }), { mode: 0o600 });
  await assert.rejects(finishMacLocalDatabaseUpgradeV1(options), /upgrade_prepare_record_refused/u);
  await assertUntouched();

  // The unmodified record still finishes cleanly.
  await writeFile(preparedFile, JSON.stringify(record), { mode: 0o600 });
  const verifiedRoles = [];
  await finishMacLocalDatabaseUpgradeV1({ protectedRoot: root, mainCommit,
    verifyLogin: async (_configuration, role) => { verifiedRoles.push(role); } });
  assert.deepEqual(verifiedRoles.sort(), newUpgradeLogins);
});

test("SCRAM verifier is deterministic for a fixed salt and rejects malformed material", () => {
  const password = "p".repeat(40), salt = Buffer.alloc(16, 7);
  const first = postgresScramVerifierV1(password, salt);
  assert.equal(first, postgresScramVerifierV1(password, salt));
  assert.equal(checkedPostgresScramVerifierV1(first), first);
  assert.throws(() => checkedPostgresScramVerifierV1("SCRAM-SHA-256$4096:bad$bad:bad"), /upgrade_scram_verifier_refused/u);
});

test("queue fingerprint ignores which UTC days have queue_stats partitions but not their shape", async () => {
  const { normalizeQueueCatalogV1 } = await import("../scripts/mac-local/fixed-queue-schema.mjs");
  const day = date => ({
    relations: [{ relname: "queue_stats" }, { relname: `queue_stats_${date}` }, { relname: `queue_stats_${date}_pkey` }],
    types: [{ typname: `_queue_stats_${date}` }],
    indexes: [{ relname: `queue_stats_${date}_pkey`,
      definition: `CREATE UNIQUE INDEX queue_stats_${date}_pkey ON control_room_queue.queue_stats_${date} USING btree (id, captured_on)` }],
  });
  const merge = (...days) => Object.fromEntries(Object.keys(day("x")).map(section =>
    [section, days.flatMap(value => value[section]).filter((row, index, rows) =>
      rows.findIndex(other => JSON.stringify(other) === JSON.stringify(row)) === index)]));
  const before = normalizeQueueCatalogV1(merge(day("20260927"), day("20260928")));
  assert.deepEqual(normalizeQueueCatalogV1(merge(day("20260928"), day("20260929"))), before);
  assert.deepEqual(normalizeQueueCatalogV1(merge(day("20260928"), day("20260929"), day("20261005"))), before);
  const altered = merge(day("20260928"), day("20260929"));
  altered.indexes.push({ relname: "queue_stats_20260929_rogue",
    definition: "CREATE INDEX queue_stats_20260929_rogue ON control_room_queue.queue_stats_20260929 USING btree (name)" });
  assert.notDeepEqual(normalizeQueueCatalogV1(altered), before);
  assert.equal(normalizeQueueCatalogV1({ namespace: [{ nspname: "control_room_queue" }] }).namespace[0].nspname, "control_room_queue");
});

test("the role manifest names every role the migrations, down files and schema files touch, with no dangerous attribute", async t => {
  const { databaseRoleManifestV1: manifest, databaseRoleAttributesV1, databaseRoleNamesInSqlV1,
    unknownDatabaseRoleNamesV1 } = await import("../scripts/mac-local/database-role-manifest.mjs");
  const logins = Object.keys(manifest.logins), known = new Set([...manifest.groups, ...logins]);
  assert.equal(known.size, manifest.groups.length + logins.length, "a name is either a group or a login");
  for (const [login, { group }] of Object.entries(manifest.logins)) assert.ok(manifest.groups.includes(group), login);
  const named = new Set();
  for (const file of ["production_provision.sql", "production_roles.sql", "production_table_grants.sql",
    "private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
    "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
    "agent_reviewer_roles.sql", "fleet_gateway_roles.sql"]) {
    const text = (await readFile(new URL(`../db/roles/${file}`, import.meta.url), "utf8")).replace(/--[^\n]*/gu, "");
    for (const match of text.matchAll(/\b(?:CREATE ROLE|TO|FROM|IN ROLE)\s+(control_room_[a-z_]+)\b(?!\.)/gu))
      named.add(match[1]);
  }
  for (const match of (await readFile(new URL("../deploy/postgres/apply-migrations.mjs", import.meta.url), "utf8"))
    .matchAll(/CREATE ROLE (control_room_[a-z_]+)/gu)) named.add(match[1]);
  assert.deepEqual([...named].filter(role => !known.has(role)).sort(), []);

  // The migrations and down files are applied to the same database the upgrade
  // repairs, and they name roles in the statements that run against it. Every
  // name in every file has to be one the upgrade itself creates, checks or
  // revokes, or the owner has a live role the tool never reasons about.
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const onDisk = [];
  for (const directory of ["db/migrations", "db/down"])
    for (const name of (await readdir(join(repositoryRoot, directory))).sort())
      if (name.endsWith(".sql")) onDisk.push(`${directory}/${name}`);
  const touched = new Map();
  for (const file of onDisk) {
    for (const [name, forms] of databaseRoleNamesInSqlV1(await readFile(join(repositoryRoot, file), "utf8"))) {
      const existing = touched.get(name);
      if (existing) for (const form of forms) existing.add(form);
      else touched.set(name, new Set(forms));
    }
  }
  // Every file on disk is scanned, not only the ledger's entries, so a migration
  // added without regenerating the ledger is still checked here.
  const ledger = JSON.parse(await readFile(join(repositoryRoot, "deploy/postgres/migration-ledger.json"), "utf8"));
  const ledgerMigrations = new Set(ledger.entries.map(entry => entry.file));
  for (const file of onDisk) {
    const down = file.startsWith("db/down/");
    const up = `db/migrations/${file.slice("db/down/".length)}`;
    assert.ok(down ? ledgerMigrations.has(up) : ledgerMigrations.has(file), `${file} is in the migration ledger`);
  }
  assert.ok(onDisk.length > 100, "the scan sees the whole migration and down set");
  assert.deepEqual([...touched.keys()].filter(role => !known.has(role)).sort(), [], "no role is named outside the manifest");
  // 0206-0208 added the five shared roles to this list, and deliberately: 0206's
  // edit to db/roles/production_table_grants.sql is a REVOKE that takes the
  // blanket grants back off the result-file tables, so the down file has to
  // reverse exactly that by naming the same roles. A down file that dropped them
  // would leave a database whose shared roles still held the blanket grants the
  // up migration removed, which is exactly what a down migration must never do.
  assert.deepEqual([...touched.keys()].sort(),
    ["control_room_agent_reviewer", "control_room_application", "control_room_backup",
      "control_room_fleet_gateway", "control_room_github_broker", "control_room_local_result_publisher",
      "control_room_native_results", "control_room_private_web", "control_room_reader",
      "control_room_schedule_admissions", "control_room_task_coordinator", "control_room_work_intake"],
  "the migrations name these manifest roles and no others");

  // The scanner reads what SQL actually means, so prove it on a temp copy of
  // the tree with a role the manifest has never heard of planted in each
  // statement form a migration can use. A green scan over the real files alone
  // would be just as green over a scanner that never matches anything.
  const planted = "control_room_planted_unknown";
  const copy = await mkdtemp(join(tmpdir(), "mac-db-role-manifest-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(join(repositoryRoot, "db"), join(copy, "db"), { recursive: true });
  const statements = {
    "create": `CREATE ROLE ${planted} NOLOGIN;`,
    "alter": `ALTER ROLE ${planted} NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    "drop": `DROP ROLE ${planted};`,
    "member": `GRANT control_room_reader TO ${planted} IN ROLE control_room_backup;`,
    "admin": `GRANT control_room_backup TO ${planted} WITH ADMIN OPTION;`,
    "grant": `GRANT SELECT ON control_nodes TO ${planted};`,
    "revoke": `REVOKE ALL ON control_nodes FROM ${planted};`,
    "owner": `ALTER VIEW control_nodes OWNER TO ${planted};`,
    "owned": `DROP OWNED BY ${planted} CASCADE;`,
    "session": `SET ROLE ${planted};`,
    "grantor": `GRANT SELECT ON control_nodes TO control_room_reader GRANTED BY ${planted};`,
    "catalog": `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${planted}') THEN END IF;`,
  };
  const probe = join(copy, "db/migrations/0110_planted_probe.sql"), probeDown = join(copy, "db/down/0110_planted_probe.sql");
  for (const [form, statement] of Object.entries(statements)) {
    await writeFile(probe, statement);
    await writeFile(probeDown, statement);
    assert.deepEqual(unknownDatabaseRoleNamesV1([await readFile(probe, "utf8")]), [planted],
      `a ${form} statement in a migration names a role outside the manifest`);
    assert.deepEqual(unknownDatabaseRoleNamesV1([await readFile(probeDown, "utf8")]), [planted],
      `a ${form} statement in a down file names a role outside the manifest`);
    // A commented-out statement is not a role the database ever sees and must
    // not fail the manifest.
    assert.deepEqual(unknownDatabaseRoleNamesV1([`-- ${statement}\n/* ${statement} */\n`]), [],
      `a commented-out ${form} statement is not a live role`);
  }
  // The planted copy fails the same check the real files pass, in both places.
  const copyFiles = [];
  for (const directory of ["db/migrations", "db/down"])
    for (const name of (await readdir(join(copy, directory))).sort())
      if (name.endsWith(".sql")) copyFiles.push(join(copy, directory, name));
  assert.deepEqual([...unknownDatabaseRoleNamesV1(await Promise.all(
    copyFiles.map(file => readFile(file, "utf8"))))], [planted],
  "the whole copied tree, with the probe still in it, fails the manifest check");

  assert.deepEqual(unknownDatabaseRoleNamesV1(["GRANT SELECT ON control_nodes TO PUBLIC;\n"
    + "ALTER TABLE control_nodes OWNER TO CURRENT_USER;\n"
    + "REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC;\n"
    + "REVOKE TEMPORARY ON DATABASE control_room FROM PUBLIC;\n"
    + "GRANT control_room_backup TO control_room_web;\n"
    + "EXECUTE format('REVOKE SELECT ON control_nodes FROM %I', 'control_room_private_web');\n"
    + "GRANT SELECT ON control_nodes TO \"control_room_reader\";"]), [], "pseudo-roles are not manifest roles");
  assert.deepEqual(unknownDatabaseRoleNamesV1(["GRANT SELECT ON control_nodes TO control_room_private_web;\n"
    + "REVOKE ALL ON control_nodes FROM control_room_work_intake;\n"
    + "CREATE ROLE control_room_backup NOLOGIN;\n"]), [], "every known role still passes");
  assert.deepEqual(unknownDatabaseRoleNamesV1([
    `GRANT SELECT ON control_nodes TO ${planted}, control_room_private_web;`,
    `REVOKE ALL ON control_nodes FROM control_room_work_intake, ${planted};`,
  ]), [planted], "one unknown name in a list fails, and the known ones do not");

  for (const role of known) {
    const attributes = databaseRoleAttributesV1(role);
    assert.match(attributes, /^(?:NO)?LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS$/u);
    assert.equal(attributes.startsWith("LOGIN"), Object.hasOwn(manifest.logins, role));
  }
  assert.throws(() => databaseRoleAttributesV1("control_room_unlisted"), /upgrade_role_catalog_refused/u);
  assert.deepEqual(logins.filter(login => manifest.logins[login].newLogin).sort(),
    newUpgradeLogins);
  assert.deepEqual(manifest.logins.control_room_agent_reviewer_login,
    { group: "control_room_agent_reviewer", newLogin: true, legacyGroup: null, mac: true });
  assert.equal(databaseRoleAttributesV1("control_room_agent_reviewer"),
    "NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  assert.deepEqual(manifest.logins.control_room_fleet,
    { group: "control_room_fleet_gateway", newLogin: true, legacyGroup: null, mac: true });
  assert.deepEqual(manifest.logins.control_room_fleet_owner,
    { group: "control_room_fleet_owner_authority", newLogin: true, legacyGroup: null, mac: true });
});

test("a missing login code is refused in plain words that name only manifest logins", async () => {
  const { plainMacDatabaseUpgradeRefusalV1 } = await import("../scripts/mac-local/database-upgrade-remote.mjs");
  const error = new Error("upgrade_new_login_needs_verifier:control_room_publisher,control_room_work_intake_agent");
  assert.equal(sanitizedMacDatabaseUpgradeFailureV1(error, "plan"),
    "upgrade_error:upgrade_new_login_needs_verifier stage=plan sqlstate=none class=Error system=none");
  assert.equal(plainMacDatabaseUpgradeRefusalV1(error), "Refused: this upgrade adds the new database login "
    + "control_room_publisher and control_room_work_intake_agent, and each needs its login code from the Mac. "
    + "Nothing was changed. Run the upgrade again with the code on standard input.");
  assert.equal(plainMacDatabaseUpgradeRefusalV1(new Error("upgrade_new_login_needs_verifier:postgres")), undefined);
  assert.equal(plainMacDatabaseUpgradeRefusalV1(new Error("upgrade_plan_changed_refused")), undefined);
});

test("login codes are optional and only manifest logins may receive one", async () => {
  const { parseMacDatabaseLoginCodesV1 } = await import("../scripts/mac-local/database-upgrade-remote.mjs");
  const publisher = postgresScramVerifierV1("p".repeat(40)), intake = postgresScramVerifierV1("i".repeat(40));
  assert.deepEqual(parseMacDatabaseLoginCodesV1(""), {});
  assert.deepEqual(parseMacDatabaseLoginCodesV1(undefined), {});
  assert.deepEqual(parseMacDatabaseLoginCodesV1(`${publisher}\n`), { control_room_publisher: publisher });
  assert.deepEqual(parseMacDatabaseLoginCodesV1(JSON.stringify({ control_room_work_intake_agent: intake })),
    { control_room_work_intake_agent: intake });
  for (const refused of [{ control_room_app: publisher }, { postgres: publisher },
    { control_room_publisher: "SCRAM-SHA-256$4096:bad$bad:bad" }, [publisher]])
    assert.throws(() => parseMacDatabaseLoginCodesV1(JSON.stringify(refused)),
      /upgrade_(?:verifier_input|scram_verifier)_refused/u);
});

test("prepare and finish can run again once every login already exists, without making a new code", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-again-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const names = { web: "control_room_web", coordinator: "control_room_coordinator", results: "control_room_results",
    queueWorker: "control_room_queue_worker", publisher: "control_room_publisher",
    agentReviewer: "control_room_agent_reviewer_login", fleetGateway: "control_room_fleet",
    fleetOwner: "control_room_fleet_owner" };
  const base = { host: "127.0.0.1", port: 15432, database: "control_room", majorVersion: 17 };
  const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1 };
  for (const [key, username] of Object.entries(names)) {
    roles[key] = { ...base, username, password: `${key}`.padEnd(41, "k") };
    await writeFile(join(passwords, `${username}.txt`), `${roles[key].password}\n`, { mode: 0o600 });
  }
  await writeFile(join(config, "mac-local.json"), JSON.stringify(captureProvisionedMacLocalConfigurationV1({
    database: roles.web, ownerCode: "owner-code", workers: [
      { workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" },
    ] })), { mode: 0o600 });
  const roleFile = join(config, "database-roles.json");
  await writeFile(roleFile, JSON.stringify(roles), { mode: 0o600 });
  const intakeUsername = "control_room_work_intake_agent", intakePassword = "workintake".padEnd(41, "k");
  await writeFile(join(passwords, `${intakeUsername}.txt`), `${intakePassword}\n`, { mode: 0o600 });
  const intakeFile = join(config, "work-intake-server.json");
  await writeFile(intakeFile, JSON.stringify(prepareProvisionedWorkIntakeConfigurationV1({
    database: { ...base, username: intakeUsername, password: intakePassword },
    integrityKey: "k".repeat(43), credentials: [] })), { mode: 0o600 });
  const before = await readFile(roleFile), intakeBefore = await readFile(intakeFile);
  const options = { protectedRoot: root, mainCommit: "d".repeat(40) };
  const prepared = await prepareMacLocalDatabaseUpgradeV1(options);
  assert.deepEqual(prepared, { mainCommit: options.mainCommit, nothingToPrepare: true });
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ ...options,
    verifyLogin: async () => { throw new Error("nothing new to verify"); } }),
  { finished: true, mainCommit: options.mainCommit, nothingToFinish: true });
  await writeFile(join(config, "database-upgrade-prepare.json"), JSON.stringify({
    schema: "control-room.mac-database-upgrade-prepare/v2", mainCommit: "e".repeat(40),
    logins: { control_room_publisher: { salt: Buffer.alloc(16, 1).toString("base64"), verifierDigest: "f".repeat(64) },
      control_room_work_intake_agent: { salt: Buffer.alloc(16, 1).toString("base64"), verifierDigest: "f".repeat(64) } } }),
  { mode: 0o600 });
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ ...options,
    verifyLogin: async () => { throw new Error("nothing new to verify"); } }),
  { finished: true, mainCommit: options.mainCommit, nothingToFinish: true }, "the first upgrade's record is not redone");
  assert.deepEqual(await readFile(roleFile), before);
  assert.deepEqual(await readFile(intakeFile), intakeBefore);
});

test("a finished upgrade leaves the Mac host startable: the real roster check accepts the intake record", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-host-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await baseUpgradeFixture(root);
  const options = { protectedRoot: root, mainCommit: "a".repeat(40) };
  await prepareMacLocalDatabaseUpgradeV1(options);
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} });

  // The real config loader and the real roster check run unmodified; only the
  // effectful release modules (host composition, postgres, serving, renderer,
  // intake service) are stubbed so no listener or database actually opens.
  await startWebHostOnRoster(t, root);
});

test("repoint updates the intake record's endpoint too, so a later upgrade converges instead of refusing", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-repoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const names = { web: "control_room_web", coordinator: "control_room_coordinator", results: "control_room_results",
    publisher: "control_room_publisher", agentReviewer: "control_room_agent_reviewer_login",
    queueWorker: "control_room_queue_worker" };
  const values = Object.fromEntries(Object.values(names).map((name, index) => [name, `${"r".repeat(40)}${index}`]));
  for (const [name, value] of Object.entries(values))
    await writeFile(join(passwords, `${name}.txt`), `${value}\n`, { mode: 0o600 });
  const web = { host: "127.0.0.1", port: 15432, database: "control_room", username: names.web,
    password: values[names.web], majorVersion: 17 };
  const role = key => ({ ...web, username: names[key], password: values[names[key]] });
  const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web, coordinator: role("coordinator"),
    results: role("results"), publisher: role("publisher"), agentReviewer: role("agentReviewer"),
    queueWorker: role("queueWorker") };
  const mac = captureProvisionedMacLocalConfigurationV1({ database: web, ownerCode: "owner-code",
    workers: [{ workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" }] });
  const macFile = join(config, "mac-local.json"), roleFile = join(config, "database-roles.json");
  await writeFile(macFile, JSON.stringify(mac), { mode: 0o600 });
  await writeFile(roleFile, JSON.stringify(roles), { mode: 0o600 });

  const options = { protectedRoot: root, mainCommit: "b".repeat(40) };
  const prepared = await prepareMacLocalDatabaseUpgradeV1(options);
  assert.deepEqual(Object.keys(JSON.parse(prepared.code)), ["control_room_work_intake_agent",
    "control_room_fleet", "control_room_fleet_owner"]);
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} });
  assert.deepEqual(await prepareMacLocalDatabaseUpgradeV1(options), { mainCommit: options.mainCommit, nothingToPrepare: true });

  const intakeFile = join(config, "work-intake-server.json");
  const intakeBeforeRepoint = captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  assert.equal(intakeBeforeRepoint.database.host, "127.0.0.1");

  const status = { Self: { Tags: ["tag:general", "tag:control-room-client"] }, Peer: { server: {
    Online: true, Tags: ["tag:control-room-vps"], TailscaleIPs: ["100.100.9.9"], DNSName: "repointed.example.invalid." } } };
  const route = macLocalRouteFromTailscaleStatusV1(status,
    "## VPS evidence (synthetic)\n\nTLS, SCRAM and loopback checks passed.\n\n## Live acceptance\n");
  assert.deepEqual(await provisionMacLocalDatabaseV1({ repointOnly: true, protectedRoot: root, route }), { repointed: true });

  const intakeAfterRepoint = captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  assert.equal(intakeAfterRepoint.database.host, "100.100.9.9");
  assert.equal(intakeAfterRepoint.database.password, intakeBeforeRepoint.database.password);
  assert.deepEqual(intakeAfterRepoint.credentials, intakeBeforeRepoint.credentials);
  const rolesAfterRepoint = captureMacLocalDatabaseRolesV1(JSON.parse(await readFile(roleFile, "utf8")));
  assert.equal(rolesAfterRepoint.fleetGateway?.host, "100.100.9.9");
  assert.equal(rolesAfterRepoint.fleetOwner?.host, "100.100.9.9");

  // Before the fix, repoint left work-intake-server.json pointed at the old
  // endpoint and every later upgrade refused with upgrade_role_config_refused.
  assert.deepEqual(await prepareMacLocalDatabaseUpgradeV1(options), { mainCommit: options.mainCommit, nothingToPrepare: true });
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ ...options,
    verifyLogin: async () => { throw new Error("nothing new to verify"); } }),
  { finished: true, mainCommit: options.mainCommit, nothingToFinish: true });
});

test("an existing intake record with the wrong password or a stale endpoint refuses both prepare and finish", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-intake-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const names = { web: "control_room_web", coordinator: "control_room_coordinator", results: "control_room_results",
    publisher: "control_room_publisher", agentReviewer: "control_room_agent_reviewer_login",
    queueWorker: "control_room_queue_worker", fleetGateway: "control_room_fleet",
    fleetOwner: "control_room_fleet_owner" };
  const base = { host: "127.0.0.1", port: 15432, database: "control_room", majorVersion: 17 };
  const values = Object.fromEntries(Object.values(names).map((name, index) => [name, `${"g".repeat(40)}${index}`]));
  for (const [name, value] of Object.entries(values))
    await writeFile(join(passwords, `${name}.txt`), `${value}\n`, { mode: 0o600 });
  const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, ...Object.fromEntries(Object.entries(names).map(
    ([key, name]) => [key, { ...base, username: name, password: values[name] }])) };
  const mac = captureProvisionedMacLocalConfigurationV1({ database: roles.web, ownerCode: "owner-code",
    workers: [{ workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" }] });
  await writeFile(join(config, "mac-local.json"), JSON.stringify(mac), { mode: 0o600 });
  await writeFile(join(config, "database-roles.json"), JSON.stringify(roles), { mode: 0o600 });
  const intakeUsername = "control_room_work_intake_agent", intakePassword = "i".repeat(41);
  await writeFile(join(passwords, `${intakeUsername}.txt`), `${intakePassword}\n`, { mode: 0o600 });
  const intakeFile = join(config, "work-intake-server.json");
  const validIntake = prepareProvisionedWorkIntakeConfigurationV1({
    database: { ...base, username: intakeUsername, password: intakePassword },
    integrityKey: "k".repeat(43), credentials: [] });
  const options = { protectedRoot: root, mainCommit: "c".repeat(40) };
  const refusal = /upgrade_role_config_refused/u;

  await writeFile(intakeFile, JSON.stringify({ ...validIntake,
    database: { ...validIntake.database, password: "w".repeat(40) } }), { mode: 0o600 });
  await assert.rejects(prepareMacLocalDatabaseUpgradeV1(options), refusal);
  await assert.rejects(finishMacLocalDatabaseUpgradeV1(options), refusal);

  await writeFile(intakeFile, JSON.stringify({ ...validIntake,
    database: { ...validIntake.database, port: 15433 } }), { mode: 0o600 });
  await assert.rejects(prepareMacLocalDatabaseUpgradeV1(options), refusal);
  await assert.rejects(finishMacLocalDatabaseUpgradeV1(options), refusal);

  await writeFile(intakeFile, JSON.stringify(validIntake), { mode: 0o600 });
  assert.deepEqual(await prepareMacLocalDatabaseUpgradeV1(options),
    { mainCommit: options.mainCommit, nothingToPrepare: true });
});

test("an installation that already has the publisher and intake login gets a code for the reviewer login only", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-reviewer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const names = { web: "control_room_web", coordinator: "control_room_coordinator", results: "control_room_results",
    queueWorker: "control_room_queue_worker", publisher: "control_room_publisher",
    fleetGateway: "control_room_fleet", fleetOwner: "control_room_fleet_owner" };
  const base = { host: "127.0.0.1", port: 15432, database: "control_room", majorVersion: 17 };
  const roles = { schema: MAC_LOCAL_DATABASE_ROLES_V1 };
  for (const [key, username] of Object.entries(names)) {
    roles[key] = { ...base, username, password: `${key}`.padEnd(41, "k") };
    await writeFile(join(passwords, `${username}.txt`), `${roles[key].password}\n`, { mode: 0o600 });
  }
  await writeFile(join(config, "mac-local.json"), JSON.stringify(captureProvisionedMacLocalConfigurationV1({
    database: roles.web, ownerCode: "owner-code", workers: [
      { workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" },
    ] })), { mode: 0o600 });
  const roleFile = join(config, "database-roles.json");
  await writeFile(roleFile, JSON.stringify(roles), { mode: 0o600 });
  const intakeUsername = "control_room_work_intake_agent", intakePassword = "workintake".padEnd(41, "k");
  await writeFile(join(passwords, `${intakeUsername}.txt`), `${intakePassword}\n`, { mode: 0o600 });
  const intakeFile = join(config, "work-intake-server.json");
  await writeFile(intakeFile, JSON.stringify(prepareProvisionedWorkIntakeConfigurationV1({
    database: { ...base, username: intakeUsername, password: intakePassword },
    integrityKey: "k".repeat(43), credentials: [] })), { mode: 0o600 });
  const intakeBefore = await readFile(intakeFile);
  const options = { protectedRoot: root, mainCommit: "d".repeat(40) };
  const prepared = await prepareMacLocalDatabaseUpgradeV1(options);
  const codes = parseMacDatabaseLoginCodesV1(prepared.code);
  assert.deepEqual(Object.keys(codes), ["control_room_agent_reviewer_login"]);
  const verified = [];
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async (configuration, role) => {
    verified.push(role);
    assert.equal(configuration.username, role);
  } });
  assert.deepEqual(verified, ["control_room_agent_reviewer_login"], "existing logins are not re-verified or changed");
  const changed = captureMacLocalDatabaseRolesV1(JSON.parse(await readFile(roleFile, "utf8")));
  assert.deepEqual(changed.publisher, roles.publisher);
  assert.equal(changed.agentReviewer.password,
    (await readFile(join(passwords, "control_room_agent_reviewer_login.txt"), "utf8")).trim());
  assert.deepEqual(await readFile(intakeFile), intakeBefore);
  assert.deepEqual(await prepareMacLocalDatabaseUpgradeV1({ ...options, mainCommit: "e".repeat(40) }),
    { mainCommit: "e".repeat(40), nothingToPrepare: true });
});

test("a finish that cannot write the intake record still leaves every client file on disk", async t => {
  // The order the finish must keep: a worker's client file is on disk before
  // the intake record that carries only its digest. `verifyLogin` runs after
  // the installer has read every existing file and before it writes any, so
  // replacing the record with a directory fails the last write of the run and
  // nothing else. The clients are already on disk by then.
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-write-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), clientRoot = join(config, "work-intake-clients");
  const intakeFile = join(config, "work-intake-server.json");
  const workerIds = ["worker:codex:mac-1", "worker:claude:mac-1", "worker:hermes:mac-1"];
  const clientPath = workerId => join(clientRoot, workIntakeClientFileNameV1(workerId));
  const options = { protectedRoot: root, mainCommit: "e".repeat(40) };
  await baseUpgradeFixture(root);
  await prepareMacLocalDatabaseUpgradeV1(options);
  // Sabotage once, on the first login checked: the run then verifies the rest,
  // writes the role record and every client file, and fails on the last write
  // of the run, the rename onto the intake record. The error has to be the
  // rename's own, not the sabotage's, or this proves nothing about the order.
  await assert.rejects(finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async (_configuration, role) => {
    if (role === "control_room_publisher") { await rm(intakeFile, { force: true }); await mkdir(intakeFile); }
  } }), { code: "EISDIR" });
  for (const workerId of workerIds) {
    const client = captureWorkIntakeClientConfigurationV1(JSON.parse(await readFile(clientPath(workerId), "utf8")));
    assert.equal((await stat(clientPath(workerId))).mode & 0o777, 0o600, workerId);
    assert.match(client.bearerSecret, /^[A-Za-z0-9_-]{43}$/u, workerId);
  }

  // The next run owns the repair: with the record gone, the login is missing
  // again, so it is recreated from the client files already on disk.
  await rm(intakeFile, { recursive: true, force: true });
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} });
  const intake = captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  const digests = new Map(intake.credentials.map(entry => [entry.workerId, entry.credentialDigest]));
  assert.deepEqual([...digests.keys()].sort(), [...workerIds].sort());
  for (const workerId of workerIds)
    assert.equal(digests.get(workerId), sha256Digest(JSON.parse(await readFile(clientPath(workerId), "utf8")).bearerSecret),
      `${workerId} signs in with the file the server accepts`);
  await startWebHostOnRoster(t, root);
});

test("a finish killed between the client files and the intake record ends in a good state on the next run", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), clientRoot = join(config, "work-intake-clients");
  const intakeFile = join(config, "work-intake-server.json");
  const workerIds = ["worker:codex:mac-1", "worker:claude:mac-1", "worker:hermes:mac-1"];
  const clientPath = workerId => join(clientRoot, workIntakeClientFileNameV1(workerId));
  const options = { protectedRoot: root, mainCommit: "e".repeat(40) };
  await baseUpgradeFixture(root);
  await prepareMacLocalDatabaseUpgradeV1(options);
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} });

  // The state a kill right after the record landed used to leave behind: the
  // record present, so the intake login reads as finished, and no client file.
  // Before the fix the next finish answered nothingToFinish, wrote nothing,
  // and every worker stayed unable to sign in until someone re-provisioned the
  // whole database.
  const readIntake = async () => captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  for (const workerId of workerIds) await rm(clientPath(workerId), { force: true });
  const stranded = await readIntake();
  const repaired = await finishMacLocalDatabaseUpgradeV1({ ...options,
    verifyLogin: async () => { throw new Error("a repair re-authenticates no login"); } });
  assert.deepEqual(repaired, { finished: true, mainCommit: options.mainCommit, repairedIntakeClients: [...workerIds].sort() });

  const after = await readIntake();
  const digests = new Map(after.credentials.map(entry => [entry.workerId, entry.credentialDigest]));
  assert.deepEqual(after.credentials.map(entry => entry.workerId).sort(), [...workerIds].sort());
  assert.equal(after.database.password, stranded.database.password, "the repair changes no login");
  assert.equal(after.integrityKey, stranded.integrityKey);
  for (const workerId of workerIds) {
    const client = captureWorkIntakeClientConfigurationV1(JSON.parse(await readFile(clientPath(workerId), "utf8")));
    assert.equal((await stat(clientPath(workerId))).mode & 0o777, 0o600);
    assert.equal((await stat(clientRoot)).mode & 0o777, 0o700);
    // The file the worker signs in with is the one the server now accepts.
    assert.equal(digests.get(workerId), sha256Digest(client.bearerSecret), workerId);
  }
  // The real credential verifier the intake service builds from the record
  // accepts each worker's bearer and nothing else.
  const verifier = createMappedWorkIntakeCredentialVerifierV1(after.credentials);
  for (const workerId of workerIds) {
    const client = JSON.parse(await readFile(clientPath(workerId), "utf8"));
    assert.equal((await verifier.verify(client.bearerSecret)).identityId,
      after.credentials.find(entry => entry.workerId === workerId).principal.identityId);
  }
  await assert.rejects(verifier.verify("z".repeat(43)), /work_intake_credential_refused/u);
  await startWebHostOnRoster(t, root);

  // A further run is the ordinary no-op again, and changes nothing.
  const before = await readFile(intakeFile);
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ ...options,
    verifyLogin: async () => { throw new Error("nothing new to verify"); } }),
  { finished: true, mainCommit: options.mainCommit, nothingToFinish: true });
  assert.deepEqual(await readFile(intakeFile), before);
  for (const workerId of workerIds) assert.ok(await readFile(clientPath(workerId), "utf8"), workerId);
});

test("a repair keeps every client that survived, and leaves a record that is not this Mac's alone", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-partial-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config"), clientRoot = join(config, "work-intake-clients");
  const intakeFile = join(config, "work-intake-server.json");
  const options = { protectedRoot: root, mainCommit: "f".repeat(40) };
  await baseUpgradeFixture(root);
  await prepareMacLocalDatabaseUpgradeV1(options);
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} });
  const intakeBefore = captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  const keep = "worker:codex:mac-1", lost = "worker:claude:mac-1";
  const keptSecret = JSON.parse(await readFile(join(clientRoot, workIntakeClientFileNameV1(keep)), "utf8")).bearerSecret;
  await rm(join(clientRoot, workIntakeClientFileNameV1(lost)), { force: true });

  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} });
  assert.equal(JSON.parse(await readFile(join(clientRoot, workIntakeClientFileNameV1(keep)), "utf8")).bearerSecret,
    keptSecret, "a client that survived keeps the exact secret its owner installed");
  const after = captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  assert.equal(after.credentials.find(entry => entry.workerId === keep).credentialDigest,
    intakeBefore.credentials.find(entry => entry.workerId === keep).credentialDigest,
    "the surviving worker's server-side digest is unchanged");
  assert.equal(after.credentials.find(entry => entry.workerId === lost).credentialDigest,
    sha256Digest(JSON.parse(await readFile(join(clientRoot, workIntakeClientFileNameV1(lost)), "utf8")).bearerSecret));
  await startWebHostOnRoster(t, root);

  // A record that names a worker this Mac has not enabled is not one a finish
  // wrote, and the host would refuse to start on it, so the repair leaves it
  // byte for byte: rewriting credentials the owner never asked about would be
  // a worse outcome than the state the owner can already see and fix.
  await rm(join(clientRoot, workIntakeClientFileNameV1(lost)), { force: true });
  const stranger = { workerId: "worker:unknown:mac-1", workerKind: "codex",
    credentialDigest: sha256Digest("q".repeat(43)),
    principal: { ...intakeBefore.credentials[0].principal, identityId: "identity:work-intake:unknown" } };
  const foreign = { ...intakeBefore, credentials: [...intakeBefore.credentials, stranger] };
  await writeFile(intakeFile, JSON.stringify(foreign), { mode: 0o600 });
  const before = await readFile(intakeFile);
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} }),
    { finished: true, mainCommit: options.mainCommit, nothingToFinish: true });
  assert.deepEqual(await readFile(intakeFile), before, "a record outside the roster is never rewritten");
  assert.deepEqual(captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8"))).credentials
    .map(entry => entry.workerId).sort(), ["worker:claude:mac-1", "worker:codex:mac-1", "worker:hermes:mac-1",
    "worker:unknown:mac-1"]);

  // The same holds for a record with no roster at all, which is what the
  // pre-upgrade installer wrote: still a no-op, still nothing written.
  await writeFile(intakeFile, JSON.stringify(prepareProvisionedWorkIntakeConfigurationV1({
    database: intakeBefore.database, integrityKey: "k".repeat(43), credentials: [] })), { mode: 0o600 });
  const empty = await readFile(intakeFile);
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ ...options, verifyLogin: async () => {} }),
    { finished: true, mainCommit: options.mainCommit, nothingToFinish: true });
  assert.deepEqual(await readFile(intakeFile), empty);
});

/** Runs the real host composition over a protected root with every effectful
 * module stubbed, so the roster check the owner hits at start-up is the one
 * under test without a listener or a database. */
async function startWebHostOnRoster(t, protectedRoot) {
  const load = async path => {
    const name = path.split("/").at(-1);
    if (name === "macLocalProtectedLoader.js") return macLocalProtectedLoader;
    if (name === "macLocalHost.js") return { createMacLocalProtectedHostV1() {
      return { async start() { return { isReady: () => true, async close() {} }; } };
    } };
    if (name === "workIntakePrivateService.js") return { async prepareWorkIntakePrivateServiceV1() {
      return { async start() {}, async close() {} };
    } };
    if (name === "privatePostgres.js") return { createPrivatePostgresDatabase() {} };
    if (name === "serving.js") return { async loadPrivateClientAssets() { return {}; } };
    if (name === "index.js") return { default() {} };
    throw new Error(`unexpected ${name}`);
  };
  const active = await startMacLocalWebHost({ protectedRoot }, {
    load, loadHealthProbeKey: async () => Buffer.alloc(32, 8), hostReleaseIdentity: async () => "dev",
  });
  await active.close();
  t.diagnostic("the real roster check accepted the intake record");
}
