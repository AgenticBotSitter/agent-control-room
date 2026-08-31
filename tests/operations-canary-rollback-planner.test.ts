import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildOperationsCanaryRollbackPlannerV1,
  buildOperationsDeploymentPlanV1,
  buildOperationsDeploymentPrerequisiteV1,
  buildOperationsDeploymentReadinessAssessmentV1,
  buildOperationsReleaseCandidateV1,
  buildOperationsRollbackPlanV1,
  buildOperationsSyntheticBackupManifestV1,
  buildOperationsSyntheticReleaseCandidateV1,
  buildOperationsSyntheticTopologyFixtureV1,
  createOperationsDisabledCanaryRollbackExecutorV1,
  createOperationsIntentMemoryPortV1,
  createOperationsIntentMemoryPortFromSnapshotV1,
  OPERATIONS_CANARY_ROLLBACK_ACTIONS_V1,
  OPERATIONS_CANARY_ROLLBACK_QUESTION_IDS_V1,
  OPERATIONS_CANARY_ROLLBACK_STEP_IDS_V1,
  OPERATIONS_DEPLOYMENT_GATE_IDS_V1,
  OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1,
  OperationsContractErrorV1,
  OperationsEffectIntentLedgerV1,
  parseOperationsCanaryRollbackPlannerV1,
  projectOperationsCanaryRollbackV1,
  type OperationsCanaryRollbackPlannerV1,
  type OperationsIntentRecordV1,
} from "../src/operations/v1";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security";
import { binaryViewAttack, observedProxy } from "./proxy-test-helper";

const evidence = (label: string) => sha256Digest({ test: "operations-canary-rollback", label });
const clone = <T>(value: T): T => structuredClone(value);
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}
const at = (seconds: number) => new Date(Date.parse("2026-08-30T05:00:00.000Z") + seconds * 1000).toISOString();

function referenceRelease(releaseId: string, version: string, prefix: string) {
  const value = (label: string) => evidence(`${prefix}:${label}`);
  return buildOperationsReleaseCandidateV1({ releaseId, version,
    sourceRevisionDigest: value("source"), applicationArtifactDigest: value("application"), migrationBundleDigest: value("migration"),
    publicAssetsDigest: value("assets"), lockfileDigest: value("lockfile"), sbomDigest: value("sbom"),
    provenanceDigest: value("provenance"), signatureEvidenceDigest: value("signature"),
    configurationSchemaDigest: value("configuration"), protocolCompatibilityDigest: value("protocol"),
    rollbackCompatibilityDigest: value("rollback"), builtAt: at(-3600) });
}
function previousRelease() {
  return referenceRelease("release:operations:synthetic:previous", "0.0.9-ops-candidate", "previous");
}

function fixture(input: { ownerValidUntil?: string; plannerExpiresAt?: string; currentOverride?: ReturnType<typeof buildOperationsReleaseCandidateV1> } = {}) {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), current = input.currentOverride ?? buildOperationsSyntheticReleaseCandidateV1(topology),
    previous = previousRelease(), deployment = buildOperationsDeploymentPlanV1({ planId: "plan:operations:canary:test",
      topology, release: current, previousReleaseDigest: previous.releaseDigest, plannedAt: at(0), expiresAt: at(3600) }),
    checkedAt = at(60), ownerValidUntil = input.ownerValidUntil ?? at(1800);
  const prerequisites = OPERATIONS_DEPLOYMENT_GATE_IDS_V1.map((gateId, position) => buildOperationsDeploymentPrerequisiteV1({
    gateId, state: "met", evidenceDigest: position === 0 ? topology.topologyDigest : position === 1 ? current.releaseDigest
      : position === 13 ? OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 : evidence(`gate:${gateId}`), checkedAt,
    ...([6, 7, 8, 9, 14, 15, 16, 17].includes(position) ? { validUntil: position === 17 ? ownerValidUntil : at(2400) } : {}),
    safeReasonCode: "authoritative_evidence_current" }));
  const readiness = buildOperationsDeploymentReadinessAssessmentV1({ assessmentId: "assessment:operations:canary:test",
    plan: deployment, prerequisites, assessedAt: checkedAt });
  const rollback = buildOperationsRollbackPlanV1({ rollbackPlanId: "rollback-plan:operations:canary:test", topology,
    currentRelease: current, previousRelease: previous, databaseDisposition: "unchanged_verified",
    compatibilityEvidenceDigest: evidence("rollback-compatibility"), plannedAt: at(70), expiresAt: at(3600) });
  const plannerInput = { plannerId: "planner:operations:canary:test", deploymentPlan: deployment,
    readinessAssessment: readiness, rollbackPlan: rollback, createdAt: at(90), plannerExpiresAt: input.plannerExpiresAt ?? at(1200) };
  const planner = buildOperationsCanaryRollbackPlannerV1({ plannerId: plannerInput.plannerId,
    deploymentPlan: deployment, readinessAssessment: readiness, rollbackPlan: rollback, createdAt: plannerInput.createdAt,
    expiresAt: plannerInput.plannerExpiresAt });
  return { topology, current, previous, deployment, prerequisites, readiness, rollback, planner, plannerInput };
}

