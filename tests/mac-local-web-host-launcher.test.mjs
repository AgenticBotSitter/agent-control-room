import assert from "node:assert/strict";
import test from "node:test";
import { parseMacLocalWebHostArguments, readPinnedMacExecutableVersion, startMacLocalTaskHost,
  startHostWithOptionalIntake, startMacLocalWebHost, verifyPinnedMacModelPolicy } from "../scripts/mac-local/start-web-host.mjs";

test("Mac local web host launcher accepts only the owner-attended fixed protected root", () => {
  assert.deepEqual(parseMacLocalWebHostArguments(["--owner-attended", "--protected-root", "/Library/Application Support/Agent Control Room"]),
    { protectedRoot: "/Library/Application Support/Agent Control Room" });
  assert.deepEqual(parseMacLocalWebHostArguments(["--help"]), { help: true });
  for (const args of [[], ["--protected-root", "/tmp/x"], ["--owner-attended", "--protected-root", "relative"],
    ["--owner-attended", "--protected-root", "/tmp/x\n"]]) {
    assert.throws(() => parseMacLocalWebHostArguments(args), /mac_local_web_host_arguments_invalid/);
  }
});

test("Mac local web host reads a bounded exact executable version without shell expansion", async () => {
  const seen = [];
  const version = await readPinnedMacExecutableVersion("/usr/local/bin/example", { execFile: async (...args) => {
    seen.push(args); return { stdout: "example 1.2.3\n" };
  } });
  assert.equal(version, "example 1.2.3");
  assert.deepEqual(seen[0][0], "/usr/local/bin/example");
  assert.deepEqual(seen[0][1], ["--version"]);
  await assert.rejects(() => readPinnedMacExecutableVersion("/usr/local/bin/example", { execFile: async () => ({ stdout: "bad\nvalue" }) }),
    /mac_local_executable_version_unavailable/);
});

test("startup validates an explicit model allowlist against the pinned CLI surface", async () => {
  const worker = { kind: "codex", executablePath: "/usr/local/bin/codex", modelPolicy: {
    models: ["gpt-build"], defaultModel: "gpt-build", efforts: ["high"], defaultEffort: "high",
  } };
  const calls = [];
  assert.equal(await verifyPinnedMacModelPolicy(worker, { execFile: async (_path, args) => {
    calls.push(args); return { stdout: args[0] === "debug" ? "gpt-build\n" : "--model\n" };
  } }), true);
  assert.deepEqual(calls, [["debug", "models"], ["exec", "--help"]]);
  assert.equal(await verifyPinnedMacModelPolicy(worker, { execFile: async (_path, args) => ({
    stdout: args[0] === "debug" ? "different-model\n" : "--model\n",
  }) }), false);
});

test("web host validates and prepares optional intake before listeners and cleans a partial start", async () => {
  const calls = [];
  const ownerWebPush = Object.freeze({ subject: "mailto:owner@example.invalid", publicKey: "p".repeat(87),
    privateKey: "k".repeat(43) });
  const load = async path => {
    const name = path.split("/").at(-1);
    if (name === "macLocalProtectedLoader.js") return {
      async loadWorkIntakeServerConfigurationFromRootV1() { calls.push("load-intake"); return {
        port:3211,integrityKey:"y".repeat(43),database:{},credentials:[{workerId:"worker:test",workerKind:"codex"}]}; },
      async loadMacLocalProtectedConfigurationFromRootV1() { return {enablement:{workers:[{workerId:"worker:test",kind:"codex"}]}}; },
      async loadOwnerWebPushConfigFromRootV1() { calls.push("load-owner-web-push"); return ownerWebPush; },
    };
    if (name === "macLocalHost.js") return { createMacLocalProtectedHostV1(input) {
      assert.equal(input.workBatchIntegrityKey instanceof Uint8Array, true);
      assert.equal(input.workBatchIntegrityKey.length, 32);
      assert.equal(input.ownerWebPush, ownerWebPush);
      calls.push("prepare-web"); return {
      async start() { calls.push("start-web"); return { async close() { calls.push("close-web"); } }; },
    }; } };
    if (name === "workIntakePrivateService.js") return { async prepareWorkIntakePrivateServiceV1() {
      calls.push("prepare-intake"); return { async start() { calls.push("start-intake"); throw new Error("fixture"); },
        async close() { calls.push("close-intake"); } };
    } };
    if (name === "privatePostgres.js") return { createPrivatePostgresDatabase() {} };
    if (name === "serving.js") return { async loadPrivateClientAssets() { return {}; } };
    if (name === "index.js") return { default() {} };
    throw new Error(`unexpected ${name}`);
  };
  await assert.rejects(startMacLocalWebHost({ protectedRoot: "/protected" }, {
    load, loadHealthProbeKey: async () => Buffer.alloc(32, 7), hostReleaseIdentity: async () => "dev",
  }), /fixture/);
  assert.deepEqual(calls, ["load-intake", "load-owner-web-push", "prepare-web", "prepare-intake", "start-web", "start-intake",
    "close-intake", "close-web"]);
});

