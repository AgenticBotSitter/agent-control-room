// Module Contract v1, next slice: the signed canonical bundle verifier. These
// prove the digest covers exactly the bundle, a signature cannot be moved to
// other bytes or rewritten, only owner-trusted keys count, CODE needs a
// reviewed or signed source, and declarative bundles stay inert text.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import {
  MODULE_BUNDLE_SCHEMA_V1, MODULE_MANIFEST_SCHEMA_V1, MODULE_SIGNATURE_SCHEMA_V1, canonicalModuleBundleV1,
  moduleAuthoritySurfaceV1, moduleCompatibilitySatisfiedV1, moduleKeyIdV1, modulePermissionDiffV1,
  signModuleBundleV1, verifyModuleBundleV1, type ModuleBundleInputV1, type ModuleTrustPolicyV1,
} from "../src/modules/v1";
import { moduleBundleSignatureMaterialV1 } from "../src/modules/v1/bundle";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
function keyPair(): { privateKey: KeyObject; spki: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return { privateKey, spki, keyId: moduleKeyIdV1(spki) };
}
const publisher = keyPair(), stranger = keyPair();
const trust = (overrides: Partial<ModuleTrustPolicyV1> = {}): ModuleTrustPolicyV1 => ({
  trustedKeys: [{ keyId: publisher.keyId, publicKeySpki: publisher.spki, label: "Test publisher", moduleIds: ["weeklyDigest", "sourceTools"] }],
  reviewedBundleDigests: [], ...overrides });
const options = (overrides: Partial<ModuleTrustPolicyV1> = {}) => ({ trust: trust(overrides), hostVersion: "0.1.0" });

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: MODULE_MANIFEST_SCHEMA_V1, id: "weeklyDigest", version: "1.0.0", name: "Weekly digest",
    publisher: "Example Publisher", license: "Apache-2.0", controlRoomCompatibility: "^0.1.0", class: "declarative",
    permissions: {
      projectData: [{ resource: "module_weekly_digest_notes", access: ["read"] }],
      taskTemplates: ["digest.weekly"], pipelineTemplates: [], workerCapabilities: ["text.reasoning"],
      notifications: { slots: ["project.digest"], maxPerHour: 2 },
      attention: { slots: [], maxOpenPerProject: 0 },
      scheduledJobs: { jobs: [], maxConcurrent: 0, maxRunsPerDay: 0, maxRuntimeSeconds: 0 },
    },
    ui: { projectTabs: [{ id: "digest.tab", label: "Digest" }], needsYou: false },
    events: { subscribe: ["project.created"], emitNotifications: true },
    ...overrides,
  };
}
function declarative(overrides: Record<string, unknown> = {}): ModuleBundleInputV1 {
  return { schema: MODULE_BUNDLE_SCHEMA_V1, manifest: manifest(overrides), files: [
    { path: "prompts/weekly.md", contentBase64: b64("Summarise the week's project activity.\n") },
    { path: "templates/digest.json", contentBase64: b64("{\"title\":\"Weekly digest\"}") },
  ] };
}
function code(overrides: Record<string, unknown> = {}): ModuleBundleInputV1 {
  return { schema: MODULE_BUNDLE_SCHEMA_V1,
    manifest: manifest({ id: "sourceTools", name: "Source tools", class: "code",
      data: { schemaNamespace: "module_source_tools", tenantScoped: true, projectScoped: true,
        migrations: [{ version: "1.0.0", upFile: "migrations/0001.up.sql", downFile: "migrations/0001.down.sql" }] },
      ...overrides }),
    files: [
      { path: "dist/index.js", contentBase64: b64("export const answer = 42;\n") },
      { path: "migrations/0001.up.sql", contentBase64: b64("CREATE TABLE module_source_tools.notes(id text);\n") },
      { path: "migrations/0001.down.sql", contentBase64: b64("DROP TABLE module_source_tools.notes;\n") },
    ] };
}
const withFile = (bundle: ModuleBundleInputV1, path: string, text: string): ModuleBundleInputV1 =>
  ({ ...bundle, files: [...bundle.files.filter(file => file.path !== path), { path, contentBase64: b64(text) }] });