function ledgerFor(planner: OperationsCanaryRollbackPlannerV1, portId = "intent-port:operations:test") {
  const port = createOperationsIntentMemoryPortV1(portId), key = new Uint8Array(32).fill(41),
    identity = evidence(`ledger:${portId}`), checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true }),
    ledger = new OperationsEffectIntentLedgerV1(port, identity,
      { integrityKey: key, checkpointStore: checkpoints, mode: "create", testOnly: true, clock: () => at(900) });
  return { port, key, identity, checkpoints, ledger, records: ledger.registerPlanner(planner) };
}

function complete(ledger: OperationsEffectIntentLedgerV1, intentId: string,
  outcome: "forward_migration_verified" | "canary_passed" | "canary_failed" | "promotion_verified" | "application_rollback_verified",
  offset: number): OperationsIntentRecordV1 {
  ledger.claim(intentId, evidence(`claim:${intentId}`), at(offset));
  ledger.recordMarker(intentId, evidence(`marker:${intentId}`), at(offset + 1));
  return ledger.recordReceipt(intentId, { outcome, effectReceiptDigest: evidence(`effect:${intentId}`),
    independentVerificationDigest: evidence(`independent:${intentId}`), recordedAt: at(offset + 2) });
}

test("CR10A-OPS-080 freezes an ordered proposal-only canary and rollback plan", () => {
  const { planner } = fixture();
  assert.deepEqual(parseOperationsCanaryRollbackPlannerV1(planner), planner);
  assert.deepEqual(planner.steps.map((step) => step.stepId), [...OPERATIONS_CANARY_ROLLBACK_STEP_IDS_V1]);
  assert.deepEqual(planner.ownerQuestions.map((question) => question.questionId), [...OPERATIONS_CANARY_ROLLBACK_QUESTION_IDS_V1]);
  assert.deepEqual(planner.intents.map((intent) => intent.action), [...OPERATIONS_CANARY_ROLLBACK_ACTIONS_V1]);
  assert.equal(planner.steps.every((step, position) => step.position === position && !step.performsAction), true);
  assert.equal(planner.intents.every((intent) => !intent.authorized && !intent.commandLines.length && !intent.targetPresent), true);
  assert.equal(planner.automaticPromotionAllowed || planner.automaticRollbackAllowed || planner.databaseDownMigrationAllowed
    || planner.databaseRestoreIncluded || planner.automaticRetryAfterChange || planner.commandsPresent || planner.executorPresent
    || planner.serviceClientPresent || planner.databaseClientPresent || planner.providerClientPresent || planner.networkClientPresent
    || planner.authorized || planner.grantsApproval || planner.grantsDeploymentAuthority || planner.grantsRollbackAuthority
    || planner.grantsExecutionAuthority, false);
});

