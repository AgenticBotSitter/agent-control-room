import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";
import { fleetConnectorOwnerNextStepV1, fleetJoinCommandsV1 } from "../src/web/v1/fleet-owner-http.ts";

const run = promisify(execFile);
const botKinds = ["claude-code", "codex", "hermes", "claude-desktop", "cursor", "mcp-agent"];

function joinCode(index) { return `crj_${String.fromCharCode(65 + index).repeat(43)}`; }
function workerId(index) { return `fleet-worker:${index.toString(16).repeat(32)}`; }

async function writeAgentCliStubs(root) {
  const stub = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const tool = basename(process.argv[1]), args = process.argv.slice(2);
if (args[0] !== "mcp" || args[1] !== "add") process.exit(41);
const server = tool === "claude" ? args[4] : args[2];
const root = tool === "claude" ? process.env.CLAUDE_CONFIG_DIR
  : tool === "codex" ? process.env.CODEX_HOME : process.env.HERMES_HOME;
const statePath = join(root, "stub-registrations.json");
mkdirSync(dirname(statePath), { recursive: true });
let state = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
state[server] = { args };
writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", { mode: 0o600 });
if (tool === "hermes") writeFileSync(join(root, "config.yaml"),
  "mcp_servers:\\n  " + server + ":\\n    command: fixture\\n", { mode: 0o600 });
`;
  await mkdir(root, { recursive: true });
  for (const command of ["claude", "codex", "hermes"]) {
    const path = join(root, command);
    await writeFile(path, stub, { mode: 0o700 });
    await chmod(path, 0o700);
  }
}

async function gateway(releaseRoot, manifest, bindings) {
  const connector = await readFile(join(releaseRoot, manifest.file));
  const used = new Map(), state = { enrollments: 0, heartbeats: 0 };
  const server = createServer(async (request, response) => {
    const send = (status, value, type = "application/json") => {
      response.writeHead(status, { "content-type": type }); response.end(value);
    };
    if (request.method === "GET" && request.url === `/fleet/v1/${manifest.file}`)
      return send(200, connector, "text/javascript");
    if (request.method === "GET" && request.url === "/fleet/v1/connector-manifest.json")
      return send(200, `${JSON.stringify(manifest)}\n`);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.method === "POST" && request.url === "/fleet/v1/enroll") {
      const expected = bindings.get(body.code);
      if (!expected || expected.bot !== body.workerKind)
        return send(409, JSON.stringify({ ok: false, error: "worker_kind_mismatch" }));
      const prior = used.get(body.code);
      if (prior && (prior.clientNonce !== body.clientNonce || prior.credentialDigest !== body.credentialDigest))
        return send(409, JSON.stringify({ ok: false, error: "code_used" }));
      if (!prior) { used.set(body.code, body); state.enrollments += 1; }
      return send(201, JSON.stringify({ ok: true, result: { workerId: expected.workerId,
        displayName: expected.displayName, projectIds: ["project:test"], workerKind: expected.bot,
        capabilities: ["writing"], credentialExpiresAt: "2099-01-01T00:00:00.000Z" } }));
    }
    if (request.method === "POST" && request.url === "/fleet/v1/heartbeat"
      && /^Bearer crf_[A-Za-z0-9_-]{43}$/u.test(request.headers.authorization ?? "")) {
      state.heartbeats += 1;
      return send(200, JSON.stringify({ ok: true, result: { displayName: "Installed", operationsMode: "running" } }));
    }
    send(404, JSON.stringify({ ok: false, error: "not_found" }));
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, state,
    close: () => new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())) };
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

test("each exact macOS install line registers all six bot kinds and is idempotent", async t => {
  const root = await mkdtemp(join(tmpdir(), "connect-bot-line-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = join(root, "release"), stubs = join(root, "stubs");
  const release = await buildFleetConnectorReleaseForTestV1({ root: releaseRoot, builtFrom: "a".repeat(40) });
  await writeAgentCliStubs(stubs);
  const bindings = new Map(botKinds.map((bot, index) => [joinCode(index), {
    bot, workerId: workerId(index), displayName: `${bot} fixture`,
  }]));
  const service = await gateway(releaseRoot, release.manifest, bindings);
  t.after(() => service.close());

  for (const [index, bot] of botKinds.entries()) await t.test(bot, async () => {
    const home = join(root, `home-${index}`), xdg = join(home, ".config");
    await mkdir(home, { recursive: true });
    const identity = bindings.get(joinCode(index));
    const commands = fleetJoinCommandsV1(service.origin, joinCode(index), bot, release.manifest, identity);
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
      XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"), XDG_RUNTIME_DIR: join(home, ".runtime"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), HERMES_HOME: join(home, ".hermes"),
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
      CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", CONTROL_ROOM_TEST_AGENT_CLI_DIR: stubs };
    await run("/bin/zsh", ["-c", commands.unix], { env, timeout: 30_000 });
    await run("/bin/zsh", ["-c", commands.unix], { env, timeout: 30_000 });

    const profile = commands.profileName;
    const credential = await readJson(join(xdg, "control-room", "bots", `${profile}.json`));
    assert.deepEqual(credential.installation, { bot, name: profile,
      workspace: join(home, "ControlRoomWork", profile), state: "installed" });
    assert.equal((await stat(credential.installation.workspace)).isDirectory(), true);
    const serverName = `control-room-${profile}`;
    if (["claude-code", "codex", "hermes"].includes(bot)) {
      const toolRoot = bot === "claude-code" ? join(home, ".claude")
        : bot === "codex" ? join(home, ".codex") : join(home, ".hermes");
      const registrations = await readJson(join(toolRoot, "stub-registrations.json"));
      assert.deepEqual(Object.keys(registrations), [serverName], "the stub CLI saved one idempotent registration");
      assert.ok(registrations[serverName].args.includes(join(home, "ControlRoomWork", profile)));
      if (bot === "hermes") assert.match(await readFile(join(toolRoot, "config.yaml"), "utf8"), new RegExp(`  ${serverName}:`, "u"));
    } else {
      const configPath = bot === "cursor" ? join(home, ".cursor", "mcp.json")
        : bot === "claude-desktop" ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : join(xdg, "control-room", "generic-mcp.json");
      const saved = await readJson(configPath);
      assert.deepEqual(Object.keys(saved.mcpServers), [serverName], "the config writer saved one idempotent registration");
      assert.deepEqual(saved.mcpServers[serverName].args.slice(-2), ["--workspace", join(home, "ControlRoomWork", profile)]);
    }
  });
  assert.equal(service.state.enrollments, 6, "rerunning never redeems a code twice");
  assert.equal(service.state.heartbeats, 12, "both first installs and retries prove the saved credential works");
});

test("Windows and Linux command fixtures install the same profile and give kind-specific next steps", () => {
  const manifest = { schema: "control-room.fleet-connector-release/v1", version: "0.4.0",
    file: "connector-0.4.0.mjs", sha256: "b".repeat(64), size: 1234, builtFrom: "c".repeat(40) };
  for (const [index, bot] of botKinds.entries()) {
    const identity = { displayName: `${bot} fixture`, workerId: workerId(index) };
    const commands = fleetJoinCommandsV1("https://control.example", joinCode(index), bot, manifest, identity);
    assert.match(commands.unix, new RegExp(`install .*--bot ${bot} --name ${commands.profileName} --workspace "\\$w" --i-am-the-installer$`, "u"));
    assert.match(commands.windows, new RegExp(`install .*--bot ${bot} --name ${commands.profileName} --workspace \\$w --i-am-the-installer$`, "u"));
    for (const os of ["macos", "windows", "linux"]) {
      const next = fleetConnectorOwnerNextStepV1(bot, os, commands.profileName);
      if (bot === "mcp-agent") assert.match(next, os === "windows" ? /%APPDATA%\\control-room/u : /\$XDG_CONFIG_HOME.*~\/\.config\/control-room/u);
      else if (["cursor", "claude-desktop"].includes(bot)) assert.match(next, /Close and reopen.*no background service/u);
      else assert.match(next, /registered now.*no background service or restart/u);
    }
  }
  assert.throws(() => fleetConnectorOwnerNextStepV1("unknown", "macos", "safe-profile"));
  assert.throws(() => fleetConnectorOwnerNextStepV1("codex", "android", "safe-profile"));
  assert.throws(() => fleetConnectorOwnerNextStepV1("codex", "macos", "unsafe profile"));
});
