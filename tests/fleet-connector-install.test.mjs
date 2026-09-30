import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as connector from "../scripts/fleet/connector.mjs";
import { buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";

const SOURCE = resolve("scripts/fleet/connector.mjs");
const WORKER_ID = `fleet-worker:${"a".repeat(32)}`;
// Unattended worker installation is refused unless this exact connector build
// carries its own harness adapter, so the worker tests exercise the real
// bundled release rather than a source checkout.
let bundledRoot, bundledSource, bundledConnector;

test.before(async () => {
  bundledRoot = await mkdtemp(join(tmpdir(), "connector-install-bundle-"));
  const release = await buildFleetConnectorReleaseForTestV1({ root: bundledRoot, builtFrom: "7".repeat(40) });
  bundledSource = join(bundledRoot, release.manifest.file);
  bundledConnector = await import(`${pathToFileURL(bundledSource).href}?install-tests=1`);
});
test.after(async () => { if (bundledRoot) await rm(bundledRoot, { recursive: true, force: true }); });
const WORKING_AGREEMENT = Object.freeze({ version: connector.WORKING_AGREEMENT.version,
  digest: connector.WORKING_AGREEMENT.digest, startsWork: false, grantsAuthority: false });

function code(character) { return `crj_${character.repeat(43)}`; }

function json(ok, result, status = ok ? 200 : 409) {
  return new Response(JSON.stringify(ok ? { ok: true, result } : { ok: false, error: result }), {
    status, headers: { "content-type": "application/json" },
  });
}

function fakeGateway({ rotateDelayMs = 0, resultWorkerKind } = {}) {
  const workerKinds = new Set(["codex", "claude-code", "hermes", "claude-desktop", "cursor", "mcp-agent"]);
  const used = new Set();
  const bindings = new Map();
  const state = { enrollments: 0, rotations: 0, digest: null, dropAfterEnroll: false, dropAfterRotate: false };
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const bearer = String(init.headers?.authorization ?? "").replace(/^Bearer /u, "");
    const authenticated = state.digest && connector.sha256(bearer) === state.digest;
    if (path === "/fleet/v1/enroll") {
      if (!workerKinds.has(body.workerKind)) return json(false, "invalid", 400);
      const prior = bindings.get(body.code);
      if (used.has(body.code) && (prior?.clientNonce !== body.clientNonce || prior?.credentialDigest !== body.credentialDigest))
        return json(false, "code_used", 409);
      if (!used.has(body.code)) {
        used.add(body.code); bindings.set(body.code, body); state.enrollments += 1; state.digest = body.credentialDigest;
        if (state.dropAfterEnroll) { state.dropAfterEnroll = false; throw new Error("enrollment response dropped"); }
      }
      return json(true, { workerId: WORKER_ID, displayName: "Fixture bot", projectIds: ["project:test"],
        workerKind: resultWorkerKind ?? body.workerKind, capabilities: ["writing"],
        credentialExpiresAt: "2099-01-01T00:00:00.000Z", workingAgreement: WORKING_AGREEMENT }, 201);
    }
    if (!authenticated) return json(false, "unauthenticated", 401);
    if (path === "/fleet/v1/rotate") {
      state.rotations += 1;
      if (rotateDelayMs) await new Promise(done => setTimeout(done, rotateDelayMs));
      state.digest = body.newCredentialDigest;
      if (state.dropAfterRotate) { state.dropAfterRotate = false; throw new Error("connection dropped"); }
      return json(true, { credentialExpiresAt: "2099-02-01T00:00:00.000Z" });
    }
    if (path === "/fleet/v1/heartbeat") return json(true, { displayName: "Fixture bot", operationsMode: "running",
      workingAgreement: WORKING_AGREEMENT });
    if (path === "/fleet/v1/me") return json(true, { displayName: "Fixture bot",
      credentialExpiresAt: "2099-02-01T00:00:00.000Z", workingAgreement: WORKING_AGREEMENT });
    throw new Error(`unexpected request ${path}`);
  };
  return { fetcher, state };
}