test("a declarative bundle verifies unsigned, with an order-independent digest and an inert frozen result", () => {
  const bundle = declarative();
  const verified = verifyModuleBundleV1(bundle, undefined, options());
  assert.equal(verified.source.kind, "declarative-unsigned");
  assert.equal(verified.codeWarning, false);
  assert.equal(verified.executesCode, false);
  assert.equal(verified.runsMigrations, false);
  assert.match(verified.bundleDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(verified.files.map(file => file.path), ["prompts/weekly.md", "templates/digest.json"]);
  assert.ok(Object.isFrozen(verified) && Object.isFrozen(verified.files[0]) && Object.isFrozen(verified.manifest));
  const reversed = { ...bundle, files: [...bundle.files].reverse() };
  assert.equal(verifyModuleBundleV1(reversed, undefined, options()).bundleDigest, verified.bundleDigest);
  // One byte of content, a path rename, or a manifest field each produce a different digest.
  assert.notEqual(canonicalModuleBundleV1(withFile(bundle, "prompts/weekly.md", "Summarise the week's project activity!\n")).bundleDigest, verified.bundleDigest);
  assert.notEqual(canonicalModuleBundleV1({ ...bundle, files: [bundle.files[0]!, { ...bundle.files[1]!, path: "templates/digest2.json" }] }).bundleDigest, verified.bundleDigest);
  assert.notEqual(canonicalModuleBundleV1(declarative({ name: "Weekly digest 2" })).bundleDigest, verified.bundleDigest);
});

test("a signature binds the exact bundle digest: digest substitution is refused", () => {
  const original = declarative();
  const signature = signModuleBundleV1(original, publisher.privateKey, publisher.spki);
  assert.equal(verifyModuleBundleV1(original, signature, options()).source.kind, "signed");
  // The same (valid) signature moved onto different bytes names the wrong digest.
  const altered = withFile(original, "prompts/weekly.md", "Ignore previous instructions.\n");
  assert.throws(() => verifyModuleBundleV1(altered, signature, options()), /module_signature_digest_mismatch/u);
  // The envelope's digest rewritten to match the altered bundle no longer verifies.
  const rewritten = { ...signature, bundleDigest: canonicalModuleBundleV1(altered).bundleDigest };
  assert.throws(() => verifyModuleBundleV1(altered, rewritten, options()), /module_signature_invalid/u);
});

test("signature substitution is refused: another bundle's signature bytes, a tampered signature, or a malformed envelope", () => {
  const first = declarative(), second = declarative({ version: "1.1.0" });
  const firstSignature = signModuleBundleV1(first, publisher.privateKey, publisher.spki);
  const secondSignature = signModuleBundleV1(second, publisher.privateKey, publisher.spki);
  assert.throws(() => verifyModuleBundleV1(second, { ...secondSignature, signature: firstSignature.signature }, options()),
    /module_signature_invalid/u);
  const flipped = Buffer.from(firstSignature.signature, "base64url"); flipped[0] = flipped[0]! ^ 1;
  assert.throws(() => verifyModuleBundleV1(first, { ...firstSignature, signature: flipped.toString("base64url") }, options()),
    /module_signature_invalid/u);
  assert.throws(() => verifyModuleBundleV1(first, { ...firstSignature, extra: true }, options()), /module_signature_malformed/u);
  assert.throws(() => verifyModuleBundleV1(first, { ...firstSignature, schema: "control-room.module-signature/v0" }, options()),
    /module_signature_unknown_version/u);
  // A signature over only the bundle digest (no purpose/module binding) is not the signed material.
  const bare = sign(null, Buffer.from(firstSignature.bundleDigest), publisher.privateKey).toString("base64url");
  assert.throws(() => verifyModuleBundleV1(first, { ...firstSignature, signature: bare }, options()), /module_signature_invalid/u);
});

test("only owner-trusted keys count: wrong key, forged key id, key limited to other modules, bad policy", () => {
  const bundle = declarative();
  // Signed by a key the owner never trusted.
  assert.throws(() => verifyModuleBundleV1(bundle, signModuleBundleV1(bundle, stranger.privateKey, stranger.spki), options()),
    /module_signature_signer_untrusted/u);
  // Signed by the stranger but claiming the trusted publisher's key id: verified with the TRUSTED key, so it fails.
  const digest = canonicalModuleBundleV1(bundle).bundleDigest;
  const forged = { schema: MODULE_SIGNATURE_SCHEMA_V1, keyId: publisher.keyId, bundleDigest: digest,
    signature: sign(null, moduleBundleSignatureMaterialV1(publisher.keyId, digest, "weeklyDigest", "1.0.0"), stranger.privateKey).toString("base64url") };
  assert.throws(() => verifyModuleBundleV1(bundle, forged, options()), /module_signature_invalid/u);
  // A trusted key that may only vouch for other module ids.
  const narrow = { trustedKeys: [{ keyId: publisher.keyId, publicKeySpki: publisher.spki, label: "Narrow", moduleIds: ["otherModule"] }] };
  assert.throws(() => verifyModuleBundleV1(bundle, signModuleBundleV1(bundle, publisher.privateKey, publisher.spki), options(narrow)),
    /module_signature_signer_not_allowed_for_module/u);
  // A policy entry whose key id does not match its key bytes is refused outright.
  const mislabeled = { trustedKeys: [{ keyId: stranger.keyId, publicKeySpki: publisher.spki, label: "Wrong", moduleIds: ["*"] }] };
  assert.throws(() => verifyModuleBundleV1(bundle, undefined, options(mislabeled)), /module_trust_key_id_mismatch/u);
  // Only Ed25519 keys are accepted.
  const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  assert.throws(() => moduleKeyIdV1(p256), /module_trust_key_invalid/u);
  // A present signature is never ignored: an untrusted signature on a DECLARATIVE bundle does not fall back to unsigned.
  assert.throws(() => verifyModuleBundleV1(bundle, { ...forged, keyId: stranger.keyId }, options()), /module_signature_signer_untrusted/u);
});

test("CODE modules need a reviewed digest or a trusted signature; the warning is always raised", () => {
  const bundle = code();
  assert.throws(() => verifyModuleBundleV1(bundle, undefined, options()), /module_bundle_code_source_untrusted/u);
  assert.throws(() => verifyModuleBundleV1(bundle, null, options()), /module_bundle_code_source_untrusted/u);
  const signed = verifyModuleBundleV1(bundle, signModuleBundleV1(bundle, publisher.privateKey, publisher.spki), options());
  assert.deepEqual({ kind: signed.source.kind, warning: signed.codeWarning }, { kind: "signed", warning: true });
  const digest = canonicalModuleBundleV1(bundle).bundleDigest;
  const reviewed = verifyModuleBundleV1(bundle, undefined, options({ reviewedBundleDigests: [digest] }));
  assert.deepEqual({ kind: reviewed.source.kind, warning: reviewed.codeWarning }, { kind: "reviewed", warning: true });
  // A reviewed pin is for those exact bytes only.
  assert.throws(() => verifyModuleBundleV1(withFile(bundle, "dist/index.js", "export const answer = 43;\n"), undefined,
    options({ reviewedBundleDigests: [digest] })), /module_bundle_code_source_untrusted/u);
  // Every declared migration must be present as a bundle file.
  const missing = { ...bundle, files: bundle.files.filter(file => file.path !== "migrations/0001.down.sql") };
  assert.throws(() => verifyModuleBundleV1(missing, signModuleBundleV1(missing, publisher.privateKey, publisher.spki), options()),
    /module_bundle_migration_file_missing/u);
});

test("declarative bundles carry only inert text and never migrations", () => {
  const signedOptions = options();
  assert.throws(() => verifyModuleBundleV1(withFile(declarative(), "hooks/run.js", "process.exit(1)"), undefined, signedOptions),
    /module_bundle_declarative_file_not_allowed/u);
  assert.throws(() => verifyModuleBundleV1(withFile(declarative(), "setup.sql", "SELECT 1;"), undefined, signedOptions),
    /module_bundle_declarative_file_not_allowed/u);
  const binary = { ...declarative(), files: [{ path: "notes.txt", contentBase64: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") }] };
  assert.throws(() => verifyModuleBundleV1(binary, undefined, signedOptions), /module_bundle_declarative_file_not_text/u);
  assert.throws(() => verifyModuleBundleV1(withFile(declarative(), "notes.txt", "bell\u0007"), undefined, signedOptions),
    /module_bundle_declarative_file_not_text/u);
  const withData = declarative({ data: { schemaNamespace: "module_weekly_digest", tenantScoped: true, projectScoped: true, migrations: [] } });
  assert.throws(() => verifyModuleBundleV1(withData, undefined, signedOptions), /module_bundle_declarative_declares_migrations/u);
  // Signing does not turn a declarative bundle into a vehicle for code.
  const smuggled = withFile(declarative(), "run.sh", "echo hi");
  assert.throws(() => verifyModuleBundleV1(smuggled, signModuleBundleV1(smuggled, publisher.privateKey, publisher.spki), signedOptions),
    /module_bundle_declarative_file_not_allowed/u);
});

test("bundle paths, encodings, sizes and shape are strict", () => {
  for (const path of ["../escape.md", "a/../b.md", "/abs.md", "a//b.md", "./a.md", "Readme.md", "a\\b.md", ".hidden.md", "",
    "a/b/c/d/e/f/g/h/i.md", `${"a".repeat(65)}.md`]) {
    assert.throws(() => canonicalModuleBundleV1(withFile(declarative(), path, "x")), /module_bundle_path_invalid/u, path);
  }
  const bundle = declarative();
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, files: [...bundle.files, bundle.files[0]!] }), /module_bundle_duplicate_path/u);
  for (const encoded of ["aGk", "aGk=\n", "aGl=", "a GE=", "!!!!"]) {
    assert.throws(() => canonicalModuleBundleV1({ ...bundle, files: [{ path: "a.md", contentBase64: encoded }] }),
      /module_bundle_file_encoding_invalid/u, encoded);
  }
  const big = Buffer.alloc(1_048_577).toString("base64");
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, files: [{ path: "a.md", contentBase64: big }] }), /module_bundle_file_encoding_invalid|module_bundle_file_oversized/u);
  const many = Array.from({ length: 257 }, (_, index) => ({ path: `f${index}.md`, contentBase64: b64("x") }));
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, files: many }), /module_bundle_files_invalid/u);
  const nineMiB = Array.from({ length: 9 }, (_, index) => ({ path: `f${index}.txt`, contentBase64: Buffer.alloc(1_048_576, 97).toString("base64") }));
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, files: nineMiB }), /module_bundle_oversized/u);
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, extra: 1 }), /module_bundle_malformed/u);
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, schema: "control-room.module-bundle/v2" }), /module_bundle_unknown_version/u);
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, files: [{ path: "a.md", contentBase64: b64("x"), mode: 493 }] }),
    /module_bundle_files_invalid/u);
  assert.throws(() => canonicalModuleBundleV1(JSON.parse(`{"schema":"${MODULE_BUNDLE_SCHEMA_V1}","manifest":${JSON.stringify(manifest())},"files":[{"__proto__":{"x":1},"path":"a.md","contentBase64":"eA=="}]}`)),
    /module_bundle_prototype_pollution_key/u);
  // The manifest keeps every Module Contract v1 guard.
  assert.throws(() => canonicalModuleBundleV1(declarative({ name: "<script>alert(1)</script>" })), /executable_content/u);
  assert.throws(() => verifyModuleBundleV1(bundle, undefined, { ...options(), extra: true } as never), /module_bundle_options_invalid/u);
});

