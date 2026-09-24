import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test, type TestContext } from "node:test";
import {
  createPrivateMacosClaudeCodeInstalledProcessHostPortsV1,
  CLAUDE_CODE_MACOS_PROCESS_PORT_ACTIVATION_BLOCKERS_V1,
  type PrivateMacosClaudeCodeProcessPortConfigurationV1,
} from "../src/node-bridge/private-macos-claude-code-process-host-ports";
import {
  createPrivateClaudeCodeInstalledProcessHostV1,
  CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
  type PrivateClaudeCodeNativeChildV1,
} from "../src/harness/claude-code-v1/private-installed-process-host";
import { CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1 } from "../src/harness/claude-code-v1/text-review-invocation-policy";
import { CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1 } from "../src/installer/v1/macos-claude-code-process-native-sidecar.mjs";

const run = promisify(execFile), nativeTest = process.platform === "darwin" ? test : test.skip;
const signal = () => new AbortController().signal;
const digest = (text: string | Buffer) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const binding = { processAttemptId: "fixture-process", runId: "fixture-run", attemptId: "fixture-attempt", invocationDigest: digest("invocation") };
let root: string, helper: string, preHoldDeathHelper: string, original: string, statusFixture: string;
before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-claude-port-test-"); await chmod(root, 0o700);
  helper = join(root, "helper"); original = join(root, "fixture"); statusFixture = join(root, "status-fixture");
  preHoldDeathHelper = join(root, "pre-hold-death-helper");
  await run("/usr/bin/clang", [...CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1,
    "native/claude-code-process-v1.c", "-o", helper], { timeout: 30_000 });
  await run("/usr/bin/clang", [...CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1,
    "-DACR_TEST_CUSTODIAN_DEATH_BEFORE_HOLD=1", "native/claude-code-process-v1.c", "-o", preHoldDeathHelper],
  { timeout: 30_000 });
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "tests/helpers/claude-code-port-fixture.c", "-o", original], { timeout: 30_000 });
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "tests/helpers/claude-code-port-status-fixture.c", "-o", statusFixture], { timeout: 30_000 });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function setup(t: TestContext, overrides: Partial<PrivateMacosClaudeCodeProcessPortConfigurationV1> = {}) {
  const scope = await mkdtemp(join(root, "scope-")), workspace = join(scope, "workspace"), executable = join(scope, "fixture");
  await mkdir(workspace, { mode: 0o700 }); await copyFile(original, executable); await chmod(executable, 0o700);
  const es = await lstat(executable, { bigint: true }), ws = await lstat(workspace, { bigint: true });
  const config = { schema: "control-room.macos-claude-code-process-port/v1", helperPath: helper,
    helperSha256: digest(await readFile(helper)), executablePath: executable, executableSha256: digest(await readFile(executable)),
    executableIdentity: { device: `${es.dev}`, inode: `${es.ino}` },
    workingDirectory: workspace, workingDirectoryIdentity: { device: `${ws.dev}`, inode: `${ws.ino}` },
    workingDirectoryBindingDigest: digest("workspace"), qualificationDigest: digest("qualification"), ownerUid: process.geteuid!(),
    holdDeadlineMs: 2_000, runDeadlineMs: 5_000, ...overrides } satisfies PrivateMacosClaudeCodeProcessPortConfigurationV1;
  const ports = createPrivateMacosClaudeCodeInstalledProcessHostPortsV1(config);
  const request = { schema: CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
    executablePath: config.executablePath, executableSha256: config.executableSha256,
    workingDirectory: config.workingDirectory, workingDirectoryBindingDigest: config.workingDirectoryBindingDigest,
    qualificationDigest: config.qualificationDigest };
  let child: PrivateClaudeCodeNativeChildV1 | undefined;
  t.after(async () => { if (child) { await child.signalKill(signal()).catch(() => {}); await child.exited.catch(() => {}); } });
  return { config, ports, request, executable, workspace,
    launch: () => child = ports.launch({ ...request, args: CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1, binding }) };
}

