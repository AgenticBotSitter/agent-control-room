import assert from "node:assert/strict";
import test from "node:test";
import { nativeResultId, resultBytesHash } from "../src/artifacts/v1/native-results";
import { commitNativeResultReservationMetadataV1, markNativeResultReservationStorageUncertainV1,
  nativeResultReservationSchemaV1, reconcileNativeResultReservationCrashV1,
  reserveNativeResultWriteV1, verifyNativeResultReservationBytesV1 } from
  "../src/artifacts/v1/native-result-reservation";
import { sha256Digest } from "../src/security";

const bytes = new TextEncoder().encode("Exact private native result.");

function snapshot() {
  return {
    runId: "run:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test",
    leaseId: "lease:test", leaseEpoch: 4, bindingDigest: sha256Digest("binding"),
    sessionKeyDigest: sha256Digest("session"), nativeRunKeyDigest: sha256Digest("native-run"),
    snapshotVersion: 9, observedAt: "2026-09-13T12:00:00.000Z",
    upstreamUpdatedAt: "2026-09-13T11:59:59.000Z", state: "completed" as const,
    availability: "current" as const, lastActivity: "message_progress" as const,
    stopAttempted: false, safeReason: "none" as const,
    result: { contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength }, usage: null,
  };
}

const reserve = (existing?: unknown, snapshotValue: unknown = snapshot(), tenantId = "tenant:test", nodeId = "node:test") =>
  reserveNativeResultWriteV1({ tenantId, nodeId, snapshot: snapshotValue, ...(existing === undefined ? {} : { existing }) });

function rehash(value: unknown) {
  const copy = structuredClone(value) as Record<string, unknown>;
  const { contractDigest: _ignored, ...material } = copy;
  return { ...material, contractDigest: sha256Digest(material) };
}

test("reserves one deterministic native result identity before any byte or metadata write", () => {
  const reservation = reserve();
  assert.equal(reservation.state, "reserved");
  assert.equal(reservation.identity.artifactId, nativeResultId("tenant:test", "run:test"));
  assert.equal(reservation.identity.snapshotDigest, sha256Digest(snapshot()));
  assert.equal(reservation.identity.snapshotVersion, 9);
  assert.equal(reservation.identity.contentHash, resultBytesHash(bytes));
  assert.equal(reservation.identity.sizeBytes, bytes.byteLength);
  assert.equal(reservation.identity.leaseId, "lease:test");
  assert.equal(reservation.identity.leaseEpoch, 4);
  assert.equal(reservation.identity.bindingDigest, sha256Digest("binding"));
  for (const flag of ["canonicalPublicationAllowed", "completionVerified", "grantsExecutionAuthority",
    "grantsStorageWriteAuthority", "permitsRetry", "permitsCleanup", "deletesArtifact"] as const) {
    assert.equal(reservation[flag], false);
  }
  assert.equal(Object.isFrozen(reservation), true);
  assert.equal(Object.isFrozen(reservation.identity), true);
  assert.deepEqual(reserve(reservation), reservation);
  assert.throws(() => reserveNativeResultWriteV1({ tenantId: "tenant:test", nodeId: "node:test",
    snapshot: snapshot(), unexpected: true } as never), /reservation_unavailable/);
});

test("exact replay returns the existing state while every reservation identity conflict refuses", () => {
  const existing = reserve();
  const cases: Array<[string, unknown, string?, string?]> = [
    ["projectId", "project:other"], ["jobId", "job:other"], ["attemptId", "attempt:other"],
    ["runId", "run:other"], ["snapshotVersion", 10], ["leaseId", "lease:other"], ["leaseEpoch", 5],
    ["bindingDigest", sha256Digest("other-binding")], ["sessionKeyDigest", sha256Digest("other-session")],
    ["nativeRunKeyDigest", sha256Digest("other-native-run")],
  ];
  for (const [key, replacement] of cases) {
    assert.throws(() => reserve(existing, { ...snapshot(), [key]: replacement }), /reservation_conflict/, key);
  }
  assert.throws(() => reserve(existing, snapshot(), "tenant:other"), /reservation_conflict/);
  assert.throws(() => reserve(existing, snapshot(), "tenant:test", "node:other"), /reservation_conflict/);
  assert.throws(() => reserve(existing, { ...snapshot(), result: {
    contentHash: sha256Digest("other-content"), sizeBytes: bytes.byteLength } }), /reservation_conflict/);
  assert.throws(() => reserve(existing, { ...snapshot(), result: {
    contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength + 1 } }), /reservation_conflict/);
});

test("reuses fatal byte validation and advances only reserved to bytes_verified", () => {
  const reserved = reserve();
  const verified = verifyNativeResultReservationBytesV1(reserved, bytes);
  assert.equal(verified.state, "bytes_verified");
  assert.ok(verified.bytesVerificationDigest);
  assert.deepEqual(verifyNativeResultReservationBytesV1(verified, bytes), verified);
  for (const invalid of [bytes.slice(0, -1), new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode("Authorization: Bearer private-private-private")]) {
    assert.throws(() => verifyNativeResultReservationBytesV1(reserved, invalid), /reservation_unavailable/);
  }
});