async function temporary(t, prefix = "connector-install-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function recorder({ failOnce = false, writeHermes = true } = {}) {
  const calls = [];
  let fail = failOnce;
  return {
    calls,
    runner: async (command, args, options = {}) => {
      calls.push([command, args, options]);
      if (fail) { fail = false; throw new Error("registration failed"); }
      if (command === "hermes" && writeHermes) {
        const configPath = join(options.env.HERMES_HOME, "config.yaml");
        await mkdir(dirname(configPath), { recursive: true });
        let raw = "mcp_servers:\n";
        try { raw = await readFile(configPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const server = args[2];
        if (args[1] === "add" && !raw.includes(`  ${server}:`)) raw += `  ${server}:\n    command: fixture\n`;
        if (args[1] === "remove") raw = raw.replace(new RegExp(`  ${server}:\\n    command: fixture\\n`, "u"), "");
        await writeFile(configPath, raw, { mode: 0o600 });
      }
      return { stdout: "", stderr: "" };
    },
  };
}

test("install registers Claude Code, Codex and Hermes with per-bot credentials and explicit workspaces", async t => {
  for (const [index, bot] of ["claude-code", "codex", "hermes"].entries()) {
    await t.test(bot, async t => {
      const homeDir = await temporary(t, `connector-${bot}-`);
      const gateway = fakeGateway(), commands = recorder();
      const name = `${bot}-fixture`;
      const installed = await connector.installConnector({ server: "https://control.example", code: code(String(index + 1)),
        bot, name, homeDir, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE, platform: "linux", env: {} });
      assert.equal(gateway.state.enrollments, 1);
      const saved = await connector.loadConfig(installed.paths.configPath);
      assert.deepEqual(saved.installation, { bot, name, workspace: installed.paths.workspace, state: "installed" });
      assert.equal((await stat(installed.paths.configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(installed.paths.configPath))).mode & 0o777, 0o700);
      assert.equal(commands.calls.length, 1);
      const args = commands.calls[0][1];
      assert.ok(args.includes(installed.paths.shimPath));
      assert.deepEqual(args.slice(-6), ["--profile", name, "--config", installed.paths.configPath,
        "--workspace", installed.paths.workspace]);
      if (bot === "hermes") assert.deepEqual(args.slice(0, 6),
        ["mcp", "add", `control-room-${name}`, "--command", installed.paths.shimPath, "--args"]);
      assert.match(await readFile(installed.paths.shimPath, "utf8"), /connector\.mjs.*mcp/u);
    });
  }
});

test("spawned bot CLIs receive only paths derived from the injected home", async t => {
  const homeDir = await temporary(t, "connector-cli-env-"), gateway = fakeGateway(), commands = recorder();
  const inherited = { PATH: "/fixture/bin", HERMES_HOME: "/live/hermes", CODEX_HOME: "/live/codex",
    CLAUDE_CONFIG_DIR: "/live/claude", XDG_CONFIG_HOME: join(homeDir, "caller-config"),
    XDG_DATA_HOME: join(homeDir, "caller-data"), XDG_CUSTOM_HOME: "/live/custom" };
  await connector.installConnector({ server: "https://control.example", code: code("I"), bot: "hermes",
    name: "isolated", homeDir, platform: "linux", env: inherited, fetcher: gateway.fetcher,
    runner: commands.runner, sourcePath: SOURCE });
  const childEnv = commands.calls[0][2].env;
  assert.equal(childEnv.PATH, inherited.PATH);
  assert.equal(childEnv.HOME, homeDir);
  assert.equal(childEnv.HERMES_HOME, join(homeDir, ".hermes"));
  assert.equal(childEnv.CODEX_HOME, join(homeDir, ".codex"));
  assert.equal(childEnv.CLAUDE_CONFIG_DIR, join(homeDir, ".claude"));
  assert.equal(childEnv.XDG_CONFIG_HOME, join(homeDir, ".config"));
  assert.equal(childEnv.XDG_CUSTOM_HOME, undefined);
});

test("macOS worker install writes a per-bot harness profile and owner LaunchAgent, then removes both", async t => {
  const homeDir = await temporary(t, "connector-mac-worker-"), gateway = fakeGateway(), commands = recorder();
  const input = { server: "https://control.example", code: code("W"), bot: "codex", name: "local-codex",
    homeDir, platform: "darwin", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: bundledSource,
    alsoWorker: true, workerExecutable: "/fixture/bin/codex", workerDeadlineMs: 120_000,
    userId: 501, nodePath: "/fixture/bin/node" };
  const installed = await bundledConnector.installConnector(input);
  const harnesses = JSON.parse(await readFile(installed.paths.harnessesPath, "utf8"));
  assert.deepEqual(harnesses, { schema: "control-room.fleet-harnesses/v1", harnesses: { codex: {
    enabled: true, executablePath: "/fixture/bin/codex", workingDirectory: installed.paths.workspace, deadlineMs: 120_000,
  } } });
  const plist = await readFile(installed.paths.launchAgentPath, "utf8");
  assert.match(plist, /<string>run<\/string>/u);
  assert.match(plist, /<string>--profile<\/string>\s*<string>local-codex<\/string>/u);
  assert.match(plist, /<string>--harnesses<\/string>/u);
  assert.equal(plist.includes((await bundledConnector.loadConfig(installed.paths.configPath)).secret), false);
  assert.equal(plist.includes("HOME"), false, "the plist must not carry an environment block");
  assert.equal((await stat(installed.paths.launchAgentPath)).mode & 0o777, 0o600);
  assert.deepEqual(commands.calls.filter(call => call[0] === "/bin/launchctl").map(call => call[1][0]),
    ["bootout", "bootstrap"]);
  assert.equal((await bundledConnector.loadConfig(installed.paths.configPath)).installation.worker, "launch-agent");

  const installedCopy = await import(`${pathToFileURL(installed.paths.connectorPath).href}?installed-round-trip=1`);
  const accepted = await installedCopy.loadHarnessSettings(installed.paths.harnessesPath);
  assert.equal(accepted.adapterModule, null);
  assert.equal(typeof (await installedCopy.loadHarnessAdapter(accepted, "codex")).execute, "function");

  await bundledConnector.installConnector({ ...input, alsoWorker: false });
  assert.equal((await bundledConnector.loadConfig(installed.paths.configPath)).installation.worker, "launch-agent",
    "an ordinary retry must not orphan an already-running worker service");

  await bundledConnector.uninstallConnector({ bot: input.bot, name: input.name, homeDir, platform: "darwin", env: {},
    runner: commands.runner, realHomeDir: homeDir, userId: 501 });
  await assert.rejects(stat(installed.paths.configPath), error => error.code === "ENOENT");
  await assert.rejects(stat(installed.paths.harnessesPath), error => error.code === "ENOENT");
  await assert.rejects(stat(installed.paths.launchAgentPath), error => error.code === "ENOENT");
});

test("worker install retries safely after launchctl stops halfway without a second enrollment", async t => {
  const homeDir = await temporary(t, "connector-worker-retry-"), gateway = fakeGateway(), commands = recorder();
  let failBootstrap = true;
  const runner = async (...args) => {
    if (args[0] === "/bin/launchctl" && args[1][0] === "bootstrap" && failBootstrap) {
      failBootstrap = false; throw new Error("launchctl stopped with exit 5: fixture failure");
    }
    return commands.runner(...args);
  };
  const input = { server: "https://control.example", code: code("X"), bot: "claude-code", name: "retry-worker",
    homeDir, platform: "darwin", env: {}, fetcher: gateway.fetcher, runner, sourcePath: bundledSource, alsoWorker: true,
    workerExecutable: "/fixture/bin/claude", userId: 501, nodePath: "/fixture/bin/node" };
  await assert.rejects(bundledConnector.installConnector(input), /fixture failure/u);
  assert.equal((await bundledConnector.loadConfig(bundledConnector.connectorInstallPaths(input).configPath)).installation.state, "registering");
  const installed = await bundledConnector.installConnector(input);
  assert.equal(gateway.state.enrollments, 1);
  assert.equal((await bundledConnector.loadConfig(installed.paths.configPath)).installation.state, "installed");
  assert.equal((await bundledConnector.loadConfig(installed.paths.configPath)).installation.worker, "launch-agent");
});

test("real-home installs honor explicit bot profile directories and refuse invalid ones before enrollment", async t => {
  for (const [index, [bot, key]] of [["hermes", "HERMES_HOME"], ["codex", "CODEX_HOME"],
    ["claude-code", "CLAUDE_CONFIG_DIR"]].entries()) {
    await t.test(bot, async t => {
      const homeDir = await temporary(t, `connector-explicit-${bot}-`), gateway = fakeGateway(), commands = recorder();
      const target = join(homeDir, `target-${bot}`), env = { [key]: target };
      await connector.installConnector({ server: "https://control.example", code: code(String.fromCharCode(97 + index)),
        bot, name: `explicit-${bot}`, homeDir, realHomeDir: homeDir, platform: "linux", env,
        fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE });
      assert.equal(commands.calls[0][2].env[key], target);
      if (bot === "hermes") assert.equal((await stat(join(target, "config.yaml"))).isFile(), true);
    });
  }

  const homeDir = await temporary(t, "connector-invalid-profile-"), gateway = fakeGateway();
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: code("v"), bot: "hermes",
    name: "invalid-profile", homeDir, realHomeDir: homeDir, platform: "linux", env: { HERMES_HOME: "relative" },
    fetcher: gateway.fetcher, runner: recorder().runner, sourcePath: SOURCE }), /HERMES_HOME must be an absolute/u);
  assert.equal(gateway.state.enrollments, 0);
});

test("a code for another bot is refused before registration and leaves no profile", async t => {
  const homeDir = await temporary(t, "connector-kind-mismatch-"), gateway = fakeGateway({ resultWorkerKind: "codex" });
  const commands = recorder(), input = { server: "https://control.example", code: code("w"), bot: "claude-code",
    name: "wrong-kind", homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher,
    runner: commands.runner, sourcePath: SOURCE };
  await assert.rejects(connector.installConnector(input), /made for codex, not claude-code.*Nothing was installed/u);
  assert.equal(commands.calls.length, 0);
  await assert.rejects(stat(connector.connectorInstallPaths(input).configPath), error => error.code === "ENOENT");
});

test("the fake gateway refuses an unknown worker kind instead of echoing it", async t => {
  const homeDir = await temporary(t, "connector-unknown-kind-"), configPath = join(homeDir, "unknown.json");
  await assert.rejects(connector.join({ server: "https://control.example", code: code("u"),
    workerKind: "unknown-bot", configPath, fetcher: fakeGateway().fetcher }), /\(invalid\)/u);
  await assert.rejects(stat(configPath), error => error.code === "ENOENT");
});

