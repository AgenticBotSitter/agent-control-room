import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CompletionGateErrorV1, type CompletionReviewV1, type CompletionVerificationV1 } from "../src/completion-gate/v1";
import { sha256Digest } from "../src/security";
import { createMacLocalHumanVerificationRegistryV1, createMacLocalHumanVerificationScenarioV1,
  createMacLocalOwnerReviewProfileV1, createMacLocalTextScenarioV1, MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1,
  MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1, MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1,
  MAC_LOCAL_TEXT_SCENARIO_V1, macLocalOwnerReviewProfileIdV1 } from "../src/web/v1/mac-local-owner-review-profile";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const input = { tenantId: "tenant:mac", projectId: "project:a", ownerIdentityId: "identity:tenant:mac:owner",
  projectCreatedAt: "2026-09-25T12:00:00.000Z" };

test("one stable owner-review profile per project, with a non-authorizing text check", () => {
  const a = createMacLocalOwnerReviewProfileV1(input);
  const b = createMacLocalOwnerReviewProfileV1({ ...input, projectId: "project:b" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, macLocalOwnerReviewProfileIdV1(input.projectId));
  assert.deepEqual(a, createMacLocalOwnerReviewProfileV1(input));
  assert.equal(a.automaticLowRiskDisposition, false);
  assert.equal(a.reviewerSeparation.actor, true);
  assert.equal(a.reviewerSeparation.worker, true);
  assert.equal(a.reviewerSeparation.modelFamily, true);
  assert.equal(createMacLocalOwnerReviewProfileV1({ ...input, reviewerIndependence: "different_worker" })
    .reviewerSeparation.modelFamily, false);
  assert.equal(createMacLocalTextScenarioV1(a).acceptanceProfileDigest, sha256Digest(a));
  assert.deepEqual(a.requiredVerificationScenarioIds, [MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, MAC_LOCAL_TEXT_SCENARIO_V1]);
  const human = createMacLocalHumanVerificationScenarioV1(a);
  assert.equal(human.acceptanceProfileDigest, sha256Digest(a));
  assert.notEqual(human.scenarioId, createMacLocalTextScenarioV1(a).scenarioId,
    "an automated structure pass can never stand in for owner observation");
  const registry = createMacLocalHumanVerificationRegistryV1([a]);
  registry.register(b); registry.register(b);
  assert.deepEqual(registry.list().map(value => value.acceptanceProfileId), [a.id, b.id]);
  const long = "project:" + "x".repeat(172);
  assert.match(macLocalOwnerReviewProfileIdV1(long), /^profile:mac-local-owner-review:v2:[a-f0-9]{32}$/);
});

test("migration 0092 derives the same short and long profile ids as TypeScript", async () => {
  const sql = await readFile(new URL("../db/migrations/0092_phase2b_mac_local_quality_profile.sql", import.meta.url), "utf8");
  assert.ok(sql.includes(`WHEN length('${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}' || NEW.project_id) <= 180`));
  assert.ok(sql.includes(`THEN '${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}' || NEW.project_id`));
  assert.ok(sql.includes(`ELSE '${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}'`));
  assert.ok(sql.includes("sha256(convert_to(to_json(NEW.project_id)::text,'UTF8'))"),
    "SQL must hash the JSON text form used by sha256Digest on a bare string");
  assert.ok(sql.includes(`),'hex'),1,${MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1})`));

  const long = "project:" + "x".repeat(172);
  const sqlEquivalent = MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1
    + createHash("sha256").update(JSON.stringify(long)).digest("hex").slice(0, MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1);
  assert.equal(macLocalOwnerReviewProfileIdV1(long), sqlEquivalent);
});

test("profile v2 lets the owner review an agent result and refuses a same-family agent reviewer", async t => {
  const profile = createMacLocalOwnerReviewProfileV1({ tenantId: binding.tenantId, projectId: binding.projectId,
    ownerIdentityId: "identity:test", projectCreatedAt: at() });
  const producer = { actorId: binding.nodeId, actorType: "agent" as const, workerId: "worker:producer",
    agentProfileId: "profile:producer", harness: "hermes", adapterId: "adapter:producer", modelFamily: "family:shared" };
  const f = await ownerReviewFixture({ profile, producer }); t.after(f.close);

  const agentReview: CompletionReviewV1 = { schemaVersion: "control-room-completion-gate/v1", id: "review:same-family",
    tenantId: binding.tenantId, projectId: binding.projectId, targetId: f.target.id, targetDigest: sha256Digest(f.target),
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    reviewer: { actorId: "agent:reviewer", actorType: "agent", workerId: "worker:reviewer",
      agentProfileId: "profile:reviewer", harness: "claude-code", adapterId: "adapter:reviewer", modelFamily: "family:shared" },
    authority: "completion_gate", decision: "accepted", assessedRisk: "low", effectiveRisk: "low",
    evidenceDigests: [f.artifact.contentHash], findingIds: [], reviewedAt: at(6000),
    grantsApproval: false, grantsExecutionAuthority: false };
  await assert.rejects(() => f.reviewStore.recordReview(agentReview),
    (error: unknown) => error instanceof CompletionGateErrorV1 && error.safeCode === "reviewer_not_independent");

  const options = await f.reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  assert.equal(options.availability, "available");
  assert.equal(options.canReview, true);
  const recorded = await f.reviews.record(f.identity, binding.projectId, binding.jobId, f.draft, "profile-v2-owner-review-001");
  assert.equal(recorded.receipt.decision, "accepted");
});

test("Mac-local acceptance explicitly attests the owner read the result and atomically records its human check", async t => {
  const profile = createMacLocalOwnerReviewProfileV1({ tenantId: binding.tenantId, projectId: binding.projectId,
    ownerIdentityId: "identity:test", projectCreatedAt: at() });
  const f = await ownerReviewFixture({ profile }); t.after(f.close);
  const registry = createMacLocalHumanVerificationRegistryV1([profile]);
  const reviews = f.createReviews(undefined, undefined, { acceptanceVerificationScenarios: registry });
  const options = await reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  assert.equal(options.acceptanceAttestation?.scenarioId, MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1);
  const recorded = await reviews.record(f.identity, binding.projectId, binding.jobId, {
    ...f.draft, acceptanceAttestation: { scenarioId: options.acceptanceAttestation!.scenarioId,
      instructionsDigest: options.acceptanceAttestation!.instructionsDigest, confirmed: true },
  }, "profile-v2-attested-owner-review-001");
  assert.equal(recorded.receipt.decision, "accepted");
  const replayed = await reviews.record(f.identity, binding.projectId, binding.jobId, {
    ...f.draft, acceptanceAttestation: { scenarioId: options.acceptanceAttestation!.scenarioId,
      instructionsDigest: options.acceptanceAttestation!.instructionsDigest, confirmed: true },
  }, "profile-v2-attested-owner-review-001");
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.receipt.reviewId, recorded.receipt.reviewId);
  await assert.rejects(() => reviews.record(f.identity, binding.projectId, binding.jobId, {
    ...f.draft, acceptanceAttestation: { scenarioId: options.acceptanceAttestation!.scenarioId,
      instructionsDigest: sha256Digest("changed-instructions"), confirmed: true },
  }, "profile-v2-attested-owner-review-001"), (error: unknown) => (error as { code?: string }).code === "conflict");
  const snapshot = await f.reviewStore.snapshot(binding.tenantId, f.target.id);
  assert.deepEqual(snapshot.missingVerificationScenarioIds, [MAC_LOCAL_TEXT_SCENARIO_V1]);
  const verificationId = `verification:owner:${sha256Digest({ tenantId: binding.tenantId, actorId: "identity:test",
    targetId: f.target.id, scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1 }).slice(7)}`;
  const verification = await f.reviewStore.getRecord(binding.tenantId, verificationId, "verification");
  assert.equal((verification as { outcome?: string })?.outcome, "passed");
  const counts = await f.db.query<{ kind: string; count: string }>(`SELECT kind,count(*)::text AS count
    FROM control_completion_gate_records WHERE tenant_id=$1 AND parent_id=$2 AND kind IN ('review','verification')
    GROUP BY kind ORDER BY kind`, [binding.tenantId, f.target.id]);
  assert.deepEqual(counts.rows, [{ kind: "review", count: "1" }, { kind: "verification", count: "1" }]);

  const automatic: CompletionVerificationV1 = { schemaVersion: "control-room-completion-gate/v1", id: "verification:text:one",
    tenantId: binding.tenantId, projectId: binding.projectId, targetId: f.target.id, targetDigest: sha256Digest(f.target),
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile), scenarioId: MAC_LOCAL_TEXT_SCENARIO_V1,
    outcome: "passed", verifier: { actorId: "service:quality", actorType: "service" }, evidenceDigests: [f.artifact.contentHash],
    verifiedAt: at(6000), grantsApproval: false, grantsExecutionAuthority: false };
  await f.reviewStore.recordVerification(automatic);
  const jobRow = await f.db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, binding.jobId]);
  await f.db.query(`UPDATE control_jobs SET state='succeeded',version=3,payload=$3::jsonb,updated_at=$4
    WHERE tenant_id=$1 AND id=$2`, [binding.tenantId, binding.jobId,
    JSON.stringify({ ...jobRow.rows[0]!.payload, state: "succeeded", version: 3, updatedAt: at(6000) }), at(6000)]);
  const detail = await f.tasks.detail(f.identity, binding.projectId, binding.jobId);
  assert.equal(detail.task.qualityStatus, "accepted", "the task header receives authenticated ready evidence");
  const list = await f.tasks.list(f.identity, binding.projectId);
  assert.equal(list.tasks.find(task => task.jobId === binding.jobId)?.qualityStatus, "accepted",
    "the Work list receives authenticated ready evidence");
  const home = await f.tasks.home(f.identity);
  assert.equal(home.recentResults.find(item => item.task.jobId === binding.jobId)?.task.qualityStatus, "accepted",
    "Home receives authenticated ready evidence");
});

