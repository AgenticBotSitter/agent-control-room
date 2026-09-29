import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installOrRefreshService, plistPath, SERVICE_LABEL, serviceInstalled, servicePid, servicePlist,
  serviceStatus, serviceUpToDate, stopService, uninstallService } from "../scripts/mac-local/service.mjs";
import { hostCommand } from "../scripts/mac-local/stack.mjs";
import { cleanupTestPostgres, DISPOSABLE_POSTGRES_MARKER, parsePostgresProcesses,
  parseSharedMemory } from "../scripts/dev/cleanup-test-postgres.mjs";

const root = "/protected/root", logPath = "/protected/root/runtime/task-host.log";
const target = `gui/501/${SERVICE_LABEL}`;

/** A fake launchctl that records calls and models loaded/enabled state. It never runs the real tool. */
async function fixture(t, { loaded = false, pid = 4242 } = {}) {
  const home = await mkdtemp(join(tmpdir(), "acr-service-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [], state = { loaded, pid, enabled: true };
  const runtime = { uid: () => 501, home: () => home, launchctl: async args => {
    calls.push(args.join(" "));
    const [verb] = args;
    if (verb === "print") return state.loaded ? { code: 0, stdout: `${target} = {\n\tstate = running\n\tpid = ${state.pid}\n}\n` } : { code: 113, stdout: "" };
    if (verb === "print-disabled") return { code: 0,
      stdout: `disabled services = {\n\t"${SERVICE_LABEL}" => ${state.enabled ? "false" : "true"}\n}\n` };
    if (verb === "bootout") { if (!state.loaded) return { code: 3, stdout: "" }; state.loaded = false; return { code: 0, stdout: "" }; }
    if (verb === "bootstrap") { if (state.loaded || !state.enabled) return { code: 5, stdout: "" }; state.loaded = true; return { code: 0, stdout: "" }; }
    if (verb === "enable") { state.enabled = true; return { code: 0, stdout: "" }; }
    if (verb === "disable") { state.enabled = false; return { code: 0, stdout: "" }; }
    if (verb === "kickstart") return { code: state.loaded ? 0 : 113, stdout: "" };
    return { code: 64, stdout: "" };
  } };
  return { home, calls, state, runtime };
}

test("plist runs exactly the host command, restarts only after a crash, and carries only PATH and LANG", () => {
  const plist = servicePlist({ protectedRoot: root, logPath,
    env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", SECRET_TOKEN: "do-not-copy", HOME: "/Users/x" } });
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/gu)].map(match => match[1]);
  const start = args.indexOf(hostCommand(root)[0]);
  assert.deepEqual(args.slice(start, start + hostCommand(root).length), hostCommand(root));
  assert.match(plist, /<key>KeepAlive<\/key>\n<dict><key>SuccessfulExit<\/key><false\/><\/dict>/u);
  assert.match(plist, /<key>RunAtLoad<\/key>\n<true\/>/u);
  assert.match(plist, /<key>ExitTimeOut<\/key>\n<integer>45<\/integer>/u);
  assert.match(plist, /<key>PATH<\/key>/u);
  assert.match(plist, /<key>LANG<\/key>/u);
  assert.doesNotMatch(plist, /SECRET_TOKEN|do-not-copy|<key>HOME<\/key>/u);
});

test("plist escapes XML and refuses relative or control-character paths", () => {
  assert.match(servicePlist({ protectedRoot: "/a&b/<root>", logPath, env: {} }), /\/a&amp;b\/&lt;root&gt;/u);
  assert.throws(() => servicePlist({ protectedRoot: "relative/root", logPath, env: {} }), /path_invalid/u);
  assert.throws(() => servicePlist({ protectedRoot: root, logPath: "/log\nx", env: {} }), /path_invalid/u);
});

test("first install writes a private plist, enables and bootstraps the agent", async t => {
  const f = await fixture(t);
  assert.equal(await serviceInstalled(f.runtime), false);
  assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), "installed");
  assert.deepEqual(f.calls, ["print " + target, "enable " + target, `bootstrap gui/501 ${plistPath(f.home)}`]);
  assert.equal((await stat(plistPath(f.home))).mode & 0o777, 0o600);
  assert.equal(await serviceInstalled(f.runtime), true);
  assert.equal(await serviceUpToDate({ protectedRoot: root, logPath, env: {} }, f.runtime), true);
  assert.deepEqual(await servicePid(f.runtime), { loaded: true, pid: 4242 });
});

