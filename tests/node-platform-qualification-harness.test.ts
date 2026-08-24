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
const readiness = join(root, "scripts", "qualification", "platform-key-store-readiness.ts");

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
  const dispatch = await readFile(join(root, "docs", "CR5C9H_PINNED_QUALIFICATION_HARNESSES.md"), "utf8");
  assert.match(source, /createNodePrivateKeyStore/);
  assert.match(source, /from "\.\.\/\.\.\/src\/node-policy\/v1\/index\.ts"/);
  assert.match(source, /macos-keychain-fixture\.swift/);
  assert.doesNotMatch(source, /Always Allow/i);
  assert.doesNotMatch(source, /\.\.\/\.\.\/src\/node-policy\/v1\/native-key-stores/);
  assert.match(swift, /standardInput\.readDataToEndOfFile/);
  assert.match(swift, /SecItemAdd/);
  assert.doesNotMatch(swift, /CommandLine\.arguments\[[^\]]+\].*(?:password|secret|private)/i);
  assert.match(dispatch, /node --import tsx scripts\/qualification\/platform-key-store-harness\.ts --platform windows/);
  assert.match(dispatch, /node --import tsx scripts\/qualification\/platform-key-store-harness\.ts --platform linux/);
  assert.match(dispatch, /node --import tsx scripts\/qualification\/platform-key-store-harness\.ts --platform macos/);
  assert.doesNotMatch(dispatch, /pnpm (?:run |exec )?qualify:keystore/);
});

test("readiness command proves launch prerequisites without native effects", async () => {
  const source = await readFile(readiness, "utf8");
  assert.doesNotMatch(source, /node:child_process|generateKeyPair|randomBytes|createNodePrivateKeyStore|NodeSafeCommandRunner/);
  assert.doesNotMatch(source, /\b(?:writeFile|mkdir|mkdtemp|rm|unlink|chmod|symlink)\b/);
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const tail = platform === "macos" ? ["--operator-ready", "live-stderr-and-desktop"] : [];
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx", readiness, "--platform", platform, ...tail,
  ], { cwd: root, timeout: 30_000, maxBuffer: 8_192 });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout) as {
    schema: string;
    platform: string;
    ready: boolean;
    checks: Array<{ status: string }>;
    artifacts: { harnessSha256: string; helperSha256?: string };
  };
  assert.equal(result.schema, "control-room.platform-key-store-readiness/v1");
  assert.equal(result.platform, platform);
  assert.equal(result.ready, true);
  assert.ok(result.checks.every((check) => check.status === "pass"));
  assert.match(result.artifacts.harnessSha256, /^[0-9a-f]{64}$/);
  if (platform === "macos") assert.match(result.artifacts.helperSha256!, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(stdout, /(?:Users|home)[\\/]|BEGIN PRIVATE KEY/i);
});

test("readiness command fails closed for platform, arguments, and unattended macOS", async () => {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const otherPlatform = platform === "windows" ? "linux" : "windows";
  const cases: Array<{ args: string[]; cwd: string; category: string }> = [
    { args: ["--platform", otherPlatform], cwd: root, category: "wrong_platform" },
    { args: ["--platform", platform, "--unknown", "value"], cwd: root, category: "invalid_arguments" },
    { args: ["--platform", "macos"], cwd: root, category: "operator_not_ready" },
  ];
  for (const item of cases) {
    await assert.rejects(execFileAsync(process.execPath, ["--import", "tsx", readiness, ...item.args], {
      cwd: item.cwd, timeout: 30_000, maxBuffer: 8_192,
    }), (error: unknown) => {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      assert.deepEqual(JSON.parse(stdout), {
        schema: "control-room.platform-key-store-readiness-error/v1",
        category: item.category,
      });
      return true;
    });
  }
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
