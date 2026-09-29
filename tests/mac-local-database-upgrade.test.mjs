import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProvisionedMacLocalConfigurationV1,
  prepareMacLocalDatabaseUpgradeV1, finishMacLocalDatabaseUpgradeV1,
  planMacDatabaseUpgradeFromFileV1 } from "../scripts/mac-local/provision-database.mjs";
import { captureMacUpgradeSnapshotV1 } from "../scripts/mac-local/database-upgrade-snapshot.mjs";
import { checkedPostgresScramVerifierV1, postgresScramVerifierV1 } from
  "../scripts/mac-local/database-upgrade-scram.mjs";
import { applyMacGrantDiffV1, desiredMacGrantsV1, diffMacGrantsV1, macGrantCatalogSqlV1, macRolePlan,
  readDesiredMacGrantsV1 } from
  "../scripts/mac-local/database-upgrade-grants.mjs";
import { MAC_LOCAL_DATABASE_ROLES_V1, captureMacLocalDatabaseRolesV1 } from
  "../src/web/v1/mac-local-database-roles.ts";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { planMacDatabaseUpgradeSnapshotV1, sanitizedMacDatabaseUpgradeFailureV1 } from
  "../scripts/mac-local/database-upgrade-remote.mjs";

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
    "control_room_native_results", "control_room_local_result_publisher"])
    assert.ok(desired.has(`${role}|function|public.is_work_intake_session()||EXECUTE|plain`));
  assert.ok(desired.has("control_room_agent_reviewer|function|public.commit_agent_review(text, jsonb, jsonb, bytea)||EXECUTE|plain"));
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
    "agent_reviewer_roles.sql",
  ].map(async file => [file, await readFile(new URL(`../db/roles/${file}`, import.meta.url), "utf8")])));
  sources["private_web_roles.sql"] += "\nGRANT SELECT ON control_leases TO control_room_private_web;\n";
  assert.throws(() => desiredMacGrantsV1(sources), /upgrade_grant_source_duplicate/u);
});

test("grant convergence admits only the pinned intake identity function boundary", async () => {
  const calls = [];
  const client = { query: async sql => { calls.push(sql); } };
  await applyMacGrantDiffV1(client, { extra: [],
    missing: ["control_room_private_web|function|public.is_work_intake_session()||EXECUTE|plain"] });
  assert.deepEqual(calls,
    ["GRANT EXECUTE ON FUNCTION public.is_work_intake_session() TO control_room_private_web"]);
  await assert.rejects(applyMacGrantDiffV1(client, { extra: [],
    missing: ["control_room_queue_worker|function|public.is_work_intake_session()||EXECUTE|plain"] }),
  /upgrade_unexpected_function_grant/u);
  await assert.rejects(applyMacGrantDiffV1(client, { extra: [],
    missing: ["control_room_private_web|function|public.other_function()||EXECUTE|plain"] }),
  /upgrade_unexpected_function_grant/u);
});

test("grant convergence applies only the pinned agent-review function boundary", async () => {
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
  await assert.rejects(applyMacGrantDiffV1(client, {
    extra: ["control_room_private_web|function|public.other_function(text)||EXECUTE|plain"], missing: [],
  }), /upgrade_unexpected_function_grant/u);
  assert.match(macGrantCatalogSqlV1, /oidvectortypes\(p\.proargtypes\)/u,
    "catalog signatures use identity types without declared argument names");
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
  const roles = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)].map(rolname => ({ rolname,
    rolcanlogin: Object.hasOwn(macRolePlan, rolname), rolinherit: true, rolsuper: false, rolcreatedb: false,
    rolcreaterole: false, rolreplication: false, rolbypassrls: false }));
  const memberships = Object.entries(macRolePlan).map(([member, parent]) =>
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

test("prepare and finish preserve old passwords and owner config; only verified restricted logins are added", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const macBefore = await readFile(macFile);
  const rolesBefore = await readFile(roleFile);
  const mainCommit = "a".repeat(40), options = { protectedRoot: root, mainCommit };
  await assert.rejects(readFile(join(passwords, "control_room_publisher.txt")), { code: "ENOENT" });
  const prepared = await prepareMacLocalDatabaseUpgradeV1(options);
  assert.equal(prepared.mainCommit, mainCommit);
  const verifiers = JSON.parse(prepared.verifier);
  checkedPostgresScramVerifierV1(verifiers.publisher);
  checkedPostgresScramVerifierV1(verifiers.agentReviewer);
  assert.deepEqual(await readFile(roleFile), rolesBefore);
  let verified = 0;
  await assert.rejects(finishMacLocalDatabaseUpgradeV1({ ...options, verifyPublisher: async () => {
    throw new Error("publisher_not_live");
  } }), /publisher_not_live/u);
  assert.deepEqual(await readFile(roleFile), rolesBefore);
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyPublisher: async publisher => {
    verified += 1;
    assert.equal(publisher.username, "control_room_publisher");
    assert.equal(publisher.password, (await readFile(join(passwords, "control_room_publisher.txt"), "utf8")).trim());
  }, verifyAgentReviewer: async reviewer => {
    assert.equal(reviewer.username, "control_room_agent_reviewer_login");
    assert.equal(reviewer.password, (await readFile(join(passwords, "control_room_agent_reviewer_login.txt"), "utf8")).trim());
  } });
  const changed = JSON.parse(await readFile(roleFile, "utf8"));
  const validated = captureMacLocalDatabaseRolesV1(changed);
  assert.equal(validated.publisher.username, "control_room_publisher");
  assert.equal(validated.publisher.password, (await readFile(join(passwords, "control_room_publisher.txt"), "utf8")).trim());
  assert.equal(validated.agentReviewer.username, "control_room_agent_reviewer_login");
  assert.equal((await stat(join(passwords, "control_room_publisher.txt"))).mode & 0o077, 0);
  for (const [key, name] of Object.entries(roleNames)) assert.deepEqual(changed[key], oldRoles[key], name);
  assert.deepEqual(await readFile(macFile), macBefore);
  await finishMacLocalDatabaseUpgradeV1({ ...options, verifyPublisher: async () => { verified += 1; },
    verifyAgentReviewer: async () => {} });
  assert.equal(verified, 2);
  assert.deepEqual(await readFile(macFile), macBefore);
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
