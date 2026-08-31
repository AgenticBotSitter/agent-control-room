import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessPublicPackageCompatibilityV1,
  assessPublicPackageReleaseCandidateV1,
  buildPublicPackageClassificationRegistryV1,
  buildPublicPackageCompatibilityPolicyV1,
  buildPublicPackageCompatibilityRequestV1,
  buildPublicPackageManifestV1,
  buildPublicPackageSignatureClaimV1,
  buildPublicPackageSignatureVerificationV1,
  buildPublicReleaseEvidenceBundleV1,
  buildPublicReleaseGateEvidenceV1,
  createDisabledPublicPackagePublisherV1,
  parsePublicPackageClassificationRegistryV1,
  parsePublicPackageCompatibilityAssessmentV1,
  parsePublicPackageCompatibilityPolicyV1,
  parsePublicPackageCompatibilityRequestV1,
  parsePublicPackageDisabledPublicationReceiptV1,
  parsePublicPackageManifestV1,
  parsePublicPackageReleaseCandidateV1,
  parsePublicPackageReleaseProjectionV1,
  parsePublicPackageSignatureClaimV1,
  parsePublicPackageSignatureVerificationV1,
  parsePublicReleaseEvidenceBundleV1,
  parsePublicReleaseGateEvidenceV1,
  PRIVATE_PACKAGE_CLASS_IDS_V1,
  PUBLIC_PACKAGE_CLASS_IDS_V1,
  PUBLIC_PACKAGE_FORMAT_VERSION_V1,
  PUBLIC_RELEASE_GATE_IDS_V1,
  PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1,
  projectPublicPackageReleaseV1,
  PublicPackageContractErrorV1,
  type PublicPackageManifestV1,
  type PublicPackageManifestEntryV1,
  type PublicReleaseEvidenceModeV1,
  type PublicReleaseGateIdV1,
  type PublicReleaseGateStateV1,
} from "../src/public-package/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const BASE = "2026-08-30T08:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(BASE) + seconds * 1_000).toISOString();
const distinct = (label: string) => sha256Digest({ test: "public-package-contract", label });
const clone = <T>(value: T): T => structuredClone(value);
const code = (safeCode: string) => (error: unknown) => error instanceof PublicPackageContractErrorV1 && error.safeCode === safeCode;
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}

const entryInputs = [
  ["packages/control-room-core/src/index.ts", "public:core", "source", "application/typescript"],
  ["packages/control-room-adapter-sdk/src/index.ts", "public:adapter-sdk", "source", "application/typescript"],
  ["packages/control-room-conformance-kit/src/index.ts", "public:conformance-kit", "source", "application/typescript"],
  ["packages/reference-adapters/synthetic/index.ts", "public:reference-adapter", "fixture", "application/typescript"],
  ["examples/synthetic/README.md", "public:synthetic-example", "documentation", "text/markdown"],
  ["docs/public/GETTING_STARTED.md", "public:documentation", "documentation", "text/markdown"],
  ["schemas/public/adapter.json", "public:schema", "schema", "application/json"],
  ["release/NOTICE", "public:release-metadata", "metadata", "text/plain"],
] as const;

function manifest(version = "0.1.0", packageId = "package:control-room:public") {
  const registry = buildPublicPackageClassificationRegistryV1(), policy = buildPublicPackageCompatibilityPolicyV1();
  return buildPublicPackageManifestV1({ manifestId: `manifest:${packageId}:${version}`, packageId, packageVersion: version,
    producerId: "producer:control-room:release", classificationRegistryDigest: registry.registryDigest,
    compatibilityPolicyDigest: policy.policyDigest, entries: entryInputs.map(([entryPath, classId, entryKind, mediaType], index) => ({
      entryPath, classId, entryKind, objectKind: "regular_file", executable: false, generated: index >= 2,
      mediaType, byteLength: 100 + index, contentDigest: distinct(`content:${version}:${entryPath}`),
      sourceDigest: distinct(`source:${version}:${entryPath}`),
    })), sourceRevisionDigest: distinct(`revision:${version}`), buildRecipeDigest: distinct(`recipe:${version}`),
    dependencyLockDigest: distinct(`lock:${version}`), sbomDigest: distinct(`sbom:${version}`),
    licenseInventoryDigest: distinct(`licenses:${version}`), noticeDigest: distinct(`notice:${version}`),
    provenanceDigest: distinct(`provenance:${version}`), privateTreeScanDigest: distinct(`private-scan:${version}`),
    credentialScanDigest: distinct(`credential-scan:${version}`), reproducibilityPlanDigest: distinct(`repro:${version}`), createdAt: BASE });
}

