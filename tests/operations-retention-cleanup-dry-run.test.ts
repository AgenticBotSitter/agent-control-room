import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessOperationsDataDispositionV1,
  buildOperationsDataClassRegistryV1,
  buildOperationsDataDispositionProposalV1,
  buildOperationsDataDispositionRequestV1,
  buildOperationsRetentionCleanupDryRunPlanV1,
  buildOperationsRetentionEvidenceV1,
  buildOperationsSyntheticPrivacyRetentionPolicyV1,
  createOperationsDisabledRetentionCleanupExecutorV1,
  createOperationsRetentionFakeInventoryAdapterV1,
  OPERATIONS_RETENTION_CLEANUP_STEP_IDS_V1,
  OperationsContractErrorV1,
  OperationsRetentionCleanupAuthenticatorV1,
  parseOperationsRetentionCleanupDryRunPlanV1,
  parseOperationsRetentionCleanupLifecycleV1,
  parseOperationsRetentionCleanupReceiptV1,
  projectOperationsRetentionCleanupV1,
  runOperationsRetentionCleanupDryRunV1,
  type OperationsDataClassIdV1,
  type OperationsDispositionRequestKindV1,
  type OperationsRetentionCleanupDryRunPlanV1,
  type OperationsRetentionCleanupDryRunReportV1,
} from "../src/operations/v1";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const BASE = "2026-08-30T08:00:00.000Z";
const scope = { tenantId: "tenant:operations:cleanup", workspaceId: "workspace:operations:cleanup",
  projectId: "project:operations:cleanup" } as const;
const at = (seconds: number) => new Date(Date.parse(BASE) + seconds * 1_000).toISOString();
const day = (days: number) => at(days * 86_400);
const distinct = (label: string) => sha256Digest({ test: "operations-retention-cleanup", label });
const clone = <T>(value: T): T => structuredClone(value);
const code = (safeCode: string) => (error: unknown) => error instanceof OperationsContractErrorV1 && error.safeCode === safeCode;
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}

function context(dataClassId: OperationsDataClassIdV1 = "data-class:operations:private-artifact-body",
  requestKind: OperationsDispositionRequestKindV1 = "retention_expiry") {
  const registry = buildOperationsDataClassRegistryV1(), policy = buildOperationsSyntheticPrivacyRetentionPolicyV1({
    ...scope, effectiveAt: BASE }), request = buildOperationsDataDispositionRequestV1({ policy, dataClassId,
      recordSetDigest: distinct(`records:${dataClassId}`), requestKind, requestedAt: day(1) }),
    definition = registry.definitions.find((item) => item.dataClassId === dataClassId)!,
    evidence = buildOperationsRetentionEvidenceV1({ registry, policy, request, clockStartedAt: BASE, evaluatedAt: day(31),
      allDependencyHorizonsKnown: true, ...(definition.dependencyHorizonRequired ? { maximumDependencyHorizonAt: day(20) } : {}),
      activeReferencesAbsent: true, referenceEvidenceDigest: distinct("reference"),
      inventoryEvidenceDigest: distinct("inventory"), auditChainHeadDigest: distinct("audit") }), holds: never[] = [],
    releases: never[] = [], assessment = assessOperationsDataDispositionV1({ registry, policy, request, evidence, holds, releases }),
    proposal = buildOperationsDataDispositionProposalV1(assessment), createdAt = day(31), expiresAt = at(31 * 86_400 + 600),
    plan = buildOperationsRetentionCleanupDryRunPlanV1({ registry, policy, request, evidence, holds, releases,
      assessment, proposal, createdAt, expiresAt });
  return { registry, policy, request, evidence, holds, releases, assessment, proposal, plan, createdAt, expiresAt };
}
function report(plan: OperationsRetentionCleanupDryRunPlanV1, changes: Partial<{
  recordSetDigest: string; itemCount: number; totalBytes: number; activeReferenceCount: number; legalHoldCount: number;
  existingTombstoneCount: number; existingQuarantineCount: number }> = {}): OperationsRetentionCleanupDryRunReportV1 {
  const adapter = createOperationsRetentionFakeInventoryAdapterV1({ recordSetDigest: plan.recordSetDigest, itemCount: 12,
    totalBytes: 4_096, activeReferenceCount: 0, legalHoldCount: 0, existingTombstoneCount: 0,
    existingQuarantineCount: 0, inventoryEvidenceDigest: distinct(`inventory:${plan.cleanupAction}`),
    referenceEvidenceDigest: distinct(`references:${plan.cleanupAction}`), holdEvidenceDigest: distinct(`holds:${plan.cleanupAction}`),
    observedAt: new Date(Date.parse(plan.createdAt) + 1_000).toISOString(),
    validUntil: new Date(Date.parse(plan.createdAt) + 300_000).toISOString(), ...changes });
  return runOperationsRetentionCleanupDryRunV1({ plan, adapter });
}
function auth(label: string, checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true }),
  key = new Uint8Array(32).fill(0x71)) {
  return { checkpoints, key, value: new OperationsRetentionCleanupAuthenticatorV1(distinct(`auth:${label}`), key,
    checkpoints, { testOnly: true }) };
}
function markReady(plan: OperationsRetentionCleanupDryRunPlanV1, value = report(plan), label = plan.cleanupAction) {
  const authentication = auth(label), started = authentication.value.start(plan, value), claimed =
    authentication.value.recordSyntheticClaim(started, distinct(`claim:${label}`), new Date(Date.parse(started.updatedAt) + 1_000).toISOString()),
    marked = authentication.value.recordSyntheticMarker(claimed, distinct(`marker:${label}`),
      new Date(Date.parse(claimed.updatedAt) + 1_000).toISOString());
  return { ...authentication, report: value, started, claimed, marked };
}
function successInput(plan: OperationsRetentionCleanupDryRunPlanV1, recordedAt: string) {
  return { outcome: "simulated_success" as const, independentPostConditionDigest: distinct(`post:${plan.cleanupAction}`),
    auditAppendEvidenceDigest: distinct(`audit:${plan.cleanupAction}`),
    ...(["delete_body", "replace_with_digest_tombstone"].includes(plan.cleanupAction)
      ? { tombstoneEvidenceDigest: distinct(`tombstone:${plan.cleanupAction}`) } : {}),
    ...(plan.cleanupAction === "record_quarantine_candidate"
      ? { quarantineEvidenceDigest: distinct("quarantine") } : {}),
    ...(plan.cleanupAction === "reconcile_source_authority"
      ? { sourceReconciliationEvidenceDigest: distinct("source") } : {}), recordedAt };
}

