import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, cp, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { stoppedProcessFixtures } from "./helpers/stopped-process-fixtures.mjs";
import { generateRehearsalConfigV1, REHEARSAL_ROOT_V1 } from "../scripts/install/rehearsal/config.mjs";
import { collectResultsV1, renderResultsV1 } from "../scripts/install/rehearsal/collect-results.mjs";
import { launchdLabelsV1 } from "../scripts/install/rehearsal/snapshot.mjs";
import { REQUIRED_INSTALLER_CAPABILITIES_V1, verifyInstallerCapabilitiesV1 } from "../scripts/install/rehearsal/verify-capabilities.mjs";
import { checkOwnerBotsStoppedV1, readSipEnabledV1, trustedExecutableV1, parseKernelFactsV1, parseOwnerBotProcessesV1 } from "../scripts/install/rehearsal/check-bots-stopped.mjs";

// The output shape lsof prints with `-Fpnft`: no header, one field per line, the
// file TYPE line between the descriptor and the name. Used wherever this file needs
// a kernel read without a live process behind it.
const parseKernelFactsFixture = lines => parseKernelFactsV1(`${lines.join("\n")}\n`);

const nativeRunFile = promisify(execFile);
const runFile = (file, args, options = {}) => nativeRunFile(file, args, { timeout: 20_000, killSignal: "SIGKILL", ...options }), repository = resolve(new URL("..", import.meta.url).pathname);
const configCli = join(repository, "scripts/install/rehearsal/config.mjs"), snapshotCli = join(repository, "scripts/install/rehearsal/snapshot.mjs");
const liveSnapshotCli = join(repository, "scripts/install/rehearsal/live-snapshot.mjs");
const collectorCli = join(repository, "scripts/install/rehearsal/collect-results.mjs"), capabilityCli = join(repository, "scripts/install/rehearsal/verify-capabilities.mjs");
const botCheckCli = join(repository, "scripts/install/rehearsal/check-bots-stopped.mjs");
const fixtureRoot = join(repository, "tests/fixtures/e2e2"), created = [];
async function temporary(prefix) { const path = await mkdtemp(join(tmpdir(), prefix)); created.push(path); return path; }
test.after(async () => { for (const path of created.reverse()) await rm(path, { recursive: true, force: true }); });
async function executable(path, body) { await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 }); await chmod(path, 0o700); }

// macOS ps pads every column except the last to a fixed width, so a combined row
// shows the executable path cut to sixteen characters in the comm column, and the
// argument column starts with the whole path again, followed by its arguments.
function psRow(uid, pid, ppid, executable, arguments_ = "") {
  const comm = executable.slice(0, 16).padEnd(16);
  return arguments_ ? `${uid} ${pid} ${ppid} ${comm} ${executable} ${arguments_}` : `${uid} ${pid} ${ppid} ${comm} ${executable}`;
}

// A worker run through an interpreter has the interpreter as its executable, so
// the comm column names the interpreter and the script is the first argument.
function interpretedRow(uid, pid, ppid, interpreter, script, arguments_ = "") {
  const comm = interpreter.slice(0, 16).padEnd(16);
  const command = `${interpreter} ${script}${arguments_ ? ` ${arguments_}` : ""}`;
  return `${uid} ${pid} ${ppid} ${comm} ${command}`;
}

