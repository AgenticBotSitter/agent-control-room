import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REHEARSAL_POSTGRES_MARKER,
  createRehearsalOwnership,
} from "../scripts/mac-local/rehearsal/lifecycle.mjs";
import { cleanupRehearsalRoot, cleanupRegisteredRehearsals } from "../scripts/mac-local/rehearsal/cleanup.mjs";
import { hostCommand, runtimePaths } from "../scripts/mac-local/stack.mjs";

async function fixture(t, processes = []) {
  const base = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "acr-rehearsal-cleanup-"));
  await fs.chmod(base, 0o700);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "run"), registryDirectory = join(base, "registry");
  await fs.mkdir(root, { mode: 0o700 });
  const ownership = await createRehearsalOwnership({ root, databasePort: 15499, webPort: 3217,
    repositoryRoot: await fs.realpath(process.cwd()), registryDirectory, processes });
  await fs.mkdir(join(root, "pg"), { mode: 0o700 });
  await fs.writeFile(join(root, "pg", REHEARSAL_POSTGRES_MARKER), `${JSON.stringify({
    schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal", runId: ownership.runId,
  })}\n`, { mode: 0o600 });
  await fs.mkdir(join(root, "protected", "config"), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(root, "protected", "config", "mac-local.json"), `${JSON.stringify({
    port: 3217, database: { host: "127.0.0.1", port: 15499, database: "control_room", majorVersion: 17 },
  })}\n`, { mode: 0o600 });
  return { base, root, registryDirectory, ownership };
}

function fakeRuntime(commands, actions, { sticky = new Set(), currentPid = -1 } = {}) {
  let pgRunning = true;
  return {
    ...fs,
    currentPid: () => currentPid,
    processCommand: async pid => commands.get(pid),
    processIdsByCommand: async command => [...commands.entries()]
      .filter(([, current]) => current === command.join(" ")).map(([pid]) => pid),
    signal: (pid, signal) => {
      actions.push(["signal", pid, signal]);
      const actual = Math.abs(pid);
      if (!sticky.has(actual)) commands.delete(actual);
      return true;
    },
    wait: async () => {},
    pgCtl: async (directory, args) => {
      actions.push(["pg_ctl", directory, ...args]);
      assert.equal(directory.endsWith("/pg"), true);
      assert.equal(args.some(value => value === "5432" || value === "15499"), false,
        "cleanup must never select a cluster by port");
      if (args[0] === "stop") { pgRunning = false; return; }
      if (!pgRunning) throw Object.assign(new Error("not running"), { code: 3 });
    },
  };
}

test("cleanup stops only exact recorded process identities before the exact owned -D cluster", async t => {
  const processes = [
    { kind: "child", pid: 201, command: ["/usr/bin/node", "child"], group: true },
    { kind: "journey", pid: 202, command: ["/usr/bin/node", "journey", "/tmp/run"], group: true },
    { kind: "host", pid: 203, command: ["/usr/bin/node", "host", "--protected-root", "/tmp/run/protected"], group: true },
  ];
  const fixtureValue = await fixture(t, processes), actions = [];
  const commands = new Map(processes.map(process => [process.pid, process.command.join(" ")]));
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(commands, actions));
  assert.equal(result.cleaned, true);
  assert.deepEqual(actions.map(action => action[0] === "signal" ? [action[0], Math.abs(action[1])] : [action[0]]), [
    ["signal", 201], ["signal", 202], ["signal", 203], ["pg_ctl"], ["pg_ctl"],
  ]);
  await assert.rejects(fs.lstat(fixtureValue.root), error => error.code === "ENOENT");
  await assert.rejects(fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`)),
    error => error.code === "ENOENT");
});

test("cleanup never signals a recycled PID and skips its own exact record", async t => {
  const processes = [
    { kind: "setup", pid: 301, command: ["node", "setup"], group: true },
    { kind: "host", pid: 302, command: ["node", "expected-host"], group: true },
  ];
  const fixtureValue = await fixture(t, processes), actions = [];
  const commands = new Map([[301, "node setup"], [302, "node different-host"]]);
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(commands, actions, { currentPid: 301 }));
  assert.equal(result.cleaned, true);
  assert.deepEqual(result.outcomes.map(item => item.state), ["current", "not_running"]);
  assert.equal(actions.some(action => action[0] === "signal"), false);
});

test("cleanup discovers an exact detached host left by an interrupted mac:up", async t => {
  const fixtureValue = await fixture(t), actions = [], pid = 350;
  const command = hostCommand(fixtureValue.ownership.protectedRoot);
  const result = await cleanupRehearsalRoot(fixtureValue,
    fakeRuntime(new Map([[pid, command.join(" ")]]), actions));
  assert.equal(result.cleaned, true);
  assert.deepEqual(result.outcomes, [{ kind: "host", pid, state: "stopped" }]);
  assert.deepEqual(actions[0], ["signal", -pid, "SIGTERM"]);
});

test("cleanup retains the root when a detached-host PID file is malformed", async t => {
  const fixtureValue = await fixture(t), actions = [];
  await fs.mkdir(runtimePaths(fixtureValue.ownership.protectedRoot).runtime, { recursive: true, mode: 0o700 });
  await fs.writeFile(runtimePaths(fixtureValue.ownership.protectedRoot).hostPid, "not-a-pid\n", { mode: 0o600 });
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions));
  assert.equal(result.cleaned, false);
  assert.equal(result.reason, "rehearsal_host_identity_uncertain");
  assert.deepEqual(actions, []);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
});

test("cleanup retains all owned state when an exact process cannot be stopped", async t => {
  const processRecord = { kind: "host", pid: 401, command: ["node", "host"], group: true };
  const fixtureValue = await fixture(t, [processRecord]), actions = [];
  const commands = new Map([[401, processRecord.command.join(" ")]]);
  const result = await cleanupRehearsalRoot({ ...fixtureValue, graceMs: 0 },
    fakeRuntime(commands, actions, { sticky: new Set([401]) }));
  assert.equal(result.cleaned, false);
  assert.equal(result.reason, "process_cleanup_uncertain");
  assert.equal(actions.some(action => action[0] === "pg_ctl"), false);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
  assert.equal((await fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`))).isFile(), true);
});

