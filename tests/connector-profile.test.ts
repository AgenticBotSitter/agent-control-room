import assert from "node:assert/strict";
import test from "node:test";
import { connectorOperationAdmissibleV1, connectorOperationNamesV1, parseConnectorProfileV1 } from "../src/harness/v1/connector-profile";

const operation = (status: "supported" | "unsupported" | "unknown", evidence: "source_inspected" | "fixture_tested" | "actual_interface_tested" | "native_qualified", reasonCode: string) =>
  ({ status, evidence, reasonCode });

function profile() {
  return {
    schema: "control-room.connector-profile/v1",
    connectorId: "connector.hermes-gpt.fastmcp.v1",
    connectorVersion: "1.0.0",
    harness: "hermes",
    harnessVersion: "0.10.0",
    sourceRevision: "89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73",
    transport: "fastmcp_tools",
    isolation: "harness_owned",
    credentialResolution: "harness_native",
    distribution: "invocation_only",
    operations: Object.fromEntries(connectorOperationNamesV1.map(name => [name,
      name === "submit" ? operation("supported", "source_inspected", "upstream_tool_present")
        : operation("unsupported", "source_inspected", `upstream_${name}_not_available`)])),
    resultContract: { forms: ["utf8_text"], maximumBytes: 65_536, additionalAttachments: false },
  };
}

function packageProfile() {
  const value = profile();
  const { sourceRevision: _sourceRevision, ...withoutRevision } = value;
  return {
    ...withoutRevision,
    connectorId: "connector.claude-code.jsonl.v1",
    harness: "claude" as const,
    harnessVersion: "2.1.270",
    sourcePackage: {
      ecosystem: "npm" as const,
      name: "@anthropic-ai/claude-code",
      version: "2.1.270",
      integrity: `sha512-${"A".repeat(86)}==`,
    },
    transport: "jsonl_stdio" as const,
  };
}

test("source evidence describes a connector but cannot enable execution", () => {
  const value = profile();
  const parsed = parseConnectorProfileV1(value);
  assert.equal(parsed.operations.submit.status, "supported");
  assert.equal(connectorOperationAdmissibleV1(parsed, "submit"), false);
  parsed.operations.submit.evidence = "actual_interface_tested";
  assert.equal(connectorOperationAdmissibleV1(parsed, "submit"), true);
});

test("connector profiles are exact, bounded and contain every explicit operation", () => {
  assert.throws(() => parseConnectorProfileV1({ ...profile(), endpoint: "https://private.example" }));
  const missing = profile();
  delete (missing.operations as Record<string, unknown>).cancel;
  assert.throws(() => parseConnectorProfileV1(missing));
  const binary = profile();
  binary.resultContract = { forms: ["binary"] as never[], maximumBytes: 65_536, additionalAttachments: false };
  assert.throws(() => parseConnectorProfileV1(binary));
});

test("Git and exact npm package identities are supported without widening profiles", () => {
  assert.equal(parseConnectorProfileV1(profile()).sourceRevision,
    "89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73");
  const parsed = parseConnectorProfileV1(packageProfile());
  assert.deepEqual(parsed.sourcePackage, packageProfile().sourcePackage);
  assert.equal(parsed.transport, "jsonl_stdio");

  const neither = packageProfile();
  delete (neither as { sourcePackage?: unknown }).sourcePackage;
  assert.throws(() => parseConnectorProfileV1(neither));
  assert.throws(() => parseConnectorProfileV1({
    ...packageProfile(),
    sourceRevision: "89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73",
  }));

  const mismatch = packageProfile();
  mismatch.sourcePackage.version = "2.1.269";
  assert.throws(() => parseConnectorProfileV1(mismatch));
});

test("package identity rejects paths, URLs, whitespace and non-canonical integrity", () => {
  for (const name of ["../claude", "https://registry.example/claude", "claude code", "@scope", "@Scope/claude"]) {
    const value = packageProfile();
    value.sourcePackage.name = name;
    assert.throws(() => parseConnectorProfileV1(value), name);
  }
  for (const integrity of [
    `sha256-${"A".repeat(86)}==`,
    `sha512-${"A".repeat(85)}==`,
    `sha512-${"A".repeat(85)}B==`,
    `sha512-${"A".repeat(86)}== sha512-${"B".repeat(86)}==`,
  ]) {
    const value = packageProfile();
    value.sourcePackage.integrity = integrity;
    assert.throws(() => parseConnectorProfileV1(value), integrity);
  }
});

test("package identity requires one exact complete semantic version", () => {
  for (const version of ["latest", "next", "2", "2.1", "^2.1.270", ">=2.1.270", "02.1.270"]) {
    const value = packageProfile();
    value.sourcePackage.version = version;
    value.harnessVersion = version;
    assert.throws(() => parseConnectorProfileV1(value), version);
  }
  for (const version of ["0.0.0", "2.1.270-beta.1", "2.1.270+build.5"]) {
    const value = packageProfile();
    value.sourcePackage.version = version;
    value.harnessVersion = version;
    assert.equal(parseConnectorProfileV1(value).sourcePackage?.version, version);
  }
});

test("package identity is inert and operation admission remains fail closed", () => {
  const evidenceLevels = ["source_inspected", "fixture_tested", "actual_interface_tested", "native_qualified"] as const;
  for (const operationName of connectorOperationNamesV1) {
    for (const evidence of evidenceLevels) {
      const value = packageProfile();
      value.operations[operationName] = operation("supported", evidence, `claude_${operationName}_evidence`);
      assert.equal(
        connectorOperationAdmissibleV1(value, operationName),
        evidence === "actual_interface_tested" || evidence === "native_qualified",
        `${operationName}/${evidence}`,
      );
      value.operations[operationName] = operation("unknown", evidence, `claude_${operationName}_unknown`);
      assert.equal(connectorOperationAdmissibleV1(value, operationName), false);
      value.operations[operationName] = operation("unsupported", evidence, `claude_${operationName}_unsupported`);
      assert.equal(connectorOperationAdmissibleV1(value, operationName), false);
    }
  }
});

test("parsed package identity is detached from caller mutation", () => {
  const value = packageProfile();
  const parsed = parseConnectorProfileV1(value);
  value.sourcePackage.name = "changed-after-parse";
  assert.equal(parsed.sourcePackage?.name, "@anthropic-ai/claude-code");
});

test("observation profiles cannot grant execution and submit needs credential isolation", () => {
  const observed = profile();
  observed.transport = "observation_only";
  assert.throws(() => parseConnectorProfileV1(observed));
  const noCredentials = profile();
  noCredentials.credentialResolution = "unsupported";
  assert.throws(() => parseConnectorProfileV1(noCredentials));
});