function compatibility(currentManifest = manifest(), options: { requestedVersion?: string; currentInstalledVersion?: string;
  formatVersion?: string; contracts?: string[] } = {}) {
  const policy = buildPublicPackageCompatibilityPolicyV1(), request = buildPublicPackageCompatibilityRequestV1({
    packageId: currentManifest.packageId, manifestDigest: currentManifest.manifestDigest,
    requestedPackageVersion: options.requestedVersion ?? currentManifest.packageVersion,
    ...(options.currentInstalledVersion ? { currentInstalledVersion: options.currentInstalledVersion } : {}),
    requestedPackageFormatVersion: options.formatVersion ?? PUBLIC_PACKAGE_FORMAT_VERSION_V1,
    requestedContractVersions: options.contracts ?? [...PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1], requestedAt: at(1) });
  return { policy, request, assessment: assessPublicPackageCompatibilityV1({ manifest: currentManifest, policy, request, assessedAt: at(2) }) };
}

function signature(currentManifest = manifest(), state: "unsigned" | "unverified_signature_digest" = "unverified_signature_digest",
  verificationState: "not_observed" | "failed" | "verified_external" = "verified_external") {
  const claim = buildPublicPackageSignatureClaimV1({ manifest: currentManifest, claimState: state,
    ...(state === "unverified_signature_digest" ? { signerKeyFingerprintDigest: distinct("fingerprint"),
      signatureDigest: distinct(`signature:${currentManifest.manifestDigest}`) } : {}), claimedAt: at(1) });
  const verification = buildPublicPackageSignatureVerificationV1({ manifest: currentManifest, claim,
    verifierId: "verifier:independent:signature", verificationState, evidenceDigest: distinct(`signature-evidence:${verificationState}`),
    verifiedAt: at(2) });
  return { claim, verification };
}

function gateRecords(currentManifest: PublicPackageManifestV1, mode: PublicReleaseEvidenceModeV1,
  changes: Partial<Record<PublicReleaseGateIdV1, PublicReleaseGateStateV1>> = {}, validUntil = at(86_400)) {
  const policy = buildPublicPackageCompatibilityPolicyV1();
  const exactEvidence: Partial<Record<PublicReleaseGateIdV1, string>> = {
    manifest_integrity: currentManifest.manifestDigest,
    explicit_public_classification: currentManifest.classificationRegistryDigest,
    private_tree_exclusion: currentManifest.privateTreeScanDigest,
    credential_value_exclusion: currentManifest.credentialScanDigest,
    sbom_complete: currentManifest.sbomDigest,
    license_notice_complete: sha256Digest({ licenseInventoryDigest: currentManifest.licenseInventoryDigest,
      noticeDigest: currentManifest.noticeDigest }),
    provenance_complete: currentManifest.provenanceDigest,
  };
  return PUBLIC_RELEASE_GATE_IDS_V1.map((gateId) => buildPublicReleaseGateEvidenceV1({ manifest: currentManifest, policy,
    gateId, evidenceMode: mode, state: changes[gateId] ?? "passed", verifierId: gateId === "manifest_integrity"
      || gateId === "sbom_complete" || gateId === "license_notice_complete" || gateId === "provenance_complete"
      || gateId === "reproducible_build" || gateId === "compatibility_pass"
      ? currentManifest.producerId : `verifier:independent:${gateId}`,
    evidenceDigest: exactEvidence[gateId] ?? distinct(`gate:${mode}:${gateId}`),
    observedAt: at(2), validUntil }));
}

