import assert from "node:assert/strict";
import test from "node:test";
import { MAC_LOCAL_TASK_PROVIDER_V1, MAC_LOCAL_THREE_AGENT_KINDS_V1, loadMacLocalTaskProviderFromRootV1,
  requireMacLocalThreeAgentReadinessV1 } from "../src/web/v1/mac-local-task-provider";

const directory = (mode = 0o700) => ({ isDirectory: () => true, isSymbolicLink: () => false, mode, size: 0 });
const file = (mode = 0o600, size = 100) => ({ isFile: () => true, isSymbolicLink: () => false, mode, size });
const provider = Object.freeze({ schema: MAC_LOCAL_TASK_PROVIDER_V1,
  workerKinds: MAC_LOCAL_THREE_AGENT_KINDS_V1,
  async createTaskApplication() { return { operations: {}, isReady: () => true, async close() {} }; },
});

test("loads only the fixed, owner-only local task provider path", async () => {
  const seen: string[] = [];
  const loaded = await loadMacLocalTaskProviderFromRootV1("/protected", {
    async lstat(path) { seen.push(path); return path.endsWith("task-provider.mjs") ? file() : directory(); },
    async load(path) { seen.push(`load:${path}`); return provider; },
  });
  assert.equal(loaded.schema, MAC_LOCAL_TASK_PROVIDER_V1);
  assert.deepEqual(seen, ["/protected", "/protected/runtime", "/protected/runtime/task-provider.mjs", "load:/protected/runtime/task-provider.mjs"]);
});

test("refuses loose, substituted, or malformed local task providers", async () => {
  const base = { async lstat(path: string) { return path.endsWith("task-provider.mjs") ? file() : directory(); },
    async load() { return provider; } };
  await assert.rejects(loadMacLocalTaskProviderFromRootV1("relative", base), /mac_local_task_provider_root_invalid/);
  await assert.rejects(loadMacLocalTaskProviderFromRootV1("/protected", { ...base,
    async lstat(path: string) { return path.endsWith("task-provider.mjs") ? file(0o644) : directory(); } }), /mac_local_task_provider_invalid/);
  await assert.rejects(loadMacLocalTaskProviderFromRootV1("/protected", { ...base,
    async load() { return { schema: MAC_LOCAL_TASK_PROVIDER_V1, workerKinds: ["hermes-021"], createTaskApplication() {} }; } }), /mac_local_task_provider_invalid/);
});

test("three-agent task host requires all three freshly verified local worker kinds", () => {
  const read = () => [
    { kind: "hermes-021", state: "ready", proof: "not_proven" },
    { kind: "claude-code", state: "ready", proof: "not_proven" },
    { kind: "codex", state: "ready", proof: "not_proven" },
  ] as const;
  requireMacLocalThreeAgentReadinessV1(provider, { read });
  assert.throws(() => requireMacLocalThreeAgentReadinessV1(provider, { read: () => [
    { kind: "hermes-021", state: "ready", proof: "not_proven" },
    { kind: "claude-code", state: "unavailable", proof: "not_proven" },
    { kind: "codex", state: "ready", proof: "not_proven" },
  ] }), /mac_local_three_agent_readiness_required/);
});
