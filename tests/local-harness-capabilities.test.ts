import assert from "node:assert/strict";
import test from "node:test";
import { localHarnessCapabilitiesV1 } from "../src/harness/v1/local-harness-capabilities";

test("local harness capabilities are truthful, bounded and installation-safe", () => {
  assert.deepEqual(localHarnessCapabilitiesV1.map(value => value.id), ["hermes", "claude", "codex"]);
  const hermes = localHarnessCapabilitiesV1.find(value => value.id === "hermes")!;
  const claude = localHarnessCapabilitiesV1.find(value => value.id === "claude")!;
  const codex = localHarnessCapabilitiesV1.find(value => value.id === "codex")!;
  assert.equal(hermes.state, "setup_required");
  assert.equal(hermes.operations.submit, "unknown");
  assert.match(hermes.firstSupportedWork, /plain-text review/);
  assert.match(hermes.firstSupportedWork, /cannot edit a project yet/);
  assert.equal(claude.state, "setup_required");
  assert.equal(claude.operations.submit, "unsupported");
  assert.equal(codex.state, "not_available");
  assert.equal(codex.operations.submit, "unsupported");
  const rendered = JSON.stringify(localHarnessCapabilitiesV1);
  assert.doesNotMatch(rendered, /\/Users\/|https?:\/\/|(?:token|password|profile)\s*[=:]/i);
});