function releaseFixture(options: { mode?: PublicReleaseEvidenceModeV1; changes?: Partial<Record<PublicReleaseGateIdV1, PublicReleaseGateStateV1>>;
  verificationState?: "not_observed" | "failed" | "verified_external"; assessedAt?: string; validUntil?: string } = {}) {
  const currentManifest = manifest(), { policy, assessment } = compatibility(currentManifest),
    { claim, verification } = signature(currentManifest, "unverified_signature_digest", options.verificationState),
    mode = options.mode ?? "external_digest_only", records = gateRecords(currentManifest, mode, options.changes, options.validUntil),
    evidenceBundle = buildPublicReleaseEvidenceBundleV1({ manifest: currentManifest, policy, evidenceMode: mode, records, assembledAt: at(3) }),
    candidate = assessPublicPackageReleaseCandidateV1({ manifest: currentManifest, policy, compatibility: assessment,
      signatureClaim: claim, signatureVerification: verification, evidenceBundle, assessedAt: options.assessedAt ?? at(4) });
  return { manifest: currentManifest, policy, assessment, claim, verification, records, evidenceBundle, candidate };
}

test("CR10B-PUB-000 freezes eight public and nine default-private material classes", () => {
  const registry = buildPublicPackageClassificationRegistryV1();
  assert.deepEqual(parsePublicPackageClassificationRegistryV1(registry), registry);
  assert.deepEqual(registry.definitions.map((item) => item.classId), [...PUBLIC_PACKAGE_CLASS_IDS_V1, ...PRIVATE_PACKAGE_CLASS_IDS_V1]);
  assert.equal(registry.definitions.filter((item) => item.publicEligible).length, 8);
  assert.equal(registry.definitions.filter((item) => !item.publicEligible).length, 9);
  assert.equal(registry.allowByDefault || registry.pathInferenceGrantsEligibility || registry.contentInspectionPerformed
    || registry.grantsPublicationAuthority, false);
});

test("CR10B-PUB-000 rejects re-digested classification drift", () => {
  const registry = buildPublicPackageClassificationRegistryV1(), changed = clone(registry) as unknown as Record<string, unknown>;
  const definitions = changed.definitions as Array<Record<string, unknown>>;
  definitions[8] = resign({ ...definitions[8]!, publicEligible: true, allowedPathRoot: "private/" }, "definitionDigest");
  assert.throws(() => parsePublicPackageClassificationRegistryV1(resign(changed, "registryDigest")), code("classification_mismatch"));
});

test("CR10B-PUB-000 builds one canonical immutable metadata-only manifest", () => {
  const value = manifest();
  assert.deepEqual(parsePublicPackageManifestV1(value), value);
  assert.equal(value.entries.length, 8);
  assert.deepEqual(value.entries.map((entry) => entry.classId).sort(), [...PUBLIC_PACKAGE_CLASS_IDS_V1].sort());
  assert.deepEqual(value.entries.map((entry) => entry.entryPath), [...value.entries.map((entry) => entry.entryPath)].sort());
  assert.equal(value.publicOnlyDeclaration && !value.contentBytesInspectedByContract && !value.symlinksAllowed
    && !value.unicodePathsAllowed && !value.runtimeValuesIncluded && !value.credentialValuesIncluded
    && !value.privateLocatorValuesIncluded && !value.productionHistoryIncluded && !value.signatureClaimsIncluded
    && !value.certificationClaimsIncluded && !value.grantsInstallAuthority && !value.grantsPublicationAuthority, true);
});

test("CR10B-PUB-000 rejects private classes, traversal, local state, and class-root confusion", () => {
  for (const change of [
    { classId: "private:deployment-config" }, { entryPath: "../packages/control-room-core/index.ts" },
    { entryPath: "packages/control-room-core/.env" }, { entryPath: "packages/control-room-core/state.sqlite" },
    { entryPath: "docs/public/index.ts" },
  ]) {
    const current = manifest();
    const coreEntry = current.entries.find((entry) => entry.classId === "public:core")!;
    const input = { ...coreEntry, ...change } as unknown as Record<string, unknown>;
    delete input.entryDigest;
    const registry = buildPublicPackageClassificationRegistryV1(), policy = buildPublicPackageCompatibilityPolicyV1();
    assert.throws(() => buildPublicPackageManifestV1({ manifestId: "manifest:package:negative:0.1.0", packageId: "package:negative",
      packageVersion: "0.1.0", producerId: "producer:negative", classificationRegistryDigest: registry.registryDigest,
      compatibilityPolicyDigest: policy.policyDigest, entries: [input], sourceRevisionDigest: distinct("negative-revision"),
      buildRecipeDigest: distinct("negative-recipe"), dependencyLockDigest: distinct("negative-lock"), sbomDigest: distinct("negative-sbom"),
      licenseInventoryDigest: distinct("negative-license"), noticeDigest: distinct("negative-notice"), provenanceDigest: distinct("negative-provenance"),
      privateTreeScanDigest: distinct("negative-private"), credentialScanDigest: distinct("negative-credential"),
      reproducibilityPlanDigest: distinct("negative-repro"), createdAt: BASE }));
  }
});

