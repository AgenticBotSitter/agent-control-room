import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { PublicPackageContractErrorV1 } from "./errors";
import { parseExactPublicPackageV1, verifyPublicPackageDigestV1 } from "./exact";
import { PUBLIC_PACKAGE_CLASS_IDS_V1, type PublicPackageClassIdV1 } from "./contract";

/**
 * Metadata-only results for a bounded inspection of the eight public roots.
 * This contract never carries file bodies and can never certify, sign, install,
 * archive, publish, or otherwise release a package.
 */
export const PUBLIC_MECHANICAL_ASSURANCE_CONTRACT_V1 = "control-room-public-mechanical-assurance/v1" as const;

export const PUBLIC_MECHANICAL_ROOTS_V1 = [
  ["public:core", "packages/control-room-core/"],
  ["public:adapter-sdk", "packages/control-room-adapter-sdk/"],
  ["public:conformance-kit", "packages/control-room-conformance-kit/"],
  ["public:reference-adapter", "packages/reference-adapters/"],
  ["public:synthetic-example", "examples/synthetic/"],
  ["public:documentation", "docs/public/"],
  ["public:schema", "schemas/public/"],
  ["public:release-metadata", "release/"],
] as const satisfies ReadonlyArray<readonly [PublicPackageClassIdV1, string]>;

export const PUBLIC_MECHANICAL_PACKAGE_NAMES_V1 = [
  "@control-room/public-core", "@control-room/observation-adapter-sdk", "@control-room/conformance-kit",
  "@control-room/synthetic-reference-adapters", "@control-room/synthetic-example",
] as const;

const packageExpectations: Record<(typeof PUBLIC_MECHANICAL_PACKAGE_NAMES_V1)[number], { root: string; dependencies: readonly string[] }> = {
  "@control-room/public-core": { root: "packages/control-room-core/", dependencies: ["zod"] },
  "@control-room/observation-adapter-sdk": { root: "packages/control-room-adapter-sdk/", dependencies: ["@control-room/public-core"] },
  "@control-room/conformance-kit": { root: "packages/control-room-conformance-kit/", dependencies: ["@control-room/observation-adapter-sdk"] },
  "@control-room/synthetic-reference-adapters": { root: "packages/reference-adapters/", dependencies: ["@control-room/public-core", "@control-room/observation-adapter-sdk", "@control-room/conformance-kit"] },
  "@control-room/synthetic-example": { root: "examples/synthetic/", dependencies: ["@control-room/conformance-kit", "@control-room/synthetic-reference-adapters"] },
};

export type PublicMechanicalFindingKindV1 = "credential_pattern" | "private_key_block" | "bearer_token" | "signed_url" | "private_locator";
export type PublicMechanicalBlockerV1 =
  | "root_inventory_invalid" | "sbom_inventory_invalid" | "license_or_notice_missing"
  | "schema_or_fixture_normalization_invalid" | "document_link_invalid" | "sensitive_data_detected";

export interface PublicMechanicalFileV1 {
  entryPath: string;
  classId: PublicPackageClassIdV1;
  mediaType: "application/json" | "application/typescript" | "text/markdown" | "text/plain";
  executable: false;
  byteLength: number;
  contentDigest: string;
}

export interface PublicSbomComponentV1 {
  packageName: (typeof PUBLIC_MECHANICAL_PACKAGE_NAMES_V1)[number];
  packageVersion: "0.1.0";
  root: string;
  dependencies: string[];
  manifestDigest: string;
  licenseFileDigest: string;
  noticeFileDigest: string;
  componentDigest: string;
}

export interface PublicSchemaNormalizationV1 {
  entryPath: "schemas/public/observation-adapter-manifest.v1.json" | "schemas/public/release-plan.v1.json";
  schemaId: "control-room-public-observation-manifest/v1" | "control-room-public-release-tooling/v1";
  draft2020: true;
  additionalPropertiesClosed: true;
  noEffectConstantsPresent: true;
  sourceDigest: string;
  normalizationDigest: string;
}

export interface PublicFixtureNormalizationV1 {
  fixtureId: "fixture:synthetic-reference-adapters:v1" | "fixture:synthetic-example:v1";
  entryPath: "packages/reference-adapters/src/index.ts" | "examples/synthetic/src/index.ts";
  fabricatedOnly: true;
  memoryOnly: true;
  externalEffectsAllowed: false;
  sourceDigest: string;
  normalizationDigest: string;
}

