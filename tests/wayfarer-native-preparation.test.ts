import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import {
  buildCurrentWayfarerDeliveryDisabledV1,
  buildCurrentWayfarerUnrealBenchmarkDisabledV1,
  buildCurrentWayfarerUnrealExecutorDisabledV1,
  buildWayfarerDeliveryDisabledOutcomeV1,
  buildWayfarerDeliveryPreparationPackageV1,
  buildWayfarerSyntheticProjectPackV1,
  buildWayfarerUnrealExecutorAdmissionV1,
  buildWayfarerUnrealExecutorDisabledReceiptV1,
  parseWayfarerDeliveryDisabledOutcomeV1,
  parseWayfarerDeliveryPreparationPackageV1,
  parseWayfarerUnrealExecutorAdmissionV1,
  parseWayfarerUnrealExecutorDisabledReceiptV1,
  parseWayfarerUnrealExecutorManifestV1,
  WAYFARER_DELIVERY_BLOCKERS_V1,
  WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1,
} from "../src/project-adapters/wayfarer/v1";
import { sha256Digest } from "../src/security";

function safeCode(code: string) {
  return (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1 && value.safeCode === code;
}
function clone<T>(value: T): T { return structuredClone(value); }
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value };
  delete material[key];
  return { ...value, [key]: sha256Digest(material) };
}

test("CR9B-WF-090 freezes a disabled executor with no command or native capability seam", () => {
  const { manifest } = buildCurrentWayfarerUnrealExecutorDisabledV1();
  assert.equal(manifest.implementationState, "frozen_disabled_contract_only");
  assert.equal(manifest.commandModel, "none");
  assert.deepEqual(manifest.supportedPlatforms, ["macos", "windows", "linux"]);
  assert.equal(manifest.maximumAttempts, 1);
  assert.equal(manifest.maximumRuntimeSeconds, 900);
  assert.equal(manifest.maximumCostUsd, 0);
  assert.equal(manifest.networkPolicy, "forbidden");
  assert.equal(manifest.canPrepareAdmissionOnly, true);
  for (const value of [manifest.nativeAdapterPresent, manifest.processSpawnPresent, manifest.filesystemReaderPresent,
    manifest.sceneLocatorResolverPresent, manifest.toolLocatorResolverPresent, manifest.credentialResolverPresent,
    manifest.networkClientPresent, manifest.artifactWriterPresent, manifest.cancellationControllerPresent,
    manifest.canExecute, manifest.allowsNativeExecution, manifest.grantsApproval, manifest.grantsExecutionAuthority]) {
    assert.equal(value, false);
  }
  assert.deepEqual(parseWayfarerUnrealExecutorManifestV1(manifest), manifest);
});

test("CR9B-WF-090 admission binds the accepted disabled benchmark truth and creates nothing", () => {
  const value = buildCurrentWayfarerUnrealExecutorDisabledV1();
  assert.equal(value.admission.packetDigest, value.packet.packetDigest);
  assert.equal(value.admission.assessmentDigest, value.assessment.assessmentDigest);
  assert.equal(value.admission.dispositionDigest, value.disposition.dispositionDigest);
  assert.deepEqual(value.admission.readinessGateBlockers, value.disposition.blockingGateIds);
  assert.deepEqual(value.admission.executorBlockers, WAYFARER_UNREAL_EXECUTOR_BLOCKERS_V1);
  assert.equal(value.admission.status, "disabled_before_start");
  for (const field of ["createsJob", "createsReservation", "createsLease", "createsEffectClaim", "recordsPreEffectMarker",
    "resolvesPrivateLocator", "invokesNativeAdapter", "attemptsExecution", "consumesOwnerApproval", "eligibleForOwnerWindow",
    "benchmarkAuthorized", "unrealEligible", "automaticRetryAllowed", "grantsApproval", "grantsExecutionAuthority"] as const) {
    assert.equal(value.admission[field], false, field);
  }
});

test("CR9B-WF-090 disabled receipt proves a pre-attempt stop without pretending cleanup ran", () => {
  const { admission, receipt } = buildCurrentWayfarerUnrealExecutorDisabledV1();
  assert.equal(receipt.admissionDigest, admission.admissionDigest);
  assert.equal(receipt.result, "disabled_before_start");
  for (const field of ["attemptIdPresent", "processStarted", "sceneRead", "gpuWorkObserved", "outputObserved", "networkObserved",
    "credentialResolutionObserved", "filesystemEffectObserved", "externalEffectOccurred", "retryScheduled", "benchmarkAuthorized",
    "unrealEligible", "grantsApproval", "grantsExecutionAuthority"] as const) assert.equal(receipt[field], false, field);
  assert.deepEqual(parseWayfarerUnrealExecutorDisabledReceiptV1(receipt), receipt);
});

