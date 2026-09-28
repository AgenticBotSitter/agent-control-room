import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureMacLocalTaskRunLimitsV1, DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1,
  MAC_LOCAL_TASK_RUN_LIMITS_V1, MAX_TASK_RUN_OUTPUT_BYTES, MAX_TASK_RUN_WALL_TIME_MS,
  MIN_TASK_RUN_OUTPUT_BYTES, MIN_TASK_RUN_WALL_TIME_MS } from "../src/harness/v1/owner-trusted-local-run-limits";
import { loadMacLocalTaskRunLimitsFromRootV1,
  writeMacLocalTaskRunLimitsToRootV1 } from "../src/web/v1/mac-local-task-run-limits";
import { parseConfigureTaskRunLimitsArgumentsV1 } from "../scripts/mac-local/configure-task-run-limits";

async function protectedRoot(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "acr-task-run-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  await mkdir(join(root, "config"), { mode: 0o700 });
  return root;
}

const limits = (wallTimeMs = 45_000, outputBytes = 262_144) => ({
  schema: MAC_LOCAL_TASK_RUN_LIMITS_V1, wallTimeMs, outputBytes,
});

test("the exact schema accepts safe integer boundaries and rejects malformed or out-of-range values", () => {
  assert.deepEqual(captureMacLocalTaskRunLimitsV1(limits()), limits());
  assert.deepEqual(captureMacLocalTaskRunLimitsV1(limits(MIN_TASK_RUN_WALL_TIME_MS, MIN_TASK_RUN_OUTPUT_BYTES)),
    limits(MIN_TASK_RUN_WALL_TIME_MS, MIN_TASK_RUN_OUTPUT_BYTES));
  assert.deepEqual(captureMacLocalTaskRunLimitsV1(limits(MAX_TASK_RUN_WALL_TIME_MS, MAX_TASK_RUN_OUTPUT_BYTES)),
    limits(MAX_TASK_RUN_WALL_TIME_MS, MAX_TASK_RUN_OUTPUT_BYTES));
  for (const value of [
    { ...limits(), extra: true },
    { wallTimeMs: 1_000, outputBytes: 16_384 },
    { ...limits(), schema: "wrong" },
    limits(MIN_TASK_RUN_WALL_TIME_MS - 1, MIN_TASK_RUN_OUTPUT_BYTES),
    limits(MAX_TASK_RUN_WALL_TIME_MS + 1, MIN_TASK_RUN_OUTPUT_BYTES),
    limits(MIN_TASK_RUN_WALL_TIME_MS, MIN_TASK_RUN_OUTPUT_BYTES - 1),
    limits(MIN_TASK_RUN_WALL_TIME_MS, MAX_TASK_RUN_OUTPUT_BYTES + 1),
    limits(1_000.5, MIN_TASK_RUN_OUTPUT_BYTES),
    limits(1_000, Number.NaN),
  ]) assert.throws(() => captureMacLocalTaskRunLimitsV1(value), /mac_local_task_run_limits_invalid/u);
});

test("an absent settings file loads the safe defaults without creating state", async t => {
  const root = await protectedRoot(t);
  assert.deepEqual(await loadMacLocalTaskRunLimitsFromRootV1(root), DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1);
  assert.deepEqual(await readdir(join(root, "config")), []);
});

test("the writer creates and atomically replaces a private exact settings file", async t => {
  const root = await protectedRoot(t), file = join(root, "config/task-run-limits.json");
  await writeMacLocalTaskRunLimitsToRootV1(root, limits());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadMacLocalTaskRunLimitsFromRootV1(root), limits());
  assert.deepEqual(await readdir(join(root, "config")), ["task-run-limits.json"]);
  const replacement = limits(90_000, 524_288);
  await writeMacLocalTaskRunLimitsToRootV1(root, replacement);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), replacement);
  assert.deepEqual(await readdir(join(root, "config")), ["task-run-limits.json"], "no temporary file remains");
});

