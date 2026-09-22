import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";
import {
  assembleMacosLocalLauncherBundleV1,
  runBoundedMacosLauncherChildV1,
  runMacosLocalLauncherBundleV1,
  verifyExtractedMacosLocalLauncherBundleV1,
} from "../src/installer/v1/macos-local-launcher-bundle.mjs";
import { runLocalLauncherCoreV1 } from "../src/installer/v1/local-launcher-core.mjs";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refusal = { message: "macos_local_launcher_bundle_refused" };
let suiteRoot, releaseDirectory, bundleRoot, assembled;

async function extract(archive, destination) {
  await run("tar", ["-xzf", archive, "-C", destination]);
  return join(destination, "agent-control-room-macos-0.1.0");
}

before(async () => {
  suiteRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-macos-launcher-")));
  releaseDirectory = join(suiteRoot, "release");
  await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: releaseDirectory });
  const output = join(suiteRoot, "bundle-output");
  assembled = await assembleMacosLocalLauncherBundleV1({ sourceRoot: repository, releaseDirectory, outputDirectory: output });
  bundleRoot = await extract(join(output, assembled.archiveName), suiteRoot);
});

after(async () => {
  await rm(suiteRoot, { recursive: true, force: true });
});

test("assembles one deterministic macOS asset with an executable Finder launcher", async () => {
  assert.equal(assembled.assetCount, 1);
  assert.equal(assembled.deterministic, true);
  assert.equal(assembled.platform, "darwin");
  assert.equal(assembled.nodePrerequisite, ">=22.13.0");
  assert.equal(assembled.installsNode, false);
  const secondOutput = join(suiteRoot, "bundle-output-second");
  const second = await assembleMacosLocalLauncherBundleV1({ sourceRoot: repository, releaseDirectory,
    outputDirectory: secondOutput });
  assert.equal(second.archiveSha256, assembled.archiveSha256);
  assert.deepEqual(await readFile(join(secondOutput, second.archiveName)),
    await readFile(join(suiteRoot, "bundle-output", assembled.archiveName)));
  const command = join(bundleRoot, "Open Agent Control Room.command");
  assert.notEqual((await lstat(command)).mode & 0o111, 0);
  const source = await readFile(command, "utf8");
  assert.match(source, /Node\.js 22\.13 or later/u);
  assert.doesNotMatch(source, /curl|wget|brew|npm install/u);
  await run("/bin/sh", ["-n", command]);
  assert.deepEqual(await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot), {
    verified: true, version: "0.1.0", fileCount: 9,
    releaseManifestDigest: `sha256:${createHash("sha256").update(await readFile(join(bundleRoot,
      "release", "agent-control-room-0.1.0.manifest.json"))).digest("hex")}`,
  });
});

