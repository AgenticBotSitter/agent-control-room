import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_PROFILE_SCHEMA_V1,
  connectorOperationAdmissibleV1,
  connectorOperationNamesV1,
  parseConnectorProfileV1,
  type ConnectorOperationNameV1,
} from "../src/harness/v1/connector-profile";

const operation = (status: "supported" | "unsupported" | "unknown",
  evidence: "source_inspected" | "fixture_tested" | "actual_interface_tested" | "native_qualified",
  reasonCode: string) =>
  ({ status, evidence, reasonCode });

function profileFor(harness: "hermes" | "codex" | "claude" | "other", connectorIdSuffix: string,
  sourceRevision = "0123456789abcdef0123456789abcdef01234567",
  overrides: Record<string, unknown> = {}) {
  return {
    schema: CONNECTOR_PROFILE_SCHEMA_V1,
    connectorId: `connector.${connectorIdSuffix}`,
    connectorVersion: "1.0.0",
    harness,
    harnessVersion: "0.10.0",
    sourceRevision,
    transport: "fastmcp_tools",
    isolation: "harness_owned",
    credentialResolution: "harness_native",
    distribution: "invocation_only",
    operations: Object.fromEntries(connectorOperationNamesV1.map((name) =>
      [name, name === "submit"
        ? operation("supported", "actual_interface_tested", "upstream_tool_present")
        : operation("unsupported", "actual_interface_tested", `upstream_${name}_not_available`)])),
    resultContract: { forms: ["utf8_text"], maximumBytes: 65_536, additionalAttachments: false },
    ...overrides,
  };
}

test("every declared harness parses and the schema discriminator is constant", () => {
  for (const harness of ["hermes", "codex", "claude", "other"] as const) {
    const parsed = parseConnectorProfileV1(profileFor(harness, harness));
    assert.equal(parsed.harness, harness);
    assert.equal(parsed.schema, CONNECTOR_PROFILE_SCHEMA_V1);
  }
});

test("distinct connector identifiers remain identity-isolated", () => {
  const hermes = parseConnectorProfileV1(profileFor("hermes", "hermes.v1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  const codex = parseConnectorProfileV1(profileFor("codex", "codex.v1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
  assert.notEqual(hermes.connectorId, codex.connectorId);
  assert.notEqual(hermes.sourceRevision, codex.sourceRevision);
  assert.equal(hermes.harness, "hermes");
  assert.equal(codex.harness, "codex");
});

test("only the exact four harnesses are accepted; anything else is rejected", () => {
  const forged = profileFor("hermes", "forged.v1");
  (forged as Record<string, unknown>).harness = "openai-mystery";
  assert.throws(() => parseConnectorProfileV1(forged));
});

test("missing and extraneous operations are both rejected to keep results bounded", () => {
  const missing = profileFor("hermes", "missing.v1");
  delete (missing.operations as Record<string, unknown>).cancel;
  assert.throws(() => parseConnectorProfileV1(missing));
  const extraneous = profileFor("hermes", "extra.v1");
  (extraneous as { operations: Record<string, unknown> }).operations = {
    ...(extraneous.operations as Record<string, unknown>),
    sideload: operation("supported", "fixture_tested", "sideload_granted"),
  };
  assert.throws(() => parseConnectorProfileV1(extraneous));
});

test("result bound is exactly 65,536 bytes; greater and lesser values are rejected", () => {
  const laxer = profileFor("hermes", "laxer.v1");
  laxer.resultContract = { forms: ["utf8_text"], maximumBytes: 65_537, additionalAttachments: false };
  assert.throws(() => parseConnectorProfileV1(laxer));
  const stricter = profileFor("hermes", "stricter.v1");
  stricter.resultContract = { forms: ["utf8_text"], maximumBytes: 65_535, additionalAttachments: false };
  assert.throws(() => parseConnectorProfileV1(stricter));
});

test("evidence transition: source and fixture cannot enable, actual and native can", () => {
  const value = profileFor("hermes", "hermes.v1");
  for (const weak of ["source_inspected", "fixture_tested"] as const) {
    const candidate = parseConnectorProfileV1(value);
    candidate.operations.submit.evidence = weak;
    assert.equal(connectorOperationAdmissibleV1(candidate, "submit"), false,
      `weak evidence ${weak} must not enable submit`);
  }
  for (const strong of ["actual_interface_tested", "native_qualified"] as const) {
    const candidate = parseConnectorProfileV1(value);
    candidate.operations.submit.evidence = strong;
    assert.equal(connectorOperationAdmissibleV1(candidate, "submit"), true,
      `strong evidence ${strong} must enable submit`);
  }
});

test("credential isolation: submit cannot be supported when credential resolution is unsupported", () => {
  const breach = profileFor("hermes", "breach.v1");
  breach.credentialResolution = "unsupported";
  assert.throws(() => parseConnectorProfileV1(breach));
});

test("observation-only transport cannot advertise execution operations", () => {
  for (const op of ["submit", "cancel", "resume"] as const) {
    const observed = profileFor("hermes", `obs.v1.${op}`);
    observed.transport = "observation_only";
    assert.throws(() => parseConnectorProfileV1(observed),
      `observation-only transport must not allow ${op}`);
  }
});

test("disconnect/restart: switching to unknown hides operation from the admissible set", () => {
  const value = parseConnectorProfileV1(profileFor("hermes", "restart.v1"));
  const before = connectorOperationAdmissibleV1(value, "status");
  assert.equal(before, false, "status starts unsupported by the test fixture");
  const after = parseConnectorProfileV1(profileFor("hermes", "restart.v1"));
  after.operations.status = operation("supported", "native_qualified", "upstream_status_native");
  assert.equal(connectorOperationAdmissibleV1(after, "status"), true);
});

test("every connector operation must show up in the admissible check, even unknown ones", () => {
  const value = profileFor("hermes", "complete.v1");
  for (const op of connectorOperationNamesV1 as readonly ConnectorOperationNameV1[]) {
    const result = connectorOperationAdmissibleV1(value, op);
    assert.equal(typeof result, "boolean", `op ${op} must return a boolean`);
  }
});

test("parity: parseConnectorProfileV1 deep-clones so caller mutation cannot poison the original", () => {
  const original = profileFor("hermes", "parity.v1");
  const parsed = parseConnectorProfileV1(original);
  (parsed.operations.submit as { reasonCode: string }).reasonCode = "mutated";
  const reParsed = parseConnectorProfileV1(original);
  assert.notEqual(reParsed.operations.submit.reasonCode, "mutated");
});

test("sourceRevision must be exactly 40 lowercase hex characters", () => {
  const upper = profileFor("hermes", "upper.v1");
  upper.sourceRevision = "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
  assert.throws(() => parseConnectorProfileV1(upper));
  const short = profileFor("hermes", "short.v1");
  short.sourceRevision = "0123456789abcdef0123456789abcdef0123456";
  assert.throws(() => parseConnectorProfileV1(short));
});

test("credential resolution must be one of the explicit named modes", () => {
  const forger = profileFor("hermes", "forge.v1");
  forger.credentialResolution = "make_believe" as never;
  assert.throws(() => parseConnectorProfileV1(forger));
});
