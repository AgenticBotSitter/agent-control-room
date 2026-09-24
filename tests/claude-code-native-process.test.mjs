import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1 } from
  "../src/installer/v1/macos-claude-code-process-native-sidecar.mjs";

const run = promisify(execFile), nativeTest = process.platform === "darwin" ? test : test.skip;
let root, helper, original, closeFdLauncher;
before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-claude-custody-test-"); await chmod(root, 0o700);
  helper = join(root, "claude-code-process-v1"); original = join(root, "fixture-original");
  await run("/usr/bin/clang", [...CLAUDE_CODE_PROCESS_NATIVE_REVIEWED_CFLAGS_V1,
    "native/claude-code-process-v1.c", "-o", helper], { timeout: 30_000 });
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "tests/helpers/claude-code-native-fixture.c", "-o", original], { timeout: 30_000 });
  closeFdLauncher = join(root, "close-fd-launcher");
  await run("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "tests/helpers/claude-code-close-fd-launcher.c", "-o", closeFdLauncher], { timeout: 30_000 });
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function command(opcode) { const b = Buffer.alloc(16); b.write("ACRC"); b[4] = opcode; return b; }
async function setup(t, overrides = {}) {
  const scope = await mkdtemp(join(root, "scope-")), workspace = join(scope, "workspace"), executable = join(scope, "fixture");
  await mkdir(workspace, { mode: 0o700 }); await copyFile(original, executable); await chmod(executable, 0o700);
  const es = await lstat(executable), ws = await lstat(workspace), e = Buffer.from(executable), w = Buffer.from(workspace);
  const header = Buffer.alloc(104); header.write("ACRCCP1\n"); header.writeUInt32BE(1, 8);
  header.writeUInt32BE(e.length, 12); header.writeUInt32BE(w.length, 16);
  header.writeUInt32BE(overrides.holdMs ?? 5_000, 20); header.writeUInt32BE(overrides.runMs ?? 5_000, 24);
  [process.geteuid(), es.dev, es.ino, ws.dev, ws.ino].forEach((v, i) => header.writeBigUInt64BE(BigInt(v), 32 + 8 * i));
  createHash("sha256").update(await readFile(executable)).digest().copy(header, 72);
  const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", ACR_FIXTURE_MUST_NOT_INHERIT: "yes" } });
  const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
  const status = [], pending = []; let buffered = Buffer.alloc(0), bytes = 0, stdout = "", stderr = "", helperError = "";
  child.stdout.on("data", chunk => {
    bytes += chunk.length; assert.ok(bytes <= 128); buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 16) { const frame = buffered.subarray(0, 16); buffered = buffered.subarray(16);
      assert.equal(frame.subarray(0, 4).toString(), "ACRS"); status.push(frame);
      const next = pending.shift(); if (next) next(frame);
    }
  });
  child.stderr.on("data", chunk => { helperError += chunk; });
  child.stdio[4].on("data", chunk => { stdout += chunk; }); child.stdio[5].on("data", chunk => { stderr += chunk; });
  for (const stream of [child.stdin, child.stdio[3]]) stream.on("error", () => {});
  let consumed = 0;
  t.after(async () => { if (child.exitCode === null) { child.stdin.destroy(); await exit; }
    assert.equal(helperError, ""); });
  const next = () => {
    if (status.length > consumed) return Promise.resolve(status[consumed++]);
    consumed++; return Promise.race([new Promise(resolve => pending.push(resolve)),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("bounded status missing")), 4_000); timer.unref(); })]);
  };
  return { child, exit, header, frame: Buffer.concat([header, e, w]), executable, workspace, scope, next, status,
    output: () => ({ stdout, stderr }), marker: () => access(join(workspace, "target-started")) };
}

nativeTest("held descriptors start no target until GO; one fixed invocation and isolated streams reach exact exit", async t => {
  const s = await setup(t); s.child.stdin.write(s.frame); assert.equal((await s.next())[4], 1);
  s.child.stdio[3].write("x"); await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(s.marker(), { code: "ENOENT" }); assert.deepEqual(s.output(), { stdout: "", stderr: "" });
  s.child.stdin.write(command(2)); assert.equal((await s.next())[4], 2);
  const end = await s.next(); assert.equal(end[4], 3); assert.equal(end[5], 1); assert.equal(end[6], 1);
  assert.equal(end.readUInt32BE(8), 7); assert.equal(await s.exit, 0); await s.marker();
  assert.deepEqual(s.output(), { stdout: "fixture-output\n", stderr: "fixture-error\n" });
});