test("the shared launcher core accepts a host-neutral handoff without platform policy", async () => {
  const installRoot = join(suiteRoot, "core-install"), journalRoot = join(suiteRoot, "core-journal");
  await mkdir(installRoot, { mode: 0o700 }); await mkdir(journalRoot, { mode: 0o700 });
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) return { exitCode: 0, signal: null,
      stdout: JSON.stringify({ readyForOwnerSetup: true, startsService: false, createsDatabase: false, writesCredentials: false }) };
    if (spec.args[0].endsWith("scripts/launch-local-setup.mjs")) return { exitCode: 0, signal: null,
      stdout: JSON.stringify({ state: "source_only_rehearsal_begun", version: "0.1.0", createsDatabase: false,
        startsService: false, startsWorker: false, launcherComplete: false, productionAcceptanceComplete: false }) };
    return { exitCode: 0, signal: null, stdout: JSON.stringify({
      schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "portable-local", revision: 0,
      planDigest: `sha256:${"c".repeat(64)}`, replayed: false, createsDatabase: false, writesCredentials: false,
      startsService: false, startsWorker: false, enablesAuthority: false, enablesWorkers: false, grantsExecutionAuthority: false,
    }) };
  };
  const verifiedBundle = await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot);
  const report = await runLocalLauncherCoreV1({ verifiedBundle,
    releaseDirectory: join(bundleRoot, "release"), installRoot, journalRoot, installationId: "portable-local",
    topologyPlanDigest: `sha256:${"d".repeat(64)}`, environment: { PATH: "/safe/bin" },
    executable: process.execPath, schema: "example.local-launcher/v1" }, {
    runner, openerRunner: async () => ({ exitCode: 0, signal: null, stdout: "" }), openerExecutable: "/usr/bin/xdg-open",
    async supervisor(spec, dependencies) {
      assert.deepEqual(spec.environment, { PATH: "/safe/bin" });
      assert.equal(typeof dependencies.runOpener, "function");
      assert.equal(dependencies.openerExecutable, "/usr/bin/xdg-open");
      return { state: "setup_host_closed", ready: true, opened: true, reaped: true };
    },
  });
  assert.equal(report.schema, "example.local-launcher/v1");
  assert.equal(report.state, "source_only_setup_prepared");
  assert.equal(calls.length, 3);
  const mismatchInstall = join(suiteRoot, "core-manifest-mismatch");
  await mkdir(mismatchInstall, { mode: 0o700 });
  await assert.rejects(runLocalLauncherCoreV1({ verifiedBundle: { ...verifiedBundle,
    releaseManifestDigest: `sha256:${"e".repeat(64)}` }, releaseDirectory: join(bundleRoot, "release"),
    installRoot: mismatchInstall, journalRoot, installationId: "portable-local",
    topologyPlanDigest: `sha256:${"d".repeat(64)}`, environment: { PATH: "/safe/bin" },
    executable: process.execPath, schema: "example.local-launcher/v1" }, {
    runner: async () => { throw new Error("must not run"); },
    openerRunner: async () => ({ exitCode: 0, signal: null, stdout: "" }), openerExecutable: "/usr/bin/xdg-open",
  }), { message: "local_launcher_core_refused" });
});

test("refuses changed, missing, linked, extra, or any inexact member mode", async () => {
  for (const [name, mutate] of [
    ["changed", root => writeFile(join(root, "runtime/local-release-stager.mjs"), "changed\n")],
    ["missing", root => unlink(join(root, "release/SHA256SUMS"))],
    ["linked", async root => {
      await unlink(join(root, "release/SHA256SUMS"));
      await symlink("../MACOS_LAUNCHER_MANIFEST.json", join(root, "release/SHA256SUMS"));
    }],
    ["extra", root => writeFile(join(root, "extra.txt"), "extra\n")],
    ["command-not-executable", root => chmod(join(root, "Open Agent Control Room.command"), 0o644)],
    ["file-too-open", root => chmod(join(root, "release/SHA256SUMS"), 0o666)],
    ["command-too-open", root => chmod(join(root, "Open Agent Control Room.command"), 0o777)],
    ["special-bits", root => chmod(join(root, "Open Agent Control Room.command"), 0o1755)],
    ["directory-too-open", root => chmod(join(root, "runtime"), 0o777)],
  ]) {
    const target = join(suiteRoot, `mutation-${name}`);
    await mkdir(target);
    const copy = await extract(join(suiteRoot, "bundle-output", assembled.archiveName), target);
    await mutate(copy);
    await assert.rejects(verifyExtractedMacosLocalLauncherBundleV1(copy), refusal, name);
  }
});

test("refuses unsupported systems and old Node before writing an installation root", async () => {
  const home = join(suiteRoot, "unsupported-home");
  await mkdir(home, { mode: 0o700 });
  await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: home }, {
    platform: "linux", architecture: "arm64", nodeVersion: "22.13.0",
  }), { message: "macos_local_launcher_unsupported_platform" });
  await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: home }, {
    platform: "darwin", architecture: "arm64", nodeVersion: "22.12.0",
  }), { message: "macos_local_launcher_node_prerequisite_missing" });
  await assert.rejects(lstat(join(home, "Library")), error => error?.code === "ENOENT");
});

