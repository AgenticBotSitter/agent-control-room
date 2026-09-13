import assert from "node:assert/strict";
import test from "node:test";
import { connectorOperationAdmissibleV1, connectorOperationNamesV1 } from "../src/harness/v1/connector-profile";
import { claudeCodeConnectorProfileV1, CLAUDE_CODE_PACKAGE_NAME_V1, CLAUDE_CODE_PACKAGE_VERSION_V1 } from "../src/harness/claude-code-v1";

test("CR-CC claude code connector identifies the exact npm package, not an invented git revision", () => {
  assert.equal(claudeCodeConnectorProfileV1.sourceRevision, undefined);
  assert.deepEqual(claudeCodeConnectorProfileV1.sourcePackage, {
    ecosystem: "npm", name: CLAUDE_CODE_PACKAGE_NAME_V1, version: CLAUDE_CODE_PACKAGE_VERSION_V1,
    integrity: "sha512-0zMkfIWQu7/SG56VP8r780HZWvrNShzK28AbAnhKRK0ns+ToGXPT0W8UqyZmZCUKAkJDd5//TrwSOhk1+hysiw==",
  });
  assert.equal(claudeCodeConnectorProfileV1.transport, "jsonl_stdio");
  assert.equal(claudeCodeConnectorProfileV1.credentialResolution, "harness_native");
});

test("CR-CC no Claude Code operation is admissible yet, per docs/SHARED_CONNECTOR_CONTRACT.md", () => {
  for (const name of connectorOperationNamesV1) {
    assert.equal(claudeCodeConnectorProfileV1.operations[name].status, "unsupported", name);
    assert.equal(connectorOperationAdmissibleV1(claudeCodeConnectorProfileV1, name), false, name);
  }
});

test("CR-CC every declared evidence level reflects something Stage A0 actually captured, not a guess", () => {
  // Stage A0 (docs/claude/CLAUDE_CODE_A0_VERIFICATION.md) ran the real CLI unauthenticated
  // and captured real system/init, assistant, and result stream-json frames. That's real
  // fixture evidence for the result/status/events/usage/resume-not-found shapes, but no
  // operation ever completed a real authenticated round trip, so none may claim
  // actual_interface_tested or native_qualified.
  for (const name of connectorOperationNamesV1) {
    const evidence = claudeCodeConnectorProfileV1.operations[name].evidence;
    assert.notEqual(evidence, "actual_interface_tested", name);
    assert.notEqual(evidence, "native_qualified", name);
  }
  assert.equal(claudeCodeConnectorProfileV1.operations.result.evidence, "fixture_tested");
  assert.equal(claudeCodeConnectorProfileV1.operations.cancel.evidence, "source_inspected");
});
