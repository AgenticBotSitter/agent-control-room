#!/usr/bin/env node

import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const REPO = process.cwd();
const BOARD = path.resolve(process.env.ACR_LOCAL_WORKBOARD ?? ".local-workboard");
const INBOX = path.join(BOARD, "inbox", "qwen");
const LOG = path.join(BOARD, "logs", "qwen-watcher.jsonl");
const LOCK = path.join(BOARD, "locks", "qwen-watcher.lock");

async function acquireWatcherLock() {
  await mkdir(path.dirname(LOCK), { recursive: true });
  try {
    return await open(LOCK, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let prior;
    try {
      prior = JSON.parse(await readFile(LOCK, "utf8"));
    } catch {
      throw new Error("another Qwen watcher lock exists and cannot be verified safely");
    }
    if (!Number.isSafeInteger(prior?.pid) || prior.pid <= 0) {
      throw new Error("another Qwen watcher lock exists with an invalid owner record");
    }
    try {
      process.kill(prior.pid, 0);
      throw new Error(`Qwen watcher already running (PID ${prior.pid})`);
    } catch (probeError) {
      if (probeError?.code !== "ESRCH") throw probeError;
    }
    await unlink(LOCK);
    return acquireWatcherLock();
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function record(event, details = {}) {
  const entry = { at: new Date().toISOString(), event, ...details };
  await appendFile(LOG, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(entry));
}

async function inboxCount() {
  const result = await run(["local-tools/local-workboard.mjs", "status"]);
  if (result.code !== 0) throw new Error(result.stderr || "unable to read workboard status");
  return JSON.parse(result.stdout).workers.qwen.inbox.count;
}

let draining = false;
let drainAgain = false;

async function drain() {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      while ((await inboxCount()) > 0) {
        await record("job-started");
        const result = await run(["local-tools/qwen-workboard-once.mjs"]);
        await record(result.code === 0 ? "job-finished" : "job-failed", {
          exitCode: result.code,
          output: (result.stdout || result.stderr).trim().slice(0, 2_000),
        });
      }
    } while (drainAgain);
  } catch (error) {
    await record("watcher-error", { error: error?.message ?? String(error) });
  } finally {
    draining = false;
  }
}

await run(["local-tools/local-workboard.mjs", "init"]);
await mkdir(path.dirname(LOG), { recursive: true });
const lock = await acquireWatcherLock();
await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
await record("watcher-started", { pid: process.pid });

const watcher = watch(INBOX, () => void drain());
await drain();

async function stop(signal) {
  watcher.close();
  await record("watcher-stopped", { signal });
  await lock.close();
  await unlink(LOCK).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
