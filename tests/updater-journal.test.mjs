import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStepJournalV1, reconcileJournalDisplayV1, RefusalAggregatorV1 } from "../src/updater/v1/journal.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "updater-journal-"));
  await (await import("node:fs/promises")).mkdir(join(root, "updater-state"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, journal: new FileStepJournalV1(root, { ownerUid: process.getuid(), ...options }) };
}

test("journal is file-first: a valid file refreshes a short display, while display-ahead and mismatch become uncertain", async t => {
  const { journal } = await fixture(t);
  await journal.intent({ runId: "run-one", ordinal: 1, from: "approved", to: "prechecked", detail: {} });
  await journal.done({ runId: "run-one", ordinal: 1, state: "prechecked", detail: {} });
  const display = { rows: [], async readJournalDisplay() { return this.rows; }, async refreshJournalDisplay(rows) { this.rows = rows; } };
  assert.deepEqual(await reconcileJournalDisplayV1({ journal, display }), { state: "ready", refreshed: true });
  display.rows.push({ schema: "control-room.updater-journal/v1", kind: "done", at: "2000-01-01T00:00:00.000Z" });
  assert.equal((await reconcileJournalDisplayV1({ journal, display })).reason, "display_ahead");
  display.rows = [{ schema: "forged" }];
  assert.equal((await reconcileJournalDisplayV1({ journal, display })).reason, "display_content_mismatch");
  assert.equal((await reconcileJournalDisplayV1({ journal, display, rescued: true })).reason, "rescue_marker");
});

test("journal keeps its verified prefix at every byte offset and resumes after repairing the tail", { timeout: 120_000 }, async t => {
  const { root, journal } = await fixture(t);
  for (let ordinal = 1; ordinal <= 3; ordinal += 1)
    await journal.done({ runId: "run-torn", ordinal, state: "staged", detail: { message: "é完整" } });
  const path = join(root, "updater-state/journal.jsonl"), prefix = await readFile(path);
  const expected = (await journal.validate()).entries;
  await journal.done({ runId: "run-torn", ordinal: 4, state: "succeeded", detail: { message: "é完整" } });
  const entry = (await readFile(path)).subarray(prefix.length);
  for (let cut = 0; cut < entry.length; cut += 1) {
    await writeFile(path, Buffer.concat([prefix, entry.subarray(0, cut)]), { mode: 0o600 });
    assert.deepEqual((await journal.validate()).entries, expected, `cut ${cut}`);
    assert.deepEqual(await readFile(path), prefix, `durable repair at cut ${cut}`);
  }
  for (const tail of ['{"torn"\n', '{"torn"', entry.toString().trimEnd()]) {
    await writeFile(path, Buffer.concat([prefix, Buffer.from(tail)]));
    assert.equal(await journal.nextOrdinal("run-torn"), 4);
    assert.equal(await journal.quarantineCorrupt(), false);
    await journal.done({ runId: "run-torn", ordinal: 4, state: "succeeded", detail: {} });
    assert.equal((await journal.validate()).entries.length, 4);
  }
  await writeFile(path, "", { mode: 0o600 });
  assert.equal((await journal.validate()).entries.length, 0);
  await journal.done({ runId: "empty", ordinal: 1, state: "succeeded", detail: {} });
  assert.equal((await journal.validate()).entries.length, 1);
});

test("journal refuses middle corruption, blank middle lines and parseable forged final entries without changing history", async t => {
  const { root, journal } = await fixture(t);
  await journal.done({ runId: "run-one", ordinal: 1, state: "staged", detail: {} });
  const path = join(root, "updater-state/journal.jsonl"), first = await readFile(path, "utf8");
  for (const middle of ['{"torn"\n', '\n']) {
    const damaged = `${first}${middle}${first}{"tail"`;
    await writeFile(path, damaged);
    await assert.rejects(journal.validate(), /updater_journal_short: invalid JSON on journal line 2/u);
    assert.equal(await readFile(path, "utf8"), damaged);
  }
  const forged = `${first}${JSON.stringify({ schema: "control-room.updater-journal/v1", kind: "done", at: "2000-01-01T00:00:00.000Z", runId: "forged", prevMac: "0".repeat(64), mac: "f".repeat(64) })}\n`;
  await writeFile(path, forged);
  await assert.rejects(journal.validate(), /updater_journal_mac_refused/u);
  await chmod(path, 0o666);
  await assert.rejects(journal.validate(), /updater_journal_owner_refused/u);
});

