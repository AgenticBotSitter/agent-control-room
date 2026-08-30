import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessOperationsDataDispositionV1,
  buildOperationsDataClassRegistryV1,
  buildOperationsDataDispositionProposalV1,
  buildOperationsDataDispositionRequestV1,
  buildOperationsLegalHoldReleaseEvidenceV1,
  buildOperationsLegalHoldV1,
  buildOperationsPrivacyRetentionPolicyV1,
  buildOperationsRetentionEvidenceV1,
  buildOperationsSyntheticPrivacyRetentionPolicyV1,
  createOperationsDisabledDataDispositionExecutorV1,
  OPERATIONS_DATA_CLASS_IDS_V1,
  OPERATIONS_DATA_DISPOSITION_GATE_CODES_V1,
  OperationsContractErrorV1,
  parseOperationsDataClassDefinitionV1,
  parseOperationsDataClassRegistryV1,
  parseOperationsDataDispositionAssessmentV1,
  parseOperationsDataDispositionProposalV1,
  parseOperationsDataDispositionRequestV1,
  parseOperationsPrivacyRetentionPolicyV1,
  parseOperationsRetentionEvidenceV1,
  projectOperationsPrivacyV1,
  type OperationsDataClassIdV1,
  type OperationsDataDispositionRequestV1,
  type OperationsLegalHoldReleaseEvidenceV1,
  type OperationsLegalHoldV1,
  type OperationsPrivacyRetentionPolicyV1,
} from "../src/operations/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const BASE = "2026-08-30T08:00:00.000Z";
const scope = { tenantId: "tenant:operations:privacy", workspaceId: "workspace:operations:privacy",
  projectId: "project:operations:privacy" } as const;
const distinct = (label: string) => sha256Digest({ test: "operations-privacy-retention", label });
const atDay = (days: number) => new Date(Date.parse(BASE) + days * 86_400_000).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const code = (safeCode: string) => (error: unknown) => error instanceof OperationsContractErrorV1 && error.safeCode === safeCode;
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}
function fixture() {
  const registry = buildOperationsDataClassRegistryV1();
  const policy = buildOperationsSyntheticPrivacyRetentionPolicyV1({ ...scope, effectiveAt: BASE });
  return { registry, policy };
}
function request(policy: OperationsPrivacyRetentionPolicyV1, dataClassId: OperationsDataClassIdV1,
  requestKind: "retention_expiry" | "owner_deletion_request" | "subject_erasure_request" | "quarantine_review" = "retention_expiry",
  subjectReferenceDigest?: string): OperationsDataDispositionRequestV1 {
  return buildOperationsDataDispositionRequestV1({ policy, dataClassId, recordSetDigest: distinct(`records:${dataClassId}`),
    requestKind, ...(subjectReferenceDigest ? { subjectReferenceDigest } : {}), requestedAt: atDay(1) });
}
function evidence(registry: ReturnType<typeof buildOperationsDataClassRegistryV1>, policy: OperationsPrivacyRetentionPolicyV1,
  target: OperationsDataDispositionRequestV1, options: { day?: number; allKnown?: boolean; horizonDay?: number;
    referencesAbsent?: boolean } = {}) {
  const definition = registry.definitions.find((item) => item.dataClassId === target.dataClassId)!;
  const allKnown = options.allKnown ?? true;
  const horizonDay = options.horizonDay ?? 20;
  return buildOperationsRetentionEvidenceV1({ registry, policy, request: target, clockStartedAt: BASE,
    evaluatedAt: atDay(options.day ?? 31), allDependencyHorizonsKnown: allKnown,
    ...(definition.dependencyHorizonRequired && allKnown ? { maximumDependencyHorizonAt: atDay(horizonDay) } : {}),
    activeReferencesAbsent: options.referencesAbsent ?? true, referenceEvidenceDigest: distinct("reference-evidence"),
    inventoryEvidenceDigest: distinct("inventory-evidence"), auditChainHeadDigest: distinct("audit-head") });
}
function assessment(registry: ReturnType<typeof buildOperationsDataClassRegistryV1>, policy: OperationsPrivacyRetentionPolicyV1,
  target: OperationsDataDispositionRequestV1, options: { day?: number; allKnown?: boolean; horizonDay?: number;
    referencesAbsent?: boolean; holds?: OperationsLegalHoldV1[]; releases?: OperationsLegalHoldReleaseEvidenceV1[] } = {}) {
  return assessOperationsDataDispositionV1({ registry, policy, request: target,
    evidence: evidence(registry, policy, target, options), holds: options.holds ?? [], releases: options.releases ?? [] });
}
function ruleInputs(registry: ReturnType<typeof buildOperationsDataClassRegistryV1>) {
  return registry.definitions.map((definition) => ({ dataClassId: definition.dataClassId,
    retentionState: definition.retentionKind === "source_authoritative" ? "source_authoritative" as const
      : definition.retentionKind === "indefinite_preservation" ? "indefinite_preservation" as const
        : "configured_duration" as const,
    ...(definition.retentionKind === "source_authoritative" ? { sourcePolicyDigest: distinct(`source:${definition.dataClassId}`) }
      : definition.retentionKind === "indefinite_preservation" ? {} : { retainForDays: 30 }) }));
}

