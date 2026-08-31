import assert from "node:assert/strict";
import test from "node:test";
import { codexHarnessAdapterV1, CODEX_PINNED_MACOS_CDHASH_V1 } from "../src/harness/codex-v1";
import { hermesHarnessAdapterV1, HERMES_REQUIRED_GATEWAY_METHODS_V1, hermesAdapterManifestV1 } from "../src/harness/hermes-v1";
import { defineHarnessAdapterV1, exampleHarnessAdapterV1, HARNESS_ADAPTER_SDK_VERSION_V1, runHarnessAdapterConformanceV1 } from "../src/harness/sdk-v1";

const at = "2026-08-28T12:00:00.000Z";
const context = (sequence: number, nativeSessionId?: string) => ({ tenantId: "tenant:sdk", nodeId: "node:sdk", runId: "run:sdk",
  sequence, occurredAt: at, ...(nativeSessionId ? { nativeSessionId } : {}) });

const hermesEvidence = { harnessVersion: "0.20.6", harnessRevision: hermesAdapterManifestV1.harnessRevision,
  gatewayMethods: [...HERMES_REQUIRED_GATEWAY_METHODS_V1] };
const codexEvidence = { version: "0.150.0-alpha.8", macosCodeDirectoryHash: CODEX_PINNED_MACOS_CDHASH_V1, execJson: true,
  execResume: true, ignoreUserConfig: true, ignoreRules: true, credentialIsolation: "blocked", sandboxModes: ["read-only","workspace-write"] };

test("CR7D public SDK represents Hermes and Codex as observation-only adapters", () => {
  for (const adapter of [hermesHarnessAdapterV1,codexHarnessAdapterV1,exampleHarnessAdapterV1]) {
    assert.equal(adapter.sdkVersion,HARNESS_ADAPTER_SDK_VERSION_V1);
    assert.deepEqual(Object.keys(adapter).sort(),["evaluateCompatibility","manifest","normalizeEvent","sdkVersion"]);
    assert.equal("start" in adapter,false); assert.equal("approve" in adapter,false); assert.equal("dispatch" in adapter,false);
    assert.equal("credential" in adapter,false); assert.equal("execute" in adapter,false);
  }
  assert.equal(codexHarnessAdapterV1.manifest.supportedVerbs.includes("steer"),false);
  assert.equal(hermesHarnessAdapterV1.manifest.approvalMode,"observe_only");
});

test("CR7D conformance accepts the real Hermes and Codex safe event mappings", () => {
  const hermes = runHarnessAdapterConformanceV1({ adapter: hermesHarnessAdapterV1, compatibilityEvidence: hermesEvidence, fixtures: [
    { name: "gateway ready", frame: { jsonrpc: "2.0",method: "event",params: { type: "gateway.ready",session_id: "native:hermes" } },
      context: context(1,"native:hermes"), expectedEventCount: 1 },
    { name: "tool progress", frame: { jsonrpc: "2.0",method: "event",params: { type: "tool.progress",session_id: "native:hermes" } },
      context: context(2,"native:hermes"), expectedEventCount: 1 },
  ] });
  assert.deepEqual(hermes,{ adapterId: "adapter.hermes.gateway.v1",compatible: true,normalizedEventCount: 2,reasons: [] });

  const codex = runHarnessAdapterConformanceV1({ adapter: codexHarnessAdapterV1, compatibilityEvidence: codexEvidence, fixtures: [
    { name: "thread start",frame: JSON.stringify({ type: "thread.started",thread_id: "123e4567-e89b-12d3-a456-426614174000" }),context: context(1),expectedEventCount: 1 },
    { name: "turn complete",frame: JSON.stringify({ type: "turn.completed",usage: { input_tokens: 3,output_tokens: 2 } }),context: context(2),expectedEventCount: 2 },
  ] });
  assert.deepEqual(codex,{ adapterId: "adapter.codex.exec.macos.v1",compatible: true,normalizedEventCount: 3,reasons: [] });
});

test("CR7D normalizes native identity into a digest and never exposes it in output", () => {
  const hermes = hermesHarnessAdapterV1.normalizeEvent({ jsonrpc: "2.0",method: "event",params: { type: "gateway.ready",session_id: "native:private" } },context(1,"native:private"));
  const codex = codexHarnessAdapterV1.normalizeEvent(JSON.stringify({ type: "thread.started",thread_id: "123e4567-e89b-12d3-a456-426614174000" }),context(1));
  for (const output of [hermes,codex]) {
    assert.match(output.nativeSessionKeyDigest ?? "",/^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(output).includes("native:private"),false);
    assert.equal(JSON.stringify(output).includes("123e4567-e89b-12d3-a456-426614174000"),false);
  }
});

