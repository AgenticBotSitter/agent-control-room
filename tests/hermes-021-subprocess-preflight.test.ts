import assert from "node:assert/strict";
import test from "node:test";
import { HERMES_021_MACOS_LOCAL_RUNNER_PREFLIGHT_V1,
  preflightHermes021MacosLocalRunnerV1 } from "../src/harness/hermes-021-v1";

const configuration = { executablePath: "/private/runner/hermes", profile: "cr", model: "qwen3.8:27b-long",
  provider: "ollama", workingDirectory: "/private/work" };

test("preflight reads only the required executable and work directory metadata", async () => {
  const seen: string[] = [];
  const result = await preflightHermes021MacosLocalRunnerV1(configuration,
    async path => { seen.push(`access:${path}`); }, async path => {
      seen.push(`stat:${path}`); return { isFile: () => path === configuration.executablePath,
        isDirectory: () => path === configuration.workingDirectory };
    });
  assert.deepEqual(result, { schema: HERMES_021_MACOS_LOCAL_RUNNER_PREFLIGHT_V1, ready: true, startsWork: false });
  assert.deepEqual(seen.sort(), [`access:${configuration.executablePath}`, `stat:${configuration.executablePath}`,
    `stat:${configuration.workingDirectory}`].sort());
});

test("preflight refuses a missing executable or non-directory work folder", async () => {
  await assert.rejects(() => preflightHermes021MacosLocalRunnerV1(configuration,
    async () => { throw new Error("missing"); }, async () => ({ isFile: () => true, isDirectory: () => true })),
  /preflight_unavailable/);
  await assert.rejects(() => preflightHermes021MacosLocalRunnerV1(configuration,
    async () => {}, async () => ({ isFile: () => false, isDirectory: () => false })), /preflight_unavailable/);
});