test("CR10A-OPS-080 rejects automatic action, down migration, step drift, and question drift after re-signing", () => {
  const { planner } = fixture();
  for (const field of ["automaticPromotionAllowed", "automaticRollbackAllowed", "databaseDownMigrationAllowed",
    "automaticRetryAfterChange"] as const) {
    const drift = { ...clone(planner), [field]: true } as unknown as Record<string, unknown>;
    assert.throws(() => parseOperationsCanaryRollbackPlannerV1(resign(drift, "plannerDigest")));
  }
  const steps = clone(planner); steps.steps.reverse();
  steps.steps = steps.steps.map((step, position) => resign({ ...step, position } as unknown as Record<string, unknown>, "stepDigest") as never);
  assert.throws(() => parseOperationsCanaryRollbackPlannerV1(resign(steps as unknown as Record<string, unknown>, "plannerDigest")));
  const question = clone(planner); question.ownerQuestions[1]!.choices = ["promote_candidate", "stop"];
  question.ownerQuestions[1] = resign(question.ownerQuestions[1] as unknown as Record<string, unknown>, "questionDigest") as never;
  assert.throws(() => parseOperationsCanaryRollbackPlannerV1(resign(question as unknown as Record<string, unknown>, "plannerDigest")));
});

test("CR10A-OPS-080 refuses stale owner windows and substituted readiness gates", () => {
  assert.throws(() => fixture({ ownerValidUntil: at(300), plannerExpiresAt: at(600) }),
    (error: unknown) => error instanceof OperationsContractErrorV1 && error.safeCode === "scope_mismatch");
  const value = fixture(), readiness = clone(value.readiness); readiness.prerequisites.reverse();
  const drift = resign(readiness as unknown as Record<string, unknown>, "assessmentDigest");
  assert.throws(() => buildOperationsCanaryRollbackPlannerV1({ plannerId: "planner:operations:gate-substitution",
    deploymentPlan: value.deployment, readinessAssessment: drift, rollbackPlan: value.rollback,
    createdAt: at(90), expiresAt: at(600) }));
});

test("CR10A-OPS-080 refuses wrong release binding and rollback disguised as database restore", () => {
  const value = fixture(), foreignCurrent = referenceRelease("release:operations:foreign", "0.2.0-foreign", "foreign");
  const foreignRollback = buildOperationsRollbackPlanV1({ rollbackPlanId: "rollback-plan:operations:foreign-current",
    topology: value.topology, currentRelease: foreignCurrent, previousRelease: value.previous,
    databaseDisposition: "unchanged_verified", compatibilityEvidenceDigest: evidence("foreign-compatibility"),
    plannedAt: at(70), expiresAt: at(3600) });
  assert.throws(() => buildOperationsCanaryRollbackPlannerV1({ plannerId: "planner:operations:foreign-current",
    deploymentPlan: value.deployment, readinessAssessment: value.readiness, rollbackPlan: foreignRollback,
    createdAt: at(90), expiresAt: at(600) }));
  const backup = buildOperationsSyntheticBackupManifestV1(value.topology, value.previous), restoreRollback = buildOperationsRollbackPlanV1({
    rollbackPlanId: "rollback-plan:operations:restore-confusion", topology: value.topology, currentRelease: value.current,
    previousRelease: value.previous, databaseDisposition: "restore_from_verified_backup_required",
    compatibilityEvidenceDigest: evidence("restore-compatibility"), backup, plannedAt: at(70), expiresAt: at(3600) });
  assert.throws(() => buildOperationsCanaryRollbackPlannerV1({ plannerId: "planner:operations:restore-confusion",
    deploymentPlan: value.deployment, readinessAssessment: value.readiness, rollbackPlan: restoreRollback,
    createdAt: at(90), expiresAt: at(600) }));
});

test("CR10A-OPS-080 ledger registration is exact-replay safe and survives a synthetic restart", () => {
  const { planner } = fixture(), value = ledgerFor(planner);
  assert.equal(value.records.length, 4); assert.deepEqual(value.ledger.registerPlanner(planner), value.records);
  const snapshot = value.ledger.exportSnapshot(); value.ledger.close();
  const restoredPort = createOperationsIntentMemoryPortFromSnapshotV1("intent-port:operations:restored", snapshot);
  assert.throws(() => new OperationsEffectIntentLedgerV1(restoredPort, value.identity,
    { integrityKey: new Uint8Array(32).fill(99), checkpointStore: value.checkpoints, mode: "open", testOnly: true }));
  const reopened = new OperationsEffectIntentLedgerV1(restoredPort, value.identity,
    { integrityKey: value.key, checkpointStore: value.checkpoints, mode: "open", testOnly: true, clock: () => at(900) });
  assert.equal(reopened.list().length, 4); assert.deepEqual(reopened.list().map((record) => record.state),
    ["proposed", "proposed", "proposed", "proposed"]); reopened.close();
});

