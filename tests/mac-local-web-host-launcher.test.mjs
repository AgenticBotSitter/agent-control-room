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
  const task = { async close() {}, isReady: () => true };
  const result = await startMacLocalTaskHost({ protectedRoot: "/protected" }, {
    readVersion: async () => "pinned",
    load: async path => {
      loaded.push(path.split("/").at(-1));
      if (path.endsWith("macLocalHost.js")) return { createMacLocalProtectedHostV1: input => ({
        async start() { return input.createTaskApplication && input.startQueueWorker ? task : assert.fail("task callbacks missing"); },
      }) };
      if (path.endsWith("macLocalProtectedLoader.js")) return {
        loadMacLocalProtectedConfigurationFromRootV1: async () => ({}), loadMacLocalDatabaseRolesFromRootV1: async () => ({}),
      };
      if (path.endsWith("macLocalTaskProvider.js")) return { loadMacLocalTaskProviderFromRootV1: async () => ({
        createTaskApplication: async () => ({}), startQueueWorker: async () => ({}),
      }) };
      if (path.endsWith("privatePostgres.js")) return { createPrivatePostgresDatabase: () => ({}) };
      if (path.endsWith("serving.js")) return { loadPrivateClientAssets: async () => ({ respond() {} }) };
      if (path.endsWith("index.js")) return { default() {} };
      throw new Error(`unexpected ${path}`);
    },
  });
  assert.equal(result, task);
  assert.deepEqual(loaded.sort(), ["index.js", "macLocalHost.js", "macLocalProtectedLoader.js", "macLocalTaskProvider.js", "privatePostgres.js", "serving.js"].sort());
});