test("CR10B-PUB-000 rejects re-digested manifest order, class, and path aliases", () => {
  const value = manifest();
  const reordered = clone(value); reordered.entries.reverse();
  assert.throws(() => parsePublicPackageManifestV1(resign(reordered as unknown as Record<string, unknown>, "manifestDigest")), code("classification_mismatch"));
  const changed = clone(value), position = changed.entries.findIndex((item) => item.classId === "public:core"), entry = changed.entries[position]!;
  entry.classId = "public:documentation";
  changed.entries[position] = resign(entry as unknown as Record<string, unknown>, "entryDigest") as unknown as PublicPackageManifestEntryV1;
  changed.entrySetDigest = sha256Digest(changed.entries.map((item) => item.entryDigest));
  assert.throws(() => parsePublicPackageManifestV1(resign(changed as unknown as Record<string, unknown>, "manifestDigest")), code("classification_mismatch"));
  const collision = clone(value), collisionSource = collision.entries.find((item) => item.classId === "public:core")!,
    duplicate = { ...clone(collisionSource), entryPath: collisionSource.entryPath.replace("index.ts", "INDEX.TS") };
  collision.entries.push(resign(duplicate as unknown as Record<string, unknown>, "entryDigest") as unknown as PublicPackageManifestEntryV1);
  collision.entries.sort((a, b) => a.entryPath.localeCompare(b.entryPath, "en"));
  collision.entrySetDigest = sha256Digest(collision.entries.map((item) => item.entryDigest));
  assert.throws(() => parsePublicPackageManifestV1(resign(collision as unknown as Record<string, unknown>, "manifestDigest")), code("classification_mismatch"));
});

test("CR10B-PUB-000 compatibility policy is exact and rejects re-digested downgrade permission", () => {
  const policy = buildPublicPackageCompatibilityPolicyV1();
  assert.deepEqual(parsePublicPackageCompatibilityPolicyV1(policy), policy);
  assert.deepEqual(policy.supportedContractVersions, [...PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1]);
  const changed = resign({ ...clone(policy), downgradeAccepted: true } as unknown as Record<string, unknown>, "policyDigest");
  assert.throws(() => parsePublicPackageCompatibilityPolicyV1(changed), code("invalid_input"));
});

test("CR10B-PUB-000 accepts only the exact package, format, release line, and contract set", () => {
  const { request, assessment } = compatibility();
  assert.deepEqual(parsePublicPackageCompatibilityRequestV1(request), request);
  assert.deepEqual(parsePublicPackageCompatibilityAssessmentV1(assessment), assessment);
  assert.equal(assessment.compatible, true); assert.deepEqual(assessment.reasons, []);
  assert.equal(assessment.exactContractMatch && assessment.supportedReleaseLine && !assessment.downgradeDetected
    && !assessment.grantsInstallAuthority && !assessment.grantsPublicationAuthority, true);
});

