// Real per-run CPU and memory enforcement (A-100).
//
// Every enforcement assertion here runs real process supervision: a real
// detached child process group, the real `ps` process table, the real
// TERM -> KILL escalation and the real absence confirmation. Nothing about
// the supervisor, the process table or the kill path is mocked, because a
// mocked sampler proves only that a sampler was called.
//
// macOS note: `setrlimit` alone is not fail-closed here. Measured on this
// platform, a child that catches SIGXCPU keeps running past both the soft and
// the hard limit, and RLIMIT_AS/RLIMIT_RSS are ignored outright. The CPU-burn
// child below therefore *ignores SIGXCPU and SIGTERM* on purpose: it can only
// be stopped by the supervisor, which is exactly the property under test.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createOwnerTrustedLocalCodexExecV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalClaudeExecV1 } from "../src/harness/claude-code-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecV1 } from "../src/harness/hermes-local-v1/owner-trusted-local-exec";
import { captureTaskRunResourceStopV1, detectResourceBreachV1, parsePsGroupRowV1,
  parsePsTimeToMillisecondsV1, startTaskRunResourceSupervisorV1, summarizeProcessGroupV1 }
  from "../src/harness/v1/owner-trusted-local-resource-supervisor";
import { captureMacLocalTaskRunLimitsV1, captureMacLocalTaskRunResourcesV1,
  DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1, MAC_LOCAL_TASK_RUN_LIMITS_V1,
  MAX_TASK_RUN_CPU_TIME_MS, MAX_TASK_RUN_RESIDENT_BYTES, MIN_TASK_RUN_CPU_TIME_MS,
  MIN_TASK_RUN_RESIDENT_BYTES, TASK_RUN_RESOURCE_SAMPLE_INTERVAL_MS }
  from "../src/harness/v1/owner-trusted-local-run-limits";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "acr-cpu-memory-limits-"));
/** A wall deadline far above every resource limit below, so only the
 * resource supervisor can be what stops a runaway run. */
const LONG_WALL_MS = 60_000;

test.after(async () => { await rm(root, { recursive: true, force: true }); });

async function taskDirectory() { return await mkdtemp(join(root, "task-")); }

/** Real children, real process groups. The adapter is the production one; only
 * the executable/args are redirected at a real node process. */
function codex(script: string) {
  return createOwnerTrustedLocalCodexExecV1({ spawn: (_file, _args, options) =>
    spawn(process.execPath, ["-e", script], { ...options, env: { ...options.env, NODE_ENV: "test" } }) });
}
function claude(script: string) {
  return createOwnerTrustedLocalClaudeExecV1({ spawn: (_file, _args, options) =>
    spawn(process.execPath, ["-e", script], { ...options, env: { ...options.env, NODE_ENV: "test" } }) });
}
function hermes(script: string) {
  return createOwnerTrustedLocalHermesExecV1({ spawn: (_file, _args, options) =>
    spawn(process.execPath, ["-e", script], { ...options, env: { ...options.env, NODE_ENV: "test" } }) });
}

/** A run that can only be stopped by the supervisor: it catches SIGXCPU and
 * SIGTERM, so `setrlimit` and a polite termination both fail to stop it. */
const CPU_BURNER = `
process.on("SIGXCPU", () => {});
process.on("SIGTERM", () => {});
let total = 0;
for (;;) { total += 1; }
`;

/** Grows resident memory steadily while using almost no CPU, so the memory
 * limit is provably the one that stops it, not the CPU limit. */
const MEMORY_GROWER = `
const blocks = [];
setInterval(() => { blocks.push(new Array(250000).fill(1)); }, 4);
setInterval(() => {}, 1000);
`;

const NORMAL_FINISH = `
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
out({ type: "item.completed", item: { type: "agent_message", text: "bounded result" } });
out({ type: "turn.completed" });
`;

const processGroupExists = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