nativeTest("CANCEL retires HOLD without creating any target", async t => {
  const s = await setup(t); s.child.stdin.write(s.frame); assert.equal((await s.next())[4], 1);
  s.child.stdin.write(command(3)); assert.equal((await s.next())[4], 6); assert.equal(await s.exit, 0);
  await assert.rejects(s.marker(), { code: "ENOENT" });
});

nativeTest("private watchdog descriptors cannot occupy or leak through a missing protocol descriptor", async () => {
  const child = spawn(closeFdLauncher, [helper], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const output = [];
  child.stdout.on("data", chunk => output.push(chunk));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const frames = Buffer.concat(output);
  assert.equal(exit, 1);
  assert.equal(frames.length, 16);
  assert.equal(frames.subarray(0, 4).toString(), "ACRS");
  assert.equal(frames[4], 4);
});

nativeTest("replacement of executable or workspace after VERIFIED refuses before target code", async t => {
  for (const kind of ["executable", "workspace", "symlink"]) {
    const s = await setup(t); s.child.stdin.write(s.frame); assert.equal((await s.next())[4], 1);
    if (kind === "workspace") { await rename(s.workspace, `${s.workspace}-old`); await mkdir(s.workspace, { mode: 0o700 }); }
    else { await rename(s.executable, `${s.executable}-old`);
      if (kind === "symlink") await symlink(`${s.executable}-old`, s.executable);
      else { await copyFile(original, s.executable); await chmod(s.executable, 0o700); } }
    s.child.stdin.write(command(2)); assert.equal((await s.next())[4], 4); assert.equal(await s.exit, 1);
    await assert.rejects(s.marker(), { code: "ENOENT" });
  }
});

nativeTest("wrong hash, reserved bytes, unknown control, truncated command, and EOF all refuse without target", async t => {
  for (const kind of ["hash", "reserved", "unknown", "truncated", "eof", "command-reserved"]) {
    const s = await setup(t);
    if (kind === "hash") s.frame[72] ^= 1;
    if (kind === "reserved") s.frame[28] = 1;
    s.child.stdin.write(s.frame);
    if (!["hash", "reserved"].includes(kind)) {
      assert.equal((await s.next())[4], 1);
      if (kind === "unknown") s.child.stdin.write(command(99));
      else if (kind === "command-reserved") { const c = command(2); c[15] = 1; s.child.stdin.write(c); }
      else s.child.stdin.end(kind === "truncated" ? command(2).subarray(0, 7) : undefined);
    }
    assert.equal((await s.next())[4], 4); assert.equal(await s.exit, 1);
    await assert.rejects(s.marker(), { code: "ENOENT" });
  }
});

nativeTest("TERM and KILL own only the target group and confirm leader status plus group absence", async t => {
  for (const opcode of [4, 5]) {
    const s = await setup(t); s.child.stdin.write(s.frame); assert.equal((await s.next())[4], 1);
    s.child.stdin.write(command(2)); assert.equal((await s.next())[4], 2);
    s.child.stdin.write(command(opcode)); const end = await s.next();
    assert.equal(end[4], 3); assert.equal(end[5], 2); assert.equal(end[6], 1);
    assert.equal(end.readUInt32BE(8), opcode === 4 ? 15 : 9); assert.equal(await s.exit, 0);
  }
});

nativeTest("deadline or post-start control loss kills the owned target and reports uncertainty", async t => {
  for (const kind of ["deadline", "eof"]) {
    const s = await setup(t, { runMs: 150 }); s.child.stdin.write(s.frame); assert.equal((await s.next())[4], 1);
    s.child.stdin.write(command(2)); assert.equal((await s.next())[4], 2);
    if (kind === "eof") s.child.stdin.end();
    assert.equal((await s.next())[4], 5); assert.equal(await s.exit, 1);
  }
});
