#!/usr/bin/env node

import { appendFile, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const REPO = await realpath(process.cwd());
const BOARD = path.resolve(process.env.ACR_LOCAL_WORKBOARD ?? ".local-workboard");
const MAX_MATERIAL_BYTES = 128 * 1024;
const METRICS = path.join(BOARD, "metrics", "qwen-events.jsonl");

async function recordMetrics(packet, startedAt, output) {
  const parsed = JSON.parse(output);
  if (parsed?.schema !== "agent-control-room.qwen-worker-result/v1") {
    throw new Error("Qwen worker returned an unexpected metrics envelope");
  }
  await mkdir(path.dirname(METRICS), { recursive: true });
  const record = {
    schema: "agent-control-room.local-model-event/v1",
    worker: "qwen",
    model: parsed.model,
    role: "first-pass-review-or-analysis",
    jobId: packet.id,
    mode: parsed.mode,
    startedAt,
    completedAt: new Date().toISOString(),
    wallMs: parsed.metrics?.wallMs ?? null,
    inputTokens: parsed.metrics?.promptTokens ?? null,
    outputTokens: parsed.metrics?.outputTokens ?? null,
    outputTokensPerSecond: parsed.metrics?.passes?.at(-1)?.outputTokensPerSecond ?? null,
  };
  await appendFile(METRICS, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function runNode(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `child exited ${code}`))));
    child.stdin.end(input);
  });
}

function allowedInput(relative) {
  if (!relative || path.isAbsolute(relative)) return false;
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return false;
  if (/^(\.git|\.env|\.codex|\.claude)(\/|$)/.test(normalized)) return false;
  if (/(^|\/)(id_[a-z0-9_-]+|[^/]*\.(pem|key|p12|pfx))$/i.test(normalized)) return false;
  return true;
}

async function materialFor(packet) {
  const sections = [];
  let total = 0;
  for (const relative of packet.inputs) {
    if (!allowedInput(relative)) throw new Error(`input path is not allowed: ${relative}`);
    const requested = path.resolve(REPO, relative);
    const actual = await realpath(requested);
    if (actual !== REPO && !actual.startsWith(`${REPO}${path.sep}`)) throw new Error(`input escapes repository: ${relative}`);
    const details = await stat(actual);
    if (!details.isFile()) throw new Error(`input is not a regular file: ${relative}`);
    total += details.size;
    if (total > MAX_MATERIAL_BYTES) throw new Error(`combined input exceeds ${MAX_MATERIAL_BYTES} bytes`);
    sections.push(`--- ${relative} ---\n${await readFile(actual, "utf8")}`);
  }
  return sections.join("\n\n");
}

const claim = JSON.parse(await runNode(["local-tools/local-workboard.mjs", "claim", "--worker", "qwen"]));
if (claim.status === "empty") {
  console.log(JSON.stringify(claim));
  process.exit(0);
}

const packet = claim.packet;
const temporaryResult = path.join(BOARD, "logs", `${packet.id}.${process.pid}.result.json`);
try {
  const material = await materialFor(packet);
  const startedAt = new Date().toISOString();
  const output = await runNode(
    [
      "local-tools/qwen-worker.mjs",
      "--task",
      [
        packet.objective,
        `Base commit: ${packet.baseCommit}`,
        `Owned paths: ${packet.ownedPaths.join(", ") || "read-only"}`,
        `Acceptance checks: ${packet.acceptanceChecks.join("; ") || "review only"}`,
        "State observed facts separately from inferences. Cite exact input files for every finding.",
      ].join("\n"),
      "--mode",
      packet.mode ?? "direct",
      "--num-predict",
      String(packet.numPredict ?? 4096),
      "--timeout-minutes",
      String(packet.timeoutMinutes ?? 15),
    ],
    material,
  );
  await recordMetrics(packet, startedAt, output).catch(error => {
    console.error(`qwen-workboard: unable to record metrics: ${error?.message ?? String(error)}`);
  });
  await writeFile(temporaryResult, output, { flag: "wx", mode: 0o600 });
  const finished = await runNode([
    "local-tools/local-workboard.mjs",
    "finish",
    "--worker",
    "qwen",
    "--id",
    packet.id,
    "--result",
    temporaryResult,
    "--outcome",
    "completed",
  ]);
  await unlink(temporaryResult);
  console.log(finished.trim());
} catch (error) {
  const failure = { error: error?.message ?? String(error) };
  await writeFile(temporaryResult, `${JSON.stringify(failure, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const finished = await runNode([
    "local-tools/local-workboard.mjs",
    "finish",
    "--worker",
    "qwen",
    "--id",
    packet.id,
    "--result",
    temporaryResult,
    "--outcome",
    "failed",
  ]);
  await unlink(temporaryResult);
  console.error(finished.trim());
  process.exitCode = 1;
}
