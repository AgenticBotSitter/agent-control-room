import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareMacosHermesRestrictedHomePreflightV1 as prepare } from
  "../src/installer/v1/macos-hermes-restricted-home-preflight";
import { prepareMacosHermesCliReleaseSidecarContractV1 as sidecar } from
  "../src/installer/v1/macos-hermes-cli-release-sidecar-contract";
import { buildMacosHermesRuntimeImageManifestV1 as inventory } from
  "../src/installer/v1/macos-hermes-runtime-image-manifest";
import { buildMacosHermesRuntimeImportPolicyV1 as policy } from
  "../src/installer/v1/macos-hermes-runtime-import-policy";

const d = (c: string) => `sha256:${c.repeat(64)}`;
function fixture(extraFiles: string[] = []) {
  const files = ["python/bin/python3.11", "runtime/hermes/hermes_cli/main.py",
    "runtime/hermes/hermes_cli/_early_recovery.py", "runtime/hermes/cli.py",
    "runtime/dependencies/openai/_base_client.py", ...extraFiles];
  const dirs = new Set(["python/lib/python3.11/lib-dynload"]);
  for (const path of [...files, ...dirs]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries = [
    ...[...dirs].map(path => ({ path, kind: "directory", mode: "0555", sizeBytes: 0,
      sha256: null, linkCount: null })),
    ...files.map(path => ({ path, kind: "regular_file", mode: "0444", sizeBytes: 1,
      sha256: d("a"), linkCount: 1 })),
  ];
  const manifest = inventory({ architecture: "arm64", entries,
    expectedPaths: entries.map(entry => entry.path), runtimeImageSha256: d("b") });
  return { executionHomeEntries: [], nativeHostInput: {
    architecture: "arm64", releaseSha256: d("c"), observedEntries: entries,
    runtimeImageSha256: d("b"), runtimeManifest: manifest,
    sidecarContract: sidecar({ architecture: "arm64", releaseSha256: d("c"), releaseVersion: "1.0.0",
      runtimeImageSha256: d("b"), runtimeManifestSha256: manifest.manifestDigest,
      nativeHostArtifactSha256: d("d"), nativeHostSourceSha256: d("e") }),
    importPolicy: policy({ architecture: "arm64", runtimeImageManifestDigest: manifest.manifestDigest,
      dependencyInventoryDigest: d("a"), nativeLibraryInventoryDigest: d("d"), licenseInventoryDigest: d("e") }),
  } };
}

test("recognizes image-internal reviewed behavior while retaining all live blockers", () => {
  const result = prepare(fixture());
  assert.equal(result.bootstrapRootClassification, "exact_image_internal_parent");
  assert.equal(result.readyForLaunch, false);
  assert.equal(result.grantsLaunchAuthority, false);
  assert.equal(result.grantsPackagingAuthority, false);
  assert.equal(result.filesystemCustodyVerified, false);
  assert.ok(result.blockerCodes.includes("entry_point_plugin_closure_unproven"));
  assert.deepEqual(prepare(JSON.parse(JSON.stringify(fixture()))), result);
});

test("rejects execution-home code, profiles, credentials, symlinks and arbitrary paths", () => {
  for (const path of ["plugins", "providers", "profiles", "config.yaml", ".env", "auth.json",
    "memories", "skills", "../escape", "/external", ".update-incomplete"])
    assert.throws(() => prepare({ ...fixture(), executionHomeEntries: [{ path, kind: "directory", mode: "0700" }] }));
  for (const kind of ["symlink", "regular_file"])
    assert.throws(() => prepare({ ...fixture(), executionHomeEntries: [{ path: "logs", kind, mode: "0700" }] }));
  prepare({ ...fixture(), executionHomeEntries: [{ path: "logs", kind: "directory", mode: "0700" }] });
});

test("rejects recovery triggers and executable site-loading hooks inside an otherwise matching inventory", () => {
  for (const file of ["runtime/hermes/.update-incomplete", "runtime/hermes/.lazy-refresh-incomplete",
    "runtime/dependencies/escape.pth", "runtime/dependencies/link.egg-link",
    "runtime/dependencies/sitecustomize.py", "runtime/hermes/.env"])
    assert.throws(() => prepare(fixture([file])));
});

test("refuses runtime options, missing closure files and untrusted property evaluation", () => {
  for (const name of ["env", "args", "profile", "externalRoots", "readyForLaunch"])
    assert.throws(() => prepare({ ...fixture(), [name]: true }));
  const input = fixture();
  input.nativeHostInput.observedEntries.pop();
  assert.throws(() => prepare(input));
  let calls = 0;
  const accessor = Object.defineProperty(fixture(), "executionHomeEntries", { enumerable: true,
    get() { calls += 1; return []; } });
  assert.throws(() => prepare(accessor));
  assert.throws(() => prepare(new Proxy(fixture(), { get() { calls += 1; return []; } })));
  assert.equal(calls, 0);
});