test("CR10B-PUB-000 reports downgrade, format, prerelease, unsupported line, and contract drift", () => {
  assert.deepEqual(compatibility(manifest(), { currentInstalledVersion: "0.1.1" }).assessment.reasons, ["downgrade_rejected"]);
  assert.deepEqual(compatibility(manifest(), { formatVersion: "control-room-public-package-format/v2" }).assessment.reasons,
    ["package_format_mismatch"]);
  const pre = compatibility(manifest("0.1.0-beta.1"));
  assert.deepEqual(pre.assessment.reasons, ["pre_release_rejected"]);
  const unsupported = compatibility(manifest("0.2.0"));
  assert.deepEqual(unsupported.assessment.reasons, ["release_line_unsupported"]);
  const contracts = [...PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1, "control-room-invented/v1"];
  assert.deepEqual(compatibility(manifest(), { contracts }).assessment.reasons, ["contract_set_mismatch"]);
});

test("CR10B-PUB-000 compatibility request identity and ordering cannot be re-digested", () => {
  const { request } = compatibility(), changed = clone(request);
  changed.requestedContractVersions.reverse();
  assert.throws(() => parsePublicPackageCompatibilityRequestV1(resign(changed as unknown as Record<string, unknown>, "requestDigest")),
    code("compatibility_rejected"));
  const renamed = resign({ ...clone(request), requestId: "compatibility-request:forged:0.1.0" } as unknown as Record<string, unknown>, "requestDigest");
  assert.throws(() => parsePublicPackageCompatibilityRequestV1(renamed), code("compatibility_rejected"));
});

test("CR10B-PUB-000 signature digest claims are explicitly unverified and contain no signature or key bytes", () => {
  const current = manifest(), unsigned = signature(current, "unsigned", "not_observed"), signed = signature(current);
  assert.deepEqual(parsePublicPackageSignatureClaimV1(unsigned.claim), unsigned.claim);
  assert.deepEqual(parsePublicPackageSignatureClaimV1(signed.claim), signed.claim);
  assert.equal(unsigned.claim.claimState, "unsigned"); assert.equal(unsigned.claim.algorithm, "none");
  assert.equal(signed.claim.claimState, "unverified_signature_digest"); assert.equal(signed.claim.verificationState, "not_verified");
  assert.equal(signed.claim.signatureBytesPresent || signed.claim.signingKeyValuePresent
    || signed.claim.cryptographicVerificationPerformed || signed.claim.grantsCertification
    || signed.claim.grantsPublicationAuthority, false);
});

test("CR10B-PUB-000 external verification requires an independent verifier and exact claim binding", () => {
  const current = manifest(), signed = signature(current);
  assert.deepEqual(parsePublicPackageSignatureVerificationV1(signed.verification), signed.verification);
  assert.equal(signed.verification.verificationState, "verified_external");
  assert.equal(signed.verification.verifierIndependent && signed.verification.cryptographicVerificationReported, true);
  const claim = buildPublicPackageSignatureClaimV1({ manifest: current, claimState: "unverified_signature_digest",
    signerKeyFingerprintDigest: distinct("self-fingerprint"), signatureDigest: distinct("self-signature"), claimedAt: at(1) });
  assert.throws(() => buildPublicPackageSignatureVerificationV1({ manifest: current, claim,
    verifierId: current.producerId, verificationState: "verified_external", evidenceDigest: distinct("self-evidence"), verifiedAt: at(2) }),
    code("signature_mismatch"));
  const foreign = manifest("0.1.1", "package:control-room:foreign");
  assert.throws(() => buildPublicPackageSignatureVerificationV1({ manifest: foreign, claim,
    verifierId: "verifier:independent:signature", verificationState: "verified_external", evidenceDigest: distinct("foreign-evidence"),
    verifiedAt: at(2) }), code("signature_mismatch"));
});

test("CR10B-PUB-000 eleven ordered gates enforce independence and bounded freshness", () => {
  const current = manifest(), policy = buildPublicPackageCompatibilityPolicyV1(), records = gateRecords(current, "external_digest_only");
  assert.deepEqual(records.map((record) => record.gateId), [...PUBLIC_RELEASE_GATE_IDS_V1]);
  records.forEach((record) => assert.deepEqual(parsePublicReleaseGateEvidenceV1(record), record));
  assert.throws(() => buildPublicReleaseGateEvidenceV1({ manifest: current, policy, gateId: "private_tree_exclusion",
    evidenceMode: "external_digest_only", state: "passed", verifierId: current.producerId, evidenceDigest: distinct("self-private-scan"),
    observedAt: at(2), validUntil: at(100) }), code("evidence_mismatch"));
  assert.throws(() => buildPublicReleaseGateEvidenceV1({ manifest: current, policy, gateId: "sbom_complete",
    evidenceMode: "external_digest_only", state: "passed", verifierId: current.producerId, evidenceDigest: distinct("stale-sbom"),
    observedAt: at(2), validUntil: at(8 * 86_400) }), code("evidence_mismatch"));
});

