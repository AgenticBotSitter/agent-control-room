import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MACOS_HERMES_RUNTIME_IMAGE_MANIFEST_V1,
  buildMacosHermesRuntimeImageManifestV1,
  parseMacosHermesRuntimeImageManifestV1,
  serializeMacosHermesRuntimeImageManifestV1,
  verifyMacosHermesRuntimeImageManifestV1,
} from "../src/installer/v1/macos-hermes-runtime-image-manifest";

const d = (character: string) => `sha256:${character.repeat(64)}`;
const entries = Object.freeze([
  Object.freeze({ path: "bin", kind: "directory", mode: "0555", sizeBytes: 0, sha256: null, linkCount: null }),
  Object.freeze({ path: "bin/hermes", kind: "regular_file", mode: "0555", sizeBytes: 17, sha256: d("a"), linkCount: 1 }),
  Object.freeze({ path: "lib", kind: "directory", mode: "0555", sizeBytes: 0, sha256: null, linkCount: null }),
  Object.freeze({ path: "lib/runtime.py", kind: "regular_file", mode: "0444", sizeBytes: 23, sha256: d("b"), linkCount: 1 }),
  Object.freeze({ path: "LICENSE", kind: "regular_file", mode: "0444", sizeBytes: 11, sha256: d("c"), linkCount: 1 }),
]);
const expectedPaths = Object.freeze(entries.map(entry => entry.path));
const input = Object.freeze({ architecture: "arm64", entries, expectedPaths, runtimeImageSha256: d("d") });
const refusal = /^Error: macos_hermes_runtime_image_manifest_refused$/u;

test("builds one deterministic, redacted and deliberately non-authorizing runtime inventory", () => {
  const manifest = buildMacosHermesRuntimeImageManifestV1(input);
  assert.equal(manifest.schema, MACOS_HERMES_RUNTIME_IMAGE_MANIFEST_V1);
  assert.equal(manifest.hermesVersion, "0.21.3");
  assert.equal(manifest.hermesSourceRevision, "00570550f37e9082676955d50f65c7d9ba846cc9");
  assert.deepEqual(manifest.entries.map(entry => entry.path), ["LICENSE", "bin", "bin/hermes", "lib", "lib/runtime.py"]);
  assert.equal(manifest.entryCount, 5);
  assert.equal(manifest.totalFileBytes, 51);
  assert.deepEqual(manifest.privacy, {
    storesAbsolutePaths: false,
    storesOwnerIdentity: false,
    storesTimestamps: false,
    inspectsFileContents: false,
    credentialAbsenceVerified: false,
    requiredNextStep: "owner_authorized_public_runtime_capture",
  });
  assert.equal(manifest.status, "inventory_only");
  assert.equal(manifest.grantsPackagingAuthority, false);
  assert.equal(manifest.grantsLaunchAuthority, false);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.entries), true);
  assert.equal(Object.isFrozen(manifest.entries[0]), true);
  assert.equal(Object.isFrozen(manifest.privacy), true);
  assert.deepEqual(parseMacosHermesRuntimeImageManifestV1(JSON.parse(
    serializeMacosHermesRuntimeImageManifestV1(manifest))), manifest);

  const reversed = buildMacosHermesRuntimeImageManifestV1({ ...input, entries: [...entries].reverse() });
  assert.equal(serializeMacosHermesRuntimeImageManifestV1(reversed), serializeMacosHermesRuntimeImageManifestV1(manifest));
});

test("verifies an exact later image observation but returns no launch capability", () => {
  const manifest = buildMacosHermesRuntimeImageManifestV1(input);
  const verified = verifyMacosHermesRuntimeImageManifestV1({
    manifest,
    observedEntries: [...entries].reverse(),
    runtimeImageSha256: d("d"),
  });
  assert.deepEqual(verified, manifest);
  assert.equal(verified.grantsLaunchAuthority, false);

  const changed = entries.map(entry => entry.path === "lib/runtime.py" ? { ...entry, sha256: d("e") } : entry);
  assert.throws(() => verifyMacosHermesRuntimeImageManifestV1({ manifest, observedEntries: changed,
    runtimeImageSha256: d("d") }), refusal);
  assert.throws(() => verifyMacosHermesRuntimeImageManifestV1({ manifest, observedEntries: entries,
    runtimeImageSha256: d("e") }), refusal);
});

