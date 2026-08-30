import assert from "node:assert/strict";
import test from "node:test";
import { buildWayfarerSchedulingScenarioCatalogV1, buildWayfarerSyntheticProjectPackV1,
  parseWayfarerSchedulingScenarioV1 } from "../src/project-adapters/wayfarer/v1";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

function setup() { const pack = buildWayfarerSyntheticProjectPackV1();
  return { pack, scenarios: buildWayfarerSchedulingScenarioCatalogV1(pack) }; }
function named(scenarios: ReturnType<typeof buildWayfarerSchedulingScenarioCatalogV1>, suffix: string) {
  return scenarios.find((scenario) => scenario.scenarioId.endsWith(suffix))!;
}
function rehash<T extends Record<string, unknown>>(value: T) { const copy = { ...value }; delete copy.scenarioDigest;
  return { ...copy, scenarioDigest: sha256Digest(copy) }; }

test("CR9B-WF-070 catalog covers ready, scratch, GPU, benchmark, contention, and Unreal scenarios", () => {
  const { scenarios } = setup();
  assert.equal(scenarios.length, 6); assert.equal(new Set(scenarios.map((scenario) => scenario.scenarioId)).size, 6);
  assert.deepEqual(scenarios.map((scenario) => scenario.scenarioId), ["scenario:wayfarer:synthetic-render-ready",
    "scenario:wayfarer:scratch-blocked", "scenario:wayfarer:gpu-capability-missing", "scenario:wayfarer:benchmark-mismatch",
    "scenario:wayfarer:gpu-contention", "scenario:wayfarer:unreal-disabled"]);
});

test("CR9B-WF-070 ready route is only a synthetic selection and never a reservation or dispatch", () => {
  const ready = named(setup().scenarios, "synthetic-render-ready");
  assert.equal(ready.selectedForSimulation, true); assert.deepEqual(ready.rejectionReasons, []);
  assert.equal(ready.gpuCapabilityState, "reported_pass"); assert.equal(ready.benchmarkState, "synthetic_match");
  assert.equal(ready.schedulerExplanation.some((line) => /not an execution grant or resource reservation/i.test(line)), true);
  assert.equal(ready.evidenceAuthority === "synthetic_only" && !ready.realGpuInspected && !ready.realScratchInspected
    && !ready.benchmarkExecuted && !ready.createsReservation && !ready.dispatchesWork && !ready.allowsNativeExecution
    && !ready.grantsApproval && !ready.grantsExecutionAuthority, true);
});

test("CR9B-WF-070 hard eligibility names scratch, GPU capability, and benchmark failures", () => {
  const { scenarios } = setup();
  assert.deepEqual(named(scenarios, "scratch-blocked").rejectionReasons, ["scratch_insufficient"]);
  assert.deepEqual(named(scenarios, "gpu-capability-missing").rejectionReasons, ["gpu_capability_missing"]);
  assert.deepEqual(named(scenarios, "benchmark-mismatch").rejectionReasons, ["benchmark_environment_mismatch"]);
  assert.equal(named(scenarios, "scratch-blocked").selectedForSimulation, false);
});

test("CR9B-WF-070 contention reports a bottleneck and hypothetical relief without releasing capacity", () => {
  const contention = named(setup().scenarios, "gpu-contention");
  assert.deepEqual(contention.rejectionReasons, ["gpu_capacity_unavailable"]);
  assert.match(contention.bottleneckResourceKey!, /^resource:wayfarer:synthetic-gpu:/u);
  assert.equal(contention.reliefWouldMakeFeasible, true); assert.equal(contention.createsReservation, false);
  assert.equal(contention.dispatchesWork, false);
});

test("CR9B-WF-070 Unreal remains ineligible despite generous declared synthetic resources", () => {
  const unreal = named(setup().scenarios, "unreal-disabled");
  assert.deepEqual(unreal.rejectionReasons, ["unreal_not_eligible"]); assert.equal(unreal.selectedForSimulation, false);
  assert.ok(unreal.availableMemoryBytes >= unreal.minimumMemoryBytes); assert.ok(unreal.availableScratchBytes >= unreal.minimumScratchBytes);
  assert.equal(unreal.gpuCapabilityState, "reported_pass"); assert.equal(unreal.benchmarkState, "synthetic_match");
  assert.equal(unreal.benchmarkExecuted, false);
});

test("CR9B-WF-070 scenario results are deterministic, digest-bound, and exact", () => {
  const first = setup(), second = buildWayfarerSchedulingScenarioCatalogV1(first.pack);
  assert.deepEqual(second, first.scenarios);
  for (const scenario of first.scenarios) assert.deepEqual(parseWayfarerSchedulingScenarioV1(scenario), scenario);
  const ready = named(first.scenarios, "synthetic-render-ready");
  assert.throws(() => parseWayfarerSchedulingScenarioV1({ ...ready, projectId: "project:other" }), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerSchedulingScenarioV1(rehash({ ...ready, selectedForSimulation: false })), ProjectWorkspaceContractErrorV1);
  assert.throws(() => parseWayfarerSchedulingScenarioV1({ ...ready, hostName: "private-machine" }), ProjectWorkspaceContractErrorV1);
});

test("CR9B-WF-070 exact catalog input rejects accessors and Proxies without executing traps", () => {
  const { pack } = setup(); let calls = 0; const accessor = { ...pack };
  Object.defineProperty(accessor, "packId", { enumerable: true, get() { calls += 1; return pack.packId; } });
  assert.throws(() => buildWayfarerSchedulingScenarioCatalogV1(accessor), ProjectWorkspaceContractErrorV1); assert.equal(calls, 0);
  const proxied = observedProxy(pack, "transparent");
  assert.throws(() => buildWayfarerSchedulingScenarioCatalogV1(proxied.value), ProjectWorkspaceContractErrorV1);
  assert.equal(proxied.trapCount(), 0);
});
