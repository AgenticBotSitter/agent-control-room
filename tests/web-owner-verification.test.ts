import assert from "node:assert/strict";
import test from "node:test";
import { ownerVerificationFixture, interceptVerificationDatabase } from "./helpers/owner-verification";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import type { CompletionVerificationV1 } from "../src/completion-gate/v1";
import { taskVerificationCommandSchema, taskVerificationOptionsSchema } from "../src/web/v1/task-verification-wire";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { request, token } from "./helpers/web-foundation";

const checkpointScope = `completion-gate:${binding.tenantId}`;
type Fixture = Awaited<ReturnType<typeof ownerVerificationFixture>>;
const record = (f: Fixture, draft: unknown = f.verificationDraft) =>
  f.verifications.record(f.identity, binding.projectId, binding.jobId, draft);
const options = (f: Fixture) => f.verifications.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
const verificationRows = async (f: Fixture) => (await f.db.query("SELECT * FROM control_completion_gate_records WHERE kind='verification'")).rows;

test("owner verification persists actual checkpointed Completion Gate evidence and never completes the canonical task", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close);
  const before = f.checkpoints.read(checkpointScope)!;
  const offered = taskVerificationOptionsSchema.parse(await options(f));
  assert.equal(offered.source, "configured"); assert.equal(offered.scenarios.length, 1);
  assert.equal(offered.scenarios[0].availability, "available"); assert.equal(offered.scenarios[0].ownVerification, null);
  assert.equal(offered.scenarios[0].instructionsDigest, f.verificationDraft.instructionsDigest);
  assert.deepEqual(f.checkpoints.read(checkpointScope), before, "options must not alter the checkpoint");
  await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, "owner-verification-quality-001");
  assert.equal((await f.reviewStore.snapshot(binding.tenantId, f.target.id)).status, "pending");
  const preRecord = f.checkpoints.read(checkpointScope)!;
  const saved = taskVerificationCommandSchema.parse(await record(f));
  assert.equal(saved.replayed, false); assert.equal(saved.receipt.noteDigest, sha256Digest(f.verificationDraft.note));
  assert.equal(saved.receipt.recordedAt, at(6000)); assert.equal(saved.receipt.completesJob, false);
  assert.equal(saved.receipt.grantsApproval, false); assert.equal(saved.receipt.grantsExecutionAuthority, false);
  assert.equal(f.checkpoints.read(checkpointScope)!.revision, preRecord.revision + 1);
  const verification = await f.reviewStore.getRecord(binding.tenantId, saved.receipt.verificationId, "verification") as CompletionVerificationV1;
  assert.ok(verification); assert.equal(verification.verifier.actorId, "identity:test"); assert.equal(verification.verifier.actorType, "human");
  assert.equal(verification.targetDigest, f.verificationDraft.targetDigest); assert.equal(verification.outcome, "passed");
  assert.equal(verification.acceptanceProfileId, f.profile.id); assert.equal(verification.acceptanceProfileDigest, sha256Digest(f.profile));
  assert.equal(verification.scenarioId, f.scenario.scenarioId); assert.equal(verification.verifiedAt, saved.receipt.recordedAt);
  assert.ok(verification.evidenceDigests.includes(f.artifact.contentHash));
  assert.ok(verification.evidenceDigests.includes(saved.receipt.noteDigest));
  assert.equal((await f.reviewStore.snapshot(binding.tenantId, f.target.id)).status, "ready");
  assert.equal((await f.tasks.detail(f.identity, binding.projectId, binding.jobId)).task.state, "leased");
  const history = await options(f);
  assert.equal(history.scenarios[0].availability, "already_recorded");
  const { noteDigest, ...historyReceipt } = saved.receipt;
  assert.ok(noteDigest); assert.deepEqual(history.scenarios[0].ownVerification, historyReceipt);
  for (const table of ["control_effect_intents", "control_approvals"])
    assert.equal((await f.db.query(`SELECT id FROM ${table}`)).rows.length, 0);
  assert.equal((await f.db.query("SELECT id FROM control_completion_gate_records WHERE kind='revision'")).rows.length, 0);
  assert.equal((await f.db.query("SELECT id FROM control_attempts")).rows.length, 1);
  assert.equal(JSON.stringify((await f.db.query("SELECT * FROM audit_events")).rows).includes(f.verificationDraft.note), false);
  assert.equal(JSON.stringify(await verificationRows(f)).includes(f.verificationDraft.note), false);
});

