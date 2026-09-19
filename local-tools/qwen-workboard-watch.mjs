#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const REPO = process.cwd();
const BOARD = path.resolve(process.env.ACR_LOCAL_WORKBOARD ?? ".local-workboard");
const INBOX = path.join(BOARD, "inbox", "qwen");
const LOG = path.join(BOARD, "logs", "qwen-watcher.jsonl");

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
await record("watcher-started", { pid: process.pid });

const watcher = watch(INBOX, () => void drain());
await drain();

async function stop(signal) {
  watcher.close();
  await record("watcher-stopped", { signal });
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