test("CR10A-OPS-100 freezes fourteen exact data classes and preserves audit and replay invariants", () => {
  const registry = buildOperationsDataClassRegistryV1();
  assert.equal(registry.definitions.length, 14);
  assert.deepEqual(registry.definitions.map((item) => item.dataClassId), [...OPERATIONS_DATA_CLASS_IDS_V1]);
  assert.deepEqual(parseOperationsDataClassRegistryV1(registry), registry);
  const audit = registry.definitions.find((item) => item.dataClassId.endsWith("audit-security"))!;
  const replay = registry.definitions.find((item) => item.dataClassId.endsWith("effect-replay"))!;
  assert.equal(audit.retentionKind, "indefinite_preservation");
  assert.equal(audit.dispositionMode, "never_delete_full_record");
  assert.equal(audit.auditPreservation, "append_only_full_record");
  assert.equal(replay.dependencyHorizonRequired, true);
  assert.equal(replay.dispositionMode, "compact_to_digest_tombstone_review");
  assert.equal(registry.rawMaterialPresent || registry.locatorValuesPresent || registry.makesLegalDeterminations
    || registry.grantsApproval || registry.grantsDeletionAuthority || registry.grantsExecutionAuthority, false);
});

test("CR10A-OPS-100 rejects re-signed data-class and registry semantic drift", () => {
  const registry = buildOperationsDataClassRegistryV1(), changed = clone(registry.definitions[0]!);
  changed.dispositionMode = "delete_body_review";
  const signedDefinition = resign(changed as unknown as Record<string, unknown>, "definitionDigest");
  assert.throws(() => parseOperationsDataClassDefinitionV1(signedDefinition), code("scope_mismatch"));
  const forgedRegistry = clone(registry) as unknown as Record<string, unknown>;
  (forgedRegistry.definitions as unknown[])[0] = signedDefinition;
  assert.throws(() => parseOperationsDataClassRegistryV1(resign(forgedRegistry, "registryDigest")), code("scope_mismatch"));
});

