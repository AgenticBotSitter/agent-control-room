import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_MECHANICAL_PACKAGE_NAMES_V1,
  PUBLIC_MECHANICAL_ROOTS_V1,
  buildPublicDocumentLinkV1,
  buildPublicFixtureNormalizationV1,
  buildPublicMechanicalAuditV1,
  buildPublicSchemaNormalizationV1,
  buildPublicSbomComponentV1,
  buildPublicSensitiveDataFindingV1,
  type PublicMechanicalFileV1,
} from "../src/public-package/v1/mechanical-assurance";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const secretPatterns: ReadonlyArray<readonly ["credential_pattern" | "private_key_block" | "bearer_token" | "signed_url" | "private_locator", RegExp]> = [
  ["private_key_block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["bearer_token", /\bBearer\s+[a-z0-9._~+/=-]{12,}/i],
  ["credential_pattern", /(?:api[_-]?key|password|passphrase|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{6,}/i],
  ["signed_url", /(?:X-Amz-Signature|X-Amz-Credential)=/i],
  ["private_locator", /(?:postgres(?:ql)?:\/\/|s3:\/\/|file:\/\/)/i],
];

const packageRoots = [
  ["@control-room/public-core", "packages/control-room-core/", ["zod"]],
  ["@control-room/observation-adapter-sdk", "packages/control-room-adapter-sdk/", ["@control-room/public-core"]],
  ["@control-room/conformance-kit", "packages/control-room-conformance-kit/", ["@control-room/observation-adapter-sdk"]],
  ["@control-room/synthetic-reference-adapters", "packages/reference-adapters/", ["@control-room/public-core", "@control-room/observation-adapter-sdk", "@control-room/conformance-kit"]],
  ["@control-room/synthetic-example", "examples/synthetic/", ["@control-room/conformance-kit", "@control-room/synthetic-reference-adapters"]],
] as const;

function publicPath(absolutePath: string): string {
  const value = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
  if (!value || value.startsWith("../") || value.includes("/../") || !PUBLIC_MECHANICAL_ROOTS_V1.some(([, root]) => value.startsWith(root))) {
    throw new Error("public audit path escaped fixed roots");
  }
  return value;
}

function classForPath(entryPath: string): PublicMechanicalFileV1["classId"] {
  const classId = PUBLIC_MECHANICAL_ROOTS_V1.find(([, root]) => entryPath.startsWith(root))?.[0];
  if (!classId) throw new Error("public audit class missing");
  return classId;
}

function mediaType(entryPath: string): PublicMechanicalFileV1["mediaType"] {
  if (entryPath.endsWith(".ts")) return "application/typescript";
  if (entryPath.endsWith(".json")) return "application/json";
  if (entryPath.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

function collectFiles(directory: string): string[] {
  const rootStatus = lstatSync(directory);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) throw new Error("public audit rejects substituted roots");
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name), status = lstatSync(absolutePath);
    if (status.isSymbolicLink() || !status.isFile() && !status.isDirectory()) throw new Error("public audit rejects symlinks and special entries");
    if (status.isDirectory()) result.push(...collectFiles(absolutePath)); else result.push(absolutePath);
  }
  return result;
}

function parseLinkTarget(sourcePath: string, rawTarget: string): { targetPath: string; fragment: string | null } {
  if (!rawTarget || rawTarget.includes("://") || rawTarget.startsWith("/") || rawTarget.includes("\\") || rawTarget.includes("?")) throw new Error("public audit link target is not local");
  const [relativeTarget, fragment] = rawTarget.split("#", 2);
  const absoluteTarget = resolve(dirname(resolve(repositoryRoot, sourcePath)), relativeTarget!);
  return { targetPath: publicPath(absoluteTarget), fragment: fragment || null };
}

function noEffectSchema(path: string, value: Record<string, unknown>): boolean {
  const properties = value.properties as Record<string, { const?: unknown }> | undefined;
  if (!properties) return false;
  if (path.endsWith("observation-adapter-manifest.v1.json")) return properties.effectAuthority?.const === "none" && properties.accessMode?.const === "none";
  return ["archiveCreationAllowed", "packageInstallationAllowed", "registryContactAllowed", "networkContactAllowed", "nativeHarnessContactAllowed", "signingAllowed", "publicationAllowed", "grantsReleaseAuthority"].every((key) => properties[key]?.const === false);
}

/** Reads only the fixed public roots and returns digest-only mechanical evidence. */
export function collectPublicMechanicalAuditV1(observedAt: string) {
  const paths = PUBLIC_MECHANICAL_ROOTS_V1.flatMap(([, root]) => collectFiles(resolve(repositoryRoot, root))).sort((left, right) => publicPath(left).localeCompare(publicPath(right)));
  const files: PublicMechanicalFileV1[] = [];
  const findings = [] as ReturnType<typeof buildPublicSensitiveDataFindingV1>[];
  const contents = new Map<string, string>();
  for (const absolutePath of paths) {
    const entryPath = publicPath(absolutePath), status = lstatSync(absolutePath), bytes = readFileSync(absolutePath), text = bytes.toString("utf8");
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o111) !== 0) throw new Error("public audit rejects executable or substituted files");
    files.push({ entryPath, classId: classForPath(entryPath), mediaType: mediaType(entryPath), executable: false, byteLength: bytes.byteLength, contentDigest: digest(bytes) });
    contents.set(entryPath, text);
    for (const [kind, pattern] of secretPatterns) {
      if (pattern.test(text)) findings.push(buildPublicSensitiveDataFindingV1({ entryPath, kind }));
    }
  }
  const file = (entryPath: string) => files.find((item) => item.entryPath === entryPath) ?? (() => { throw new Error("public audit required file missing"); })();
  const sbom = packageRoots.map(([packageName, root, expectedDependencies]) => {
    const manifestPath = `${root}package.json`, manifest = JSON.parse(contents.get(manifestPath) ?? "") as { name?: unknown; version?: unknown; dependencies?: unknown };
    if (manifest.name !== packageName || manifest.version !== "0.1.0" || JSON.stringify(Object.keys((manifest.dependencies ?? {}) as Record<string, unknown>).sort()) !== JSON.stringify([...expectedDependencies].sort())) throw new Error("public audit package manifest drift");
    return buildPublicSbomComponentV1({ packageName, packageVersion: "0.1.0", root, dependencies: [...expectedDependencies].sort(), manifestDigest: file(manifestPath).contentDigest, licenseFileDigest: file(`${root}LICENSE`).contentDigest, noticeFileDigest: file(`${root}NOTICE`).contentDigest });
  });
  if (sbom.map((item) => item.packageName).join("|") !== PUBLIC_MECHANICAL_PACKAGE_NAMES_V1.join("|")) throw new Error("public audit SBOM order drift");
  const schemaPaths = ["schemas/public/observation-adapter-manifest.v1.json", "schemas/public/release-plan.v1.json"] as const;
  const schemas = schemaPaths.map((entryPath) => {
    const value = JSON.parse(contents.get(entryPath) ?? "") as Record<string, unknown>, schemaId = value.$id;
    if (value.$schema !== "https://json-schema.org/draft/2020-12/schema" || value.additionalProperties !== false || typeof schemaId !== "string" || !noEffectSchema(entryPath, value)) throw new Error("public audit schema normalization failed");
    return buildPublicSchemaNormalizationV1({ entryPath, schemaId: schemaId as "control-room-public-observation-manifest/v1" | "control-room-public-release-tooling/v1", draft2020: true, additionalPropertiesClosed: true, noEffectConstantsPresent: true, sourceDigest: file(entryPath).contentDigest });
  });
  const fixtures = [
    buildPublicFixtureNormalizationV1({ fixtureId: "fixture:synthetic-reference-adapters:v1", entryPath: "packages/reference-adapters/src/index.ts", fabricatedOnly: true, memoryOnly: true, externalEffectsAllowed: false, sourceDigest: file("packages/reference-adapters/src/index.ts").contentDigest }),
    buildPublicFixtureNormalizationV1({ fixtureId: "fixture:synthetic-example:v1", entryPath: "examples/synthetic/src/index.ts", fabricatedOnly: true, memoryOnly: true, externalEffectsAllowed: false, sourceDigest: file("examples/synthetic/src/index.ts").contentDigest }),
  ];
  const links = files.filter((item) => item.mediaType === "text/markdown").flatMap((item) => [...(contents.get(item.entryPath) ?? "").matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => {
    const parsed = parseLinkTarget(item.entryPath, match[1]!);
    if (!files.some((candidate) => candidate.entryPath === parsed.targetPath)) throw new Error("public audit markdown link target missing");
    return buildPublicDocumentLinkV1({ sourcePath: item.entryPath, targetPath: parsed.targetPath, fragment: parsed.fragment, resolvesInsidePublicRoots: true });
  }));
  return buildPublicMechanicalAuditV1({ observedAt, files, sbom, schemas, fixtures, links, sensitiveDataFindings: findings });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(collectPublicMechanicalAuditV1("2026-08-29T12:00:00.000Z"))}\n`);
}
