import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { buildMacosHermesSealedRuntimeCandidatePolicyV1 as build,
  parseMacosHermesSealedRuntimeCandidatePolicyV1 as parse,
  serializeMacosHermesSealedRuntimeCandidatePolicyV1 as serialize } from
  "../src/installer/v1/macos-hermes-sealed-runtime-candidate-policy";
import { parseMacosHermesRuntimeImportPolicyV1 as parseBaseline } from
  "../src/installer/v1/macos-hermes-runtime-import-policy";
import { buildMacosHermesRuntimeImportPolicyV1 as policy } from
  "../src/installer/v1/macos-hermes-runtime-import-policy";
import { prepareMacosHermesCliReleaseSidecarContractV1 as sidecar } from
  "../src/installer/v1/macos-hermes-cli-release-sidecar-contract";
import { buildMacosHermesRuntimeImageManifestV1 as inventory } from
  "../src/installer/v1/macos-hermes-runtime-image-manifest";
import { prepareMacosHermesRestrictedHomePreflightV1 as preflight } from
  "../src/installer/v1/macos-hermes-restricted-home-preflight";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
function fixture() {
  const files = ["python/bin/python3.11", "runtime/hermes/hermes_cli/main.py",
    "runtime/hermes/hermes_cli/_early_recovery.py", "runtime/hermes/hermes_cli/_startup_fast.py",
    "runtime/hermes/cli.py", "runtime/dependencies/openai/_base_client.py"];
  const dirs = new Set(["python/lib/python3.11/lib-dynload"]);
  for (const path of [...files, ...dirs]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries = [
    ...[...dirs].map(path => ({ path, kind: "directory", mode: "0555", sizeBytes: 0,
      sha256: null, linkCount: null })),
    ...files.map(path => ({ path, kind: "regular_file", mode: "0444", sizeBytes: 1,
      sha256: digest("a"), linkCount: 1 })),
  ];
  const manifest = inventory({ architecture: "arm64", entries,
    expectedPaths: entries.map(entry => entry.path), runtimeImageSha256: digest("b") });
  return { executionHomeEntries: [], nativeHostInput: {
    architecture: "arm64", releaseSha256: digest("c"), observedEntries: entries,
    runtimeImageSha256: digest("b"), runtimeManifest: manifest,
    sidecarContract: sidecar({ architecture: "arm64", releaseSha256: digest("c"), releaseVersion: "1.0.0",
      runtimeImageSha256: digest("b"), runtimeManifestSha256: manifest.manifestDigest,
      nativeHostArtifactSha256: digest("d"), nativeHostSourceSha256: digest("e") }),
    importPolicy: policy({ architecture: "arm64", runtimeImageManifestDigest: manifest.manifestDigest,
      dependencyInventoryDigest: digest("a"), nativeLibraryInventoryDigest: digest("d"), licenseInventoryDigest: digest("e") }),
  } };
}
const input = fixture();
const copy = () => JSON.parse(serialize(build(input)));
function rehash(value: ReturnType<typeof copy>) {
  const { policyDigest: _digest, ...body } = value;
  return { ...body, policyDigest: sha256Digest(body) };
}

test("candidate is frozen, deterministic, inventory-bound, and retains baseline incompatibility", () => {
  const candidate = build(input);
  assert.deepEqual(parse(copy()), candidate);
  assert.deepEqual(parseBaseline(candidate.baselinePolicy), candidate.baselinePolicy);
  assert.throws(() => parseBaseline(candidate));
  assert.equal(candidate.baselinePolicy.sourceReview.compatibleWithPolicy, false);
  assert.equal(candidate.readyForLaunch, false);
  for (const [key, value] of Object.entries(candidate))
    if (key.startsWith("grants")) assert.equal(value, false);
  assert.ok(Object.isFrozen(candidate.reviewedExceptions.rootMutations[0]));
  assert.ok(Object.isFrozen(candidate.blockerCodes));
  assert.equal(candidate.nativeHostBindingDigest, preflight(input).nativeHostBindingDigest);
  assert.equal(candidate.restrictedHomePreflightDigest, preflight(input).preflightDigest);
  assert.notEqual(build({ ...input, executionHomeEntries: [
    { path: "logs", kind: "directory", mode: "0700" },
  ] }).policyDigest, candidate.policyDigest);
});

test("candidate requires successful native-host and restricted-home joins", () => {
  assert.throws(() => build({ architecture: "arm64", ...input.nativeHostInput.importPolicy.inventories }));
  const changed = fixture();
  changed.nativeHostInput.runtimeImageSha256 = digest("f");
  assert.throws(() => build(changed));
  assert.throws(() => build({ ...input, executionHomeEntries: [
    { path: "profiles", kind: "directory", mode: "0700" },
  ] }));
});

test("refuses changed exact roots, hook identity, target, semantics and blockers even when rehashed", () => {
  const alterations = [
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.rootMutations[0].target = "/external"; },
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.rootMutations[1].source = "runtime/hermes/other.py"; },
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.rootMutations[1].operation = "append"; },
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.rootMutations.reverse(); },
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.metaPathHook.finder = "OtherFinder"; },
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.metaPathHook.targetModule = "openai"; },
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.metaPathHook.requiredResolvedTarget = "runtime/hermes/openai/_base_client.py"; },
    (v: ReturnType<typeof copy>) => { v.reviewedExceptions.metaPathHook.removesSelfBeforeDelegation = false; },
    (v: ReturnType<typeof copy>) => { v.blockerCodes.pop(); },
    (v: ReturnType<typeof copy>) => { v.grantsLaunchAuthority = true; },
    (v: ReturnType<typeof copy>) => { v.readyForLaunch = true; },
  ];
  for (const alter of alterations) {
    const value = copy();
    alter(value);
    assert.throws(() => parse(rehash(value)));
  }
  const value = copy();
  value.policyDigest = digest("f");
  assert.throws(() => parse(value));
});

test("refuses runtime options and hostile data without invoking getters or proxy traps", () => {
  for (const key of ["roots", "hooks", "env", "profile", "args", "readyForLaunch"])
    assert.throws(() => build({ ...input, [key]: true }));
  let calls = 0;
  const value = copy();
  Object.defineProperty(value.reviewedExceptions.metaPathHook, "finder", {
    enumerable: true, get() { calls += 1; return "_AsyncHttpxDelNeuter"; },
  });
  assert.throws(() => parse(value));
  const proxied = copy();
  proxied.reviewedExceptions.rootMutations = new Proxy(proxied.reviewedExceptions.rootMutations, {
    get() { calls += 1; return undefined; },
  });
  assert.throws(() => parse(proxied));
  assert.throws(() => parse(new Proxy(copy(), { get() { calls += 1; return undefined; } })));
  const hidden = copy();
  Object.defineProperty(hidden.reviewedExceptions, "extra", { value: true });
  assert.throws(() => parse(hidden));
  const symbol = copy();
  symbol.reviewedExceptions[Symbol("extra")] = true;
  assert.throws(() => parse(symbol));
  assert.equal(calls, 0);
});
