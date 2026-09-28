import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REHEARSAL_POSTGRES_MARKER,
  captureRehearsalOwnership,
  createRehearsalOwnership,
  runBoundedChild,
  updateRehearsalProcesses,
} from "../scripts/mac-local/rehearsal/lifecycle.mjs";
import { cleanupRehearsalRoot, cleanupRegisteredRehearsals } from "../scripts/mac-local/rehearsal/cleanup.mjs";
import { hostCommand, runtimePaths } from "../scripts/mac-local/stack.mjs";

/** A child process that starts and closes at once, so registration can be exercised over an
 * injected `processCommand` with no real process and no clock. */
function fakeSpawn() {
  return () => {
    const child = new EventEmitter();
    child.pid = 32_242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => child.emit("close", 0, null));
    return child;
  };
}

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
  // Pid 301 is this run's own process, so it is skipped. Pid 302 is alive but under a different
  // command line: a recycled pid. Cleanup used to answer `not_running` for it and then delete the
  // root, which is the exact defect this PR fixes — a live pid it cannot identify is identity
  // uncertainty, so the root is retained and the command exits nonzero for the operator to retry.
  const processes = [
    { kind: "setup", pid: 301, command: ["node", "setup"], group: true },
    { kind: "host", pid: 302, command: ["node", "expected-host"], group: true },
  ];
  const fixtureValue = await fixture(t, processes), actions = [];
  const commands = new Map([[301, "node setup"], [302, "node different-host"]]);
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(commands, actions, { currentPid: 301 }));
  assert.equal(result.cleaned, false);
  assert.equal(result.reason, "rehearsal_host_identity_uncertain");
  assert.deepEqual(result.outcomes.map(item => item.state), ["current", "identity_uncertain"]);
  assert.equal(actions.some(action => action[0] === "signal"), false);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true, "the root must be retained");
  assert.equal((await fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`))).isFile(), true,
    "the registry record must be retained so cleanup can be retried");
});

test("cleanup deletes the root when every recorded pid is genuinely gone", async t => {
  // The other half of the same case, so the new refusal cannot pass by never cleaning anything:
  // when each recorded pid has actually exited, cleanup still stops the cluster and removes the
  // root and the registry record.
  const processes = [{ kind: "setup", pid: 303, command: ["node", "setup"], group: true }];
  const fixtureValue = await fixture(t, processes), actions = [];
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions));
  assert.equal(result.cleaned, true);
  assert.deepEqual(result.outcomes.map(item => item.state), ["not_running"]);
  assert.equal(actions.some(action => action[0] === "signal"), false);
  await assert.rejects(fs.lstat(fixtureValue.root), error => error.code === "ENOENT");
  await assert.rejects(fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`)),
    error => error.code === "ENOENT");
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

test("cleanup retains the root when a child survives SIGKILL but is no longer the exact command", async t => {
  // `stopExactProcess`'s final verdict decides whether a process that took a SIGKILL is really
  // gone. The old verdict asked only "is the command line still the exact one?", so a process that
  // survived but under a different command line was reported `stopped` — a proof of absence that
  // was never established. It must ask whether the pid exists at all, and `still_running` must
  // reach the caller so the root is retained.
  const processRecord = { kind: "child", pid: 801, command: ["node", "child"], group: true };
  const fixtureValue = await fixture(t, [processRecord]), actions = [];
  const commands = new Map([[801, "node child"]]);
  let samples = 0;
  const runtime = fakeRuntime(commands, actions, { sticky: new Set([801]) });
  const realProcessCommand = runtime.processCommand;
  runtime.processCommand = async pid => {
    samples += 1;
    // Sample 1 classifies, 2 is the post-grace read, 3 is the final verdict. The process is exact
    // through the stop attempt and different by the verdict that claims it is gone.
    return samples >= 3 ? "node re-exec'd-into-something-else" : realProcessCommand(pid);
  };
  const result = await cleanupRehearsalRoot({ ...fixtureValue, graceMs: 0 }, runtime);
  assert.equal(result.cleaned, false, "a surviving pid must never be reported stopped");
  assert.equal(result.reason, "process_cleanup_uncertain");
  assert.equal(actions.some(action => action[0] === "pg_ctl"), false,
    "the database must not be stopped while a child is unaccounted for");
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
  assert.equal((await fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`))).isFile(), true);
});

test("a still-running child blocks cleanup even when its pid exits the exact match", async t => {
  // The `still_running` verdict is the loop-level fail-closed guard. It is duplicated in the
  // children loop and the hosts loop, and a test that only exercises one copy would not notice
  // the other being removed. This drives the *hosts* loop's copy, so both are covered: the host
  // pid is still running under the recorded command through the whole stop attempt.
  const processRecord = { kind: "host", pid: 802, command: ["node", "host"], group: true };
  const fixtureValue = await fixture(t, [processRecord]), actions = [];
  const commands = new Map([[802, "node host"]]);
  const result = await cleanupRehearsalRoot({ ...fixtureValue, graceMs: 0 },
    fakeRuntime(commands, actions, { sticky: new Set([802]) }));
  assert.equal(result.cleaned, false, "a host that will not stop must block cleanup");
  assert.equal(result.reason, "process_cleanup_uncertain");
  assert.equal(result.outcomes[0]?.state, "still_running");
  assert.equal(actions.some(action => action[0] === "pg_ctl"), false);
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
  assert.equal((await fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`))).isFile(), true);
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