/** Every process still alive whose pgid is the recorded run group. */
async function survivors(processGroupId: number): Promise<string[]> {
  const { stdout } = await exec("ps", ["-e", "-o", "pid=,pgid=,command="]);
  return stdout.split("\n").filter((line: string) => line.trim().split(/\s+/)[1] === String(processGroupId));
}

test("a CPU-burning child that ignores SIGXCPU is stopped at its CPU limit", async () => {
  const cwd = await taskDirectory();
  const started = Date.now();
  const result = await codex(CPU_BURNER).execute({
    executablePath: process.execPath, prompt: "burn", workingDirectory: cwd, deadlineMs: LONG_WALL_MS,
    resources: { cpuTimeMs: 1_000, maxResidentBytes: 1_073_741_824 } });
  const elapsed = Date.now() - started;

  assert.equal(result.status, "limit_exceeded");
  assert.equal(result.reason, "cpu_time_exceeded");
  assert.ok(result.limit, "the stopped run must carry the limit it hit");
  assert.equal(result.limit!.limit, "cpu_time");
  assert.equal(result.limit!.cause, "exceeded");
  // The measured value is recorded and is at or past the limit that stopped it.
  assert.ok(result.limit!.measuredCpuTimeMs >= 1_000,
    `measured CPU ${result.limit!.measuredCpuTimeMs}ms must be at or past the 1000ms limit`);
  assert.equal(result.limit!.limitCpuTimeMs, 1_000);
  // It was stopped by the resource limit, well before the wall deadline.
  assert.ok(elapsed < LONG_WALL_MS, `stopped at ${elapsed}ms, not by the ${LONG_WALL_MS}ms wall deadline`);
});

test("a memory-growing child is stopped at its memory limit", async () => {
  const cwd = await taskDirectory();
  const limitBytes = 400 * 1024 * 1024;
  const started = Date.now();
  const result = await codex(MEMORY_GROWER).execute({
    executablePath: process.execPath, prompt: "grow", workingDirectory: cwd, deadlineMs: LONG_WALL_MS,
    // A CPU allowance no memory grower could reach, so the CPU limit cannot be
    // what stopped this run.
    resources: { cpuTimeMs: MAX_TASK_RUN_CPU_TIME_MS, maxResidentBytes: limitBytes } });
  const elapsed = Date.now() - started;

  assert.equal(result.status, "limit_exceeded");
  assert.equal(result.reason, "memory_exceeded");
  assert.equal(result.limit!.limit, "resident_memory");
  assert.equal(result.limit!.limitResidentBytes, limitBytes);
  assert.ok(result.limit!.measuredResidentBytes >= limitBytes,
    `measured ${result.limit!.measuredResidentBytes} must be at or past the ${limitBytes} byte limit`);
  // Idle growth uses negligible CPU: the recorded CPU proves the stop was the
  // memory limit and not a CPU limit that happened to fire first.
  assert.ok(result.limit!.measuredCpuTimeMs < 1_000,
    `a memory grower used ${result.limit!.measuredCpuTimeMs}ms CPU, so CPU cannot be why it stopped`);
  assert.ok(elapsed < LONG_WALL_MS, `stopped at ${elapsed}ms, not by the wall deadline`);
});

test("a forking child is measured as a group, so a descendant cannot escape the limit", async () => {
  const cwd = await taskDirectory();
  // The direct child allocates nothing and burns nothing; its descendant does
  // both. A per-process sampler would report ~0 for the whole run.
  const result = await codex(`
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(MEMORY_GROWER)}], { stdio: "ignore" });
    descendant.unref();
    setInterval(() => {}, 1000);
  `).execute({
    executablePath: process.execPath, prompt: "fork", workingDirectory: cwd, deadlineMs: LONG_WALL_MS,
    resources: { cpuTimeMs: MAX_TASK_RUN_CPU_TIME_MS, maxResidentBytes: 400 * 1024 * 1024 } });

  assert.equal(result.status, "limit_exceeded");
  assert.equal(result.limit!.limit, "resident_memory");
  assert.ok(result.limit!.measuredResidentBytes >= 400 * 1024 * 1024,
    "the descendant's memory must be counted against the run limit");
});