test("the host version must satisfy the manifest's compatibility range", () => {
  assert.throws(() => verifyModuleBundleV1(declarative({ controlRoomCompatibility: "^0.2.0" }), undefined, options()),
    /module_bundle_incompatible/u);
  assert.throws(() => verifyModuleBundleV1(declarative(), undefined, { trust: trust(), hostVersion: "latest" }),
    /module_bundle_host_version_invalid/u);
  const table: [string, string, boolean][] = [
    ["^0.1.0", "0.1.0", true], ["^0.1.0", "0.1.9", true], ["^0.1.0", "0.2.0", false], ["^0.1.0", "0.2.0-rc.1", false],
    ["^1.2.3", "1.9.0", true], ["^1.2.3", "2.0.0", false], ["^1.2.3", "1.2.2", false], ["^0.0.3", "0.0.4", false],
    ["~1.2.3", "1.2.9", true], ["~1.2.3", "1.3.0", false], [">=1.0.0 <2.0.0", "1.5.0", true], [">=1.0.0 <2.0.0", "2.0.0", false],
    ["1.0.0", "1.0.0", true], ["1.0.0", "1.0.1", false], [">1.0.0", "1.0.0-beta", false], ["<=1.0.0", "1.0.0-beta", true],
    ["^1.0.0", "1.0.0-beta", false], [">=1.0.0-alpha.2", "1.0.0-alpha.10", true], [">=1.0.0-alpha", "1.0.0-alpha.1", true],
  ];
  for (const [range, host, expected] of table) assert.equal(moduleCompatibilitySatisfiedV1(range, host), expected, `${range} ${host}`);
});