test("a definitive enrollment refusal is cleanly retryable and a transport-pending profile can be uninstalled", async t => {
  const homeDir = await temporary(t, "connector-refused-enrollment-"), pathsInput = { homeDir, platform: "linux", env: {}, name: "refused" };
  let refuse = true;
  const valid = fakeGateway();
  const fetcher = async (...args) => refuse ? (refuse = false, json(false, "code_expired", 410)) : valid.fetcher(...args);
  const input = { server: "https://control.example", code: code("x"), bot: "cursor", name: "refused", homeDir,
    platform: "linux", env: {}, fetcher, runner: recorder().runner, sourcePath: SOURCE };
  await assert.rejects(connector.installConnector(input), /code_expired/u);
  await assert.rejects(stat(connector.connectorInstallPaths(pathsInput).configPath), error => error.code === "ENOENT");
  await connector.installConnector({ ...input, code: code("y") });

  const pendingHome = await temporary(t, "connector-pending-uninstall-"), dropped = fakeGateway();
  dropped.state.dropAfterEnroll = true;
  const pendingInput = { server: "https://control.example", code: code("z"), bot: "cursor", name: "pending",
    homeDir: pendingHome, platform: "linux", env: {}, fetcher: dropped.fetcher, runner: recorder().runner, sourcePath: SOURCE };
  await assert.rejects(connector.installConnector(pendingInput), /response dropped/u);
  const pendingPath = connector.connectorInstallPaths(pendingInput).configPath;
  assert.equal((await connector.loadConfig(pendingPath)).workerId, null);
  const removed = await connector.uninstallConnector({ bot: "cursor", name: "pending", homeDir: pendingHome,
    platform: "linux", env: {}, runner: recorder().runner });
  assert.match(removed.ownerAction, /Control Room.*Workers/u);
  await assert.rejects(stat(pendingPath), error => error.code === "ENOENT");
});

test("rate limits and timeout responses preserve pending enrollment for an exact retry", async t => {
  for (const [index, [errorCode, status]] of [["rate_limited", 429], [null, 408], [null, 429]].entries()) {
    await t.test(errorCode ?? `http_${status}`, async t => {
      const homeDir = await temporary(t, `connector-transient-${status}-${index}-`), gateway = fakeGateway();
      let first = true;
      const fetcher = async (...args) => {
        if (!first) return gateway.fetcher(...args);
        first = false;
        return new Response(JSON.stringify(errorCode ? { ok: false, error: errorCode } : { ok: false }), {
          status, headers: { "content-type": "application/json" },
        });
      };
      const configPath = join(homeDir, "pending.json"), joinCode = code(String.fromCharCode(114 + index));
      await assert.rejects(connector.join({ server: "https://control.example", code: joinCode,
        workerKind: "cursor", configPath, fetcher }), error => {
        assert.equal(error.code, errorCode ?? `http_${status}`);
        return true;
      });
      const pending = await connector.loadConfig(configPath);
      assert.equal(pending.workerId, null);
      const result = await connector.join({ server: "https://control.example", code: joinCode,
        workerKind: "cursor", configPath, fetcher });
      assert.equal(result.workerKind, "cursor");
      assert.equal(gateway.state.enrollments, 1);
    });
  }
});

test("Hermes zero exit without a saved entry is not reported as installed", async t => {
  const homeDir = await temporary(t, "connector-hermes-postcondition-"), gateway = fakeGateway();
  const input = { server: "https://control.example", code: code("J"), bot: "hermes", name: "missing-entry",
    homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher, runner: recorder({ writeHermes: false }).runner,
    sourcePath: SOURCE };
  await assert.rejects(connector.installConnector(input), /did not save the MCP registration/u);
  assert.equal((await connector.loadConfig(connector.connectorInstallPaths(input).configPath)).installation.state, "registering");
});

test("Hermes zero exit without removing its entry keeps the credential for retry", async t => {
  const homeDir = await temporary(t, "connector-hermes-remove-postcondition-"), gateway = fakeGateway();
  const commands = recorder();
  const input = { server: "https://control.example", code: code("Q"), bot: "hermes", name: "still-registered",
    homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE };
  const installed = await connector.installConnector(input);
  const noRemove = async (command, args, options) => {
    if (command === "hermes" && args[1] === "remove") return { stdout: "", stderr: "" };
    return commands.runner(command, args, options);
  };
  await assert.rejects(connector.uninstallConnector({ bot: "hermes", name: input.name, homeDir,
    platform: "linux", env: {}, runner: noRemove }), /did not remove the MCP registration/u);
  assert.equal((await connector.loadConfig(installed.paths.configPath)).installation.state, "installed");
});

test("the test guard refuses agent CLIs before even an injected spawner is called", async () => {
  let spawned = false;
  await assert.rejects(connector.runCommand("hermes", ["mcp", "list"], {
    env: { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
    spawnProcess: () => { spawned = true; throw new Error("must not spawn"); },
  }), /Test guard refused/u);
  assert.equal(spawned, false);
});

test("Claude Desktop and Cursor JSON merges preserve other servers, back up first, and uninstall only their entry", async t => {
  for (const [index, bot] of ["claude-desktop", "cursor"].entries()) {
    await t.test(bot, async t => {
      const homeDir = await temporary(t, `connector-${bot}-`);
      const gateway = fakeGateway(), name = `${bot}-fixture`;
      const configPath = bot === "cursor" ? join(homeDir, ".cursor", "mcp.json")
        : join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, `${JSON.stringify({ theme: "dark", mcpServers: { existing: { command: "existing" } } })}\n`);
      const installed = await connector.installConnector({ server: "https://control.example", code: code(String(index + 4)),
        bot, name, homeDir, fetcher: gateway.fetcher, runner: recorder().runner, sourcePath: SOURCE, platform: "darwin", env: {} });
      const merged = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(merged.theme, "dark");
      assert.deepEqual(merged.mcpServers.existing, { command: "existing" });
      assert.deepEqual(merged.mcpServers[`control-room-${name}`].args,
        ["--profile", name, "--config", installed.paths.configPath, "--workspace", installed.paths.workspace]);
      assert.equal((await readdir(dirname(configPath))).filter(file => file.includes(".backup-")).length, 1);

      const removed = await connector.uninstallConnector({ bot, name, homeDir, runner: recorder().runner,
        platform: "darwin", env: {} });
      const restored = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(restored, { theme: "dark", mcpServers: { existing: { command: "existing" } } });
      assert.equal((await readdir(dirname(configPath))).filter(file => file.includes(".backup-")).length, 2);
      assert.equal(removed.shimRemoved, false);
      await assert.rejects(stat(installed.paths.configPath), error => error.code === "ENOENT");
      assert.equal((await stat(installed.paths.shimPath)).isFile(), true);
      assert.equal((await stat(installed.paths.workspace)).isDirectory(), true, "uninstall preserves user work");
    });
  }
});

