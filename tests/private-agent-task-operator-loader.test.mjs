import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguration, PRIVATE_VPS_AGENT_TASK_PROVIDER_V1, schema } from "../deploy/agent-task-operator-config.mjs";

const settings = Object.freeze({ schema: "control-room.agent-task-operator-settings/v1" });
const trustedInputs = Object.freeze({ trusted: true });
const nativeHttps = Object.freeze({ cert: new Uint8Array([1]), key: new Uint8Array([2]), ca: new Uint8Array([3]) });
const provider = Object.freeze({ schema: PRIVATE_VPS_AGENT_TASK_PROVIDER_V1,
  async createConfiguration({ signal }) { assert.equal(signal.aborted, false); return Object.freeze({ operatorSettings: settings, trustedInputs, nativeHttps }); } });

test("protected agent-task loader accepts only an owner-held provider and uses the existing assembler", async () => {
  const calls = [];
  const prepared = await createConfiguration({ signal: new AbortController().signal }, {
    providerPath: () => "/protected/agent-task-provider.mjs",
    async validatePath(path) { calls.push(`validate:${path}`); },
    async loadProvider(path) { calls.push(`provider:${path}`); return provider; },
    async loadAssembler() { calls.push("assembler"); return { assemblePrivateAgentTaskOperatorConfiguration(actualSettings, actualTrusted) {
      calls.push([actualSettings, actualTrusted]); return Object.freeze({ port: 3210, configuration: Object.freeze({ coordinator: Object.freeze({}) }) });
    } }; },
  });
  assert.equal(schema, "control-room.private-vps-configuration/v1");
  assert.equal(prepared.mode, "agent-tasks"); assert.equal(prepared.port, 3210); assert.equal(prepared.nativeHttps, nativeHttps);
  assert.deepEqual(calls.slice(0, 3), ["validate:/protected/agent-task-provider.mjs", "provider:/protected/agent-task-provider.mjs", "assembler"]);
  assert.equal(calls[3][0], settings); assert.equal(calls[3][1], trustedInputs);
});

test("missing, malformed, aborted, and failing providers refuse without reaching the assembler or leaking their error", async () => {
  const cases = [
    { providerPath: () => undefined },
    { providerPath: () => "relative.mjs" },
    { providerPath: () => "/protected/provider.mjs", validatePath: async () => { throw new Error("private filesystem detail"); } },
    { providerPath: () => "/protected/provider.mjs", validatePath: async () => {}, loadProvider: async () => ({ schema: PRIVATE_VPS_AGENT_TASK_PROVIDER_V1 }) },
    { providerPath: () => "/protected/provider.mjs", validatePath: async () => {}, loadProvider: async () => Object.freeze({ schema: PRIVATE_VPS_AGENT_TASK_PROVIDER_V1,
      async createConfiguration() { return { operatorSettings: settings, trustedInputs }; } }) },
  ];
  for (const patch of cases) {
    let assembled = 0;
    await assert.rejects(createConfiguration({ signal: new AbortController().signal }, {
      providerPath: patch.providerPath, validatePath: patch.validatePath ?? (async () => {}), loadProvider: patch.loadProvider ?? (async () => provider),
      async loadAssembler() { assembled++; return {}; },
    }), error => error.message === "private_agent_task_operator_configuration_invalid");
    assert.equal(assembled, 0);
  }
  const aborted = AbortSignal.abort();
  await assert.rejects(createConfiguration({ signal: aborted }, { providerPath: () => { throw new Error("must not read"); },
    validatePath: async () => assert.fail("must not validate"), loadProvider: async () => provider, loadAssembler: async () => ({}) }),
  error => !String(error.message).includes("must not read"));
});
