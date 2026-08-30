import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PUBLIC_TREE_DISPOSITION_GATE_IDS_V1,
  parsePublicDirectDependencyLicenseObservationV1,
  parsePublicProjectLicenseObservationV1,
  parsePublicTreeDispositionProjectionV1,
  parsePublicTreeDispositionV1,
  projectPublicTreeDispositionV1,
  type PublicTreeDispositionV1,
} from "../src/public-package/v1";
import { sha256Digest } from "../src/security";
import { collectCurrentPublicTreeDispositionV1 } from "../scripts/public-tree-disposition";
import { collectPublicMechanicalAuditV1 } from "../scripts/public-package-mechanical-audit";
import { observedProxy } from "./proxy-test-helper";

const BASE = "2026-08-29T18:00:00.000Z";
const disposition = () => collectCurrentPublicTreeDispositionV1(BASE);
const clone = <T>(value: T): T => structuredClone(value);

test("CR10C-MECH-050 records the current public tree as blocked, not releasable", () => {
  const value = disposition();
  assert.deepEqual(parsePublicTreeDispositionV1(value), value);
  assert.equal(value.state, "blocked_before_independent_review");
  assert.equal(value.licenseDisposition, "unresolved_owner_authority_and_complete_text_required");
  assert.equal(value.publicTreeDisposition, "mechanical_candidate_not_approved_for_public_release");
  assert.deepEqual(value.gates.map((gate) => gate.gateId), [...PUBLIC_TREE_DISPOSITION_GATE_IDS_V1]);
  assert.deepEqual(value.blockers, value.gates.filter((gate) => gate.state !== "passed_local").map((gate) => gate.gateId));
  assert.equal(value.nextRequiredBlock, "CR10Q-SEC-000/010");
});

test("CR10C-MECH-050 treats project SPDX identifier stubs and missing manifest metadata as actual failures", () => {
  const value = disposition();
  assert.equal(value.projectLicenseIdentifierObserved, "Apache-2.0");
  assert.equal(value.completeProjectLicenseTextObserved || value.packageManifestLicenseMetadataObserved, false);
  assert.equal(value.gates.find((gate) => gate.gateId === "complete_project_license_text")?.state, "failed");
  assert.equal(value.gates.find((gate) => gate.gateId === "package_manifest_license_metadata")?.state, "failed");
  const audit = collectPublicMechanicalAuditV1(BASE);
  assert.equal(audit.sbom.every((component) => component.licenseFileDigest === "sha256:31d33b6815f84ee57fd784c7a88333a776bd3df1532d650bfdad7305d9efbf35"), true);
});

test("CR10C-MECH-050 observes Zod MIT metadata locally but refuses to call it independent provenance", () => {
  const value = disposition();
  assert.equal(value.localDirectDependencyLicenseObserved, true);
  assert.equal(value.directDependencyLicense, "MIT");
  assert.equal(value.localDependencyEvidenceIndependent, false);
  assert.equal(value.gates.find((gate) => gate.gateId === "local_direct_dependency_metadata")?.state, "passed_local");
  assert.equal(value.gates.find((gate) => gate.gateId === "independent_dependency_provenance")?.state, "not_observed");
});

test("CR10C-MECH-050 never infers legal authority or enables a release effect", () => {
  const value = disposition();
  assert.equal(value.legalAdviceProvided || value.authorLicenseGrantInferred || value.publicSafetyCertified || value.releaseArtifactObserved, false);
  assert.equal(value.archiveCreationAllowed || value.packageInstallationAllowed || value.registryContactAllowed || value.networkContactAllowed
    || value.signingAllowed || value.uploadAllowed || value.publicationAllowed || value.grantsCertification || value.grantsReleaseAuthority, false);
});

test("CR10C-MECH-050 safe projection contains reasons but no paths, digests, or license body", () => {
  const value = disposition(), projection = projectPublicTreeDispositionV1(value);
  assert.deepEqual(parsePublicTreeDispositionProjectionV1(projection), projection);
  assert.equal(projection.passedLocalGateCount, 6);
  assert.equal(projection.failedGateCount, 2);
  assert.equal(projection.notObservedGateCount, 9);
  assert.equal(projection.blockerCodes.length, 11);
  assert.equal(projection.containsPaths || projection.containsEvidenceDigests || projection.containsLicenseText
    || projection.publicationAvailable || projection.grantsCertification || projection.grantsReleaseAuthority, false);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("packages/") || serialized.includes("sha256:") || serialized.includes("Permission is hereby granted"), false);
});

