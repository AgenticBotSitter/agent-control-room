import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const harness = join(root, "scripts", "qualification", "platform-key-store-harness.ts");

interface HarnessResult {
  schema: string;
  platform: string;
  provider: string;
  implementation: string;
  attempt: number;
  passed: boolean;
  cases: Array<{ id: string; status: string; category: string }>;
  counts: Record<string, number>;
  publicKeyFingerprint: string;
  cleanupTargets: string[];
}

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("qualification harness is pinned to the real provider factory and committed helpers", async () => {
  const source = await readFile(harness, "utf8");
  const swift = await readFile(join(root, "scripts", "qualification", "macos-keychain-fixture.swift"), "utf8");
  assert.match(source, /createNodePrivateKeyStore/);
  assert.match(source, /from "\.\.\/\.\.\/src\/node-policy\/v1\/index\.ts"/);
  assert.match(source, /macos-keychain-fixture\.swift/);
  assert.doesNotMatch(source, /Always Allow/i);
  assert.doesNotMatch(source, /\.\.\/\.\.\/src\/node-policy\/v1\/native-key-stores/);
  assert.match(swift, /standardInput\.readDataToEndOfFile/);
  assert.match(swift, /SecItemAdd/);
  assert.doesNotMatch(swift, /CommandLine\.arguments\[[^\]]+\].*(?:password|secret|private)/i);
});

test("Windows execute-only harness qualifies CurrentUser DPAPI through the real factory", { skip: process.platform !== "win32" }, async () => {
  const directory = await scratch("control-room-cr5c9h-win-");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--import", "tsx", harness, "--platform", "windows", "--scratch", directory,
    ], { cwd: root, env: { ...process.env, NODE_ENV: "test" }, timeout: 60_000, maxBuffer: 32_768 });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout) as HarnessResult;
    assert.equal(result.schema, "control-room.platform-key-store-qualification/v1");
    assert.equal(result.platform, "windows");
    assert.equal(result.provider, "windows_dpapi_current_user");
    assert.equal(result.implementation, "createNodePrivateKeyStore");
    assert.equal(result.attempt, 1);
    assert.equal(result.passed, true);
    assert.equal(result.counts.keypairs, 1);
    assert.equal(result.counts.protectCalls, 1);
    assert.equal(result.counts.adapterUnprotectCalls, 3);
    assert.deepEqual(result.cleanupTargets, ["dpapi-valid.bin", "dpapi-tampered.bin"]);
    assert.match(result.publicKeyFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(result.cases.every((item) => item.status === "pass"));
    assert.deepEqual((await readdir(directory)).sort(), ["dpapi-tampered.bin", "dpapi-valid.bin"]);
    assert.doesNotMatch(stdout, /BEGIN PRIVATE KEY|CONTROL_ROOM_DPAPI_UNPROTECT_FAILED|[A-Za-z]:\\Users\\/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wrong-platform execution fails closed with one safe category and no artifact", async () => {
  const requested = process.platform === "linux" ? "windows" : "linux";
  const directory = await scratch("control-room-cr5c9h-wrong-");
  try {
    await assert.rejects(execFileAsync(process.execPath, [
      "--import", "tsx", harness, "--platform", requested, "--scratch", directory,
    ], { cwd: root, env: { ...process.env, NODE_ENV: "test" }, timeout: 30_000, maxBuffer: 8_192 }), (error: unknown) => {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      assert.deepEqual(JSON.parse(stdout), {
        schema: "control-room.platform-key-store-qualification-error/v1",
        category: "unavailable_platform",
      });
      return true;
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness refuses a nonempty scratch directory before platform effects", async () => {
  const directory = await scratch("control-room-cr5c9h-nonempty-");
  try {
    await writeFile(join(directory, "unexpected.txt"), "constant");
    await assert.rejects(execFileAsync(process.execPath, [
      "--import", "tsx", harness, "--platform", process.platform === "win32" ? "windows" : "linux", "--scratch", directory,
    ], { cwd: root, env: { ...process.env, NODE_ENV: "test" }, timeout: 30_000, maxBuffer: 8_192 }), (error: unknown) => {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      assert.equal(JSON.parse(stdout).category, "permission_denied");
      return true;
    });
    assert.deepEqual(await readdir(directory), ["unexpected.txt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness rejects unknown or duplicate arguments before platform effects", async () => {
  const directory = await scratch("control-room-cr5c9h-args-");
  try {
    for (const tail of [["--unknown", "value"], ["--scratch", directory]]) {
      await assert.rejects(execFileAsync(process.execPath, [
        "--import", "tsx", harness,
        "--platform", process.platform === "win32" ? "windows" : "linux",
        "--scratch", directory,
        ...tail,
      ], { cwd: root, env: { ...process.env, NODE_ENV: "test" }, timeout: 30_000, maxBuffer: 8_192 }), (error: unknown) => {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        assert.equal(JSON.parse(stdout).category, "invalid_configuration");
        return true;
      });
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