test("cleanup is idempotent for an absent root and refuses an existing legacy root without a marker", async t => {
  const base = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "acr-rehearsal-absent-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const registryDirectory = join(base, "registry"), root = join(base, "missing");
  const absent = await cleanupRehearsalRoot({ root, registryDirectory }, fakeRuntime(new Map(), []));
  assert.deepEqual({ cleaned: absent.cleaned, alreadyCleaned: absent.alreadyCleaned },
    { cleaned: true, alreadyCleaned: true });
  await fs.mkdir(root, { mode: 0o700 });
  const legacy = await cleanupRehearsalRoot({ root, registryDirectory }, fakeRuntime(new Map(), []));
  // A directory that exists but carries no ownership marker is NOT an already-cleaned root: it is
  // a root this stack cannot prove it owns. It must be refused by name, never deleted, because
  // "absent" and "unidentified" are different answers and only the first one authorises removal.
  assert.equal(legacy.cleaned, false);
  assert.equal(legacy.reason, "rehearsal_ownership_marker_missing");
  assert.equal(legacy.alreadyCleaned, undefined);
  assert.equal((await fs.lstat(root)).isDirectory(), true, "an unproven root must be retained");
});

test("a rehearsal root on a reserved port is refused when the record is read back", async t => {
  // `createRehearsalOwnership` refuses the reserved ports, so this only fires if a record reaches
  // disk some other way. `captureRehearsalOwnership` is the independent check on the way back out
  // of a file, and the live application's database (5432) and web (3210) ports are exactly what a
  // rehearsal must never point at. Without it, cleanup would happily act on such a record.
  for (const [name, key, port] of [["database", "databasePort", 5432], ["web", "webPort", 3210]]) {
    await t.test(name, async t => {
      const base = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "acr-rehearsal-reserved-"));
      t.after(() => fs.rm(base, { recursive: true, force: true }));
      const root = join(base, "run"), registryDirectory = join(base, "registry");
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      // The record is created on a disposable port, then rewritten on disk to the reserved one —
      // which is the only way such a record can exist at all, and the reason the read-back check
      // has to be independent of the creation check.
      const ownership = await createRehearsalOwnership({ root, databasePort: 15499, webPort: 3217,
        repositoryRoot: await fs.realpath(process.cwd()), registryDirectory, processes: [] });
      const planted = { ...ownership, [key]: port };
      const body = `${JSON.stringify(planted, null, 2)}\n`;
      await fs.writeFile(join(root, ".control-room-rehearsal.json"), body, { mode: 0o600 });
      await fs.writeFile(join(registryDirectory, `${ownership.runId}.json`), body, { mode: 0o600 });
      assert.throws(() => captureRehearsalOwnership(planted), /rehearsal_ownership_invalid/u,
        `a record on reserved ${name} port ${port} must be refused`);
      // A record this stack cannot even parse is a hard refusal that propagates out of cleanup
      // rather than becoming a `cleaned: false` result, so the command exits nonzero and the root
      // is left exactly where it is for the operator to look at.
      await assert.rejects(cleanupRehearsalRoot({ root, registryDirectory }, fakeRuntime(new Map(), [])),
        /rehearsal_ownership_invalid/u,
        `a reserved-port ${name} record must abort cleanup before anything is signalled or removed`);
      assert.equal((await fs.lstat(root)).isDirectory(), true);
    });
  }
});