test("composes the existing stager with one stable installation identity without effects", async () => {
  const installRoot = join(suiteRoot, "private-install"), journalRoot = join(suiteRoot, "private-journal");
  const launcherHome = join(suiteRoot, "launcher-home");
  await mkdir(installRoot, { mode: 0o700 }); await mkdir(journalRoot, { mode: 0o700 });
  const calls = [], supervisors = [];
  const runner = async spec => {
    calls.push(spec);
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ readyForOwnerSetup: true,
        startsService: false, createsDatabase: false, writesCredentials: false }), stderr: "" };
    }
    if (spec.args[0].endsWith("scripts/launch-local-setup.mjs")) {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ state: "source_only_rehearsal_begun",
        version: "0.1.0", createsDatabase: false, startsService: false, startsWorker: false,
        launcherComplete: false, productionAcceptanceComplete: false }), stderr: "" };
    }
    if (spec.args[0].endsWith("scripts/initialize-local-installation-plan.mjs")) {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({
        schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "macos-local",
        revision: 0, planDigest: `sha256:${"a".repeat(64)}`, replayed: false,
        createsDatabase: false, writesCredentials: false, startsService: false, startsWorker: false,
        enablesAuthority: false, enablesWorkers: false, grantsExecutionAuthority: false,
      }), stderr: "" };
    }
    throw new Error("unexpected process");
  };
  const report = await runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: launcherHome, installRoot, journalRoot }, {
    platform: "darwin", architecture: "arm64", nodeVersion: "22.13.0", runner,
    async supervisor(spec, dependencies) {
      supervisors.push({ spec, dependencies });
      return { state: "setup_host_closed", ready: true, opened: true, reaped: true };
    },
    hostEnvironment: { PATH: "/safe/bin", HOME: "/private/source-home", TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8", NODE_OPTIONS: "--require=/secret/startup.cjs", BASH_ENV: "/secret/bash-env",
      NPM_TOKEN: "secret", npm_config_userconfig: "/secret/npmrc" },
  });
  assert.equal(report.state, "source_only_setup_prepared");
  assert.equal(report.releaseVerified, true);
  assert.equal(report.preflightPassed, true);
  assert.equal(report.launcherComplete, false);
  assert.equal(report.setupHostOpened, true);
  assert.equal(report.setupHostClosed, true);
  assert.equal(report.installationPlanInitialized, true);
  assert.equal(report.productionAcceptanceComplete, false);
  assert.equal(calls.length, 3);
  assert.match(calls[0].args[0], /versions\/0\.1\.0\/scripts\/prepare-local-installation\.mjs$/u);
  assert.match(calls[1].args[0], /versions\/0\.1\.0\/scripts\/launch-local-setup\.mjs$/u);
  assert.match(calls[2].args[0], /versions\/0\.1\.0\/scripts\/initialize-local-installation-plan\.mjs$/u);
  assert.ok(calls[1].args.includes(join(bundleRoot, "release")));
  assert.ok(calls[1].args.includes("--owner-attended"));
  assert.ok(calls[2].args.includes("--controller-only"));
  assert.ok(calls[2].args.includes("--owner-attended"));
  assert.ok(calls[2].args.includes("--release-digest"));
  const topologyDigest = `sha256:${createHash("sha256").update(JSON.stringify({ placement: "this-computer",
    schema: "control-room.local-launcher-topology/v1" })).digest("hex")}`;
  const topologyIndex = calls[1].args.indexOf("--topology-plan-digest");
  assert.equal(calls[1].args[topologyIndex + 1], topologyDigest);
  for (const call of calls.slice(1)) {
    const idIndex = call.args.indexOf("--installation-id");
    assert.notEqual(idIndex, -1);
    assert.equal(call.args[idIndex + 1], "macos-local");
  }
  assert.deepEqual(calls[0].environment, { PATH: "/safe/bin", HOME: launcherHome,
    TMPDIR: "/private/tmp", LANG: "en_US.UTF-8" });
  assert.equal(calls[0].timeoutMs, 60_000);
  assert.equal(calls[1].timeoutMs, 20 * 60_000);
  assert.equal(calls[2].timeoutMs, 60_000);
  assert.equal(supervisors.length, 1);
  assert.deepEqual(supervisors[0].spec.args, [join(installRoot, "versions", "0.1.0", "scripts", "run-local-setup-host.mjs"),
    "--release-root", join(installRoot, "versions", "0.1.0"), "--journal-root", journalRoot,
    "--installation-id", "macos-local", "--port", "3210"]);
  assert.equal(supervisors[0].dependencies.runOpener, runBoundedMacosLauncherChildV1);
  assert.equal(supervisors[0].dependencies.openerExecutable, "/usr/bin/open");
  for (const key of ["NODE_OPTIONS", "BASH_ENV", "ENV", "NPM_TOKEN", "npm_config_userconfig"]) {
    assert.equal(Object.hasOwn(calls[0].environment, key), false);
  }
});