test("concurrent identical records and later replay preserve one verification and one checkpoint advance; changed evidence conflicts", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close); const before = f.checkpoints.read(checkpointScope)!;
  const saved = await Promise.all(Array.from({ length: 3 }, () => record(f)));
  assert.equal(saved.filter(value => !value.replayed).length, 1);
  assert.equal(new Set(saved.map(value => value.receipt.verificationId)).size, 1);
  assert.equal((await verificationRows(f)).length, 1); assert.equal(f.checkpoints.read(checkpointScope)!.revision, before.revision + 1);
  const checkpoint = f.checkpoints.read(checkpointScope);
  const replay = await f.createVerifications(f.db, () => instant + 7000).record(f.identity, binding.projectId, binding.jobId, f.verificationDraft);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, saved[0].receipt);
  for (const patch of [{ note: "A different observation." }, { outcome: "failed" }, { instructionsDigest: sha256Digest("changed") }])
    await assert.rejects(record(f, { ...f.verificationDraft, ...patch }), { code: "conflict" });
  assert.deepEqual(f.checkpoints.read(checkpointScope), checkpoint); assert.equal((await verificationRows(f)).length, 1);
});

test("lost commit acknowledgement reconciles only by explicit exact replay", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close); let commits = 0;
  const db: DatabaseClient = { ...f.db, async transactionWithPreCommitCheck(work, check) {
    const value = await f.db.transactionWithPreCommitCheck(work, check); commits++; throw new Error(`synthetic_lost_ack:${String(!!value)}`);
  } };
  await assert.rejects(f.createVerifications(db).record(f.identity, binding.projectId, binding.jobId, f.verificationDraft), /synthetic_lost_ack/);
  assert.equal(commits, 1); assert.equal((await verificationRows(f)).length, 1);
  const checkpoint = f.checkpoints.read(checkpointScope), replay = await record(f);
  assert.equal(replay.replayed, true); assert.deepEqual(f.checkpoints.read(checkpointScope), checkpoint);
});

test("failed, blocked and inconclusive owner outcomes persist truth and keep required verification unsatisfied", async t => {
  for (const outcome of ["failed", "blocked", "inconclusive"] as const) await t.test(outcome, async t => {
    const f = await ownerVerificationFixture(); t.after(f.close);
    const saved = await record(f, { ...f.verificationDraft, outcome });
    const verification = await f.reviewStore.getRecord(binding.tenantId, saved.receipt.verificationId, "verification") as CompletionVerificationV1;
    assert.equal(saved.receipt.outcome, outcome); assert.equal(verification.outcome, outcome);
    const snapshot = await f.reviewStore.snapshot(binding.tenantId, f.target.id);
    assert.equal(snapshot.status, "verification_blocked"); assert.deepEqual(snapshot.missingVerificationScenarioIds, [f.scenario.scenarioId]);
    assert.equal((await f.tasks.detail(f.identity, binding.projectId, binding.jobId)).task.state, "leased");
  });
});

test("empty or unmatched trusted manual scenarios expose no invented verification command", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close); const before = f.checkpoints.read(checkpointScope);
  for (const manualVerificationScenarios of [[], [{ ...f.scenario, acceptanceProfileDigest: sha256Digest("other profile") }],
    [{ ...f.scenario, acceptanceProfileId: "profile:other" }], [{ ...f.scenario, scenarioId: "scenario:unrequired" }]]) {
    const service = f.createVerifications(f.db, undefined, { manualVerificationScenarios });
    const offered = await service.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
    assert.deepEqual(offered.scenarios, []);
    if (!manualVerificationScenarios.length) assert.equal(offered.source, "not_configured");
    await assert.rejects(service.record(f.identity, binding.projectId, binding.jobId, f.verificationDraft));
  }
  assert.deepEqual(f.checkpoints.read(checkpointScope), before); assert.deepEqual(await verificationRows(f), []);
});

