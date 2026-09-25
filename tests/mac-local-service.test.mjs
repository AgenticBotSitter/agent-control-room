import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installOrRefreshService, plistPath, SERVICE_LABEL, serviceInstalled, servicePid, servicePlist,
  serviceUpToDate, stopService, uninstallService } from "../scripts/mac-local/service.mjs";
import { hostCommand } from "../scripts/mac-local/stack.mjs";

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