test("CR10A-OPS-100 policy is exact, ordered, revision-linked, external-law-only, and authority-free", () => {
  const { registry, policy } = fixture();
  assert.deepEqual(parseOperationsPrivacyRetentionPolicyV1(policy, registry), policy);
  assert.deepEqual(policy.rules.map((item) => item.dataClassId), [...OPERATIONS_DATA_CLASS_IDS_V1]);
  assert.equal(policy.rules.find((item) => item.dataClassId.endsWith("audit-security"))?.retentionState,
    "indefinite_preservation");
  assert.equal(policy.rules.find((item) => item.dataClassId.endsWith("public-artifact-body"))?.retentionState,
    "source_authoritative");
  assert.equal(policy.rules.find((item) => item.dataClassId.endsWith("private-artifact-body"))?.retainForDays, 30);
  assert.equal(!policy.legalRulesSuppliedExternally || policy.makesLegalDeterminations || policy.defaultDeletionAllowed
    || policy.automaticDispositionAllowed || policy.nativeExecutorPresent || policy.grantsApproval
    || policy.grantsDeletionAuthority || policy.grantsExecutionAuthority, false);
  const revision = buildOperationsPrivacyRetentionPolicyV1({ registry, policyId: policy.policyId, revision: 2,
    previousPolicyDigest: policy.policyDigest, ...scope, rules: ruleInputs(registry), effectiveAt: atDay(2) });
  assert.equal(revision.previousPolicyDigest, policy.policyDigest);
  assert.throws(() => buildOperationsPrivacyRetentionPolicyV1({ registry, policyId: policy.policyId, revision: 2,
    ...scope, rules: ruleInputs(registry), effectiveAt: atDay(2) }), code("scope_mismatch"));
});

test("CR10A-OPS-100 rejects re-signed rule identifiers, order, source, and retention-state drift", () => {
  const { registry, policy } = fixture();
  for (const mutate of [
    (value: typeof policy) => { value.rules[0]!.ruleId = "rule:operations:privacy:invented"; },
    (value: typeof policy) => { value.rules.reverse(); },
    (value: typeof policy) => { delete value.rules.find((item) => item.dataClassId.endsWith("public-artifact-body"))!.sourcePolicyDigest; },
    (value: typeof policy) => { value.rules.find((item) => item.dataClassId.endsWith("audit-security"))!.retentionState = "configured_duration"; },
  ]) {
    const changed = clone(policy); mutate(changed);
    changed.rules = changed.rules.map((rule) => resign(rule as unknown as Record<string, unknown>, "ruleDigest") as never);
    assert.throws(() => parseOperationsPrivacyRetentionPolicyV1(
      resign(changed as unknown as Record<string, unknown>, "policyDigest"), registry), code("scope_mismatch"));
  }
});

test("CR10A-OPS-100 disposition requests bind exact project scope and store only a subject digest", () => {
  const { policy } = fixture(), subject = distinct("subject"), target = request(policy,
    "data-class:operations:private-artifact-body", "subject_erasure_request", subject);
  assert.deepEqual(parseOperationsDataDispositionRequestV1(target), target);
  assert.equal(target.tenantId, scope.tenantId); assert.equal(target.subjectReferenceDigest, subject);
  assert.equal(target.rawSubjectPresent || target.rawMaterialPresent || target.locatorValuePresent || target.makesLegalDetermination
    || target.performsAction || target.grantsApproval || target.grantsDeletionAuthority || target.grantsExecutionAuthority, false);
  assert.throws(() => request(policy, "data-class:operations:private-artifact-body", "subject_erasure_request"), code("scope_mismatch"));
  assert.throws(() => request(policy, "data-class:operations:private-artifact-body", "owner_deletion_request", subject), code("scope_mismatch"));
  const forged = resign({ ...clone(target), requestId: "request:operations:privacy:forged" } as unknown as Record<string, unknown>, "requestDigest");
  assert.throws(() => parseOperationsDataDispositionRequestV1(forged), code("scope_mismatch"));
});

test("CR10A-OPS-100 retention expiry is not due early and becomes review-only after every horizon", () => {
  const { registry, policy } = fixture(), target = request(policy, "data-class:operations:private-artifact-body");
  assert.equal(assessment(registry, policy, target, { day: 29 }).disposition, "not_due");
  const due = assessment(registry, policy, target, { day: 31 });
  assert.equal(due.disposition, "deletion_review_candidate");
  assert.equal(due.candidateActionPresent, true); assert.equal(due.performsAction, false);
  assert.equal(assessment(registry, policy, target, { day: 40, horizonDay: 50 }).disposition, "not_due");
  assert.equal(assessment(registry, policy, target, { day: 51, horizonDay: 50 }).disposition, "deletion_review_candidate");
});

