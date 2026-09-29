import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMacosHermesNativeHostInputContractV1 as prepare } from
  "../src/installer/v1/macos-hermes-native-host-input-contract";
import { prepareMacosHermesCliReleaseSidecarContractV1 as sidecar } from
  "../src/installer/v1/macos-hermes-cli-release-sidecar-contract";
import { buildMacosHermesRuntimeImageManifestV1 as inventory } from
  "../src/installer/v1/macos-hermes-runtime-image-manifest";
import { buildMacosHermesRuntimeImportPolicyV1 as policy } from
  "../src/installer/v1/macos-hermes-runtime-import-policy";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const entries = [{ path: "LICENSE", kind: "regular_file", mode: "0444", sizeBytes: 4,
  sha256: d("a"), linkCount: 1 }];
function fixture(architecture = "arm64") {
  const manifest = inventory({ architecture, entries, expectedPaths: ["LICENSE"], runtimeImageSha256: d("b") });
  return {
    architecture, releaseSha256: d("c"), observedEntries: entries, runtimeImageSha256: d("b"),
    runtimeManifest: manifest,
    sidecarContract: sidecar({ architecture, releaseSha256: d("c"), releaseVersion: "1.0.0",
      runtimeImageSha256: d("b"), runtimeManifestSha256: manifest.manifestDigest,
      nativeHostArtifactSha256: d("d"), nativeHostSourceSha256: d("e") }),
    importPolicy: policy({ architecture, runtimeImageManifestDigest: manifest.manifestDigest,
      dependencyInventoryDigest: d("a"), nativeLibraryInventoryDigest: d("d"), licenseInventoryDigest: d("e") }),
  };
}

test("matching inputs bind deterministically to the fixed protocol but never become execution authority", () => {
  for (const architecture of ["arm64", "x64"]) {
    const input = fixture(architecture);
    const result = prepare(input);
    assert.deepEqual(prepare(JSON.parse(JSON.stringify(input))), result);
    assert.equal(result.protocol, "ACRHCP1");
    assert.equal(result.readyForLaunch, false);
    assert.equal(result.filesystemCustodyVerified, false);
    assert.equal(result.grantsLaunchAuthority, false);
    assert.equal(result.grantsPackagingAuthority, false);
    assert.ok(result.blockerCodes.includes("runtime_import_policy_incompatible"));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.blockerCodes));
  }
});

test("refuses architecture, release, image, policy and inventory substitutions", () => {
  const input = fixture();
  for (const change of [
    { architecture: "x64" }, { releaseSha256: d("f") }, { runtimeImageSha256: d("f") },
    { sidecarContract: fixture("x64").sidecarContract },
    { runtimeManifest: fixture("x64").runtimeManifest },
    { importPolicy: fixture("x64").importPolicy },
    { importPolicy: policy({ architecture: "arm64", runtimeImageManifestDigest: d("f"),
      dependencyInventoryDigest: d("a"), nativeLibraryInventoryDigest: d("d"), licenseInventoryDigest: d("e") }) },
    { observedEntries: [{ ...entries[0], sha256: d("f") }] },
    { observedEntries: [{ ...entries[0], mode: "0644" }] },
  ]) assert.throws(() => prepare({ ...input, ...change }));
});

test("refuses caller paths, runtime options, getters and proxies without evaluating them", () => {
  for (const key of ["executable", "runtimePath", "profile", "model", "workdir", "args", "env"]) {
    assert.throws(() => prepare({ ...fixture(), [key]: "/private/fixture" }));
  }
  let calls = 0;
  const getter = Object.defineProperty(fixture(), "architecture", { enumerable: true,
    get() { calls += 1; return "arm64"; } });
  assert.throws(() => prepare(getter));
  assert.throws(() => prepare(new Proxy(fixture(), { get() { calls += 1; return undefined; } })));
  assert.equal(calls, 0);
});
