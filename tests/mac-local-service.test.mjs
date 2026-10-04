import { spawn } from "node:child_process";
import { once } from "node:events";
import fsPromises from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, lstat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FLEET_GATEWAY_LAUNCHD_HANDOFF, installOrRefreshService, plistPath, SERVICE_LABEL, serviceInstalled, servicePid, servicePlist,
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
  assert.doesNotMatch(plist, /start-fleet-gateway/u, "cook/daemons owns the separate production service definition");
  assert.match(FLEET_GATEWAY_LAUNCHD_HANDOFF, /cook\/daemons item 5/u);
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


test("R5S-02: leftover temporary symlink cannot overwrite notes or become the published plist", async t => {
  const f = await fixture(t), path = plistPath(f.home), notes = join(f.home, "owner-notes");
  await mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
  await writeFile(notes, "keep these notes", { mode: 0o600 });
  const planted = `${path}.new-${process.pid}`;
  await symlink(notes, planted);
  await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime);
  assert.equal(await readFile(notes, "utf8"), "keep these notes");
  assert.equal((await lstat(planted)).isSymbolicLink(), true, "unowned entries are left alone");
  const entry = await lstat(path);
  assert.equal(entry.isFile(), true); assert.equal(entry.isSymbolicLink(), false);
  assert.equal(entry.mode & 0o777, 0o600); assert.equal(entry.nlink, 1);
  assert.equal(await serviceUpToDate({ protectedRoot: root, logPath, env: {} }, f.runtime), true);
});


test("R5S-02: exclusive temporary collisions refuse without touching the symlink target", async t => {
  const f = await fixture(t), notes = join(f.home, "owner-notes");
  await writeFile(notes, "keep these notes", { mode: 0o600 });
  const original = fsPromises.open; let planted;
  fsPromises.open = async (path, flags, mode) => {
    if (String(path).includes(".plist.new-")) {
      // These independent fences must remain even if a future caller changes its creation flags.
      assert.ok(flags & constants.O_EXCL); assert.ok(flags & constants.O_NOFOLLOW);
      planted = path; await symlink(notes, path);
    }
    return original(path, flags, mode);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), { code: "EEXIST" });
    assert.equal(await readFile(notes, "utf8"), "keep these notes");
    assert.equal((await lstat(planted)).isSymbolicLink(), true, "failed creation did not acquire this entry");
    assert.equal(await serviceInstalled(f.runtime), false);
  } finally { fsPromises.open = original; syncBuiltinESMExports(); }
  await rm(planted);
  assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), "installed");
});

test("R5S-02: descriptor refusals and partial write failures remove only owned temporaries", async t => {
  for (const fault of ["file", "links", "owner", "mode", "write", "sync", "chmod"]) {
    await t.test(fault, async t => {
      const f = await fixture(t), path = plistPath(f.home);
      await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime);
      const before = await readFile(path, "utf8"), original = fsPromises.open;
      let closed = false;
      fsPromises.open = async (...args) => {
        const handle = await original(...args);
        if (String(args[0]).includes(".plist.new-")) {
          const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
          handle.close = async () => { await close(); closed = true; };
          handle.stat = async () => {
            const entry = await stat();
            if (fault === "file") entry.isFile = () => false;
            if (fault === "links") entry.nlink = 2;
            if (fault === "owner") entry.uid += 1;
            if (fault === "mode") entry.mode |= 0o020;
            return entry;
          };
          if (["write", "sync", "chmod"].includes(fault)) {
            const method = { write: "writeFile", sync: "sync", chmod: "chmod" }[fault], write = handle.writeFile.bind(handle);
            handle[method] = async () => { if (fault === "write") await write("partial");
              throw Object.assign(new Error("injected_io_failure"), { code: "ENOSPC" }); };
          }
        }
        return handle;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(installOrRefreshService({ protectedRoot: root, logPath, env: { LANG: "C" } }, f.runtime),
          /mac_local_service_temporary_invalid|injected_io_failure/u);
        assert.equal(closed, true); assert.equal(await readFile(path, "utf8"), before);
        assert.deepEqual((await readdir(join(f.home, "Library/LaunchAgents"))).filter(name => name.includes(".new-")), []);
      } finally { fsPromises.open = original; syncBuiltinESMExports(); }
      assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: { LANG: "C" } }, f.runtime), "refreshed");
    });
  }
});


test("R5S-04: fifty competing installs are admitted once or cleanly refused before mutation", async t => {
  const f = await fixture(t), input = { protectedRoot: root, logPath, env: {} };
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const runtime = { ...f.runtime, launchctl: async args => {
    if (args[0] === "print") { entered(); await gate; }
    return f.runtime.launchctl(args);
  } };
  const first = installOrRefreshService(input, runtime);
  await started;
  try {
    const results = await Promise.allSettled(Array.from({ length: 49 }, () => installOrRefreshService(input, f.runtime)));
    assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "mac_local_service_busy"));
    assert.deepEqual(f.calls, [], "contenders do not query or mutate launchd");
    assert.equal(await serviceInstalled(f.runtime), false);
  } finally { release(); await first; }
  assert.equal(await serviceUpToDate(input, f.runtime), true);
  assert.equal(f.state.loaded, true);
  await stopService(f.runtime); await installOrRefreshService(input, f.runtime); await stopService(f.runtime);
});

