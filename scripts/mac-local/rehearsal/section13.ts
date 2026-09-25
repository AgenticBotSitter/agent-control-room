// Full first-owner / completion-gate rehearsal against only the exact local
// PG17 cluster made by `pnpm mac:rehearsal up`. Do not point this at a VPS.
// Usage: node --import tsx scripts/mac-local/rehearsal/section13.ts ABSOLUTE_REHEARSAL_DIR
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "pg";
import { connectTarget } from "../../../deploy/postgres/evidence.mjs";
import { sha256Digest } from "../../../src/security/canonical-digest";
import { applyMacLocalFirstOwnerV1 } from "../first-owner-vps.mjs";
import { loadMacLocalTaskRuntimeFromRootV1 } from "../../../src/web/v1/mac-local-task-runtime";
import { openMacLocalRollbackCheckpointStoreV1 } from "../../../src/web/v1/mac-local-rollback-checkpoint-store";
import { CompletionGateStoreV1 } from "../../../src/completion-gate/v1/store";
import { createMacLocalOwnerReviewProfileV1 } from "../../../src/web/v1/mac-local-owner-review-profile";
import { createPrivatePostgresDatabase } from "../../../src/web/v1/private-postgres";
import { serviceInstalled } from "../service.mjs";

const [arg] = process.argv.slice(2);
if (!arg || process.argv.length !== 3 || !isAbsolute(arg) || resolve(arg) !== arg) {
  process.stderr.write("usage: node --import tsx scripts/mac-local/rehearsal/section13.ts ABSOLUTE_REHEARSAL_DIR\n");
  process.exit(2);
}
const root = resolve(arg), protectedRoot = join(root, "protected");
let verifiedThisRehearsalCluster = false;
let stackMayBeUp = false;
async function main() {
const config = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
const roleMap = JSON.parse(await readFile(join(protectedRoot, "config/database-roles.json"), "utf8"));
const manifestPath = join(protectedRoot, "config/first-owner-manifest.json");
const receiptPath = join(protectedRoot, "config/first-owner-receipt.json");
if (config?.database?.host !== "127.0.0.1" || config.database.database !== "control_room"
  || config.database.majorVersion !== 17 || !Number.isInteger(config.database.port)
  || roleMap?.coordinator?.host !== "127.0.0.1" || roleMap.coordinator.port !== config.database.port
  || roleMap.coordinator.database !== "control_room") throw new Error("rehearsal_database_scope_refused");
if (await serviceInstalled()) throw new Error("rehearsal_refused_existing_launchd_service");

// Replace only the disposable protected root's worker locations with harmless
// version-reporting fixtures. No worker task is submitted or executable agent
// protocol is launched by this rehearsal.
const fakeDirectory = join(protectedRoot, "fake-workers");
await mkdir(fakeDirectory, { mode: 0o700 });
await chmod(fakeDirectory, 0o700);
for (const worker of config.enablement.workers) {
  const name = worker.kind === "claude-code" ? "claude" : worker.kind;
  const executable = join(fakeDirectory, name);
  const version = `${name} 1.0.0`;
  await writeFile(executable, `#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf '%s\\n' '${version}'\n`, { mode: 0o700, flag: "wx" });
  await chmod(executable, 0o700);
  worker.executablePath = executable;
  worker.recordedVersion = version;
}
await writeFile(join(protectedRoot, "config/mac-local.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await chmod(join(protectedRoot, "config/mac-local.json"), 0o600);

const target = `host=127.0.0.1 port=${config.database.port} dbname=control_room user=postgres`;
const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", ...args], {
  cwd: process.cwd(), encoding: "utf8", timeout: 180_000,
  env: { ...process.env, CONTROL_ROOM_PROTECTED_ROOT: protectedRoot },
});
const admin = connectTarget(target);
await admin.connect();
try {
  const identity = (await admin.query<{ data_directory: string; version_num: number; current_user: string; current_database: string }>(
    "SELECT current_setting('data_directory') AS data_directory,current_setting('server_version_num')::int AS version_num,current_user,current_database() AS current_database")).rows[0];
  if (resolve(identity?.data_directory ?? "") !== resolve(root, "pg")
    || Math.floor((identity?.version_num ?? 0) / 10_000) !== 17
    || identity?.current_user !== "postgres" || identity.current_database !== "control_room")
    throw new Error("rehearsal_database_scope_refused");
  verifiedThisRehearsalCluster = true;
} finally { await admin.end(); }

// This check is deliberately before the VPS-side transaction: missing reviewed
// coordinator reads are a stop condition, not a reason to change role grants.
const coordinator = new Client({ host: roleMap.coordinator.host, port: roleMap.coordinator.port,
  database: roleMap.coordinator.database, user: roleMap.coordinator.username, password: roleMap.coordinator.password,
  connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
await coordinator.connect();
try {
  const role = (await coordinator.query<{ current_user: string }>("SELECT current_user")).rows[0]?.current_user;
  if (role !== roleMap.coordinator.username) throw new Error("completion_gate_coordinator_role_mismatch");
  for (const table of ["control_completion_gate_integrity", "control_completion_gate_records"])
    await coordinator.query(`SELECT tenant_id FROM ${table} WHERE false`);
} catch {
  throw new Error("STOP: coordinator lacks SELECT on a completion-gate table; do not widen grants or provision the tenant");
} finally { await coordinator.end(); }

const generate = invoke(["scripts/mac-local/first-owner-manifest.mjs", protectedRoot, join(root, "first-owner-manifest.json")]);
assert.equal(generate.status, 0, generate.stderr || generate.stdout);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expectedDigest = sha256Digest(manifest);
const nonPeer = invoke(["scripts/mac-local/first-owner-vps.mjs", "--manifest", join(root, "first-owner-manifest.json")]);
assert.notEqual(nonPeer.status, 0, "VPS CLI must refuse when invoked by a non-postgres OS user");
assert.match(nonPeer.stderr, /Do not automatically retry/u, "CLI failure stays generic and does not expose database details");
const upArgs = ["scripts/mac-local/up.mjs", "--protected-root", protectedRoot];
const noSetup = invoke(upArgs);
assert.notEqual(noSetup.status, 0, "mac:up without VPS setup must refuse");
assert.match(`${noSetup.stdout}\n${noSetup.stderr}`, /first-owner setup has not been run; see OWNER_GUIDE_MAC\.md/u);

let receipt: Awaited<ReturnType<typeof applyMacLocalFirstOwnerV1>>;
const vps = new Client({ host: "127.0.0.1", port: config.database.port, database: "control_room", user: "postgres",
  connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 30_000 });
await vps.connect();
try {
  receipt = await applyMacLocalFirstOwnerV1(vps, manifest);
  assert.equal(receipt.manifestDigest, expectedDigest);
  assert.equal(receipt.created + receipt.kept, 14);
  const repeat = await applyMacLocalFirstOwnerV1(vps, manifest);
  assert.equal(repeat.created, 0, "second VPS run must keep all existing rows");
  assert.equal(repeat.kept, 14);
  assert.equal(repeat.manifestDigest, expectedDigest);

  const conflict = structuredClone(manifest);
  conflict.identity.id += ".altered";
  await assert.rejects(applyMacLocalFirstOwnerV1(vps, conflict), /mac_local_first_owner_manifest_invalid/u,
    "altered manifest id must be refused");
} finally { await vps.end(); }

await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await chmod(receiptPath, 0o600);

const complete = () => invoke(["scripts/mac-local/complete-first-owner.mjs", protectedRoot, receiptPath]);
// Corrupt one disposable public-key fingerprint, prove pin refusal, and restore
// exact original value before any successful finisher attempt (the finisher
// pins the receipt before it writes the completion checkpoint).
const keyNode = manifest.nodes[0].nodeId;
const keyCheck = connectTarget(target);
await keyCheck.connect();
let originalFingerprint: string;
try {
  originalFingerprint = (await keyCheck.query<{ fingerprint: string }>(
    "SELECT fingerprint FROM control_node_keys WHERE node_id=$1", [keyNode])).rows[0]?.fingerprint;
  if (!originalFingerprint) throw new Error("first_owner_key_missing");
  await keyCheck.query("ALTER TABLE control_node_keys DISABLE TRIGGER control_node_keys_identity_immutable");
  try {
    await keyCheck.query("UPDATE control_node_keys SET fingerprint=$2 WHERE node_id=$1", [keyNode, `sha256:${"0".repeat(64)}`]);
    const badPin = invoke(["scripts/mac-local/pin-node-keys.mjs", protectedRoot, receiptPath]);
    assert.notEqual(badPin.status, 0, "tampered key row must fail the pin");
  } finally {
    await keyCheck.query("UPDATE control_node_keys SET fingerprint=$2 WHERE node_id=$1", [keyNode, originalFingerprint]);
    await keyCheck.query("ALTER TABLE control_node_keys ENABLE TRIGGER control_node_keys_identity_immutable");
  }
} finally {
  await keyCheck.end();
}

// Mutate only disposable evidence, restore it even if the command refuses.
const originalManifest = await readFile(manifestPath, "utf8");
const originalReceipt = await readFile(receiptPath, "utf8");
try {
  const altered = JSON.parse(originalManifest);
  altered.completionGateGenesis.stateAuthTag = altered.completionGateGenesis.stateAuthTag.replace(/.$/u, altered.completionGateGenesis.stateAuthTag.endsWith("0") ? "1" : "0");
  await writeFile(manifestPath, `${JSON.stringify(altered, null, 2)}\n`, { mode: 0o600 });
  const receiptForAlteredManifest = JSON.parse(originalReceipt);
  receiptForAlteredManifest.manifestDigest = sha256Digest(altered);
  await writeFile(receiptPath, `${JSON.stringify(receiptForAlteredManifest, null, 2)}\n`, { mode: 0o600 });
  assert.notEqual(complete().status, 0, "altered genesis tag must fail the Mac finisher");
} finally {
  await writeFile(manifestPath, originalManifest, { mode: 0o600 });
  await writeFile(receiptPath, originalReceipt, { mode: 0o600 });
}

try {
  const altered = JSON.parse(originalReceipt);
  altered.manifestDigest = `sha256:${"0".repeat(64)}`;
  await writeFile(receiptPath, `${JSON.stringify(altered, null, 2)}\n`, { mode: 0o600 });
  assert.notEqual(complete().status, 0, "receipt bound to another manifest must fail");
} finally { await writeFile(receiptPath, originalReceipt, { mode: 0o600 }); }

const firstComplete = complete();
assert.equal(firstComplete.status, 0, firstComplete.stderr || firstComplete.stdout);
const repeatedComplete = complete();
assert.equal(repeatedComplete.status, 0, repeatedComplete.stderr || repeatedComplete.stdout);

// Simulate the required advanced-state / missing-checkpoint stop condition on
// this throwaway cluster. This is explicit fault injection, not a lifecycle
// advance: the integrity revision is restored after both refusals are checked.
const checkpointFile = join(protectedRoot, "state/rollback-checkpoints.json");
const checkpointSaved = `${checkpointFile}.section13-saved`;
await rename(checkpointFile, checkpointSaved);
const fault = connectTarget(target);
await fault.connect();
try {
  await fault.query("UPDATE control_completion_gate_integrity SET revision=revision+1 WHERE tenant_id=$1", [manifest.tenant.id]);
  assert.notEqual(complete().status, 0, "finisher must refuse advanced integrity without checkpoint");
  const missingCheckpointUp = invoke(upArgs);
  assert.notEqual(missingCheckpointUp.status, 0, "mac:up must refuse advanced integrity without checkpoint");
} finally {
  await fault.query("UPDATE control_completion_gate_integrity SET revision=1 WHERE tenant_id=$1", [manifest.tenant.id]);
  await fault.end();
  await rename(checkpointSaved, checkpointFile);
}

// A genuine completion-gate mutation after the first-owner handoff: create
// one disposable project, register its profile through the reviewed store,
// then remove the independent checkpoint and prove neither command repairs it.
const realProjectId = "project:section13-checkpoint";
const advanceAdmin = connectTarget(target);
await advanceAdmin.connect();
try {
  await advanceAdmin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
    title,description,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1','Disposable completion advance','No worker task',
      'planned','manual_project_active','healthy','control_room_native',$5,'{}'::jsonb,$5)`,
  [realProjectId, manifest.tenant.id, manifest.workspace.id, manifest.adapters[0].id, manifest.createdAt]);
  await advanceAdmin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [manifest.tenant.id, realProjectId, manifest.createdAt]);
} finally { await advanceAdmin.end(); }
const taskRuntime = await loadMacLocalTaskRuntimeFromRootV1(protectedRoot);
// No reviewed application login may insert profiles: coordinator, results and
// web triggers each reject that record kind. Use the throwaway cluster's
// postgres login only to exercise the store's advanced-state/checkpoint logic.
const advancePool = createPrivatePostgresDatabase({ ...roleMap.web, username: "postgres",
  password: roleMap.web.password });
const advanceCheckpoints = await openMacLocalRollbackCheckpointStoreV1(protectedRoot);
try {
  const gate = new CompletionGateStoreV1(advancePool.client, taskRuntime.keys.review, advanceCheckpoints);
  const profile = createMacLocalOwnerReviewProfileV1({ tenantId: manifest.tenant.id, projectId: realProjectId,
    ownerIdentityId: manifest.identity.id, projectCreatedAt: manifest.createdAt });
  await gate.registerProfile(profile);
  await gate.verifyProvisionedTenantV1(manifest.tenant.id);
} finally {
  await advanceCheckpoints.close();
  await advancePool.close();
}
await rename(checkpointFile, checkpointSaved);
try {
  assert.notEqual(complete().status, 0, "finisher must refuse a real advanced tenant without its checkpoint");
  assert.notEqual(invoke(upArgs).status, 0, "mac:up must refuse a real advanced tenant without its checkpoint");
} finally { await rename(checkpointSaved, checkpointFile); }

// Prove read-only readiness with fake version-reporting executables. Create a
// project so mac:up constructs the task provider, but intentionally submit no
// task and invoke no worker task protocol.
const start = invoke(upArgs);
assert.equal(start.status, 0, start.stderr || start.stdout);
stackMayBeUp = true;
const ownerCode = (await readFile(join(protectedRoot, "config/owner-sign-in.txt"), "utf8")).trim();
const origin = `http://127.0.0.1:${config.port}`;
const sessionResponse = await fetch(new URL("/api/v1/local-owner-session", origin), {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }),
});
assert.equal(sessionResponse.status, 201, "local disposable owner sign-in should succeed");
const cookie = (sessionResponse.headers.get("set-cookie") ?? "").split(";", 1)[0];
assert.ok(cookie.startsWith("control_room_local_owner="));
const projectResponse = await fetch(new URL("/api/v1/projects", origin), {
  method: "POST", headers: { origin, cookie, "content-type": "application/json", "idempotency-key": "section13-rehearsal-project" },
  body: JSON.stringify({ title: "Disposable section 13 rehearsal", summary: "Readiness only; no task submissions." }),
});
assert.equal(projectResponse.status, 201, `disposable project creation status ${projectResponse.status}`);
const downBeforeTaskHost = invoke(["scripts/mac-local/down.mjs", "--protected-root", protectedRoot]);
assert.equal(downBeforeTaskHost.status, 0, downBeforeTaskHost.stderr || downBeforeTaskHost.stdout);
stackMayBeUp = false;
const taskHost = invoke(upArgs);
assert.equal(taskHost.status, 0, taskHost.stderr || taskHost.stdout);
stackMayBeUp = true;
// A local owner session does not survive a host restart; sign in again.
const resumed = await fetch(new URL("/api/v1/local-owner-session", origin), {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }),
});
assert.equal(resumed.status, 201, "owner sign-in after the task-host restart should succeed");
const taskHostCookie = (resumed.headers.get("set-cookie") ?? "").split(";", 1)[0];
assert.ok(taskHostCookie.startsWith("control_room_local_owner="));
const workersResponse = await fetch(new URL("/api/v1/local-workers", origin), { headers: { cookie: taskHostCookie } });
assert.equal(workersResponse.status, 200);
const workersBody = await workersResponse.json();
assert.equal(workersBody.workers?.length, 3);
assert.ok(workersBody.workers.every((worker: { state: string }) => worker.state === "ready"));
const finalDown = invoke(["scripts/mac-local/down.mjs", "--protected-root", protectedRoot]);
assert.equal(finalDown.status, 0, finalDown.stderr || finalDown.stdout);
stackMayBeUp = false;
process.stdout.write("Focused first-owner and section 13 checks plus three-worker readiness: PASS (no tasks submitted)\n");
}

try {
  await main();
} finally {
  if (verifiedThisRehearsalCluster) {
    if (stackMayBeUp) {
      const downHost = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/down.mjs", "--protected-root", protectedRoot], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      });
      if (downHost.status !== 0) throw new Error("rehearsal_mac_stack_stop_failed");
    }
    const down = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/rehearsal/setup.ts", "down", root], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
    });
    const status = spawnSync("pg_ctl", ["-D", join(root, "pg"), "status"], { encoding: "utf8", timeout: 10_000 });
    if (status.status === 0) throw new Error("rehearsal_cluster_still_running_after_cleanup");
    if (down.status !== 0 && !/data directory .* not exist/u.test(`${down.stderr}\n${down.stdout}`))
      throw new Error("rehearsal_cluster_stop_failed");
  }
}
