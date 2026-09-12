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

test("observation profiles cannot grant execution and submit needs credential isolation", () => {
  const observed = profile();
  observed.transport = "observation_only";
  assert.throws(() => parseConnectorProfileV1(observed));
  const noCredentials = profile();
  noCredentials.credentialResolution = "unsupported";
  assert.throws(() => parseConnectorProfileV1(noCredentials));
});