test("R5S-04: overlapping stop and uninstall refuse, then retry after failed install releases the lock", async t => {
  const f = await fixture(t), input = { protectedRoot: root, logPath, env: {} };
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const runtime = { ...f.runtime, launchctl: async args => {
    if (args[0] === "bootstrap") { entered(); await gate; throw new Error("dropped_service_connection"); }
    return f.runtime.launchctl(args);
  } };
  const first = installOrRefreshService(input, runtime), failed = assert.rejects(first, /dropped_service_connection/u);
  await started;
  try {
    await assert.rejects(stopService(f.runtime), { code: "mac_local_service_busy" });
    await assert.rejects(uninstallService(f.runtime), { code: "mac_local_service_busy" });
    assert.equal(await serviceInstalled(f.runtime), true);
  } finally { release(); await failed; }
  assert.equal(await stopService(f.runtime), "not_running");
  assert.equal(await installOrRefreshService(input, f.runtime), "reloaded");
  assert.equal(await uninstallService(f.runtime), "stopped_and_removed");
});


test("R5S-04: a separate holder process excludes stop and SIGKILL releases lifecycle authority", async t => {
  const f = await fixture(t), moduleUrl = new URL("../scripts/mac-local/service.mjs", import.meta.url).href;
  const program = `import { installOrRefreshService } from ${JSON.stringify(moduleUrl)};
const runtime={uid:()=>501,home:()=>process.argv[1],launchctl:async()=>{
  process.stdout.write("HOLDING\\n");await new Promise(()=>{});
}};
await installOrRefreshService({protectedRoot:"/protected/root",logPath:"/protected/root/log",env:{}},runtime);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, f.home],
    { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
  const closed = once(child, "close"); let timer;
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  try {
    await Promise.race([once(child.stdout, "data").then(([chunk]) => assert.match(String(chunk), /HOLDING/u)),
      closed.then(() => { throw new Error("holder_exited_before_lock"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("holder_start_timeout")), 5000); })]);
    await assert.rejects(stopService(f.runtime), { code: "mac_local_service_busy" });
    assert.deepEqual(f.calls, []);
    kill(); await closed;
    assert.equal(await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), "installed");
    assert.equal(await stopService(f.runtime), "stopped");
  } finally { clearTimeout(timer); kill(); await closed; }
});


test("R5S-02: rename failure preserves the current plist and removes its owned temporary", async t => {
  const f = await fixture(t), input = { protectedRoot: root, logPath, env: {} };
  await installOrRefreshService(input, f.runtime);
  const before = await readFile(plistPath(f.home), "utf8"), original = fsPromises.rename;
  fsPromises.rename = async () => { throw Object.assign(new Error("rename_failed"), { code: "EIO" }); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(installOrRefreshService({ ...input, env: { LANG: "C" } }, f.runtime), { code: "EIO" });
    assert.equal(await readFile(plistPath(f.home), "utf8"), before);
    assert.deepEqual((await readdir(join(f.home, "Library/LaunchAgents"))).filter(name => name.includes(".new-")), []);
  } finally { fsPromises.rename = original; syncBuiltinESMExports(); }
  await installOrRefreshService({ ...input, env: { LANG: "C" } }, f.runtime);
});

test("R5S-02: publication cleanup leaves a replacement at the old temporary name untouched", async t => {
  const f = await fixture(t), original = fsPromises.rename; let replacement;
  fsPromises.rename = async (from, to) => {
    await original(from, to); replacement = from;
    await writeFile(from, "unowned replacement", { mode: 0o600 });
  };
  syncBuiltinESMExports();
  try {
    await installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime);
    assert.equal(await readFile(replacement, "utf8"), "unowned replacement");
    assert.equal(await serviceInstalled(f.runtime), true);
  } finally { fsPromises.rename = original; syncBuiltinESMExports(); }
});


test("R5S-02: failed write cleanup preserves a substituted temporary inode", async t => {
  const f = await fixture(t);
  const original = fsPromises.open; let replacement;
  fsPromises.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes(".plist.new-")) handle.writeFile = async () => {
      replacement = args[0]; await fsPromises.rename(replacement, `${replacement}.owned`);
      await writeFile(replacement, "unowned replacement", { mode: 0o600 });
      throw Object.assign(new Error("partial_disk_full"), { code: "ENOSPC" });
    };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(installOrRefreshService({ protectedRoot: root, logPath, env: {} }, f.runtime), { code: "ENOSPC" });
    assert.equal(await readFile(replacement, "utf8"), "unowned replacement");
  } finally { fsPromises.open = original; syncBuiltinESMExports(); }
});
