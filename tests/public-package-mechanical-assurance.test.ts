import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_MECHANICAL_PACKAGE_NAMES_V1,
  PUBLIC_MECHANICAL_ROOTS_V1,
  buildPublicDocumentLinkV1,
  buildPublicMechanicalAuditV1,
  buildPublicSensitiveDataFindingV1,
  parsePublicDocumentLinkV1,
  parsePublicMechanicalAuditV1,
  parsePublicSbomComponentV1,
  type PublicMechanicalAuditV1,
} from "../src/public-package/v1";
import { sha256Digest } from "../src/security";
import { collectPublicMechanicalAuditV1 } from "../scripts/public-package-mechanical-audit";
import { observedProxy } from "./proxy-test-helper";

const BASE = "2026-08-29T12:00:00.000Z";
const audit = () => collectPublicMechanicalAuditV1(BASE);
const clone = <T>(value: T): T => structuredClone(value);

test("CR10C-MECH-010 generates a fixed-root digest-only inventory and exact five-component SBOM", () => {
  const value = audit();
  assert.deepEqual(parsePublicMechanicalAuditV1(value), value);
  assert.equal(value.state, "mechanical_candidate_only");
  assert.deepEqual(value.blockers, []);
  assert.equal(value.files.every((item, index, values) => index === 0 || values[index - 1]!.entryPath.localeCompare(item.entryPath) < 0), true);
  assert.deepEqual([...new Set(value.files.map((item) => item.classId))].sort(), PUBLIC_MECHANICAL_ROOTS_V1.map(([classId]) => classId).sort());
  assert.deepEqual(value.sbom.map((item) => item.packageName), [...PUBLIC_MECHANICAL_PACKAGE_NAMES_V1]);
  assert.equal(value.files.some((item) => item.entryPath.includes(".git") || item.entryPath.includes("node_modules")), false);
  assert.equal(value.files.every((item) => !item.executable), true);
  assert.equal(value.contentBodiesRetained || value.licenseDispositionDeclared || value.publicTreeDispositionDeclared
    || value.archiveCreationAllowed || value.packageInstallationAllowed || value.registryContactAllowed || value.networkContactAllowed
    || value.signingAllowed || value.publicationAllowed || value.grantsCertification || value.grantsReleaseAuthority, false);
});

test("CR10C-MECH-020 records license and NOTICE digests without making a legal disposition", () => {
  const value = audit();
  for (const component of value.sbom) {
    assert.deepEqual(parsePublicSbomComponentV1(component), component);
    assert.match(component.licenseFileDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(component.noticeFileDigest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.match(value.licenseNoticeInventoryDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.licenseDispositionDeclared, false);
});

test("CR10C-MECH-030 normalizes the two schemas, two fabricated fixtures, and local public Markdown links", () => {
  const value = audit();
  assert.deepEqual(value.schemas.map((item) => item.entryPath), ["schemas/public/observation-adapter-manifest.v1.json", "schemas/public/release-plan.v1.json"]);
  assert.deepEqual(value.fixtures.map((item) => item.fixtureId), ["fixture:synthetic-reference-adapters:v1", "fixture:synthetic-example:v1"]);
  assert.equal(value.schemas.every((item) => item.draft2020 && item.additionalPropertiesClosed && item.noEffectConstantsPresent), true);
  assert.equal(value.fixtures.every((item) => item.fabricatedOnly && item.memoryOnly && !item.externalEffectsAllowed), true);
  assert.equal(value.links.length > 0 && value.links.every((item) => item.resolvesInsidePublicRoots), true);
  assert.equal(value.links.some((item) => item.targetPath.includes("://") || item.targetPath.startsWith("/")), false);
});

test("CR10C-MECH-040 scans content without retaining bodies and blocks a digest-only sensitive-data finding", () => {
  const value = audit();
  assert.deepEqual(value.sensitiveDataFindings, []);
  const finding = buildPublicSensitiveDataFindingV1({ entryPath: "docs/public/SECURITY.md", kind: "credential_pattern" });
  const blocked = buildPublicMechanicalAuditV1({ observedAt: BASE, files: value.files, sbom: value.sbom, schemas: value.schemas,
    fixtures: value.fixtures, links: value.links, sensitiveDataFindings: [finding] });
  assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.blockers, ["sensitive_data_detected"]);
  assert.equal(JSON.stringify(blocked).includes("credential_pattern"), true);
  assert.equal(JSON.stringify(blocked).includes("not-a-real-secret-value"), false);
  assert.equal(blocked.contentBodiesRetained, false);
});

test("CR10C rejects root, SBOM, normalized-link, and digest substitutions even when re-digested", () => {
  const value = audit();
  const wrongRoot = clone(value);
  wrongRoot.files[0]!.classId = "public:schema";
  const rootBlocked = buildPublicMechanicalAuditV1({ observedAt: BASE, files: wrongRoot.files, sbom: value.sbom, schemas: value.schemas,
    fixtures: value.fixtures, links: value.links, sensitiveDataFindings: value.sensitiveDataFindings });
  assert.deepEqual(rootBlocked.blockers, ["root_inventory_invalid"]);
  const executable = clone(value) as unknown as { files: Array<Record<string, unknown>> };
  executable.files[0]!.executable = true;
  assert.throws(() => buildPublicMechanicalAuditV1({ observedAt: BASE, files: executable.files as never, sbom: value.sbom, schemas: value.schemas,
    fixtures: value.fixtures, links: value.links, sensitiveDataFindings: value.sensitiveDataFindings }));
  const wrongSbom = clone(value.sbom[0]!);
  wrongSbom.dependencies.push("unreviewed-package");
  const material = wrongSbom as unknown as Record<string, unknown>; delete material.componentDigest;
  assert.throws(() => parsePublicSbomComponentV1({ ...material, componentDigest: sha256Digest(material) }));
  assert.throws(() => buildPublicDocumentLinkV1({ sourcePath: "docs/public/GETTING_STARTED.md", targetPath: "docs/private/secret.md", fragment: null, resolvesInsidePublicRoots: true }));
  const link = value.links[0]!, tampered = clone(link) as unknown as Record<string, unknown>;
  tampered.targetPath = "docs/private/secret.md"; delete tampered.linkDigest;
  assert.throws(() => parsePublicDocumentLinkV1({ ...tampered, linkDigest: sha256Digest(tampered) }));
});

test("CR10C parser rejects Proxy input before a trap can run", () => {
  const proxied = observedProxy(audit(), "throwing");
  assert.throws(() => parsePublicMechanicalAuditV1(proxied.value));
  assert.equal(proxied.trapCount(), 0);
});

test("CR10C exact audit identity fails after a re-digested source-inventory substitution", () => {
  const value = clone(audit()) as PublicMechanicalAuditV1;
  value.files[0]!.contentDigest = sha256Digest({ foreign: "public-file" });
  const material = value as unknown as Record<string, unknown>; delete material.auditDigest;
  assert.throws(() => parsePublicMechanicalAuditV1({ ...material, auditDigest: sha256Digest(material) }));
});
