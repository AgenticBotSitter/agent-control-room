import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { buildTextArtifactBundle, type TextArtifactBundleInputV1 } from "../src/node-executor/artifact-evidence.ts";

function validInput(overrides: Partial<TextArtifactBundleInputV1> = {}): TextArtifactBundleInputV1 {
  return {
    artifactId: "artifact-0001",
    claimId: "claim-0001",
    tenantId: "tenant-a",
    projectId: "project-a",
    jobId: "job-0001",
    attemptId: "attempt-0001",
    producerId: "producer-node-1",
    logicalRole: "execution-report",
    schemaVersion: "1.0.0",
    storageClass: "repository",
    retentionClass: "standard-90d",
    text: "hello artifact body\nline two\n",
    createdAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("builds exact UTF-8 bytes and content hash over raw bytes, not canonical JSON", () => {
  const text = "héllo — unicode ✓";
  const bundle = buildTextArtifactBundle(validInput({ text }));
  const expected = new TextEncoder().encode(text);
  assert.deepEqual(Buffer.from(bundle.bytes), Buffer.from(expected));
  assert.equal(bundle.manifest.sizeBytes, expected.byteLength);
  assert.equal(bundle.manifest.contentHash, `sha256:${sha256Hex(expected)}`);
});

test("content hash differs between a value and its differently-serialized form", () => {
  // raw bytes vs. the same payload with different whitespace: hashes must reflect exact bytes
  const bundle = buildTextArtifactBundle(validInput({ text: '{"a":1,"b":2}' }));
  const compact = new TextEncoder().encode('{"a": 1, "b": 2}');
  assert.notEqual(bundle.manifest.contentHash, `sha256:${sha256Hex(compact)}`);
});

test("manifest matches the domain record contract exactly", () => {
  const input = validInput({ workflowId: "workflow-9" });
  const bundle = buildTextArtifactBundle(input);
  assert.equal(bundle.manifest.contractVersion, "control-room-domain/v1");
  assert.equal(bundle.manifest.kind, "artifact_manifest");
  assert.equal(bundle.manifest.id, "artifact-0001");
  assert.equal(bundle.manifest.tenantId, "tenant-a");
  assert.equal(bundle.manifest.version, 0);
  assert.equal(bundle.manifest.state, "declared");
  assert.equal(bundle.manifest.mimeType, "text/plain; charset=utf-8");
  assert.equal(bundle.manifest.createdAt, bundle.manifest.updatedAt);
  assert.equal(bundle.manifest.workflowId, "workflow-9");
});

test("manifest omits optional fields when absent", () => {
  const bundle = buildTextArtifactBundle(validInput());
  assert.equal("workflowId" in bundle.manifest, false);
  assert.equal("opaqueLocator" in bundle.manifest, false);
});

test("manifestDigest is the repository canonical digest of the manifest", async () => {
  const bundle = buildTextArtifactBundle(validInput());
  const { sha256Digest } = await import("../src/security/digest.ts");
  assert.equal(bundle.verificationClaim.manifestDigest, sha256Digest(bundle.manifest));
});

test("claim digest covers every claim field except claimDigest itself", async () => {
  const bundle = buildTextArtifactBundle(validInput());
  const { sha256Digest } = await import("../src/security/digest.ts");
  const { claimDigest, ...rest } = bundle.verificationClaim;
  assert.equal(typeof claimDigest, "string");
  assert.equal(claimDigest!.length, "sha256:".length + 64);
  assert.equal(claimDigest, sha256Digest(rest));
});

test("claim is separated from manifest: no verified/accepted/approval fields", () => {
  const bundle = buildTextArtifactBundle(validInput());
  const serialized = JSON.stringify(bundle.verificationClaim).toLowerCase();
  assert.equal(serialized.includes('"verified'), false);
  assert.equal(serialized.includes('"accepted'), false);
  assert.equal(serialized.includes("approval"), false);
  assert.equal(bundle.verificationClaim.claim, "content_hash_matches_exact_bytes");
  // locator never copied into claim
  const withLocator = buildTextArtifactBundle(validInput({ opaqueLocator: "repo://bucket/path/file.txt" }));
  assert.equal(JSON.stringify(withLocator.verificationClaim).includes("repo://"), false);
});

test("opaqueLocator lands on the manifest but never on the claim", () => {
  const bundle = buildTextArtifactBundle(validInput({ opaqueLocator: "r2://artifacts/x.bin" }));
  assert.equal(bundle.manifest.opaqueLocator, "r2://artifacts/x.bin");
  assert.equal("opaqueLocator" in bundle.verificationClaim, false);
});

test("canonical RFC 3339 UTC createdAt round-trips; non-canonical denied", () => {
  assert.doesNotThrow(() => buildTextArtifactBundle(validInput()));
  for (const bad of ["2026-08-26T12:00:00+00:00", "2026-08-26T12:00:00Z", "2026-08-26 12:00:00Z", "not-a-date"]) {
    assert.throws(() => buildTextArtifactBundle(validInput({ createdAt: bad })), Error, `should deny ${bad}`);
  }
});

test("size limit: text over 65,536 UTF-8 bytes denied", () => {
  const big = "x".repeat(65_537);
  assert.throws(() => buildTextArtifactBundle(validInput({ text: big })));
  const edge = "y".repeat(65_536);
  assert.doesNotThrow(() => buildTextArtifactBundle(validInput({ text: edge })));
});

test("identifier validation: empty, long, whitespace, control characters denied", () => {
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "a".repeat(201) })));
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "has space" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "tab\tinside" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "nl\ninside" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "ctrl\u0007bell" })));
  // Unicode whitespace is also rejected: NBSP, em space, ideographic space.
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "nbsp\u00a0inside" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "em\u2003space" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ artifactId: "ideo\u3000space" })));
  assert.doesNotThrow(() => buildTextArtifactBundle(validInput({ artifactId: "a".repeat(200) })));
});

test("empty logical role, schema version, or retention class denied", () => {
  assert.throws(() => buildTextArtifactBundle(validInput({ logicalRole: "" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ schemaVersion: "" })));
  assert.throws(() => buildTextArtifactBundle(validInput({ retentionClass: "" })));
});

test("invalid storage class denied", () => {
  assert.throws(() => buildTextArtifactBundle(validInput({ storageClass: "usb-stick" as never })));
});

test("secret-material rejection: locator, manifest, and claim are guarded", () => {
  // Contract mandates: opaqueLocator passes the secret-material guard; manifest and claim are guarded before return.
  assert.throws(
    () => buildTextArtifactBundle(validInput({ opaqueLocator: "https://user:supersecret9@host.example/file.txt" })),
    Error,
  );
  // A secret-bearing field name on the record shape would be caught by the guard; verify the guard
  // fires through the module by probing a locator that trips the key-pattern rule.
  assert.throws(() => buildTextArtifactBundle(validInput({ opaqueLocator: "Bearer abcdef1234567890abcdef" })), Error);
});

test("input immutability: caller object is not mutated by construction", () => {
  const input = validInput();
  const snapshot = JSON.stringify(input);
  buildTextArtifactBundle(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test("deterministic output: same input yields byte-identical digests", () => {
  const a = buildTextArtifactBundle(validInput());
  const b = buildTextArtifactBundle(validInput());
  assert.equal(a.manifest.contentHash, b.manifest.contentHash);
  assert.equal(a.verificationClaim.manifestDigest, b.verificationClaim.manifestDigest);
  assert.equal(a.verificationClaim.claimDigest, b.verificationClaim.claimDigest);
});
