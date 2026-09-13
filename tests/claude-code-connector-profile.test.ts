import assert from "node:assert/strict";
import test from "node:test";
import { connectorOperationAdmissibleV1, connectorOperationNamesV1 } from "../src/harness/v1/connector-profile";
import { claudeCodeConnectorProfileV1, CLAUDE_CODE_PACKAGE_INTEGRITY_V1,
  CLAUDE_CODE_PACKAGE_NAME_V1, CLAUDE_CODE_PACKAGE_VERSION_V1 } from "../src/harness/claude-code-v1";

test("Claude Code profile identifies one exact operator-installed npm package", () => {
  assert.equal(claudeCodeConnectorProfileV1.sourceRevision, undefined);
  assert.deepEqual(claudeCodeConnectorProfileV1.sourcePackage, {
    ecosystem: "npm", name: CLAUDE_CODE_PACKAGE_NAME_V1, version: CLAUDE_CODE_PACKAGE_VERSION_V1,
    integrity: CLAUDE_CODE_PACKAGE_INTEGRITY_V1,
  });
  assert.equal(claudeCodeConnectorProfileV1.transport, "jsonl_stdio");
  assert.equal(claudeCodeConnectorProfileV1.credentialResolution, "harness_native");
  assert.equal(claudeCodeConnectorProfileV1.distribution, "invocation_only");
});

test("Claude Code profile cannot admit any operation without authenticated evidence", () => {
  for (const name of connectorOperationNamesV1) {
    assert.equal(claudeCodeConnectorProfileV1.operations[name].status, "unsupported", name);
    assert.equal(connectorOperationAdmissibleV1(claudeCodeConnectorProfileV1, name), false, name);
    assert.notEqual(claudeCodeConnectorProfileV1.operations[name].evidence, "actual_interface_tested", name);
    assert.notEqual(claudeCodeConnectorProfileV1.operations[name].evidence, "native_qualified", name);
  }
});
