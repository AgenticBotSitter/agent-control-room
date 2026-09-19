#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repo = process.cwd();
const board = await mkdtemp(path.join(os.tmpdir(), "acr-local-board-test-"));
const packetFile = path.join(board, "packet.json");
const resultFile = path.join(board, "result.json");

function command(args, expected = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["local-tools/local-workboard.mjs", ...args], {
      cwd: repo,
      env: { ...process.env, ACR_LOCAL_WORKBOARD: board },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== expected) reject(new Error(`expected ${expected}, received ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

try {
  const packet = {
    schema: "agent-control-room.local-job/v1",
    id: "concurrency-test-01",
    worker: "qwen",
    objective: "Prove one atomic claimant.",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    inputs: [],
    ownedPaths: [],
    acceptanceChecks: ["one claimant"],
    effects: "read-only",
    mode: "direct",
  };
  await writeFile(packetFile, `${JSON.stringify(packet)}\n`);
  await writeFile(resultFile, `${JSON.stringify({ observed: "one claimant" })}\n`);

  await command(["init"]);
  await command(["enqueue", "--packet", packetFile]);
  await command(["enqueue", "--packet", packetFile], 2);

  const claims = await Promise.all([
    command(["claim", "--worker", "qwen"]),
    command(["claim", "--worker", "qwen"]),
  ]);
  const parsedClaims = claims.map(result => JSON.parse(result.stdout));
  assert.equal(parsedClaims.filter(result => result.status === "claimed").length, 1);
  assert.equal(parsedClaims.filter(result => result.status === "empty").length, 1);

  await command([
    "finish",
    "--worker",
    "qwen",
    "--id",
    packet.id,
    "--result",
    resultFile,
    "--outcome",
    "completed",
  ]);
  const delivered = JSON.parse(
    await readFile(path.join(board, "outbox", "qwen", `${packet.id}.json`), "utf8"),
  );
  assert.equal(delivered.outcome, "completed");
  assert.equal(delivered.result.observed, "one claimant");

  await command(["ack", "--worker", "qwen", "--id", packet.id]);
  const status = JSON.parse((await command(["status"])).stdout);
  assert.equal(status.workers.qwen.inbox.count, 0);
  assert.equal(status.workers.qwen.working.count, 0);
  assert.equal(status.workers.qwen.outbox.count, 0);
  assert.equal(status.workers.qwen.failed.count, 0);
  assert.deepEqual(status.workers.qwen.stagedResults, []);

  console.log("local-workboard: 12 assertions passed");
} finally {
  await rm(board, { recursive: true, force: true });
}