test("desktop configuration updates serialize across profiles and preserve a symlinked target", async t => {
  const homeDir = await temporary(t, "connector-shared-desktop-");
  const cursorDir = join(homeDir, ".cursor"), targetDir = join(homeDir, "dotfiles");
  const configPath = join(cursorDir, "mcp.json"), targetPath = join(targetDir, "cursor.json");
  await mkdir(cursorDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify({ mcpServers: { existing: { command: "existing" } } })}\n`);
  await symlink(targetPath, configPath);
  const installs = Array.from({ length: 20 }, async (_, index) => {
    const gateway = fakeGateway(), name = `shared-${index}`;
    return connector.installConnector({ server: "https://control.example", code: code(String.fromCharCode(65 + index)),
      bot: "cursor", name, homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher,
      runner: recorder().runner, sourcePath: SOURCE });
  });
  await Promise.all(installs);
  assert.equal((await lstat(configPath)).isSymbolicLink(), true);
  const saved = JSON.parse(await readFile(targetPath, "utf8"));
  assert.deepEqual(saved.mcpServers.existing, { command: "existing" });
  assert.equal(Object.keys(saved.mcpServers).filter(name => name.startsWith("control-room-shared-")).length, 20);
});

test("a dangling desktop configuration symlink is refused without replacing it", async t => {
  const homeDir = await temporary(t, "connector-dangling-desktop-"), cursorDir = join(homeDir, ".cursor");
  const configPath = join(cursorDir, "mcp.json");
  await mkdir(cursorDir, { recursive: true });
  await symlink(join(homeDir, "missing", "cursor.json"), configPath);
  const gateway = fakeGateway();
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: code("Z"), bot: "cursor",
    name: "dangling", homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher,
    runner: recorder().runner, sourcePath: SOURCE }), /dangling symbolic link/u);
  assert.equal((await lstat(configPath)).isSymbolicLink(), true);
});

test("Windows installation constructs current-user-only icacls commands and a cmd shim", async t => {
  const homeDir = await temporary(t, "connector-windows-");
  const env = { APPDATA: join(homeDir, "roaming"), LOCALAPPDATA: join(homeDir, "local"), USERNAME: "FixtureUser" };
  const gateway = fakeGateway(), commands = recorder();
  const installed = await connector.installConnector({ server: "https://control.example", code: code("7"), bot: "codex",
    name: "win-codex", homeDir, env, platform: "win32", fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE });
  const acl = commands.calls.filter(call => call[0] === "icacls");
  assert.ok(acl.length >= 4);
  assert.ok(acl.some(call => call[1][0] === installed.paths.configPath));
  assert.ok(acl.every(call => call[1].slice(1).join(" ") === "/inheritance:r /grant:r FixtureUser:F"));
  assert.match(installed.paths.shimPath, /\.cmd$/u);
  assert.match(await readFile(installed.paths.shimPath, "utf8"), /mcp %\*/u);
});

test("a spent code is refused for a second bot profile", async t => {
  const root = await temporary(t, "connector-code-reuse-");
  const gateway = fakeGateway(), commands = recorder(), spent = code("8");
  await connector.installConnector({ server: "https://control.example", code: spent, bot: "codex", name: "first",
    homeDir: join(root, "one"), platform: "linux", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE });
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: spent, bot: "hermes", name: "second",
    homeDir: join(root, "two"), platform: "linux", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE }),
  /code_used/u);
  assert.equal(gateway.state.enrollments, 1);
});

test("installation resumes after registration stops halfway without redeeming the code twice", async t => {
  const homeDir = await temporary(t, "connector-resume-");
  const gateway = fakeGateway(), commands = recorder({ failOnce: true });
  const input = { server: "https://control.example", code: code("9"), bot: "codex", name: "retry-bot", homeDir,
    platform: "linux", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE };
  await assert.rejects(connector.installConnector(input), /registration failed/u);
  const paths = connector.connectorInstallPaths(input);
  assert.equal((await connector.loadConfig(paths.configPath)).installation.state, "registering");
  await connector.installConnector(input);
  assert.equal(gateway.state.enrollments, 1);
  assert.equal((await connector.loadConfig(paths.configPath)).installation.state, "installed");
});

test("installation retries a dropped enrollment response with the saved nonce and secret", async t => {
  const homeDir = await temporary(t, "connector-enrollment-retry-");
  const gateway = fakeGateway(); gateway.state.dropAfterEnroll = true;
  const input = { server: "https://control.example", code: code("D"), bot: "codex", name: "lost-response", homeDir,
    platform: "linux", env: {}, fetcher: gateway.fetcher, runner: recorder().runner, sourcePath: SOURCE };
  await assert.rejects(connector.installConnector(input), /enrollment response dropped/u);
  await connector.installConnector(input);
  assert.equal(gateway.state.enrollments, 1);
  assert.equal((await connector.loadConfig(connector.connectorInstallPaths(input).configPath)).installation.state, "installed");
});

test("CLI-backed uninstall removes each registration and keeps the graceful shared shim", async t => {
  const homeDir = await temporary(t, "connector-cli-uninstall-");
  const gateway = fakeGateway(), commands = recorder();
  for (const [index, bot] of ["claude-code", "codex", "hermes"].entries()) {
    const name = `${bot}-remove`;
    await connector.installConnector({ server: "https://control.example", code: code(String.fromCharCode(69 + index)), bot,
      name, homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE });
  }
  const firstPaths = connector.connectorInstallPaths({ homeDir, platform: "linux", env: {}, name: "claude-code-remove" });
  const first = await connector.uninstallConnector({ bot: "claude-code", name: "claude-code-remove", homeDir,
    platform: "linux", env: {}, runner: commands.runner });
  assert.equal(first.shimRemoved, false);
  assert.equal((await stat(firstPaths.shimPath)).isFile(), true);
  await connector.uninstallConnector({ bot: "codex", name: "codex-remove", homeDir,
    platform: "linux", env: {}, runner: commands.runner });
  const last = await connector.uninstallConnector({ bot: "hermes", name: "hermes-remove", homeDir,
    platform: "linux", env: {}, runner: commands.runner });
  assert.equal(last.shimRemoved, false);
  assert.equal((await stat(firstPaths.shimPath)).isFile(), true);
  assert.deepEqual(commands.calls.filter(call => call[1][1] === "remove").map(call => call[0]), ["claude", "codex", "hermes"]);
});

test("uninstall tolerates an already-missing CLI entry and removes credential temp files", async t => {
  const homeDir = await temporary(t, "connector-missing-cli-entry-"), gateway = fakeGateway(), commands = recorder();
  const input = { server: "https://control.example", code: code("n"), bot: "codex", name: "already-removed",
    homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE };
  const installed = await connector.installConnector(input);
  const orphan = `${installed.paths.configPath}.999999.dead.tmp`;
  await writeFile(orphan, "secret fixture\n", { mode: 0o600 });
  const missingRunner = async (command, args, options) => {
    if (command === "codex" && args[1] === "remove") throw new Error("No such server");
    return commands.runner(command, args, options);
  };
  await connector.uninstallConnector({ bot: "codex", name: input.name, homeDir,
    platform: "linux", env: {}, runner: missingRunner });
  await assert.rejects(stat(installed.paths.configPath), error => error.code === "ENOENT");
  await assert.rejects(stat(orphan), error => error.code === "ENOENT");
});

test("bad install input and real-home CLI use fail before enrollment", async t => {
  const homeDir = await temporary(t, "connector-refusal-");
  await assert.rejects(connector.join({ server: "https://control.example", code: code("A"), configPath: join(homeDir, "join.json"),
    fetcher: async () => { throw new Error("must not call"); } }), /worker kind is required/u);
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: code("A"), bot: "other",
    name: "bad", homeDir }), /Choose one bot/u);
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: code("A"), bot: "codex",
    name: "bad/name", homeDir }), /bot name/u);
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: code("A"), bot: "codex",
    name: "bad", workspace: "relative", homeDir }), /absolute directory/u);
  let out = "", err = "";
  const status = await connector.main(["install", "--server", "https://control.example", "--code", code("A"),
    "--bot", "codex", "--name", "real"], { out: { write: value => { out += value; } }, err: { write: value => { err += value; } } },
  { homeDir, realHomeDir: homeDir, fetcher: async () => { throw new Error("must not call"); } });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.match(err, /Refusing to change a real home/u);
  err = "";
  const mcpStatus = await connector.main(["mcp", "--profile", "real"],
    { out: { write: () => {} }, err: { write: value => { err += value; } } }, { homeDir, realHomeDir: homeDir });
  assert.equal(mcpStatus, 1);
  assert.match(err, /explicit --workspace/u);
  for (const [workspace, message] of [["relative", /absolute directory/u],
    [join(homeDir, "missing"), /could not be checked safely/u]]) {
    err = "";
    const invalidWorkspaceStatus = await connector.main(["mcp", "--profile", "real", "--workspace", workspace],
      { out: { write: () => {} }, err: { write: value => { err += value; } } }, { homeDir, realHomeDir: homeDir });
    assert.equal(invalidWorkspaceStatus, 1);
    assert.match(err, message);
  }
  const fileWorkspace = join(homeDir, "not-a-directory");
  await writeFile(fileWorkspace, "fixture\n");
  err = "";
  const fileWorkspaceStatus = await connector.main(["mcp", "--profile", "real", "--workspace", fileWorkspace],
    { out: { write: () => {} }, err: { write: value => { err += value; } } }, { homeDir, realHomeDir: homeDir });
  assert.equal(fileWorkspaceStatus, 1);
  assert.match(err, /must exist and be a directory/u);
});

test("bad worker-install input is refused before enrollment", async t => {
  const homeDir = await temporary(t, "connector-worker-refusal-"), gateway = fakeGateway();
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: code("A"), bot: "codex",
    name: "linux-worker", homeDir, platform: "linux", alsoWorker: true }), /macOS only/u);
  await assert.rejects(connector.installConnector({ server: "https://control.example", code: code("A"), bot: "codex",
    name: "source-worker", homeDir, platform: "darwin", alsoWorker: true, workerExecutable: "/fixture/bin/codex",
    userId: 501, fetcher: gateway.fetcher }), /requires the bundled Control Room connector release/u);
  await assert.rejects(bundledConnector.installConnector({ server: "https://control.example", code: code("A"),
    bot: "cursor", name: "desktop-worker", homeDir, platform: "darwin", alsoWorker: true }), /Only Claude Code/u);
  await assert.rejects(bundledConnector.installConnector({ server: "https://control.example", code: code("A"),
    bot: "hermes", name: "hermes-worker", homeDir, platform: "darwin", alsoWorker: true }), /requires --worker-profile/u);
  const workerBase = { server: "https://control.example", code: code("A"), bot: "codex", name: "invalid-worker",
    homeDir, platform: "darwin", alsoWorker: true, userId: 501, fetcher: gateway.fetcher };
  await assert.rejects(bundledConnector.installConnector({ ...workerBase, sourcePath: bundledSource, workerExecutable: "relative" }), /absolute path/u);
  await assert.rejects(bundledConnector.installConnector({ ...workerBase, sourcePath: bundledSource, workerExecutable: "/fixture/bin/codex",
    workerDeadlineMs: 99 }), /worker deadline/u);
  await assert.rejects(bundledConnector.installConnector({ ...workerBase, sourcePath: bundledSource, workerExecutable: "/fixture/bin/codex",
    workerModel: "gpt-build" }), /model selection/u);
  await assert.rejects(bundledConnector.installConnector({ ...workerBase, sourcePath: bundledSource, workerExecutable: "/fixture/bin/codex",
    nodePath: "relative" }), /Node executable/u);
  await assert.rejects(bundledConnector.installConnector({ ...workerBase, sourcePath: bundledSource, workerExecutable: "/fixture/bin/codex",
    userId: 0 }), /user id/u);
  assert.equal(gateway.state.enrollments, 0, "all worker input refusals happen before enrollment");
});

test("an explicit credential path overrides profile-derived lookup", async t => {
  const homeDir = await temporary(t, "connector-explicit-config-"), configPath = join(homeDir, "chosen.json");
  const secret = `crf_${"V".repeat(43)}`;
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2099-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  let out = "";
  const status = await connector.main(["status", "--profile", "different", "--config", configPath],
    { out: { write: value => { out += value; } }, err: { write: () => {} } },
    { homeDir, realHomeDir: homeDir, fetcher: async url => {
      assert.equal(new URL(url).pathname, "/fleet/v1/heartbeat");
      return json(true, { displayName: "Chosen", workingAgreement: WORKING_AGREEMENT });
    } });
  assert.equal(status, 0);
  assert.match(out, /Chosen/u);
});

test("install refuses unsafe workspace roots and preserves an existing workspace mode", async t => {
  const homeDir = await temporary(t, "connector-workspace-guard-"), gateway = fakeGateway();
  const base = { server: "https://control.example", code: code("o"), bot: "cursor", name: "workspace",
    homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher, runner: recorder().runner, sourcePath: SOURCE };
  const paths = connector.connectorInstallPaths(base);
  for (const workspace of [homeDir, paths.configRoot, dirname(paths.configRoot)]) {
    await assert.rejects(connector.installConnector({ ...base, workspace }), /workspace (?:cannot be|must be separate)/u);
  }
  assert.equal(gateway.state.enrollments, 0);

  const existing = join(homeDir, "shared-project");
  await mkdir(existing, { mode: 0o750 });
  await chmod(existing, 0o750);
  await connector.installConnector({ ...base, workspace: existing, code: code("p") });
  assert.equal((await stat(existing)).mode & 0o777, 0o750);
});

test("ten concurrent rotations make exactly one server rotation and stale locks recover", async t => {
  const homeDir = await temporary(t, "connector-rotation-");
  const path = join(homeDir, "bot.json");
  const secret = `crf_${"B".repeat(43)}`;
  await writeFile(path, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  const gateway = fakeGateway({ rotateDelayMs: 50 }); gateway.state.digest = connector.sha256(secret);
  const results = await Promise.all(Array.from({ length: 10 }, () => connector.rotate({ configPath: path, fetcher: gateway.fetcher })));
  assert.equal(gateway.state.rotations, 1);
  assert.equal(results.filter(value => value.coalesced === true).length, 9);

  const stale = `${path}.rotate.lock`;
  await writeFile(stale, `${JSON.stringify({ pid: 777777, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  await connector.rotate({ configPath: path, fetcher: gateway.fetcher,
    lock: { staleMs: 1_000, deadlineMs: 100, isPidAlive: pid => pid !== 777777 } });
  assert.equal(gateway.state.rotations, 2);
  await assert.rejects(stat(stale), error => error.code === "ENOENT");

  await writeFile(stale, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(0).toISOString() })}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(stale, old, old);
  await assert.rejects(connector.rotate({ configPath: path, fetcher: gateway.fetcher,
    lock: { staleMs: 1, deadlineMs: 20, waitMs: 5, isPidAlive: () => true } }), /Another session/u);
  await rm(stale);

  await mkdir(stale);
  await utimes(stale, old, old);
  await assert.rejects(connector.rotate({ configPath: path, fetcher: gateway.fetcher,
    lock: { staleMs: 1, deadlineMs: 100, waitMs: 5 } }), error => {
    assert.match(error.message, /stale but has no owner record/u);
    assert.ok(error.message.includes(stale), "the owner receives the exact stale-lock path");
    return true;
  });
  assert.equal(gateway.state.rotations, 2);
  await rm(stale, { recursive: true });

  await writeFile(stale, "{\"pid\":", { mode: 0o600 });
  await utimes(stale, old, old);
  await assert.rejects(connector.rotate({ configPath: path, fetcher: gateway.fetcher,
    lock: { staleMs: 1, deadlineMs: 20, waitMs: 5 } }), /stale but has no valid owner PID/u);
  await rm(stale);

  await mkdir(stale);
  await writeFile(join(stale, `owner-${"e".repeat(32)}.json`), `${JSON.stringify({ pid: 777777 })}\n`);
  await writeFile(join(stale, "unexpected"), "fixture\n");
  await utimes(stale, old, old);
  await assert.rejects(connector.rotate({ configPath: path, fetcher: gateway.fetcher,
    lock: { staleMs: 1, deadlineMs: 20, waitMs: 5 } }), /stale but has no valid owner PID/u);
  await rm(stale, { recursive: true });
});

test("unlock removes only a stale empty profile lock after excluding live contenders", async t => {
  const homeDir = await temporary(t, "connector-unlock-"), name = "wedged";
  const paths = connector.connectorInstallPaths({ homeDir, platform: "linux", env: {}, name });
  const lockPath = `${paths.configPath}.rotate.lock`, old = new Date(Date.now() - 60_000);
  await mkdir(lockPath, { recursive: true });
  await utimes(lockPath, old, old);
  let out = "", err = "";
  const status = await connector.main(["unlock", "--name", name],
    { out: { write: value => { out += value; } }, err: { write: value => { err += value; } } },
    { homeDir, realHomeDir: join(homeDir, "real"), platform: "linux", env: {}, staleMs: 1 });
  assert.equal(status, 0, err);
  assert.match(out, /"unlocked": "wedged"/u);
  await assert.rejects(stat(lockPath), error => error.code === "ENOENT");

  await mkdir(lockPath);
  await assert.rejects(connector.unlockConnector({ name, homeDir, platform: "linux", env: {}, staleMs: 60_000 }),
    /not stale yet/u);
  await writeFile(join(lockPath, `owner-${"a".repeat(32)}.json`), "{}\n");
  await utimes(lockPath, old, old);
  await assert.rejects(connector.unlockConnector({ name, homeDir, platform: "linux", env: {}, staleMs: 1 }),
    /has an owner record/u);
  await rm(lockPath, { recursive: true });

  await mkdir(lockPath);
  await utimes(lockPath, old, old);
  const token = "b".repeat(32), contender = `${lockPath}.${process.pid}.${token}.tmp`;
  await writeFile(contender, `${JSON.stringify({ pid: process.pid, processIdentity: "same", token })}\n`, { mode: 0o600 });
  await assert.rejects(connector.unlockConnector({ name, homeDir, platform: "linux", env: {}, staleMs: 1,
    isPidAlive: () => true, getProcessIdentity: async () => "same" }), /still running/u);
  assert.equal((await stat(lockPath)).isDirectory(), true);
  await connector.unlockConnector({ name, homeDir, platform: "linux", env: {}, staleMs: 1,
    isPidAlive: () => false, getProcessIdentity: async () => null });
  await assert.rejects(stat(contender), error => error.code === "ENOENT");

  await mkdir(lockPath);
  await utimes(lockPath, old, old);
  await assert.rejects(connector.unlockConnector({ name, homeDir, platform: "linux", env: {}, staleMs: 1,
    beforeRemovalCheck: async () => { await rmdir(lockPath); await mkdir(lockPath); },
  }), /changed while unlock was checking/u);
  assert.equal((await stat(lockPath)).isDirectory(), true);
  await rmdir(lockPath);

  await mkdir(lockPath);
  await utimes(lockPath, old, old);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => connector.unlockConnector({
    name, homeDir, platform: "linux", env: {}, staleMs: 1,
  })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 19);
  for (const result of results.filter(result => result.status === "rejected"))
    assert.match(result.reason?.message ?? "", /Another unlock check|No credential lock exists/u);
});

