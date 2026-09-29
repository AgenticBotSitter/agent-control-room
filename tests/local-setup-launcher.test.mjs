import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseLocalSetupHostArguments, runLocalSetupHost } from "../scripts/run-local-setup-host.mjs";

const releaseRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const args = ["--release-root", releaseRoot, "--journal-root", "/private/setup-journal", "--installation-id", "local-setup-one", "--port", "3210"];

test("local setup host launcher requires exact absolute arguments", () => {
  assert.deepEqual(parseLocalSetupHostArguments(args), { releaseRoot, journalRoot: "/private/setup-journal", installationId: "local-setup-one", port: 3210 });
  assert.deepEqual(parseLocalSetupHostArguments(["--help"]), { help: true });
  assert.deepEqual(parseLocalSetupHostArguments(["--port", "3210", "--installation-id", "local-setup-one", "--journal-root", "/private/setup-journal", "--release-root", releaseRoot]),
    { releaseRoot, journalRoot: "/private/setup-journal", installationId: "local-setup-one", port: 3210 });
  for (const value of [[], ["--release-root", releaseRoot, "--journal-root", "relative", "--installation-id", "local-setup-one", "--port", "3210"],
    ["--release-root", "/wrong-release", "--journal-root", "/private/setup-journal", "--installation-id", "local-setup-one", "--port", "3210"],
    ["--release-root", releaseRoot, "--journal-root", "/private/setup-journal", "--installation-id", "LOCAL", "--port", "3210"],
    ["--release-root", releaseRoot, "--journal-root", "/private/setup-journal", "--installation-id", "local-setup-one", "--port", "03210"],
    ["--release-root", releaseRoot, "--journal-root", "/private/setup-journal", "--installation-id", "local-setup-one", "--port", "3211"]])
    assert.throws(() => parseLocalSetupHostArguments(value), /local_setup_host_arguments_invalid/);
});

test("local setup launcher emits one readiness record only after the injected service is ready", async () => {
  let resolveStart;
  const started = new Promise(resolve => { resolveStart = resolve; });
  let releaseLoads = 0, factoryInput, serviceStarts = 0, closes = 0;
  const output = [], errors = [];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const runtime = {
    signals: new EventEmitter(), ownerUid: () => 501, report: line => { output.push(line); finish(); },
    reportError: line => errors.push(line),
    async loadRelease() { releaseLoads += 1; return [{ createInstalledLocalSetupHostV1(input) {
      factoryInput = input;
      return { isReady: () => serviceStarts === 1, async start() { await started; serviceStarts += 1; }, async close() { closes += 1; } };
    } }, { async loadPrivateClientAssets(path) { assert.match(path, /dist-vps\/client$/u); return { count: 0, digest: "assets", respond: () => undefined }; } },
    { default: () => new Response("setup") }, { startPrivateHostLifecycle({ start }) {
      const ready = start(new AbortController().signal);
      return { ready, completed: finished.then(async () => { await ready; return { status: "closed" }; }) };
    } }]; },
  };
  const running = runLocalSetupHost(args, runtime);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(releaseLoads, 1);
  assert.equal(serviceStarts, 0);
  assert.deepEqual(output, []);
  resolveStart();
  assert.equal(await running, 0);
  assert.equal(serviceStarts, 1);
  assert.equal(closes, 0);
  assert.equal(factoryInput.journalRoot, "/private/setup-journal");
  assert.equal(factoryInput.installationId, "local-setup-one");
  assert.equal(factoryInput.ownerUid, 501);
  assert.equal(factoryInput.port, 3210);
  assert.equal(factoryInput.assets.count, 0);
  assert.equal(factoryInput.assets.digest, "assets");
  assert.equal(typeof factoryInput.assets.respond, "function");
  assert.equal(typeof factoryInput.render, "function");
  assert.equal(typeof factoryInput.closeApplication, "function");
  assert.equal(factoryInput.isApplicationReady(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(output, ["{\"schema\":\"control-room.local-setup-host-readiness/v1\",\"state\":\"ready\",\"origin\":\"http://127.0.0.1:3210\",\"path\":\"/setup\"}\n"]);
});

test("local setup launcher rejects failure without a false readiness record", async () => {
  const output = [], errors = [];
  const code = await runLocalSetupHost(args, {
    signals: new EventEmitter(), ownerUid: () => 501, report: line => output.push(line), reportError: line => errors.push(line),
    async loadRelease() { return [{ createInstalledLocalSetupHostV1() {
      return { isReady: () => false, async start() { throw new Error("private value"); }, async close() {} };
    } }, { async loadPrivateClientAssets() { return { count: 0, digest: "assets", respond: () => undefined }; } },
    { default: () => new Response("setup") }, { startPrivateHostLifecycle({ start }) {
      const ready = start(new AbortController().signal);
      return { ready, completed: Promise.resolve({ status: "closed" }) };
    } }]; },
  });
  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.deepEqual(errors, ["Control Room local setup host did not become ready; cleanup may require owner attention."]);
});