test("registry cleanup removes an exact stale record after its root is already absent", async t => {
  const fixtureValue = await fixture(t), actions = [];
  const registryPath = join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`);
  await fs.rm(fixtureValue.root, { recursive: true });
  const results = await cleanupRegisteredRehearsals({ registryDirectory: fixtureValue.registryDirectory },
    fakeRuntime(new Map(), actions));
  assert.equal(results[0].cleaned, true);
  assert.equal(results[0].alreadyCleaned, true);
  await assert.rejects(fs.lstat(registryPath), error => error.code === "ENOENT");
});

test("registration samples past a transient pre-exec command line", async () => {
  // A wrapper binary is not the process it becomes: `pnpm` starts as `/usr/bin/env node …/pnpm`
  // and execs into `node …/pnpm` a few milliseconds later. A record taken at spawn can therefore
  // hold the transient form, which `ps` never reports again, and a record that can never match
  // again is indistinguishable to cleanup from a pid that is simply gone. Registration samples
  // until two consecutive observations agree. This is a pure unit test over an injected
  // `processCommand`, so it is deterministic and needs no clock.
  const samples = [
    "/usr/bin/env node /pnpm exec node -e setInterval",
    "node /pnpm exec node -e setInterval",
    "node /pnpm exec node -e setInterval",
  ];
  let seen = 0, recorded;
  await runBoundedChild("pnpm", ["exec", "node", "-e", "setInterval(() => {}, 1000)"], {
    spawnImpl: fakeSpawn(),
    processCommand: async () => samples[Math.min(seen++, samples.length - 1)],
    onSpawn: record => { recorded = record; },
  });
  assert.deepEqual(recorded.command, ["node /pnpm exec node -e setInterval"],
    "the settled form must be recorded, not the transient pre-exec form");
  assert.equal(seen, 3, "registration must sample until two consecutive observations agree");
});

test("a transient form that happens to repeat is why cleanup must stay fail-closed", async () => {
  // Two consecutive identical samples narrow the window; they cannot close it. If the pre-`exec`
  // form happens to repeat, sampling records it — and nothing at registration can tell a settled
  // command line from a transient one that has paused. This is the honest boundary of the
  // registration-side fix, and it is exactly why the deletion side refuses to delete rather than
  // treating an unmatchable record as proof of absence. Cleanup's identity-uncertainty path is
  // the backstop for this case, and it is covered separately.
  const samples = [
    "/usr/bin/env node /pnpm exec node -e setInterval",
    "/usr/bin/env node /pnpm exec node -e setInterval",
  ];
  let seen = 0, recorded;
  await runBoundedChild("pnpm", ["exec", "node", "-e", "setInterval(() => {}, 1000)"], {
    spawnImpl: fakeSpawn(),
    processCommand: async () => samples[Math.min(seen++, samples.length - 1)],
    onSpawn: record => { recorded = record; },
  });
  assert.equal(seen, 2, "sampling stops as soon as two consecutive observations agree");
  assert.deepEqual(recorded.command, [samples[0]],
    "a repeated transient form is recorded as-is; cleanup's identity guard is what makes that safe");
});

test("a registration sample that never settles still records a real command line", async () => {
  // If the command line keeps changing, registration must not fail and leave the child
  // unregistered (an unregistered child can never be cleaned up). It records the last real
  // observation, and cleanup's identity-uncertainty classification is the backstop.
  let seen = 0, recorded;
  const result = await runBoundedChild("pnpm", ["exec", "node", "-e", "setInterval(() => {}, 1000)"], {
    spawnImpl: fakeSpawn(),
    processCommand: async () => { seen += 1; return `node changing-${seen}`; },
    onSpawn: record => { recorded = record; },
  });
  assert.equal(seen, 20, "sampling is bounded, so an unstable command line cannot hang registration");
  assert.equal(result.error, undefined, "an unsettled sample must not fail registration");
  assert.deepEqual(recorded.command, ["node changing-20"], "the last real observation is recorded");
});

test("registration reports a child whose command line cannot be read at all", async () => {
  // The one registration failure that is still correct: no command line means no identity, and an
  // unidentifiable child is terminated rather than left running and unrecorded.
  let registered = false;
  const result = await runBoundedChild("pnpm", ["exec", "node", "-e", "setInterval(() => {}, 1000)"], {
    spawnImpl: fakeSpawn(),
    processCommand: async () => undefined,
    onSpawn: () => { registered = true; },
  });
  assert.equal(result.error?.message, "rehearsal_child_identity_unavailable");
  assert.equal(registered, false, "a child with no readable command line must not be registered");
});

test("cleanup matches and stops the real OS command for a pnpm-wrapped child", async t => {
  // The load-bearing assertion here is the outcome, not the shape of the recorded string. The
  // implementation used to sample `ps` once at spawn, which lands in the transient
  // `/usr/bin/env …/pnpm` pre-`exec` form; a record that can never match again then reads as
  // "already gone" and cleanup deletes the root while the child runs. The child is given time to
  // settle *before* cleanup runs, and cleanup must either stop it or retain the root — it may not
  // report `cleaned: true` with the child still alive, whatever the record happens to say.
  const fixtureValue = await fixture(t);
  await fs.rm(join(fixtureValue.root, "pg"), { recursive: true });
  await fs.rm(join(fixtureValue.root, "protected"), { recursive: true });
  let registeredResolve;
  const registered = new Promise(resolve => { registeredResolve = resolve; });
  const childResult = runBoundedChild("pnpm", ["exec", "node", "-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), timeoutMs: 10_000, terminateGraceMs: 1_000,
    async onSpawn(record) {
      await updateRehearsalProcesses({ root: fixtureValue.root, registryDirectory: fixtureValue.registryDirectory,
        processes: [{ kind: "child", ...record }] });
      registeredResolve(record);
    },
  });
  const first = await Promise.race([
    registered.then(record => ({ record })),
    childResult.then(result => ({ result })),
  ]);
  if ("result" in first) {
    assert.match(first.result.error?.message ?? "", /rehearsal_child_identity_unavailable/u);
    t.skip("sandbox denied OS process-command inspection");
    return;
  }
  // Registration records one joined string, as the ownership schema requires.
  assert.equal(first.record.command.length, 1);
  assert.match(first.record.command[0], /pnpm.*exec.*node/u);
  // Let the wrapper finish its exec transition, so the run is decided by cleanup's guard rather
  // than by which side of that transition the registration happened to sample.
  await new Promise(resolveWait => setTimeout(resolveWait, 400));
  const stillAlive = () => {
    try { process.kill(first.record.pid, 0); return true; } catch { return false; }
  };
  assert.equal(stillAlive(), true, "the child must still be running when cleanup starts");

  const result = await cleanupRehearsalRoot({ root: fixtureValue.root,
    registryDirectory: fixtureValue.registryDirectory, graceMs: 1_000 });
  // The invariant under test: cleanup never reports success while an owned child is still running.
  if (result.cleaned === true)
    assert.equal(stillAlive(), false, "cleanup reported cleaned: true with the child still alive");
  else {
    assert.equal(result.reason, "rehearsal_child_identity_uncertain",
      "a retained root must say why, and that reason must be the identity uncertainty");
    assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true, "the root must be retained");
    assert.equal((await fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`))).isFile(), true,
      "the registry record must be retained so cleanup can be retried");
  }
  const stopped = await childResult;
  // Either path must leave no owned child running; a retained root keeps the evidence to retry.
  assert.equal(stopped.signal !== null || result.cleaned === false, true);
  if (result.cleaned === true) await assert.rejects(fs.lstat(fixtureValue.root), error => error.code === "ENOENT");
  try { process.kill(-first.record.pid, "SIGKILL"); } catch {}
  if (result.cleaned === false) await fs.rm(fixtureValue.root, { recursive: true, force: true });
});