test("operator, wrong project scope, missing content grant, revoked identity/session and inactive project cannot verify", async t => {
  for (const mode of ["operator", "scope", "content", "identity", "session", "project"] as const) await t.test(mode, async t => {
    const f = await ownerVerificationFixture(); t.after(f.close); await options(f); const before = f.checkpoints.read(checkpointScope);
    if (mode === "operator") await f.db.query("UPDATE control_role_grants SET role_key='operator'");
    if (mode === "scope") await f.db.query(`UPDATE control_role_grants SET project_ids='["project:other"]'::jsonb`);
    if (mode === "content") await f.db.query(`UPDATE control_role_grants SET allowed_actions='["projects.read","tasks.read","tasks.reviews.record"]'::jsonb`);
    if (mode === "identity") await f.db.query("UPDATE control_identities SET state='suspended'");
    if (mode === "session") await f.db.query("UPDATE control_web_sessions SET revoked_at=$1", [at(6000)]);
    if (mode === "project") await f.db.query("UPDATE control_manual_project_heads SET lifecycle='archived'");
    await assert.rejects(record(f)); assert.deepEqual(await verificationRows(f), []);
    assert.deepEqual(f.checkpoints.read(checkpointScope), before);
  });
});

test("an authenticated owner sharing the producer actor identifier is not independent", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close);
  const subject = "synthetic-producing-owner";
  await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    SELECT $1,tenant_id,'human','Synthetic producing owner',auth_provider,$2,'active',created_at,updated_at FROM control_identities LIMIT 1`,
  [binding.nodeId, sha256Digest({ provider: f.accessTrust.issuer, subject })]);
  await f.db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
    allow_external_effects,require_strong_factor,created_at,updated_at)
    SELECT 'grant:producing-owner',tenant_id,$1,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
    require_strong_factor,created_at,updated_at FROM control_role_grants LIMIT 1`, [binding.nodeId]);
  const jwt = token({ sub: subject, iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const identity = createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, jwt), instant + 6000);
  const offered = await f.verifications.options(identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  assert.equal(offered.scenarios[0].availability, "independence_required");
  await assert.rejects(f.verifications.record(identity, binding.projectId, binding.jobId, f.verificationDraft));
  assert.deepEqual(await verificationRows(f), []);
});

test("profile risk floor and grant revocation block the verification command", async t => {
  const f = await ownerVerificationFixture({ profile: { minimumRisk: "high" } }); t.after(f.close);
  await f.db.query("UPDATE control_role_grants SET risk_ceiling='low'");
  assert.equal((await options(f)).scenarios[0].availability, "access_denied"); await assert.rejects(record(f), { code: "access_denied" });
  await f.db.query("UPDATE control_role_grants SET risk_ceiling='critical',revoked_at=$1", [at(5000)]);
  await assert.rejects(record(f)); assert.deepEqual(await verificationRows(f), []);
});

test("final session/grant expiry and ordinary SQL failure roll back verification plus staged checkpoint", async t => {
  for (const mode of ["session_expiry", "grant_expiry", "sql_failure"] as const) await t.test(mode, async t => {
    const f = await ownerVerificationFixture(); t.after(f.close); let now = instant + 6000, intercepted = false;
    if (mode === "grant_expiry") await f.db.query("UPDATE control_role_grants SET expires_at=$1", [at(6100)]);
    const before = f.checkpoints.read(checkpointScope);
    const db = interceptVerificationDatabase(f.db, sql => {
      if (!sql.includes("INSERT INTO audit_events")) return; intercepted = true;
      if (mode === "sql_failure") throw new Error("synthetic_verification_sql_failure");
      now = mode === "grant_expiry" ? instant + 6200 : Date.parse(f.identity.expiresAt) + 1;
    });
    await assert.rejects(f.createVerifications(db, () => now).record(f.identity, binding.projectId, binding.jobId, f.verificationDraft));
    assert.equal(intercepted, true); assert.deepEqual(await verificationRows(f), []);
    assert.deepEqual(f.checkpoints.read(checkpointScope), before);
    assert.equal((await f.reviewStore.snapshot(binding.tenantId, f.target.id)).status, "pending");
  });
});