test("CR10A-OPS-100 unknown dependency horizons and active references fail closed", () => {
  const { registry, policy } = fixture(), target = request(policy, "data-class:operations:effect-replay");
  assert.equal(assessment(registry, policy, target, { allKnown: false }).disposition, "blocked_unknown_horizon");
  assert.equal(assessment(registry, policy, target, { referencesAbsent: false }).disposition, "blocked_active_reference");
  const forgedEvidence = evidence(registry, policy, target), changed = resign({ ...clone(forgedEvidence),
    evidenceId: "evidence:operations:privacy:forged" } as unknown as Record<string, unknown>, "evidenceDigest");
  assert.throws(() => parseOperationsRetentionEvidenceV1(changed), code("scope_mismatch"));
});

test("CR10A-OPS-100 an unconfigured policy never invents a deletion deadline", () => {
  const registry = buildOperationsDataClassRegistryV1(), rules: Array<{ dataClassId: OperationsDataClassIdV1;
    retentionState: "configured_duration" | "blocked_unconfigured" | "source_authoritative" | "indefinite_preservation";
    retainForDays?: number; sourcePolicyDigest?: string }> = ruleInputs(registry), position = rules.findIndex((item) =>
    item.dataClassId === "data-class:operations:private-artifact-body");
  rules[position] = { dataClassId: "data-class:operations:private-artifact-body", retentionState: "blocked_unconfigured" };
  const policy = buildOperationsPrivacyRetentionPolicyV1({ registry, policyId: "policy:operations:privacy:unconfigured",
    revision: 1, ...scope, rules, effectiveAt: BASE }), target = request(policy, "data-class:operations:private-artifact-body");
  assert.equal(assessment(registry, policy, target, { day: 365 }).disposition, "blocked_policy_unconfigured");
});

test("CR10A-OPS-100 a legal hold wins over expiry, owner request, subject request, and quarantine", () => {
  const { registry, policy } = fixture(), subject = distinct("held-subject");
  const hold = buildOperationsLegalHoldV1({ holdId: "legal-hold:operations:privacy:one", ...scope,
    dataClassIds: ["data-class:operations:private-artifact-body"], subjectReferenceDigest: subject,
    authorityEvidenceDigest: distinct("hold-authority"), basisReferenceDigest: distinct("hold-basis"), effectiveAt: BASE });
  for (const [kind, subjectDigest] of [["retention_expiry"], ["owner_deletion_request"],
    ["subject_erasure_request", subject], ["quarantine_review"]] as const) {
    const target = request(policy, "data-class:operations:private-artifact-body", kind, subjectDigest);
    assert.equal(assessment(registry, policy, target, { holds: [hold] }).disposition, "blocked_legal_hold");
  }
  assert.equal(hold.controlRoomDeterminedLegalNeed || !hold.preventsDisposition || hold.performsAction
    || hold.grantsApproval || hold.grantsDeletionAuthority || hold.grantsExecutionAuthority, false);
});

test("CR10A-OPS-100 hold release is evidence-only and can restore review eligibility but never deletes", () => {
  const { registry, policy } = fixture(), target = request(policy, "data-class:operations:private-artifact-body"),
    hold = buildOperationsLegalHoldV1({ holdId: "legal-hold:operations:privacy:release", ...scope,
      dataClassIds: [target.dataClassId], authorityEvidenceDigest: distinct("hold-authority-release"),
      basisReferenceDigest: distinct("hold-basis-release"), effectiveAt: BASE }),
    release = buildOperationsLegalHoldReleaseEvidenceV1({ hold, authorityEvidenceDigest: distinct("release-authority"),
      basisReferenceDigest: distinct("release-basis"), releasedAt: atDay(30) });
  assert.equal(assessment(registry, policy, target, { day: 20, holds: [hold], releases: [release] }).disposition,
    "blocked_legal_hold");
  assert.equal(assessment(registry, policy, target, { day: 31, holds: [hold], releases: [release] }).disposition,
    "deletion_review_candidate");
  assert.equal(!release.evidenceOnly || !release.doesNotDelete || release.performsAction || release.grantsApproval
    || release.grantsDeletionAuthority || release.grantsExecutionAuthority, false);
  const foreignHold = buildOperationsLegalHoldV1({ holdId: "legal-hold:operations:privacy:foreign",
    tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: "project:operations:foreign",
    dataClassIds: [target.dataClassId], authorityEvidenceDigest: distinct("foreign-authority"),
    basisReferenceDigest: distinct("foreign-basis"), effectiveAt: BASE });
  assert.throws(() => assessment(registry, policy, target, { holds: [foreignHold] }), code("scope_mismatch"));
});

