import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalInstallationPlanArguments,
  runInitializeLocalInstallationPlan } from "../scripts/initialize-local-installation-plan.mjs";

const releaseDigest = `sha256:${"a".repeat(64)}`;
const args = ["--owner-attended", "--journal-root", "/private/control-room/journal",
  "--installation-id", "local-installation-one", "--release-digest", releaseDigest,
  "--topology-plan", "/private/control-room/reviewed-topology.json"];
const controllerArgs = ["--owner-attended", "--journal-root", "/private/control-room/journal",
  "--installation-id", "local-installation-one", "--release-digest", releaseDigest, "--controller-only"];

test("launcher accepts only the exact owner-attended bootstrap arguments", () => {
  assert.deepEqual(parseLocalInstallationPlanArguments(args), { journalRoot: "/private/control-room/journal",
    installationId: "local-installation-one", releaseDigest,
    topologyPlanPath: "/private/control-room/reviewed-topology.json" });
  assert.deepEqual(parseLocalInstallationPlanArguments(["--help"]), { help: true });
  assert.deepEqual(parseLocalInstallationPlanArguments(controllerArgs), { journalRoot: "/private/control-room/journal",
    installationId: "local-installation-one", releaseDigest, controllerOnly: true });
  const reordered = ["--topology-plan", "/private/control-room/reviewed-topology.json", "--release-digest", releaseDigest,
    "--owner-attended", "--installation-id", "local-installation-one", "--journal-root", "/private/control-room/journal"];
  assert.deepEqual(parseLocalInstallationPlanArguments(reordered), parseLocalInstallationPlanArguments(args));
  for (const invalid of [[], args.filter(value => value !== "--owner-attended"), [...args, "--owner-uid", "501"],
    [...args, "--controller-only"], controllerArgs.filter(value => value !== "--controller-only"),
    args.map(value => value === "/private/control-room/journal" ? "relative" : value),
    args.map(value => value === "local-installation-one" ? "UNSAFE" : value),
    args.map(value => value === releaseDigest ? "sha256:no" : value)])
    assert.throws(() => parseLocalInstallationPlanArguments(invalid), /arguments_invalid/u);
});

test("controller-only mode obtains the neutral topology from the reviewed bootstrap module without a temp file", async () => {
  let reads = 0, factoryCalls = 0, captured; const output = [], errors = [];
  const neutral = { schema: "control-room.installation-topology-plan/v1", requestedRoutes: [] };
  const result = { schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "local-installation-one",
    revision: 0, planDigest: `sha256:${"c".repeat(64)}`, replayed: false };
  const code = await runInitializeLocalInstallationPlan(controllerArgs, { ownerUid: () => 501,
    async readTopology() { reads += 1; return {}; }, async loadBootstrap() { return {
      createControllerOnlyInstallationTopologyV1() { factoryCalls += 1; return neutral; },
      async initializeLocalInstallationPlanV1(input) { captured = input; return result; },
    }; }, report: line => output.push(line), reportError: line => errors.push(line) });
  assert.equal(code, 0); assert.equal(reads, 0); assert.equal(factoryCalls, 1);
  assert.equal(captured.topologyPlan, neutral); assert.deepEqual(errors, []);
  assert.deepEqual(output, [`${JSON.stringify(result)}\n`]);
});

test("launcher obtains owner uid from its runtime and emits only the sanitized result", async () => {
  const output = [], errors = [], topologyPlan = { schema: "reviewed-topology" };
  let readPath, capturedInput, capturedRuntime, loads = 0;
  const result = { schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "local-installation-one",
    revision: 0, planDigest: `sha256:${"b".repeat(64)}`, replayed: false, createsDatabase: false,
    writesCredentials: false, startsService: false, startsWorker: false, enablesAuthority: false,
    enablesWorkers: false, grantsExecutionAuthority: false };
  const code = await runInitializeLocalInstallationPlan(args, { ownerUid: () => 501,
    async readTopology(path) { readPath = path; return topologyPlan; },
    async loadBootstrap() { loads += 1; return { async initializeLocalInstallationPlanV1(input, runtime) {
      capturedInput = input; capturedRuntime = runtime; return result;
    } }; }, report: line => output.push(line), reportError: line => errors.push(line) });
  assert.equal(code, 0); assert.equal(loads, 1);
  assert.equal(readPath, "/private/control-room/reviewed-topology.json");
  assert.deepEqual(capturedInput, { ownerAttended: true, journalRoot: "/private/control-room/journal",
    installationId: "local-installation-one", releaseDigest, topologyPlan });
  assert.equal(capturedRuntime.ownerUid(), 501);
  assert.deepEqual(errors, []); assert.deepEqual(output, [`${JSON.stringify(result)}\n`]);
  assert.doesNotMatch(output[0], /private\/control-room|reviewed-topology/u);
});

test("launcher fails closed without reading inputs for an invalid owner runtime", async () => {
  let reads = 0, loads = 0; const output = [], errors = [];
  const code = await runInitializeLocalInstallationPlan(args, { ownerUid: () => undefined,
    async readTopology() { reads += 1; return {}; }, async loadBootstrap() { loads += 1; return {}; },
    report: line => output.push(line), reportError: line => errors.push(line) });
  assert.equal(code, 1); assert.equal(reads, 0); assert.equal(loads, 0); assert.deepEqual(output, []);
  assert.deepEqual(errors, ["Control Room requires an owner-local runtime to initialize the installation plan."]);
});

test("launcher sanitizes topology, load, and journal failures", async () => {
  for (const failure of ["read", "load", "initialize"]) {
    const output = [], errors = [];
    const code = await runInitializeLocalInstallationPlan(args, { ownerUid: () => 501,
      async readTopology() { if (failure === "read") throw new Error("/private/secret-topology"); return {}; },
      async loadBootstrap() { if (failure === "load") throw new Error("private module"); return {
        async initializeLocalInstallationPlanV1() { if (failure === "initialize") throw new Error("private journal"); return {}; },
      }; }, report: line => output.push(line), reportError: line => errors.push(line) });
    assert.equal(code, 1); assert.deepEqual(output, []); assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /secret|private journal|private module/u);
  }
});
