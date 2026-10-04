import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";
import { connectorReleaseSignatureMaterialV1, releaseKeyIdV1, RELEASE_TRUST_SCHEMA_V1 } from "../scripts/release-signing.mjs";
import { FLEET_WORKING_AGREEMENT_METADATA_V1 } from "../src/fleet/v1/working-agreement.ts";
import { fleetConnectorOwnerNextStepV1, fleetJoinCommandsV1 } from "../src/web/v1/fleet-owner-http.ts";

const run = promisify(execFile);
const botKinds = ["claude-code", "codex", "hermes", "claude-desktop", "cursor", "mcp-agent"];
const releaseKeys = generateKeyPairSync("ed25519");
const releasePublicKey = releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const releaseTrust = Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
  keyId: releaseKeyIdV1(releasePublicKey), publicKey: releasePublicKey, versionFloor: "0.0.0", revokedKeyIds: [] });

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

async function writeServiceStubs(root) {
  const stub = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), statePath = process.env.CONTROL_ROOM_TEST_SERVICE_STATE;
let state = [];
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
if (args[0] === "print") { if (state.includes(args[1])) process.exit(0); console.error("not found"); process.exit(3); }
if (args[0] === "bootout") state = state.filter(item => item !== args[1]);
if (args[0] === "bootstrap") {
  const body = readFileSync(args[2], "utf8"), label = /<key>Label<\\/key><string>([^<]+)<\\/string>/.exec(body)?.[1];
  const target = args[1] + "/" + label;
  if (!state.includes(target)) state.push(target);
}
writeFileSync(statePath, JSON.stringify(state) + "\\n", { mode: 0o600 });
`;
  await mkdir(root, { recursive: true });
  for (const command of ["launchctl", "systemctl", "schtasks"]) {
    const path = join(root, command);
    await writeFile(path, stub, { mode: 0o700 });
    await chmod(path, 0o700);
  }
}

async function gateway(releaseRoot, manifest, bindings) {
  const connector = await readFile(join(releaseRoot, manifest.file));
  const unsigned = { version: manifest.version, file: manifest.file, sha256: manifest.sha256,
    size: manifest.size, builtFrom: manifest.builtFrom, minVersion: manifest.version };
  const advertisement = Object.freeze({ ...unsigned,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), releaseKeys.privateKey).toString("base64url") });
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
        capabilities: ["writing"], credentialExpiresAt: "2099-01-01T00:00:00.000Z",
        workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1, releaseTrust, connector: advertisement } }));
    }
    if (request.method === "GET" && request.url === "/fleet/v1/me"
      && /^Bearer crf_[A-Za-z0-9_-]{43}$/u.test(request.headers.authorization ?? ""))
      return send(200, JSON.stringify({ ok: true, result: { displayName: "Installed",
        workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1, releaseTrust, connector: advertisement } }));
    if (request.method === "POST" && request.url === "/fleet/v1/heartbeat"
      && /^Bearer crf_[A-Za-z0-9_-]{43}$/u.test(request.headers.authorization ?? "")) {
      state.heartbeats += 1;
      return send(200, JSON.stringify({ ok: true, result: { displayName: "Installed",
        workerKind: [...used.values()].find(value => bindings.get(value.code)?.workerId === request.headers["x-control-room-worker"])?.workerKind,
        operationsMode: "running",
        workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1, releaseTrust, connector: advertisement } }));
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

test("exact macOS lines install all registrations and one idempotent worker for each supported unattended kind", async t => {
  const root = await mkdtemp(join(tmpdir(), "connect-bot-line-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = join(root, "release"), stubs = join(root, "stubs"), serviceStubs = join(root, "service-stubs");
  const release = await buildFleetConnectorReleaseForTestV1({ root: releaseRoot, builtFrom: "a".repeat(40),
    releaseTrust });
  await writeAgentCliStubs(stubs);
  await writeServiceStubs(serviceStubs);
  const bindings = new Map(botKinds.map((bot, index) => [joinCode(index), {
    bot, workerId: workerId(index), displayName: `${bot} fixture`,
  }]));
  const service = await gateway(releaseRoot, release.manifest, bindings);
  t.after(() => service.close());

  for (const [index, bot] of botKinds.entries()) await t.test(bot, async () => {
    const home = join(root, `home-${index}`), xdg = join(home, ".config");
    await mkdir(home, { recursive: true });
    const identity = bindings.get(joinCode(index));
    const optedIn = ["claude-code", "codex", "hermes"].includes(bot);
    const selection = bot === "hermes" ? { profile: "fixture", model: "hermes-3", provider: "local" } : {};
    const commands = fleetJoinCommandsV1(service.origin, joinCode(index), bot, release.manifest, identity, optedIn, selection);
    const serviceState = join(root, "service-state.json");
    const env = { ...process.env, PATH: `${stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
      XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"), XDG_RUNTIME_DIR: join(home, ".runtime"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), HERMES_HOME: join(home, ".hermes"),
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
      CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", CONTROL_ROOM_TEST_AGENT_CLI_DIR: stubs,
      CONTROL_ROOM_TEST_SERVICE_CLI_DIR: serviceStubs, CONTROL_ROOM_TEST_SERVICE_STATE: serviceState };
    await run("/bin/zsh", ["-c", commands.unix], { env, timeout: 30_000 });
    await run("/bin/zsh", ["-c", commands.unix], { env, timeout: 30_000 });

    const profile = commands.profileName;
    const credential = await readJson(join(xdg, "control-room", "bots", `${profile}.json`));
    assert.deepEqual(credential.installation, { bot, name: profile,
      workspace: join(home, "ControlRoomWork", profile), state: "installed",
      updates: { releasePublicKey, floorVersion: release.manifest.version, keyId: releaseTrust.keyId,
        epoch: 1, revokedKeyIds: [], paused: false }, ...(optedIn ? { unattended: true } : {}) });
    assert.equal((await stat(credential.installation.workspace)).isDirectory(), true);
    if (optedIn) {
      const agents = await readdir(join(home, "Library", "LaunchAgents"));
      const serviceKey = createHash("sha256").update(profile).digest("hex").slice(0, 16);
      assert.deepEqual(agents, [`xyz.agentcontrolroom.connector.${serviceKey}.plist`], "one hashed LaunchAgent belongs to this profile");
      const harnesses = await readJson(join(xdg, "control-room", "bots", `${profile}.harnesses.json`));
      assert.equal(harnesses.harnesses[bot].enabled, true);
      if (bot === "hermes") assert.deepEqual({ profile: harnesses.harnesses.hermes.profile,
        model: harnesses.harnesses.hermes.model, provider: harnesses.harnesses.hermes.provider }, selection);
    }
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
  assert.equal((await readJson(join(root, "service-state.json"))).length, 3,
    "retries replace the same three profile labels instead of adding duplicate agents");
});

