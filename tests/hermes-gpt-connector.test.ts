import assert from "node:assert/strict";
import test from "node:test";
import {
  HERMES_GPT_SOURCE_REVISION_V1, hermesGptConnectorProfileV1,
} from "../src/harness/hermes-gpt-v1/connector-profile";
import {
  connectorOperationAdmissibleV1, connectorOperationNamesV1, parseConnectorProfileV1,
} from "../src/harness/v1/connector-profile";
import {
  HERMES_SESSION_MAX_PROMPT_CHARS_V1, HERMES_SESSION_MAX_RESULT_CHARS_V1,
  HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1, HERMES_SESSION_MIN_RESULT_CHARS_V1,
  HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1, HERMES_SESSION_TOOLS_V1,
} from "../src/harness/hermes-gpt-v1/session-contract";
import { hermesSessionUnsupportedOperationV1 } from "../src/harness/hermes-gpt-v1/session-runtime";

test("the profile still parses and pins the exact evaluated upstream revision", () => {
  const parsed = parseConnectorProfileV1(hermesGptConnectorProfileV1);
  assert.equal(parsed.sourceRevision, HERMES_GPT_SOURCE_REVISION_V1);
  assert.equal(parsed.sourceRevision, "89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73");
  assert.equal(parsed.transport, "fastmcp_tools");
  assert.equal(parsed.harness, "hermes");
  assert.equal(parsed.resultContract.maximumBytes, 65_536);
  assert.equal(parsed.resultContract.additionalAttachments, false);
});

test("recorded-transport fixtures raise the three mapped operations to fixture evidence only", () => {
  for (const name of ["submit", "status", "result"] as const) {
    assert.equal(hermesGptConnectorProfileV1.operations[name].status, "supported", name);
    assert.equal(hermesGptConnectorProfileV1.operations[name].evidence, "fixture_tested", name);
  }
  // Absence of cancel/events/usage/artifacts is a source-inspection finding.
  // No fixture exercises a tool that does not exist upstream, so claiming
  // fixture evidence for them would be false.
  for (const name of ["events", "cancel", "resume", "read", "usage", "artifacts"] as const) {
    assert.equal(hermesGptConnectorProfileV1.operations[name].status, "unsupported", name);
    assert.equal(hermesGptConnectorProfileV1.operations[name].evidence, "source_inspected", name);
  }
});

test("fixture evidence still cannot admit any operation for execution", () => {
  // This is the whole point of the evidence ladder: recorded transports prove
  // the mapping, not that a real Hermes installation behaves this way. Live
  // qualification is separately authorized work.
  for (const name of connectorOperationNamesV1) {
    assert.equal(connectorOperationAdmissibleV1(hermesGptConnectorProfileV1, name), false, name);
  }
});

test("the runtime refuses every unsupported operation with its upstream reason", () => {
  assert.deepEqual(hermesSessionUnsupportedOperationV1("cancel"),
    { supported: false, reasonCode: "no_cancel_interface" });
  assert.deepEqual(hermesSessionUnsupportedOperationV1("events"),
    { supported: false, reasonCode: "no_event_replay_interface" });
  assert.deepEqual(hermesSessionUnsupportedOperationV1("resume"),
    { supported: false, reasonCode: "restart_can_orphan_running_job" });
  assert.deepEqual(hermesSessionUnsupportedOperationV1("usage"),
    { supported: false, reasonCode: "no_per_job_usage_interface" });
  assert.deepEqual(hermesSessionUnsupportedOperationV1("artifacts"),
    { supported: false, reasonCode: "no_bounded_artifact_interface" });
  assert.deepEqual(hermesSessionUnsupportedOperationV1("read"),
    { supported: false, reasonCode: "use_bounded_result_operation" });
  assert.equal(hermesSessionUnsupportedOperationV1("submit").supported, true);
  assert.equal(hermesSessionUnsupportedOperationV1("nonsense" as never).reasonCode, "unknown_operation");
});

test("the contract constants match the pinned upstream module exactly", () => {
  // Read from operator_session.py at 89cbfbe2: MAX_PROMPT_CHARS, MAX_RESULT_CHARS,
  // MIN_TIMEOUT, MAX_TIMEOUT and the result-cap clamp floor.
  assert.equal(HERMES_SESSION_MAX_PROMPT_CHARS_V1, 65_536);
  assert.equal(HERMES_SESSION_MAX_RESULT_CHARS_V1, 24_000);
  assert.equal(HERMES_SESSION_MIN_RESULT_CHARS_V1, 500);
  assert.equal(HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1, 10);
  assert.equal(HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1, 3_600);
  assert.deepEqual([...HERMES_SESSION_TOOLS_V1],
    ["hermes_session_continue", "hermes_session_job_status", "hermes_session_job_result"]);
});

test("the profile carries no endpoint, credential or executable reference", () => {
  const serialized = JSON.stringify(hermesGptConnectorProfileV1);
  for (const forbidden of ["http://", "https://", "token", "password", "secret", "/Users/", "/home/", "hermes.exe"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), forbidden);
  }
});