export interface PublicDocumentLinkV1 {
  sourcePath: string;
  targetPath: string;
  fragment: string | null;
  resolvesInsidePublicRoots: true;
  linkDigest: string;
}

export interface PublicSensitiveDataFindingV1 {
  entryPath: string;
  kind: PublicMechanicalFindingKindV1;
  findingDigest: string;
}

export interface PublicMechanicalAuditV1 {
  contractVersion: typeof PUBLIC_MECHANICAL_ASSURANCE_CONTRACT_V1;
  auditId: string;
  observedAt: string;
  files: PublicMechanicalFileV1[];
  sbom: PublicSbomComponentV1[];
  schemas: PublicSchemaNormalizationV1[];
  fixtures: PublicFixtureNormalizationV1[];
  links: PublicDocumentLinkV1[];
  sensitiveDataFindings: PublicSensitiveDataFindingV1[];
  inspectedContentBytes: number;
  sourceInventoryDigest: string;
  sbomDigest: string;
  licenseNoticeInventoryDigest: string;
  normalizationDigest: string;
  privateDataScanDigest: string;
  state: "blocked" | "mechanical_candidate_only";
  blockers: PublicMechanicalBlockerV1[];
  contentBodiesRetained: false;
  licenseDispositionDeclared: false;
  publicTreeDispositionDeclared: false;
  archiveCreationAllowed: false;
  packageInstallationAllowed: false;
  registryContactAllowed: false;
  networkContactAllowed: false;
  signingAllowed: false;
  publicationAllowed: false;
  grantsCertification: false;
  grantsReleaseAuthority: false;
  auditDigest: string;
}

const safePath = z.string().min(4).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((value) => !value.includes("//") && !value.includes("..") && !value.startsWith("/"));
const fileSchema = z.object({ entryPath: safePath, classId: z.enum(PUBLIC_PACKAGE_CLASS_IDS_V1), mediaType: z.enum(["application/json", "application/typescript", "text/markdown", "text/plain"]), executable: z.literal(false), byteLength: z.number().int().min(0).max(2_000_000), contentDigest: digest }).strict();
const componentSchema = z.object({ packageName: z.enum(PUBLIC_MECHANICAL_PACKAGE_NAMES_V1), packageVersion: z.literal("0.1.0"), root: safePath, dependencies: z.array(z.string().min(1).max(180)).max(8), manifestDigest: digest, licenseFileDigest: digest, noticeFileDigest: digest, componentDigest: digest }).strict();
const schemaRecordSchema = z.object({ entryPath: z.enum(["schemas/public/observation-adapter-manifest.v1.json", "schemas/public/release-plan.v1.json"]), schemaId: z.enum(["control-room-public-observation-manifest/v1", "control-room-public-release-tooling/v1"]), draft2020: z.literal(true), additionalPropertiesClosed: z.literal(true), noEffectConstantsPresent: z.literal(true), sourceDigest: digest, normalizationDigest: digest }).strict();
const fixtureRecordSchema = z.object({ fixtureId: z.enum(["fixture:synthetic-reference-adapters:v1", "fixture:synthetic-example:v1"]), entryPath: z.enum(["packages/reference-adapters/src/index.ts", "examples/synthetic/src/index.ts"]), fabricatedOnly: z.literal(true), memoryOnly: z.literal(true), externalEffectsAllowed: z.literal(false), sourceDigest: digest, normalizationDigest: digest }).strict();
const linkSchema = z.object({ sourcePath: safePath, targetPath: safePath, fragment: z.string().min(1).max(180).nullable(), resolvesInsidePublicRoots: z.literal(true), linkDigest: digest }).strict();
const findingSchema = z.object({ entryPath: safePath, kind: z.enum(["credential_pattern", "private_key_block", "bearer_token", "signed_url", "private_locator"]), findingDigest: digest }).strict();
const blockerSchema = z.enum(["root_inventory_invalid", "sbom_inventory_invalid", "license_or_notice_missing", "schema_or_fixture_normalization_invalid", "document_link_invalid", "sensitive_data_detected"]);
const auditSchema = z.object({
  contractVersion: z.literal(PUBLIC_MECHANICAL_ASSURANCE_CONTRACT_V1), auditId: id, observedAt: time,
  files: z.array(fileSchema).min(8).max(300), sbom: z.array(componentSchema).length(5), schemas: z.array(schemaRecordSchema).length(2), fixtures: z.array(fixtureRecordSchema).length(2), links: z.array(linkSchema).max(100), sensitiveDataFindings: z.array(findingSchema).max(100), inspectedContentBytes: z.number().int().min(0).max(50_000_000),
  sourceInventoryDigest: digest, sbomDigest: digest, licenseNoticeInventoryDigest: digest, normalizationDigest: digest, privateDataScanDigest: digest,
  state: z.enum(["blocked", "mechanical_candidate_only"]), blockers: z.array(blockerSchema).max(6), contentBodiesRetained: z.literal(false), licenseDispositionDeclared: z.literal(false), publicTreeDispositionDeclared: z.literal(false), archiveCreationAllowed: z.literal(false), packageInstallationAllowed: z.literal(false), registryContactAllowed: z.literal(false), networkContactAllowed: z.literal(false), signingAllowed: z.literal(false), publicationAllowed: z.literal(false), grantsCertification: z.literal(false), grantsReleaseAuthority: z.literal(false), auditDigest: digest,
}).strict();