test("an invalid existing file fails closed and is never repaired or overwritten", async t => {
  const root = await protectedRoot(t), file = join(root, "config/task-run-limits.json");
  const invalid = "{\"schema\":\"wrong\"}\n";
  await writeFile(file, invalid, { mode: 0o600 });
  await assert.rejects(loadMacLocalTaskRunLimitsFromRootV1(root), /mac_local_task_run_limits_unavailable/u);
  await assert.rejects(writeMacLocalTaskRunLimitsToRootV1(root, limits()), /mac_local_task_run_limits_unavailable/u);
  assert.equal(await readFile(file, "utf8"), invalid);
});

test("loader and writer refuse public files, symlinks, public directories, and non-canonical roots", async t => {
  const root = await protectedRoot(t), file = join(root, "config/task-run-limits.json");
  await writeFile(file, `${JSON.stringify(limits())}\n`, { mode: 0o600 });
  await chmod(file, 0o644);
  await assert.rejects(loadMacLocalTaskRunLimitsFromRootV1(root), /mac_local_task_run_limits_unavailable/u);
  await assert.rejects(writeMacLocalTaskRunLimitsToRootV1(root, limits()), /mac_local_task_run_limits_unavailable/u);
  await chmod(file, 0o600);

  const linked = await protectedRoot(t);
  await symlink(file, join(linked, "config/task-run-limits.json"));
  await assert.rejects(loadMacLocalTaskRunLimitsFromRootV1(linked), /mac_local_task_run_limits_unavailable/u);
  await assert.rejects(writeMacLocalTaskRunLimitsToRootV1(linked, limits()), /mac_local_task_run_limits_unavailable/u);

  await chmod(join(root, "config"), 0o755);
  await assert.rejects(loadMacLocalTaskRunLimitsFromRootV1(root), /mac_local_task_run_limits_unavailable/u);
  await assert.rejects(writeMacLocalTaskRunLimitsToRootV1(root, limits()), /mac_local_task_run_limits_unavailable/u);
  await assert.rejects(loadMacLocalTaskRunLimitsFromRootV1("relative/root"), /mac_local_task_run_limits_unavailable/u);
});

test("the configuration command accepts each flag exactly once and validates canonical integers and bounds", () => {
  const args = ["--protected-root", "/protected", "--wall-time-ms", "120000", "--output-bytes", "1048576"];
  assert.deepEqual(parseConfigureTaskRunLimitsArgumentsV1(args), parseConfigureTaskRunLimitsArgumentsV1(["--", ...args]));
  assert.deepEqual(parseConfigureTaskRunLimitsArgumentsV1(args), {
    protectedRoot: "/protected", limits: DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1,
  });
  for (const bad of [args.slice(0, -2), [...args, "--wall-time-ms", "1000"], [...args, "--extra", "1"],
    ["--protected-root", "/protected", "--wall-time-ms", "01000", "--output-bytes", "16384"],
    ["--protected-root", "/protected", "--wall-time-ms", "999", "--output-bytes", "16384"],
    ["--protected-root", "/protected", "--wall-time-ms", "1000", "--output-bytes", "16777217"]])
    assert.throws(() => parseConfigureTaskRunLimitsArgumentsV1(bad), /mac_local_task_run_limits_(?:arguments_refused|invalid)/u);
});

test("the direct command reports only its generic outcome, never the configured values", async t => {
  const root = await protectedRoot(t);
  const configured = ["77777", "333333"];
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/configure-task-run-limits.ts",
    "--protected-root", root, "--wall-time-ms", configured[0]!, "--output-bytes", configured[1]!],
  { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "mac:configure-task-run-limits updated\n");
  assert.ok(configured.every(value => !result.stdout.includes(value) && !result.stderr.includes(value)));
  assert.deepEqual(await loadMacLocalTaskRunLimitsFromRootV1(root), limits(77_777, 333_333));

  const refusedValue = "999999999999";
  const refused = spawnSync(process.execPath, ["--import", "tsx", "scripts/mac-local/configure-task-run-limits.ts",
    "--protected-root", root, "--wall-time-ms", refusedValue, "--output-bytes", "16384"],
  { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.ok(!refused.stdout.includes(refusedValue) && !refused.stderr.includes(refusedValue));
});