test("a reused live PID does not preserve a dead owner generation", async t => {
  const root = await temporary(t, "connector-pid-reuse-"), lockPath = join(root, "bot.rotate.lock");
  const token = "c".repeat(32), ownerPath = join(lockPath, `owner-${token}.json`);
  await mkdir(lockPath);
  await writeFile(ownerPath, `${JSON.stringify({ pid: 777777, processIdentity: "old-process", token })}\n`, { mode: 0o600 });
  const release = await connector.acquireRotationLock(lockPath, {
    deadlineMs: 100,
    isPidAlive: () => true,
    getProcessIdentity: async pid => pid === 777777 ? "reused-process" : "test-process",
  });
  await release();
  await assert.rejects(stat(lockPath), error => error.code === "ENOENT");
});

test("a live process generation is never cleaned merely because its lock is old", async t => {
  const root = await temporary(t, "connector-live-generation-"), lockPath = join(root, "bot.rotate.lock");
  const token = "d".repeat(32), ownerPath = join(lockPath, `owner-${token}.json`);
  await mkdir(lockPath);
  await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, processIdentity: "same-process", token })}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await assert.rejects(connector.acquireRotationLock(lockPath, {
    staleMs: 1,
    deadlineMs: 30,
    waitMs: 5,
    isPidAlive: () => true,
    getProcessIdentity: async () => "same-process",
  }), /Another session is renewing/u);
  assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")),
    { pid: process.pid, processIdentity: "same-process", token });
});