test("rollback after the external checkpoint flush stays fail-closed and does not retry", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close); const before = f.checkpoints.read(checkpointScope)!;
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(work, () => {
    check(); throw new Error("synthetic_verification_commit_uncertain");
  }) };
  await assert.rejects(f.createVerifications(db).record(f.identity, binding.projectId, binding.jobId, f.verificationDraft), /synthetic_verification_commit_uncertain/);
  assert.deepEqual(await verificationRows(f), []); assert.equal(f.checkpoints.read(checkpointScope)!.revision, before.revision + 1);
  await assert.rejects(record(f), /integrity_failed/);
});

test("current bytes, exact target/content/scenario and request scope are required", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close); const before = f.checkpoints.read(checkpointScope);
  for (const patch of [{ contentHash: sha256Digest("other bytes") }, { targetDigest: sha256Digest("other target") },
    { targetId: "target:other" }, { artifactId: "artifact:other" }, { scenarioId: "scenario:other" },
    { instructionsDigest: sha256Digest("other instructions") }, { verifier: "identity:other" },
    { note: " " }, { note: "Invalid\0note" }, { note: "界".repeat(1400) }])
    await assert.rejects(record(f, { ...f.verificationDraft, ...patch }));
  await assert.rejects(f.verifications.record(f.identity, "project:other", binding.jobId, f.verificationDraft));
  await assert.rejects(f.verifications.record(f.identity, binding.projectId, "job:other", f.verificationDraft));
  for (const read of [async () => undefined, async () => new TextEncoder().encode("Changed stored bytes.")]) {
    const service = f.createVerifications(f.db, undefined, { results: { ...f.config, storage: { read } } });
    await assert.rejects(service.record(f.identity, binding.projectId, binding.jobId, f.verificationDraft));
  }
  assert.deepEqual(await verificationRows(f), []); assert.deepEqual(f.checkpoints.read(checkpointScope), before);
});

test("historical replay still requires current bytes and current owner session authority", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close); await record(f);
  const checkpoint = f.checkpoints.read(checkpointScope);
  const missing = f.createVerifications(f.db, undefined, { results: { ...f.config, storage: { read: async () => undefined } } });
  await assert.rejects(missing.record(f.identity, binding.projectId, binding.jobId, f.verificationDraft));
  await assert.rejects(missing.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id));
  await f.db.query("UPDATE control_web_sessions SET revoked_at=$1", [at(6000)]);
  await assert.rejects(record(f), { code: "authentication_required" });
  await assert.rejects(options(f), { code: "authentication_required" });
  assert.equal((await verificationRows(f)).length, 1); assert.deepEqual(f.checkpoints.read(checkpointScope), checkpoint);
});

test("tampered persisted verification history cannot be read or replayed as an authentic receipt", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close); await record(f);
  const checkpoint = f.checkpoints.read(checkpointScope);
  const tamper = `UPDATE control_completion_gate_records SET payload=jsonb_set(payload,'{outcome}','"failed"'::jsonb) WHERE kind='verification'`;
  await assert.rejects(f.db.query(tamper), /append-only/);
  // Simulate privileged storage corruption only after proving the ordinary append-only guard rejects it.
  await f.raw.exec("ALTER TABLE control_completion_gate_records DISABLE TRIGGER control_completion_gate_records_append_only");
  await f.db.query(tamper);
  await assert.rejects(options(f), /integrity_failed/); await assert.rejects(record(f), /integrity_failed/);
  assert.deepEqual(f.checkpoints.read(checkpointScope), checkpoint);
});