test("CR10A-OPS-100 append-only audit records remain preserved under every request kind", () => {
  const { registry, policy } = fixture();
  for (const kind of ["retention_expiry", "owner_deletion_request", "quarantine_review"] as const) {
    const target = request(policy, "data-class:operations:audit-security", kind);
    const value = assessment(registry, policy, target);
    assert.equal(value.disposition, "blocked_audit_preservation");
    assert.equal(value.candidateActionPresent, false); assert.equal(value.auditRecordPreserved, true);
  }
});

test("CR10A-OPS-100 replay truth compacts to a tombstone; source content reconciles at its source", () => {
  const { registry, policy } = fixture(), replay = assessment(registry, policy,
    request(policy, "data-class:operations:effect-replay")), source = assessment(registry, policy,
    request(policy, "data-class:operations:public-artifact-body"));
  assert.equal(replay.disposition, "digest_tombstone_review_candidate");
  assert.equal(buildOperationsDataDispositionProposalV1(replay).candidateAction, "compact_to_digest_tombstone_candidate");
  assert.equal(buildOperationsDataDispositionProposalV1(replay).tombstoneRequired, true);
  assert.equal(source.disposition, "source_reconciliation_review_candidate");
  assert.equal(buildOperationsDataDispositionProposalV1(source).candidateAction, "source_reconciliation_candidate");
});

test("CR10A-OPS-100 quarantine remains a separate owner-review route", () => {
  const { registry, policy } = fixture(), target = request(policy, "data-class:operations:quarantine-evidence", "quarantine_review"),
    value = assessment(registry, policy, target), proposal = buildOperationsDataDispositionProposalV1(value);
  assert.equal(value.disposition, "quarantine_review_candidate"); assert.equal(proposal.candidateAction, "quarantine_candidate");
  assert.equal(proposal.performsAction || proposal.grantsApproval || proposal.grantsDeletionAuthority
    || proposal.grantsExecutionAuthority, false);
});

test("CR10A-OPS-100 every candidate carries ten missing gates and the executor is disabled", () => {
  const { registry, policy } = fixture(), value = assessment(registry, policy,
    request(policy, "data-class:operations:private-artifact-body")), proposal = buildOperationsDataDispositionProposalV1(value);
  assert.deepEqual(proposal.requiredGateCodes, [...OPERATIONS_DATA_DISPOSITION_GATE_CODES_V1]);
  assert.equal(proposal.ownerDecisionPresent || proposal.effectClaimPresent || proposal.preEffectMarkerPresent
    || proposal.terminalReceiptPresent || proposal.independentAbsenceEvidencePresent || proposal.nativeExecutorPresent
    || proposal.performsAction || proposal.grantsApproval || proposal.grantsDeletionAuthority || proposal.grantsExecutionAuthority, false);
  const disabled = createOperationsDisabledDataDispositionExecutorV1().prepare(proposal);
  assert.equal(disabled.status, "disabled_before_execution");
  assert.equal(disabled.clientPresent || disabled.credentialResolutionAttempted || disabled.effectAttempted
    || disabled.performsAction || disabled.grantsApproval || disabled.grantsDeletionAuthority || disabled.grantsExecutionAuthority, false);
  assert.throws(() => createOperationsDisabledDataDispositionExecutorV1().prepare(clone(proposal)), code("unsupported_action"));
});

