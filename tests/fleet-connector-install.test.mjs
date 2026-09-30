import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import * as connector from "../scripts/fleet/connector.mjs";

const SOURCE = resolve("scripts/fleet/connector.mjs");
const WORKER_ID = `fleet-worker:${"a".repeat(32)}`;

function code(character) { return `crj_${character.repeat(43)}`; }

function json(ok, result, status = ok ? 200 : 409) {
  return new Response(JSON.stringify(ok ? { ok: true, result } : { ok: false, error: result }), {
    status, headers: { "content-type": "application/json" },
  });
}

function fakeGateway({ rotateDelayMs = 0 } = {}) {
  const used = new Set();
  const bindings = new Map();
  const state = { enrollments: 0, rotations: 0, digest: null, dropAfterEnroll: false, dropAfterRotate: false };
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const bearer = String(init.headers?.authorization ?? "").replace(/^Bearer /u, "");
    const authenticated = state.digest && connector.sha256(bearer) === state.digest;
    if (path === "/fleet/v1/enroll") {
      const prior = bindings.get(body.code);
      if (used.has(body.code) && (prior?.clientNonce !== body.clientNonce || prior?.credentialDigest !== body.credentialDigest))
        return json(false, "code_used", 409);
      if (!used.has(body.code)) {
        used.add(body.code); bindings.set(body.code, body); state.enrollments += 1; state.digest = body.credentialDigest;
        if (state.dropAfterEnroll) { state.dropAfterEnroll = false; throw new Error("enrollment response dropped"); }
      }
      return json(true, { workerId: WORKER_ID, displayName: "Fixture bot", projectIds: ["project:test"],
        capabilities: ["writing"], credentialExpiresAt: "2099-01-01T00:00:00.000Z" }, 201);
    }
    if (!authenticated) return json(false, "unauthenticated", 401);
    if (path === "/fleet/v1/rotate") {
      state.rotations += 1;
      if (rotateDelayMs) await new Promise(done => setTimeout(done, rotateDelayMs));
      state.digest = body.newCredentialDigest;
      if (state.dropAfterRotate) { state.dropAfterRotate = false; throw new Error("connection dropped"); }
      return json(true, { credentialExpiresAt: "2099-02-01T00:00:00.000Z" });
    }
    if (path === "/fleet/v1/heartbeat") return json(true, { displayName: "Fixture bot", operationsMode: "running" });
    if (path === "/fleet/v1/me") return json(true, { displayName: "Fixture bot",
      credentialExpiresAt: "2099-02-01T00:00:00.000Z" });
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
      assert.deepEqual(args.slice(-4), ["--profile", name, "--workspace", installed.paths.workspace]);
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
        ["--profile", name, "--workspace", installed.paths.workspace]);
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

test("bad install input and real-home CLI use fail before enrollment", async t => {
  const homeDir = await temporary(t, "connector-refusal-");
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
  for (const [workspace, message] of [["relative", /absolute directory/u], [join(homeDir, "missing"), /must exist/u]]) {
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
  await connector.rotate({ configPath: path, fetcher: gateway.fetcher,
    lock: { staleMs: 1, deadlineMs: 100, waitMs: 5 } });
  assert.equal(gateway.state.rotations, 3);
  await assert.rejects(stat(stale), error => error.code === "ENOENT");

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

test("twenty cross-process rotations make exactly one server rotation without caller failures", async t => {
  const homeDir = await temporary(t, "connector-process-rotation-");
  const configPath = join(homeDir, "bot.json"), secret = `crf_${"R".repeat(43)}`;
  const state = { digest: connector.sha256(secret), rotations: 0 };
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
      await new Promise(done => setTimeout(done, 100));
      state.digest = body.newCredentialDigest;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { credentialExpiresAt: "2099-02-01T00:00:00.000Z" } }));
      return;
    }
    if (request.url === "/fleet/v1/me") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { credentialExpiresAt: "2099-02-01T00:00:00.000Z" } }));
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
    const processes = Array.from({ length: 20 }, rotateInProcess);
    await Promise.all(processes.map(childProcess => childProcess.ready));
    for (const childProcess of processes) childProcess.child.send("rotate");
    return Promise.all(processes.map(childProcess => childProcess.done));
  };
  const results = await runBurst();
  assert.deepEqual(results.filter(result => result.code !== 0), [],
    `all child rotations must succeed: ${JSON.stringify(results.filter(result => result.code !== 0))}`);
  assert.equal(state.rotations, 1);
  assert.equal(results.filter(result => JSON.parse(result.stdout).coalesced === true).length, 19);
  assert.deepEqual((await readdir(homeDir)).filter(file => file.includes(".rotate.lock")), []);

  const lockPath = `${configPath}.rotate.lock`, deadToken = "d".repeat(32);
  await mkdir(lockPath);
  await writeFile(join(lockPath, `owner-${deadToken}.json`), `${JSON.stringify({ pid: 777777,
    acquiredAt: new Date().toISOString(), token: deadToken })}\n`, { mode: 0o600 });
  const recovered = await runBurst();
  assert.deepEqual(recovered.filter(result => result.code !== 0), [],
    `all dead-lock recovery callers must succeed: ${JSON.stringify(recovered.filter(result => result.code !== 0))}`);
  assert.equal(state.rotations, 2);
  assert.equal(recovered.filter(result => JSON.parse(result.stdout).coalesced === true).length, 19);
  assert.deepEqual((await readdir(homeDir)).filter(file => file.includes(".rotate.lock")), []);
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
  let laggerObserved;
  const laggerHasRead = new Promise(resolveLagger => { laggerObserved = resolveLagger; });
  const cleaner = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: { isPidAlive: pid => pid !== 777777,
    beforeDeadOwnerCleanup: async () => laggerHasRead } });
  const lagger = connector.rotate({ configPath, fetcher: gateway.fetcher, lock: { isPidAlive: pid => pid !== 777777,
    beforeDeadOwnerCleanup: async () => {
      laggerObserved();
      const deadline = Date.now() + 2_000;
      for (;;) {
        const owners = await readdir(lockPath).catch(() => []);
        const tokens = await Promise.all(owners.map(async file => {
          try { return JSON.parse(await readFile(join(lockPath, file), "utf8")).token; } catch { return null; }
        }));
        if (tokens.some(token => token && token !== deadToken)) return;
        if (Date.now() >= deadline) throw new Error("replacement lock generation was not published");
        await new Promise(done => setTimeout(done, 5));
      }
    } } });
  const results = await Promise.all([cleaner, lagger]);
  assert.equal(gateway.state.rotations, 1);
  assert.equal(results.filter(result => result.coalesced === true).length, 1);
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