test("20 SIGKILLs during an actual partial journal write preserve history and resume cleanly", { timeout: 120_000 }, async t => {
  const { root, journal } = await fixture(t);
  await journal.done({ runId: "crash", ordinal: 1, state: "staged", detail: {} });
  for (let round = 0; round < 20; round += 1) {
    const child = spawn(process.execPath, ["tests/helpers/updater-journal-torn-child.mjs", root, String(round + 2), String(round)],
      { stdio: ["pipe", "ignore", "pipe", "ipc"], env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
    let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("write checkpoint timeout")), 5000);
        child.once("error", reject);
        child.once("message", message => message === "partial-write" ? resolve() : reject(new Error(String(message))));
        child.once("exit", () => reject(new Error(`child exited before write: ${stderr}`)));
      });
      child.kill("SIGKILL");
      assert.equal((await closed).signal, "SIGKILL");
    } finally {
      clearTimeout(timer); child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    const resumed = new FileStepJournalV1(root, { ownerUid: process.getuid() });
    assert.equal(await resumed.nextOrdinal("crash"), round + 2);
    await resumed.done({ runId: "crash", ordinal: round + 2, state: "staged", detail: {} });
    assert.equal((await resumed.validate()).entries.length, round + 2);
  }
});

test("50 independent appenders repair a tail and serialize one valid chain and refusals aggregate once per plan and hour", async t => {
  const { root, journal } = await fixture(t);
  await journal.done({ runId: "before-burst", ordinal: 1, state: "staged", detail: {} });
  const path = join(root, "updater-state/journal.jsonl"), prefix = await readFile(path);
  await writeFile(path, Buffer.concat([prefix, Buffer.from('{"torn"')]));
  await Promise.all(Array.from({ length: 50 }, (_, index) => new FileStepJournalV1(root, { ownerUid: process.getuid() }).done({ runId: `run-${index}`, ordinal: 1,
    state: "succeeded", detail: { index } })));
  const before = await journal.validate(); assert.equal(before.entries.length, 51);
  const aggregate = new RefusalAggregatorV1(journal, { clock: () => new Date("2026-09-30T12:34:00.000Z") });
  for (let index = 0; index < 50; index += 1) aggregate.add("plan-aggregate", "approval_refused");
  assert.equal(await aggregate.flush(), 1);
  const refusal = (await journal.validate()).entries.at(-1);
  assert.deepEqual({ kind: refusal.kind, count: refusal.count, hour: refusal.hour },
    { kind: "refusal_summary", count: 50, hour: "2026-09-30T12" });
});

test("append and compaction disk-full/crash points retain a valid old authority or recover a complete replacement", async t => {
  const failed = await fixture(t, { checkpoint: async point => { if (point === "append_before_write") {
    const error = new Error("full"); error.code = "ENOSPC"; throw error;
  } } });
  await assert.rejects(failed.journal.done({ runId: "run-full", ordinal: 1, state: "succeeded", detail: {} }), /full/u);
  assert.equal((await failed.journal.validate()).entries.length, 0);

  const { root, journal } = await fixture(t);
  const old = "2000-01-01T00:00:00.000Z", payload = "x".repeat(14_000);
  for (let index = 0; index < 76; index += 1) await journal.done({ runId: `old-run-${index}`, ordinal: 1,
    state: "succeeded", at: old, detail: { payload } });
  assert.ok((await journal.validate()).bytes > 1024 * 1024);
  const original = await readFile(join(root, "updater-state/journal.jsonl"), "utf8");
  for (const point of ["compact_before_temp", "compact_before_temp_sync", "compact_after_temp_sync", "compact_after_marker", "compact_after_rename"]) {
    const crash = async seen => { if (seen === point) { const error = new Error(`crash-${point}`); error.code = "EIO"; throw error; } };
    await assert.rejects(journal.compact({ checkpoint: crash }), /crash-/u);
    const temporary = (await readdir(join(root, "updater-state"))).find(name => /^journal\.compact\.[0-9a-f]{32}$/u.test(name));
    if (temporary) {
      const candidate = await readFile(join(root, "updater-state", temporary), "utf8");
      const corrupt = point === "compact_after_marker"
        ? candidate.replace('"state":"succeeded"', '"state":"refused"') : "corrupt\n";
      await writeFile(join(root, "updater-state", temporary), corrupt, { mode: 0o600 });
    }
    await journal.recoverCompaction();
    if (point === "compact_after_rename") assert.ok((await journal.validate()).entries.length > 0, point);
    else assert.equal(await readFile(join(root, "updater-state/journal.jsonl"), "utf8"), original,
      `${point} retains the old authority when its replacement is corrupt`);
    await writeFile(join(root, "updater-state/journal.jsonl"), original, { mode: 0o600 });
    for (const name of await readdir(join(root, "updater-state")))
      if (/^journal\.compact\.[0-9a-f]{32}$/u.test(name)) await rm(join(root, "updater-state", name), { force: true });
  }
  // A replacement is an atomic snapshot: a torn final line cannot be adopted
  // even though an append journal would keep its complete prefix.
  await assert.rejects(journal.compact({ checkpoint: async point => {
    if (point === "compact_after_marker") throw new Error("torn-replacement");
  } }), /torn-replacement/u);
  const pending = (await readdir(join(root, "updater-state"))).find(name => /^journal\.compact\.[0-9a-f]{32}$/u.test(name));
  const candidatePath = join(root, "updater-state", pending), candidate = await readFile(candidatePath);
  await writeFile(candidatePath, candidate.subarray(0, candidate.length - 10));
  assert.equal(await journal.recoverCompaction(), false);
  assert.equal(await readFile(join(root, "updater-state/journal.jsonl"), "utf8"), original);
  // A marker is cleaned after each recovery; compaction remains possible and shrinks the authority.
  const result = await journal.compact(); assert.equal(result.compacted, true);
  assert.ok((await journal.validate()).bytes < 100_000);
  assert.equal(root.includes("/Library/"), false);
});

