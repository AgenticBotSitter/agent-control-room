import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
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

function recorder({ failOnce = false } = {}) {
  const calls = [];
  let fail = failOnce;
  return {
    calls,
    runner: async (command, args) => {
      calls.push([command, args]);
      if (fail) { fail = false; throw new Error("registration failed"); }
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
      assert.match(await readFile(installed.paths.shimPath, "utf8"), /connector\.mjs.*mcp/u);
    });
  }
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
      assert.equal(removed.shimRemoved, true);
      await assert.rejects(stat(installed.paths.configPath), error => error.code === "ENOENT");
      await assert.rejects(stat(installed.paths.shimPath), error => error.code === "ENOENT");
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

test("CLI-backed uninstall removes each registration and keeps the shared shim while another profile remains", async t => {
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
  assert.equal(last.shimRemoved, true);
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
  await writeFile(stale, "stale\n", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(stale, old, old);
  await connector.rotate({ configPath: path, fetcher: gateway.fetcher, lock: { staleMs: 1_000, deadlineMs: 100 } });
  assert.equal(gateway.state.rotations, 2);
  await assert.rejects(stat(stale), error => error.code === "ENOENT");
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
