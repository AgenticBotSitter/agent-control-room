import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ABS_NEWS_PUBLICATION_GATE_IDS_V1,
  buildAbsNewsPublicationDisabledDispositionV1,
  buildAbsNewsPublicationPrerequisiteV1,
  buildAbsNewsPublicationReadinessAssessmentV1,
  buildCurrentAbsNewsPublicationDisabledDispositionV1,
  parseAbsNewsPublicationDisabledDispositionV1,
  parseAbsNewsPublicationReadinessAssessmentV1,
  SqliteAbsNewsPublicationReadinessStoreV1,
} from "../src/project-adapters/abs-news/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const scope = { tenantId: "tenant:abs", workspaceId: "workspace:abs:news", projectId: "project:abs:news" };
const key = new Uint8Array(32).fill(83);
const checkedAt = "2026-08-29T16:00:00.000Z";
const recordedAt = "2026-08-29T16:01:00.000Z";

function prerequisites(state: "met" | "missing" = "missing", at = checkedAt) {
  return ABS_NEWS_PUBLICATION_GATE_IDS_V1.map((gateId) => buildAbsNewsPublicationPrerequisiteV1(state === "missing"
    ? { gateId, state, checkedAt: at, safeReasonCode: `missing_${gateId}` }
    : { gateId, state, evidenceDigest: sha256Digest({ gateId, evidence: "qualified" }), checkedAt: at,
      validUntil: "2026-08-29T17:00:00.000Z", safeReasonCode: `qualified_${gateId}` }));
}

function blocked(overrides: Partial<{ assessmentId: string; tenantId: string; assessedAt: string }> = {}) {
  const assessedAt = overrides.assessedAt ?? checkedAt;
  const assessment = buildAbsNewsPublicationReadinessAssessmentV1({
    assessmentId: overrides.assessmentId ?? "assessment:abs:publication:blocked",
    ...scope,
    ...(overrides.tenantId ? { tenantId: overrides.tenantId } : {}),
    prerequisites: prerequisites("missing", assessedAt),
    assessedAt,
  });
  return { assessment, disposition: buildAbsNewsPublicationDisabledDispositionV1({ assessment,
    recordedAt: new Date(Date.parse(assessedAt) + 60_000).toISOString() }) };
}

async function location(label = "ledger") {
  const directory = await mkdtemp(join(tmpdir(), "abs-publication-readiness-"));
  return { directory, path: join(directory, `${label}.sqlite`) };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === code;
}

test("CR9D-ABS-080 records the current truth as disabled with every required gate explicit", () => {
  const current = buildCurrentAbsNewsPublicationDisabledDispositionV1();
  assert.deepEqual(current.assessment.blockingGateIds, ABS_NEWS_PUBLICATION_GATE_IDS_V1);
  assert.deepEqual(current.disposition.blockingGateIds, ABS_NEWS_PUBLICATION_GATE_IDS_V1);
  assert.deepEqual({ readiness: current.assessment.readiness, eligible: current.assessment.eligibleForOwnerApproval,
    implemented: current.assessment.liveExecutionImplemented, authorized: current.disposition.publicationAuthorized,
    attempted: current.disposition.actualPublicationAttempted, mutation: current.disposition.publicMutationObserved,
    effect: current.disposition.externalEffectOccurred, retry: current.disposition.automaticRetryAllowed,
    checkpoint: current.disposition.requiresIndependentCheckpoint }, { readiness: "blocked", eligible: false,
    implemented: false, authorized: false, attempted: false, mutation: false, effect: false, retry: false, checkpoint: true });
  assert.deepEqual(parseAbsNewsPublicationReadinessAssessmentV1(current.assessment), current.assessment);
  assert.deepEqual(parseAbsNewsPublicationDisabledDispositionV1(current.disposition), current.disposition);
});