test("CR7D conformance rejects capability drift, malformed fixtures, session mismatch, and secret output", () => {
  assert.deepEqual(runHarnessAdapterConformanceV1({ adapter: hermesHarnessAdapterV1,compatibilityEvidence: { ...hermesEvidence,harnessVersion: "drift" },fixtures: [] }),
    { adapterId: "adapter.hermes.gateway.v1",compatible: false,normalizedEventCount: 0,reasons: ["compatibility_rejected"] });
  assert.deepEqual(runHarnessAdapterConformanceV1({ adapter: hermesHarnessAdapterV1,compatibilityEvidence: hermesEvidence,fixtures: [
    { name: "wrong session",frame: { jsonrpc: "2.0",method: "event",params: { type: "gateway.ready",session_id: "other" } },context: context(1,"native:hermes"),expectedEventCount: 1 },
  ] }),{ adapterId: "adapter.hermes.gateway.v1",compatible: false,normalizedEventCount: 0,reasons: ["normalization_failed"] });
  const hostile = defineHarnessAdapterV1({ ...exampleHarnessAdapterV1,normalizeEvent: () => ({ events: [],finalTextDigest: "sha256:" + "a".repeat(64),secret: "Bearer leaked-token-0123456789" }) });
  assert.deepEqual(runHarnessAdapterConformanceV1({ adapter: hostile,compatibilityEvidence: { version: "1.0.0" },fixtures: [
    { name: "hostile",frame: { state: "ready" },context: context(1),expectedEventCount: 0 },
  ] }),{ adapterId: "adapter.example.status.v1",compatible: false,normalizedEventCount: 0,reasons: ["normalization_failed"] });
});

test("CR7D example adapter is conformance-valid but remains effect-free", () => {
  assert.deepEqual(runHarnessAdapterConformanceV1({ adapter: exampleHarnessAdapterV1,compatibilityEvidence: { version: "1.0.0" },fixtures: [
    { name: "ready status",frame: { state: "ready" },context: context(1),expectedEventCount: 1 },
  ] }),{ adapterId: "adapter.example.status.v1",compatible: true,normalizedEventCount: 1,reasons: [] });
});

test("CR7Q conformance rejects hidden effect methods, false compatibility claims, and forged event lineage",()=>{
  const hidden={...exampleHarnessAdapterV1,execute:()=>"effect"};
  assert.deepEqual(runHarnessAdapterConformanceV1({adapter:hidden,compatibilityEvidence:{version:"1.0.0"},fixtures:[]}),
    {adapterId:"adapter:invalid",compatible:false,normalizedEventCount:0,reasons:["fixture_invalid"]});
  const contradictory=defineHarnessAdapterV1({...exampleHarnessAdapterV1,evaluateCompatibility:()=>({compatible:true,reasons:["version_drift"]})});
  assert.deepEqual(runHarnessAdapterConformanceV1({adapter:contradictory,compatibilityEvidence:{version:"1.0.0"},fixtures:[]}),
    {adapterId:"adapter.example.status.v1",compatible:false,normalizedEventCount:0,reasons:["compatibility_rejected"]});
  const forged=defineHarnessAdapterV1({...exampleHarnessAdapterV1,normalizeEvent:(frame:unknown,input:ReturnType<typeof context>)=>{
    const result=exampleHarnessAdapterV1.normalizeEvent(frame,input); return {events:result.events.map((event)=>({...event,sequence:event.sequence+1,occurredAt:"2026-08-28T12:00:01.000Z"}))};
  }});
  assert.deepEqual(runHarnessAdapterConformanceV1({adapter:forged,compatibilityEvidence:{version:"1.0.0"},fixtures:[{name:"forged lineage",frame:{state:"ready"},context:context(1),expectedEventCount:1}]}),
    {adapterId:"adapter.example.status.v1",compatible:false,normalizedEventCount:0,reasons:["normalization_failed"]});
});

test("CR7Q independent remediation rejects prototype, descriptor, accessor, and symbol widening",()=>{
  const expected={adapterId:"adapter:invalid",compatible:false,normalizedEventCount:0,reasons:["fixture_invalid"]};
  const inherited=Object.create({execute:()=>"effect"},Object.getOwnPropertyDescriptors(exampleHarnessAdapterV1)) as typeof exampleHarnessAdapterV1;
  Object.freeze(inherited);
  const nonEnumerable=Object.defineProperty({...exampleHarnessAdapterV1},"execute",{value:()=>"effect",enumerable:false}); Object.freeze(nonEnumerable);
  const accessor=Object.defineProperty({...exampleHarnessAdapterV1},"sdkVersion",{get:()=>HARNESS_ADAPTER_SDK_VERSION_V1,enumerable:true}); Object.freeze(accessor);
  const symbol=Object.freeze(Object.assign({...exampleHarnessAdapterV1},{[Symbol("execute")]:()=>"effect"}));
  for (const adapter of [inherited,nonEnumerable,accessor,symbol]) {
    assert.deepEqual(runHarnessAdapterConformanceV1({adapter,compatibilityEvidence:{version:"1.0.0"},fixtures:[]}),expected);
  }
});