test("CR10A-OPS-080 external checkpoint rejects an older authenticated ledger snapshot", () => {
  const { planner } = fixture(), value = ledgerFor(planner, "intent-port:operations:rollback-check"), old = value.ledger.exportSnapshot();
  value.ledger.claim(value.records[0]!.intent.intentId, evidence("newer-claim"), at(100)); value.ledger.close();
  const restoredOld = createOperationsIntentMemoryPortFromSnapshotV1("intent-port:operations:older-snapshot", old);
  assert.throws(() => new OperationsEffectIntentLedgerV1(restoredOld, value.identity,
    { integrityKey: value.key, checkpointStore: value.checkpoints, mode: "open", testOnly: true }));
});

test("CR10A-OPS-080 refuses canary bypass and early promotion or rollback", () => {
  const { planner } = fixture(), { ledger, records } = ledgerFor(planner, "intent-port:operations:bypass"),
    canary = records[1]!, promotion = records[2]!, rollback = records[3]!;
  assert.throws(() => ledger.claim(canary.intent.intentId, evidence("early-canary"), at(100)));
  assert.throws(() => ledger.claim(promotion.intent.intentId, evidence("early-promotion"), at(100)));
  assert.throws(() => ledger.claim(rollback.intent.intentId, evidence("early-rollback"), at(100)));
  ledger.close();
});

test("CR10A-OPS-080 permits only the explicit promotion branch after independently passing canary evidence", () => {
  const { planner } = fixture(), { ledger, records } = ledgerFor(planner, "intent-port:operations:promotion"),
    executor = createOperationsDisabledCanaryRollbackExecutorV1();
  complete(ledger, records[0]!.intent.intentId, "forward_migration_verified", 100);
  complete(ledger, records[1]!.intent.intentId, "canary_passed", 110);
  assert.throws(() => ledger.claim(records[3]!.intent.intentId, evidence("rollback-after-pass"), at(120)));
  const promotion = ledger.claim(records[2]!.intent.intentId, evidence("promotion-owner-reference"), at(120));
  const disabled = executor.prepare(promotion.intent);
  assert.equal(disabled.status, "disabled_before_execution"); assert.equal(disabled.effectAttempted, false);
  assert.deepEqual(disabled.commandLines, []); assert.equal(disabled.targetPresent || disabled.clientPresent
    || disabled.credentialResolutionAttempted || disabled.performsAction || disabled.grantsApproval
    || disabled.grantsDeploymentAuthority || disabled.grantsRollbackAuthority || disabled.grantsExecutionAuthority, false);
  ledger.recordMarker(records[2]!.intent.intentId, evidence("promotion-marker"), at(121));
  ledger.recordReceipt(records[2]!.intent.intentId, { outcome: "promotion_verified", effectReceiptDigest: evidence("promotion-effect"),
    independentVerificationDigest: evidence("promotion-independent"), recordedAt: at(122) }); ledger.close();
});

test("CR10A-OPS-080 permits only the application rollback branch after independently failed canary evidence", () => {
  const { planner } = fixture(), { ledger, records } = ledgerFor(planner, "intent-port:operations:rollback");
  complete(ledger, records[0]!.intent.intentId, "forward_migration_verified", 100);
  complete(ledger, records[1]!.intent.intentId, "canary_failed", 110);
  assert.throws(() => ledger.claim(records[2]!.intent.intentId, evidence("promotion-after-fail"), at(120)));
  const rollback = ledger.claim(records[3]!.intent.intentId, evidence("rollback-owner-reference"), at(120));
  assert.equal(rollback.state, "claimed");
  assert.throws(() => ledger.claim(records[2]!.intent.intentId, evidence("mixed-branch"), at(121)));
  ledger.recordMarker(records[3]!.intent.intentId, evidence("rollback-marker"), at(122));
  ledger.recordReceipt(records[3]!.intent.intentId, { outcome: "application_rollback_verified",
    effectReceiptDigest: evidence("rollback-effect"), independentVerificationDigest: evidence("rollback-independent"),
    recordedAt: at(123) }); ledger.close();
});