test("optional intake preserves the web host readiness signal", async () => {
  let ready = true, intakeStarts = 0, closes = 0;
  const result = await startHostWithOptionalIntake({ async start() { return {
    isReady: () => ready, async close() { closes += 1; },
  }; } }, { integrityKey: "y".repeat(43) }, { async prepareWorkIntakePrivateServiceV1() { return {
    async start() { intakeStarts += 1; }, async close() { closes += 1; },
  }; } });
  assert.equal(intakeStarts, 1); assert.equal(result.isReady(), true);
  ready = false;
  assert.equal(result.isReady(), false, "the task-host monitor must see database-backed web readiness through intake");
  await result.close(); assert.equal(closes, 2);
});

test("task host requires the fixed release provider and does not accept a caller callback", async () => {
  const loaded = [];
  let providerInput;
  const task = { async close() {}, isReady: () => true };
  const result = await startMacLocalTaskHost({ protectedRoot: "/protected" }, {
    readVersion: async () => "pinned",
    loadHealthProbeKey: async () => Buffer.alloc(32, 7), hostReleaseIdentity: async () => "dev",
    load: async path => {
      loaded.push(path.split("/").at(-1));
      if (path.endsWith("macLocalHost.js")) return { createMacLocalProtectedHostV1: input => ({
        async start() {
          if (!input.startQueueWorker) assert.fail("task callbacks missing");
          await input.createTaskApplication({ workerReadiness: {}, configuration: {}, database: {}, databaseRoles: {} });
          return task;
        },
      }) };
      if (path.endsWith("macLocalProtectedLoader.js")) return {
        loadMacLocalProtectedConfigurationFromRootV1: async () => ({ localOwnerSession: { tenantId: "tenant:fixture" },
          workspaceId: "workspace:fixture",enablement:{workers:[]} }), loadMacLocalDatabaseRolesFromRootV1: async () => ({}),
        loadWorkIntakeServerConfigurationFromRootV1: async()=>undefined,
        loadOwnerWebPushConfigFromRootV1: async()=>undefined,
      };
      if (path.endsWith("macLocalTaskProvider.js")) return { loadMacLocalTaskProviderFromRootV1: async () => ({
        workerKinds: ["hermes", "claude-code", "codex"], createTaskApplication: async input => { providerInput = input; return {}; },
      }), requireMacLocalThreeAgentReadinessV1() {} };
      if (path.endsWith("privatePostgres.js")) return { createPrivatePostgresDatabase: () => ({
        client: { query: async () => ({ rows: [{ id: "project:fixture" }] }) }, async close() {},
      }) };
      if (path.endsWith("nativeQueueFactories.js")) return { createInstalledNativeQueueFactories: () => ({ startNativeWorker: async () => ({}) }) };
      if (path.endsWith("serving.js")) return { loadPrivateClientAssets: async () => ({ respond() {} }) };
      if (path.endsWith("index.js")) return { default() {} };
      if(path.endsWith("workIntakePrivateService.js"))return{prepareWorkIntakePrivateServiceV1(){}};
      throw new Error(`unexpected ${path}`);
    },
  });
  assert.equal(result, task);
  assert.equal(providerInput.protectedRoot, "/protected");
  assert.deepEqual(loaded.sort(), ["index.js", "macLocalHost.js", "macLocalProtectedLoader.js",
    "macLocalTaskProvider.js", "nativeQueueFactories.js", "privatePostgres.js", "serving.js",
    "workIntakePrivateService.js"].sort());
});

test("a zero-project first start loads the live task provider without requiring a restart", async () => {
  const loaded = [];
  const site = { async close() {}, isReady: () => true };
  const result = await startMacLocalTaskHost({ protectedRoot: "/protected" }, { loadHealthProbeKey: async () => Buffer.alloc(32, 7),
    hostReleaseIdentity: async () => "dev", load: async path => {
    const name = path.split("/").at(-1); loaded.push(name);
    if (name === "macLocalProtectedLoader.js") return {
      loadMacLocalProtectedConfigurationFromRootV1: async () => ({enablement:{workers:[]}}),
      loadMacLocalDatabaseRolesFromRootV1: async () => ({}),loadWorkIntakeServerConfigurationFromRootV1:async()=>undefined,
      loadOwnerWebPushConfigFromRootV1:async()=>undefined,
    };
    if (name === "privatePostgres.js") return { createPrivatePostgresDatabase: () => ({}) };
    if (name === "macLocalHost.js") return { createMacLocalProtectedHostV1: input => ({ async start() {
      await input.createTaskApplication({ workerReadiness: {}, configuration: {}, database: {}, databaseRoles: {} });
      return site;
    } }) };
    if (name === "macLocalTaskProvider.js") return { loadMacLocalTaskProviderFromRootV1: async () => ({
      workerKinds: ["hermes", "claude-code", "codex"], createTaskApplication: async () => ({}),
    }), requireMacLocalThreeAgentReadinessV1() {} };
    if (name === "nativeQueueFactories.js") return { createInstalledNativeQueueFactories: () => ({ startNativeWorker: async () => ({}) }) };
    if (name === "serving.js") return { loadPrivateClientAssets: async () => ({ respond() {} }) };
    if (name === "index.js") return { default() {} };
    if(name==="workIntakePrivateService.js")return{prepareWorkIntakePrivateServiceV1(){}};
    throw new Error(`unexpected ${name}`);
  } });
  assert.equal(result, site);
  assert.equal(loaded.includes("macLocalTaskProvider.js"), true);
  assert.equal(loaded.includes("nativeQueueFactories.js"), true);
});