test("six bot kinds produce the reviewed unattended choice and next step on every OS fixture", () => {
  const manifest = { schema: "control-room.fleet-connector-release/v1", version: "0.5.0",
    file: "connector-0.5.0.mjs", sha256: "b".repeat(64), size: 1234, builtFrom: "c".repeat(40) };
  for (const [index, bot] of botKinds.entries()) {
    const identity = { displayName: `${bot} fixture`, workerId: workerId(index) };
    const commands = fleetJoinCommandsV1("https://control.example", joinCode(index), bot, manifest, identity);
    assert.match(commands.unix, new RegExp(`install .*--bot ${bot} --name ${commands.profileName} --workspace "\\$w" --i-am-the-installer$`, "u"));
    assert.match(commands.windows, new RegExp(`install .*--bot ${bot} --name ${commands.profileName} --workspace \\$w --i-am-the-installer$`, "u"));
    for (const os of ["macos", "windows", "linux"]) {
      const command = os === "windows" ? "windows" : "unix";
      const next = fleetConnectorOwnerNextStepV1(bot, os, commands.profileName);
      if (bot === "mcp-agent") assert.match(next, os === "windows" ? /%APPDATA%\\control-room/u : /\$XDG_CONFIG_HOME.*~\/\.config\/control-room/u);
      else if (["cursor", "claude-desktop"].includes(bot)) assert.match(next, /Close and reopen.*no background service/u);
      else assert.match(next, /registered now.*no background service or restart/u);
      if (["claude-code", "codex", "hermes"].includes(bot)) {
        const selection = bot === "hermes" ? { profile: "fixture", model: "hermes-3", provider: "local" } : {};
        const unattended = fleetJoinCommandsV1("https://control.example", joinCode(index), bot, manifest, identity, true, selection);
        assert.match(unattended[command], /--unattended --i-am-the-installer$/u, `${bot} ${os}`);
        if (bot === "hermes") assert.match(unattended[command],
          /--worker-profile fixture --worker-model hermes-3 --worker-provider local --unattended/u);
        assert.match(fleetConnectorOwnerNextStepV1(bot, os, commands.profileName, true),
          /per-user background worker.*checks for approved work.*harnesses\.json.*uninstall/isu);
      } else {
        assert.throws(() => fleetJoinCommandsV1("https://control.example", joinCode(index), bot, manifest, identity, true));
        assert.throws(() => fleetConnectorOwnerNextStepV1(bot, os, commands.profileName, true));
      }
    }
  }
  assert.throws(() => fleetConnectorOwnerNextStepV1("unknown", "macos", "safe-profile"));
  assert.throws(() => fleetConnectorOwnerNextStepV1("codex", "android", "safe-profile"));
  assert.throws(() => fleetConnectorOwnerNextStepV1("codex", "macos", "unsafe profile"));
});
