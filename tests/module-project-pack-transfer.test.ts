// M6: download/upload modules and project packs. These prove the exported
// bundle/pack are exactly canonical (a tamper is always caught by the
// existing verifier), that the local signing key loader accepts only a real
// Ed25519 private key, and that a project pack export carries only the
// descriptive fields the pack contract allows.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  MODULE_REGISTRY_V1, canonicalModuleBundleV1, moduleKeyIdV1, verifyModuleBundleV1, type ModuleTrustPolicyV1,
} from "../src/modules/v1";
import { exportModuleBundleV1, loadModuleSigningKeyV1, moduleBundleFileNameV1 } from "../src/modules/v1/transfer";
import { exportProjectAsPackV1 } from "../src/project-packs/transfer";
import { parseProjectPackV2, projectPackDigestV2 } from "../src/project-packs/v2/project-pack";

const noTrust: ModuleTrustPolicyV1 = { trustedKeys: [], reviewedBundleDigests: [] };

test("exporting a registered module id produces the exact canonical bundle with an empty file list", () => {
  const download = exportModuleBundleV1("news", undefined, null);
  assert.equal(download.bundle.manifest, MODULE_REGISTRY_V1.news);
  assert.deepEqual(download.bundle.files, []);
  assert.equal(download.signature, null);
  assert.equal(download.bundleDigest, canonicalModuleBundleV1(download.bundle).bundleDigest);
  assert.equal(download.fileName, "news-1.0.0.module-bundle.json");
});

test("an unknown module id is refused with the registry's own code", () => {
  assert.throws(() => exportModuleBundleV1("doesNotExist", undefined, null), /module_registry_unknown_module/u);
});

test("an unavailable exact version is refused", () => {
  assert.throws(() => exportModuleBundleV1("news", "9.9.9", null), /module_registry_version_unavailable/u);
});

test("the exact currently registered version is accepted when named explicitly", () => {
  const download = exportModuleBundleV1("news", "1.0.0", null);
  assert.equal(download.bundle.manifest, MODULE_REGISTRY_V1.news);
});

test("file names are built only from the exact id and version, ascii-safe", () => {
  assert.equal(moduleBundleFileNameV1("ideaLab", "1.0.0"), "ideaLab-1.0.0.module-bundle.json");
});

test("a downloaded CODE bundle round-trips through the unmodified verifier and needs a trusted source", () => {
  const download = exportModuleBundleV1("news", undefined, null);
  const submission = { bundle: download.bundle, signature: download.signature };
  assert.throws(() => verifyModuleBundleV1(submission.bundle, submission.signature, { trust: noTrust, hostVersion: "0.1.0" }),
    /module_bundle_code_source_untrusted/u, "an unsigned CODE download is honestly untrusted, never silently accepted");
});

test("loadModuleSigningKeyV1 returns null when no key is configured", () => {
  assert.equal(loadModuleSigningKeyV1(undefined), null);
  assert.equal(loadModuleSigningKeyV1(null), null);
});

test("loadModuleSigningKeyV1 refuses a non-Ed25519 key", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  assert.throws(() => loadModuleSigningKeyV1(pkcs8), /module_signing_key_invalid/u);
});

test("loadModuleSigningKeyV1 refuses malformed input", () => {
  assert.throws(() => loadModuleSigningKeyV1("not base64url!!"), /module_signing_key_invalid/u);
  assert.throws(() => loadModuleSigningKeyV1(""), /module_signing_key_invalid/u);
});

test("a configured signing key signs the download, and the same key trusted lets it verify", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const signingKey = loadModuleSigningKeyV1(pkcs8);
  assert.ok(signingKey);
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  assert.equal(signingKey!.publicKeySpki, spki);
  assert.equal(signingKey!.keyId, moduleKeyIdV1(spki));

  const download = exportModuleBundleV1("news", undefined, signingKey);
  assert.ok(download.signature);
  assert.equal(download.signature!.bundleDigest, download.bundleDigest);

  const trusted: ModuleTrustPolicyV1 = { trustedKeys: [{ keyId: signingKey!.keyId, publicKeySpki: spki,
    label: "Local owner key", moduleIds: ["*"] }], reviewedBundleDigests: [] };
  const verified = verifyModuleBundleV1(download.bundle, download.signature, { trust: trusted, hostVersion: "0.1.0" });
  assert.equal(verified.source.kind, "signed");
  assert.equal(verified.moduleId, "news");
});