function classForPath(entryPath: string): PublicPackageClassIdV1 | undefined {
  return PUBLIC_MECHANICAL_ROOTS_V1.find(([, root]) => entryPath.startsWith(root))?.[0];
}

function sameOrder(values: readonly string[], expected: readonly string[]): boolean { return values.join("|") === expected.join("|"); }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }

export function buildPublicSbomComponentV1(input: Omit<PublicSbomComponentV1, "componentDigest">): PublicSbomComponentV1 {
  const parsed = parseExactPublicPackageV1(componentSchema.omit({ componentDigest: true }), input, "public SBOM component");
  return parsePublicSbomComponentV1({ ...parsed, componentDigest: sha256Digest(parsed) });
}

export function parsePublicSbomComponentV1(value: unknown): PublicSbomComponentV1 {
  const parsed = parseExactPublicPackageV1(componentSchema, value, "public SBOM component");
  const expected = packageExpectations[parsed.packageName];
  if (!expected || parsed.root !== expected.root || !sameOrder(parsed.dependencies, [...expected.dependencies].sort()) || !unique(parsed.dependencies)) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "componentDigest", parsed.componentDigest);
  return parsed;
}

export function buildPublicSchemaNormalizationV1(input: Omit<PublicSchemaNormalizationV1, "normalizationDigest">): PublicSchemaNormalizationV1 {
  const parsed = parseExactPublicPackageV1(schemaRecordSchema.omit({ normalizationDigest: true }), input, "public schema normalization");
  return parsePublicSchemaNormalizationV1({ ...parsed, normalizationDigest: sha256Digest(parsed) });
}

export function parsePublicSchemaNormalizationV1(value: unknown): PublicSchemaNormalizationV1 {
  const parsed = parseExactPublicPackageV1(schemaRecordSchema, value, "public schema normalization");
  const expected = parsed.entryPath.includes("observation") ? "control-room-public-observation-manifest/v1" : "control-room-public-release-tooling/v1";
  if (parsed.schemaId !== expected) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "normalizationDigest", parsed.normalizationDigest);
  return parsed;
}

export function buildPublicFixtureNormalizationV1(input: Omit<PublicFixtureNormalizationV1, "normalizationDigest">): PublicFixtureNormalizationV1 {
  const parsed = parseExactPublicPackageV1(fixtureRecordSchema.omit({ normalizationDigest: true }), input, "public fixture normalization");
  return parsePublicFixtureNormalizationV1({ ...parsed, normalizationDigest: sha256Digest(parsed) });
}

export function parsePublicFixtureNormalizationV1(value: unknown): PublicFixtureNormalizationV1 {
  const parsed = parseExactPublicPackageV1(fixtureRecordSchema, value, "public fixture normalization");
  const expected = parsed.fixtureId === "fixture:synthetic-reference-adapters:v1" ? "packages/reference-adapters/src/index.ts" : "examples/synthetic/src/index.ts";
  if (parsed.entryPath !== expected) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "normalizationDigest", parsed.normalizationDigest);
  return parsed;
}

export function buildPublicDocumentLinkV1(input: Omit<PublicDocumentLinkV1, "linkDigest">): PublicDocumentLinkV1 {
  const parsed = parseExactPublicPackageV1(linkSchema.omit({ linkDigest: true }), input, "public document link");
  return parsePublicDocumentLinkV1({ ...parsed, linkDigest: sha256Digest(parsed) });
}

