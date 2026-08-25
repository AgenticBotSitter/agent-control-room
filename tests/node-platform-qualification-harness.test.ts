import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const harness = join(root, "scripts", "qualification", "platform-key-store-harness.ts");
const readiness = join(root, "scripts", "qualification", "platform-key-store-readiness.ts");
const stageZero = join(root, "scripts", "qualification", "platform-key-store-stage-zero.mjs");
const macosLauncher = join(root, "scripts", "qualification", "macos-attended-launcher.mjs");

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
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

test("qualification harness is pinned to the real provider factory and committed helpers", async () => {
  const source = await readFile(harness, "utf8");
  const swift = await readFile(join(root, "scripts", "qualification", "macos-keychain-fixture.swift"), "utf8");
  const dispatch = await readFile(join(root, "docs", "CR5C9H_PINNED_QUALIFICATION_HARNESSES.md"), "utf8");
  assert.match(source, /createNodePrivateKeyStore/);
  assert.match(source, /from "\.\.\/\.\.\/src\/node-policy\/v1\/index\.ts"/);
  assert.match(source, /macos-keychain-fixture\.swift/);
  assert.match(source, /qualificationStage: macosQualificationStage/);
  for (const stage of [
    "platform_guard", "fixture_compile", "fixture_add", "availability_probe", "key_unlock",
    "sign_verify", "primary_delete", "missing_probe", "cleanup_delete",
  ]) assert.match(source, new RegExp(`macosQualificationStage = "${stage}"`));
  assert.doesNotMatch(source, /Always Allow/i);
  assert.doesNotMatch(source, /\.\.\/\.\.\/src\/node-policy\/v1\/native-key-stores/);
  assert.match(swift, /standardInput\.readDataToEndOfFile/);
  assert.match(swift, /SecItemAdd/);
  assert.doesNotMatch(swift, /CommandLine\.arguments\[[^\]]+\].*(?:password|secret|private)/i);
  assert.match(dispatch, /node --import tsx scripts\/qualification\/platform-key-store-harness\.ts --platform windows/);
  assert.match(dispatch, /node --import tsx scripts\/qualification\/platform-key-store-harness\.ts --platform linux/);
  assert.match(dispatch, /node scripts\/qualification\/macos-attended-launcher\.mjs --service/);
  assert.doesNotMatch(dispatch, /pnpm (?:run |exec )?qualify:keystore/);
});

test("readiness command proves launch prerequisites without native effects", async () => {
  const source = await readFile(readiness, "utf8");
  assert.doesNotMatch(source, /node:child_process|generateKeyPair|randomBytes|createNodePrivateKeyStore|NodeSafeCommandRunner/);
  assert.doesNotMatch(source, /\b(?:writeFile|mkdir|mkdtemp|rm|unlink|chmod|symlink)\b/);
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "tsx", readiness, "--platform", platform,
  ], { cwd: root, timeout: 30_000, maxBuffer: 8_192 });
  assert.doesNotMatch(stderr, /(?:Users|home)[\\/]|BEGIN PRIVATE KEY/i);
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

test("readiness command fails closed for platform and arguments", async () => {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const otherPlatform = platform === "windows" ? "linux" : "windows";
  const cases: Array<{ args: string[]; cwd: string; category: string }> = [
    { args: ["--platform", otherPlatform], cwd: root, category: "wrong_platform" },
    { args: ["--platform", platform, "--unknown", "value"], cwd: root, category: "invalid_arguments" },
    { args: ["--platform", platform, "--operator-ready", "worker-asserted"], cwd: root, category: "invalid_arguments" },
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

test("stage zero uses stock Node and distinguishes prepared from fresh checkouts", async () => {
  const source = await readFile(stageZero, "utf8");
  assert.doesNotMatch(source, /node:child_process|from ["'][^"']*(?:tsx|zod)|\b(?:writeFile|mkdir|mkdtemp|rm|unlink|symlink)\b/);
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const prepared = await execFileAsync(process.execPath, [stageZero, "--platform", platform], {
    cwd: root, timeout: 30_000, maxBuffer: 8_192,
  });
  assert.equal(prepared.stderr, "");
  const preparedResult = JSON.parse(prepared.stdout) as { schema: string; status: string; resolved: string[]; buildPolicy: Record<string, boolean> };
  assert.equal(preparedResult.schema, "control-room.platform-key-store-stage-zero/v1");
  assert.equal(preparedResult.status, "ready_for_runtime_check");
  assert.deepEqual(preparedResult.resolved, ["tsx", "zod"]);
  assert.deepEqual(preparedResult.buildPolicy, { esbuild: false, sharp: false, workerd: false });

  const fixture = await scratch("control-room-stage-zero-fixture-");
  try {
    await mkdir(join(fixture, "scripts", "qualification"), { recursive: true });
    await copyFile(stageZero, join(fixture, "scripts", "qualification", "platform-key-store-stage-zero.mjs"));
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      await copyFile(join(root, name), join(fixture, name));
    }
    await assert.rejects(execFileAsync(process.execPath, [
      join(fixture, "scripts", "qualification", "platform-key-store-stage-zero.mjs"), "--platform", platform,
    ], { cwd: fixture, timeout: 30_000, maxBuffer: 8_192 }), (error: unknown) => {
      assert.equal((error as { code?: number }).code, 2);
      const result = JSON.parse((error as { stdout?: string }).stdout ?? "") as {
        status: string;
        missing: string[];
        preparation: {
          offline: { executable: string; args: string[]; environment: Record<string, string>; network: string };
          onlineRequiresSeparateAuthorization: { executable: string; args: string[]; environment: Record<string, string>; network: string };
        };
      };
      assert.equal(result.status, "setup_required");
      assert.deepEqual(result.missing, ["tsx", "zod"]);
      assert.deepEqual(result.preparation.offline, {
        executable: "pnpm",
        args: ["install", "--frozen-lockfile", "--offline"],
        environment: { CI: "true" },
        network: "forbidden",
      });
      assert.deepEqual(result.preparation.onlineRequiresSeparateAuthorization, {
        executable: "pnpm",
        args: ["install", "--frozen-lockfile"],
        environment: { CI: "true" },
        network: "required",
      });
      return true;
    });
    assert.deepEqual((await readdir(fixture)).sort(), ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts"]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("macOS attended launcher requires an interactive owner terminal before scratch", async () => {
  const source = await readFile(macosLauncher, "utf8");
  assert.match(source, /process\.stdin\.isTTY/);
  assert.match(source, /process\.stderr\.isTTY/);
  assert.match(source, /ALLOW ONCE/);
  assert.match(source, /Never choose Always Allow/);
  assert.match(source, /stdio: \["ignore", "pipe", "inherit"\]/);
  assert.doesNotMatch(source, /\/usr\/bin\/security/);
  await assert.rejects(execFileAsync(process.execPath, [
    macosLauncher, "--service", "control-room.test.owner", "--account", "qualification.test.owner",
  ], { cwd: root, timeout: 30_000, maxBuffer: 8_192 }), (error: unknown) => {
    const result = JSON.parse((error as { stdout?: string }).stdout ?? "") as { schema: string; category: string };
    assert.equal(result.schema, "control-room.macos-attended-qualification-error/v1");
    assert.equal(result.category, process.platform === "darwin" ? "attached_terminal_required" : "wrong_platform");
    return true;
  });
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