test("CR10A-OPS-080 restart after a marker becomes terminal ambiguity with no retry", () => {
  const { planner } = fixture(), value = ledgerFor(planner, "intent-port:operations:ambiguous"), migration = value.records[0]!;
  value.ledger.claim(migration.intent.intentId, evidence("ambiguous-claim"), at(100));
  value.ledger.recordMarker(migration.intent.intentId, evidence("ambiguous-marker"), at(101)); value.ledger.close();
  const reopened = new OperationsEffectIntentLedgerV1(value.port, value.identity,
    { integrityKey: value.key, checkpointStore: value.checkpoints, mode: "open", testOnly: true, clock: () => at(200) }), record = reopened.get(migration.intent.intentId);
  assert.equal(record.state, "ambiguous"); assert.equal(record.receipt?.outcome, "unknown_after_change");
  assert.throws(() => reopened.claim(migration.intent.intentId, evidence("retry-refused"), at(201)));
  assert.throws(() => reopened.claim(value.records[1]!.intent.intentId, evidence("canary-after-ambiguity"), at(202)));
  reopened.close();
});

test("CR10A-OPS-080 restart before a marker records definite prechange failure", () => {
  const { planner } = fixture(), value = ledgerFor(planner, "intent-port:operations:prechange"), migration = value.records[0]!;
  value.ledger.claim(migration.intent.intentId, evidence("prechange-claim"), at(100)); value.ledger.close();
  const reopened = new OperationsEffectIntentLedgerV1(value.port, value.identity,
    { integrityKey: value.key, checkpointStore: value.checkpoints, mode: "open", testOnly: true, clock: () => at(200) }), record = reopened.get(migration.intent.intentId);
  assert.equal(record.state, "failed_before_change"); assert.equal(record.marker, undefined);
  assert.equal(record.receipt?.outcome, "definite_failure"); reopened.close();
});

test("CR10A-OPS-080 refuses partial receipts and changed terminal replay", () => {
  const { planner } = fixture(), { ledger, records } = ledgerFor(planner, "intent-port:operations:receipt"), migration = records[0]!;
  const claimDigest = evidence("receipt-claim"), markerDigest = evidence("receipt-marker");
  const claimed = ledger.claim(migration.intent.intentId, claimDigest, at(100));
  assert.deepEqual(ledger.claim(migration.intent.intentId, claimDigest, at(100)), claimed);
  assert.throws(() => ledger.claim(migration.intent.intentId, evidence("changed-claim"), at(100)));
  const marked = ledger.recordMarker(migration.intent.intentId, markerDigest, at(101));
  assert.deepEqual(ledger.recordMarker(migration.intent.intentId, markerDigest, at(101)), marked);
  assert.throws(() => ledger.recordMarker(migration.intent.intentId, evidence("changed-marker"), at(101)));
  assert.throws(() => ledger.recordReceipt(migration.intent.intentId, { outcome: "forward_migration_verified",
    effectReceiptDigest: evidence("partial"), recordedAt: at(102) }));
  const exact = { outcome: "forward_migration_verified" as const, effectReceiptDigest: evidence("effect"),
    independentVerificationDigest: evidence("independent"), recordedAt: at(102) };
  const terminal = ledger.recordReceipt(migration.intent.intentId, exact);
  assert.deepEqual(ledger.recordReceipt(migration.intent.intentId, exact), terminal);
  assert.throws(() => ledger.recordReceipt(migration.intent.intentId, { ...exact,
    independentVerificationDigest: evidence("changed"), recordedAt: at(103) })); ledger.close();
});