test("CR9B-WF-090 refuses cross-packet readiness, disposition, and manifest combinations", () => {
  const current = buildCurrentWayfarerUnrealExecutorDisabledV1();
  const foreignPack = clone(buildWayfarerSyntheticProjectPackV1());
  foreignPack.packId = "pack:wayfarer:foreign";
  foreignPack.packDigest = sha256Digest(Object.fromEntries(Object.entries(foreignPack).filter(([key]) => key !== "packDigest")));
  assert.throws(() => buildWayfarerUnrealExecutorAdmissionV1({ manifest: current.manifest,
    packet: buildCurrentWayfarerUnrealBenchmarkDisabledV1(foreignPack).packet, assessment: current.assessment,
    disposition: current.disposition, evaluatedAt: "2026-08-29T23:11:00.000Z" }), safeCode("scope_mismatch"));
  const changed = clone(current.disposition);
  changed.assessmentDigest = sha256Digest({ foreign: true });
  changed.dispositionDigest = sha256Digest(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "dispositionDigest")));
  assert.throws(() => buildWayfarerUnrealExecutorAdmissionV1({ ...current, disposition: changed,
    evaluatedAt: "2026-08-29T23:11:00.000Z" }), safeCode("scope_mismatch"));
});

test("CR9B-WF-090 rejects digest drift, chronology rollback, extra fields, secrets, accessors, and Proxies", () => {
  const current = buildCurrentWayfarerUnrealExecutorDisabledV1();
  assert.throws(() => parseWayfarerUnrealExecutorManifestV1({ ...current.manifest, canExecute: true }), safeCode("invalid_input"));
  assert.throws(() => parseWayfarerUnrealExecutorAdmissionV1({ ...current.admission, surprise: false }), safeCode("invalid_input"));
  assert.throws(() => parseWayfarerUnrealExecutorAdmissionV1({ ...current.admission,
    admissionDigest: sha256Digest({ drift: true }) }), safeCode("digest_mismatch"));
  assert.throws(() => buildWayfarerUnrealExecutorDisabledReceiptV1({ admission: current.admission,
    recordedAt: "2026-08-29T23:09:59.000Z" }), safeCode("invalid_transition"));
  assert.throws(() => parseWayfarerUnrealExecutorAdmissionV1({ ...current.admission, operatorToken: "ghp_abcdefghijklmnop" }),
    (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1);
  let getterRan = false;
  const accessor = { ...current.manifest } as Record<string, unknown>;
  Object.defineProperty(accessor, "nativeAdapterPresent", { enumerable: true, get() { getterRan = true; return false; } });
  assert.throws(() => parseWayfarerUnrealExecutorManifestV1(accessor), safeCode("invalid_input"));
  assert.equal(getterRan, false);
  let trapRan = false;
  const proxy = new Proxy(current.admission, { ownKeys() { trapRan = true; return []; } });
  assert.throws(() => parseWayfarerUnrealExecutorAdmissionV1(proxy), safeCode("invalid_input"));
  assert.equal(trapRan, false);
});

test("CR9B-WF-100 prepares exact upload and publication boundaries without a destination", () => {
  const { package: prepared } = buildCurrentWayfarerDeliveryDisabledV1();
  assert.deepEqual(prepared.artifactDeclarations.map((item) => item.role),
    ["episode_master", "assembly_manifest", "publication_package"]);
  assert.deepEqual(prepared.boundaries.map((item) => item.boundaryId), ["private_upload", "public_publication"]);
  assert.deepEqual(prepared.blockingRequirements, WAYFARER_DELIVERY_BLOCKERS_V1);
  assert.equal(prepared.preparationState, "metadata_only_blocked");
  assert.equal(prepared.containsMediaBytes, false);
  assert.equal(prepared.containsArtifactLocators, false);
  assert.equal(prepared.containsDestinationIdentifiers, false);
  assert.equal(prepared.containsDestinationPaths, false);
  assert.equal(prepared.containsCredentialReferences, false);
  assert.deepEqual(parseWayfarerDeliveryPreparationPackageV1(prepared), prepared);
});

test("CR9B-WF-100 freezes destination idempotency, approval, marker, cleanup, and ambiguity requirements", () => {
  const { package: prepared } = buildCurrentWayfarerDeliveryDisabledV1();
  for (const boundary of prepared.boundaries) {
    assert.equal(boundary.risk, "high");
    assert.equal(boundary.destinationIdempotencyRequired, true);
    assert.equal(boundary.freshStrongApprovalRequired, true);
    assert.equal(boundary.nodeAuthorityRequired, true);
    assert.equal(boundary.qualifiedAdapterRequired, true);
    assert.equal(boundary.credentialBrokerRequired, true);
    assert.equal(boundary.durableEffectClaimRequired, true);
    assert.equal(boundary.preEffectMarkerRequired, true);
    assert.equal(boundary.automaticRetryAfterMarker, false);
    assert.equal(boundary.unknownAfterMarker, "terminal_ambiguity");
    assert.equal(boundary.cleanupReceiptRequired, true);
    assert.equal(boundary.destinationReceiptRequired, true);
    assert.equal(boundary.allowsNetwork, false);
    assert.equal(boundary.allowsUpload, false);
    assert.equal(boundary.allowsPublication, false);
  }
});

test("CR9B-WF-100 disabled outcome records zero delivery effects and requires a new package", () => {
  const { package: prepared, outcome } = buildCurrentWayfarerDeliveryDisabledV1();
  assert.equal(outcome.packageDigest, prepared.packageDigest);
  assert.equal(outcome.status, "disabled_before_effect");
  assert.equal(outcome.requiresNewPackageAndAuthorization, true);
  for (const field of ["uploadAttempted", "publicationAttempted", "destinationContacted", "credentialsResolved",
    "artifactBytesRead", "effectClaimCreated", "preEffectMarkerRecorded", "retryScheduled", "externalEffectOccurred",
    "grantsApproval", "grantsExecutionAuthority"] as const) assert.equal(outcome[field], false, field);
  assert.deepEqual(parseWayfarerDeliveryDisabledOutcomeV1(outcome), outcome);
});

test("CR9B-WF-100 package identities change with the Wayfarer pack and cannot be replayed across revisions", () => {
  const first = buildWayfarerDeliveryPreparationPackageV1();
  const changed = clone(buildWayfarerSyntheticProjectPackV1());
  changed.packId = "pack:wayfarer:revised";
  changed.packDigest = sha256Digest(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "packDigest")));
  const second = buildWayfarerDeliveryPreparationPackageV1(changed);
  assert.notEqual(first.packageId, second.packageId);
  assert.notEqual(first.packageDigest, second.packageDigest);
  assert.notEqual(first.packDigest, second.packDigest);
});