test("CR10A-OPS-100 proposal and assessment parsers reject re-signed deterministic identity drift", () => {
  const { registry, policy } = fixture(), value = assessment(registry, policy,
    request(policy, "data-class:operations:private-artifact-body")), changedAssessment = resign({ ...clone(value),
      assessmentId: "assessment:operations:privacy:forged" } as unknown as Record<string, unknown>, "assessmentDigest");
  assert.throws(() => parseOperationsDataDispositionAssessmentV1(changedAssessment), code("scope_mismatch"));
  const proposal = buildOperationsDataDispositionProposalV1(value), changedProposal = resign({ ...clone(proposal),
    requiredGateCodes: [...proposal.requiredGateCodes].reverse() } as unknown as Record<string, unknown>, "proposalDigest");
  assert.throws(() => parseOperationsDataDispositionProposalV1(changedProposal), code("scope_mismatch"));
});

test("CR10A-OPS-100 privacy projection is scope-bound, bounded, digest-only, and control-free", () => {
  const { registry, policy } = fixture(), values = [
    assessment(registry, policy, request(policy, "data-class:operations:private-artifact-body")),
    assessment(registry, policy, request(policy, "data-class:operations:effect-replay")),
  ], projection = projectOperationsPrivacyV1(policy, values);
  assert.equal(projection.cards.length, 2); assert.equal(projection.configuredClassCount, 14);
  assert.deepEqual(projection.controls, []); assert.deepEqual(projection.commandLines, []);
  assert.equal(projection.rawMaterialPresent || projection.locatorValuesPresent || projection.performsAction
    || projection.grantsApproval || projection.grantsDeletionAuthority || projection.grantsExecutionAuthority, false);
  const foreignPolicy = buildOperationsSyntheticPrivacyRetentionPolicyV1({ tenantId: scope.tenantId,
    workspaceId: scope.workspaceId, projectId: "project:operations:foreign", effectiveAt: BASE });
  assert.throws(() => projectOperationsPrivacyV1(foreignPolicy, values), code("scope_mismatch"));
});

test("CR10A-OPS-100 hostile inputs reject extras, accessors, and Proxies without invoking traps", () => {
  const { policy } = fixture(), input = { policy, dataClassId: "data-class:operations:private-artifact-body" as const,
    recordSetDigest: distinct("hostile-records"), requestKind: "retention_expiry" as const, requestedAt: atDay(1) };
  assert.throws(() => buildOperationsDataDispositionRequestV1({ ...input, rawBody: "forbidden" }));
  const accessor = { ...input }; Object.defineProperty(accessor, "recordSetDigest", { enumerable: true,
    get() { throw new Error("must not run"); } });
  assert.throws(() => buildOperationsDataDispositionRequestV1(accessor));
  const proxy = observedProxy(input, "throwing"); assert.throws(() => buildOperationsDataDispositionRequestV1(proxy.value));
  assert.equal(proxy.trapCount(), 0);
  const syntheticInput = { ...scope, effectiveAt: BASE }, syntheticProxy = observedProxy(syntheticInput, "throwing");
  assert.throws(() => buildOperationsSyntheticPrivacyRetentionPolicyV1(syntheticProxy.value));
  assert.equal(syntheticProxy.trapCount(), 0);
  const arrayProxy = observedProxy([], "throwing"); assert.throws(() => projectOperationsPrivacyV1(policy, arrayProxy.value));
  assert.equal(arrayProxy.trapCount(), 0);
});

test("CR10A-OPS-100 implementation has no filesystem, process, database, provider, or network effect client", () => {
  const source = readFileSync("src/operations/v1/privacy-retention.ts", "utf8");
  assert.doesNotMatch(source, /node:(?:child_process|fs|net|tls|http|https)|from ["']postgres["']|@aws-sdk|cloudflare|fetch\s*\(|process\.|rm\s+-|unlink\s*\(/);
});