test("refuses links, special files, unsafe modes and malformed entry metadata", () => {
  const base = entries.find(entry => entry.path === "bin/hermes")!;
  for (const replacement of [
    { ...base, kind: "symlink" },
    { ...base, kind: "fifo" },
    { ...base, kind: "socket" },
    { ...base, mode: "0755" },
    { ...base, mode: "4755" },
    { ...base, linkCount: 2 },
    { ...base, sha256: null },
    { ...base, sizeBytes: -1 },
    { ...base, owner: "private-owner" },
  ]) {
    const changed = entries.map(entry => entry.path === base.path ? replacement : entry);
    assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input, entries: changed }), refusal);
  }
  const directory = entries.find(entry => entry.path === "bin")!;
  for (const replacement of [
    { ...directory, mode: "0444" },
    { ...directory, sizeBytes: 1 },
    { ...directory, sha256: d("f") },
    { ...directory, linkCount: 1 },
  ]) {
    const changed = entries.map(entry => entry.path === directory.path ? replacement : entry);
    assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input, entries: changed }), refusal);
  }
});

test("refuses unsafe names, missing parents, duplicates, omissions and extra entries", () => {
  const file = entries.find(entry => entry.path === "lib/runtime.py")!;
  for (const path of ["/private/runtime.py", "../runtime.py", "lib//runtime.py", "lib/./runtime.py",
    "lib\\runtime.py", "lib\0runtime.py"]) {
    const changed = entries.map(entry => entry.path === file.path ? { ...entry, path } : entry);
    assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input, entries: changed,
      expectedPaths: expectedPaths.map(expected => expected === file.path ? path : expected) }), refusal);
  }

  assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input,
    entries: entries.filter(entry => entry.path !== "lib") }), refusal);
  assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input,
    entries: [...entries, entries[0]], expectedPaths: [...expectedPaths, entries[0].path] }), refusal);
  assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input,
    entries: entries.slice(1) }), refusal);
  assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input,
    entries: [...entries, { path: "extra", kind: "regular_file", mode: "0444", sizeBytes: 1,
      sha256: d("f"), linkCount: 1 }] }), refusal);
});

test("refuses proxies, accessors, forged status and any saved-manifest mutation", () => {
  assert.throws(() => buildMacosHermesRuntimeImageManifestV1(new Proxy(input, {})), refusal);
  assert.throws(() => buildMacosHermesRuntimeImageManifestV1({ ...input, entries: new Proxy([...entries], {}) }), refusal);
  const getter = { ...input } as Record<string, unknown>;
  Object.defineProperty(getter, "runtimeImageSha256", { enumerable: true, get() { throw new Error("read"); } });
  assert.throws(() => buildMacosHermesRuntimeImageManifestV1(getter), refusal);

  const manifest = buildMacosHermesRuntimeImageManifestV1(input);
  for (const changed of [
    { ...manifest, status: "ready" },
    { ...manifest, grantsPackagingAuthority: true },
    { ...manifest, grantsLaunchAuthority: true },
    { ...manifest, entryCount: 4 },
    { ...manifest, totalFileBytes: 50 },
    { ...manifest, runtimeImageSha256: d("e") },
    { ...manifest, entries: manifest.entries.slice(1) },
    { ...manifest, privacy: { ...manifest.privacy, credentialAbsenceVerified: true } },
    { ...manifest, privatePath: "/private/owner" },
  ]) assert.throws(() => parseMacosHermesRuntimeImageManifestV1(changed), refusal);
});
