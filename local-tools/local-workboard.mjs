#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(process.env.ACR_LOCAL_WORKBOARD ?? ".local-workboard");
const WORKERS = new Set(["qwen", "claude"]);
const STATES = ["inbox", "working", "outbox", "failed", "archive"];
const SCHEMA = "agent-control-room.local-job/v1";

function fail(message) {
  console.error(`local-workboard: ${message}`);
  process.exit(2);
}

function safeId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{2,79}$/i.test(value);
}

async function ensureBoard() {
  await Promise.all(
    STATES.flatMap(state => [...WORKERS].map(worker => mkdir(path.join(ROOT, state, worker), { recursive: true }))),
  );
  await mkdir(path.join(ROOT, "material"), { recursive: true });
  await mkdir(path.join(ROOT, "logs"), { recursive: true });
}

async function readPacket(file) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (parsed.schema !== SCHEMA) fail(`packet schema must be ${SCHEMA}`);
  if (!safeId(parsed.id)) fail("packet id must be 3-80 safe filename characters");
  if (!WORKERS.has(parsed.worker)) fail("packet worker must be qwen or claude");
  if (typeof parsed.objective !== "string" || !parsed.objective.trim()) fail("packet objective is required");
  if (typeof parsed.baseCommit !== "string" || !/^[0-9a-f]{7,40}$/i.test(parsed.baseCommit)) {
    fail("packet baseCommit must be a Git commit hash");
  }
  if (!Array.isArray(parsed.inputs) || parsed.inputs.some(input => typeof input !== "string")) {
    fail("packet inputs must be an array of repository-relative file paths");
  }
  if (!Array.isArray(parsed.ownedPaths) || parsed.ownedPaths.some(input => typeof input !== "string")) {
    fail("packet ownedPaths must be an array");
  }
  if (!Array.isArray(parsed.acceptanceChecks) || parsed.acceptanceChecks.some(input => typeof input !== "string")) {
    fail("packet acceptanceChecks must be an array");
  }
  if (parsed.effects !== "read-only" && parsed.effects !== "repository-write") {
    fail("packet effects must be read-only or repository-write");
  }
  if (parsed.mode !== undefined && parsed.mode !== "direct" && parsed.mode !== "deliberate") {
    fail("packet mode must be direct or deliberate");
  }
  return parsed;
}

async function exists(file) {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function allLocations(worker, id) {
  return Promise.all(STATES.map(async state => ({ state, present: await exists(path.join(ROOT, state, worker, `${id}.json`)) })));
}

async function atomicJson(destination, value) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
}

async function enqueue(packetFile) {
  const packet = await readPacket(path.resolve(packetFile));
  const locations = await allLocations(packet.worker, packet.id);
  if (locations.some(location => location.present)) fail(`job ${packet.id} already exists on this board`);
  const destination = path.join(ROOT, "inbox", packet.worker, `${packet.id}.json`);
  await atomicJson(destination, { ...packet, queuedAt: new Date().toISOString() });
  return { status: "queued", worker: packet.worker, id: packet.id, path: destination };
}