test("a tampered download (manifest field changed after export) is caught by the digest, not silently accepted", () => {
  const download = exportModuleBundleV1("sessionObservations", undefined, null);
  const tampered = { ...download.bundle, manifest: { ...(download.bundle.manifest as Record<string, unknown>), publisher: "Someone else" } };
  const before = canonicalModuleBundleV1(download.bundle).bundleDigest;
  const after = canonicalModuleBundleV1(tampered).bundleDigest;
  assert.notEqual(before, after, "changing a manifest field must change the digest");
});

test("a signed download is refused once its bytes are tampered, even though a trusted key signed the original", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const signingKey = loadModuleSigningKeyV1(pkcs8)!;
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const trusted: ModuleTrustPolicyV1 = { trustedKeys: [{ keyId: signingKey.keyId, publicKeySpki: spki,
    label: "Local owner key", moduleIds: ["*"] }], reviewedBundleDigests: [] };
  const download = exportModuleBundleV1("news", undefined, signingKey);
  const tampered = { ...download.bundle, manifest: { ...(download.bundle.manifest as Record<string, unknown>), name: "Tampered name" } };
  assert.throws(() => verifyModuleBundleV1(tampered, download.signature, { trust: trusted, hostVersion: "0.1.0" }),
    /module_signature_digest_mismatch/u);
});

// --- Project pack export ---

test("exporting a project builds a v2 pack with exact registered module versions, canonical order", () => {
  const download = exportProjectAsPackV1({ title: "  My Project  ".trim(), summary: "A summary.",
    enabledModules: ["news", "ideaLab", "news"] });
  assert.equal(download.pack.title, "My Project");
  assert.equal(download.pack.summary, "A summary.");
  assert.deepEqual(download.pack.modules, [
    { id: "ideaLab", version: "1.0.0" },
    { id: "news", version: "1.0.0" },
  ], "duplicates are dropped and modules are in canonical id order regardless of input order");
  assert.equal(download.digest, projectPackDigestV2(download.pack));
  assert.equal(download.fileName, "my-project.project-pack.json");
});

test("an empty project summary is replaced with placeholder text, never left invalid", () => {
  const download = exportProjectAsPackV1({ title: "Untitled", summary: "" });
  assert.equal(download.pack.summary, "No summary provided.");
  assert.deepEqual(download.pack.modules, []);
});

test("the project pack file name is ascii-safe even for a title with punctuation and unicode", () => {
  const download = exportProjectAsPackV1({ title: "Café: 2026 Q3 — Plans!", summary: "x" });
  assert.match(download.fileName, /^[a-z0-9-]+\.project-pack\.json$/);
});

test("a title that reduces to nothing safe still produces a usable file name", () => {
  const download = exportProjectAsPackV1({ title: "!!!", summary: "x" });
  assert.equal(download.fileName, "project.project-pack.json");
});

test("an unregistered enabled-module id is refused rather than silently dropped", () => {
  assert.throws(() => exportProjectAsPackV1({ title: "X", summary: "x", enabledModules: ["notAModule"] }),
    /module_registry_unknown_module/u);
});

test("the exported pack round-trips through the unmodified v2 parser and carries no extra fields", () => {
  const download = exportProjectAsPackV1({ title: "Round trip", summary: "Check.", enabledModules: ["news"] });
  const roundTripped = parseProjectPackV2(JSON.parse(JSON.stringify(download.pack)));
  assert.deepEqual(roundTripped, download.pack);
  assert.deepEqual(Object.keys(download.pack).sort(), ["modules", "schema", "setupGuidance", "summary", "title"].sort());
});