test("a changed plist is booted out, rewritten and bootstrapped; an unchanged one is restarted in place", async t => {
  const f = await fixture(t);
  await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime);
  f.calls.length = 0;
  assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: { PATH: "/usr/bin" } }, f.runtime), "refreshed");
  assert.deepEqual(f.calls, ["print " + target, "bootout " + target, "enable " + target, `bootstrap gui/501 ${plistPath(f.home)}`]);
  assert.match(await readFile(plistPath(f.home), "utf8"), /<key>PATH<\/key>/u);
  f.calls.length = 0;
  assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: { PATH: "/usr/bin" } }, f.runtime), "restarted");
  assert.deepEqual(f.calls, ["print " + target, "kickstart -k " + target]);
});

test("mac:down stops and disables the agent but keeps its plist; the next mac:up re-enables it", async t => {
  const f = await fixture(t);
  await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime);
  assert.equal(await stopService(f.runtime), "stopped");
  assert.equal(f.state.loaded, false);
  assert.equal(f.state.enabled, false);
  assert.equal(await serviceInstalled(f.runtime), true);
  assert.equal(await stopService(f.runtime), "not_running");
  assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), "reloaded");
  assert.equal(f.state.loaded && f.state.enabled, true);
});

test("uninstall stops the agent, removes the plist and clears the disable override", async t => {
  const f = await fixture(t);
  await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime);
  assert.equal(await uninstallService(f.runtime), "stopped_and_removed");
  assert.equal(await serviceInstalled(f.runtime), false);
  assert.equal(f.state.enabled, true);
  assert.equal(await uninstallService(f.runtime), "removed");
});

test("status is read-only, exact, and stable before install, while running, and after stop", async t => {
  const f = await fixture(t);
  assert.deepEqual(await serviceStatus({ protectedRoot: root, logPath, env: {} }, f.runtime), {
    installed: false, loaded: false, pid: undefined, enabled: true, definition: "absent", state: "not_installed",
  });
  assert.equal(await stat(join(f.home, "Library")).then(() => true, () => false), false,
    "status must not create the LaunchAgents parent");
  await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime);
  assert.deepEqual(await serviceStatus({ protectedRoot: root, logPath, env: {} }, f.runtime), {
    installed: true, loaded: true, pid: 4242, enabled: true, definition: "current", state: "running",
  });
  await stopService(f.runtime);
  assert.deepEqual(await serviceStatus({ protectedRoot: root, logPath, env: {} }, f.runtime), {
    installed: true, loaded: false, pid: undefined, enabled: false, definition: "current", state: "stopped",
  });
});

test("a failed bootstrap is repeat-safe and uninstall remains idempotent", async t => {
  const f = await fixture(t);
  let failed = false;
  const runtime = { ...f.runtime, launchctl: async args => {
    if (args[0] === "bootstrap" && !failed) { failed = true; return { code: 5, stdout: "" }; }
    return f.runtime.launchctl(args);
  } };
  await assert.rejects(installOrRefreshService({ protectedRoot: root, logPath, env: {} }, runtime), /launchctl_failed: bootstrap/u);
  assert.equal(await serviceInstalled(f.runtime), true, "the complete plist is retained for a safe retry");
  assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), "reloaded");
  assert.equal(await uninstallService(f.runtime), "stopped_and_removed");
  assert.equal(await uninstallService(f.runtime), "removed");
});

