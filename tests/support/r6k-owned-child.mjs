// Every crash fixture gets an owned process group, a hard deadline and awaited cleanup.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
/**
 * @template T
 * @param {string[]} args
 * @param {(context: { child: import("node:child_process").ChildProcess, closed: Promise<{code: number | null, signal: NodeJS.Signals | null}>, output: () => string, errors: () => string, kill: () => void }) => Promise<T>} work
 * @param {{timeoutMs?: number, env?: Record<string, string>}} [options]
 */
export async function ownedChild(args, work, { timeoutMs = 45_000, env = {} } = {}) {
  const child = spawn(process.execPath, args, { detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", ...env } });
  if (child.pid && process.env.R6K_GROUP_LEDGER) appendFileSync(process.env.R6K_GROUP_LEDGER, `start ${child.pid}\n`);
  let output = "", errors = "";
  child.stdout.on("data", value => { output += value; });
  child.stderr.on("data", value => { errors += value; });
  /** @type {Promise<{code: number | null, signal: NodeJS.Signals | null}>} */
  const closed = new Promise((done, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
  });
  const kill = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  try {
    const value = await work({ child, closed, output: () => output, errors: () => errors, kill });
    assert.equal(timedOut, false, "owned child exceeded its hard deadline");
    return value;
  }
  finally {
    clearTimeout(timer); kill(); await closed;
    if (child.pid && process.platform !== "win32") {
      let absent = false;
      for (let i = 0; i < 100; i++) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if (error.code === "ESRCH") { absent = true; break; } throw error; }
        await new Promise(done => setTimeout(done, 10));
      }
      assert.ok(absent, "owned child process group retired");
      if (process.env.R6K_GROUP_LEDGER) appendFileSync(process.env.R6K_GROUP_LEDGER, `closed ${child.pid}\n`);
    }
  }
}
export async function runChild(args) {
  return ownedChild(args, async ({ closed, output, errors }) => {
    const exit = await closed;
    assert.equal(exit.code, 0, errors());
    return JSON.parse(output());
  });
}
export async function killAtBoundary(args) {
  return ownedChild(args, async ({ closed, output, errors }) => {
    const exit = await closed;
    assert.equal(exit.signal, "SIGKILL", `${args.slice(3).join(" ")}: ${errors()}`);
    assert.equal(typeof JSON.parse(output()).cut, "string", "the actual boundary emitted its kill witness");
  });
}

/** @param {Array<() => Promise<void>>} cases */
export async function runCrashCases(cases) {
  let next = 0;
  const failures = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < cases.length) {
      const run = cases[next++];
      try { await run(); } catch (error) { failures.push(error); }
    }
  }));
  assert.equal(failures.length, 0, failures.map(error => String(error?.stack ?? error)).join("\n"));
}