export function parsePublicDocumentLinkV1(value: unknown): PublicDocumentLinkV1 {
  const parsed = parseExactPublicPackageV1(linkSchema, value, "public document link");
  if (!classForPath(parsed.sourcePath) || !classForPath(parsed.targetPath)) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "linkDigest", parsed.linkDigest);
  return parsed;
}

export function buildPublicSensitiveDataFindingV1(input: Omit<PublicSensitiveDataFindingV1, "findingDigest">): PublicSensitiveDataFindingV1 {
  const parsed = parseExactPublicPackageV1(findingSchema.omit({ findingDigest: true }), input, "public sensitive data finding");
  return parsePublicSensitiveDataFindingV1({ ...parsed, findingDigest: sha256Digest(parsed) });
}

export function parsePublicSensitiveDataFindingV1(value: unknown): PublicSensitiveDataFindingV1 {
  const parsed = parseExactPublicPackageV1(findingSchema, value, "public sensitive data finding");
  if (!classForPath(parsed.entryPath)) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "findingDigest", parsed.findingDigest);
  return parsed;
}

function auditBlockers(input: Pick<PublicMechanicalAuditV1, "files" | "sbom" | "schemas" | "fixtures" | "links" | "sensitiveDataFindings">): PublicMechanicalBlockerV1[] {
  const blockers: PublicMechanicalBlockerV1[] = [];
  const sortedFiles = [...input.files].sort((a, b) => a.entryPath.localeCompare(b.entryPath));
  if (!unique(sortedFiles.map((item) => item.entryPath)) || sortedFiles.some((item) => classForPath(item.entryPath) !== item.classId || item.executable)
    || !sameOrder(sortedFiles.map((item) => item.entryPath), input.files.map((item) => item.entryPath))
    || PUBLIC_MECHANICAL_ROOTS_V1.some(([classId]) => !input.files.some((item) => item.classId === classId))) blockers.push("root_inventory_invalid");
  if (!unique(input.sbom.map((item) => item.packageName)) || !sameOrder(input.sbom.map((item) => item.packageName), PUBLIC_MECHANICAL_PACKAGE_NAMES_V1)
    || input.sbom.some((item) => !item.root.endsWith("/") || !classForPath(item.root))) blockers.push("sbom_inventory_invalid");
  if (input.sbom.some((item) => !item.licenseFileDigest || !item.noticeFileDigest)) blockers.push("license_or_notice_missing");
  if (!sameOrder(input.schemas.map((item) => item.entryPath), ["schemas/public/observation-adapter-manifest.v1.json", "schemas/public/release-plan.v1.json"])
    || !sameOrder(input.fixtures.map((item) => item.fixtureId), ["fixture:synthetic-reference-adapters:v1", "fixture:synthetic-example:v1"])) blockers.push("schema_or_fixture_normalization_invalid");
  if (!unique(input.links.map((item) => item.linkDigest))) blockers.push("document_link_invalid");
  if (input.sensitiveDataFindings.length > 0) blockers.push("sensitive_data_detected");
  return blockers;
}