test("CR10C-MECH-050 rejects re-digested gate-state and identity substitutions", () => {
  const changed = clone(disposition()) as PublicTreeDispositionV1;
  const gate = changed.gates.find((item) => item.gateId === "owner_publication_decision")!;
  gate.state = "passed_local";
  const gateMaterial = gate as unknown as Record<string, unknown>; delete gateMaterial.gateDigest; gate.gateDigest = sha256Digest(gateMaterial);
  const material = changed as unknown as Record<string, unknown>; delete material.dispositionDigest;
  assert.throws(() => parsePublicTreeDispositionV1({ ...material, dispositionDigest: sha256Digest(material) }));
  const renamed = clone(disposition()) as unknown as Record<string, unknown>;
  renamed.reviewerId = "reviewer:substituted"; delete renamed.dispositionDigest;
  assert.throws(() => parsePublicTreeDispositionV1({ ...renamed, dispositionDigest: sha256Digest(renamed) }));
});

test("CR10C-MECH-050 license and dependency observations reject re-digested semantic drift", () => {
  const current = disposition();
  const audit = collectPublicMechanicalAuditV1(BASE);
  assert.equal(current.mechanicalAuditDigest, audit.auditDigest);
  const source = readFileSync(new URL("../scripts/public-tree-disposition.ts", import.meta.url), "utf8");
  assert.equal(source.includes('packageVersion: "4.1.12"') && source.includes('declaredLicense: "MIT"'), true);
  const project = {
    packageName: "@control-room/public-core", licenseProfile: "spdx_identifier_only", licenseIdentifier: "Apache-2.0", licenseByteLength: 11,
    licenseContentDigest: audit.sbom[0]!.licenseFileDigest, manifestDigest: audit.sbom[0]!.manifestDigest, manifestLicenseDeclaration: null,
  } as const;
  const projectSigned = { ...project, observationDigest: sha256Digest(project) };
  assert.deepEqual(parsePublicProjectLicenseObservationV1(projectSigned), projectSigned);
  assert.throws(() => parsePublicProjectLicenseObservationV1({ ...projectSigned, licenseIdentifier: "MIT", observationDigest: sha256Digest({ ...project, licenseIdentifier: "MIT" }) }));
  assert.throws(() => parsePublicDirectDependencyLicenseObservationV1({ packageName: "zod", packageVersion: "4.1.13", declaredLicense: "MIT",
    localManifestDigest: audit.sbom[0]!.manifestDigest, localLicenseTextDigest: audit.sbom[0]!.licenseFileDigest,
    dependencyLockEntryDigest: audit.sbom[0]!.componentDigest, localTransitiveDependencyCount: 0, evidenceMode: "prepared_workspace_local",
    independentProvenanceVerified: false, observationDigest: sha256Digest({ foreign: true }) }));
});

test("CR10C-MECH-050 rejects Proxy input before behavior can run", () => {
  const proxied = observedProxy(disposition(), "throwing");
  assert.throws(() => parsePublicTreeDispositionV1(proxied.value));
  assert.equal(proxied.trapCount(), 0);
});

test("CR10C-MECH-050 implementation has no release, registry, signer, provider, or native client", () => {
  const protectedSource = readFileSync(new URL("../src/public-package/v1/public-tree-disposition.ts", import.meta.url), "utf8");
  const scriptSource = readFileSync(new URL("../scripts/public-tree-disposition.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:http", "node:https", "node:net", "node:tls", "fetch(", "registry.npmjs.org",
    "createPrivateKey", "sign(", "spawn(", "exec(", "npm publish", "pnpm publish", "process.env"]) {
    assert.equal(protectedSource.includes(forbidden) || scriptSource.includes(forbidden), false, forbidden);
  }
});