test("a refused canonical plan bootstrap never starts or opens the setup host", async () => {
  const installRoot = join(suiteRoot, "bootstrap-refusal-install");
  const journalRoot = join(suiteRoot, "bootstrap-refusal-journal");
  const launcherHome = join(suiteRoot, "bootstrap-refusal-home");
  await mkdir(installRoot, { mode: 0o700 });
  await mkdir(journalRoot, { mode: 0o700 });
  let supervisorCalls = 0;
  const runner = async spec => {
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({ readyForOwnerSetup: true,
        startsService: false, createsDatabase: false, writesCredentials: false }), stderr: "",
    };
    if (spec.args[0].endsWith("scripts/launch-local-setup.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({ state: "source_only_rehearsal_begun",
        version: "0.1.0", createsDatabase: false, startsService: false, startsWorker: false,
        launcherComplete: false, productionAcceptanceComplete: false }), stderr: "",
    };
    return { exitCode: 1, signal: null, stdout: "", stderr: "sanitized refusal" };
  };
  await assert.rejects(runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: launcherHome,
    installRoot, journalRoot, installationId: "bootstrap-refusal" }, {
    platform: "darwin", architecture: "arm64", nodeVersion: "22.13.0", runner,
    async supervisor() { supervisorCalls += 1; throw new Error("must not start"); },
  }), { message: "macos_local_launcher_plan_bootstrap_refused" });
  assert.equal(supervisorCalls, 0);
});

test("an exact reopening resumes the saved rehearsal before replaying the canonical plan", async () => {
  const installRoot = join(suiteRoot, "reopen-install");
  const journalRoot = join(suiteRoot, "reopen-journal");
  const launcherHome = join(suiteRoot, "reopen-home");
  await mkdir(installRoot, { mode: 0o700 });
  await mkdir(journalRoot, { mode: 0o700 });
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    if (spec.args[0].endsWith("scripts/prepare-local-installation.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({ readyForOwnerSetup: true,
        startsService: false, createsDatabase: false, writesCredentials: false }), stderr: "",
    };
    if (spec.args.includes("begin")) return { exitCode: 1, signal: null, stdout: "", stderr: "already exists" };
    if (spec.args.includes("resume")) return { exitCode: 0, signal: null, stdout: JSON.stringify({
      state: "source_only_rehearsal_resumed", version: "0.1.0", createsDatabase: false,
      startsService: false, startsWorker: false, launcherComplete: false, productionAcceptanceComplete: false,
    }), stderr: "" };
    if (spec.args[0].endsWith("scripts/initialize-local-installation-plan.mjs")) return {
      exitCode: 0, signal: null, stdout: JSON.stringify({
        schema: "control-room.local-installation-plan-bootstrap/v1", installationId: "macos-local",
        revision: 0, planDigest: `sha256:${"b".repeat(64)}`, replayed: true,
        createsDatabase: false, writesCredentials: false, startsService: false, startsWorker: false,
        enablesAuthority: false, enablesWorkers: false, grantsExecutionAuthority: false,
      }), stderr: "",
    };
    throw new Error("unexpected process");
  };
  let supervisorCalls = 0;
  const report = await runMacosLocalLauncherBundleV1({ bundleRoot, homeDirectory: launcherHome,
    installRoot, journalRoot }, { platform: "darwin", architecture: "arm64", nodeVersion: "22.13.0", runner,
    async supervisor() { supervisorCalls += 1; return { state: "setup_host_closed", ready: true, opened: true, reaped: true }; },
  });
  assert.equal(report.state, "source_only_setup_prepared");
  assert.equal(supervisorCalls, 1);
  const setupModes = calls.filter(call => call.args[0].endsWith("scripts/launch-local-setup.mjs"))
    .map(call => call.args[call.args.indexOf("--mode") + 1]);
  assert.deepEqual(setupModes, ["begin", "resume"]);
  const resume = calls.find(call => call.args.includes("resume"));
  const expectedVersionIndex = resume.args.indexOf("--expected-release-version");
  const expectedDigestIndex = resume.args.indexOf("--expected-release-manifest-digest");
  assert.equal(resume.args[expectedVersionIndex + 1], "0.1.0");
  assert.equal(resume.args[expectedDigestIndex + 1], (await verifyExtractedMacosLocalLauncherBundleV1(bundleRoot)).releaseManifestDigest);
});