export function buildPublicMechanicalAuditV1(input: {
  observedAt: string;
  files: PublicMechanicalFileV1[];
  sbom: PublicSbomComponentV1[];
  schemas: PublicSchemaNormalizationV1[];
  fixtures: PublicFixtureNormalizationV1[];
  links: PublicDocumentLinkV1[];
  sensitiveDataFindings: PublicSensitiveDataFindingV1[];
}): PublicMechanicalAuditV1 {
  const files = input.files.map((item) => parseExactPublicPackageV1(fileSchema, item, "public mechanical file"));
  const sbom = input.sbom.map(parsePublicSbomComponentV1);
  const schemas = input.schemas.map(parsePublicSchemaNormalizationV1);
  const fixtures = input.fixtures.map(parsePublicFixtureNormalizationV1);
  const links = input.links.map(parsePublicDocumentLinkV1);
  const sensitiveDataFindings = input.sensitiveDataFindings.map(parsePublicSensitiveDataFindingV1);
  const blockers = auditBlockers({ files, sbom, schemas, fixtures, links, sensitiveDataFindings });
  const sourceInventoryDigest = sha256Digest(files);
  const sbomDigest = sha256Digest(sbom.map(({ componentDigest }) => componentDigest));
  const licenseNoticeInventoryDigest = sha256Digest(sbom.map(({ packageName, licenseFileDigest, noticeFileDigest }) => ({ packageName, licenseFileDigest, noticeFileDigest })));
  const normalizationDigest = sha256Digest({ schemas: schemas.map(({ normalizationDigest }) => normalizationDigest), fixtures: fixtures.map(({ normalizationDigest }) => normalizationDigest), links: links.map(({ linkDigest }) => linkDigest) });
  const privateDataScanDigest = sha256Digest(sensitiveDataFindings);
  const auditIdentity = { sourceInventoryDigest, sbomDigest, licenseNoticeInventoryDigest, normalizationDigest, privateDataScanDigest };
  const material: Omit<PublicMechanicalAuditV1, "auditDigest"> = {
    contractVersion: PUBLIC_MECHANICAL_ASSURANCE_CONTRACT_V1, auditId: `mechanical-audit:${sha256Digest(auditIdentity).slice(7, 31)}`,
    observedAt: input.observedAt, files, sbom, schemas, fixtures, links, sensitiveDataFindings,
    inspectedContentBytes: files.reduce((sum, item) => sum + item.byteLength, 0), sourceInventoryDigest, sbomDigest, licenseNoticeInventoryDigest,
    normalizationDigest, privateDataScanDigest, state: blockers.length === 0 ? "mechanical_candidate_only" : "blocked", blockers,
    contentBodiesRetained: false, licenseDispositionDeclared: false, publicTreeDispositionDeclared: false,
    archiveCreationAllowed: false, packageInstallationAllowed: false, registryContactAllowed: false, networkContactAllowed: false,
    signingAllowed: false, publicationAllowed: false, grantsCertification: false, grantsReleaseAuthority: false,
  };
  return parsePublicMechanicalAuditV1({ ...material, auditDigest: sha256Digest(material) });
}

export function parsePublicMechanicalAuditV1(value: unknown): PublicMechanicalAuditV1 {
  const parsed = parseExactPublicPackageV1(auditSchema, value, "public mechanical audit");
  const components = parsed.sbom.map(parsePublicSbomComponentV1), schemas = parsed.schemas.map(parsePublicSchemaNormalizationV1), fixtures = parsed.fixtures.map(parsePublicFixtureNormalizationV1), links = parsed.links.map(parsePublicDocumentLinkV1), findings = parsed.sensitiveDataFindings.map(parsePublicSensitiveDataFindingV1);
  const blockers = auditBlockers({ files: parsed.files, sbom: components, schemas, fixtures, links, sensitiveDataFindings: findings });
  if (!sameOrder(parsed.blockers, blockers) || parsed.state !== (blockers.length === 0 ? "mechanical_candidate_only" : "blocked")
    || parsed.inspectedContentBytes !== parsed.files.reduce((sum, item) => sum + item.byteLength, 0)) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const sourceInventoryDigest = sha256Digest(parsed.files);
  const sbomDigest = sha256Digest(components.map(({ componentDigest }) => componentDigest));
  const licenseNoticeInventoryDigest = sha256Digest(components.map(({ packageName, licenseFileDigest, noticeFileDigest }) => ({ packageName, licenseFileDigest, noticeFileDigest })));
  const normalizationDigest = sha256Digest({ schemas: schemas.map(({ normalizationDigest }) => normalizationDigest), fixtures: fixtures.map(({ normalizationDigest }) => normalizationDigest), links: links.map(({ linkDigest }) => linkDigest) });
  const privateDataScanDigest = sha256Digest(findings);
  if (parsed.sourceInventoryDigest !== sourceInventoryDigest || parsed.sbomDigest !== sbomDigest || parsed.licenseNoticeInventoryDigest !== licenseNoticeInventoryDigest
    || parsed.normalizationDigest !== normalizationDigest || parsed.privateDataScanDigest !== privateDataScanDigest) throw new PublicPackageContractErrorV1("evidence_mismatch");
  const identity = { sourceInventoryDigest, sbomDigest, licenseNoticeInventoryDigest, normalizationDigest, privateDataScanDigest };
  if (parsed.auditId !== `mechanical-audit:${sha256Digest(identity).slice(7, 31)}`) throw new PublicPackageContractErrorV1("evidence_mismatch");
  verifyPublicPackageDigestV1(parsed as unknown as Record<string, unknown>, "auditDigest", parsed.auditDigest);
  return parsed;
}