test("CR10A-OPS-110 builds one exact twelve-step dry-run plan from re-derived primary evidence", () => {
  const { plan } = context();
  assert.deepEqual(parseOperationsRetentionCleanupDryRunPlanV1(plan), plan);
  assert.deepEqual(plan.steps.map((item) => item.stepId), [...OPERATIONS_RETENTION_CLEANUP_STEP_IDS_V1]);
  assert.equal(plan.cleanupAction, "delete_body"); assert.equal(plan.tombstoneMode, "pending_deletion_tombstone");
  assert.equal(!plan.requiresCurrentPolicy || !plan.requiresFreshInventory || !plan.requiresLegalHoldClearance
    || !plan.requiresCompleteDependencyHorizons || !plan.requiresActiveReferenceAbsence || !plan.requiresFreshOwnerDecision
    || !plan.requiresProtectedEffectClaim || !plan.requiresPreEffectMarker || !plan.requiresIndependentTerminalReceipt
    || !plan.requiresAuditAppend || plan.automaticRetryAllowed || !plan.dryRunOnly || plan.nativeExecutorPresent
    || plan.performsAction || plan.grantsApproval || plan.grantsDeletionAuthority || plan.grantsExecutionAuthority, false);
});

test("CR10A-OPS-110 plan construction rejects substituted assessment or proposal evidence", () => {
  const current = context(), foreign = context("data-class:operations:effect-replay");
  const input = { registry: current.registry, policy: current.policy, request: current.request, evidence: current.evidence,
    holds: current.holds, releases: current.releases, assessment: current.assessment, proposal: current.proposal,
    createdAt: current.createdAt, expiresAt: current.expiresAt };
  assert.throws(() => buildOperationsRetentionCleanupDryRunPlanV1({ ...input, assessment: foreign.assessment }), code("scope_mismatch"));
  assert.throws(() => buildOperationsRetentionCleanupDryRunPlanV1({ ...input, proposal: foreign.proposal }), code("scope_mismatch"));
});

