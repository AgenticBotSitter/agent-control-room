import assert from "node:assert/strict";
import test from "node:test";
import { parseReportedModel, readModelOutcomes, renderModelOutcomes, summarizeModelOutcomes } from "../scripts/public-model-outcomes.mjs";

const body = (model, effort = "medium") => `Control-Room-Issue: 10\nWorker-Model: ${model}\nWorker-Effort: ${effort}`;
const correction = head => ({ body: `CHANGES REQUIRED at exact head ${head}.` });

test("model and effort require exactly one bounded report", () => {
  assert.deepEqual(parseReportedModel(body("OpenAI/Sol", "high")), { model: "OpenAI/Sol", effort: "high", valid: true });
  assert.equal(parseReportedModel("Worker-Model: A\nWorker-Model: B\nWorker-Effort: high").model, "unreported");
  assert.deepEqual(parseReportedModel("Worker-Model: A\nWorker-Effort: enormous"), { model: "A", effort: "unknown", valid: false });
});

test("outcomes count unique corrected heads and keep open work distinct", () => {
  const head = "a".repeat(40);
  const rows = summarizeModelOutcomes([
    { body: body("OpenAI/Sol", "high"), merged: true, state: "closed", comments: [] },
    { body: body("OpenAI/Sol", "high"), merged: true, state: "closed", comments: [correction(head), correction(head)] },
    { body: body("Anthropic/Opus", "medium"), merged: false, state: "open", comments: [correction("b".repeat(40))] },
  ]);
  assert.deepEqual(rows[0], { model: "OpenAI/Sol", effort: "high", submissions: 2, merged: 2, open: 0,
    closedWithoutMerge: 0, correctionRequested: 1, correctionRounds: 1, firstPassMerges: 1,
    invalidOrMissingReport: 0, mergeRate: 1, correctionRate: 0.5 });
  assert.equal(rows[1].open, 1);
});

test("GitHub read is bounded, read-only and renders its limits honestly", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const values = url.includes("/pulls?")
      ? [{ number: 1, body: body("OpenAI/Terra"), state: "closed", merged_at: "now" }] : [];
    return { ok: true, status: 200, async json() { return structuredClone(values); } };
  };
  const report = await readModelOutcomes({ repository: "owner/repo", fetchImpl });
  assert.equal(report.rows[0].merged, 1);
  assert.ok(calls.every(call => !call.options.method || call.options.method === "GET"));
  assert.match(renderModelOutcomes(report), /self-reported/i);
  assert.match(renderModelOutcomes(report), /not a general model-quality ranking/i);
});

test("issue-side correction records are attributed to the pull request model", async () => {
  const issueUrl = "https://api.github.com/repos/owner/repo/issues/10";
  const fetchImpl = async url => ({ ok: true, status: 200, async json() {
    if (url.includes("/pulls?")) return [{ number: 7, body: body("OpenAI/Astra", "xhigh"), state: "open",
      merged_at: null }];
    return [{ ...correction("c".repeat(40)), issue_url: issueUrl }];
  } });
  const report = await readModelOutcomes({ repository: "owner/repo", fetchImpl });
  assert.equal(report.rows[0].correctionRequested, 1);
  assert.equal(report.rows[0].correctionRounds, 1);
});
