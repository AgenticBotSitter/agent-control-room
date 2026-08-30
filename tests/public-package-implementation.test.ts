import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPublicPackageTreeDefinitionsV1, parsePublicPackageTreeDefinitionV1 } from "../src/public-package/v1";
import { runObservationConformanceKitV1 } from "../packages/control-room-conformance-kit/src/index";
import { syntheticReferenceConformanceCasesV1 } from "../packages/reference-adapters/src/index";
import { OBSERVATION_ADAPTER_SDK_VERSION_V1, defineObservationAdapterV1 } from "../packages/control-room-adapter-sdk/src/index";
import { PUBLIC_OBSERVATION_CONTRACT_V1, PUBLIC_OBSERVATION_EVENT_V1 } from "../packages/control-room-core/src/index";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? sourceFiles(path) : [path];
});

test("CR10B-PUB-010/020/030/040 freezes four exact local candidate package trees", () => {
  const definitions = buildPublicPackageTreeDefinitionsV1();
  assert.deepEqual(definitions.map((item) => item.root), [
    "packages/control-room-core/", "packages/control-room-adapter-sdk/", "packages/control-room-conformance-kit/", "packages/reference-adapters/",
  ]);
  for (const definition of definitions) assert.deepEqual(parsePublicPackageTreeDefinitionV1(definition), definition);
});

test("CR10B-PUB-010/020/030/040 package manifests are local candidates with narrow exports", () => {
  for (const definition of buildPublicPackageTreeDefinitionsV1()) {
    const manifest = JSON.parse(readFileSync(join(root, definition.root, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.name, definition.packageName);
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.exports, { ".": "./src/index.ts" });
    assert.equal("scripts" in manifest || "publishConfig" in manifest || "bin" in manifest, false);
    assert.deepEqual(Object.keys((manifest.dependencies ?? {}) as Record<string, unknown>).sort(), [...definition.allowedPackageDependencies].sort());
  }
});

test("CR10B-PUB-010/020/030/040 public packages cannot reach private runtime or effect clients", () => {
  const forbidden = ["../../src/", "../../../src/", "@/", "node:fs", "node:child_process", "node:http", "node:https", "node:net", "node:tls", "fetch(", "process.env", "spawn(", "exec(", "publish", "registry.npmjs.org"];
  for (const definition of buildPublicPackageTreeDefinitionsV1()) {
    for (const path of sourceFiles(join(root, definition.root, "src"))) {
      const source = readFileSync(path, "utf8");
      for (const value of forbidden) assert.equal(source.includes(value), false, `${path} includes ${value}`);
    }
  }
});

test("CR10B-PUB-010 public core accepts observation contracts and rejects sensitive-shaped data", async () => {
  const { observationAdapterManifestSchemaV1, assertNoSensitiveValuesV1 } = await import("../packages/control-room-core/src/index");
  const manifest = observationAdapterManifestSchemaV1.parse({
    schemaVersion: PUBLIC_OBSERVATION_CONTRACT_V1, adapterId: "adapter.test.observation.v1", adapterVersion: "0.1.0", harness: "other", harnessVersion: "0.0.0-synthetic", harnessRevision: "0000000000000000000000000000000000000000",
    runtime: { name: "synthetic", minimumVersion: "0.1.0", supportedPlatforms: ["linux"] }, observationKinds: ["stream"], eventSchemaVersion: PUBLIC_OBSERVATION_EVENT_V1,
    effectAuthority: "none", accessMode: "none", outputForms: ["structured_events"], license: "Apache-2.0", distribution: "redistributable",
  });
  assert.equal(manifest.effectAuthority, "none");
  assert.throws(() => assertNoSensitiveValuesV1({ privateKey: "value" }, "test"));
});

test("CR10B-PUB-020 rejects adapter shapes that add an uncontracted operation method", () => {
  assert.throws(() => defineObservationAdapterV1({
    sdkVersion: OBSERVATION_ADAPTER_SDK_VERSION_V1,
    manifest: {
      schemaVersion: PUBLIC_OBSERVATION_CONTRACT_V1, adapterId: "adapter.invalid.v1", adapterVersion: "0.1.0", harness: "other", harnessVersion: "0.1.0", harnessRevision: "0000000000000000000000000000000000000000",
      runtime: { name: "synthetic", minimumVersion: "0.1.0", supportedPlatforms: ["linux"] }, observationKinds: ["stream"], eventSchemaVersion: PUBLIC_OBSERVATION_EVENT_V1,
      effectAuthority: "none", accessMode: "none", outputForms: ["structured_events"], license: "Apache-2.0", distribution: "redistributable",
    }, evaluateCompatibility: () => ({ compatible: true, reasons: [] }), normalizeObservation: () => ({ events: [] }), performOperation: () => undefined,
  } as never));
});

test("CR10B-PUB-030/040 conformance accepts the three synthetic reference adapters", () => {
  const report = runObservationConformanceKitV1(syntheticReferenceConformanceCasesV1);
  assert.equal(report.passed, true);
  assert.deepEqual(report.results.map((item) => [item.adapterId, item.normalizedEventCount]), [
    ["adapter.reference.hermes.synthetic.v1", 2], ["adapter.reference.codex.synthetic.v1", 2], ["adapter.reference.example.synthetic.v1", 1],
  ]);
});