test("CR9D-ABS-080 complete evidence creates only a candidate for fresh owner approval, never publication authority", () => {
  const assessment = buildAbsNewsPublicationReadinessAssessmentV1({ assessmentId: "assessment:abs:publication:candidate", ...scope,
    candidatePackageId: "package:abs:article:r1", candidatePackageDigest: sha256Digest({ package: 1 }),
    candidateDestinationId: "destination:abs:public", candidateDestinationDigest: sha256Digest({ destination: "public" }),
    prerequisites: prerequisites("met"), assessedAt: checkedAt });
  assert.deepEqual({ readiness: assessment.readiness, blockers: assessment.blockingGateIds, eligible: assessment.eligibleForOwnerApproval,
    freshApproval: assessment.requiresFreshOwnerApproval, resolution: assessment.requiresAuthoritativeResolution,
    implemented: assessment.liveExecutionImplemented, authorized: assessment.publicationAuthorized,
    approval: assessment.grantsApproval, execution: assessment.grantsExecutionAuthority }, { readiness: "candidate", blockers: [],
    eligible: true, freshApproval: true, resolution: true, implemented: false, authorized: false, approval: false, execution: false });
  assert.throws(() => buildAbsNewsPublicationDisabledDispositionV1({ assessment, recordedAt }), errorCode("unsupported_action"));
});

test("CR9D-ABS-080 exact readiness boundary rejects partial identities, expired evidence drift, aliases, accessors, and Proxies", () => {
  assert.throws(() => buildAbsNewsPublicationReadinessAssessmentV1({ assessmentId: "assessment:partial", ...scope,
    candidatePackageId: "package:partial", prerequisites: prerequisites("met"), assessedAt: checkedAt }),
  ProjectWorkspaceContractErrorV1);
  const reversed = prerequisites("missing").reverse();
  assert.throws(() => buildAbsNewsPublicationReadinessAssessmentV1({ assessmentId: "assessment:order", ...scope,
    prerequisites: reversed, assessedAt: checkedAt }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => buildAbsNewsPublicationPrerequisiteV1({ gateId: ABS_NEWS_PUBLICATION_GATE_IDS_V1[0], state: "expired",
    evidenceDigest: sha256Digest({ evidence: 1 }), checkedAt, validUntil: "2026-08-29T16:30:00.000Z",
    safeReasonCode: "expired_destination" }), ProjectWorkspaceContractErrorV1);
  const value = blocked().assessment;
  assert.throws(() => parseAbsNewsPublicationReadinessAssessmentV1({ ...value, projectId: "project:alias" }), errorCode("digest_mismatch"));
  let calls = 0;
  const accessor = { ...value };
  Object.defineProperty(accessor, "assessmentId", { enumerable: true, get() { calls += 1; return value.assessmentId; } });
  assert.throws(() => parseAbsNewsPublicationReadinessAssessmentV1(accessor), ProjectWorkspaceContractErrorV1);
  assert.equal(calls, 0);
  const proxied = observedProxy(value, "transparent");
  assert.throws(() => parseAbsNewsPublicationReadinessAssessmentV1(proxied.value), ProjectWorkspaceContractErrorV1);
  assert.equal(proxied.trapCount(), 0);
  const dispositionInput = observedProxy({ assessment: value, recordedAt }, "transparent");
  assert.throws(() => buildAbsNewsPublicationDisabledDispositionV1(dispositionInput.value), ProjectWorkspaceContractErrorV1);
  assert.equal(dispositionInput.trapCount(), 0);
});

test("CR9D-ABS-080 disabled disposition is durable, append-only, restart-safe, and exact replay is inert", async () => {
  const target = await location();
  try {
    const value = blocked();
    let store = new SqliteAbsNewsPublicationReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    assert.equal(store.latest(), undefined);
    assert.equal(store.record(value).replayed, false);
    const before = store.verifyIntegrity();
    assert.deepEqual(before, { revision: 2, recordCount: 2, stateDigest: before.stateDigest });
    assert.deepEqual(store.latest(), value);
    assert.equal(store.record(value).replayed, true);
    assert.deepEqual(store.verifyIntegrity(), before);
    store.close();
    store = new SqliteAbsNewsPublicationReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "open" });
    assert.deepEqual(store.latest(), value);
    assert.deepEqual(store.verifyIntegrity(), before);
    store.close();
  } finally {
    await rm(target.directory, { recursive: true, force: true });
  }
});