test("a failed combined verification rolls back the preceding owner review", async t => {
  const profile = createMacLocalOwnerReviewProfileV1({ tenantId: binding.tenantId, projectId: binding.projectId,
    ownerIdentityId: "identity:test", projectCreatedAt: at() });
  const f = await ownerReviewFixture({ profile }); t.after(f.close);
  const registry = createMacLocalHumanVerificationRegistryV1([profile]);
  const failVerification = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(statement: string, params?: unknown[]) {
    if (statement.includes("INSERT INTO control_completion_gate_records") && params?.[3] === "verification")
      throw new Error("injected_verification_failure");
    return tx.query<T>(statement, params);
  } });
  const failingDb: DatabaseClient = { query: f.db.query.bind(f.db),
    transaction: work => f.db.transaction(tx => work(failVerification(tx))),
    transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work(failVerification(tx)), check) };
  const reviews = f.createReviews(failingDb, undefined, { acceptanceVerificationScenarios: registry });
  const options = await reviews.options(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId, f.target.id);
  await assert.rejects(() => reviews.record(f.identity, binding.projectId, binding.jobId, {
    ...f.draft, acceptanceAttestation: { scenarioId: options.acceptanceAttestation!.scenarioId,
      instructionsDigest: options.acceptanceAttestation!.instructionsDigest, confirmed: true },
  }, "profile-v2-rollback-owner-review-001"), /injected_verification_failure/);
  const rows = await f.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_completion_gate_records
    WHERE tenant_id=$1 AND parent_id=$2 AND kind IN ('review','verification')`, [binding.tenantId, f.target.id]);
  assert.equal(rows.rows[0]?.count, "0");
  const commands = await f.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_web_task_review_commands
    WHERE tenant_id=$1 AND target_id=$2`, [binding.tenantId, f.target.id]);
  assert.equal(commands.rows[0]?.count, "0");
});
