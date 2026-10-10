import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLocalToolAdapterRunner } from "../../scripts/fleet/connector.mjs";

// The drain observer follows only the adapter's asynchronous execution. Test
// observation, readiness and filesystem cleanup latency do not advance its clock.
const timerScope = new AsyncLocalStorage();
export const inToolTimerScope = () => timerScope.getStore() === true;
export const withToolTimerScope = run => timerScope.run(true, run);

export async function preserveToolFailure(body, cleanup) {
  let value, primaryError;
  try { value = await body(); } catch (error) { primaryError = error; }
  try { await cleanup(); } catch (error) { if (!primaryError) throw error; }
  if (primaryError) throw primaryError;
  return value;
}

// A dead, unreaped owned leader can produce EPERM on Darwin. Reap it first;
// only observed disappearance is success. An unknown/live refusal stays red.
export async function retireToolProcess({ child, closed }, {
  kill = process.kill.bind(process), wait = signal => signal,
} = {}) {
  const group = process.platform === "win32" ? child.pid : -child.pid;
  try { if (group) kill(group, "SIGKILL"); }
  catch (error) {
    if (error?.code === "EPERM" && (typeof child.exitCode === "number" || typeof child.signalCode === "string")) {
      await wait(closed, "a dead owned leader must be reaped within the cleanup bound");
      try { kill(group, 0); } catch (gone) { if (gone?.code === "ESRCH") return; throw gone; }
    }
    if (error?.code !== "ESRCH") throw error;
  }
  await wait(closed, "an owned child must close within the cleanup bound");
  let observing = true;
  try {
    if (group) await wait((async () => {
      while (observing) {
        try { kill(group, 0); }
        catch (error) { if (error?.code === "ESRCH") return; throw error; }
        await new Promise(done => setImmediate(done));
      }
    })(), "an owned process group must disappear after close");
  } finally { observing = false; }
}

// Only fixture initialization and deliberate preparation happen before
// admission. The sole later message is the product's real staged launch data.
export async function preparedToolRunner(t, registry, {
  count = 1, prepare = async () => {}, onPhase = () => {}, onLaunch = () => {},
  startProcess = spawn, track, wait, retire, ...options
} = {}) {
  const adapter = [...registry.adapters.values()][0];
  const script = adapter.arguments[0];
  const wrapper = join(dirname(script), `prepared-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(wrapper, `
const parentGone = () => process.exit(0);
process.once("disconnect", parentGone);
const launchData = await new Promise(done => {
  process.on("message", function receive(message) {
    if (message === "probe") { process.send("probed"); return; }
    if (message === "disconnect") { process.disconnect(); return; }
    if (message === "release") { process.send("released"); return; }
    process.off("message", receive); done(message);
  });
  process.send("initialized");
});
process.argv = [process.execPath, ...launchData.argv];
process.chdir(launchData.cwd);
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, launchData.env);
process.off("disconnect", parentGone);
process.disconnect();
` + await readFile(script, "utf8"), { mode: 0o700 });
  const records = [];
  try {
    // Preparation is bounded by caller observers, never by the product timer.
    for (let index = 0; index < count; index += 1) {
      const child = startProcess(adapter.executable, [wrapper], { env: {}, shell: false,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const record = { child, closed: track(t, child) }; records.push(record);
      let failure;
      child.on("error", error => { failure = error; });
      const received = new Set();
      const messages = new Map();
      child.on("message", message => {
        received.add(message); messages.get(message)?.(); onPhase(message, child);
      });
      const acknowledgement = async name => {
        const signal = received.has(name) ? Promise.resolve() : new Promise(done => messages.set(name, done));
        const failed = new Promise((_, reject) => {
          const onError = error => reject(error);
          const onExit = () => reject(new assert.AssertionError({ message: "a prepared tool must stay alive before launch" }));
          child.once("error", onError); child.once("exit", onExit);
          signal.finally(() => { child.off("error", onError); child.off("exit", onExit); });
        });
        if (failure) throw failure;
        await wait(Promise.race([signal, failed]), `the real tool must acknowledge ${name} within the setup bound`);
        assert.ok(child.exitCode === null && child.signalCode === null, "a prepared tool must stay alive before launch");
      };
      await acknowledgement("initialized");
      child.send("probe"); await acknowledgement("probed");
      await prepare(child, index);
      child.send("release"); await acknowledgement("released");
    }
  } catch (error) {
    await preserveToolFailure(async () => { throw error; }, () => retire(t));
  }
  const ready = [...records];
  return createLocalToolAdapterRunner(registry, { ...options, spawner: (executable, argv, launchOptions) => {
    const { child } = ready.shift();
    assert.ok(child.connected && child.exitCode === null && child.signalCode === null,
      "a prepared launch requires a live connected child");
    onLaunch(executable, argv, launchOptions, child);
    child.send({ executable, argv, cwd: launchOptions.cwd, env: launchOptions.env, shell: launchOptions.shell }, error => {
      if (error) child.emit("error", error);
    });
    return child;
  } });
}