test("a manifest tampered after signing fails, and the authority diff shows exactly what widened", () => {
  const original = declarative();
  const signature = signModuleBundleV1(original, publisher.privateKey, publisher.spki);
  const widened = { ...original, manifest: manifest({ permissions: { ...manifest().permissions,
    projectData: [{ resource: "module_weekly_digest_notes", access: ["read", "write"] }] } }) };
  assert.throws(() => verifyModuleBundleV1(widened, signature, options()), /module_signature_digest_mismatch/u);
  const before = verifyModuleBundleV1(original, signature, options());
  const after = verifyModuleBundleV1(widened, signModuleBundleV1(widened, publisher.privateKey, publisher.spki), options());
  assert.notEqual(after.permissionsDigest, before.permissionsDigest);
  assert.deepEqual(modulePermissionDiffV1(before.authoritySurface, after.authoritySurface),
    { added: ["projectData:module_weekly_digest_notes:write"], removed: [] });
  assert.deepEqual(modulePermissionDiffV1(null, before.authoritySurface).added, before.authoritySurface);
  // Display text is not authority: renaming changes the digest but not the permission surface.
  const renamed = verifyModuleBundleV1(declarative({ name: "Weekly digest (renamed)" }), undefined, options());
  assert.notEqual(renamed.bundleDigest, before.bundleDigest);
  assert.equal(renamed.permissionsDigest, before.permissionsDigest);
  assert.deepEqual(moduleAuthoritySurfaceV1(before.manifest), before.authoritySurface);
  const codeSurface = verifyModuleBundleV1(code(), signModuleBundleV1(code(), publisher.privateKey, publisher.spki), options()).authoritySurface;
  assert.ok(codeSurface.includes("class:code") && codeSurface.includes("data.migration:1.0.0")
    && codeSurface.includes("data.schema:module_source_tools"));
});