test("cleanup refuses a mismatched or reserved protected configuration before any signal", async t => {
  const processRecord = { kind: "host", pid: 501, command: ["node", "host"], group: true };
  const fixtureValue = await fixture(t, [processRecord]), actions = [];
  await fs.writeFile(join(fixtureValue.root, "protected", "config", "mac-local.json"), `${JSON.stringify({
    port: 3210, database: { host: "127.0.0.1", port: 5432, database: "control_room" },
  })}\n`, { mode: 0o600 });
  const result = await cleanupRehearsalRoot(fixtureValue,
    fakeRuntime(new Map([[501, "node host"]]), actions));
  assert.equal(result.cleaned, false);
  assert.equal(result.reason, "rehearsal_protected_configuration_mismatch");
  assert.deepEqual(actions, []);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
});

test("cleanup refuses missing or mismatched PostgreSQL ownership without pg_ctl or removal", async t => {
  const fixtureValue = await fixture(t), actions = [];
  await fs.writeFile(join(fixtureValue.root, "pg", REHEARSAL_POSTGRES_MARKER), `${JSON.stringify({
    schema: "control-room.disposable-postgres/v1", createdBy: "mac-local-rehearsal", runId: "f".repeat(32),
  })}\n`, { mode: 0o600 });
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions));
  assert.equal(result.cleaned, false);
  assert.equal(result.reason, "rehearsal_postgres_marker_mismatch");
  assert.deepEqual(actions, []);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
});

test("cleanup removes an interrupted initdb directory only when it has no process identity", async t => {
  const fixtureValue = await fixture(t), actions = [];
  await fs.rm(join(fixtureValue.root, "pg", REHEARSAL_POSTGRES_MARKER));
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions));
  assert.equal(result.cleaned, true);
  assert.deepEqual(actions, []);
  await assert.rejects(fs.lstat(fixtureValue.root), error => error.code === "ENOENT");
});

test("cleanup retains an unmarked PostgreSQL directory when postmaster.pid exists", async t => {
  const fixtureValue = await fixture(t), actions = [];
  await fs.rm(join(fixtureValue.root, "pg", REHEARSAL_POSTGRES_MARKER));
  await fs.writeFile(join(fixtureValue.root, "pg", "postmaster.pid"), "123\n", { mode: 0o600 });
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions));
  assert.equal(result.cleaned, false);
  assert.equal(result.reason, "rehearsal_postgres_marker_missing_with_process_identity");
  assert.deepEqual(actions, []);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
});

test("cleanup refuses a loose ownership marker before any process or database action", async t => {
  const fixtureValue = await fixture(t), actions = [];
  await fs.chmod(join(fixtureValue.root, ".control-room-rehearsal.json"), 0o644);
  await assert.rejects(cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions)),
    /rehearsal_ownership_file_unsafe/u);
  assert.deepEqual(actions, []);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
});

test("registry cleanup ignores unrecognized files and cleans only a validated registered root", async t => {
  const fixtureValue = await fixture(t), actions = [];
  await fs.writeFile(join(fixtureValue.registryDirectory, "unrelated.txt"), "leave me\n", { mode: 0o600 });
  const results = await cleanupRegisteredRehearsals({ registryDirectory: fixtureValue.registryDirectory },
    fakeRuntime(new Map(), actions));
  assert.equal(results.length, 1);
  assert.equal(results[0].root, fixtureValue.root);
  assert.equal(results[0].cleaned, true);
  assert.equal(await fs.readFile(join(fixtureValue.registryDirectory, "unrelated.txt"), "utf8"), "leave me\n");
});