nativeTest("VERIFIED survives the higher host's successful bounded-signal abort; streams cannot forge status", async t => {
  const s = await setup(t);
  const host = createPrivateClaudeCodeInstalledProcessHostV1({
    schema: "control-room.claude-code-private-installed-process-host-configuration/v1",
    process: { executablePath: s.config.executablePath, workingDirectory: s.config.workingDirectory,
      args: CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1 },
    executableSha256: s.config.executableSha256, workingDirectoryBindingDigest: s.config.workingDirectoryBindingDigest,
    qualificationDigest: s.config.qualificationDigest, startupDeadlineMs: 2_000, terminateDeadlineMs: 100, killDeadlineMs: 4_000,
  }, s.ports, { assertCurrent() {} });
  const owned = host.acquire(binding, signal()), io = await owned.ready;
  t.after(async () => { await owned.close().catch(() => {}); });
  await io.writeStdin(Buffer.from("x"), signal()); await io.closeStdin(signal());
  let out = "", err = "";
  for (;;) { const chunk = await io.readStdout(signal()); if (!chunk) break; out += Buffer.from(chunk).toString(); }
  for (;;) { const chunk = await io.readStderr(signal()); if (!chunk) break; err += Buffer.from(chunk).toString(); }
  assert.equal(out, "ACRS forged target output\n"); assert.equal(err, "private fixture error\n");
  assert.deepEqual(await io.exited, { code: 7, signal: null }); await owned.close();
});