test("the lock stress probe stops children after a no-progress timeout", async () => {
  const child = spawn(process.execPath, ["scripts/fleet/stress-connector-lock.mjs", "1", "40", "0.05"], {
    cwd: resolve("."),
    env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", CONTROL_ROOM_STRESS_NO_PROGRESS_TIMEOUT_MS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "", forced = false;
  child.stderr.on("data", chunk => { stderr += chunk; });
  const force = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 5_000);
  const code = await new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", resolveClose);
  });
  clearTimeout(force);
  assert.equal(forced, false);
  assert.notEqual(code, 0);
  assert.match(stderr, /made no progress for 1 ms/u);
});

test("fifty cross-process rotations stay exclusive and recover an actually killed owner", async t => {
  const homeDir = await temporary(t, "connector-process-rotation-");
  const configPath = join(homeDir, "bot.json"), secret = `crf_${"R".repeat(43)}`;
  const state = { digest: connector.sha256(secret), rotations: 0, activeRotations: 0, maximumActiveRotations: 0, blockNext: false };
  let blockedRequestStarted, allowBlockedRequest, blockedRequestFinished;
  let blockedStarted = Promise.resolve(), blockedAllowed = Promise.resolve(), blockedFinished = Promise.resolve();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const bearer = String(request.headers.authorization ?? "").replace(/^Bearer /u, "");
    if (connector.sha256(bearer) !== state.digest) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "unauthenticated" }));
      return;
    }
    if (request.url === "/fleet/v1/rotate") {
      state.rotations += 1;
      state.activeRotations += 1;
      state.maximumActiveRotations = Math.max(state.maximumActiveRotations, state.activeRotations);
      if (state.blockNext) {
        state.blockNext = false;
        blockedRequestStarted();
        await blockedAllowed;
      }
      await new Promise(done => setTimeout(done, 100));
      state.digest = body.newCredentialDigest;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { credentialExpiresAt: "2099-02-01T00:00:00.000Z",
        workingAgreement: WORKING_AGREEMENT } }));
      state.activeRotations -= 1;
      blockedRequestFinished?.();
      return;
    }
    if (request.url === "/fleet/v1/me") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { credentialExpiresAt: "2099-02-01T00:00:00.000Z",
        workingAgreement: WORKING_AGREEMENT } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1",
    server: `http://127.0.0.1:${address.port}`, workerId: WORKER_ID, secret,
    credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });

  const childSource = `
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const { rotate } = await import(pathToFileURL(resolve("scripts/fleet/connector.mjs")).href);
    try {
      process.send("ready");
      await new Promise(resolveStart => process.once("message", resolveStart));
      process.disconnect();
      const result = await rotate({ configPath: process.argv[1] });
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stderr.write(String(error?.stack ?? error));
      process.exitCode = 1;
    }
  `;
  const rotateInProcess = () => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, configPath], {
      cwd: resolve("."), env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const ready = new Promise((resolveReady, rejectReady) => {
      child.once("message", message => message === "ready" ? resolveReady() : rejectReady(new Error("child was not ready")));
      child.once("error", rejectReady);
    });
    const done = new Promise(resolveChild => {
      child.once("error", error => resolveChild({ code: null, stdout, stderr: String(error) }));
      child.once("close", code => resolveChild({ code, stdout, stderr }));
    });
    return { child, ready, done };
  };
  const runBurst = async () => {
    const processes = Array.from({ length: 50 }, rotateInProcess);
    await Promise.all(processes.map(childProcess => childProcess.ready));
    for (const childProcess of processes) childProcess.child.send("rotate");
    return Promise.all(processes.map(childProcess => childProcess.done));
  };
  const results = await runBurst();
  assert.deepEqual(results.filter(result => result.code !== 0), [],
    `all child rotations must succeed: ${JSON.stringify(results.filter(result => result.code !== 0))}`);
  assert.equal(state.rotations, 1);
  assert.equal(state.maximumActiveRotations, 1);
  assert.equal(results.filter(result => JSON.parse(result.stdout).coalesced === true).length, 49);
  assert.deepEqual((await readdir(homeDir)).filter(file => file.endsWith(".rotate.lock") || file.endsWith(".tmp")), []);

  blockedStarted = new Promise(resolveStarted => { blockedRequestStarted = resolveStarted; });
  blockedAllowed = new Promise(resolveAllowed => { allowBlockedRequest = resolveAllowed; });
  blockedFinished = new Promise(resolveFinished => { blockedRequestFinished = resolveFinished; });
  state.blockNext = true;
  const killedOwner = rotateInProcess();
  await killedOwner.ready;
  killedOwner.child.send("rotate");
  await blockedStarted;
  const lockPath = `${configPath}.rotate.lock`;
  assert.equal((await readdir(lockPath)).filter(file => file.startsWith("owner-")).length, 1);
  killedOwner.child.kill("SIGKILL");
  const killedResult = await killedOwner.done;
  assert.notEqual(killedResult.code, 0);
  allowBlockedRequest();
  await blockedFinished;

  const recovered = await runBurst();
  assert.deepEqual(recovered.filter(result => result.code !== 0), [],
    `all dead-lock recovery callers must succeed: ${JSON.stringify(recovered.filter(result => result.code !== 0))}`);
  assert.equal(state.rotations, 2);
  assert.equal(state.maximumActiveRotations, 1);
  assert.equal(recovered.filter(result => JSON.parse(result.stdout).coalesced === true).length, 50);
  assert.deepEqual((await readdir(homeDir)).filter(file => file.endsWith(".rotate.lock") || file.endsWith(".tmp")), []);
});

