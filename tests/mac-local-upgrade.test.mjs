import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMacUpgradeArgumentsV1, runMacUpgradeV1 } from "../scripts/mac-local/upgrade.mjs";

const before = "a".repeat(40), after = "b".repeat(40);
const head = Object.freeze({ order: 104, file: "db/migrations/0104_fixture.sql", digest: `sha256:${"c".repeat(64)}` });

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
