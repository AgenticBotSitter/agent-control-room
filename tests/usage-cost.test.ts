import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseCodexJsonLineV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createClaudeCodeStreamDecoderV1 } from "../src/harness/claude-code-v1/stream-json-decode";
import { parseHermesTerminalUsageV1 } from "../src/harness/hermes-local-v1/owner-trusted-local-exec";
import { costForUsageV1, rollupUsageV1, type UsagePriceTableV1 } from "../src/usage/v1/usage-cost";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "usage", name), "utf8");
const table: UsagePriceTableV1 = { schema: "control-room.usage-price-table/v1", tableId: "owner-prices-2026-09",
  recordedAt: "2026-09-28T00:00:00.000Z", entries: [
    { entryId: "codex-token-price", harness: "codex", model: "gpt-fixture",
      billing: { kind: "token", inputNanoUsdPerToken: "1250", outputNanoUsdPerToken: "10000" } },
    { entryId: "claude-subscription", harness: "claude", model: "sonnet-fixture", billing: { kind: "subscription" } },
  ] };

test("fixture captures parse Codex, Claude and Hermes usage, including missing usage", async () => {
  const codex = (await fixture("codex-turn-completed.jsonl")).trim().split("\n").map(parseCodexJsonLineV1);
  assert.deepEqual(codex.at(-1), { kind: "complete", usage: { inputTokens: 120, outputTokens: 30 } });
  const codexMissing = (await fixture("codex-turn-completed-missing-usage.jsonl")).trim().split("\n").map(parseCodexJsonLineV1);
  assert.deepEqual(codexMissing.at(-1), { kind: "complete" });

  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-00000000ac01" });
  const claude = createClaudeCodeStreamDecoderV1(); claude.accept(init);
  const claudeResult = claude.accept((await fixture("claude-result.json")).trim());
  assert.equal(claudeResult.kind, "result");
  if (claudeResult.kind === "result") assert.deepEqual(claudeResult.usage, { inputTokens: 80, outputTokens: 20, totalTokens: 100 });
  const missing = createClaudeCodeStreamDecoderV1(); missing.accept(init);
  const missingResult = missing.accept((await fixture("claude-result-missing-usage.json")).trim());
  assert.equal(missingResult.kind === "result" && missingResult.usage, undefined);

  assert.deepEqual(parseHermesTerminalUsageV1(JSON.parse(await fixture("hermes-result.json"))),
    { inputTokens: 50, outputTokens: 10, totalTokens: 60, durationMs: 1250 });
  const hermesMissing = JSON.parse(await fixture("hermes-result-missing-usage.json"));
  assert.throws(() => parseHermesTerminalUsageV1(hermesMissing));
});

test("cost requires an owner-recorded matching price and distinguishes subscriptions", () => {
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, wallTimeMs: 1000 };
  assert.deepEqual(costForUsageV1({ harness: "codex", model: "gpt-fixture", usage, priceTable: table }),
    { kind: "known", nanoUsd: "325000", priceEntryId: "codex-token-price", tableId: "owner-prices-2026-09" });
  assert.deepEqual(costForUsageV1({ harness: "claude", model: "sonnet-fixture", usage, priceTable: table }),
    { kind: "included_in_subscription", priceEntryId: "claude-subscription", tableId: "owner-prices-2026-09" });
  assert.deepEqual(costForUsageV1({ harness: "claude", model: "sonnet-fixture", usage: null, priceTable: table }),
    { kind: "included_in_subscription", priceEntryId: "claude-subscription", tableId: "owner-prices-2026-09" });
  assert.deepEqual(costForUsageV1({ harness: "hermes", model: "local-fixture", usage, priceTable: table }),
    { kind: "unknown", reason: "price_entry_not_recorded" });
  assert.deepEqual(costForUsageV1({ harness: "codex", model: "gpt-fixture", usage }),
    { kind: "unknown", reason: "price_table_not_recorded" });
});

test("rollups are exact and preserve priced, subscription and unknown run counts", () => {
  const priced = { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, wallTimeMs: 1000 },
    cost: { kind: "known" as const, nanoUsd: "325000", priceEntryId: "codex-token-price", tableId: table.tableId } };
  const included = { usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, wallTimeMs: 500 },
    cost: { kind: "included_in_subscription" as const, priceEntryId: "claude-subscription", tableId: table.tableId } };
  const unknown = { usage: { inputTokens: null, outputTokens: null, totalTokens: null, wallTimeMs: 250 },
    cost: { kind: "unknown" as const, reason: "usage_not_reported" as const } };
  assert.deepEqual(rollupUsageV1([priced, included, unknown]), { runs: 3, inputTokens: null, outputTokens: null,
    totalTokens: null, wallTimeMs: 1750, knownCostNanoUsd: "325000", knownCostRuns: 1,
    subscriptionRuns: 1, unknownCostRuns: 1, unknownCostReasons: ["usage_not_reported"] });
});
