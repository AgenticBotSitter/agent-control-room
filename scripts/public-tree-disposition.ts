import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessPublicTreeDispositionV1,
  buildPublicDirectDependencyLicenseObservationV1,
  buildPublicProjectLicenseObservationV1,
  buildPublicTreeDispositionSourceFactsV1,
  projectPublicTreeDispositionV1,
} from "../src/public-package/v1/public-tree-disposition";
import { collectPublicMechanicalAuditV1 } from "./public-package-mechanical-audit";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const byteDigest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const packageRoots = [
  ["@control-room/public-core", "packages/control-room-core/"],
  ["@control-room/observation-adapter-sdk", "packages/control-room-adapter-sdk/"],
  ["@control-room/conformance-kit", "packages/control-room-conformance-kit/"],
  ["@control-room/synthetic-reference-adapters", "packages/reference-adapters/"],
  ["@control-room/synthetic-example", "examples/synthetic/"],
] as const;

/** Re-derives the current blocked disposition from fixed local evidence only. */
export function collectCurrentPublicTreeDispositionV1(observedAt: string) {
  const audit = collectPublicMechanicalAuditV1(observedAt);
  const projectLicenses = packageRoots.map(([packageName, root]) => {
    const licenseBytes = readFileSync(resolve(repositoryRoot, root, "LICENSE"));
    const manifestBytes = readFileSync(resolve(repositoryRoot, root, "package.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
    if (licenseBytes.toString("utf8").trim() !== "Apache-2.0" || licenseBytes.byteLength !== 11 || Object.hasOwn(manifest, "license")) {
      throw new Error("public disposition source evidence drift");
    }
    return buildPublicProjectLicenseObservationV1({ packageName, licenseProfile: "spdx_identifier_only", licenseIdentifier: "Apache-2.0",
      licenseByteLength: 11, licenseContentDigest: byteDigest(licenseBytes), manifestDigest: byteDigest(manifestBytes), manifestLicenseDeclaration: null });
  });
  const zodManifestBytes = readFileSync(resolve(repositoryRoot, "node_modules/zod/package.json"));
  const zodLicenseBytes = readFileSync(resolve(repositoryRoot, "node_modules/zod/LICENSE"));
  const zodManifest = JSON.parse(zodManifestBytes.toString("utf8")) as { name?: unknown; version?: unknown; license?: unknown; dependencies?: unknown };
  if (zodManifest.name !== "zod" || zodManifest.version !== "4.1.12" || zodManifest.license !== "MIT"
    || zodManifest.dependencies && Object.keys(zodManifest.dependencies as Record<string, unknown>).length !== 0
    || !zodLicenseBytes.toString("utf8").startsWith("MIT License\n")) throw new Error("public disposition local dependency evidence drift");
  const lock = readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const lockMatch = lock.match(/\n {2}zod@4\.1\.12:\n {4}resolution: \{integrity: ([^}]+)\}/);
  if (!lockMatch?.[1]) throw new Error("public disposition lock evidence missing");
  const directDependency = buildPublicDirectDependencyLicenseObservationV1({ packageName: "zod", packageVersion: "4.1.12", declaredLicense: "MIT",
    localManifestDigest: byteDigest(zodManifestBytes), localLicenseTextDigest: byteDigest(zodLicenseBytes), dependencyLockEntryDigest: byteDigest(`zod@4.1.12:${lockMatch[1]}`),
    localTransitiveDependencyCount: 0, evidenceMode: "prepared_workspace_local", independentProvenanceVerified: false });
  const facts = buildPublicTreeDispositionSourceFactsV1({ mechanicalAuditDigest: audit.auditDigest, projectLicenses, directDependency,
    authorLicenseAuthorityConfirmed: false, noticeAttributionReviewed: false, finalArtifactInventoryObserved: false,
    independentPrivateDataReviewComplete: false, independentSecurityReviewComplete: false, signatureVerified: false,
    realCleanRoomInstallObserved: false, ownerPublicationDecisionObserved: false });
  return assessPublicTreeDispositionV1({ audit, facts, reviewerId: "reviewer:codex:architect:local", assessedAt: observedAt });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const disposition = collectCurrentPublicTreeDispositionV1("2026-08-29T18:00:00.000Z");
  process.stdout.write(`${JSON.stringify(projectPublicTreeDispositionV1(disposition))}\n`);
}