test("CR9B-WF-100 rejects reordered roles, boundary aliases, outer re-signing, secret material, and chronology rollback", () => {
  const current = buildCurrentWayfarerDeliveryDisabledV1();
  const reordered = clone(current.package);
  reordered.artifactDeclarations.reverse();
  const resignedOrder = resign(reordered as unknown as Record<string, unknown>, "packageDigest");
  assert.throws(() => parseWayfarerDeliveryPreparationPackageV1(resignedOrder), safeCode("scope_mismatch"));
  const aliased = clone(current.package);
  aliased.boundaries[0].requiredArtifactRoles = ["episode_master", "publication_package"];
  aliased.boundaries[0] = resign(aliased.boundaries[0] as unknown as Record<string, unknown>, "boundaryDigest") as never;
  const resignedAlias = resign(aliased as unknown as Record<string, unknown>, "packageDigest");
  assert.throws(() => parseWayfarerDeliveryPreparationPackageV1(resignedAlias), safeCode("scope_mismatch"));
  assert.throws(() => parseWayfarerDeliveryPreparationPackageV1({ ...current.package,
    destinationToken: "Bearer abcdefghijklmnopqrstuvwxyz" }), (value: unknown) => value instanceof ProjectWorkspaceContractErrorV1);
  assert.throws(() => buildWayfarerDeliveryDisabledOutcomeV1({ package: current.package,
    recordedAt: "2026-08-29T23:19:59.000Z" }), safeCode("invalid_transition"));
});

test("CR9B-WF-090/100 source files contain no native process, filesystem, network, or provider imports", async () => {
  const sources = await Promise.all(["unreal-executor.ts", "delivery-preparation.ts"].map((name) =>
    readFile(new URL(`../src/project-adapters/wayfarer/v1/${name}`, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /node:(?:child_process|fs|http|https|net|tls)|\b(?:spawn|execFile|fetch)\s*\(/);
    assert.doesNotMatch(source, /@aws-sdk|cloudflare|youtube|googleapis/i);
  }
});