test("cleanup retains the root when a recorded child is alive but cannot be identified", async t => {
  // The deterministic companion to the pnpm case, and the one that needs no clock at all: a
  // pre-`exec`-shaped record against a live child. `stopExactProcess` used to treat "recorded
  // string ≠ current string" as proof of absence, so it answered `not_running`, which the caller
  // read as "already gone" and then removed the root, the marker and the registry record. A live
  // pid whose command line does not match is identity uncertainty, and it must retain the root.
  const recorded = { kind: "child", pid: 601, command: ["/usr/bin/env node /pnpm exec node -e setInterval"], group: true };
  const fixtureValue = await fixture(t, [recorded]), actions = [];
  // The pid exists and is alive, under the settled form rather than the recorded pre-`exec` form.
  const commands = new Map([[601, "node /pnpm exec node -e setInterval"]]);
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(commands, actions));
  assert.equal(result.cleaned, false, "a live unidentified pid must never authorise deletion");
  assert.equal(result.reason, "rehearsal_child_identity_uncertain");
  assert.deepEqual(result.outcomes, [{ kind: "child", pid: 601, state: "identity_uncertain" }]);
  assert.deepEqual(actions, [], "an unidentified pid must not be signalled either");
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true, "the root must be retained");
  assert.equal((await fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`))).isFile(), true,
    "the registry record must be retained so cleanup can be retried");
  assert.equal(actions.some(action => action[0] === "pg_ctl"), false,
    "the database must not be stopped before the process is accounted for");
});

test("cleanup re-checks liveness immediately before deleting the root", async t => {
  // The loops that stop each process prove a pid was gone at the moment they handled it. Between
  // that proof and the `rm` anything can change, and deletion is the irreversible step. This
  // drives a pid that is clean when the stop loop sees it and alive again by the time deletion is
  // about to happen — the exact shape of an OS-recycled or re-exec'd child.
  const processRecord = { kind: "child", pid: 701, command: ["node", "child"], group: true };
  const fixtureValue = await fixture(t, [processRecord]), actions = [];
  const commands = new Map([[701, "node child"]]);
  let samples = 0;
  const runtime = fakeRuntime(commands, actions);
  const realProcessCommand = runtime.processCommand;
  // The stop loop's samples see the process; the re-check immediately before deletion does not.
  runtime.processCommand = async pid => {
    samples += 1;
    // 1 = initial classify, 2 = the in-grace loop, 3 = the post-grace re-read, 4 = pre-delete check.
    return samples >= 4 ? undefined : realProcessCommand(pid);
  };
  const result = await cleanupRehearsalRoot({ ...fixtureValue, graceMs: 0 }, runtime);
  assert.equal(result.cleaned, true, "a pid that is genuinely gone at the re-check is deleted");
  assert.ok(samples >= 4, `the pre-delete re-check must sample at least once more (saw ${samples})`);
  await assert.rejects(fs.lstat(fixtureValue.root), error => error.code === "ENOENT");
});

test("cleanup retains the root when an owned pid reappears between the stop loop and deletion", async t => {
  // The mirror of the case above: the same re-check, with the pid still alive when it runs. Under
  // the old code the stop loop's `not_running` verdict was the last word and the root was deleted.
  const processRecord = { kind: "child", pid: 702, command: ["node", "child"], group: true };
  const fixtureValue = await fixture(t, [processRecord]), actions = [];
  const commands = new Map([[702, "node child"]]);
  let samples = 0;
  const runtime = fakeRuntime(commands, actions);
  const realProcessCommand = runtime.processCommand;
  runtime.processCommand = async pid => {
    samples += 1;
    // The stop loop proves it gone; the re-check finds it alive again under an unrelated command,
    // which is what a recycled or re-exec'd pid looks like.
    return samples >= 4 ? "node something-else-entirely" : realProcessCommand(pid);
  };
  const result = await cleanupRehearsalRoot({ ...fixtureValue, graceMs: 0 }, runtime);
  assert.equal(result.cleaned, false, "a pid alive at the pre-delete re-check must retain the root");
  assert.equal(result.reason, "process_cleanup_uncertain");
  assert.equal(result.outcomes.at(-1)?.state, "identity_uncertain");
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
  assert.equal((await fs.lstat(join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`))).isFile(), true);
});

