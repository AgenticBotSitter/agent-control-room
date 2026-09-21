import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { sha256Digest } from "../src/security";
import { advanceInstallationTransitionRecordV1, createInstallationTransitionRecordV1,
  isInstallationTransitionAdmissionPausedV1, readInstallationTransitionRecordV1 } from "../src/harness/v1/installation-transition-store";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationTransitionV1 } from "../src/harness/v1/installation-transition";
import { nativeTaskFixture } from "./native-task-fixture";

const key = new Uint8Array(32).fill(84);
const at = (seconds: number) => new Date(1_800_000_000_000 + seconds * 1000).toISOString();
const digest = (value: string) => sha256Digest(value);
const transitionId = "transition:store-fixture";
const tenantId = "tenant:test";
const plan = () => planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:old", adapterId: "connector:old", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:new", adapterId: "connector:new", adapterRevision: "0000001" }] });

test("the signed journal exact-replays and refuses changed or stale revisions", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const input = { tenantId, transitionId, topologyPlan: plan(), now: at(0) };
  const first = await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, input));
  assert.equal(first.replayed, false);
  const replay = await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, input));
  assert.equal(replay.replayed, true);
  await assert.rejects(f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key,
    { ...input, topologyPlan: planInstallationTopologyV1({ databaseAuthorityDigest: digest("other"), schedulerAuthorityDigest: digest("scheduler"),
      currentRoutes: [{ kind: "local", workerId: "worker:other", adapterId: "connector:other", adapterRevision: "0000001" }],
      requestedRoutes: [{ kind: "local", workerId: "worker:different", adapterId: "connector:different", adapterRevision: "0000001" }] }) })),
  /installation_transition_unavailable/);
  const pause = { tenantId, transitionId, expectedRevision: 0, action: "pause_admission", now: at(1), evidenceDigest: digest("pause") } as const;
  assert.equal((await f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key, pause))).replayed, false);
  assert.equal((await f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key, pause))).replayed, true);
  assert.equal((await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, input))).replayed, true,
    "an original create retry remains exact after later journal revisions");
  await assert.rejects(f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key,
    { ...pause, evidenceDigest: digest("changed") })), /installation_transition_unavailable/);
  await assert.rejects(f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key,
    { tenantId, transitionId, expectedRevision: 0, action: "record_drain", now: at(2), evidenceDigest: digest("drain") })), /installation_transition_conflict/);
});

test("the admission reader fences only affected workers from durable pause through failure preparation", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, { tenantId, transitionId, topologyPlan: plan(), now: at(0) }));
  await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, { tenantId: "tenant:other", transitionId, topologyPlan: plan(), now: at(0) }));
  assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:old" })), false);
  assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:unrelated" })), false);
  let current = await f.db.transaction(tx => readInstallationTransitionRecordV1(tx, key, { tenantId, transitionId }));
  for (const [action, evidence] of [["pause_admission", "pause"], ["record_drain", "drain"], ["verify_proofs", "proof"]] as const) {
    current = await f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key, { tenantId, transitionId,
      expectedRevision: current!.revision, action, now: at(current!.revision + 1), evidenceDigest: digest(evidence) })).then(result => result.record);
    assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:old" })), true);
    assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:new" })), true);
    assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId: "tenant:other", workerId: "worker:old" })), false,
      "an identical transition ID in another tenant cannot create this tenant's fence");
  }
  current = await f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key, { tenantId, transitionId,
    expectedRevision: current!.revision, action: "fail", now: at(4), failureDigest: digest("failure") })).then(result => result.record);
  assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:old" })), true);
  current = await f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key, { tenantId, transitionId,
    expectedRevision: current!.revision, action: "prepare_rollback", now: at(5), evidenceDigest: digest("rollback-ready") })).then(result => result.record);
  assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:old" })), true);
  await f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key, { tenantId, transitionId,
    expectedRevision: current!.revision, action: "rollback", now: at(6), evidenceDigest: digest("rolled-back") }));
  assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:old" })), false);
  const secondId = "transition:second-fence";
  await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, { tenantId, transitionId: secondId, topologyPlan: plan(), now: at(7) }));
  await f.db.transaction(tx => advanceInstallationTransitionRecordV1(tx, key, { tenantId, transitionId: secondId,
    expectedRevision: 0, action: "pause_admission", now: at(8), evidenceDigest: digest("second-pause") }));
  assert.equal(await f.db.transaction(tx => isInstallationTransitionAdmissionPausedV1(tx, key, { tenantId, workerId: "worker:old" })), true,
    "the reader considers every current transition for the worker, not a caller-selected transition");
});