test("CR10B-PUB-000 evidence bundle rejects reordering and cross-package substitution", () => {
  const value = releaseFixture(), changed = clone(value.evidenceBundle); changed.records.reverse();
  assert.throws(() => parsePublicReleaseEvidenceBundleV1(resign(changed as unknown as Record<string, unknown>, "bundleDigest")),
    code("evidence_mismatch"));
  const foreign = manifest("0.1.1", "package:control-room:foreign"), foreignRecord = gateRecords(foreign, "external_digest_only")[0]!;
  const records = [...value.records]; records[0] = foreignRecord;
  assert.throws(() => buildPublicReleaseEvidenceBundleV1({ manifest: value.manifest, policy: value.policy,
    evidenceMode: "external_digest_only", records, assembledAt: at(3) }), code("evidence_mismatch"));
});

test("CR10B-PUB-000 complete external digest evidence yields only an independent-review candidate", () => {
  const value = releaseFixture();
  assert.deepEqual(parsePublicPackageReleaseCandidateV1(value.candidate), value.candidate);
  assert.equal(value.candidate.state, "candidate_for_independent_release_review"); assert.deepEqual(value.candidate.blockers, []);
  assert.equal(value.candidate.certificationState, "not_certified");
  assert.equal(value.candidate.certificationEligibility, "eligible_for_independent_review");
  assert.equal(value.candidate.freshOwnerReleaseDecisionRequired && value.candidate.independentSecurityReviewRequired
    && value.candidate.cleanRoomInstallEvidenceRequired && !value.candidate.contentBytesInspectedByContract
    && !value.candidate.buildPerformedByContract && !value.candidate.signingPerformedByContract
    && !value.candidate.publicationAttempted && !value.candidate.grantsCertification
    && !value.candidate.grantsInstallAuthority && !value.candidate.grantsPublicationAuthority, true);
});

test("CR10B-PUB-000 synthetic evidence can become only a synthetic candidate", () => {
  const value = releaseFixture({ mode: "synthetic" });
  assert.equal(value.candidate.state, "synthetic_candidate_only");
  assert.deepEqual(value.candidate.blockers, ["synthetic_evidence_only"]);
  assert.equal(value.candidate.certificationEligibility, "not_eligible");
});

test("CR10B-PUB-000 failed, absent, unsigned, and expired evidence remain blocked", () => {
  const failed = releaseFixture({ changes: { private_tree_exclusion: "failed", clean_room_install: "not_observed" } });
  assert.equal(failed.candidate.state, "blocked");
  assert.deepEqual(failed.candidate.blockers, ["private_tree_exclusion", "clean_room_install"]);
  const unsigned = releaseFixture({ verificationState: "not_observed" });
  assert.equal(unsigned.candidate.state, "blocked"); assert.deepEqual(unsigned.candidate.blockers, ["signature_not_verified"]);
  const expired = releaseFixture({ validUntil: at(5), assessedAt: at(6) });
  assert.equal(expired.candidate.state, "blocked"); assert.deepEqual(expired.candidate.blockers, ["evidence_expired"]);
});

test("CR10B-PUB-000 signature and manifest substitution cannot be promoted by re-digesting primary evidence", () => {
  const value = releaseFixture(), foreign = manifest("0.1.1", "package:control-room:foreign");
  assert.throws(() => assessPublicPackageReleaseCandidateV1({ manifest: foreign, policy: value.policy,
    compatibility: value.assessment, signatureClaim: value.claim, signatureVerification: value.verification,
    evidenceBundle: value.evidenceBundle, assessedAt: at(4) }), code("evidence_mismatch"));
  const foreignBinding = { ...clone(value.verification), manifestDigest: foreign.manifestDigest } as unknown as Record<string, unknown>;
  const forgedVerification = resign(foreignBinding, "verificationDigest");
  assert.throws(() => assessPublicPackageReleaseCandidateV1({ manifest: value.manifest, policy: value.policy,
    compatibility: value.assessment, signatureClaim: value.claim, signatureVerification: forgedVerification,
    evidenceBundle: value.evidenceBundle, assessedAt: at(4) }), code("evidence_mismatch"));
});