async function fixture({ live = true } = {}) {
  const root = await temporary("control-room-e2e2-fixture-"), system = join(root, "system"), bin = join(root, "bin"), state = join(root, "state");
  for (const path of ["etc/sudoers.d", "etc/newsyslog.d", "usr/local/bin", "usr/lib/cron", "Library/LaunchAgents",
    "Library/LaunchDaemons", "Library/Application Support", "Users/fixtureowner/Library/LaunchAgents"]) await mkdir(join(system, path), { recursive: true });
  await Promise.all([mkdir(bin), mkdir(state), cp(join(fixtureRoot, "dscl-users.txt"), join(state, "users")),
    cp(join(fixtureRoot, "dscl-groups.txt"), join(state, "groups")), cp(join(fixtureRoot, "launchctl-print-system.txt"), join(state, "launchctl")),
    cp(join(fixtureRoot, "tailscale-status.json"), join(state, "tailscale-status")), cp(join(fixtureRoot, "tailscale-serve-status.json"), join(state, "tailscale-serve")),
    cp(join(fixtureRoot, "lsof-listeners.txt"), join(state, "lsof")), writeFile(join(system, "usr/lib/cron/cron.deny"), "nobody\n"),
    writeFile(join(system, "usr/lib/cron/at.deny"), "nobody\n"), writeFile(join(system, "etc/sudoers.d/control-room"), "fixture\n"),
    writeFile(join(system, "etc/newsyslog.d/control-room.conf"), "fixture\n"), writeFile(join(system, "usr/local/bin/control-room"), "fixture\n")]);
  if (live) await writeFile(join(system, "Users/fixtureowner/Library/LaunchAgents/com.controlroom.live.web.plist"),
    "<plist><dict><key>Label</key><string>com.controlroom.live.web</string></dict></plist>\n");
  await executable(join(bin, "dscl"), `case "$3" in /Users) /bin/cat ${JSON.stringify(join(state, "users"))} ;; /Groups) /bin/cat ${JSON.stringify(join(state, "groups"))} ;; *) exit 8 ;; esac`);
  await executable(join(bin, "launchctl"), `/bin/cat ${JSON.stringify(join(state, "launchctl"))}`);
  await executable(join(bin, "tailscale"), `case "$1 $2" in "status --json") /bin/cat ${JSON.stringify(join(state, "tailscale-status"))} ;; "serve status") [ "$3" = --json ] && /bin/cat ${JSON.stringify(join(state, "tailscale-serve"))} ;; *) exit 8 ;; esac`);
  await executable(join(bin, "lsof"), `/bin/cat ${JSON.stringify(join(state, "lsof"))}`);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmpdir(), CONTROL_ROOM_REHEARSAL_TESTING: "1", CONTROL_ROOM_REHEARSAL_COMMAND_DIR: bin };
  return { root, system, bin, state, env, snapshotTemp: await realpath(root) };
}
function snapshotEnvironment(f) {
  return { ...f.env, TMPDIR: f.snapshotTemp, CONTROL_ROOM_REHEARSAL_COMMAND_DIR: join(f.snapshotTemp, "bin") };
}
async function before(f, extraEnvironment = {}) {
  const path = (await runFile(process.execPath, [snapshotCli, "before", "--system-root", f.system], { env: { ...snapshotEnvironment(f), ...extraEnvironment }, encoding: "utf8" })).stdout.trim();
  created.push(path); return path;
}
async function retained(f, stamp = "20260930T123456789Z") {
  const logical = `${REHEARSAL_ROOT_V1}.uninstalled-${stamp}`, physical = join(f.system, logical.slice(1));
  await mkdir(physical, { recursive: true }); return logical;
}
async function after(f, state, retainedRoot) {
  return runFile(process.execPath, [snapshotCli, "after", "--state", state, "--retained-root", retainedRoot, "--system-root", f.system], { env: snapshotEnvironment(f), encoding: "utf8" });
}
async function configCommand(f, extra = []) {
  const liveRoot = join(f.root, "live"), output = join(f.root, `config-${Math.random().toString(16).slice(2)}.json`); await mkdir(liveRoot, { recursive: true });
  const args = [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net", "--live-hostname", "fixture-mac.live-tail.ts.net",
    "--live-ports", "3310,3311,7864", "--live-label-prefixes", "com.agent-control-room.,com.controlroom.", "--live-root", liveRoot,
    "--system-root", f.system, "--output", output, ...extra];
  return { output, result: await runFile(process.execPath, args, { env: f.env, encoding: "utf8" }) };
}
async function ownerSnapshot(f, output = join(f.root, `owner-live-${Math.random().toString(16).slice(2)}.json`)) {
  const result = await runFile(process.execPath, [liveSnapshotCli, "create", "--live-ports", "3310,3311,7864",
    "--live-label-prefixes", "com.agent-control-room.,com.controlroom.", "--live-root", join(f.root, "live"),
    "--system-root", f.system, "--output", output], { env: f.env, encoding: "utf8" });
  const digest = /OWNER LIVE SNAPSHOT SHA256: ([a-f0-9]{64})/u.exec(result.stdout)?.[1]; assert.ok(digest);
  return { output, digest, result };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

test("config is isolated, Tailscale is skip-only, and the installer supports every C6 rehearsal flag", async () => {
  const config = await generateRehearsalConfigV1({ tailnetName: "fixture-rehearsal.other-tail.ts.net", noLiveInstall: true });
  assert.equal(config.root, REHEARSAL_ROOT_V1); assert.deepEqual(config.ports, { web: 13210, gateway: 13211 });
  assert.equal(Object.values(config.launchdLabels).every(label => label.startsWith("xyz.agentcontrolroom.rehearsal.")), true);
  // THE REHEARSAL TAILSCALE CONTRACT, and it is the one this test exists for: in
  // rehearsal mode Tailscale is SKIP-ONLY, and the config is what says so. The
  // five installer flags are all OBSERVED (nothing is missing) because the
  // installer grew `--authenticator` and `--e2e2-evidence-log`, and a rehearsal
  // config that still listed them as missing would make the launcher assert a
  // gap that no longer exists — which is how a rehearsal stops proving the
  // installer actually speaks the flags.
  assert.deepEqual(config.tailscale, { mode: "skip", expectedStepOutcome: "skipped (rehearsal)", mutationAllowed: false });
  assert.deepEqual(config.observedInstallerFlags, ["--root", "--web-port", "--rehearsal-config", "--fresh-database",
    "--authenticator", "--e2e2-evidence-log"]);
  assert.deepEqual(config.missingInstallerFlags, []);
  assert.deepEqual(config.database, { mode: "fresh" });
  assert.deepEqual(config.authenticator, { kind: "software", userVerification: "required" });
});

test("live discovery reads real-format plist and lsof sources and reports its count", async () => {
  const f = await fixture(), { output, result } = await configCommand(f), config = JSON.parse(await readFile(output, "utf8"));
  assert.match(result.stdout, /^live sources read: 2$/mu); assert.equal(config.liveSourcesRead, 2);
});

test("owner snapshot supplies the real hostname and a checksum pinned for the same account", async () => {
  const f = await fixture(), handoff = await ownerSnapshot(f), snapshot = JSON.parse(await readFile(handoff.output, "utf8"));
  assert.equal(snapshot.hostname, "fixture-mac.live-tail.ts.net");
  assert.equal(snapshot.ports.includes(3310), true); assert.equal(snapshot.labels.includes("com.controlroom.live.web"), true);
  assert.deepEqual(snapshot.serveStatus, JSON.parse(await readFile(join(f.state, "tailscale-serve"), "utf8")));
  assert.equal((await lstat(handoff.output)).mode & 0o777, 0o644);
  const output = join(f.root, "snapshot-config.json");
  const result = await runFile(process.execPath, [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net",
    "--live-snapshot", handoff.output, "--live-snapshot-digest", handoff.digest, "--output", output], { env: f.env, encoding: "utf8" });
  const config = JSON.parse(await readFile(output, "utf8"));
  assert.match(result.stdout, /live sources read: 2/u); assert.equal(config.liveSnapshotSha256, handoff.digest);
  await assert.rejects(runFile(process.execPath, [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net",
    "--live-snapshot", handoff.output, "--live-snapshot-digest", handoff.digest, "--live-root", join(f.root, "live"),
    "--output", join(f.root, "snapshot-config-with-live-read.json")], { env: f.env }), /live_snapshot_refused/u);
});

test("owner Serve check fails closed on snapshot, Serve, or hostname drift and can retry", async () => {
  const f = await fixture(), handoff = await ownerSnapshot(f), args = [liveSnapshotCli, "check-serve", "--input", handoff.output, "--checksum", handoff.digest];
  assert.match((await runFile(process.execPath, args, { env: f.env, encoding: "utf8" })).stdout, /Serve and hostname unchanged/u);
  await assert.rejects(runFile(process.execPath, [...args.slice(0, -1), "0".repeat(64)], { env: f.env }), /live_snapshot_checksum_refused/u);
  await writeFile(join(f.state, "tailscale-serve"), "{\"TCP\":{}}\n");
  await assert.rejects(runFile(process.execPath, args, { env: f.env }), /tailscale_serve_changed/u);
  await cp(join(fixtureRoot, "tailscale-serve-status.json"), join(f.state, "tailscale-serve"));
  assert.match((await runFile(process.execPath, args, { env: f.env, encoding: "utf8" })).stdout, /PASS/u);
  await writeFile(join(f.state, "tailscale-status"), "{\"Self\":{\"DNSName\":\"changed.other-tail.ts.net\"}}\n");
  await assert.rejects(runFile(process.execPath, args, { env: f.env }), /tailscale_serve_changed/u);
});

test("owner snapshot refuses bad or missing live data and succeeds on retry", async () => {
  const f = await fixture(), output = join(f.root, "retry-owner-live.json");
  await writeFile(join(f.state, "tailscale-status"), "{}\n");
  await assert.rejects(ownerSnapshot(f, output), /live_snapshot_command_refused/u);
  assert.equal(await lstat(output).then(() => true, () => false), false);
  await cp(join(fixtureRoot, "tailscale-status.json"), join(f.state, "tailscale-status"));
  const handoff = await ownerSnapshot(f, output); assert.ok(handoff.digest);
  await assert.rejects(runFile(process.execPath, [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net",
    "--live-snapshot", join(f.root, "missing.json"), "--live-snapshot-digest", handoff.digest, "--output", join(f.root, "missing-config.json")], { env: f.env }), /live_snapshot_refused/u);
  await assert.rejects(runFile(process.execPath, [liveSnapshotCli, "create", "--live-ports", "0",
    "--live-label-prefixes", "com.controlroom.", "--live-root", join(f.root, "live"), "--system-root", f.system,
    "--output", join(f.root, "bad-port.json")], { env: f.env }), /live_ports_refused/u);
  await assert.rejects(runFile(process.execPath, [liveSnapshotCli, "create", "--live-ports", "3310",
    "--live-label-prefixes", "bad label", "--live-root", join(f.root, "live"), "--system-root", f.system,
    "--output", join(f.root, "bad-label.json")], { env: f.env }), /live_label_prefixes_refused/u);
});

test("same-account snapshot consumption rejects every malformed signed snapshot field", async () => {
  const f = await fixture(), handoff = await ownerSnapshot(f), original = JSON.parse(await readFile(handoff.output, "utf8"));
  const mutations = [
    value => { value.schema = "wrong"; }, value => { value.sourcesRead = 0; }, value => { value.hostname = "not a host"; },
    value => { value.ports = [0]; }, value => { value.labels = ["bad label"]; }, value => { value.accounts = ["owner"]; },
    value => { value.roots = ["relative"]; }, value => { value.hosts = ["other.example.test"]; }, value => { value.serveStatus = []; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(original); mutate(changed); const bytes = `${JSON.stringify(changed, null, 2)}\n`, input = join(f.root, `malformed-${index}.json`);
    await writeFile(input, bytes);
    await assert.rejects(runFile(process.execPath, [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net",
      "--live-snapshot", input, "--live-snapshot-digest", digest(bytes), "--output", join(f.root, `malformed-config-${index}.json`)], { env: f.env }), /live_snapshot_refused/u);
  }
});

test("twenty concurrent owner snapshot writers never overwrite the snapshot", async () => {
  const f = await fixture(), output = join(f.root, "one-owner-live.json"), calls = Array.from({ length: 20 }, () => ownerSnapshot(f, output));
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 19);
  assert.equal(results.filter(result => result.status === "rejected").every(result => /output_exists/u.test(`${result.reason}`)), true);
});

test("operator guide keeps interactive stops open, pins Git ownership, and checks Serve at every boundary", async () => {
  const guide = await readFile(join(repository, "docs/install/E2E2_REHEARSAL.md"), "utf8");
  assert.match(guide, /The check denies by default/u);
  assert.match(guide, /Apple system signing evidence/u);
  assert.match(guide, /only reviewed terminals are Apple Terminal and iTerm at their reviewed bundle locations/u);
  assert.match(guide, /folders are left alone/u);
  assert.match(guide, /union of two process-list and kernel-file scans/u);
  assert.match(guide, /immediately before the first privileged command/u);
  assert.match(guide, /cannot prevent an arbitrary program from launching/u);
  assert.doesNotMatch(guide, /^\s*set\s+-[^\n]*e/mu); assert.doesNotMatch(guide, /\bexit\s+[1-9]\b/u);
  assert.doesNotMatch(guide, /safe\.directory=(?:['"]?\*|\$HOME|~)/u);
  assert.equal([...guide.matchAll(/git -c safe\.directory="\$KIT_ROOT" rev-parse HEAD/gu)].length, 2);
  assert.match(guide, /Pause all bots/u); assert.match(guide, /Owner account: capture the live snapshot/u);
  assert.match(guide, /Owner account: verify the snapshot/u);
  assert.equal([...guide.matchAll(/run `serve_check`/gu)].length >= 4, true);
  assert.equal([...guide.matchAll(/STOP:/gu)].length >= 10, true); assert.equal([...guide.matchAll(/return 1/gu)].length >= 10, true);
  assert.match(guide, /one file, `\/Users\/Shared\/control-room-e2e2\/INSTALL_NIGHT_PASTE\.txt`/u);
  assert.match(guide, /staging folder.*must be writable by the normal owner account/u);
  assert.match(guide, /three lead-supplied values.*`COMMIT40`.*`LIVE_PORTS`.*`LIVE_LABEL_PREFIXES`/u);
  assert.match(guide, /If a new Terminal window is opened, first paste the owner variable header/u);
  assert.match(guide, /owner runs `\/usr\/local\/bin\/tailscale status --json`/u);
  assert.match(guide, /your Mac password is typed only after every bot has stopped/u);
  assert.match(guide, /check-bots-stopped\.mjs/u);
  assert.match(guide, /quit the Claude app and the ChatGPT app \(Cmd-Q\)/u);
  assert.match(guide, /The lead is not available from here until the installer prints Ready \(or rolls back\)/u);
  assert.match(guide, /do not retry, copy the last lines/u);
  assert.doesNotMatch(guide, /tell the lead/u);
  assert.match(guide, /a QR code or a typed-code prompt in the Face ID step/u);
  assert.doesNotMatch(guide, /an unexplained retry prompt/u);
  assert.match(guide, /show the lead after reopening Claude/u);
  assert.doesNotMatch(guide, /fresh administrator/iu);
  assert.doesNotMatch(guide, /checksum handoff/iu);
  assert.match(guide, /\/usr\/bin\/sudo \/bin\/sh "\$KIT_ROOT\/scripts\/install-night\/bootstrap\.sh"/u);
  assert.match(guide, /"\$REHEARSAL_ROOT\/runtime\/node-current\/bin\/node"/u);
  assert.match(guide, /"\$REHEARSAL_ROOT\/updater\/current\/bin\/control-room\.mjs" uninstall-fresh/u);
  const bundle = JSON.parse(await readFile(join(repository, "src/updater/v1/policy/bundle.json"), "utf8"));
  const installedCli = bundle.entries.find(entry => entry.input === "cli.mjs")?.output;
  assert.ok(installedCli);
  assert.ok(guide.includes(`"$REHEARSAL_ROOT/updater/current/${installedCli}" uninstall-fresh`));
  assert.doesNotMatch(guide, /\[the exact C6/u);
  assert.doesNotMatch(guide, /current installer does not implement this probe/u);
  const serveFunction = /serve_check\(\) \{([\s\S]*?)\n\}/u.exec(guide)?.[1] ?? "";
  for (const variable of ["NODE_BIN", "KIT_ROOT", "LIVE_SNAPSHOT"]) assert.match(serveFunction, new RegExp(`${variable}=`, "u"));
});

test("zero live sources is refused unless the explicit no-live override is yes", async () => {
  const f = await fixture({ live: false }); await writeFile(join(f.state, "lsof"), "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n");
  await assert.rejects(configCommand(f), /live_sources_missing/u);
  await assert.rejects(runFile(process.execPath, [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net",
    "--output", join(f.root, "missing-live-inputs.json")], { env: f.env }), /live_inputs_required/u);
  await assert.rejects(runFile(process.execPath, [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net",
    "--no-live-install", "maybe", "--output", join(f.root, "bad-override.json")], { env: f.env }), /arguments_refused/u);
  const output = join(f.root, "no-live.json"), result = await runFile(process.execPath, [configCli, "--tailnet-name", "fixture-rehearsal.other-tail.ts.net",
    "--no-live-install", "yes", "--live-root", join(f.root, "absent"), "--system-root", f.system, "--output", output], { env: f.env });
  assert.match(result.stdout, /live sources read: 0/u);
});

test("live name, port, label prefix, case, root containment, and tailnet-suffix collisions are refused", async () => {
  const f = await fixture(), base = { tailnetName: "fixture-rehearsal.other-tail.ts.net", liveRoot: join(f.root, "absent"), systemRoot: f.system,
    liveHostname: "fixture-mac.live-tail.ts.net", livePorts: [3310, 3311, 7864], liveLabelPrefixes: ["com.controlroom."] };
  const oldTesting = process.env.CONTROL_ROOM_REHEARSAL_TESTING, oldCommands = process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR;
  process.env.CONTROL_ROOM_REHEARSAL_TESTING = "1"; process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR = f.bin;
  try {
    await assert.rejects(generateRehearsalConfigV1({ ...base, tailnetName: "fixture.other-tail.ts.net" }), /rehearsal_tailnet_refused/u);
    await assert.rejects(generateRehearsalConfigV1({ ...base, livePorts: [13210] }), /live_port_collision_refused/u);
    await assert.rejects(generateRehearsalConfigV1({ ...base, liveLabelPrefixes: ["XYZ.AGENTCONTROLROOM.REHEARSAL"] }), /live_label_collision_refused/u);
    await assert.rejects(generateRehearsalConfigV1({ ...base, tailnetName: "new-rehearsal.live-tail.ts.net." }), /live_host_collision_refused/u);
    const configRoot = join(f.root, "live-config"); await mkdir(join(configRoot, "Protected/config"), { recursive: true });
    await writeFile(join(configRoot, "Protected/config/supervisor.json"), JSON.stringify({ installRoot: `${REHEARSAL_ROOT_V1.toLowerCase()}/child` }));
    await assert.rejects(generateRehearsalConfigV1({ ...base, liveRoot: configRoot }), /live_root_collision_refused/u);
    await writeFile(join(configRoot, "Protected/config/supervisor.json"), JSON.stringify({ arbitrary: "13210" }));
    await assert.rejects(generateRehearsalConfigV1({ ...base, liveRoot: configRoot }), /live_port_collision_refused/u);
    await writeFile(join(configRoot, "Protected/config/supervisor.json"), JSON.stringify({ endpoint: "http://127.0.0.1:13211/path" }));
    await assert.rejects(generateRehearsalConfigV1({ ...base, liveRoot: configRoot }), /live_port_collision_refused/u);
    await writeFile(join(configRoot, "Protected/config/supervisor.json"), JSON.stringify({ account: "_CRDB_Rehearsal" }));
    await assert.rejects(generateRehearsalConfigV1({ ...base, liveRoot: configRoot }), /live_account_collision_refused/u);
    await writeFile(join(configRoot, "Protected/config/supervisor.json"), JSON.stringify({ dnsName: "FIXTURE-REHEARSAL.OTHER-TAIL.TS.NET." }));
    await assert.rejects(generateRehearsalConfigV1({ ...base, liveRoot: configRoot }), /live_host_collision_refused/u);
  } finally {
    if (oldTesting === undefined) delete process.env.CONTROL_ROOM_REHEARSAL_TESTING; else process.env.CONTROL_ROOM_REHEARSAL_TESTING = oldTesting;
    if (oldCommands === undefined) delete process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR; else process.env.CONTROL_ROOM_REHEARSAL_COMMAND_DIR = oldCommands;
  }
});

test("the real launchctl shape keeps nonnumeric, negative, and disabled rows", async () => {
  const labels = launchdLabelsV1(await readFile(join(fixtureRoot, "launchctl-print-system.txt"), "utf8"));
  assert.match(labels, /com\.controlroom\.live\.web/u); assert.match(labels, /com\.controlroom\.live\.worker/u); assert.match(labels, /com\.controlroom\.live\.disabled/u);
  assert.throws(() => launchdLabelsV1("system = {\n services = {\n unexpected row\n }\n}\n"), /launchctl_output_refused/u);
  const volatile = launchdLabelsV1("system = {\n services = {\n - 0 io.tailscale.ipn.macsys.network-extension.1.94.0\n - 0 com.controlroom.live.web\n }\n}\n");
  assert.doesNotMatch(volatile, /tailscale/iu); assert.match(volatile, /com\.controlroom\.live\.web/u);
});

test("snapshot diff is empty only with exactly one newly retained rehearsal root", async () => {
  const bad = await fixture(), badState = await before(bad);
  await mkdir(join(bad.system, REHEARSAL_ROOT_V1.slice(1)), { recursive: true });
  await assert.rejects(after(bad, badState, REHEARSAL_ROOT_V1), error => error.code === 1 && /retained_root_refused/u.test(error.stderr));
  const f = await fixture(), state = await before(f), kept = await retained(f);
  assert.match((await after(f, state, kept)).stdout, /PASS: system diff empty/u);
  const diff = JSON.parse(await readFile(join(state, "diff.json"), "utf8"));
  assert.deepEqual(diff.changed, []); assert.equal(diff.retainedRoot, kept); assert.equal(diff.passed, true);
  const stale = await fixture(); await retained(stale, "20260929T123456789Z");
  await assert.rejects(before(stale), /rehearsal_leftover_refused/u);
});

const leftovers = [
  ["account", f => writeFile(join(f.state, "users"), "_controlroom 207\n_crdb_rehearsal 219\nfixtureowner 501\n")],
  ["group", f => writeFile(join(f.state, "groups"), "_controlroom_rehearsal 219\nadmin 80\nstaff 20\n")],
  ["launchd nonnumeric row", f => writeFile(join(f.state, "launchctl"), "system = {\n services = {\n 0 (pe) xyz.agentcontrolroom.rehearsal.supervisor\n }\n}\n")],
  ["launchd disabled row", f => writeFile(join(f.state, "launchctl"), "system = {\n services = {\n }\n disabled services = {\n \"xyz.agentcontrolroom.rehearsal.supervisor\" => true\n }\n}\n")],
  ["LaunchAgent", f => writeFile(join(f.system, "Library/LaunchAgents/xyz.agentcontrolroom.rehearsal.agent.plist"), "changed\n")],
  ["LaunchDaemon", f => writeFile(join(f.system, "Library/LaunchDaemons/xyz.agentcontrolroom.rehearsal.daemon.plist"), "changed\n")],
  ["sudoers", f => writeFile(join(f.system, "etc/sudoers.d/control-room-rehearsal"), "changed\n")],
  ["newsyslog", f => writeFile(join(f.system, "etc/newsyslog.d/xyz.agentcontrolroom.rehearsal.conf"), "changed\n")],
  ["cron deny", f => writeFile(join(f.system, "usr/lib/cron/cron.deny"), "nobody\nfixture\n")],
  ["at deny", f => writeFile(join(f.system, "usr/lib/cron/at.deny"), "nobody\nfixture\n")],
  ["shim", f => writeFile(join(f.system, "usr/local/bin/control-room-rehearsal"), "changed\n")],
  ["same-name content", f => writeFile(join(f.system, "etc/sudoers.d/control-room"), "different bytes\n")],
  ["Serve", f => writeFile(join(f.state, "tailscale-serve"), "{\"TCP\":{}}\n")],
  ["Self.DNSName", f => writeFile(join(f.state, "tailscale-status"), "{\"Self\":{\"DNSName\":\"changed.other-tail.ts.net\"}}\n")],
  ["original rehearsal root", f => mkdir(join(f.system, REHEARSAL_ROOT_V1.slice(1)), { recursive: true })],
];
for (const [name, mutate] of leftovers) test(`snapshot refuses a leftover in ${name}`, async () => {
  const f = await fixture(), state = await before(f), kept = await retained(f); await mutate(f);
  await assert.rejects(after(f, state, kept), error => error.code === 1 && /snapshot_diff_not_empty/u.test(error.stderr));
});

test("snapshot refuses missing before evidence", async () => {
  const f = await fixture(), state = await before(f), kept = await retained(f); await rm(join(state, "before-tailscale-serve.txt"));
  await assert.rejects(after(f, state, kept), /snapshot_state_refused/u);
});

test("snapshot failure is retryable and leaves no incomplete private directory", async t => {
  const f = await fixture(), prefix = "control-room-e2e2-";
  // fixture() makes a private TMPDIR, passed to the snapshot CLI by before().
  t.after(() => rm(f.root, { recursive: true, force: true }));
  // Another job's snapshot appears during the failure. It belongs to the shared
  // parent, outside this fixture's TMPDIR, and must never enter our cleanup check.
  const unrelated = await temporary(prefix);
  t.after(() => rm(unrelated, { recursive: true, force: true }));
  await writeFile(join(unrelated, "owner-marker"), "another job\n");
  await rm(join(f.state, "tailscale-status")); await assert.rejects(before(f));
  const afterFailure = (await readdir(f.snapshotTemp)).filter(name => name.startsWith(prefix)); assert.deepEqual(afterFailure, []);
  assert.equal(await readFile(join(unrelated, "owner-marker"), "utf8"), "another job\n");
  await cp(join(fixtureRoot, "tailscale-status.json"), join(f.state, "tailscale-status"));
  const state = await before(f);
  assert.equal(state.startsWith(`${f.snapshotTemp}/`), true, "the retry publishes inside its own TMPDIR");
});

test("a stop halfway kills its process group and removes its partial snapshot", async t => {
  const group = await stoppedProcessFixtures();
  t.after(() => group.stop());
  const f = await fixture(), initial = new Set((await readdir(f.snapshotTemp)).filter(name => name.startsWith("control-room-e2e2-")));
  const child = spawn(group.launcher, [process.execPath, "--import", join(repository, "tests/helpers/exit-on-parent-pipe.mjs"), snapshotCli, "before", "--system-root", f.system], {
    env: { ...snapshotEnvironment(f), CONTROL_ROOM_REHEARSAL_PAUSE_AFTER: "capture" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stopped = false;
  t.after(() => { if (!stopped) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } } });
  let partial;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const names = (await readdir(f.snapshotTemp)).filter(name => name.startsWith("control-room-e2e2-") && !initial.has(name));
    for (const name of names) if (await lstat(join(f.snapshotTemp, name, "paused")).then(() => true, () => false)) partial = name;
    if (partial) break; await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.ok(partial); const exited = new Promise(resolvePromise => child.once("exit", (...values) => resolvePromise(values)));
  process.kill(-child.pid, "SIGTERM"); const [code] = await exited; stopped = true; assert.notEqual(code, 0);
  for (let attempt = 0; attempt < 100 && await lstat(join(f.snapshotTemp, partial)).then(() => true, () => false); attempt += 1) await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  assert.equal(await lstat(join(f.snapshotTemp, partial)).then(() => true, () => false), false);
});

test("twenty concurrent after callers serialize and only one publishes a diff", async () => {
  const f = await fixture(), state = await before(f), kept = await retained(f), results = await Promise.allSettled(Array.from({ length: 20 }, () => after(f, state, kept)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.filter(result => result.status === "rejected").length, 19);
});

const transactionId = "11111111-1111-4111-8111-111111111111", commit = "a".repeat(40), root = REHEARSAL_ROOT_V1, at = "2026-09-30T12:00:00.000Z";
function bound(row) { return { ...row, transactionId, commit, root }; }
function journal({ health = true } = {}) {
  return [bound({ schema: "control-room.install-journal/v2", command: "install", sequence: 1, phase: "done", action: "fresh-database", at, data: { selected: true } }),
    bound({ schema: "control-room.install-journal/v2", command: "install", sequence: 2, phase: "done", action: "health-check", at,
      data: { healthy: health, samples: health ? 3 : 2, schemaDigest: `sha256:${"a".repeat(64)}` } }),
    bound({ schema: "control-room.install-journal/v2", command: "install", sequence: 3, phase: "done", action: "transaction", at, data: { state: "installed" } })];
}
function evidence() {
  return [bound({ schema: "control-room.e2e2-evidence/v1", kind: "passkey", status: "registered" }),
    ...["node", "pnpm", "esbuild", "postgresql"].map(tree => bound({ schema: "control-room.e2e2-evidence/v1", kind: "runtime-root-metadata", tree, passed: true, entries: 2 })),
    ...["postgres", "supervisor"].map(role => bound({ schema: "control-room.e2e2-evidence/v1", kind: "seatbelt", role, applied: true, skipped: false })),
    ...["capture", "activate", "restore"].map(step => bound({ schema: "control-room.e2e2-evidence/v1", kind: "tailscale-step", step, outcome: "skipped (rehearsal)" })),
    bound({ schema: "control-room.e2e2-evidence/v1", kind: "spawn-count", expected: 2 }),
    bound({ schema: "control-room.e2e2-evidence/v1", kind: "spawn-t1", spawnId: "one", passed: true }),
    bound({ schema: "control-room.e2e2-evidence/v1", kind: "spawn-t1", spawnId: "two", passed: true }),
    bound({ schema: "control-room.e2e2-evidence/v1", kind: "owner-uid", uid: 501 }),
    bound({ schema: "control-room.e2e2-evidence/v1", kind: "health", healthy: true, samples: 3,
      schemaDigest: `sha256:${"a".repeat(64)}` }),
    ...["read", "write", "signal"].map(operation => bound({ schema: "control-room.e2e2-evidence/v1", kind: "p0-denial", operation, uid: 501, denied: true }))];
}

test("collector renders every required row and fails closed on mixed or stale evidence", () => {
  const pass = collectResultsV1(journal(), evidence()); assert.equal(pass.passed, true); assert.match(renderResultsV1(pass), /Overall: \*\*PASS\*\*/u);
  const mixed = journal(); mixed[0] = { ...mixed[0], transactionId: "22222222-2222-4222-8222-222222222222" };
  assert.equal(collectResultsV1(mixed, evidence()).passed, false);
  const stale = evidence(); stale[0] = { ...stale[0], commit: "b".repeat(40) }; assert.equal(collectResultsV1(journal(), stale).passed, false);
});

test("collector independently fails every evidence guard", () => {
  const cases = [
    ["installed", journal().map(row => row.action === "transaction" ? { ...row, data: { state: "failed" } } : row), evidence()],
    ["fresh", journal().map(row => row.action === "fresh-database" ? { ...row, data: { selected: false } } : row), evidence()],
    ["runtime", journal(), evidence().filter(row => row.kind !== "runtime-root-metadata" || row.tree !== "node")],
    ["seatbelt", journal(), evidence().map(row => row.kind === "seatbelt" && row.role === "postgres" ? { ...row, skipped: true } : row)],
    ["tailscale", journal(), evidence().map(row => row.kind === "tailscale-step" && row.step === "activate" ? { ...row, outcome: "done" } : row)],
    ["duplicate", journal(), [...evidence(), evidence()[0]]],
    ["T1", journal(), evidence().map(row => row.kind === "spawn-t1" && row.spawnId === "two" ? { ...row, passed: false } : row)],
    ["owner uid", journal(), evidence().map(row => row.kind === "p0-denial" && row.operation === "read" ? { ...row, uid: 502 } : row)],
    ["P0", journal(), evidence().filter(row => row.kind !== "p0-denial" || row.operation !== "signal")],
    ["health journal", journal({ health: false }), evidence()],
    ["health evidence", journal(), evidence().filter(row => row.kind !== "health")],
  ];
  for (const [name, changedJournal, changedEvidence] of cases) assert.equal(collectResultsV1(changedJournal, changedEvidence).passed, false, name);
});

test("collector requires owner-private readable copies and refuses missing data", async () => {
  const base = await temporary("control-room-e2e2-cli-"), journalPath = join(base, "journal.jsonl"), evidencePath = join(base, "evidence.jsonl"), output = join(base, "report.md");
  await Promise.all([writeFile(journalPath, `${journal().map(JSON.stringify).join("\n")}\n`, { mode: 0o600 }), writeFile(evidencePath, `${evidence().map(JSON.stringify).join("\n")}\n`, { mode: 0o600 })]);
  await runFile(process.execPath, [collectorCli, "--journal", journalPath, "--evidence", evidencePath, "--output", output]);
  await assert.rejects(runFile(process.execPath, [collectorCli, "--journal", journalPath, "--evidence", evidencePath, "--output", output]), /output_exists/u);
  await rm(evidencePath); await assert.rejects(runFile(process.execPath, [collectorCli, "--journal", journalPath, "--evidence", evidencePath, "--output", join(base, "missing.md")]), /rehearsal_evidence_refused/u);
});

test("the capability gate requires every C6 control and every Tailscale skip outcome", async () => {
  assert.equal(verifyInstallerCapabilitiesV1(REQUIRED_INSTALLER_CAPABILITIES_V1), true);
  for (const field of ["capture", "activate", "restore"]) {
    const changed = structuredClone(REQUIRED_INSTALLER_CAPABILITIES_V1); changed.rehearsal.tailscale[field] = "done";
    assert.throws(() => verifyInstallerCapabilitiesV1(changed), /installer_capabilities_refused/u);
  }
  const base = await temporary("control-room-e2e2-capabilities-"), input = join(base, "capabilities.json");
  await writeFile(input, JSON.stringify(REQUIRED_INSTALLER_CAPABILITIES_V1));
  assert.match((await runFile(process.execPath, [capabilityCli, "--input", input])).stdout, /no Tailscale mutation/u);
});

test("thirty parallel no-live config callers are isolated", async () => {
  const base = await temporary("control-room-e2e2-load-");
  const calls = Array.from({ length: 30 }, (_, index) => runFile(process.execPath, [configCli, "--tailnet-name", `fixture-${index}-rehearsal.other-tail.ts.net`,
    "--no-live-install", "yes", "--live-root", join(base, "absent"), "--output", join(base, `config-${index}.json`)]));
  assert.equal((await Promise.all(calls)).length, 30);
});

test("rehearsal scripts contain no privileged system mutation commands", async () => {
  const directory = join(repository, "scripts/install/rehearsal"), files = (await readdir(directory)).filter(name => /\.(?:mjs|sh)$/u.test(name));
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    assert.doesNotMatch(source, /\bdscl\b[^\n]*(?:create|delete)/iu, file);
    assert.doesNotMatch(source, /\blaunchctl\b[^\n]*(?:bootstrap|bootout|load|unload)/iu, file);
    assert.doesNotMatch(source, /\/usr\/bin\/sudo|\bexecFile\([^\n]*["']sudo["']/u, file);
    assert.doesNotMatch(source, /\btailscale\s+(?:set|up|serve|funnel)\b/iu, file);
  }
});

test("collector requires one bound registered practice passkey and recovers after failed evidence", () => {
  const good = evidence(), passkey = good.find(row => row.kind === "passkey");
  for (const changed of [good.filter(row => row.kind !== "passkey"), [...good, passkey],
    ...["stopped", "failed", undefined, true].map(status => good.map(row => row.kind === "passkey" ? { ...row, status } : row)),
    good.map(row => row.kind === "passkey" ? { ...row, transactionId: "22222222-2222-4222-8222-222222222222" } : row)]) {
    const result = collectResultsV1(journal(), changed);
    assert.equal(result.passed, false);
    assert.equal(result.rows.find(row => row.check === "practice passkey registered").passed, false);
    assert.match(renderResultsV1(result), /Overall: \*\*FAIL\*\*/u);
  }
  for (let caller = 0; caller < 50; caller += 1) {
    assert.equal(collectResultsV1(journal(), good).passed, true);
  }
});

test("collector CLI writes FAIL for an unregistered passkey, retries with corrected evidence, and handles a burst", async () => {
  const base = await temporary("control-room-e2e2-passkey-"), journalPath = join(base, "journal.jsonl"), evidencePath = join(base, "evidence.jsonl");
  await writeFile(journalPath, `${journal().map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const writeEvidence = rows => writeFile(evidencePath, `${rows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const collect = output => runFile(process.execPath, [collectorCli, "--journal", journalPath, "--evidence", evidencePath, "--output", output]);
  for (const status of [undefined, "stopped"]) {
    await writeEvidence(evidence().flatMap(row => row.kind !== "passkey" ? [row] : status ? [{ ...row, status }] : []));
    const output = join(base, `failed-${status ?? "missing"}.md`);
    await assert.rejects(collect(output), error => error.code === 1 && /Overall: \*\*FAIL\*\*/u.test(error.stdout));
    assert.match(await readFile(output, "utf8"), /practice passkey registered \| FAIL/u);
  }
  await writeEvidence(evidence());
  const outputs = Array.from({ length: 20 }, (_, index) => join(base, `pass-${index}.md`));
  const results = await Promise.all(outputs.map(collect));
  for (const result of results) assert.match(result.stdout, /practice passkey registered \| PASS/u);
  const duplicate = join(base, "one-output.md"), callers = await Promise.allSettled([collect(duplicate), collect(duplicate)]);
  assert.equal(callers.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(callers.filter(result => result.status === "rejected" && /output_exists/u.test(result.reason.stderr)).length, 1);
});

test("A2-06 rehearsal generator refuses duplicate live configuration and pinned snapshot keys", async () => {
  const f = await fixture({ live: false }), liveRoot = join(f.root, 'live');
  await mkdir(join(liveRoot, 'Protected/config'), { recursive: true });
  const path = join(liveRoot, 'Protected/config/host.json');
  await writeFile(path, '{"webPort":13210,"webPort":54321}');
  await assert.rejects(configCommand(f), /live_config_refused/u);
  const { readPinnedLiveSnapshotV1 } = await import('../scripts/install/rehearsal/config.mjs');
  const snapshot = { schema: 'control-room.e2e2-owner-live-snapshot/v1', sourcesRead: 1,
    hostname: 'fixture.example', ports: [], labels: [], accounts: [], roots: [], hosts: ['fixture.example'], serveStatus: {} };
  const valid = JSON.stringify(snapshot), duplicate = valid.replace('"sourcesRead":', '"sourcesRead":0,"sourcesRead":');
  const pinned = join(f.root, 'pinned.json'); await writeFile(pinned, duplicate);
  await assert.rejects(readPinnedLiveSnapshotV1(pinned, digest(duplicate)), /live_snapshot_refused/u);
  await writeFile(pinned, valid); assert.equal((await readPinnedLiveSnapshotV1(pinned, digest(valid))).snapshot.sourcesRead, 1);
});

test("collector retains complete evidence before a torn final line and refuses middle corruption", async () => {
  const base = await temporary("control-room-e2e2-tail-"), journalPath = join(base, "journal.jsonl"), evidencePath = join(base, "evidence.jsonl");
  const prefix = `${evidence().map(JSON.stringify).join("\n")}\n`;
  await writeFile(journalPath, `${journal().map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  for (const [index, tail] of ['{"torn"', '{"torn"\n'].entries()) {
    await writeFile(evidencePath, prefix + tail, { mode: 0o600 });
    await runFile(process.execPath, [collectorCli, "--journal", journalPath, "--evidence", evidencePath, "--output", join(base, `good-${index}.md`)]);
  }
  for (const [index, middle] of ['{"torn"\n', '\n'].entries()) {
    await writeFile(evidencePath, middle + prefix, { mode: 0o600 });
    await assert.rejects(runFile(process.execPath, [collectorCli, "--journal", journalPath, "--evidence", evidencePath, "--output", join(base, `bad-${index}.md`)]), /rehearsal_evidence_refused/u);
  }
});

const families = rows => rows.map(row => row.family);
const unknown = 'unidentified';
const pure = (program, args = '', fact = {}, identity) => parseOwnerBotProcessesV1(psRow(501, 700, 1, program, args), 501,
  { facts: new Map([['700', { executable: program, cwd: '/fixture/plain', ...fact }]]), identities: new Map([[700, identity]]) });

test('R5SD: all earlier binary, runtime and wrapper false safes remain refusals', () => {
  for (const [path, family] of [
    ['/fixture/bin/opencode', 'opencode'], ['/fixture/bin/opencode-ai', 'opencode'], ['/fixture/bin/myclaude', 'claude'],
    ['/fixture/bin/notacodex', 'codex'], ['/fixture/bin/claude2.1.13', 'claude'], ['/fixture/bin/codex_2.1.13', 'codex'],
    ['/fixture/bin/hermes_worker', 'hermes'], ['/fixture/home/.claude/versions/2.1.13', 'claude'],
    ['/fixture/home/claude/versions/2.1.13', 'claude'], ['/Volumes/Fixture Disk/cli/codex', 'codex'],
    ['/Applications/Claude.app/Contents/MacOS/Claude', 'claude'],
    ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex'],
  ]) assert.deepEqual(families(pure(path)), [family], path);
  for (const runtime of ['node', 'python3', 'ruby', 'perl', 'bun', 'deno', 'java', 'tsx', 'ts-node']) {
    for (const [script, family] of [
      ['/opt/claude-worker/cli.js', 'claude'], ['/opt/codex-tool/bin/codex.js', 'codex'],
      ['/opt/hermes-elsewhere/run.js', 'hermes'], ['/opt/node_modules/@anthropic-ai/claude-code/index.js', 'claude'],
      ['/opt/pkg/@openai/codex/cli.py', 'codex'], ['/opt/lib/opencode-ai/index.js', 'opencode'],
      ['/fixture/.hermes/hooks/run.py', 'hermes'],
    ]) assert.deepEqual(families(pure(`/opt/bin/${runtime}`, `--flag ${script}`)), [family], `${runtime} ${script}`);
  }
  for (const launcher of ['env', 'npx', 'bunx', 'pnpm', 'npm', 'yarn']) {
    assert.deepEqual(families(pure(`/opt/bin/${launcher}`, 'NODE_ENV=production dlx /opt/claude-worker/cli.js')), ['claude'], launcher);
  }
  assert.deepEqual(parseOwnerBotProcessesV1(psRow(502, 700, 1, '/opt/bin/codex'), 501), []);
});

test('R5SD: generic modules, inline code, readable files and self-authored titles never exempt', async () => {
  const directory = await temporary('stopped-process-readable-'), readable = join(directory, 'plain.mjs');
  await writeFile(readable, '');
  for (const path of ['/usr/bin/node', '/usr/bin/python3', '/usr/bin/ruby', '/usr/bin/perl', '/usr/bin/java', '/bin/sh', '/bin/zsh',
    '/bin/bash', '/usr/bin/osascript', '/usr/bin/env', '/opt/bin/unknown', '/opt/homebrew/bin/renamed',
    '/opt/home/.hermes/node/bin/node', '/Library/Frameworks/Python.framework/Versions/3/Resources/Python.app/Contents/MacOS/Python']) {
    for (const args of ['', '-m pkg', '-m http.server', '-c pass', '-e 1+1', readable, '.', '--version', 'plain.js', 'My Agent Worker']) {
      assert.deepEqual(families(pure(path, args)), [unknown], `${path} ${args}`);
    }
  }
  for (const title of ['erased-worker idle', 'renamed idle', '/fixture/plain', 'My Agent Worker', '(sleep)']) {
    const row = psRow(501, 700, 1, title);
    const found = parseOwnerBotProcessesV1(row, 501, { facts: new Map([['700', { executable: '/fixture/erased-worker', cwd: '/fixture/plain' }]]) });
    assert.deepEqual(families(found), [unknown], title);
  }
  for (const path of ['/Applications/Claude.app/Contents/Resources/node', '/Applications/Image Lab.app/Contents/MacOS/run',
    '/Applications/ComfyUI.app/Contents/MacOS/python', '/Applications/Unknown.app/Contents/MacOS/run']) {
    assert.equal(pure(path).length, 1, path);
  }
  assert.deepEqual(families(pure('/opt/unknown', '', { cwd: '/srv/hermes-data' })), ['hermes']);
  assert.equal(pure('/opt/unknown', '', { cwd: '/srv/hermes-data' })[0].reason, 'works in a hermes folder');
  assert.equal(parseOwnerBotProcessesV1(psRow(501, 700, 1, '/opt/unknown'), 501)[0].executable, null);
});

test('R5SD: malformed process and kernel input, invalid uid and missing identity refuse', () => {
  for (const row of ['501 1', '501 1 0 /opt/node', '501 1 0 /usr/bin/xyz         /opt/bin/abc',
    `501 1 0 ${'/opt/bin/opencode'.slice(0, 16)}`, '501 1 0 /long/cut/program', '999999999999999999999 1 0 /opt/bin/plain    /opt/bin/plain']) {
    assert.throws(() => parseOwnerBotProcessesV1(row, 501), /bot_check_output_refused/u, row);
  }
  for (const uid of [0, -1, NaN, 1.5]) assert.throws(() => parseOwnerBotProcessesV1('', uid), /bot_check_uid_refused/u);
  for (const data of ['pnot-a-pid\n', 'p0\n', 'u501\n', 'n/fixture\n', 'p8\nftxt\ninot-an-inode\n', 'p8\nftxt\nnrelative\n']) {
    assert.throws(() => parseKernelFactsV1(data), /bot_check_kernel_refused/u, data);
  }
  assert.deepEqual(families(pure('/usr/bin/sleep')), [unknown], 'a system path by itself is insufficient');
});

function signingFixture({ real = path => path, failVerify = false, platform = true, team = 'EQHXZ8M8AV', id = 'com.google.Chrome',
  rootId = id, binaryId = id, changed = false, changedRoot = false, authority = 'macOS Software Signing',
  cdhash = 'a'.repeat(40), failDisplay = false,
  chain = ['Apple Code Signing Certification Authority', 'Apple Root CA'] } = {}) {
  let reads = 0, rootReads = 0;
  const files = { realpath: real, read: () => Buffer.from('postgres fixture'), stat: path => ({ isFile: () => true,
    dev: 1n, ino: 77n, size: 100n, mtimeNs: (changed && ++reads > 1) || (changedRoot && path.endsWith('Info.plist') && ++rootReads > 1) ? 2n : 1n, ctimeNs: 1n }) };
  const calls = [];
  const run = async (path, args, options) => {
    calls.push(args); assert.equal(path, '/usr/bin/codesign'); assert.ok(options.timeout <= 5_000);
    if (args.includes('--verify')) {
      if (args.includes('-R')) assert.ok(args[args.indexOf('-R') + 1].startsWith('='), 'inline codesign requirements need the equals prefix');
      if (failVerify === true || (failVerify === 'root' && args.at(-1).endsWith('.app')) || (failVerify === 'binary' && !args.at(-1).endsWith('.app'))) throw new Error('bad signature');
      return { stdout: '', stderr: '' };
    }
    if (failDisplay) throw new Error('metadata refused');
    return { stdout: '', stderr: `CDHash=${cdhash}\nAuthority=${authority}\n${chain.map(value => `Authority=${value}\n`).join('')}Identifier=${args.at(-1).endsWith('.app') ? rootId : binaryId}\nTeamIdentifier=${team}\n${platform ? 'Platform identifier=26\n' : ''}` };
  };
  return { files, run, calls, sipEnabled: true };
}
const trusted = async (path, options = {}, inode = '77') => trustedExecutableV1({ executable: path, inode }, signingFixture(options));

const appleBackgroundPrograms = [
  '/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/MacOS/XProtect',
  '/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/XPCServices/XProtectPluginService.xpc/Contents/MacOS/XProtectPluginService',
  '/System/Volumes/Preboot/Cryptexes/OS/System/Library/PrivateFrameworks/SafariPlatformSupport.framework/Versions/A/XPCServices/com.apple.SafariPlatformSupport.Helper.xpc/Contents/MacOS/com.apple.SafariPlatformSupport.Helper',
];

test('R5SD: obsolete-envelope Apple platform images are exempt while changed and non-Apple files stay listed', async () => {
  const programs = [...appleBackgroundPrograms, '/Library/Apple/System/Library/fixture-daemon'];
  for (const path of programs) {
    for (const authority of ['Software Signing', 'macOS Software Signing']) {
      const port = signingFixture({ failVerify: true, authority, platform: false });
      const identity = await trustedExecutableV1({ executable: path, inode: '77' }, port);
      assert.equal(identity, 'system', path);
      assert.deepEqual(pure(path, '', {}, identity), [], 'obsolete resource envelope does not list Apple background programs');
      assert.ok(port.calls.every(args => args[0] === '-d'), 'no envelope verification required');
    }
    for (const options of [
      { authority: '' }, { authority: 'Developer ID Application: fixture vendor' }, { authority: 'Software Signing impostor' },
      { authority: 'macOS Software Signing impostor' }, { cdhash: '' }, { cdhash: 'g'.repeat(40) },
      { cdhash: 'a'.repeat(39) }, { cdhash: 'a'.repeat(41) }, { changed: true }, { failDisplay: true },
      { chain: [] }, { chain: ['Apple Root CA'] }, { chain: ['Apple Code Signing Certification Authority'] },
      { chain: ['Apple Code Signing Certification Authority impostor', 'Apple Root CA'] },
      { chain: ['Apple Code Signing Certification Authority', 'Apple Root CA impostor'] },
      { chain: ['Apple Root CA', 'Apple Code Signing Certification Authority'] },
      { chain: ['Apple Code Signing Certification Authority', 'Apple Root CA', 'Extra CA'] },
    ]) {
      const identity = await trusted(path, options);
      assert.equal(identity, undefined, JSON.stringify(options));
      assert.deepEqual(families(pure(path, '', {}, identity)), [unknown], 'untrusted file stays listed');
    }
    assert.deepEqual(families(pure(path, '', {}, await trusted(path, {}, '88'))), [unknown], 'substituted inode stays listed');
    assert.deepEqual(families(pure(path, '', {}, await trusted(path, { real: () => '/fixture/substitute' }))), [unknown]);
  }
  for (const name of ['node', 'python3', 'ruby', 'perl', 'osascript', 'env', 'npx', 'sh', 'zsh']) {
    const path = `/Library/Apple/System/Library/${name}`;
    assert.deepEqual(families(pure(path, '', {}, await trusted(path))), [unknown], name);
  }
  for (const path of ['/Library/Apple-impostor/daemon', '/Library/AppleExtra/daemon', '/Library/daemon', '/usr/local/bin/daemon',
    '/SystemExtra/daemon', '/bin-extra/daemon', '/sbin-extra/daemon', '/usr-extra/daemon', '/fixture/writable/daemon',
    '/System/Volumes/Data/private/tmp/daemon', '/System/Volumes/Data/usr/local/bin/daemon']) {
    for (const platform of [true, false]) {
      assert.deepEqual(families(pure(path, '', {}, await trusted(path, { platform }))), [unknown], 'Apple-looking metadata cannot exempt a writable location');
    }
  }
  assert.equal(await trusted(programs[0], { cdhash: 'ABCDEF0123'.repeat(4), platform: false }), 'system', '40-hex CDHash');
  const identities = await Promise.all(Array.from({ length: 50 }, () => trusted(programs[0], { failVerify: true })));
  assert.ok(identities.every(identity => identity === 'system'), '50 concurrent platform inspections');
  assert.equal(await trusted(programs[0], { failDisplay: true }), undefined, 'dropped metadata refuses');
  assert.equal(await trusted(programs[0]), 'system', 'retry after failure is independent');
});

test('R5SD: real Apple background platform controls use native signing metadata', async t => {
  const { statSync } = await import('node:fs');
  const identities = [];
  for (const path of appleBackgroundPrograms) {
    if (!existsSync(path)) { t.diagnostic(`PLATFORM CONTROL absent: ${basename(path)}`); continue; }
    const identity = await trustedExecutableV1({ executable: path, inode: String(statSync(path, { bigint: true }).ino) });
    t.diagnostic(`PLATFORM CONTROL ${basename(path)}: ${identity ?? 'unverified'}`);
    identities.push(identity);
    assert.deepEqual(pure(path, '', {}, identity), [], 'native background image is not listed');
  }
  assert.ok(identities.every(identity => identity === 'system'), 'all installed Apple background images must be exempt');
});

test('R5SD: real ad-hoc re-signed XProtect and changing platform files stay listed', async t => {
  const { statSync } = await import('node:fs');
  const original = appleBackgroundPrograms[0];
  if (!existsSync(original)) { t.diagnostic('XProtect copy control absent'); return; }
  const root = await temporary('platform-signature-control-'), copy = join(root, 'XProtect');
  await copyFile(original, copy);
  const originalDisplay = await runFile('/usr/bin/codesign', ['-d', '--verbose=4', original]);
  const copyDisplay = await runFile('/usr/bin/codesign', ['-d', '--verbose=4', copy]);
  const signingFields = value => value.stderr.split('\n').filter(line => /^(?:Authority|CDHash)=/u.test(line));
  assert.deepEqual(signingFields(copyDisplay), signingFields(originalDisplay), 'writable copy preserves the native signature');
  const copyFact = { executable: copy, inode: String(statSync(copy, { bigint: true }).ino) };
  assert.deepEqual(families(pure(copy, '', {}, await trustedExecutableV1(copyFact))), [unknown], 'unchanged signed copy in a writable directory is listed');
  const dataCopy = `/System/Volumes/Data${realpathSync(copy)}`;
  if (existsSync(dataCopy)) {
    assert.equal(realpathSync(dataCopy), dataCopy, 'Data volume alias survives realpath');
    assert.deepEqual(families(pure(dataCopy, '', {}, await trustedExecutableV1({ ...copyFact, executable: dataCopy }))),
      [unknown], 'the writable Data volume is outside SIP system-image treatment');
  }
  await runFile('/usr/bin/codesign', ['--force', '--sign', '-', copy]);
  const fact = { executable: original, inode: String(statSync(copy, { bigint: true }).ino) };
  // Substitute the copy's real inode into the trusted logical location. Native
  // codesign reads the copy; a temporary path alone would trivially refuse it.
  const files = { realpath: path => path, stat: () => statSync(copy, { bigint: true }) };
  const run = (file, args, options) => runFile(file, [...args.slice(0, -1), copy], options);
  assert.deepEqual(families(pure(original, '', {}, await trustedExecutableV1(fact, { files, run }))), [unknown]);
  let changed = false;
  const changing = async (file, args, options) => {
    const result = await runFile(file, args, options);
    changed = true;
    return result;
  };
  // Real platform output with an injected stamp change avoids touching OS files.
  const platformPath = '/bin/sleep', stable = statSync(platformPath, { bigint: true });
  const concurrent = await Promise.all(Array.from({ length: 50 }, () => trustedExecutableV1({ executable: platformPath, inode: String(stable.ino) })));
  assert.ok(concurrent.every(identity => identity === 'system'), '50 concurrent native platform inspections');
  const changingFiles = { realpath: path => path, stat: () => ({ ...stable, isFile: () => true, mtimeNs: stable.mtimeNs + (changed ? 1n : 0n) }) };
  assert.equal(await trustedExecutableV1({ executable: platformPath, inode: String(stable.ino) }, { files: changingFiles }), 'system', 'native stable baseline');
  assert.deepEqual(families(pure(platformPath, '', {}, await trustedExecutableV1({ executable: platformPath, inode: String(stable.ino) },
    { files: changingFiles, run: changing }))), [unknown], 'native platform evidence cannot survive a changed stamp');
});

test('R5SD: exemptions require real paths, Apple platform evidence and verified exact app identities', async () => {
  for (const path of ['/bin/sleep', '/usr/bin/sleep', '/usr/sbin/distnoted', '/usr/libexec/useractivityd', '/System/Library/CoreServices/daemon']) {
    assert.equal(await trusted(path), 'system', path);
    assert.equal(await trusted(path, { failVerify: true }), 'system', 'platform identity does not depend on resource envelopes');
    assert.equal(await trusted(path, { failDisplay: true }), undefined, path);
    assert.equal(await trusted(path, { platform: false }), 'system', 'SIP-path Apple chain does not require a Platform identifier');
  }
  assert.equal(await trusted('/usr/bin/sleep', { real: () => '/fixture/renamed' }), undefined, 'symlink into an untrusted directory');
  assert.equal(await trusted('/usr/local/bin/sleep'), undefined);
  assert.equal(await trusted('/usr/bin/sleep', { changed: true }), undefined, 'replacement during signature verification');
  assert.equal(await trusted('/usr/bin/sleep', {}, '88'), undefined, 'mapped inode differs from signed file');
  assert.equal(await trustedExecutableV1({ executable: '/usr/bin/sleep' }, signingFixture()), undefined, 'no mapped inode evidence');
  for (const path of ['/usr/bin/python3', '/usr/bin/ruby', '/usr/bin/perl', '/usr/bin/java', '/usr/bin/osascript',
    '/usr/bin/tclsh8.5', '/usr/bin/wish8.5', '/usr/bin/expect', '/usr/bin/jrunscript', '/usr/bin/automator', '/usr/bin/shortcuts']) {
    assert.equal(await trusted(path), undefined, path);
  }
  assert.equal(await trusted('/bin/zsh'), 'shell', 'shell identity requires a terminal ancestry check before exemption');
  assert.equal(await trusted('/bin/zsh', { platform: false }), undefined, 'shell verification still requires platform metadata');
  assert.equal(await trusted('/bin/zsh', { failVerify: true }), undefined, 'shell signature must still verify');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(await trusted(chrome), 'app');
  const editor = '/Applications/Visual Studio Code.app/Contents/Resources/node';
  assert.equal(await trusted(editor, { team: 'UBF8T346G9', id: 'com.microsoft.VSCode' }), 'app', 'reviewed app-bundled runtime');
  for (const options of [{ failVerify: true }, { failVerify: 'root' }, { failVerify: 'binary' }, { team: 'ADHOC' },
    { rootId: 'com.google.Other' }, { binaryId: 'com.google.Other' }, { changedRoot: true }, { real: () => '/fixture/Chrome.app/Contents/MacOS/run' }]) {
    assert.equal(await trusted(chrome, options), undefined, JSON.stringify(options));
  }
  assert.equal(await trusted('/Applications/Claude.app/Contents/MacOS/Claude', { team: 'EQHXZ8M8AV', id: 'com.google.Chrome' }), undefined);
  for (const identity of ['system', 'app', 'terminal', 'postgres']) {
    assert.deepEqual(pure('/fixture/program', '', {}, identity), [], identity);
    assert.deepEqual(families(pure('/fixture/program', '', { cwd: '/srv/hermes-data' }, identity)), ['hermes'], 'folder evidence still refuses');
  }
});

test('R5SD: PostgreSQL uses the configured exact real path, complete digest and signature', async () => {
  const postgres = { executable: '/fixture/pg/bin/postgres', sha256: digest('postgres fixture') };
  const fact = { executable: postgres.executable, inode: '77' };
  assert.equal(await trustedExecutableV1(fact, { ...signingFixture(), postgres }), 'postgres');
  for (const options of [ { postgres: { ...postgres, sha256: '0'.repeat(64) } }, { postgres: { ...postgres, executable: '/other/bin/postgres' } },
    { postgres, ...signingFixture({ failVerify: true }) }, {} ]) {
    assert.equal(await trustedExecutableV1(fact, { ...signingFixture(), ...options }), undefined);
  }
  for (const value of [{}, { ...postgres, executable: 'relative/postgres' }, { ...postgres, executable: '/fixture/../postgres' },
    { ...postgres, executable: '/fixture/node' }, { ...postgres, sha256: 'BAD' }]) {
    await assert.rejects(checkOwnerBotsStoppedV1({ postgres: value }), /bot_check_postgres_config_refused/u);
  }
});

test('R5SD: only the check tree and verified invoking shell chain are exempt', () => {
  const rows = [psRow(501, 10, 1, '/terminal'), psRow(501, 11, 10, '/bin/zsh'), psRow(501, 12, 11, '/node'),
    psRow(501, 13, 12, '/usr/sbin/lsof'), psRow(501, 14, 1, '/bin/zsh'), psRow(501, 15, 1, '/node')].join('\n');
  const identities = new Map([[10, 'terminal'], [11, 'shell'], [14, 'shell']]);
  const facts = new Map([['12', { uid: 501, ppid: 11 }], ['11', { uid: 501, ppid: 10 }], ['13', { uid: 501, ppid: 12 }]]);
  assert.deepEqual(parseOwnerBotProcessesV1(rows, 501, { selfPid: 12, identities, facts }).map(row => row.pid), [14, 15]);
  assert.deepEqual(parseOwnerBotProcessesV1(rows, 501, { selfPid: 12, identities }).map(row => row.pid), [11, 13, 14, 15], 'stale ps parentage alone is insufficient');
  identities.delete(10);
  assert.deepEqual(parseOwnerBotProcessesV1(rows, 501, { selfPid: 12, identities, facts }).map(row => row.pid), [10, 11, 14, 15]);
  // Being an ancestor or calling itself an interactive shell cannot exempt a runtime.
  identities.set(10, 'terminal'); identities.delete(11);
  assert.deepEqual(parseOwnerBotProcessesV1(rows, 501, { selfPid: 12, identities, facts }).map(row => row.pid), [11, 14, 15]);
});

const kernelRow = (pid, executable = '/fixture/plain', uid = 501, ppid = 1) => `p${pid}\nu${uid}\nR${ppid}\nfcwd\ntDIR\nn/fixture/plain\nftxt\ntREG\ni77\nn${executable}\n`;
function scanPort(ps, kernel) {
  let psRead = 0, kernelRead = 0;
  const calls = [];
  const run = async (path, args) => { calls.push([path, args]); return { stdout: path === '/usr/bin/csrutil' ? 'System Integrity Protection status: enabled.\n' : path === '/bin/ps' ? ps[Math.min(psRead++, ps.length - 1)]
    : kernel[Math.min(kernelRead++, kernel.length - 1)], stderr: '' }; };
  return { run, calls, alive: () => true, ownerUid: 501, selfPid: 999999, identify: async () => undefined };
}

const sipOwnerLine = 'SIP is not fully on, so Apple background programs may be listed. Show the lead.';
function sipScanPort(status, { platform = false } = {}) {
  const port = scanPort([''], [kernelRow(701, '/bin/sleep') + kernelRow(702, '/bin/sleep') + kernelRow(703, '/usr/bin/true')]);
  const signing = signingFixture({ platform, failVerify: true });
  const scan = port.run, warnings = [];
  let sipReads = 0, aborted = false;
  port.run = async (file, args, options) => {
    if (file === '/usr/bin/csrutil') {
      sipReads++;
      assert.deepEqual(args, ['status']);
      assert.ok(options.timeout > 0 && options.timeout <= 5_000);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.env.LC_ALL, 'C');
      if (typeof status === 'function') return status(options);
      if (status === 'hang') return new Promise(() => { options.signal.addEventListener('abort', () => { aborted = true; }, { once: true }); });
      if (status instanceof Error) throw status;
      return status;
    }
    if (file === '/usr/bin/codesign') return signing.run(file, args, options);
    return scan(file, args, options);
  };
  port.identify = (fact, options) => trustedExecutableV1(fact, { ...options, files: signing.files });
  port.warn = line => warnings.push(line);
  return { port, warnings, sipReads: () => sipReads, aborted: () => aborted };
}

test('R5SD: SIP status enables the path exemption only for exact enabled output, once per check', async () => {
  const enabled = { stdout: 'System Integrity Protection status: enabled.\n', stderr: '' };
  for (const stdout of [enabled.stdout, enabled.stdout.trimEnd(), enabled.stdout.replace('\n', '\r\n')]) {
    const f = sipScanPort({ stdout, stderr: '' });
    assert.deepEqual(await checkOwnerBotsStoppedV1(f.port), []);
    assert.equal(f.sipReads(), 1, 'one status read even for multiple unique images');
    assert.deepEqual(f.warnings, []);
  }
  const failures = [
    ['disabled', { stdout: 'System Integrity Protection status: disabled.\n', stderr: '' }],
    ['custom', { stdout: 'System Integrity Protection status: unknown (Custom Configuration).\nConfiguration:\nFilesystem Protections: disabled\n', stderr: '' }],
    ['garbage', { stdout: 'unrecognised\n', stderr: '' }],
    ['missing data', { stdout: '', stderr: '' }],
    ['extra line', { ...enabled, stdout: enabled.stdout + 'custom configuration\n' }],
    ['leading space', { ...enabled, stdout: ' ' + enabled.stdout }],
    ['warning', { ...enabled, stderr: 'warning' }],
    ['non-zero exit with enabled stdout', Object.assign(new Error('exit 1'), { code: 1, ...enabled })],
    ['timeout', Object.assign(new Error('timed out'), { killed: true, code: 'ETIMEDOUT' })],
    ['missing binary', Object.assign(new Error('missing binary'), { code: 'ENOENT' })],
  ];
  for (const [name, status] of failures) {
    const f = sipScanPort(status);
    assert.deepEqual((await checkOwnerBotsStoppedV1(f.port)).map(row => row.pid), [701, 702, 703], name);
    assert.equal(f.sipReads(), 1, name);
    assert.deepEqual(f.warnings, [sipOwnerLine], name);
    const platform = sipScanPort(status, { platform: true });
    assert.deepEqual(await checkOwnerBotsStoppedV1(platform.port), [], 'Platform identifier fallback: ' + name);
    assert.deepEqual(platform.warnings, [sipOwnerLine]);
  }
});

test('R5SD: SIP status dropped reads abort within the bound; 50 callers fail closed and retry independently', { timeout: 12_000 }, async () => {
  const hanging = sipScanPort('hang');
  assert.deepEqual((await checkOwnerBotsStoppedV1(hanging.port)).map(row => row.pid), [701, 702, 703]);
  assert.equal(hanging.aborted(), true, 'stop the timed-out read');
  assert.equal(hanging.sipReads(), 1);
  assert.deepEqual(hanging.warnings, [sipOwnerLine]);
  const failed = await Promise.all(Array.from({ length: 50 }, async () => {
    const f = sipScanPort(Object.assign(new Error('dropped connection'), { code: 'EPIPE' }));
    assert.deepEqual((await checkOwnerBotsStoppedV1(f.port)).map(row => row.pid), [701, 702, 703]);
    assert.equal(f.sipReads(), 1);
    assert.deepEqual(f.warnings, [sipOwnerLine]);
    return f;
  }));
  assert.equal(failed.length, 50);
  const retry = sipScanPort({ stdout: 'System Integrity Protection status: enabled.\n', stderr: '' });
  assert.deepEqual(await checkOwnerBotsStoppedV1(retry.port), [], 'failure must not be cached across checks');
  assert.deepEqual(retry.warnings, []);
  const stopped = sipScanPort('hang');
  await assert.rejects(checkOwnerBotsStoppedV1({ ...stopped.port, timeoutMs: 20 }), /bot_check_command_refused/u);
  assert.equal(stopped.aborted(), true, 'whole-check stop aborts the status read');
  assert.deepEqual(stopped.warnings, [sipOwnerLine]);
});

test('R5SD: SIP native status on this Mac is enabled and consulted by the check', async t => {
  if (!existsSync('/usr/bin/csrutil')) { t.skip('csrutil unavailable: native SIP status cannot be read'); return; }
  let calls = 0;
  const port = scanPort([''], ['']);
  const scan = port.run, warnings = [];
  port.run = async (file, args, options) => {
    if (file !== '/usr/bin/csrutil') return scan(file, args, options);
    calls++;
    return runFile(file, args, options);
  };
  port.warn = line => warnings.push(line);
  assert.equal(await readSipEnabledV1(), true, 'this Mac must report fully enabled SIP');
  assert.deepEqual(await checkOwnerBotsStoppedV1(port), []);
  assert.equal(calls, 1, 'native status is consulted once by the default check');
  assert.deepEqual(warnings, []);
});

test('R5SD: membership unions both sources and includes late lsof-only births on both scans', async () => {
  const port = scanPort(['', psRow(501, 701, 1, '/fixture/old')], [kernelRow(701), kernelRow(702)]);
  assert.deepEqual((await checkOwnerBotsStoppedV1(port)).map(row => row.pid), [701, 702]);
  assert.equal(port.calls.filter(([path]) => path === '/bin/ps').length, 3);
  assert.ok(port.calls.filter(([path]) => path === '/usr/sbin/lsof').every(([, args]) => args.includes('-u') && args.includes('-R')));
  const foreign = scanPort(['', ''], [kernelRow(701, '/fixture/plain', 502)]);
  assert.deepEqual(await checkOwnerBotsStoppedV1(foreign), []);
  const reusedForeign = scanPort([psRow(501, 701, 1, '/fixture/plain')], [kernelRow(701, '/fixture/plain', 502)]);
  assert.deepEqual(await checkOwnerBotsStoppedV1(reusedForeign), [], 'fresh foreign uid overrides an earlier owner row');
  const psForeign = scanPort([psRow(501, 701, 1, '/fixture/plain'), psRow(502, 701, 1, '/fixture/plain')], ['']);
  assert.deepEqual(await checkOwnerBotsStoppedV1(psForeign), [], 'latest ps foreign uid overrides an earlier owner row');
  const departed = scanPort([psRow(501, 701, 1, '/fixture/old')], ['']); departed.alive = () => false;
  assert.deepEqual(await checkOwnerBotsStoppedV1(departed), []);
  const unreadable = scanPort([psRow(501, 701, 1, '/fixture/old')], ['']);
  assert.deepEqual(families(await checkOwnerBotsStoppedV1(unreadable)), [unknown]);
  const reuse = scanPort([psRow(501, 701, 1, '/fixture/old')], [kernelRow(701), '', '']);
  reuse.identify = async () => 'system';
  assert.deepEqual(families(await checkOwnerBotsStoppedV1(reuse)), [unknown], 'stale kernel facts never exempt a reused PID');
  const inode = String((await import('node:fs')).statSync('/bin/sleep', { bigint: true }).ino);
  const stale = scanPort([psRow(501, 701, 1, '/fixture/old'), '', ''], [kernelRow(701, '/bin/sleep').replace('i77', `i${inode}`), '', '', '']);
  stale.identify = async () => 'system';
  assert.deepEqual(families(await checkOwnerBotsStoppedV1(stale)), [unknown], 'unreadable membership cannot keep old signed-binary facts');
});

test('R5SD: final membership catches births during signing and invalidates changed executable evidence', async () => {
  const inode = String((await import('node:fs')).statSync('/bin/sleep', { bigint: true }).ino);
  const signed = kernelRow(701, '/bin/sleep').replace('i77', `i${inode}`);
  const port = scanPort([''], [signed, signed, signed + kernelRow(702)]);
  let identities = 0;
  port.identify = async () => { identities++; return 'system'; };
  assert.deepEqual((await checkOwnerBotsStoppedV1(port)).map(row => row.pid), [702]);
  assert.equal(identities, 1, 'no extra signature command creates another unchecked window');
  const changed = scanPort([''], [signed, signed, kernelRow(701)]);
  changed.identify = async () => 'system';
  assert.deepEqual(families(await checkOwnerBotsStoppedV1(changed)), [unknown], 'a new executable image cannot inherit cached trust');
  const f = await stoppedProcessFixtures();
  try {
    const localInode = String((await import('node:fs')).statSync(f.clobber, { bigint: true }).ino);
    const row = kernelRow(701, f.clobber).replace('i77', `i${localInode}`);
    const modified = scanPort([''], [row]); modified.identify = async () => 'system';
    const original = modified.run; let reads = 0;
    modified.run = async (path, args) => {
      if (path === '/usr/sbin/lsof' && ++reads === 3) await (await import('node:fs/promises')).appendFile(f.clobber, '\n');
      return original(path, args);
    };
    assert.deepEqual(families(await checkOwnerBotsStoppedV1(modified)), [unknown], 'an in-place changed inode loses trust too');
    const during = scanPort([''], [row]);
    during.identify = async () => {
      await (await import('node:fs/promises')).appendFile(f.clobber, '\n');
      return 'system';
    };
    assert.deepEqual(families(await checkOwnerBotsStoppedV1(during)), [unknown], 'a changed file cannot acquire its cache stamp after signing');
  } finally { await f.stop(); }
});

test('R5SD: slow, dropped and warning-bearing reads refuse, then retry succeeds under 50 callers', async () => {
  for (const run of [async () => { throw new Error('dropped'); }, async () => ({ stdout: psRow(501, 701, 1, '/fixture/old'), stderr: 'warning' }), async () => new Promise(() => {})]) {
    await assert.rejects(checkOwnerBotsStoppedV1({ run, timeoutMs: 20 }), /bot_check_command_refused/u);
  }
  for (const warningTool of ['/bin/ps', '/usr/sbin/lsof']) {
    const warning = scanPort([psRow(501, 701, 1, '/fixture/old')], [kernelRow(701)]);
    const read = warning.run;
    warning.run = async (path, args) => ({ ...await read(path, args), stderr: path === warningTool ? 'warning' : '' });
    await assert.rejects(checkOwnerBotsStoppedV1(warning), /bot_check_command_refused/u, 'usable stdout must not hide a tool warning');
  }
  const results = await Promise.all(Array.from({ length: 50 }, () => checkOwnerBotsStoppedV1(scanPort([psRow(501, 701, 1, '/fixture/old')], [kernelRow(701)]))));
  for (const result of results) assert.deepEqual(families(result), [unknown]);
  const droppedKernel = scanPort([''], ['']);
  droppedKernel.run = async path => { if (path === '/bin/ps') return { stdout: '', stderr: '' }; throw new Error('kernel refused'); };
  await assert.rejects(checkOwnerBotsStoppedV1(droppedKernel), /bot_check_command_refused/u);
});

test('R5SD: real stand-ins cover erased argv, renamed and re-signed runtimes, wrappers, generic Python and 50 scans', { timeout: 60_000 }, async () => {
  const f = await stoppedProcessFixtures();
  try {
    await f.populate();
    const pids = f.started.map(({ child }) => child.pid);
    const result = await runFile('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-R', '-d', 'txt,cwd', '-FpuRftin'], { maxBuffer: 1 << 24 });
    const facts = parseKernelFactsV1(result.stdout);
    assert.equal(facts.size, pids.length, 'real kernel executable evidence for every stand-in');
    const rows = f.started.map(({ child, program, args }) => psRow(process.getuid(), child.pid, process.pid, program, args.join(' '))).join('\n');
    for (let round = 0; round < 50; round++) {
      const found = parseOwnerBotProcessesV1(rows, process.getuid(), { facts });
      assert.deepEqual(found.map(row => row.pid), [...pids].sort((a, b) => a - b));
    }
    // Titles are deliberately all that ps can say here. The native and Node images
    // still must be listed, including titles repeating their own generic basename.
    for (const { label, child } of f.started.filter(row => row.label.includes('title'))) {
      for (const title of ['erased-worker idle', 'runtime-resigned idle', '/fixture/plain', 'My Agent Worker']) {
        assert.equal(parseOwnerBotProcessesV1(psRow(process.getuid(), child.pid, process.pid, title), process.getuid(), { facts }).length, 1, label);
      }
    }
    const port = scanPort(['', rows], [result.stdout]); port.ownerUid = process.getuid();
    const scans = await Promise.all(Array.from({ length: 50 }, () => checkOwnerBotsStoppedV1(port)));
    for (const found of scans) assert.deepEqual(found.map(row => row.pid), [...pids].sort((a, b) => a - b));
    assert.equal(await f.marker(), 'folders stay intact\n');
    assert.ok(f.started.length >= 35);
  } finally { await f.stop(); }
});

test('R5SD: a real child born after ps is listed when lsof first sees it', { timeout: 20_000 }, async () => {
  const f = await stoppedProcessFixtures();
  try {
    let child;
    const run = async (path, args) => {
      if (path === '/bin/ps') return { stdout: '', stderr: '' };
      child ??= await f.start('born during scan', f.clobber, ['erased-worker idle']);
      return runFile('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-R', '-d', 'txt,cwd', '-FpuRftin']);
    };
    const found = await checkOwnerBotsStoppedV1({ run, selfPid: 999999, identify: async () => undefined });
    assert.deepEqual(found.map(row => row.pid), [child.pid]);
  } finally { await f.stop(); }
});

test('R5SD: direct child stand-ins exit and are reaped when the parent pipe closes', async () => {
  const f = await stoppedProcessFixtures();
  try {
    const child = await f.start('pipe-bound native', f.clobber, ['erased-worker idle']);
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.end();
    await closed; assert.equal(child.exitCode, 0);
  } finally { await f.stop(); }
});

test('R5SD: real system signature controls work and the default scan refuses when ps is sandbox-blocked', async t => {
  const stat = (await import('node:fs')).statSync('/bin/sleep', { bigint: true });
  assert.equal(await trustedExecutableV1({ executable: '/bin/sleep', inode: String(stat.ino) }), 'system');
  for (const path of ['/usr/bin/sleep', '/usr/sbin/distnoted', '/usr/libexec/useractivityd']) {
    if (!existsSync(path)) continue;
    const inode = String((await import('node:fs')).statSync(path, { bigint: true }).ino);
    assert.equal(await trustedExecutableV1({ executable: path, inode }), 'system', path);
  }
  for (const path of ['/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron']) {
    if (!existsSync(path)) { t.diagnostic(`SIGNATURE CONTROL absent: ${basename(path)}`); continue; }
    const inode = String((await import('node:fs')).statSync(path, { bigint: true }).ino);
    assert.ok(['app', 'terminal'].includes(await trustedExecutableV1({ executable: path, inode })), basename(path));
    t.diagnostic(`SIGNATURE CONTROL verified: ${basename(path)}`);
  }
  const pg = '/opt/homebrew/opt/postgresql@17/bin/postgres';
  if (existsSync(pg)) {
    const inode = String((await import('node:fs')).statSync(pg, { bigint: true }).ino);
    const postgres = { executable: pg, sha256: digest(await readFile(pg)) };
    assert.equal(await trustedExecutableV1({ executable: pg, inode }, { postgres }), 'postgres', 'binary metadata only; no database is launched');
    t.diagnostic('SIGNATURE CONTROL verified: configured PostgreSQL binary (not executed).');
  }
  try {
    const matches = await checkOwnerBotsStoppedV1();
    for (const row of matches) assert.ok(['claude', 'codex', 'hermes', 'opencode', unknown].includes(row.family));
    for (const path of appleBackgroundPrograms) assert.ok(!matches.some(row => row.executable === path), 'Apple background image must not be listed by the real default scan');
  } catch (error) {
    let blocked;
    try { await runFile('/bin/ps', ['-axo', 'uid=']); } catch (failure) { blocked = failure; }
    assert.ok(blocked, 'inspection failure must be attributable to actual sandbox ps refusal');
    assert.equal(error.code, 'bot_check_command_refused');
    t.diagnostic('LIVE DEFAULT PATH: refused; ps is sandbox-blocked. No ambient PASS claimed.');
  }
});

test('R5SD: CLI keeps the STOP heading, names unknown programs and preserves folders without printing argv', async () => {
  const f = await stoppedProcessFixtures(), commands = await fixture();
  try {
    const child = await f.start('CLI unknown program', f.clobber, ['erased-worker idle']);
    const kernel = await runFile('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-R', '-d', 'txt,cwd', '-FpuRftin']);
    const ps = join(commands.bin, 'ps-check'), lsof = join(commands.bin, 'lsof-check');
    const rows = join(commands.state, 'ps-check'), facts = join(commands.state, 'kernel-check');
    await writeFile(rows, psRow(process.getuid(), child.pid, process.pid, 'erased-worker idle', 'fixture-private-argument'));
    await writeFile(facts, kernel.stdout);
    await executable(ps, `/bin/cat '${rows}'`); await executable(lsof, `/bin/cat '${facts}'`);
    const env = { ...process.env, CONTROL_ROOM_REHEARSAL_TESTING: '1', CONTROL_ROOM_REHEARSAL_PS_PATH: ps, CONTROL_ROOM_REHEARSAL_LSOF_PATH: lsof };
    await assert.rejects(runFile(process.execPath, [botCheckCli], { encoding: 'utf8', env }), error => {
      assert.equal(error.code, 2); assert.match(error.stdout, /^STOP: bot worker processes are still running under the owner's uid:/u);
      assert.match(error.stdout, new RegExp(`PID ${child.pid} PPID ${process.pid} FAMILY unidentified`, 'u'));
      assert.match(error.stdout, /may be a bot — quit it first/u); assert.match(error.stdout, /folders are left alone/u);
      assert.match(error.stdout, /  program: \/.+\n  folder: \/.+\n  why:/u);
      assert.doesNotMatch(error.stdout, /fixture-private-argument|erased-worker idle/u); return true;
    });
    await writeFile(rows, ''); await writeFile(facts, '');
    assert.match((await runFile(process.execPath, [botCheckCli], { env, encoding: 'utf8' })).stdout, /^PASS:/u);
    for (const args of [['unexpected'], ['--postgres-executable', '/fixture/postgres'], ['--postgres-executable', '/fixture/postgres', '--postgres-sha256', 'bad']]) {
      await assert.rejects(runFile(process.execPath, [botCheckCli, ...args], { env }), /arguments_refused|bot_check_postgres_config_refused/u);
    }
    // The password path cannot use the command fixtures to turn a real unreadable
    // process table into an empty one. On an unrestricted host it reads real tools.
    const handoff = await runFile(process.execPath, [botCheckCli, '--password-handoff'], { env, encoding: 'utf8' }).catch(error => error);
    assert.doesNotMatch(handoff.stdout ?? '', /^PASS:/u);
    assert.ok(handoff.code === 1 || handoff.code === 2);
  } finally { await f.stop(); }
});