test("owned timeout kills the full descendant process group before returning", async () => {
  const marker = join(suiteRoot, "descendant-survived");
  const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => fs.writeFileSync(process.argv[1], "survived\\n"), 450);
setInterval(() => {}, 1000);
`;
  const parent = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
  const result = await runBoundedMacosLauncherChildV1({ executable: process.execPath,
    args: ["-e", parent, marker], cwd: suiteRoot, environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 100, terminationGraceMs: 100 });
  assert.equal(result.timedOut, true);
  await wait(500);
  await assert.rejects(access(marker), error => error?.code === "ENOENT");
});

test("oversized output is retained only to the byte bound and terminates descendants", async () => {
  const marker = join(suiteRoot, "oversized-descendant-survived");
  const descendant = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setTimeout(() => fs.writeFileSync(process.argv[1], "survived\\n"), 450);
setInterval(() => {}, 1000);
`;
  const parent = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: "ignore" });
process.stdout.write(Buffer.alloc(4 * 1024 * 1024, "a"));
process.stderr.write(Buffer.alloc(4 * 1024 * 1024, "b"));
setInterval(() => {}, 1000);
`;
  const result = await runBoundedMacosLauncherChildV1({ executable: process.execPath,
    args: ["-e", parent, marker], cwd: suiteRoot, environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 2_000, terminationGraceMs: 100 });
  assert.equal(result.oversized, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 1024 * 1024);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1024 * 1024);
  assert.equal(Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > 0, true);
  await wait(500);
  await assert.rejects(access(marker), error => error?.code === "ENOENT");
});

test("the command prompt is EOF-safe and preserves success and failure status", async () => {
  const fixture = join(suiteRoot, "command-behavior"), bin = join(fixture, "bin"), runtime = join(fixture, "runtime");
  await mkdir(bin, { recursive: true }); await mkdir(runtime);
  const command = join(fixture, "Open Agent Control Room.command");
  await writeFile(command, await readFile(join(bundleRoot, "Open Agent Control Room.command")), { mode: 0o755 });
  const fakeNode = join(bin, "node");
  await writeFile(fakeNode, "#!/bin/sh\nexit \"$FAKE_NODE_EXIT\"\n", { mode: 0o755 });
  await chmod(fakeNode, 0o755);
  const base = { PATH: `${bin}:/usr/bin:/bin`, HOME: fixture };
  const success = await run("/bin/sh", [command], { env: { ...base, FAKE_NODE_EXIT: "0" }, timeout: 2_000 });
  assert.match(success.stdout, /does not activate/u);
  await assert.rejects(run("/bin/sh", [command], { env: { ...base, FAKE_NODE_EXIT: "7" }, timeout: 2_000 }), error => {
    assert.equal(error?.code, 7);
    assert.match(error?.stdout, /does not activate/u);
    return true;
  });
});

test("assembler CLI requires canonical absolute inputs", async () => {
  await assert.rejects(run(process.execPath, [join(repository, "scripts/assemble-macos-local-launcher.mjs"),
    "--source-root", ".", "--release-directory", releaseDirectory,
    "--output-directory", join(suiteRoot, "bad-cli-output")], { cwd: repository }), error => error?.code === 2);
});