test("CR10B-PUB-000 safe projection excludes paths, evidence references, and private values", () => {
  const value = releaseFixture(), projection = projectPublicPackageReleaseV1({ manifest: value.manifest, candidate: value.candidate });
  assert.deepEqual(parsePublicPackageReleaseProjectionV1(projection), projection);
  assert.equal(projection.entryCount, 8); assert.equal(projection.publicClassCount, 8);
  assert.equal(projection.publicationAvailable || projection.signingAvailable || projection.containsEntryPaths
    || projection.containsEvidenceReferences || projection.containsPrivateValues || projection.containsCredentialValues
    || projection.grantsCertification || projection.grantsInstallAuthority || projection.grantsPublicationAuthority, false);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("entryPath") || serialized.includes(value.records[0]!.evidenceDigest), false);
});

test("CR10B-PUB-000 disabled publisher stops before build, signing, upload, network, and provider contact", () => {
  const value = releaseFixture(), receipt = createDisabledPublicPackagePublisherV1().publish(value.candidate, at(5));
  assert.deepEqual(parsePublicPackageDisabledPublicationReceiptV1(receipt), receipt);
  assert.equal(receipt.disposition, "disabled_before_provider_contact");
  assert.equal(receipt.providerClientPresent || receipt.registryDestinationPresent || receipt.credentialReferencePresent
    || receipt.networkContacted || receipt.signingAttempted || receipt.buildAttempted || receipt.uploadAttempted
    || receipt.publicationAttempted || receipt.grantsCertification || receipt.grantsInstallAuthority
    || receipt.grantsPublicationAuthority, false);
});

test("CR10B-PUB-000 rejects secret-like values, accessors, and Proxies before behavior runs", () => {
  const current = manifest(), policy = buildPublicPackageCompatibilityPolicyV1();
  assert.throws(() => buildPublicPackageCompatibilityRequestV1({ packageId: current.packageId,
    manifestDigest: current.manifestDigest, requestedPackageVersion: current.packageVersion,
    requestedPackageFormatVersion: PUBLIC_PACKAGE_FORMAT_VERSION_V1,
    requestedContractVersions: [...PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1], requestedAt: BASE,
    extra: "api_key=abcdef123456" }), code("invalid_input"));
  let getterCalled = false;
  const accessor = { packageId: current.packageId, manifestDigest: current.manifestDigest,
    requestedPackageVersion: current.packageVersion, requestedPackageFormatVersion: PUBLIC_PACKAGE_FORMAT_VERSION_V1,
    requestedContractVersions: [...PUBLIC_SUPPORTED_CONTRACT_VERSIONS_V1], requestedAt: BASE };
  Object.defineProperty(accessor, "packageId", { enumerable: true, get() { getterCalled = true; return current.packageId; } });
  assert.throws(() => buildPublicPackageCompatibilityRequestV1(accessor), code("invalid_input")); assert.equal(getterCalled, false);
  const proxied = observedProxy({ manifest: current, policy, gateId: "manifest_integrity", evidenceMode: "synthetic",
    state: "passed", verifierId: current.producerId, evidenceDigest: distinct("proxy"), observedAt: at(2), validUntil: at(10) }, "throwing");
  assert.throws(() => buildPublicReleaseGateEvidenceV1(proxied.value), code("invalid_input")); assert.equal(proxied.trapCount(), 0);
});

test("CR10B-PUB-000 source contains no filesystem, process, signing, registry, or network client", () => {
  const source = readFileSync(new URL("../src/public-package/v1/contract.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:fs", "node:child_process", "node:http", "node:https", "fetch(", "process.env",
    "createPrivateKey", "sign(", "npm publish", "pnpm publish", "registry.npmjs.org"]) assert.equal(source.includes(forbidden), false, forbidden);
});
