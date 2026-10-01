import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseMacUpgradeArgumentsV1, runMacUpgradeV1 } from "../scripts/mac-local/upgrade.mjs";

const before = "a".repeat(40), after = "b".repeat(40);
const head = Object.freeze({ order: 104, file: "db/migrations/0104_fixture.sql", digest: `sha256:${"c".repeat(64)}` });
const run = promisify(execFile);

async function git(cwd, args) {
  const result = await run("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function realRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "mac-upgrade-git-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git"), seed = join(root, "seed"), checkout = join(root, "checkout");
  await mkdir(seed); await git(root, ["init", "--bare", origin]); await git(seed, ["init"]);
  await git(seed, ["config", "user.name", "Upgrade Fixture"]); await git(seed, ["config", "user.email", "upgrade@example.invalid"]);
  await writeFile(join(seed, "tracked.txt"), "before\n"); await git(seed, ["add", "tracked.txt"]);
  await git(seed, ["commit", "-m", "before"]); await git(seed, ["branch", "-M", "main"]);
  await git(seed, ["remote", "add", "origin", origin]); await git(seed, ["push", "-u", "origin", "main"]);
  const first = await git(seed, ["rev-parse", "HEAD"]);
  await git(root, ["clone", "--branch", "main", origin, checkout]);
  await writeFile(join(seed, "tracked.txt"), "after\n"); await git(seed, ["commit", "-am", "after"]); await git(seed, ["push"]);
  const second = await git(seed, ["rev-parse", "HEAD"]);
  return { root, checkout, first, second };
}

function fakeGit({ branch = "main", dirty = "", current = before, origin = after } = {}) {
  const state = { branch, dirty, current, origin, calls: [] };
  const git = async args => {
    state.calls.push(args);
    if (args.join(" ") === "branch --show-current") return state.branch;
    if (args.join(" ") === "status --porcelain") return state.dirty;
    if (args.join(" ") === "rev-parse HEAD") return state.current;
    if (args.join(" ") === "rev-parse origin/main") return state.origin;
    if (args.join(" ") === "fetch origin main") return "";
    if (args.join(" ") === "merge --ff-only origin/main") { state.current = state.origin; return ""; }
    if (args[0] === "switch" && args[1] === "--detach") { state.current = args[2]; return ""; }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { state, git };
}

async function fixture(overrides = {}) {
  const protectedRoot = await mkdtemp(join(tmpdir(), "mac-upgrade-"));
  const fake = fakeGit(overrides.git);
  const calls = [], lines = [], records = [];
  return { protectedRoot, fake, calls, lines, records,
    options: {
      protectedRoot, git: fake.git, readLedgerHead: async () => head,
      run: async args => { calls.push(args); return overrides.runResult?.(args) ?? 0; },
      write: line => lines.push(line), wait: async () => { lines.push("waited"); },
      writeRecord: async record => records.push(record), readRecord: async () => overrides.record,
      prepare: async input => ({ mainCommit: input.mainCommit, ...(overrides.prepare ?? {}) }),
      finish: async input => ({ mainCommit: input.mainCommit, ...(overrides.finish ?? {}) }),
    } };
}

test("mac upgrade follows the owner-visible order, retains only a non-secret resume record, and hands off once", async () => {
  const item = await fixture({ prepare: { code: "SCRAM-SHA-256$opaque" } });
  const result = await runMacUpgradeV1(item.options);
  assert.deepEqual(result, { upgraded: true, previousCommit: before, targetCommit: after, ledgerHead: head });
  assert.deepEqual(item.calls, [
    ["mac:down", "--", "--protected-root", item.protectedRoot], ["install", "--frozen-lockfile"], ["build"],
    ["mac:up", "--", "--protected-root", item.protectedRoot], ["mac:status", "--", "--protected-root", item.protectedRoot],
  ]);
  assert.equal(item.records.length, 1);
  assert.deepEqual(item.records[0].ledgerHead, head);
  assert.equal(JSON.stringify(item.records[0]).includes("opaque"), false, "the handoff code is never retained");
  assert.match(item.lines.join("\n"), /1\/7 stop/);
  assert.match(item.lines.join("\n"), new RegExp(`cr-db-upgrade ${after.slice(0, 7)}`, "u"));
  assert.match(item.lines.join("\n"), /Resume point if interrupted/);
  assert.match(item.lines.join("\n"), /VPS login code/);
});

test("a normal repeat prints no login code and still gives the VPS handoff", async () => {
  const item = await fixture({ prepare: { nothingToPrepare: true } });
  await runMacUpgradeV1(item.options);
  assert.doesNotMatch(item.lines.join("\n"), /VPS login code/);
  assert.match(item.lines.join("\n"), /Now run this on the VPS/);
});

test("refuses a dirty or non-main checkout before it stops the host", async () => {
  for (const git of [{ dirty: "M package.json" }, { branch: "cook/mupgrade" }]) {
    const item = await fixture({ git });
    await assert.rejects(runMacUpgradeV1(item.options), /upgrade_main_checkout_refused/);
    assert.deepEqual(item.calls, []);
    assert.deepEqual(item.records, []);
  }
});

test("refuses when main does not end at the fetched origin commit", async () => {
  const item = await fixture();
  const original = item.options.git;
  item.options.git = async args => args.join(" ") === "rev-parse origin/main" ? "d".repeat(40) : original(args);
  await assert.rejects(runMacUpgradeV1(item.options), /upgrade_main_moved_refused/);
  assert.deepEqual(item.calls, []);
});

test("a wrong or stale VPS login code is refused before Control Room is restarted", async () => {
  const item = await fixture({ finish: { mainCommit: before } });
  await assert.rejects(runMacUpgradeV1(item.options), /upgrade_finish_refused/);
  assert.equal(item.calls.some(args => args[0] === "mac:up"), false);
  assert.match(item.lines.join("\n"), /6\/7 finish/);
});

test("an unhealthy host offers the guarded rollback command", async () => {
  const item = await fixture({ runResult: args => args[0] === "mac:status" ? 1 : 0 });
  await assert.rejects(runMacUpgradeV1(item.options), /upgrade_health_failed/);
  assert.match(item.lines.join("\n"), /did not become healthy/);
  assert.match(item.lines.join("\n"), /--rollback/);
});

test("rollback refuses after a VPS migration, but rebuilds and checks the prior code when the ledger is unchanged", async () => {
  const record = { schema: "control-room.mac-upgrade-recovery/v1", previousCommit: before, targetCommit: after, ledgerHead: head };
  const changed = await fixture({ git: { current: after, origin: after }, record });
  changed.options.readLedgerHead = async () => ({ ...head, order: 105 });
  await assert.rejects(runMacUpgradeV1({ ...changed.options, rollback: true }), /upgrade_rollback_ledger_moved_refused/);
  assert.deepEqual(changed.calls, []);

  const safe = await fixture({ git: { current: after, origin: after }, record });
  const result = await runMacUpgradeV1({ ...safe.options, rollback: true });
  assert.deepEqual(result, { rolledBack: true, previousCommit: before });
  assert.deepEqual(safe.calls, [
    ["mac:down", "--", "--protected-root", safe.protectedRoot], ["build"],
    ["mac:up", "--", "--protected-root", safe.protectedRoot], ["mac:status", "--", "--protected-root", safe.protectedRoot],
  ]);
  assert.ok(safe.fake.state.calls.some(args => args.join("|") === ["switch", "--detach", before].join("|")));
});

test("argument parsing accepts only the protected root and rollback switch", () => {
  assert.deepEqual(parseMacUpgradeArgumentsV1(["--rollback", "--protected-root", "/protected"]),
    { rollback: true, protectedRoot: "/protected" });
  assert.throws(() => parseMacUpgradeArgumentsV1(["--anything", "--protected-root", "/protected"]), /upgrade_arguments_refused/);
});

test("item 10: upgrade uses fixed real Git arguments in a temporary main checkout and refuses detached HEAD", async t => {
  const repository = await realRepository(t), protectedRoot = join(repository.root, "protected");
  let laterReached = false;
  await assert.rejects(runMacUpgradeV1({ protectedRoot, repositoryRoot: repository.checkout,
    readLedgerHead: async () => { laterReached = true; throw new Error("stop_after_real_git_checks"); },
  }), /stop_after_real_git_checks/u);
  assert.equal(laterReached, true);
  assert.equal(await git(repository.checkout, ["branch", "--show-current"]), "main");
  assert.equal(await git(repository.checkout, ["rev-parse", "HEAD"]), repository.second);
  assert.equal(await git(repository.checkout, ["rev-parse", "origin/main"]), repository.second);

  await git(repository.checkout, ["checkout", "--detach", repository.first]);
  laterReached = false;
  await assert.rejects(runMacUpgradeV1({ protectedRoot, repositoryRoot: repository.checkout,
    readLedgerHead: async () => { laterReached = true; return head; },
  }), /upgrade_main_checkout_refused/u);
  assert.equal(laterReached, false, "a detached checkout is refused before any later upgrade effect");
});

test("item 11: a real recovery record survives an interrupted upgrade, validates on rollback, and refuses alteration or links", async t => {
  const item = await fixture(); t.after(() => rm(item.protectedRoot, { recursive: true, force: true }));
  delete item.options.writeRecord; delete item.options.readRecord;
  item.options.run = async args => { item.calls.push(args); return args[0] === "mac:down" ? 1 : 0; };
  await assert.rejects(runMacUpgradeV1(item.options), /upgrade_stop_failed/u);
  const recordPath = join(item.protectedRoot, "runtime/upgrade-previous.json"), entry = await lstat(recordPath);
  assert.equal(entry.isFile(), true); assert.equal(entry.isSymbolicLink(), false); assert.equal(entry.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), {
    schema: "control-room.mac-upgrade-recovery/v1", previousCommit: before, targetCommit: after, ledgerHead: head,
  });
  assert.deepEqual((await readdir(join(item.protectedRoot, "runtime"))).sort(), ["upgrade-previous.json"]);

  const rollbackGit = fakeGit({ current: after, origin: after });
  const rolledBack = await runMacUpgradeV1({ protectedRoot: item.protectedRoot, rollback: true, git: rollbackGit.git,
    readLedgerHead: async () => head, run: async () => 0, write: () => {} });
  assert.deepEqual(rolledBack, { rolledBack: true, previousCommit: before });

  const changed = JSON.parse(await readFile(recordPath, "utf8")); changed.unexpected = true;
  await writeFile(recordPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 }); await chmod(recordPath, 0o600);
  let laterCalls = 0;
  await assert.rejects(runMacUpgradeV1({ protectedRoot: item.protectedRoot, rollback: true, git: rollbackGit.git,
    readLedgerHead: async () => { laterCalls += 1; return head; }, run: async () => { laterCalls += 1; return 0; }, write: () => {} }),
  /upgrade_recovery_record_refused/u);
  assert.equal(laterCalls, 0);

  const target = join(item.protectedRoot, "record-target.json");
  await writeFile(target, `${JSON.stringify({ schema: "control-room.mac-upgrade-recovery/v1",
    previousCommit: before, targetCommit: after, ledgerHead: head })}\n`, { mode: 0o600 });
  await rm(recordPath); await symlink(target, recordPath);
  await assert.rejects(runMacUpgradeV1({ protectedRoot: item.protectedRoot, rollback: true, git: rollbackGit.git,
    readLedgerHead: async () => head, run: async () => 0, write: () => {} }), /upgrade_recovery_record_refused/u);
});

test("item 11 stress: twenty interrupted writers leave one exact parseable recovery record and no staging files", async t => {
  const protectedRoot = await mkdtemp(join(tmpdir(), "mac-upgrade-record-stress-"));
  t.after(() => rm(protectedRoot, { recursive: true, force: true }));
  const attempts = Array.from({ length: 20 }, () => {
    const currentGit = fakeGit();
    return runMacUpgradeV1({ protectedRoot, git: currentGit.git, readLedgerHead: async () => head,
      run: async args => args[0] === "mac:down" ? 1 : 0, write: () => {}, wait: async () => {},
      prepare: async input => ({ mainCommit: input.mainCommit }), finish: async input => ({ mainCommit: input.mainCommit }) });
  });
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason?.message === "upgrade_stop_failed").length, 20);
  assert.deepEqual((await readdir(join(protectedRoot, "runtime"))).sort(), ["upgrade-previous.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(protectedRoot, "runtime/upgrade-previous.json"), "utf8")), {
    schema: "control-room.mac-upgrade-recovery/v1", previousCommit: before, targetCommit: after, ledgerHead: head,
  });
});