test("tail repair refuses an inode replacement and leaves the replacement untouched", async t => {
  const { root, journal } = await fixture(t);
  await journal.done({ runId: "identity", ordinal: 1, state: "staged", detail: {} });
  const path = join(root, "updater-state/journal.jsonl"), prefix = await readFile(path);
  await writeFile(path, Buffer.concat([prefix, Buffer.from('{"torn"')]));
  const sentinel = "replacement must remain untouched";
  const repair = new FileStepJournalV1(root, { ownerUid: process.getuid(), checkpoint: async point => {
    if (point === "journal_tail_before_repair") {
      await (await import("node:fs/promises")).rename(path, `${path}.old`);
      await writeFile(path, sentinel, { mode: 0o600 });
    }
  } });
  await assert.rejects(repair.validate(), /updater_journal_owner_refused/u);
  assert.equal(await readFile(path, "utf8"), sentinel);
});

test("shared journal framing bounds complete lines and requires intact compaction replacements", async () => {
  const { readJsonlPrefixV1 } = await import("../src/installer/shared/jsonl-prefix.mjs");
  const refuse = reason => { throw new Error(reason); };
  assert.throws(() => readJsonlPrefixV1('{"large":true}\n', { maxLineBytes: 2, refuse }), /too large/u);
  assert.throws(() => readJsonlPrefixV1('{"valid":true}', { recoverTail: false, refuse }), /no newline/u);
  assert.throws(() => readJsonlPrefixV1('{"torn"\n', { recoverTail: false, refuse }), /invalid JSON/u);
  assert.deepEqual(readJsonlPrefixV1('', { recoverTail: false, refuse }).values, []);
});

test("R7J-02: oversized complete middle and final lines retain the line refusal and quarantine behaviour", async t => {
  const { root, journal } = await fixture(t);
  await journal.done({ runId: "line-size", ordinal: 1, state: "staged", detail: {} });
  const path = join(root, "updater-state/journal.jsonl"), prefix = await readFile(path, "utf8");
  const oversized = `${JSON.stringify({ payload: "x".repeat(16_384) })}\n`;
  for (const suffix of ["", prefix]) {
    const damaged = prefix + oversized + suffix;
    await writeFile(path, damaged, { mode: 0o600 });
    await assert.rejects(journal.validate(), { code: "updater_journal_line_refused" });
    assert.equal(await readFile(path, "utf8"), damaged);
    assert.equal(await journal.quarantineCorrupt(), true);
    const files = await readdir(join(root, "updater-state"));
    const poisoned = files.find(name => name.startsWith("journal.jsonl.poisoned-"));
    assert.ok(poisoned);
    assert.equal(await readFile(join(root, "updater-state", poisoned), "utf8"), damaged);
    await rm(join(root, "updater-state", poisoned));
  }
});