test("CR10A-OPS-110 plan parser rejects re-signed action, step, identity, and window drift", () => {
  const { plan } = context();
  for (const change of [
    { ...clone(plan), cleanupAction: "replace_with_digest_tombstone" },
    { ...clone(plan), planId: "plan:operations:retention-cleanup:forged" },
    { ...clone(plan), expiresAt: new Date(Date.parse(plan.createdAt) + 16 * 60_000).toISOString() },
    (() => { const value = clone(plan); value.steps.reverse(); return value; })(),
  ]) assert.throws(() => parseOperationsRetentionCleanupDryRunPlanV1(
    resign(change as unknown as Record<string, unknown>, "planDigest")), code("scope_mismatch"));
});

test("CR10A-OPS-110 maps delete, compaction, source, and quarantine to separate exact lanes", () => {
  const values = [context(), context("data-class:operations:effect-replay"),
    context("data-class:operations:public-artifact-body"),
    context("data-class:operations:quarantine-evidence", "quarantine_review")];
  assert.deepEqual(values.map((item) => item.plan.cleanupAction), ["delete_body", "replace_with_digest_tombstone",
    "reconcile_source_authority", "record_quarantine_candidate"]);
  assert.equal(new Set(values.map((item) => item.plan.planDigest)).size, 4);
});

test("CR10A-OPS-110 fake inventory produces bounded current evidence but no cleanup authority", () => {
  const { plan } = context(), value = report(plan);
  assert.equal(value.outcome, "candidate_for_external_authority_review");
  assert.equal(value.candidateForExternalAuthorityReview, true); assert.equal(value.itemCount, 12);
  assert.equal(value.cleanupAuthorized || value.inventoryBodyRead || value.rawMaterialPresent || value.locatorResolved
    || value.performsAction || value.grantsApproval || value.grantsDeletionAuthority || value.grantsExecutionAuthority, false);
});

test("CR10A-OPS-110 fresh holds, references, inventory drift, and existing terminal evidence block or reconcile", () => {
  const deletePlan = context().plan, quarantinePlan = context("data-class:operations:quarantine-evidence", "quarantine_review").plan;
  assert.equal(report(deletePlan, { legalHoldCount: 1 }).outcome, "blocked_legal_hold");
  assert.equal(report(deletePlan, { activeReferenceCount: 1 }).outcome, "blocked_active_reference");
  assert.equal(report(deletePlan, { recordSetDigest: distinct("changed-records") }).outcome, "blocked_inventory_changed");
  assert.equal(report(deletePlan, { itemCount: 0, totalBytes: 0 }).outcome, "reconciliation_required_already_absent");
  assert.equal(report(deletePlan, { existingTombstoneCount: 1 }).outcome, "reconciliation_required_existing_tombstone");
  assert.equal(report(quarantinePlan, { existingQuarantineCount: 1 }).outcome,
    "reconciliation_required_existing_quarantine");
});

test("CR10A-OPS-110 accepts only repository fake adapters and rejects copied plans", () => {
  const { plan } = context(), generic = Object.freeze({ inspect() { return {}; } });
  assert.throws(() => runOperationsRetentionCleanupDryRunV1({ plan, adapter: generic }), code("invalid_input"));
  const adapter = createOperationsRetentionFakeInventoryAdapterV1({ recordSetDigest: plan.recordSetDigest, itemCount: 1,
    totalBytes: 1, activeReferenceCount: 0, legalHoldCount: 0, existingTombstoneCount: 0, existingQuarantineCount: 0,
    inventoryEvidenceDigest: distinct("copied-inventory"), referenceEvidenceDigest: distinct("copied-reference"),
    holdEvidenceDigest: distinct("copied-hold"), observedAt: new Date(Date.parse(plan.createdAt) + 1_000).toISOString(),
    validUntil: new Date(Date.parse(plan.createdAt) + 2_000).toISOString() });
  assert.throws(() => runOperationsRetentionCleanupDryRunV1({ plan: clone(plan), adapter }), code("invalid_input"));
});

test("CR10A-OPS-110 authenticated delete rehearsal is one-use, tombstone-bound, and evidence-only", () => {
  const { plan } = context(), current = markReady(plan), receiptAt = new Date(Date.parse(current.marked.updatedAt) + 1_000).toISOString(),
    received = current.value.recordSyntheticReceipt(current.marked, successInput(plan, receiptAt)),
    completed = current.value.reconcile(received, distinct("reconcile-delete"),
      new Date(Date.parse(receiptAt) + 1_000).toISOString());
  assert.equal(completed.status, "completed_evidence_only"); assert.equal(completed.receipt?.tombstoneEvidenceDigest !== undefined, true);
  assert.equal(completed.effectAttemptCount, 0); assert.equal(completed.nativeClaimRecorded || completed.nativeMarkerRecorded
    || completed.nativeReceiptRecorded || completed.performsAction || completed.grantsApproval
    || completed.grantsDeletionAuthority || completed.grantsExecutionAuthority, false);
  assert.throws(() => current.value.start(plan, current.report));
});