test("directory election admits only one contender before owner publication", async t => {
  const homeDir = await temporary(t, "connector-directory-election-");
  const configPath = join(homeDir, "bot.json"), secret = `crf_${"E".repeat(43)}`;
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const gateway = fakeGateway({ rotateDelayMs: 20 });
  gateway.state.digest = connector.sha256(secret);
  let firstElected, releaseFirst;
  const firstHasDirectory = new Promise(resolveElected => { firstElected = resolveElected; });
  const firstMayPublish = new Promise(resolveRelease => { releaseFirst = resolveRelease; });
  let secondElected = false;
  const first = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: {
    afterDirectoryElection: async () => { firstElected(); await firstMayPublish; },
  } });
  await firstHasDirectory;
  const second = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: {
    afterDirectoryElection: async () => { secondElected = true; await firstMayPublish; },
  } });
  try {
    await new Promise(done => setTimeout(done, 75));
    assert.equal(secondElected, false);
  } finally {
    releaseFirst();
    await Promise.allSettled([first, second]);
  }
});

test("a publication failure never blindly removes the elected lock directory", async t => {
  const homeDir = await temporary(t, "connector-publication-failure-");
  const configPath = join(homeDir, "bot.json"), secret = `crf_${"F".repeat(43)}`;
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const lockPath = `${configPath}.rotate.lock`;
  await assert.rejects(connector.rotate({ configPath, fetcher: fakeGateway().fetcher,
    lock: { afterDirectoryElection: async () => { throw new Error("publication stopped"); } } }), /publication stopped/u);
  assert.equal((await stat(lockPath)).isDirectory(), true);
  assert.deepEqual(await readdir(lockPath), []);
  await rm(lockPath, { recursive: true });
});

