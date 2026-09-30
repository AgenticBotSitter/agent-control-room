#!/usr/bin/env node
// macOS/APFS stress probe for the production connector lock. It keeps 50
// logical workers contending until each has completed the requested number of
// acquisitions, replacing only children deliberately killed in the critical
// section. No agent CLI or network service is used.
import { spawn } from "node:child_process";
import { open, mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workers = Number(process.argv[2] ?? 50);
const acquisitions = Number(process.argv[3] ?? 40);
const killRate = Number(process.argv[4] ?? 0.10);
if (!Number.isSafeInteger(workers) || workers < 1 || !Number.isSafeInteger(acquisitions) || acquisitions < 40
  || !Number.isFinite(killRate) || killRate < 0.05 || killRate > 0.15)
  throw new Error("usage: stress-connector-lock.mjs [workers] [acquisitions>=40] [kill-rate 0.05..0.15]");

const root = await mkdtemp(join(tmpdir(), "control-room-lock-stress-"));
const lockPath = join(root, "credential.rotate.lock"), criticalPath = join(root, "critical-holder.json");
const moduleUrl = pathToFileURL(resolve("scripts/fleet/connector.mjs")).href;
const childSource = String.raw`
  import { open, readFile, unlink } from "node:fs/promises";
  const { acquireRotationLock } = await import(process.argv[1]);
  const lockPath = process.argv[2], markerPath = process.argv[3], loops = Number(process.argv[4]);
  const killRate = Number(process.argv[5]);
  let completed = 0, killed = false;
  try {
    while (completed < loops) {
      const release = await acquireRotationLock(lockPath, { deadlineMs: 120000 });
      let marker;
      try {
        try { marker = await open(markerPath, "wx", 0o600); }
        catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const prior = JSON.parse(await readFile(markerPath, "utf8"));
          let alive = true;
          try { process.kill(prior.pid, 0); } catch (probeError) { alive = probeError?.code !== "ESRCH"; }
          if (alive) throw new Error("MUTUAL_EXCLUSION_VIOLATION:" + prior.pid + ":" + process.pid);
          await unlink(markerPath);
          marker = await open(markerPath, "wx", 0o600);
        }
        await marker.writeFile(JSON.stringify({ pid: process.pid }) + "\n");
        await marker.sync();
        await marker.close(); marker = undefined;
        if (Math.random() < killRate) {
          killed = true;
          await new Promise(done => process.send?.({ type: "killed", completed }, done));
          process.kill(process.pid, "SIGKILL");
          await new Promise(() => {});
        }
        await new Promise(done => setTimeout(done, 1 + Math.floor(Math.random() * 5)));
        await unlink(markerPath);
        completed += 1;
      } finally {
        try { await marker?.close(); } catch {}
        if (!killed) await release();
      }
    }
    process.send?.({ type: "done", completed });
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error));
    process.exitCode = 1;
  }
`;

let kills = 0, violations = 0, completed = 0;
const failures = [];
const runSlot = async slot => {
  let remaining = acquisitions;
  while (remaining > 0) {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, moduleUrl,
      lockPath, criticalPath, String(remaining), String(killRate)], {
      cwd: resolve("."), env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "", reported = 0, deliberatelyKilled = false;
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("message", message => {
      if (message?.type === "killed") { deliberatelyKilled = true; reported = message.completed; kills += 1; }
      if (message?.type === "done") reported = message.completed;
    });
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); });
    remaining -= reported;
    completed += reported;
    if (deliberatelyKilled) continue;
    if (code !== 0) {
      if (stderr.includes("MUTUAL_EXCLUSION_VIOLATION")) violations += 1;
      failures.push({ slot, code, stderr: stderr.slice(0, 500) });
      return;
    }
  }
};

try {
  await Promise.race([
    Promise.all(Array.from({ length: workers }, (_, slot) => runSlot(slot))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stress probe wedged for 240 seconds")), 240_000)),
  ]);
  let markerLeft = false;
  try {
    const holder = JSON.parse(await readFile(criticalPath, "utf8"));
    try { process.kill(holder.pid, 0); markerLeft = true; }
    catch (error) { if (error?.code !== "ESRCH") markerLeft = true; }
    if (!markerLeft) await unlink(criticalPath);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const leftovers = (await readdir(root)).filter(name => !name.includes(".reap-"));
  const summary = { workers, acquisitionsPerWorker: acquisitions, completed, kills, violations,
    failures: failures.length, markerLeft, leftovers };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (completed !== workers * acquisitions || failures.length || violations || markerLeft || leftovers.length)
    process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