test("metadata commitment is exact and replayable but cannot skip byte verification", () => {
  const reserved = reserve(), manifestDigest = sha256Digest("manifest"), receiptDigest = sha256Digest("receipt");
  assert.throws(() => commitNativeResultReservationMetadataV1({ reservation: reserved,
    manifestDigest, receiptDigest }), /reservation_unavailable/);
  assert.throws(() => commitNativeResultReservationMetadataV1({ reservation: reserved,
    manifestDigest, receiptDigest, unexpected: true } as never), /reservation_unavailable/);
  const verified = verifyNativeResultReservationBytesV1(reserved, bytes);
  const committed = commitNativeResultReservationMetadataV1({ reservation: verified, manifestDigest, receiptDigest });
  assert.equal(committed.state, "metadata_committed");
  assert.deepEqual(commitNativeResultReservationMetadataV1({ reservation: committed,
    manifestDigest, receiptDigest }), committed);
  assert.throws(() => commitNativeResultReservationMetadataV1({ reservation: committed,
    manifestDigest: sha256Digest("other-manifest"), receiptDigest }), /reservation_conflict/);
  assert.deepEqual(verifyNativeResultReservationBytesV1(committed, bytes), committed);
});

test("storage uncertainty is terminal and crash reconciliation never retries or deletes", () => {
  const reserved = reserve(), verified = verifyNativeResultReservationBytesV1(reserved, bytes);
  const uncertainFromReserved = markNativeResultReservationStorageUncertainV1({ reservation: reserved,
    uncertaintyDigest: sha256Digest("uncertain-reserved") });
  const uncertainFromVerified = markNativeResultReservationStorageUncertainV1({ reservation: verified,
    uncertaintyDigest: sha256Digest("uncertain-verified") });
  assert.equal(uncertainFromReserved.lastCertainState, "reserved");
  assert.equal(uncertainFromReserved.bytesVerificationDigest, null);
  assert.equal(uncertainFromVerified.lastCertainState, "bytes_verified");
  assert.ok(uncertainFromVerified.bytesVerificationDigest);
  assert.throws(() => verifyNativeResultReservationBytesV1(uncertainFromVerified, bytes), /reservation_unavailable/);
  assert.throws(() => commitNativeResultReservationMetadataV1({ reservation: uncertainFromVerified,
    manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }), /reservation_unavailable/);
  assert.throws(() => markNativeResultReservationStorageUncertainV1({ reservation: uncertainFromVerified,
    uncertaintyDigest: sha256Digest("different") }), /reservation_conflict/);
  assert.throws(() => markNativeResultReservationStorageUncertainV1({ reservation: verified,
    uncertaintyDigest: sha256Digest("uncertain"), unexpected: true } as never), /reservation_unavailable/);

  const committed = commitNativeResultReservationMetadataV1({ reservation: verified,
    manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") });
  for (const state of [reserved, verified, uncertainFromReserved, uncertainFromVerified, committed]) {
    const reconciliation = reconcileNativeResultReservationCrashV1(state);
    assert.equal(reconciliation.autoRetriesWrite, false);
    assert.equal(reconciliation.autoCommitsMetadata, false);
    assert.equal(reconciliation.permitsRetry, false);
    assert.equal(reconciliation.permitsCleanup, false);
    assert.equal(reconciliation.autoDeletesBytes, false);
    assert.equal(reconciliation.grantsStorageWriteAuthority, false);
    assert.equal(reconciliation.disposition, state.state === "metadata_committed"
      ? "metadata_already_committed" : "manual_reconciliation_required");
  }
});

test("persisted reservation validation rejects recomputed identifier and state-evidence tampering", () => {
  const reserved = reserve();
  for (const changed of [
    { ...reserved, reservationId: "reservation:native:other" },
    { ...reserved, identityDigest: sha256Digest("other") },
    { ...reserved, state: "bytes_verified" },
    { ...reserved, bytesVerificationDigest: sha256Digest("fabricated") },
    { ...reserved, identity: { ...reserved.identity, artifactId: "artifact:native:other" } },
  ]) assert.equal(nativeResultReservationSchemaV1.safeParse(rehash(changed)).success, false);
});

test("persisted later states reject forged byte verification despite a recomputed contract digest", () => {
  const reserved = reserve();
  const verified = verifyNativeResultReservationBytesV1(reserved, bytes);
  const committed = commitNativeResultReservationMetadataV1({
    reservation: verified,
    manifestDigest: sha256Digest("manifest"),
    receiptDigest: sha256Digest("receipt"),
  });
  const uncertain = markNativeResultReservationStorageUncertainV1({
    reservation: verified,
    uncertaintyDigest: sha256Digest("uncertain-after-verification"),
  });

  const forgedVerified = rehash({
    ...verified,
    bytesVerificationDigest: sha256Digest("forged-verified-byte-evidence"),
  });
  assert.equal(nativeResultReservationSchemaV1.safeParse(forgedVerified).success, false);
  assert.throws(() => commitNativeResultReservationMetadataV1({
    reservation: forgedVerified,
    manifestDigest: sha256Digest("manifest"),
    receiptDigest: sha256Digest("receipt"),
  }), /reservation_unavailable/);

  const forgedCommitted = rehash({
    ...committed,
    bytesVerificationDigest: sha256Digest("forged-committed-byte-evidence"),
  });
  assert.equal(nativeResultReservationSchemaV1.safeParse(forgedCommitted).success, false);
  assert.throws(() => reconcileNativeResultReservationCrashV1(forgedCommitted), /reservation_unavailable/);

  const forgedUncertain = rehash({
    ...uncertain,
    bytesVerificationDigest: sha256Digest("forged-uncertain-byte-evidence"),
  });
  assert.equal(nativeResultReservationSchemaV1.safeParse(forgedUncertain).success, false);
  assert.throws(() => reconcileNativeResultReservationCrashV1(forgedUncertain), /reservation_unavailable/);
});
