import assert from "node:assert/strict";
import test from "node:test";
import { parseMacLocalWebHostArguments, readPinnedMacExecutableVersion, startMacLocalTaskHost } from "../scripts/mac-local/start-web-host.mjs";

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

test("task host requires the fixed release provider and does not accept a caller callback", async () => {
  const loaded = [];
  let providerInput;
  const task = { async close() {}, isReady: () => true };
  const result = await startMacLocalTaskHost({ protectedRoot: "/protected" }, {
    readVersion: async () => "pinned",
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
          workspaceId: "workspace:fixture" }), loadMacLocalDatabaseRolesFromRootV1: async () => ({}),
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
      throw new Error(`unexpected ${path}`);
    },
  });
  assert.equal(result, task);
  assert.equal(providerInput.protectedRoot, "/protected");
  assert.deepEqual(loaded.sort(), ["index.js", "macLocalHost.js", "macLocalProtectedLoader.js", "macLocalProtectedLoader.js",
    "macLocalTaskProvider.js", "nativeQueueFactories.js", "privatePostgres.js", "privatePostgres.js", "serving.js"].sort());
});

test("a zero-project first start opens the website and does not load a task provider", async () => {
  const loaded = [];
  const site = { async close() {}, isReady: () => true };
  const result = await startMacLocalTaskHost({ protectedRoot: "/protected" }, { load: async path => {
    const name = path.split("/").at(-1); loaded.push(name);
    if (name === "macLocalProtectedLoader.js") return { loadMacLocalProtectedConfigurationFromRootV1: async () => ({
      localOwnerSession: { tenantId: "tenant:fixture" }, workspaceId: "workspace:fixture" }) };
    if (name === "privatePostgres.js") return { createPrivatePostgresDatabase: () => ({
      client: { query: async () => ({ rows: [] }) }, async close() {},
    }) };
    if (name === "macLocalHost.js") return { createMacLocalProtectedHostV1: () => ({ start: async () => site }) };
    if (name === "serving.js") return { loadPrivateClientAssets: async () => ({ respond() {} }) };
    if (name === "index.js") return { default() {} };
    throw new Error(`unexpected ${name}`);
  } });
  assert.equal(result, site);
  assert.equal(loaded.includes("macLocalTaskProvider.js"), false);
  assert.equal(loaded.includes("nativeQueueFactories.js"), false);
});
