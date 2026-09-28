import assert from "node:assert/strict";
import test from "node:test";
import { deriveProtectedAgentPrincipalV1 } from "../src/completion-gate/v1/protected-agent-principal";

const route = (nodeId: string, capabilityProbeId: "harness.codex.owner-trusted.local.v1" | "harness.claude-code.local.v1" |
  "harness.hermes.macos.local.v1", executorId = "worker:one") => ({ nodeId, executorId, capabilityProbeId,
  maxConcurrentTasks: 1, requiredScratchBytes: 0, leaseSeconds: 60 });
const base = { workerId: "worker:one", nodeId: "node:one", selectionKey: "selection:one", model: "model:one" };

test("protected route derives harness, adapter, profile and family without worker-authored provenance", () => {
  const codex = deriveProtectedAgentPrincipalV1(route("node:one", "harness.codex.owner-trusted.local.v1"),
    { ...base, workerKind: "codex", provider: null, profile: null });
  const claude = deriveProtectedAgentPrincipalV1(route("node:one", "harness.claude-code.local.v1"),
    { ...base, workerKind: "claude-code", provider: null, profile: null });
  const hermes = deriveProtectedAgentPrincipalV1(route("node:one", "harness.hermes.macos.local.v1"),
    { ...base, workerKind: "hermes", provider: "openai", profile: "profile:openai" });
  assert.deepEqual([codex.harness, claude.harness, hermes.harness], ["codex", "claude", "hermes"]);
  assert.equal(codex.modelFamily, "model-family:openai");
  assert.equal(claude.modelFamily, "model-family:anthropic");
  assert.equal(hermes.modelFamily, codex.modelFamily, "family follows the protected provider, not the harness name");
  assert.equal(hermes.agentProfileId, "agent-profile:profile:openai");
});

test("unknown protected provider remains missing and route mismatch is refused", () => {
  const unknown = deriveProtectedAgentPrincipalV1(route("node:one", "harness.hermes.macos.local.v1"),
    { ...base, workerKind: "hermes", provider: "provider:unknown", profile: "profile:unknown" });
  assert.equal(unknown.modelFamily, undefined);
  assert.throws(() => deriveProtectedAgentPrincipalV1(route("node:other", "harness.codex.owner-trusted.local.v1"),
    { ...base, workerKind: "codex", provider: null, profile: null }), /protected_agent_route_mismatch/u);
  assert.throws(() => deriveProtectedAgentPrincipalV1(route("node:one", "harness.claude-code.local.v1"),
    { ...base, workerKind: "codex", provider: null, profile: null }), /protected_agent_route_mismatch/u);
  assert.throws(() => deriveProtectedAgentPrincipalV1(route("node:one", "harness.codex.owner-trusted.local.v1", "worker:other"),
    { ...base, workerKind: "codex", provider: null, profile: null }), /protected_agent_route_mismatch/u);
});