test("CR10A-OPS-110 exact claim, marker, receipt, and reconciliation replay is inert while changed replay fails", () => {
  const { plan } = context(), value = report(plan), authentication = auth("replay"), started = authentication.value.start(plan, value),
    claimAt = new Date(Date.parse(started.updatedAt) + 1_000).toISOString(), claimDigest = distinct("replay-claim"),
    claimed = authentication.value.recordSyntheticClaim(started, claimDigest, claimAt),
    claimedReplay = authentication.value.recordSyntheticClaim(claimed, claimDigest, claimAt);
  assert.equal(claimedReplay.stateDigest, claimed.stateDigest);
  assert.throws(() => authentication.value.recordSyntheticClaim(claimed, distinct("changed-claim"), claimAt), code("invalid_transition"));
  const markerAt = new Date(Date.parse(claimed.updatedAt) + 1_000).toISOString(), markerDigest = distinct("replay-marker"),
    marked = authentication.value.recordSyntheticMarker(claimed, markerDigest, markerAt),
    markerReplay = authentication.value.recordSyntheticMarker(marked, markerDigest, markerAt);
  assert.equal(markerReplay.stateDigest, marked.stateDigest);
  const receiptAt = new Date(Date.parse(marked.updatedAt) + 1_000).toISOString(), input = successInput(plan, receiptAt),
    receipt = authentication.value.recordSyntheticReceipt(marked, input), replay = authentication.value.recordSyntheticReceipt(receipt, input);
  assert.equal(replay.stateDigest, receipt.stateDigest);
  assert.throws(() => authentication.value.recordSyntheticReceipt(receipt, { ...input,
    independentPostConditionDigest: distinct("changed-post") }), code("invalid_transition"));
  const reconciledAt = new Date(Date.parse(receiptAt) + 1_000).toISOString(), done = authentication.value.reconcile(receipt,
    distinct("replay-reconcile"), reconciledAt), doneReplay = authentication.value.reconcile(done, distinct("replay-reconcile"), reconciledAt);
  assert.equal(doneReplay.stateDigest, done.stateDigest);
});

test("CR10A-OPS-110 compaction success cannot omit the required digest tombstone", () => {
  const { plan } = context("data-class:operations:effect-replay"), current = markReady(plan), recordedAt =
    new Date(Date.parse(current.marked.updatedAt) + 1_000).toISOString(), invalid = successInput(plan, recordedAt);
  delete invalid.tombstoneEvidenceDigest;
  assert.throws(() => current.value.recordSyntheticReceipt(current.marked, invalid), code("scope_mismatch"));
  assert.equal(current.value.recordSyntheticReceipt(current.marked, successInput(plan, recordedAt)).status,
    "reconciliation_required");
});

test("CR10A-OPS-110 source and quarantine success require their distinct independent evidence", () => {
  for (const currentContext of [context("data-class:operations:public-artifact-body"),
    context("data-class:operations:quarantine-evidence", "quarantine_review")]) {
    const { plan } = currentContext, current = markReady(plan), recordedAt =
      new Date(Date.parse(current.marked.updatedAt) + 1_000).toISOString(), invalid = successInput(plan, recordedAt);
    if (plan.cleanupAction === "reconcile_source_authority") delete invalid.sourceReconciliationEvidenceDigest;
    else delete invalid.quarantineEvidenceDigest;
    assert.throws(() => current.value.recordSyntheticReceipt(current.marked, invalid), code("scope_mismatch"));
    assert.equal(current.value.recordSyntheticReceipt(current.marked, successInput(plan, recordedAt)).status,
      "reconciliation_required");
  }
});

test("CR10A-OPS-110 a definite synthetic failure is separately reconciled and never relabelled success", () => {
  const { plan } = context(), current = markReady(plan), receiptAt = new Date(Date.parse(current.marked.updatedAt) + 1_000).toISOString(),
    received = current.value.recordSyntheticReceipt(current.marked, { outcome: "simulated_definite_failure",
      failureEvidenceDigest: distinct("definite-failure"), recordedAt: receiptAt }),
    finished = current.value.reconcile(received, distinct("failure-reconciliation"),
      new Date(Date.parse(receiptAt) + 1_000).toISOString());
  assert.equal(finished.status, "failed_evidence_only");
  assert.equal(finished.safeStatusCode, "synthetic_failure_reconciled_no_effect");
});