test("CR9D-ABS-080 ledger rejects time rollback, same-ID drift, cross-scope evidence, and incomplete pairs", async () => {
  const target = await location();
  try {
    const current = blocked();
    const store = new SqliteAbsNewsPublicationReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    const proxied = observedProxy(current, "transparent");
    assert.throws(() => store.record(proxied.value), ProjectWorkspaceContractErrorV1);
    assert.equal(proxied.trapCount(), 0);
    store.record(current);
    const old = blocked({ assessmentId: "assessment:abs:publication:old", assessedAt: "2026-08-29T15:00:00.000Z" });
    assert.throws(() => store.record(old), errorCode("unsupported_action"));
    const drift = blocked({ assessedAt: "2026-08-29T16:15:00.000Z" });
    assert.throws(() => store.record(drift), errorCode("replay_drift"));
    const foreign = blocked({ assessmentId: "assessment:abs:publication:foreign", tenantId: "tenant:foreign",
      assessedAt: "2026-08-29T16:30:00.000Z" });
    assert.throws(() => store.record(foreign), errorCode("scope_mismatch"));
    assert.throws(() => store.record({ assessment: current.assessment, disposition: undefined }), ProjectWorkspaceContractErrorV1);
    const { dispositionDigest: _digest, ...dispositionMaterial } = current.disposition;
    void _digest;
    const earlyMaterial = { ...dispositionMaterial, recordedAt: "2026-08-29T15:59:00.000Z" };
    assert.throws(() => store.record({ assessment: current.assessment,
      disposition: { ...earlyMaterial, dispositionDigest: sha256Digest(earlyMaterial) } }), errorCode("replay_drift"));
    store.close();
  } finally {
    await rm(target.directory, { recursive: true, force: true });
  }
});

test("CR9D-ABS-080 ledger detects authenticated deletion, metadata drift, injected schema, and a wrong integrity key", async () => {
  for (const attack of ["deletion", "metadata", "schema", "wrong_key"] as const) {
    const target = await location(attack);
    try {
      const store = new SqliteAbsNewsPublicationReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
      store.record(blocked());
      store.close();
      if (attack === "wrong_key") {
        assert.throws(() => new SqliteAbsNewsPublicationReadinessStoreV1(target.path, scope,
          { integrityKey: new Uint8Array(32).fill(84), mode: "open" }), errorCode("integrity_failed"));
        continue;
      }
      const attacker = new DatabaseSync(target.path);
      if (attack === "deletion") attacker.exec("DELETE FROM abs_news_publication_readiness_records WHERE kind='disposition'");
      if (attack === "metadata") attacker.exec("UPDATE abs_news_publication_readiness_metadata SET revision=999");
      if (attack === "schema") attacker.exec("CREATE TRIGGER readiness_injected AFTER INSERT ON abs_news_publication_readiness_records BEGIN SELECT 1; END");
      attacker.close();
      assert.throws(() => new SqliteAbsNewsPublicationReadinessStoreV1(target.path, scope,
        { integrityKey: key, mode: "open" }), errorCode("integrity_failed"));
    } finally {
      await rm(target.directory, { recursive: true, force: true });
    }
  }
});

test("CR9D-ABS-080 a new blocked assessment advances truth without erasing the prior disposition", async () => {
  const target = await location();
  try {
    const store = new SqliteAbsNewsPublicationReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    const first = blocked();
    const second = blocked({ assessmentId: "assessment:abs:publication:recheck", assessedAt: "2026-08-29T16:30:00.000Z" });
    store.record(first);
    store.record(second);
    assert.deepEqual(store.latest(), second);
    assert.deepEqual(store.verifyIntegrity(), { revision: 3, recordCount: 4, stateDigest: store.verifyIntegrity().stateDigest });
    store.close();
    const db = new DatabaseSync(target.path, { readOnly: true });
    const count = Number((db.prepare("SELECT count(*) count FROM abs_news_publication_readiness_records").get() as { count: number }).count);
    db.close();
    assert.equal(count, 4);
  } finally {
    await rm(target.directory, { recursive: true, force: true });
  }
});
