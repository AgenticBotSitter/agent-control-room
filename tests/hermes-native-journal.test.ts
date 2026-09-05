import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteNativeRunJournal } from "../src/harness/hermes-native-v1/run-journal.ts";
import { binding, digest, instant, nativeRunId } from "./hermes-native-fixture.ts";

test("journal reservation is durable and binds one run to one attempt and claim", () => {
  const journal = new SqliteNativeRunJournal(":memory:", { testOnlyAllowEphemeral: true });
  try {
    assert.equal(journal.reserve(binding, instant).created, true);
    assert.equal(journal.reserve(binding, instant + 1).created, false);
    assert.throws(() => journal.reserve({ ...binding, requestDigest: digest("e") }, instant));
    assert.throws(() => journal.reserve({ ...binding, runId: "run:second" }, instant));
    assert.throws(() => journal.reserve({ ...binding, runId: "run:second", attemptId: "attempt:second" }, instant));
    assert.equal(journal.load(binding.runId)?.version, 1);
  } finally { journal.close(); }
});
test("journal compare-and-swap protects immutable native identity and monotonic state", () => {
  const journal = new SqliteNativeRunJournal(":memory:", { testOnlyAllowEphemeral: true });
  try {
    journal.reserve(binding, instant);
    assert.throws(() => journal.update(binding.runId, 1, { state: "running" }));
    journal.update(binding.runId, 1, { state: "dispatching" });
    assert.throws(() => journal.update(binding.runId, 1, { state: "ambiguous" }));
    journal.update(binding.runId, 2, { state: "queued", nativeRunId });
    assert.throws(() => journal.update(binding.runId, 3, { nativeRunId: `run_${"2".repeat(32)}` }));
    journal.update(binding.runId, 3, { streamAttempted: true, stopAttempted: true, state: "stopping" });
    assert.throws(() => journal.update(binding.runId, 4, { streamAttempted: false }));
    assert.throws(() => journal.update(binding.runId, 4, { state: "running" }));
    journal.update(binding.runId, 4, { state: "completed", resultText: "Synthetic output" });
    assert.throws(() => journal.update(binding.runId, 5, { state: "cancelled" }));
    assert.throws(() => journal.update(binding.runId, 5, { resultText: "Changed output" }));
  } finally { journal.close(); }
});
test("a private file journal survives reopen without returning permission to submit", () => {
  const directory = mkdtempSync(join(tmpdir(), "cr14c-journal-")), path = join(directory, "runs.sqlite");
  let journal: SqliteNativeRunJournal | undefined;
  try {
    journal = new SqliteNativeRunJournal(path); journal.reserve(binding, instant);
    journal.update(binding.runId, 1, { state: "dispatching" }); journal.close();
    journal = new SqliteNativeRunJournal(path);
    const recovered = journal.reserve(binding, instant + 100);
    assert.equal(recovered.created, false); assert.equal(recovered.snapshot.state, "dispatching");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { journal?.close(); rmSync(directory, { recursive: true }); }
});
test("journal capacity and explicit private path are required; no automatic pruning", () => {
  assert.throws(() => new SqliteNativeRunJournal(":memory:"));
  assert.throws(() => new SqliteNativeRunJournal("relative.sqlite"));
  const journal = new SqliteNativeRunJournal(":memory:", { testOnlyAllowEphemeral: true, maximumEntries: 1 });
  try {
    journal.reserve(binding, instant);
    assert.throws(() => journal.reserve({ ...binding, runId: "run:second", attemptId: "attempt:second", effectClaimKey: digest("e") }, instant));
  } finally { journal.close(); }
  assert.throws(() => journal.load(binding.runId), /unavailable/);
});
