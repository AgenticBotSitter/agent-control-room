import assert from "node:assert/strict";
import test from "node:test";
import { capturePrivateClaudeCodeInstalledProcessHostConfigurationV1,
  capturePrivateClaudeCodeProcessAcquisitionConfigurationV1,
  preparePrivateClaudeCodeProcessHostPreflightV1 } from "../src/harness/claude-code-v1/private-process-acquisition";

const config = { executablePath: "/private/fixture/bin/claude", args: ["--print", "--output-format", "stream-json"],
  workingDirectory: "/private/fixture/work", cleanupMs: 20 };
const digest = `sha256:${"1".repeat(64)}`;
test("private Claude host preflight validates only fixed private settings and cannot launch", () => {
  const captured = capturePrivateClaudeCodeProcessAcquisitionConfigurationV1(config);
  assert.deepEqual(captured, { ...config, cleanupMs: 20 });
  assert.deepEqual(preparePrivateClaudeCodeProcessHostPreflightV1(config), {
    schema: "control-room.claude-code-private-process-host-preflight/v1", configured: true,
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false,
  });
});

test("private Claude host preflight refuses executable, working-directory and resume drift", () => {
  assert.throws(() => capturePrivateClaudeCodeProcessAcquisitionConfigurationV1({ ...config, executablePath: "claude" }));
  assert.throws(() => capturePrivateClaudeCodeProcessAcquisitionConfigurationV1({ ...config, workingDirectory: "relative" }));
  assert.throws(() => capturePrivateClaudeCodeProcessAcquisitionConfigurationV1({ ...config, args: ["--resume", "other"] }));
  assert.throws(() => capturePrivateClaudeCodeProcessAcquisitionConfigurationV1({ ...config, args: ["--resume=old-session"] }));
  assert.throws(() => capturePrivateClaudeCodeProcessAcquisitionConfigurationV1({ ...config, args: ["--session-id=old-session"] }));
  assert.throws(() => capturePrivateClaudeCodeProcessAcquisitionConfigurationV1({ ...config, args: ["-r", "old-session"] }));
});

test("captured private arguments cannot be changed after validation", () => {
  const captured = capturePrivateClaudeCodeProcessAcquisitionConfigurationV1(config);
  assert.throws(() => { (captured.args as string[]).push("--resume=old-session"); });
  assert.deepEqual(captured.args, config.args);
});

test("the installed host configuration remains data-only and pins reviewed installation evidence", () => {
  const captured = capturePrivateClaudeCodeInstalledProcessHostConfigurationV1({
    schema: "control-room.claude-code-private-installed-process-host-configuration/v1",
    process: config, executableSha256: digest, workingDirectoryBindingDigest: digest,
    qualificationDigest: digest, startupDeadlineMs: 100, terminateDeadlineMs: 100, killDeadlineMs: 100,
  });
  assert.deepEqual(captured.process.args, config.args);
  assert.equal(captured.qualificationDigest, digest);
  assert.equal(Reflect.ownKeys(captured).includes("launch"), false);
  assert.equal(Reflect.ownKeys(captured).includes("verifyInstallation"), false);
  assert.throws(() => capturePrivateClaudeCodeInstalledProcessHostConfigurationV1({ ...captured, launch() {} }));
});