test("a symlinked plist or LaunchAgents directory is refused and never followed", async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
  const elsewhere = join(f.home, "elsewhere.plist");
  await writeFile(elsewhere, "original");
  await symlink(elsewhere, plistPath(f.home));
  await assert.rejects(installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), /plist_invalid/u);
  assert.equal(await readFile(elsewhere, "utf8"), "original");

  const g = await fixture(t);
  await mkdir(join(g.home, "Library"), { recursive: true });
  await mkdir(join(g.home, "real-agents"));
  await symlink(join(g.home, "real-agents"), join(g.home, "Library/LaunchAgents"));
  await assert.rejects(installOrRefreshService({ protectedRoot: root, logPath, env: {} }, g.runtime), /directory_invalid/u);
  assert.deepEqual(g.calls, []);
});

test("a launchctl failure is reported, not swallowed", async t => {
  const f = await fixture(t);
  f.state.enabled = false;
  const runtime = { ...f.runtime, launchctl: async args => args[0] === "enable" ? { code: 1, stdout: "" } : f.runtime.launchctl(args) };
  await assert.rejects(installOrRefreshService({ protectedRoot: root, logPath, env: {} }, runtime), /launchctl_failed: enable/u);
});

test("cleanup parses only postmasters with explicit absolute data directories", () => {
  assert.deepEqual(parsePostgresProcesses(` 101 /opt/homebrew/bin/postgres -D /tmp/one\n 102 postgres: checkpointer\n 103 node postgres -D /tmp/no\n`),
    [{ pid: 101, dataDirectory: "/tmp/one" }]);
});

test("cleanup parses SysV ids, attachment counts and creator pids by header", () => {
  const text = `T ID KEY MODE OWNER GROUP NATTCH CPID LPID\nm 42 0x1 --rw------- owner staff 0 101 101\nm 43 0x2 --rw------- owner staff 1 102 102\n`;
  assert.deepEqual(parseSharedMemory(text), [
    { id: "42", attachments: 0, creatorPid: 101 }, { id: "43", attachments: 1, creatorPid: 102 },
  ]);
});

test("cleanup dry-run and execution touch only disposable clusters and their unattached segments", async t => {
  const cleanupRoot = await mkdtemp(join(tmpdir(), "acr-cleanup-pg-"));
  t.after(() => rm(cleanupRoot, { recursive: true, force: true }));
  const marked = join(cleanupRoot, "elsewhere-pg"), ordinary = join(cleanupRoot, "ordinary-pg");
  await Promise.all([mkdir(marked), mkdir(ordinary)]);
  await writeFile(join(marked, DISPOSABLE_POSTGRES_MARKER), JSON.stringify({
    schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal",
  }), { mode: 0o600 });
  const calls = [];
  const runtime = {
    tmpdir: () => join(cleanupRoot, "temp"), realpath: async value => value,
    lstat: async path => ({ isFile: () => path === join(marked, DISPOSABLE_POSTGRES_MARKER), isSymbolicLink: () => false,
      mode: 0o100600, uid: process.getuid?.() }), readFile: async () => JSON.stringify({
      schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal" }),
    ps: async () => ` 101 postgres -D ${join(cleanupRoot, "temp/pg")}\n 102 postgres -D ${marked}\n 103 postgres -D ${ordinary}\n`,
    pgCtl: async path => { calls.push(`stop:${path}`); },
    ipcs: async () => `T ID KEY MODE OWNER GROUP NATTCH CPID LPID\nm 41 0 x x x 0 101 1\nm 42 0 x x x 1 102 1\nm 43 0 x x x 0 103 1\n`,
    ipcrm: async id => { calls.push(`remove:${id}`); },
  };
  const dry = await cleanupTestPostgres({ dryRun: true }, runtime);
  assert.deepEqual(dry.clusters.map(value => value.pid), [101, 102]); assert.deepEqual(calls, []);
  const cleaned = await cleanupTestPostgres({}, runtime);
  assert.deepEqual(cleaned.segments.map(value => value.id), ["41"]);
  assert.deepEqual(calls, [`stop:${join(cleanupRoot, "temp/pg")}`, `stop:${marked}`, "remove:41"]);
});
