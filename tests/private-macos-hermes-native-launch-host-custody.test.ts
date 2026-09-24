import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivateMacosHermesNativeLaunchHostCustodyV1 as create,
  consumePrivateMacosHermesNativeLaunchHostFixtureFrameCapabilityV1 as consume,
  PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_CUSTODY_V1 as schema,
  PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_FRAME_REQUEST_V1 as requestSchema } from
  "../src/installer/v1/private-macos-hermes-native-launch-host-custody";
import { prepareMacosHermesNativeHostInputContractV1 as prepare } from
  "../src/installer/v1/macos-hermes-native-host-input-contract";
import { prepareMacosHermesCliReleaseSidecarContractV1 as sidecar } from
  "../src/installer/v1/macos-hermes-cli-release-sidecar-contract";
import { buildMacosHermesRuntimeImageManifestV1 as inventory } from
  "../src/installer/v1/macos-hermes-runtime-image-manifest";
import { buildMacosHermesRuntimeImportPolicyV1 as policy } from
  "../src/installer/v1/macos-hermes-runtime-import-policy";

const d = (value: string) => `sha256:${value.repeat(64)}`;
const entries = [{ path: "LICENSE", kind: "regular_file" as const, mode: "0444" as const, sizeBytes: 1, sha256: d("b"), linkCount: 1 as const }];
function verified() {
  const manifest = inventory({ architecture: "arm64", entries, expectedPaths: ["LICENSE"], runtimeImageSha256: d("c") });
  return prepare({ architecture: "arm64", releaseSha256: d("a"), runtimeImageSha256: d("c"), observedEntries: entries,
    runtimeManifest: manifest, importPolicy: policy({ architecture: "arm64", runtimeImageManifestDigest: manifest.manifestDigest,
      dependencyInventoryDigest: d("d"), nativeLibraryInventoryDigest: d("e"), licenseInventoryDigest: d("f") }),
    sidecarContract: sidecar({ architecture: "arm64", releaseVersion: "0.1.0", releaseSha256: d("a"), runtimeImageSha256: d("c"),
      runtimeManifestSha256: manifest.manifestDigest, nativeHostArtifactSha256: d("1"), nativeHostSourceSha256: d("2") }) });
}

function rebound(value: Record<string, unknown>) {
  const { bindingDigest: _ignored, ...material } = value;
  return { ...value, bindingDigest: sha256Digest(material) };
}

test("binds only the verified immutable image contract into one bounded inert fixture frame", () => {
  const custody = create({ schema, verifiedImmutableInput: verified() });
  assert.equal(custody.launchesHermes, false); assert.equal(custody.grantsLaunchAuthority, false);
  for (const field of ["acceptsCallerPath", "acceptsPathEnvironment", "acceptsRuntimeRoot", "acceptsProfile",
    "acceptsModel", "acceptsProvider", "acceptsWorkingDirectory"] as const) assert.equal(custody[field], false);
  const frame = consume(custody.fixtureFrameCapability, { schema: requestSchema });
  assert.equal(frame.bytes.toString("ascii", 0, 8), "ACRHNL1\n");
  assert.equal(frame.byteLength, custody.maximumFrameBytes); assert.equal(frame.launchesHermes, false);
  assert.throws(() => consume(custody.fixtureFrameCapability, { schema: requestSchema }), /refused/);
});

test("refuses mutable launch substitution and burns a capability after an attempted frame request", () => {
  for (const name of ["path", "PATH", "runtimeRoot", "profile", "model", "provider", "workdir"]) {
    assert.throws(() => create({ schema, verifiedImmutableInput: verified(), [name]: "/private/fixture" }), /refused/, name);
  }
  const custody = create({ schema, verifiedImmutableInput: verified() });
  assert.throws(() => consume(custody.fixtureFrameCapability, { schema: requestSchema, PATH: "/bin" }), /refused/);
  assert.throws(() => consume(custody.fixtureFrameCapability, { schema: requestSchema }), /refused/);
});

test("refuses a forged, proxied, getter-backed, or changed verified record before minting custody", () => {
  const changed = { ...verified(), runtimeImageSha256: d("9") };
  assert.throws(() => create({ schema, verifiedImmutableInput: changed }), /refused/);
  const getter = Object.defineProperty({ schema, verifiedImmutableInput: verified() }, "verifiedImmutableInput", {
    enumerable: true, get() { throw new Error("must not read"); },
  });
  assert.throws(() => create(getter), /refused/);
  assert.throws(() => create(new Proxy({ schema, verifiedImmutableInput: verified() }, {})), /refused/);
});

test("refuses hostile nested values without invoking methods, getters, or proxy traps", () => {
  let calls = 0;
  const methodArray = [...verified().blockerCodes] as string[];
  Object.defineProperty(methodArray, "every", { enumerable: false, value() { calls += 1; return true; } });
  assert.throws(() => create({ schema, verifiedImmutableInput: rebound({ ...verified(), blockerCodes: methodArray }) }), /refused/);

  const indexedGetter = [...verified().blockerCodes] as string[];
  Object.defineProperty(indexedGetter, "0", { enumerable: true, get() { calls += 1; return "native_runtime_image_not_verified"; } });
  assert.throws(() => create({ schema, verifiedImmutableInput: { ...verified(), blockerCodes: indexedGetter } }), /refused/);

  const digestGetter = { ...verified() } as Record<string, unknown>;
  Object.defineProperty(digestGetter, "releaseSha256", { enumerable: true, get() { calls += 1; return d("a"); } });
  assert.throws(() => create({ schema, verifiedImmutableInput: digestGetter }), /refused/);

  const proxy = new Proxy([...verified().blockerCodes], { getOwnPropertyDescriptor() { calls += 1; return undefined; } });
  assert.throws(() => create({ schema, verifiedImmutableInput: { ...verified(), blockerCodes: proxy } }), /refused/);

  class Subclass extends Array<string> {}
  assert.throws(() => create({ schema, verifiedImmutableInput: { ...verified(), blockerCodes: new Subclass(...verified().blockerCodes) } }), /refused/);
  assert.equal(calls, 0);
});