test("a retagged journal row is unavailable and the task coordinator is the only added role grant", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, { tenantId, transitionId, topologyPlan: plan(), now: at(0) }));
  // Establish the foreign tenant, then prove a byte-for-byte copied signed
  // record cannot cross that tenant boundary.
  await f.db.transaction(tx => createInstallationTransitionRecordV1(tx, key, { tenantId: "tenant:other",
    transitionId: "transition:other-warmup", topologyPlan: plan(), now: at(0) }));
  const source = (await f.raw.query<{ revision: number; plan_digest: string; state: string; record: unknown; auth_tag: string }>(
    `SELECT revision,plan_digest,state,record,auth_tag FROM control_installation_transition_revisions
     WHERE tenant_id=$1 AND transition_id=$2`, [tenantId, transitionId])).rows[0]!;
  await f.raw.query(`INSERT INTO control_installation_transition_revisions
    (tenant_id,transition_id,revision,plan_digest,state,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
  ["tenant:other", transitionId, source.revision, source.plan_digest, source.state, JSON.stringify(source.record), source.auth_tag]);
  await assert.rejects(f.db.transaction(tx => readInstallationTransitionRecordV1(tx, key,
    { tenantId: "tenant:other", transitionId })), /installation_transition_unavailable/);
  const retagged = createInstallationTransitionV1({ transitionId: "transition:retagged", topologyPlan: plan(), now: at(0) });
  await f.raw.query(`INSERT INTO control_installation_transition_revisions(tenant_id,transition_id,revision,plan_digest,state,record,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [tenantId, retagged.transitionId, retagged.revision, retagged.planDigest,
    retagged.state, JSON.stringify(retagged), `hmac-sha256:${"0".repeat(64)}`]);
  await assert.rejects(f.db.transaction(tx => readInstallationTransitionRecordV1(tx, key, { tenantId, transitionId: "transition:retagged" })), /installation_transition_unavailable/);
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec(`CREATE ROLE transition_coordinator_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE transition_web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_task_coordinator TO transition_coordinator_test;
    GRANT control_room_private_web TO transition_web_test`);
  const roleRecord = createInstallationTransitionV1({ transitionId: "transition:role-grant", topologyPlan: plan(), now: at(1) });
  await f.db.transaction(async tx => {
    await tx.query("SET LOCAL SESSION AUTHORIZATION transition_coordinator_test");
    const visible = await tx.query<{ transition_id: string }>("SELECT transition_id FROM control_installation_transition_revisions");
    assert.ok(visible.rows.some(row => row.transition_id === transitionId), "the coordinator can read the protected journal");
    await tx.query(`INSERT INTO control_installation_transition_revisions(tenant_id,transition_id,revision,plan_digest,state,record,auth_tag)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [tenantId, roleRecord.transitionId, roleRecord.revision,
      roleRecord.planDigest, roleRecord.state, JSON.stringify(roleRecord), `hmac-sha256:${"0".repeat(64)}`]);
  });
  await assert.rejects(f.db.transaction(async tx => {
    await tx.query("SET LOCAL SESSION AUTHORIZATION transition_web_test");
    await tx.query("SELECT record FROM control_installation_transition_revisions");
  }));
});
