import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLocalToolAdapterRunner } from "../../scripts/fleet/connector.mjs";

// Setup bounds diagnose a missing observation; they never release a gate.
export async function waitForToolState(observe, message) {
  const deadline = performance.now() + 10_000;
  while (!await observe()) {
    assert.ok(performance.now() < deadline, message);
    await new Promise(done => setImmediate(done));
  }
}

export async function waitForProcessGone(pid, message) {
  await waitForToolState(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error?.code !== "ESRCH") throw error; return true; }
  }, message);
  assert.throws(() => process.kill(pid, 0), /ESRCH/u, message);
}

// Synthetic launch seam, real execution: initialize each fixture module before
// admission. Then use the product's staged argv, cwd and environment verbatim.
// IPC is an attached gate, not readiness created by setup or an elapsed delay.
export async function preparedToolRunner(t, registry, { count = 1, hold = false, onHandoff = () => {}, startProcess = spawn, ...options } = {}) {
  const adapter = [...registry.adapters.values()][0];
  const script = adapter.arguments[0];
  const wrapper = join(dirname(script), `prepared-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(wrapper, `
const toolParentGone = () => process.exit(0);
process.once("disconnect", toolParentGone);
const toolHandoff = new Promise(done => {
  const toolMessage = message => {
    if (message === "probe") { process.send("gated"); return; }
    process.off("message", toolMessage); done(message);
  };
  process.on("message", toolMessage);
});
process.send("initialized");
const toolLaunch = await toolHandoff;
process.argv = [process.execPath, ...toolLaunch.argv];
process.chdir(toolLaunch.cwd);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, toolLaunch.env);
process.off("disconnect", toolParentGone);
process.disconnect();
` + await readFile(script, "utf8"), { mode: 0o700 });
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async ({ child, closed }) => {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
      catch (error) { if (error?.code !== "ESRCH") throw error; }
      await closed;
    }));
  });
  await Promise.all(Array.from({ length: count }, async () => {
    const child = startProcess(adapter.executable, [wrapper], { env: {}, shell: false,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let initialized = false, failure;
    child.on("error", error => { failure = error; });
    child.on("message", message => { if (message === "initialized") initialized = true; });
    const closed = new Promise(done => child.once("close", done));
    const record = { child, closed }; children.push(record);
    await waitForToolState(() => {
      if (failure) throw failure;
      assert.equal(child.exitCode, null, "a prepared tool must remain alive before handoff");
      return initialized;
    }, "the real tool module must initialize within the original setup bound");
  }));
  const ready = [...children];
  return createLocalToolAdapterRunner(registry, { ...options, spawner: (_executable, argv, launchOptions) => {
    const record = ready.shift();
    const child = record.child;
    let released = false;
    child.release = () => {
      if (released || !child.connected || child.exitCode !== null || child.signalCode !== null) return;
      released = true;
      child.send({ argv, cwd: launchOptions.cwd, env: launchOptions.env }, error => {
        if (error && error.code !== "ERR_IPC_CHANNEL_CLOSED" && error.code !== "EPIPE") throw error;
      });
    };
    onHandoff(child, argv, launchOptions);
    if (!hold) child.release();
    return child;
  } });
}