nativeTest("wrong request, wrong helper hash, pre-abort, concurrent verify and duplicate launch refuse", async t => {
  const s = await setup(t), wrong = await setup(t, { helperSha256: digest("wrong") });
  await assert.rejects(wrong.ports.verifyInstallation({ ...wrong.request, signal: signal() }), /_refused/);
  await assert.rejects(s.ports.verifyInstallation({ ...s.request, executableSha256: digest("wrong"), signal: signal() }), /_refused/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(s.ports.verifyInstallation({ ...s.request, signal: cancelled.signal }), /_refused/);
  const first = s.ports.verifyInstallation({ ...s.request, signal: signal() });
  await assert.rejects(s.ports.verifyInstallation({ ...s.request, signal: signal() }), /_refused/);
  await first; const child = s.launch(); assert.throws(s.launch, /_refused/);
  await child.signalKill(signal()); assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
});

nativeTest("post-verification replacement or symlink refuses execution and cannot report a normal exit", async t => {
  for (const kind of ["executable", "workspace", "symlink"]) {
    const s = await setup(t); await s.ports.verifyInstallation({ ...s.request, signal: signal() });
    if (kind === "workspace") { await rename(s.workspace, `${s.workspace}-old`); await mkdir(s.workspace, { mode: 0o700 }); }
    else { await rename(s.executable, `${s.executable}-old`);
      if (kind === "symlink") await symlink(`${s.executable}-old`, s.executable);
      else { await copyFile(original, s.executable); await chmod(s.executable, 0o700); } }
    const child = s.launch(); await assert.rejects(child.exited, /_uncertain/);
  }
});

nativeTest("TERM-resistant target requires KILL and exact group retirement", async t => {
  const s = await setup(t); await s.ports.verifyInstallation({ ...s.request, signal: signal() }); const child = s.launch();
  await child.writeStdin(Buffer.from("i"), signal()); assert.equal(Buffer.from((await child.readStdout(signal()))!).toString(), "ready\n");
  await child.signalTerminate(signal());
  assert.equal(await Promise.race([child.exited.then(() => "exited"), new Promise(resolve => setTimeout(() => resolve("still-running"), 75))]), "still-running");
  await child.signalKill(signal()); assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" }); await child.close(signal());
});

nativeTest("natural leader exit retires its remaining ordinary descendant before success", async t => {
  const s = await setup(t); await s.ports.verifyInstallation({ ...s.request, signal: signal() }); const child = s.launch();
  await child.writeStdin(Buffer.from("d"), signal());
  assert.deepEqual(await child.exited, { code: 11, signal: null }); await child.close(signal());
});

nativeTest("custodian death after GO is recovered without turning uncertainty into a result or retry", async t => {
  const s = await setup(t); await s.ports.verifyInstallation({ ...s.request, signal: signal() }); const child = s.launch();
  await child.writeStdin(Buffer.from("h"), signal()); await assert.rejects(child.exited, /_uncertain/);
  await assert.rejects(child.close(signal()), /_uncertain/);
  await new Promise(resolve => setTimeout(resolve, 100));
  await s.ports.verifyInstallation({ ...s.request, signal: signal() }); const next = s.launch();
  await next.writeStdin(Buffer.from("x"), signal()); await next.closeStdin(signal());
  assert.deepEqual(await next.exited, { code: 7, signal: null });
  assert.equal(CLAUDE_CODE_MACOS_PROCESS_PORT_ACTIVATION_BLOCKERS_V1.includes(
    "independent_helper_death_recovery_missing" as never), false);
});

nativeTest("custodian death before HOLD is recovered within the bound and cannot start a target", async t => {
  const s = await setup(t, { helperPath: preHoldDeathHelper, helperSha256: digest(await readFile(preHoldDeathHelper)) });
  const started = Date.now();
  await assert.rejects(s.ports.verifyInstallation({ ...s.request, signal: signal() }), /_refused/);
  assert.ok(Date.now() - started < 3_000, "independent recovery must remain inside its cleanup bound");
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(s.ports.verifyInstallation({ ...s.request, signal: signal() }), /_refused/,
    "a recovered failed custodian may create a fresh HOLD, never resume the failed one");
});

nativeTest("bounded output and expired held verification fail closed", async t => {
  const small = await setup(t, { maximumOutputBytes: 3 }); await small.ports.verifyInstallation({ ...small.request, signal: signal() });
  const child = small.launch(); await child.writeStdin(Buffer.from("x"), signal()); await assert.rejects(child.exited, /_uncertain/);
  const stale = await setup(t, { holdDeadlineMs: 100 }); await stale.ports.verifyInstallation({ ...stale.request, signal: signal() });
  await new Promise(resolve => setTimeout(resolve, 200)); assert.throws(stale.launch, /_refused/);
});

nativeTest("binary status parsing accepts split frames and rejects malformed, extra and partial terminal frames", async t => {
  for (const mode of ["split-valid", "bad-header", "bad-exit", "extra-frame", "truncated"]) {
    const workspace = join(root, mode); await mkdir(workspace, { mode: 0o700 });
    const ws = await lstat(workspace, { bigint: true });
    const s = await setup(t, { helperPath: statusFixture, helperSha256: digest(await readFile(statusFixture)),
      workingDirectory: workspace, workingDirectoryIdentity: { device: `${ws.dev}`, inode: `${ws.ino}` } });
    if (mode === "bad-header") { await assert.rejects(s.ports.verifyInstallation({ ...s.request, signal: signal() }), /_refused/); continue; }
    await s.ports.verifyInstallation({ ...s.request, signal: signal() }); const child = s.launch();
    if (mode === "split-valid") assert.deepEqual(await child.exited, { code: 0, signal: null });
    else await assert.rejects(child.exited, /_uncertain/);
  }
});

nativeTest("one port permits a new sequential task only after certain retirement", async t => {
  const s = await setup(t);
  for (let task = 0; task < 2; task++) {
    await s.ports.verifyInstallation({ ...s.request, signal: signal() }); const child = s.launch();
    await child.writeStdin(Buffer.from("x"), signal()); assert.deepEqual(await child.exited, { code: 7, signal: null });
    await child.close(signal());
  }
});

nativeTest("authority refusal releases an unused HOLD after certain native refusal; a later valid task succeeds", async t => {
  const s = await setup(t, { holdDeadlineMs: 150 }); let authorityAllowed = false;
  const host = createPrivateClaudeCodeInstalledProcessHostV1({
    schema: "control-room.claude-code-private-installed-process-host-configuration/v1",
    process: { executablePath: s.config.executablePath, workingDirectory: s.config.workingDirectory,
      args: CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1 },
    executableSha256: s.config.executableSha256, workingDirectoryBindingDigest: s.config.workingDirectoryBindingDigest,
    qualificationDigest: s.config.qualificationDigest, startupDeadlineMs: 2_000, terminateDeadlineMs: 100, killDeadlineMs: 4_000,
  }, s.ports, { assertCurrent() { if (!authorityAllowed) throw new Error("fixture-authority-refused"); } });
  const first = host.acquire(binding, signal());
  await assert.rejects(first.ready, /_refused/); await first.close();
  await assert.rejects(s.ports.verifyInstallation({ ...s.request, signal: signal() }), /_refused/,
    "the active HOLD cannot be reused before native cleanup closes");
  await new Promise(resolve => setTimeout(resolve, 300)); authorityAllowed = true;
  const second = host.acquire({ ...binding, processAttemptId: "next-authorized-process" }, signal());
  t.after(async () => { await second.close().catch(() => {}); });
  const io = await second.ready; await io.writeStdin(Buffer.from("x"), signal());
  await io.closeStdin(signal()); assert.deepEqual(await io.exited, { code: 7, signal: null }); await second.close();
});