test("CR10A-OPS-080 operator projection is bounded, control-free, and honest about ambiguity", () => {
  const { planner } = fixture(), value = ledgerFor(planner, "intent-port:operations:projection"), migration = value.records[0]!;
  let projection = projectOperationsCanaryRollbackV1(planner, value.ledger.list());
  assert.equal(projection.status, "owner_questions_pending"); assert.deepEqual(projection.controls, []); assert.deepEqual(projection.commandLines, []);
  value.ledger.claim(migration.intent.intentId, evidence("projection-claim"), at(100));
  value.ledger.recordMarker(migration.intent.intentId, evidence("projection-marker"), at(101));
  value.ledger.recordReceipt(migration.intent.intentId, { outcome: "unknown_after_change", recordedAt: at(102) });
  projection = projectOperationsCanaryRollbackV1(planner, value.ledger.list());
  assert.equal(projection.status, "terminal_ambiguity");
  assert.equal(projection.performsAction || projection.grantsApproval || projection.grantsDeploymentAuthority
    || projection.grantsRollbackAuthority || projection.grantsExecutionAuthority, false);
  assert.equal(JSON.stringify(projection).includes("tenant") || JSON.stringify(projection).includes("credential"), false); value.ledger.close();
});

test("CR10A-OPS-080 refuses forged planner intents, extra fields, accessors, and Proxies without traps", () => {
  const value = fixture(), executor = createOperationsDisabledCanaryRollbackExecutorV1();
  assert.throws(() => executor.prepare(clone(value.planner.intents[0]!)));
  const parsedButUntrusted = parseOperationsCanaryRollbackPlannerV1(clone(value.planner)), port = createOperationsIntentMemoryPortV1("intent-port:operations:untrusted"),
    checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true }),
    ledger = new OperationsEffectIntentLedgerV1(port, evidence("untrusted-ledger"),
      { integrityKey: new Uint8Array(32).fill(12), checkpointStore: checkpoints, mode: "create", testOnly: true });
  assert.throws(() => ledger.registerPlanner(parsedButUntrusted)); ledger.close();
  assert.throws(() => buildOperationsCanaryRollbackPlannerV1({ ...value.plannerInput,
    expiresAt: value.plannerInput.plannerExpiresAt, host: "raw-host" }));
  let accesses = 0; const accessor = { ...value.plannerInput, expiresAt: value.plannerInput.plannerExpiresAt };
  Object.defineProperty(accessor, "plannerId", { enumerable: true, get() { accesses += 1; return "planner:operations:accessor"; } });
  assert.throws(() => buildOperationsCanaryRollbackPlannerV1(accessor)); assert.equal(accesses, 0);
  const proxied = observedProxy({ ...value.plannerInput, expiresAt: value.plannerInput.plannerExpiresAt }, "throwing");
  assert.throws(() => buildOperationsCanaryRollbackPlannerV1(proxied.value)); assert.equal(proxied.trapCount(), 0);
});

test("CR10A-OPS-080 ledger rejects hostile integrity keys and checkpoint Proxies without traps", () => {
  for (const mode of ["shared", "buffer_getter", "buffer_data", "byte_length_getter", "byte_length_data", "subclass",
    "prototype_drift", "detached", "backing_constructor_getter", "method_getters", "subview_offset", "subview_prefix"] as const) {
    const attack = binaryViewAttack(mode), port = createOperationsIntentMemoryPortV1(`intent-port:operations:key-${mode}`),
      checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
    assert.throws(() => new OperationsEffectIntentLedgerV1(port, evidence(`key:${mode}`),
      { integrityKey: attack.value, checkpointStore: checkpoints, mode: "create", testOnly: true }));
    assert.equal(attack.getterCount(), 0, mode);
  }
  const port = createOperationsIntentMemoryPortV1("intent-port:operations:checkpoint-proxy"),
    proxied = observedProxy(new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), "throwing");
  assert.throws(() => new OperationsEffectIntentLedgerV1(port, evidence("checkpoint-proxy"),
    { integrityKey: new Uint8Array(32).fill(17), checkpointStore: proxied.value, mode: "create", testOnly: true }));
  assert.equal(proxied.trapCount(), 0);
});

test("CR10A-OPS-080 protected implementation imports no effect-capable client", () => {
  const source = readFileSync(new URL("../src/operations/v1/canary-rollback-planner.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:fs", "node:net", "node:http", "node:https", "node:sqlite",
    "from \"postgres\"", "fetch(", "systemctl", "docker ", "kubectl", "wrangler"]) assert.equal(source.includes(forbidden), false, forbidden);
});