test("an elected cleaner rechecks the observed generation and dead PID before removing it", async t => {
  const homeDir = await temporary(t, "connector-cleaner-recheck-"), lockPath = join(homeDir, "bot.rotate.lock");
  const deadToken = "b".repeat(32), ownerPath = join(lockPath, `owner-${deadToken}.json`);
  await mkdir(lockPath);
  await writeFile(ownerPath, `${JSON.stringify({ pid: 777777, token: deadToken })}\n`, { mode: 0o600 });
  let replaced = false;
  await assert.rejects(connector.acquireRotationLock(lockPath, { deadlineMs: 50, waitMs: 5,
    isPidAlive: pid => pid === process.pid,
    beforeDeadOwnerCleanup: async () => {
      if (replaced) return;
      replaced = true;
      await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token: deadToken })}\n`, { mode: 0o600 });
    },
  }), /Another session/u);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).pid, process.pid);
});

test("rotation release refuses to remove a lock whose ownership token changed", async t => {
  const homeDir = await temporary(t, "connector-lock-owner-");
  const configPath = join(homeDir, "bot.json"), secret = `crf_${"T".repeat(43)}`;
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  let releaseRequest, allowResponse;
  const requestStarted = new Promise(resolveStarted => { releaseRequest = resolveStarted; });
  const responseAllowed = new Promise(resolveAllowed => { allowResponse = resolveAllowed; });
  const fetcher = async (url, init) => {
    assert.equal(new URL(url).pathname, "/fleet/v1/rotate");
    releaseRequest();
    await responseAllowed;
    return json(true, { credentialExpiresAt: "2099-02-01T00:00:00.000Z" });
  };
  const rotating = connector.rotate({ configPath, fetcher });
  await requestStarted;
  const lockPath = `${configPath}.rotate.lock`;
  const [ownerFile] = await readdir(lockPath);
  const ownerPath = join(lockPath, ownerFile);
  const replacement = { pid: process.pid, acquiredAt: new Date().toISOString(), token: "replacement" };
  await writeFile(ownerPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  allowResponse();
  await assert.rejects(rotating, /lock changed owners/u);
  assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), replacement);
  await rm(lockPath, { recursive: true });
});

test("a lock release failure does not hide the protected operation failure", async t => {
  const homeDir = await temporary(t, "connector-release-error-"), configPath = join(homeDir, "bot.json");
  const secret = `crf_${"U".repeat(43)}`;
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const fetcher = async () => {
    const lockPath = `${configPath}.rotate.lock`, [ownerFile] = await readdir(lockPath);
    await writeFile(join(lockPath, ownerFile), `${JSON.stringify({ pid: process.pid, token: "replacement" })}\n`, { mode: 0o600 });
    throw new Error("protected operation failed");
  };
  await assert.rejects(connector.rotate({ configPath, fetcher }), error => {
    assert.match(error.message, /protected operation failed/u);
    assert.match(error.cause?.message ?? "", /lock changed owners/u);
    return true;
  });
  await rm(`${configPath}.rotate.lock`, { recursive: true });
});

test("two dead-owner cleaners cannot remove a later lock generation", async t => {
  const homeDir = await temporary(t, "connector-lock-generation-");
  const configPath = join(homeDir, "bot.json"), secret = `crf_${"G".repeat(43)}`;
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const gateway = fakeGateway({ rotateDelayMs: 50 });
  gateway.state.digest = connector.sha256(secret);
  const lockPath = `${configPath}.rotate.lock`, deadToken = "0".repeat(32);
  await mkdir(lockPath);
  await writeFile(join(lockPath, `owner-${deadToken}.json`), `${JSON.stringify({ pid: 777777,
    acquiredAt: new Date().toISOString(), token: deadToken })}\n`, { mode: 0o600 });
  let laggerObserved, replacementPublished, releaseReplacement;
  const laggerHasRead = new Promise(resolveLagger => { laggerObserved = resolveLagger; });
  const replacementHasOwner = new Promise(resolvePublication => { replacementPublished = resolvePublication; });
  const replacementMayContinue = new Promise(resolveRelease => { releaseReplacement = resolveRelease; });
  let laggerAcquired = false;
  const cleaner = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: { isPidAlive: pid => pid !== 777777,
    beforeDeadOwnerCleanup: async () => laggerHasRead,
    afterOwnerPublication: async () => { replacementPublished(); await replacementMayContinue; } } });
  const lagger = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: { isPidAlive: pid => pid !== 777777,
    beforeDeadOwnerCleanup: async () => {
      laggerObserved();
      await replacementHasOwner;
    },
    afterOwnerPublication: async () => { laggerAcquired = true; } } });
  try {
    await replacementHasOwner;
    await new Promise(done => setTimeout(done, 75));
    assert.equal(laggerAcquired, false);
  } finally { releaseReplacement(); }
  const results = await Promise.all([cleaner, lagger]);
  assert.equal(gateway.state.rotations, 1);
  assert.equal(results.filter(result => result.coalesced === true).length, 1);
  assert.equal((await readdir(homeDir)).filter(file => file === `${basename(lockPath)}.reap-${deadToken}`).length, 1,
    "one exclusive marker elects the cleaner for the observed generation");
});

test("a losing stale cleaner cannot remove a new winner before owner publication", async t => {
  const homeDir = await temporary(t, "connector-lock-publication-gap-");
  const configPath = join(homeDir, "bot.json"), secret = `crf_${"P".repeat(43)}`;
  await writeFile(configPath, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const gateway = fakeGateway({ rotateDelayMs: 20 });
  gateway.state.digest = connector.sha256(secret);
  const lockPath = `${configPath}.rotate.lock`, deadToken = "a".repeat(32);
  await mkdir(lockPath);
  await writeFile(join(lockPath, `owner-${deadToken}.json`), `${JSON.stringify({ pid: 777777,
    acquiredAt: new Date().toISOString(), token: deadToken })}\n`, { mode: 0o600 });
  let laggerObserved, winnerElected, releaseWinner;
  const laggerHasRead = new Promise(resolveLagger => { laggerObserved = resolveLagger; });
  const winnerHasDirectory = new Promise(resolveWinner => { winnerElected = resolveWinner; });
  const winnerMayPublish = new Promise(resolveRelease => { releaseWinner = resolveRelease; });
  let laggerElected = false, cleanerElections = 0;
  const winner = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: { isPidAlive: pid => pid !== 777777,
    beforeDeadOwnerCleanup: async () => laggerHasRead,
    afterCleanerElection: async () => { cleanerElections += 1; },
    afterDirectoryElection: async () => { winnerElected(); await winnerMayPublish; } } });
  const lagger = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: { isPidAlive: pid => pid !== 777777,
    beforeDeadOwnerCleanup: async () => {
      laggerObserved();
      await winnerHasDirectory;
    },
    afterCleanerElection: async () => { cleanerElections += 1; },
    afterDirectoryElection: async () => { laggerElected = true; await winnerMayPublish; } } });
  try {
    await winnerHasDirectory;
    await new Promise(done => setTimeout(done, 75));
    assert.equal(laggerElected, false);
  } finally {
    releaseWinner();
    await Promise.allSettled([winner, lagger]);
  }
  assert.equal(cleanerElections, 1);
});

test("ten concurrent installs of one profile serialize and all succeed", async t => {
  const homeDir = await temporary(t, "connector-install-race-"), gateway = fakeGateway(), commands = recorder();
  let activeRegistrations = 0, maximumRegistrations = 0;
  const serialRunner = async (...args) => {
    activeRegistrations += 1;
    maximumRegistrations = Math.max(maximumRegistrations, activeRegistrations);
    try {
      await new Promise(done => setTimeout(done, 10));
      return await commands.runner(...args);
    } finally { activeRegistrations -= 1; }
  };
  const input = { server: "https://control.example", code: code("K"), bot: "codex", name: "racer", homeDir,
    platform: "linux", env: {}, fetcher: gateway.fetcher, runner: serialRunner, sourcePath: SOURCE };
  const results = await Promise.all(Array.from({ length: 10 }, () => connector.installConnector(input)));
  assert.equal(results.length, 10);
  assert.equal(gateway.state.enrollments, 1);
  assert.equal(maximumRegistrations, 1);
  assert.equal((await connector.loadConfig(results[0].paths.configPath)).installation.state, "installed");
  assert.equal((await readdir(results[0].paths.botsDir)).filter(file => file.includes(".tmp")).length, 0);
});

test("uninstall validates the current profile only after obtaining its mutation lock", async t => {
  const homeDir = await temporary(t, "connector-uninstall-lock-"), gateway = fakeGateway(), commands = recorder();
  const input = { server: "https://control.example", code: code("L"), bot: "codex", name: "locked", homeDir,
    platform: "linux", env: {}, fetcher: gateway.fetcher, runner: commands.runner, sourcePath: SOURCE };
  const installed = await connector.installConnector(input);
  const lockPath = `${installed.paths.configPath}.rotate.lock`;
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  const removing = connector.uninstallConnector({ bot: "codex", name: "locked", homeDir,
    platform: "linux", env: {}, runner: commands.runner });
  await new Promise(done => setTimeout(done, 40));
  assert.equal((await readdir(dirname(lockPath))).filter(file => file.startsWith(`${basename(lockPath)}.`)
    && file.endsWith(".tmp")).length, 1, "a waiting acquisition reuses one contender record across polls");
  const current = await connector.loadConfig(installed.paths.configPath);
  await writeFile(installed.paths.configPath, `${JSON.stringify({ ...current,
    installation: { ...current.installation, name: "changed" } }, null, 2)}\n`, { mode: 0o600 });
  await rm(lockPath);
  await assert.rejects(removing, /does not match/u);
  assert.equal((await stat(installed.paths.configPath)).isFile(), true);
  assert.equal(commands.calls.filter(call => call[1][1] === "remove").length, 0);
});

test("desktop configuration backups retain only the newest five", async t => {
  const homeDir = await temporary(t, "connector-backup-prune-");
  const configPath = join(homeDir, ".cursor", "mcp.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, "{}\n");
  for (let index = 0; index < 4; index += 1) {
    const gateway = fakeGateway(), name = `backup-${index}`;
    await connector.installConnector({ server: "https://control.example", code: code(String.fromCharCode(77 + index)),
      bot: "cursor", name, homeDir, platform: "linux", env: {}, fetcher: gateway.fetcher,
      runner: recorder().runner, sourcePath: SOURCE, clock: () => Date.now() + index });
    await connector.uninstallConnector({ bot: "cursor", name, homeDir, platform: "linux", env: {},
      runner: recorder().runner, clock: () => Date.now() + index });
  }
  assert.equal((await readdir(dirname(configPath))).filter(file => file.includes(".backup-")).length, 5);
});

test("a dropped rotation response is promoted on retry rather than rotating a second time", async t => {
  const homeDir = await temporary(t, "connector-rotation-retry-");
  const path = join(homeDir, "bot.json"), secret = `crf_${"C".repeat(43)}`;
  await writeFile(path, `${JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: WORKER_ID, secret, credentialExpiresAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const gateway = fakeGateway(); gateway.state.digest = connector.sha256(secret); gateway.state.dropAfterRotate = true;
  await assert.rejects(connector.rotate({ configPath: path, fetcher: gateway.fetcher }), /connection dropped/u);
  assert.match((await connector.loadConfig(path)).pendingSecret, /^crf_/u);
  const recovered = await connector.recoverPending({ configPath: path, fetcher: gateway.fetcher });
  assert.equal(recovered.pendingSecret, undefined);
  assert.notEqual(recovered.secret, secret);
  assert.equal(gateway.state.rotations, 1);
});
