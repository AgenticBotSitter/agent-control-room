import assert from "node:assert/strict";
import test from "node:test";
import { hermesGptConnectorProfileV1, HERMES_GPT_SOURCE_REVISION_V1 } from "../src/harness/hermes-gpt-v1";
import { connectorOperationAdmissibleV1, connectorOperationNamesV1 } from "../src/harness/v1/connector-profile";

test("Hermes profile pins the selected source and only its inspected FastMCP boundary", () => {
  assert.equal(HERMES_GPT_SOURCE_REVISION_V1, "89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73");
  assert.equal(hermesGptConnectorProfileV1.sourceRevision, HERMES_GPT_SOURCE_REVISION_V1);
  assert.equal(hermesGptConnectorProfileV1.transport, "fastmcp_tools");
  assert.equal(hermesGptConnectorProfileV1.distribution, "invocation_only");
  assert.deepEqual(Object.entries(hermesGptConnectorProfileV1.operations)
    .filter(([, value]) => value.status === "supported").map(([name]) => name), ["submit", "status", "result"]);
});

test("source inspection cannot enable any Hermes operation", () => {
  for (const name of connectorOperationNamesV1) {
    assert.equal(connectorOperationAdmissibleV1(hermesGptConnectorProfileV1, name), false, name);
  }
});
