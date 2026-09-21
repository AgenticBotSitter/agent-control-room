import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { preflightMacosLocalServiceV1 } from "../src/harness/v1/macos-local-service-preflight";

const ownerUid = process.getuid?.() ?? -1;

async function prepared(t: import("node:test").TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-macos-service-")));
  const releaseRoot = join(root, "release");
  const protectedRoot = join(root, "protected");
  const logs = join(protectedRoot, "logs");
  const workingDirectory = join(releaseRoot, "work");
  const launcherPath = join(releaseRoot, "launch.mjs");
  const configurationPath = join(protectedRoot, "config.mjs");
  const standardOutPath = join(logs, "service.out.log");
  const standardErrorPath = join(logs, "service.err.log");
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([mkdir(workingDirectory, { recursive: true }), mkdir(logs, { recursive: true })]);
  await Promise.all([chmod(releaseRoot, 0o700), chmod(protectedRoot, 0o700), chmod(workingDirectory, 0o700), chmod(logs, 0o700)]);
  await Promise.all([writeFile(launcherPath, "export {};\n", { mode: 0o700 }), writeFile(configurationPath, "export {};\n", { mode: 0o600 })]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { label: "xyz.agentcontrolroom.local", nodePath: await realpath(process.execPath), launcherPath,
    configurationPath, workingDirectory, standardOutPath, standardErrorPath, releaseRoot, protectedRoot, ownerUid };
}

test("local service preflight accepts a fixed private release without starting it", async t => {
  const input = await prepared(t);
  const result = await preflightMacosLocalServiceV1(input);
  assert.equal(result.ready, true);
  assert.equal(result.startsWork, false);
  assert.equal(result.package.startsWork, false);
  assert.match(result.package.plist, /<key>ProgramArguments<\/key>/);
});

test("local service preflight rejects unsafe inputs, paths and existing logs", async t => {
  const input = await prepared(t);
  await assert.rejects(preflightMacosLocalServiceV1({ ...input, releaseRoot: `${input.releaseRoot}/..` }), /refused/);
  await chmod(input.protectedRoot, 0o755);
  await assert.rejects(preflightMacosLocalServiceV1(input), /refused/);
  await chmod(input.protectedRoot, 0o700);
  await writeFile(input.standardOutPath, "log", { mode: 0o644 });
  await assert.rejects(preflightMacosLocalServiceV1(input), /refused/);
});

test("local service preflight refuses a symlinked launcher", async t => {
  const input = await prepared(t);
  await rm(input.launcherPath);
  await symlink(input.nodePath, input.launcherPath);
  await assert.rejects(preflightMacosLocalServiceV1(input), /refused/);
});
