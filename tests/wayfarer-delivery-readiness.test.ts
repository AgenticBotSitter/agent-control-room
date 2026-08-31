import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import {
  buildCurrentWayfarerDeliveryDisabledV1,
  buildCurrentWayfarerDeliveryReadinessDisabledV1,
  buildWayfarerDeliveryApprovalRequestV1,
  buildWayfarerDeliveryCandidateFixtureV1,
  buildWayfarerDeliveryDisabledDispositionV1,
  buildWayfarerDeliveryReadinessAssessmentV1,
  buildWayfarerDeliveryReadinessPrerequisiteV1,
  buildWayfarerDeliveryRequestV1,
  parseWayfarerDeliveryDestinationV1,
  parseWayfarerDeliveryDisabledDispositionV1,
  parseWayfarerDeliveryReadinessAssessmentV1,
  parseWayfarerDeliveryRequestV1,
  SqliteWayfarerDeliveryReadinessStoreV1,
  WAYFARER_DELIVERY_READINESS_GATE_IDS_V1,
  type WayfarerDeliveryBoundaryIdV1,
  type WayfarerDeliveryReadinessRecordV1,
} from "../src/project-adapters/wayfarer/v1";
import { sha256Digest } from "../src/security";

const key = new Uint8Array(32).fill(113);
function safeCode(code: string) {
  return (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1 && value.safeCode === code;
}
function clone<T>(value: T): T { return structuredClone(value); }
function resign<T extends Record<string, unknown>>(value: T, keyName: string): T {
  const material = { ...value };
  delete material[keyName];
  return { ...value, [keyName]: sha256Digest(material) };
}
async function location(label = "case") {
  const directory = await mkdtemp(join(tmpdir(), `wayfarer-delivery-${label}-`));
  return { directory, path: join(directory, "readiness.sqlite") };
}
function currentRecord(boundary: WayfarerDeliveryBoundaryIdV1): WayfarerDeliveryReadinessRecordV1 {
  return buildCurrentWayfarerDeliveryReadinessDisabledV1().records[boundary === "private_upload" ? 0 : 1];
}
function complete(boundary: WayfarerDeliveryBoundaryIdV1) {
  const prepared = buildCurrentWayfarerDeliveryDisabledV1().package;
  const fixture = buildWayfarerDeliveryCandidateFixtureV1(prepared, boundary);
  const checkedAt = "2026-08-29T23:45:00.000Z";
  const prerequisites = WAYFARER_DELIVERY_READINESS_GATE_IDS_V1.map((gateId, position) =>
    buildWayfarerDeliveryReadinessPrerequisiteV1({ gateId, state: "met",
      evidenceDigest: position === 0 ? prepared.packageDigest : position === 3 ? fixture.destination.destinationDigest
        : sha256Digest({ boundary, gateId, evidence: "authoritative" }), checkedAt,
      ...(position >= 4 ? { validUntil: "2026-08-30T00:00:00.000Z" } : {}),
      safeReasonCode: "authoritative_evidence_verified" }));
  return buildWayfarerDeliveryReadinessAssessmentV1({ assessmentId: `assessment:wayfarer:${boundary}:complete`,
    package: prepared, boundaryId: boundary, candidateDestinationId: fixture.destination.destinationId,
    candidateDestinationDigest: fixture.destination.destinationDigest, prerequisites, assessedAt: checkedAt });
}

test("CR9B-WF-110 private upload and public publication have different exact destination identities", () => {
  const prepared = buildCurrentWayfarerDeliveryDisabledV1().package;
  const upload = buildWayfarerDeliveryCandidateFixtureV1(prepared, "private_upload");
  const publish = buildWayfarerDeliveryCandidateFixtureV1(prepared, "public_publication");
  assert.equal(upload.destination.destinationKind, "private_object_store");
  assert.equal(publish.destination.destinationKind, "public_video_channel");
  assert.notEqual(upload.destination.destinationIdentityDigest, publish.destination.destinationIdentityDigest);
  assert.notEqual(upload.destination.destinationPathDigest, publish.destination.destinationPathDigest);
  assert.equal(upload.destination.rawOriginStored, false);
  assert.equal(upload.destination.rawPathStored, false);
  assert.equal(upload.destination.rawCredentialReferenceStored, false);
  assert.equal(upload.destination.containsCredentials, false);
  assert.equal(upload.destination.networkConfigured, false);
  assert.equal(upload.destination.deliveryAuthorized, false);
  assert.deepEqual(parseWayfarerDeliveryDestinationV1(upload.destination), upload.destination);
});

test("CR9B-WF-110 requests bind operation, content, destination, and separate stable idempotency", () => {
  const prepared = buildCurrentWayfarerDeliveryDisabledV1().package;
  const upload = buildWayfarerDeliveryCandidateFixtureV1(prepared, "private_upload");
  const publish = buildWayfarerDeliveryCandidateFixtureV1(prepared, "public_publication");
  assert.equal(upload.request.operation, "wayfarer.upload_private_distribution");
  assert.equal(publish.request.operation, "wayfarer.publish_episode");
  assert.deepEqual(upload.request.contentIdentities.map((item) => item.role),
    ["episode_master", "assembly_manifest", "publication_package"]);
  assert.deepEqual(publish.request.contentIdentities.map((item) => item.role), ["episode_master", "publication_package"]);
  assert.notEqual(upload.request.operationDigest, publish.request.operationDigest);
  assert.notEqual(upload.request.destinationIdempotencyKey, publish.request.destinationIdempotencyKey);
  for (const request of [upload.request, publish.request]) {
    assert.equal(request.risk, "high");
    assert.equal(request.requiredFactor, "strong");
    assert.equal(request.separateNodeAttestationRequired, true);
    assert.equal(request.durableEffectClaimRequired, true);
    assert.equal(request.preEffectMarkerRequired, true);
    assert.equal(request.automaticRetryAfterMarker, false);
    assert.equal(request.unknownAfterMarker, "terminal_ambiguity");
    assert.equal(request.deliveryAuthorized, false);
    assert.deepEqual(parseWayfarerDeliveryRequestV1(request), request);
  }
});

test("CR9B-WF-110 central approval requests are strong, exact, and never execution authority", () => {
  const prepared = buildCurrentWayfarerDeliveryDisabledV1().package;
  for (const boundary of ["private_upload", "public_publication"] as const) {
    const { request, approvalRequest } = buildWayfarerDeliveryCandidateFixtureV1(prepared, boundary);
    assert.deepEqual(buildWayfarerDeliveryApprovalRequestV1(request), approvalRequest);
    assert.equal(approvalRequest.operationDigest, request.operationDigest);
    assert.equal(approvalRequest.risk, "high");
    assert.equal(approvalRequest.requiredFactor, "strong");
    assert.equal(approvalRequest.grantsExecutionAuthority, false);
  }
});

test("CR9B-WF-110 cross-boundary roles, destinations, oversized content, and expiry fail closed", () => {
  const prepared = buildCurrentWayfarerDeliveryDisabledV1().package;
  const publish = buildWayfarerDeliveryCandidateFixtureV1(prepared, "public_publication");
  const upload = buildWayfarerDeliveryCandidateFixtureV1(prepared, "private_upload");
  assert.throws(() => buildWayfarerDeliveryRequestV1({ requestId: "request:wayfarer:wrong-roles", jobId: "job:wrong",
    attemptId: "attempt:wrong", effectIntentId: "effect:wrong", package: prepared, destination: publish.destination,
    contentIdentities: upload.request.contentIdentities.map(({ role, contentDigest, sizeBytes,
      contentObservedByAuthoritativeSource }) => ({ role, contentDigest, sizeBytes, contentObservedByAuthoritativeSource })),
    completionResolutionDigest: upload.request.completionResolutionDigest, requestedAt: upload.request.requestedAt,
    expiresAt: upload.request.expiresAt }), safeCode("scope_mismatch"));
  const oversized = publish.request.contentIdentities.map(({ role, contentDigest, contentObservedByAuthoritativeSource }, position) =>
    ({ role, contentDigest, contentObservedByAuthoritativeSource, sizeBytes: position === 0 ? Number.MAX_SAFE_INTEGER : 1 }));
  assert.throws(() => buildWayfarerDeliveryRequestV1({ requestId: "request:wayfarer:oversized", jobId: "job:oversized",
    attemptId: "attempt:oversized", effectIntentId: "effect:oversized", package: prepared, destination: publish.destination,
    contentIdentities: oversized, completionResolutionDigest: publish.request.completionResolutionDigest,
    requestedAt: publish.request.requestedAt, expiresAt: publish.request.expiresAt }), safeCode("scope_mismatch"));
  assert.throws(() => buildWayfarerDeliveryRequestV1({ requestId: "request:wayfarer:expired", jobId: "job:expired",
    attemptId: "attempt:expired", effectIntentId: "effect:expired", package: prepared, destination: publish.destination,
    contentIdentities: publish.request.contentIdentities.map(({ role, contentDigest, sizeBytes,
      contentObservedByAuthoritativeSource }) => ({ role, contentDigest, sizeBytes, contentObservedByAuthoritativeSource })),
    completionResolutionDigest: publish.request.completionResolutionDigest, requestedAt: publish.request.expiresAt,
    expiresAt: publish.request.requestedAt }), safeCode("scope_mismatch"));
});

test("CR9B-WF-120 current truth records one of ten gates for both separate delivery lanes", () => {
  const current = buildCurrentWayfarerDeliveryReadinessDisabledV1();
  assert.deepEqual(current.records.map(({ assessment }) => assessment.boundaryId), ["private_upload", "public_publication"]);
  for (const { assessment, disposition } of current.records) {
    assert.equal(assessment.prerequisites.length, 10);
    assert.equal(assessment.prerequisites.filter((item) => item.state === "met").length, 1);
    assert.equal(assessment.prerequisites[0]!.evidenceDigest, current.package.packageDigest);
    assert.deepEqual(assessment.blockingGateIds, WAYFARER_DELIVERY_READINESS_GATE_IDS_V1.slice(1));
    assert.equal(assessment.readiness, "blocked");
    assert.equal(assessment.eligibleForOwnerWindow, false);
    assert.equal(disposition.status, "disabled");
    assert.equal(disposition.deliveryAttempted, false);
    assert.equal(disposition.externalEffectOccurred, false);
    assert.equal(disposition.automaticRetryAllowed, false);
  }
});

test("CR9B-WF-120 complete evidence creates only an owner-window candidate and never delivery authority", () => {
  for (const boundary of ["private_upload", "public_publication"] as const) {
    const assessment = complete(boundary);
    assert.equal(assessment.readiness, "candidate_for_owner_window");
    assert.equal(assessment.eligibleForOwnerWindow, true);
    assert.equal(assessment.blockingGateIds.length, 0);
    assert.equal(assessment.deliveryAuthorized, false);
    assert.equal(assessment.liveAdapterImplemented, false);
    assert.equal(assessment.grantsApproval, false);
    assert.equal(assessment.grantsExecutionAuthority, false);
    assert.throws(() => buildWayfarerDeliveryDisabledDispositionV1({ assessment,
      recordedAt: "2026-08-29T23:45:01.000Z" }), safeCode("unsupported_action"));
  }
});

test("CR9B-WF-120 package and destination evidence cannot be aliased even after outer re-signing", () => {
  const assessment = complete("private_upload");
  const packageAlias = clone(assessment);
  packageAlias.prerequisites[0]!.evidenceDigest = sha256Digest({ alias: "package" });
  packageAlias.prerequisites[0] = resign(packageAlias.prerequisites[0] as unknown as Record<string, unknown>,
    "prerequisiteDigest") as never;
  assert.throws(() => parseWayfarerDeliveryReadinessAssessmentV1(
    resign(packageAlias as unknown as Record<string, unknown>, "assessmentDigest")), safeCode("invalid_input"));
  const destinationAlias = clone(assessment);
  destinationAlias.prerequisites[3]!.evidenceDigest = sha256Digest({ alias: "destination" });
  destinationAlias.prerequisites[3] = resign(destinationAlias.prerequisites[3] as unknown as Record<string, unknown>,
    "prerequisiteDigest") as never;
  assert.throws(() => parseWayfarerDeliveryReadinessAssessmentV1(
    resign(destinationAlias as unknown as Record<string, unknown>, "assessmentDigest")), safeCode("invalid_input"));
});

test("CR9B-WF-120 disabled dispositions prove zero effect and bind the exact package and lane", () => {
  for (const boundary of ["private_upload", "public_publication"] as const) {
    const { assessment, disposition } = currentRecord(boundary);
    assert.equal(disposition.boundaryId, boundary);
    assert.equal(disposition.assessmentDigest, assessment.assessmentDigest);
    assert.equal(disposition.candidatePackageDigest, assessment.candidatePackageDigest);
    assert.equal(disposition.requiresNewAssessmentAndAuthorization, true);
    for (const field of ["deliveryAttempted", "destinationContacted", "artifactBytesRead", "credentialResolutionObserved",
      "effectClaimCreated", "preEffectMarkerRecorded", "destinationMutationObserved", "externalEffectOccurred",
      "uploadAuthorized", "publicationAuthorized", "grantsApproval", "grantsExecutionAuthority"] as const) {
      assert.equal(disposition[field], false, field);
    }
    assert.deepEqual(parseWayfarerDeliveryDisabledDispositionV1(disposition), disposition);
  }
});

test("CR9B-WF-120 durable store isolates both lanes, makes exact replay inert, and survives restart", async () => {
  const target = await location("restart");
  const current = buildCurrentWayfarerDeliveryReadinessDisabledV1();
  const scope = { tenantId: current.package.tenantId, workspaceId: current.package.workspaceId, projectId: current.package.projectId };
  try {
    const store = new SqliteWayfarerDeliveryReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    assert.equal(store.record(current.records[0]).replayed, false);
    assert.equal(store.record(current.records[1]).replayed, false);
    assert.equal(store.record(current.records[0]).replayed, true);
    assert.deepEqual(store.latest("private_upload"), current.records[0]);
    assert.deepEqual(store.latest("public_publication"), current.records[1]);
    assert.equal(store.verifyIntegrity().recordCount, 4);
    store.close();
    const reopened = new SqliteWayfarerDeliveryReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "open" });
    assert.deepEqual(reopened.latest("private_upload"), current.records[0]);
    assert.deepEqual(reopened.latest("public_publication"), current.records[1]);
    reopened.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9B-WF-120 later lane-specific assessment advances only that lane and preserves history", async () => {
  const target = await location("history");
  const current = buildCurrentWayfarerDeliveryReadinessDisabledV1();
  const scope = { tenantId: current.package.tenantId, workspaceId: current.package.workspaceId, projectId: current.package.projectId };
  try {
    const store = new SqliteWayfarerDeliveryReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    store.record(current.records[0]);
    store.record(current.records[1]);
    const assessment = buildWayfarerDeliveryReadinessAssessmentV1({ assessmentId: "assessment:wayfarer:private-upload:recheck",
      package: current.package, boundaryId: "private_upload", prerequisites: current.records[0].assessment.prerequisites,
      assessedAt: "2026-08-29T23:50:00.000Z" });
    const later = { assessment, disposition: buildWayfarerDeliveryDisabledDispositionV1({ assessment,
      recordedAt: "2026-08-29T23:50:01.000Z" }) };
    store.record(later);
    assert.deepEqual(store.latest("private_upload"), later);
    assert.deepEqual(store.latest("public_publication"), current.records[1]);
    assert.equal(store.verifyIntegrity().recordCount, 6);
    store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9B-WF-120 store rejects lane substitution, chronology rollback, foreign scope, and partial replay", async () => {
  for (const attack of ["lane", "chronology", "scope", "partial"] as const) {
    const target = await location(attack);
    const current = buildCurrentWayfarerDeliveryReadinessDisabledV1();
    const scope = { tenantId: current.package.tenantId, workspaceId: current.package.workspaceId, projectId: current.package.projectId };
    try {
      const store = new SqliteWayfarerDeliveryReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
      const record = clone(current.records[0]);
      if (attack === "lane") {
        record.disposition.boundaryId = "public_publication";
        record.disposition = resign(record.disposition as unknown as Record<string, unknown>, "dispositionDigest") as never;
      } else if (attack === "chronology") {
        record.disposition.recordedAt = "2026-08-29T23:39:59.000Z";
        record.disposition = resign(record.disposition as unknown as Record<string, unknown>, "dispositionDigest") as never;
      } else if (attack === "scope") {
        record.assessment.projectId = "project:foreign";
        record.assessment = resign(record.assessment as unknown as Record<string, unknown>, "assessmentDigest") as never;
      } else {
        store.record(record);
        const drift = clone(record);
        drift.disposition.dispositionId = "disposition:wayfarer:partial";
        drift.disposition = resign(drift.disposition as unknown as Record<string, unknown>, "dispositionDigest") as never;
        assert.throws(() => store.record(drift), safeCode("replay_drift"));
        store.close();
        continue;
      }
      assert.throws(() => store.record(record), (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1);
      store.close();
    } finally { await rm(target.directory, { recursive: true, force: true }); }
  }
});

test("CR9B-WF-120 ledger detects deletion, metadata, boundary, schema, and key tampering", async () => {
  for (const attack of ["deletion", "metadata", "boundary", "schema", "wrong_key"] as const) {
    const target = await location(attack);
    const current = buildCurrentWayfarerDeliveryReadinessDisabledV1();
    const scope = { tenantId: current.package.tenantId, workspaceId: current.package.workspaceId, projectId: current.package.projectId };
    try {
      const store = new SqliteWayfarerDeliveryReadinessStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
      store.record(current.records[0]);
      store.close();
      if (attack === "wrong_key") {
        assert.throws(() => new SqliteWayfarerDeliveryReadinessStoreV1(target.path, scope,
          { integrityKey: new Uint8Array(32).fill(114), mode: "open" }), safeCode("integrity_failed"));
        continue;
      }
      const db = new DatabaseSync(target.path);
      if (attack === "deletion") db.exec("DELETE FROM wayfarer_delivery_readiness_records WHERE kind='disposition'");
      if (attack === "metadata") db.exec("UPDATE wayfarer_delivery_readiness_metadata SET revision=999");
      if (attack === "boundary") db.exec("UPDATE wayfarer_delivery_readiness_records SET boundary_id='public_publication'");
      if (attack === "schema") db.exec("CREATE TRIGGER injected AFTER INSERT ON wayfarer_delivery_readiness_records BEGIN SELECT 1; END");
      db.close();
      assert.throws(() => new SqliteWayfarerDeliveryReadinessStoreV1(target.path, scope,
        { integrityKey: key, mode: "open" }), safeCode("integrity_failed"));
    } finally { await rm(target.directory, { recursive: true, force: true }); }
  }
});

test("CR9B-WF-110/120 exact boundaries reject drift, secrets, accessors, and Proxies without executing behavior", () => {
  const prepared = buildCurrentWayfarerDeliveryDisabledV1().package;
  const fixture = buildWayfarerDeliveryCandidateFixtureV1(prepared, "private_upload");
  assert.throws(() => parseWayfarerDeliveryRequestV1({ ...fixture.request,
    destinationIdempotencyKey: sha256Digest({ drift: true }) }), safeCode("digest_mismatch"));
  assert.throws(() => parseWayfarerDeliveryDestinationV1({ ...fixture.destination, rawDestination: "https://private.invalid" }),
    (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerDeliveryRequestV1({ ...fixture.request, credentialToken: "Bearer abcdefghijklmnopqrstuvwxyz" }),
    (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1);
  let getterRan = false;
  const accessor = { ...fixture.destination } as Record<string, unknown>;
  Object.defineProperty(accessor, "destinationId", { enumerable: true, get() { getterRan = true; return fixture.destination.destinationId; } });
  assert.throws(() => parseWayfarerDeliveryDestinationV1(accessor), safeCode("invalid_input"));
  assert.equal(getterRan, false);
  let trapRan = false;
  const proxy = new Proxy(fixture.request, { ownKeys() { trapRan = true; return []; } });
  assert.throws(() => parseWayfarerDeliveryRequestV1(proxy), safeCode("invalid_input"));
  assert.equal(trapRan, false);
});

test("CR9B-WF-110/120 source contains no destination client, network, filesystem, process, or provider runtime", async () => {
  const sources = await Promise.all(["delivery-authority.ts", "delivery-readiness.ts", "delivery-readiness-store.ts"]
    .map((name) => readFile(new URL(`../src/project-adapters/wayfarer/v1/${name}`, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /node:(?:child_process|fs|http|https|net|tls)|\b(?:spawn|execFile|fetch)\s*\(/);
    assert.doesNotMatch(source, /@aws-sdk|cloudflare|googleapis|youtube|r2\.cloudflarestorage/i);
  }
});