async function claim(worker) {
  if (!WORKERS.has(worker)) fail("worker must be qwen or claude");
  const inbox = path.join(ROOT, "inbox", worker);
  const entries = (await readdir(inbox)).filter(name => name.endsWith(".json")).sort();
  for (const entry of entries) {
    const source = path.join(inbox, entry);
    const destination = path.join(ROOT, "working", worker, entry);
    try {
      await rename(source, destination);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    // Once the atomic rename succeeds, every later error is a claimed-job
    // failure and must remain visible instead of being mistaken for a race.
    const packet = await readPacket(destination);
    return { status: "claimed", worker, id: packet.id, path: destination, packet };
  }
  return { status: "empty", worker };
}

async function finish(worker, id, resultFile, outcome) {
  if (!WORKERS.has(worker) || !safeId(id)) fail("invalid worker or id");
  if (outcome !== "completed" && outcome !== "failed") fail("outcome must be completed or failed");
  const working = path.join(ROOT, "working", worker, `${id}.json`);
  const state = outcome === "completed" ? "outbox" : "failed";
  const staged = path.join(ROOT, "working", worker, `${id}.result.json`);
  const destination = path.join(ROOT, state, worker, `${id}.json`);

  if (await exists(working)) {
    const packet = await readPacket(working);
    if (!(await exists(staged))) {
      const rawResult = JSON.parse(await readFile(path.resolve(resultFile), "utf8"));
      const result = {
        schema: "agent-control-room.local-result/v1",
        id,
        worker,
        outcome,
        baseCommit: packet.baseCommit,
        completedAt: new Date().toISOString(),
        result: rawResult,
      };
      await atomicJson(staged, result);
    }
    // A result becomes visible to the reviewer only after its claimed packet is
    // durably archived. A crash before then leaves both artifacts in working.
    await rename(working, path.join(ROOT, "archive", worker, `${id}.json`));
  }

  if (!(await exists(staged))) {
    if (await exists(destination)) return { status: outcome, worker, id, replayed: true };
    fail(`no claimed packet or staged result exists for ${id}`);
  }
  await rename(staged, destination);
  return { status: outcome, worker, id };
}

async function acknowledge(worker, id) {
  if (!WORKERS.has(worker) || !safeId(id)) fail("invalid worker or id");
  const completed = path.join(ROOT, "outbox", worker, `${id}.json`);
  const failed = path.join(ROOT, "failed", worker, `${id}.json`);
  const source = (await exists(completed)) ? completed : failed;
  if (!(await exists(source))) fail(`no completed or failed result exists for ${id}`);
  const destination = path.join(ROOT, "archive", worker, `${id}.result.json`);
  await rename(source, destination);
  return { status: "acknowledged", worker, id };
}

async function cancel(worker, id, reason) {
  if (!WORKERS.has(worker) || !safeId(id)) fail("invalid worker or id");
  if (typeof reason !== "string" || !reason.trim()) fail("--reason is required");
  const source = path.join(ROOT, "inbox", worker, `${id}.json`);
  const destination = path.join(ROOT, "archive", worker, `${id}.json`);
  const packet = await readPacket(source);
  await rename(source, destination);
  await atomicJson(destination, {
    schema: "agent-control-room.local-cancellation/v1",
    id,
    worker,
    cancelledAt: new Date().toISOString(),
    reason: reason.trim(),
    packet,
  });
  return { status: "cancelled", worker, id };
}

async function statusBoard() {
  const summary = {};
  for (const worker of WORKERS) {
    summary[worker] = {};
    for (const state of STATES) {
      const files = (await readdir(path.join(ROOT, state, worker))).filter(name => name.endsWith(".json"));
      const jobs = files.filter(name => !name.endsWith(".result.json"));
      summary[worker][state] = { count: jobs.length, ids: jobs.map(name => name.slice(0, -5)) };
      if (state === "working") {
        summary[worker].stagedResults = files
          .filter(name => name.endsWith(".result.json"))
          .map(name => name.slice(0, -".result.json".length));
      }
    }
  }
  return { schema: "agent-control-room.local-board-status/v1", root: ROOT, workers: summary };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

await ensureBoard();
const command = process.argv[2];
let result;
if (command === "init") result = await statusBoard();
else if (command === "enqueue") result = await enqueue(option("--packet") ?? fail("--packet is required"));
else if (command === "claim") result = await claim(option("--worker") ?? fail("--worker is required"));
else if (command === "finish") {
  result = await finish(
    option("--worker") ?? fail("--worker is required"),
    option("--id") ?? fail("--id is required"),
    option("--result") ?? fail("--result is required"),
    option("--outcome") ?? fail("--outcome is required"),
  );
} else if (command === "ack") {
  result = await acknowledge(option("--worker") ?? fail("--worker is required"), option("--id") ?? fail("--id is required"));
} else if (command === "cancel") {
  result = await cancel(
    option("--worker") ?? fail("--worker is required"),
    option("--id") ?? fail("--id is required"),
    option("--reason") ?? fail("--reason is required"),
  );
} else if (command === "status") result = await statusBoard();
else fail("command must be init, enqueue, claim, finish, ack, cancel, or status");

console.log(JSON.stringify(result, null, 2));