test("cleanup refuses a loose PostgreSQL ownership marker before any process or database action", async t => {
  // The marker is the second factor that proves <root>/pg is this run's disposable cluster. The
  // existing marker test only reaches the runId-mismatch branch; the mode/uid clause above it —
  // which refuses a world-readable marker in a private root — had no test at all.
  const fixtureValue = await fixture(t), actions = [];
  await fs.chmod(join(fixtureValue.root, "pg", REHEARSAL_POSTGRES_MARKER), 0o644);
  const result = await cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions));
  assert.equal(result.cleaned, false);
  assert.equal(result.reason, "rehearsal_postgres_marker_unsafe");
  assert.deepEqual(actions, [], "no signal and no pg_ctl may happen for an unsafe marker");
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
});

test("cleanup refuses a registry record that disagrees with the on-disk marker", async t => {
  // The registry copy is what `rehearsal:cleanup` iterates over, so a registry entry that has
  // drifted from the marker is a record cleanup would act on without the marker's agreement. The
  // two must be the same document; this clause had no test at all.
  const fixtureValue = await fixture(t, []), actions = [];
  const registryPath = join(fixtureValue.registryDirectory, `${fixtureValue.ownership.runId}.json`);
  const registered = JSON.parse(await fs.readFile(registryPath, "utf8"));
  await fs.writeFile(registryPath, `${JSON.stringify({
    ...registered, processes: [{ kind: "child", pid: 900, command: ["node", "planted"], group: true }],
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(cleanupRehearsalRoot(fixtureValue, fakeRuntime(new Map(), actions)),
    /rehearsal_registry_mismatch/u);
  assert.deepEqual(actions, [], "a drifted registry must be refused before anything is signalled");
  assert.equal((await fs.lstat(fixtureValue.root)).isDirectory(), true);
});
