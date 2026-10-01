import assert from "node:assert/strict";
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

test("journal rejects every torn boundary sampled from a complete append and a forged local-bot line", async t => {
  const { root, journal } = await fixture(t);
  await journal.done({ runId: "run-torn", ordinal: 1, state: "succeeded", detail: { message: "complete" } });
  const complete = await readFile(join(root, "updater-state/journal.jsonl"), "utf8");
  const line = complete.trimEnd();
  await writeFile(join(root, "updater-state/journal.jsonl"), `${line} `, { mode: 0o600 });
  await assert.rejects(journal.validate(), /updater_journal_short/u,
    "a complete line with a trailing non-newline byte is torn, not an accepted JSON value");
  // Every byte boundary of this realistic line exercises a kill during append.
  for (let cut = 1; cut < Buffer.byteLength(line); cut += 1) {
    await writeFile(join(root, "updater-state/journal.jsonl"), Buffer.from(line).subarray(0, cut), { mode: 0o600 });
    await assert.rejects(journal.validate(), /updater_journal_(short|line_refused|mac_refused)/u, `cut ${cut}`);
  }
  await writeFile(join(root, "updater-state/journal.jsonl"), `${complete}${JSON.stringify({ schema: "control-room.updater-journal/v1", kind: "done", at: "2000-01-01T00:00:00.000Z", runId: "forged", prevMac: "0".repeat(64), mac: "f".repeat(64) })}\n`, { mode: 0o600 });
  await assert.rejects(journal.validate(), /updater_journal_mac_refused/u);
  await chmod(join(root, "updater-state/journal.jsonl"), 0o666);
  await assert.rejects(journal.validate(), /updater_journal_owner_refused/u);
});

test("50 concurrent appenders serialize one valid chain and refusals aggregate once per plan and hour", async t => {
  const { journal } = await fixture(t);
  await Promise.all(Array.from({ length: 50 }, (_, index) => journal.done({ runId: `run-${index}`, ordinal: 1,
    state: "succeeded", detail: { index } })));
  const before = await journal.validate(); assert.equal(before.entries.length, 50);
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
  // A marker is cleaned after each recovery; compaction remains possible and shrinks the authority.
  const result = await journal.compact(); assert.equal(result.compacted, true);
  assert.ok((await journal.validate()).bytes < 100_000);
  assert.equal(root.includes("/Library/"), false);
});