test("CR10A-OPS-110 restart after claim is pre-marker failure with no retry", () => {
  const { plan } = context(), value = report(plan), current = auth("restart-before-marker"), started = current.value.start(plan, value),
    claimed = current.value.recordSyntheticClaim(started, distinct("restart-claim"),
      new Date(Date.parse(started.updatedAt) + 1_000).toISOString()), reopened = new OperationsRetentionCleanupAuthenticatorV1(
      current.value.identityDigest, current.key, current.checkpoints, { testOnly: true }), resumed = reopened.resume(claimed,
      new Date(Date.parse(claimed.updatedAt) + 1_000).toISOString());
  assert.equal(resumed.status, "failed_before_marker"); assert.equal(resumed.syntheticMarkerEvidenceDigest, undefined);
  assert.throws(() => reopened.recordSyntheticMarker(resumed, distinct("late-marker"),
    new Date(Date.parse(resumed.updatedAt) + 1_000).toISOString()), code("unsupported_action"));
});

test("CR10A-OPS-110 restart after marker becomes terminal ambiguity and rejects late success", () => {
  const { plan } = context(), current = markReady(plan), reopened = new OperationsRetentionCleanupAuthenticatorV1(
    current.value.identityDigest, current.key, current.checkpoints, { testOnly: true }), resumed = reopened.resume(current.marked,
      new Date(Date.parse(current.marked.updatedAt) + 1_000).toISOString());
  assert.equal(resumed.status, "terminal_ambiguity");
  assert.equal(resumed.receipt?.outcome, "simulated_unknown_after_marker");
  assert.throws(() => reopened.recordSyntheticReceipt(resumed, successInput(plan,
    new Date(Date.parse(resumed.updatedAt) + 1_000).toISOString())), code("invalid_transition"));
});

test("CR10A-OPS-110 restart after a complete receipt can resume reconciliation safely", () => {
  const { plan } = context(), current = markReady(plan), receiptAt = new Date(Date.parse(current.marked.updatedAt) + 1_000).toISOString(),
    received = current.value.recordSyntheticReceipt(current.marked, successInput(plan, receiptAt)), reopened =
      new OperationsRetentionCleanupAuthenticatorV1(current.value.identityDigest, current.key, current.checkpoints, { testOnly: true }),
    resumed = reopened.resume(received, new Date(Date.parse(receiptAt) + 1_000).toISOString());
  assert.equal(resumed.stateDigest, received.stateDigest);
  assert.equal(reopened.reconcile(resumed, distinct("restart-reconcile"),
    new Date(Date.parse(receiptAt) + 2_000).toISOString()).status, "completed_evidence_only");
});

test("CR10A-OPS-110 checkpoint, HMAC, and deterministic state parsing reject rollback and forgery", () => {
  const { plan } = context(), current = markReady(plan), wrong = new OperationsRetentionCleanupAuthenticatorV1(
    current.value.identityDigest, new Uint8Array(32).fill(0x72), current.checkpoints, { testOnly: true });
  assert.throws(() => wrong.verify(current.marked));
  assert.throws(() => current.value.verify(current.started));
  const forged = clone(current.marked) as unknown as Record<string, unknown>;
  forged.safeStatusCode = "forged_status"; delete forged.stateDigest; forged.stateDigest = sha256Digest((() => {
    const material = { ...forged }; delete material.stateAuthTag; delete material.stateDigest; return material;
  })());
  assert.throws(() => current.value.verify(forged));
  const idDriftInput: Record<string, unknown> = { ...clone(current.marked),
    operationId: "cleanup-operation:operations:forged" } as unknown as Record<string, unknown>;
  const idDrift = resign(idDriftInput, "stateDigest");
  assert.throws(() => parseOperationsRetentionCleanupLifecycleV1(idDrift), code("scope_mismatch"));
});