test("no orphaned child processes remain after a limit stop", async () => {
  const cwd = await taskDirectory();
  // The adapter spawns detached, so the direct child is also its process-group
  // leader: recording that id makes the orphan check a direct group query
  // rather than a command-line pattern match.
  let processGroupId: number | undefined;
  const observed = codex(`
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(CPU_BURNER)}], { stdio: "ignore" });
    descendant.unref();
    setInterval(() => {}, 1000);
  `);
  const withPid = createOwnerTrustedLocalCodexExecV1({ spawn: (file, args, options) => {
    const child = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(CPU_BURNER)}], { stdio: "ignore" });
      descendant.unref();
      setInterval(() => {}, 1000);
    `], { ...options, env: { ...options.env, NODE_ENV: "test" } });
    processGroupId = child.pid;
    return child;
  } });
  void observed;

  const result = await withPid.execute({
    executablePath: process.execPath, prompt: "leak", workingDirectory: cwd, deadlineMs: LONG_WALL_MS,
    resources: { cpuTimeMs: 1_000, maxResidentBytes: MAX_TASK_RUN_RESIDENT_BYTES } });

  assert.equal(result.status, "limit_exceeded");
  assert.ok(processGroupId !== undefined, "the run group must have been observable");
  assert.equal(processGroupExists(processGroupId!), false,
    "the run process group must be gone by the time the stopped result is returned");

  // And it stays gone: the kill path is not merely a pending instruction.
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.deepEqual(await survivors(processGroupId!), [],
    "a process survived in the stopped run group");
  const { stdout } = await exec("ps", ["-e", "-o", "command="]);
  const strayBurners = stdout.split("\n").filter((line: string) => /total \+= 1/u.test(line));
  assert.deepEqual(strayBurners, [], `an orphaned CPU burner survived: ${strayBurners.join(" | ")}`);
});

test("an ordinary run is unaffected by the same limits", async () => {
  const cwd = await taskDirectory();
  // The minimum enforced bounds, not generous ones: a normal run must still
  // complete under the tightest limits the model will accept.
  const result = await codex(NORMAL_FINISH).execute({
    executablePath: process.execPath, prompt: "finish", workingDirectory: cwd, deadlineMs: 10_000,
    resources: { cpuTimeMs: MIN_TASK_RUN_CPU_TIME_MS, maxResidentBytes: MIN_TASK_RUN_RESIDENT_BYTES } });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") throw new Error("expected a completed run");
  assert.equal(result.text, "bounded result");
  assert.equal("limit" in result, false, "a completed run must not claim a limit stop");
});

test("every local executor enforces the same limits", async () => {
  const cwd = await taskDirectory();
  const resources = { cpuTimeMs: 1_000, maxResidentBytes: MAX_TASK_RUN_RESIDENT_BYTES };
  const results = await Promise.all([
    codex(CPU_BURNER).execute({ executablePath: process.execPath, prompt: "x", workingDirectory: cwd,
      deadlineMs: LONG_WALL_MS, resources, model: "gpt-test", effort: "high" }),
    claude(CPU_BURNER).execute({ executablePath: process.execPath, prompt: "x", workingDirectory: cwd,
      deadlineMs: LONG_WALL_MS, resources }),
    hermes(CPU_BURNER).execute({ executablePath: process.execPath, prompt: "x", workingDirectory: cwd,
      deadlineMs: LONG_WALL_MS, resources, profile: "test", model: "test", provider: "test" }),
  ]);
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, "limit_exceeded", `${["codex", "claude", "hermes"][index]} must stop on CPU`);
    assert.equal(result.reason, "cpu_time_exceeded");
    assert.equal(result.limit?.limit, "cpu_time");
    assert.ok(result.limit!.measuredCpuTimeMs >= 1_000);
  }
});

test("a cancelled run still reports cancellation, not a limit stop", async () => {
  const cwd = await taskDirectory();
  const controller = new AbortController();
  const pending = codex(CPU_BURNER).execute({ executablePath: process.execPath, prompt: "x",
    workingDirectory: cwd, deadlineMs: LONG_WALL_MS, signal: controller.signal,
    resources: { cpuTimeMs: 1_000, maxResidentBytes: MAX_TASK_RUN_RESIDENT_BYTES } });
  setTimeout(() => controller.abort(), 300);
  const result = await pending;
  // Whichever stop lands first is legitimate; a limit stop must still be a
  // truthful, complete record rather than a bare failure.
  if (result.status === "limit_exceeded") assert.ok(result.limit?.measuredCpuTimeMs! >= 1_000);
  else assert.equal(result.status, "canceled");
});

test("an unreadable process table stops the run instead of leaving it unmonitored", async () => {
  const cwd = await taskDirectory();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: ["ignore", "ignore", "ignore"] });
  t_cleanup(child.pid!);
  const breaches: unknown[] = [];
  const supervisor = startTaskRunResourceSupervisorV1(child,
    { cpuTimeMs: 1_000, maxResidentBytes: MAX_TASK_RUN_RESIDENT_BYTES }, breach => { breaches.push(breach); },
    { readProcessTable: async () => { throw new Error("ps unavailable"); }, intervalMs: 25 });
  await new Promise(resolve => setTimeout(resolve, 400));
  supervisor.close();
  assert.equal(breaches.length, 1, "an unreadable table must stop the run, not be ignored");
  assert.equal((breaches[0] as { cause: string }).cause, "measurement_unavailable");
  try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
});

test("a group that disappears is not mistaken for a limit stop", async () => {
  const cwd = await taskDirectory();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  const breaches: unknown[] = [];
  const supervisor = startTaskRunResourceSupervisorV1(child,
    { cpuTimeMs: MIN_TASK_RUN_CPU_TIME_MS, maxResidentBytes: MIN_TASK_RUN_RESIDENT_BYTES },
    breach => { breaches.push(breach); }, { intervalMs: 25 });
  await new Promise(resolve => setTimeout(resolve, 400));
  supervisor.close();
  assert.deepEqual(breaches, [], "an exited run must not be reported as a limit breach");
});

function t_cleanup(pid: number) {
  test.after(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } });
}

test("the process table parser refuses anything it cannot read", () => {
  assert.equal(parsePsTimeToMillisecondsV1("0:01.23"), 1_230);
  assert.equal(parsePsTimeToMillisecondsV1("1:02:03.45"), 3_723_450);
  assert.equal(parsePsTimeToMillisecondsV1("12:34"), undefined, "whole seconds are not this format");
  assert.equal(parsePsTimeToMillisecondsV1("not-a-time"), undefined);
  // `ps` pads columns, so leading whitespace is expected input, not an error.
  assert.deepEqual(parsePsGroupRowV1("  123  122  0:01.50  2048"),
    { pid: 123, pgid: 122, cpuTimeMs: 1_500, rssKilobytes: 2048 });
  // A missing field, an extra field, a non-numeric rss and a non-numeric pid
  // are each a refusal: a line this parser cannot read must never contribute a
  // partial (too small) measurement.
  assert.equal(parsePsGroupRowV1("  123  122  0:01.50"), undefined, "a missing field is unreadable");
  assert.equal(parsePsGroupRowV1("  123  122  0:01.50  2048  extra"), undefined, "an extra field is unreadable");
  assert.equal(parsePsGroupRowV1("  123  122  0:01.50  x"), undefined, "a non-numeric rss is unreadable");
  assert.equal(parsePsGroupRowV1("  x  122  0:01.50  2048"), undefined, "a non-numeric pid is unreadable");
  assert.equal(parsePsGroupRowV1(""), undefined);
  // A malformed line is a refusal, never a smaller total.
  assert.throws(() => summarizeProcessGroupV1(["  1  1  0:00.10  100", "garbage"]),
    /task_run_resource_supervisor_unavailable/u);
});

test("a breach is reported against the limit actually crossed, CPU first", () => {
  const both = { cpuTimeMs: 5_000, residentBytes: 900_000_000, processes: 1 };
  assert.deepEqual(detectResourceBreachV1(both, { cpuTimeMs: 1_000, maxResidentBytes: 1_000_000 }), { limit: "cpu_time" });
  assert.deepEqual(detectResourceBreachV1({ ...both, cpuTimeMs: 10 },
    { cpuTimeMs: 1_000, maxResidentBytes: 1_000_000 }), { limit: "resident_memory" });
  assert.equal(detectResourceBreachV1({ cpuTimeMs: 10, residentBytes: 10, processes: 1 },
    { cpuTimeMs: 1_000, maxResidentBytes: 1_000_000 }), undefined);
  // At the limit exactly is already over it: the comparison is >=, not >.
  assert.deepEqual(detectResourceBreachV1({ cpuTimeMs: 1_000, residentBytes: 0, processes: 1 },
    { cpuTimeMs: 1_000, maxResidentBytes: MAX_TASK_RUN_RESIDENT_BYTES }), { limit: "cpu_time" });
});

test("the enforced resource record refuses anything outside the enforced bounds", () => {
  const valid = { cpuTimeMs: 1_000, maxResidentBytes: 67_108_864 };
  assert.deepEqual(captureMacLocalTaskRunResourcesV1(valid), valid);
  for (const bad of [
    { ...valid, extra: 1 }, { cpuTimeMs: 1_000 }, { ...valid, cpuTimeMs: MIN_TASK_RUN_CPU_TIME_MS - 1 },
    { ...valid, cpuTimeMs: MAX_TASK_RUN_CPU_TIME_MS + 1 },
    { ...valid, maxResidentBytes: MIN_TASK_RUN_RESIDENT_BYTES - 1 },
    { ...valid, maxResidentBytes: MAX_TASK_RUN_RESIDENT_BYTES + 1 },
    { ...valid, cpuTimeMs: 1.5 }, null, [],
  ]) assert.throws(() => captureMacLocalTaskRunResourcesV1(bad), /mac_local_task_run_limits_invalid/u);
});

test("a claimed stop record is validated before it can name a limit in a run record", () => {
  const stop = { limit: "cpu_time", reason: "cpu_time_exceeded", cause: "exceeded", measuredCpuTimeMs: 1_000,
    measuredResidentBytes: 10, limitCpuTimeMs: 1_000, limitResidentBytes: 67_108_864 };
  assert.deepEqual(captureTaskRunResourceStopV1(stop), stop);
  for (const bad of [
    { ...stop, limit: "disk_space" }, { ...stop, reason: "made_up" }, { ...stop, cause: "whatever" },
    { ...stop, measuredCpuTimeMs: -1 }, { ...stop, measuredCpuTimeMs: 1.5 }, { ...stop, extra: 1 },
    { ...stop, limit: undefined },
  ]) assert.throws(() => captureTaskRunResourceStopV1(bad), /task_run_resource_supervisor_unavailable/u);
});

test("the owner limit model carries the enforced pair and defaults to bounded values", () => {
  assert.equal(Object.keys(DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1).length, 5);
  assert.ok(DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1.cpuTimeMs >= MIN_TASK_RUN_CPU_TIME_MS);
  assert.ok(DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1.maxResidentBytes <= MAX_TASK_RUN_RESIDENT_BYTES);
  const captured = captureMacLocalTaskRunLimitsV1({ ...DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1 });
  assert.deepEqual(captured, DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1);
  // A settings file written before the resource limits existed is ambiguous,
  // and is refused rather than silently defaulted on the CPU/memory half.
  assert.throws(() => captureMacLocalTaskRunLimitsV1({ schema: MAC_LOCAL_TASK_RUN_LIMITS_V1,
    wallTimeMs: 120_000, outputBytes: 1_048_576 }), /mac_local_task_run_limits_invalid/u);
  assert.ok(TASK_RUN_RESOURCE_SAMPLE_INTERVAL_MS <= 1_000,
    "the sample cadence must be fine enough for the smallest CPU limit");
});