test("CR10A-OPS-110 safe projection authenticates state and exposes no cleanup controls", () => {
  const { plan } = context(), current = markReady(plan), projection = projectOperationsRetentionCleanupV1(
    current.value, plan, current.report, current.marked);
  assert.equal(projection.lifecycleStatus, "synthetic_marker_recorded"); assert.equal(projection.tombstoneRequired, true);
  assert.deepEqual(projection.controls, []); assert.deepEqual(projection.commandLines, []);
  assert.equal(projection.rawMaterialPresent || projection.locatorPresent || projection.performsAction
    || projection.grantsApproval || projection.grantsDeletionAuthority || projection.grantsExecutionAuthority, false);
  assert.throws(() => projectOperationsRetentionCleanupV1({}, plan, current.report, current.marked), code("invalid_input"));
});

test("CR10A-OPS-110 disabled executor stops before client, credential, locator, or effect", () => {
  const { plan } = context(), disabled = createOperationsDisabledRetentionCleanupExecutorV1().prepare(plan);
  assert.equal(disabled.status, "disabled_before_execution");
  assert.equal(disabled.locatorPresent || disabled.clientPresent || disabled.credentialResolutionAttempted
    || disabled.effectAttempted || disabled.performsAction || disabled.grantsApproval
    || disabled.grantsDeletionAuthority || disabled.grantsExecutionAuthority, false);
  assert.throws(() => createOperationsDisabledRetentionCleanupExecutorV1().prepare(clone(plan)), code("unsupported_action"));
});

test("CR10A-OPS-110 hostile wrappers, accessors, Proxies, and binary keys fail without traps", () => {
  const { plan } = context(), adapter = createOperationsRetentionFakeInventoryAdapterV1({ recordSetDigest: plan.recordSetDigest,
    itemCount: 1, totalBytes: 1, activeReferenceCount: 0, legalHoldCount: 0, existingTombstoneCount: 0,
    existingQuarantineCount: 0, inventoryEvidenceDigest: distinct("hostile-inventory"),
    referenceEvidenceDigest: distinct("hostile-reference"), holdEvidenceDigest: distinct("hostile-hold"),
    observedAt: new Date(Date.parse(plan.createdAt) + 1_000).toISOString(),
    validUntil: new Date(Date.parse(plan.createdAt) + 2_000).toISOString() }), input = { plan, adapter };
  const accessor = { ...input }; Object.defineProperty(accessor, "plan", { enumerable: true,
    get() { throw new Error("must not run"); } }); assert.throws(() => runOperationsRetentionCleanupDryRunV1(accessor));
  const proxy = observedProxy(input, "throwing"); assert.throws(() => runOperationsRetentionCleanupDryRunV1(proxy.value));
  assert.equal(proxy.trapCount(), 0);
  const keyProxy = observedProxy(new Uint8Array(32).fill(0x73), "throwing");
  assert.throws(() => new OperationsRetentionCleanupAuthenticatorV1(distinct("hostile-key"), keyProxy.value as never,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), { testOnly: true })); assert.equal(keyProxy.trapCount(), 0);
  const shared = new Uint8Array(new SharedArrayBuffer(32));
  assert.throws(() => new OperationsRetentionCleanupAuthenticatorV1(distinct("shared-key"), shared,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), { testOnly: true }));
});

test("CR10A-OPS-110 receipt parser rejects re-signed action-specific evidence aliases", () => {
  const { plan } = context(), current = markReady(plan), receiptAt = new Date(Date.parse(current.marked.updatedAt) + 1_000).toISOString(),
    received = current.value.recordSyntheticReceipt(current.marked, successInput(plan, receiptAt)), receipt = received.receipt!;
  const aliasInput = clone(receipt) as unknown as Record<string, unknown>;
  delete aliasInput.tombstoneEvidenceDigest; aliasInput.quarantineEvidenceDigest = distinct("alias");
  const alias = resign(aliasInput, "receiptDigest");
  assert.throws(() => parseOperationsRetentionCleanupReceiptV1(alias));
});

test("CR10A-OPS-110 implementation imports no filesystem, process, database, storage, provider, or network client", () => {
  const protectedSource = readFileSync("src/operations/v1/retention-cleanup-dry-run.ts", "utf8"),
    sources = [protectedSource, readFileSync("scripts/operations-retention-cleanup-dry-run.ts", "utf8")].join("\n");
  assert.doesNotMatch(sources, /node:(?:child_process|fs|net|tls|http|https)|from ["']postgres["']|@aws-sdk|cloudflare|fetch\s*\(|unlink\s*\(|rm\s+-/);
  assert.doesNotMatch(protectedSource, /process\./);
});
