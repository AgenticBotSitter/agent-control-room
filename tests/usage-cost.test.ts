import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseCodexJsonLineV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createClaudeCodeStreamDecoderV1 } from "../src/harness/claude-code-v1/stream-json-decode";
import { parseHermesTerminalUsageV1 } from "../src/harness/hermes-local-v1/owner-trusted-local-exec";
import { costForUsageV1, rollupUsageV1, usagePriceTableSchemaV1, type UsagePriceTableV1 } from "../src/usage/v1/usage-cost";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "usage", name), "utf8");
const table: UsagePriceTableV1 = { schema: "control-room.usage-price-table/v1", tableId: "owner-prices-2026-09",
  recordedAt: "2026-09-28T00:00:00.000Z", entries: [
    { entryId: "codex-token-price", harness: "codex", model: "gpt-fixture",
      billing: { kind: "token", inputNanoUsdPerToken: "1250", outputNanoUsdPerToken: "10000" } },
    { entryId: "claude-subscription", harness: "claude", model: "sonnet-fixture", billing: { kind: "subscription" } },
    // No cache price recorded for this entry, deliberately: it proves cache
    // tokens are never billed at a guessed discount off the full input rate.
    { entryId: "codex-cache-no-price", harness: "codex", model: "gpt-cache-unpriced",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
    { entryId: "codex-cache-priced", harness: "codex", model: "gpt-cache-priced",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000", cachedInputNanoUsdPerToken: "100" } },
    { entryId: "claude-cache-no-price", harness: "claude", model: "sonnet-cache-unpriced",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000" } },
    { entryId: "claude-cache-priced", harness: "claude", model: "sonnet-cache-priced",
      billing: { kind: "token", inputNanoUsdPerToken: "1000", outputNanoUsdPerToken: "2000", cachedInputNanoUsdPerToken: "50" } },
  ] };

test("fixture captures parse Codex, Claude and Hermes usage, including missing usage", async () => {
  const codex = (await fixture("codex-turn-completed.jsonl")).trim().split("\n").map(parseCodexJsonLineV1);
  assert.deepEqual(codex.at(-1), { kind: "complete", usage: { inputTokens: 120, outputTokens: 30 } });
  const codexMissing = (await fixture("codex-turn-completed-missing-usage.jsonl")).trim().split("\n").map(parseCodexJsonLineV1);
  assert.deepEqual(codexMissing.at(-1), { kind: "complete" });
  // Codex's `cached_input_tokens` is a subset of `input_tokens`, so it is
  // parsed as one extra field alongside the (unchanged) full input count.
  const codexCache = (await fixture("codex-turn-completed-cache.jsonl")).trim().split("\n").map(parseCodexJsonLineV1);
  assert.deepEqual(codexCache.at(-1), { kind: "complete", usage: { inputTokens: 100000, outputTokens: 30, cachedInputTokens: 90000 } });

  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-00000000ac01" });
  const claude = createClaudeCodeStreamDecoderV1(); claude.accept(init);
  const claudeResult = claude.accept((await fixture("claude-result.json")).trim());
  assert.equal(claudeResult.kind, "result");
  if (claudeResult.kind === "result") assert.deepEqual(claudeResult.usage, { inputTokens: 80, outputTokens: 20, totalTokens: 100 });
  const missing = createClaudeCodeStreamDecoderV1(); missing.accept(init);
  const missingResult = missing.accept((await fixture("claude-result-missing-usage.json")).trim());
  assert.equal(missingResult.kind === "result" && missingResult.usage, undefined);
  // Claude's cache-creation and cache-read tokens are additional to
  // `input_tokens`, so they are combined into one `cachedInputTokens` count.
  const withCache = createClaudeCodeStreamDecoderV1(); withCache.accept(init);
  const cacheResult = withCache.accept((await fixture("claude-result-cache.json")).trim());
  assert.equal(cacheResult.kind, "result");
  if (cacheResult.kind === "result") assert.deepEqual(cacheResult.usage,
    { inputTokens: 80, outputTokens: 20, totalTokens: 100, cachedInputTokens: 200000 });

  assert.deepEqual(parseHermesTerminalUsageV1(JSON.parse(await fixture("hermes-result.json"))),
    { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 0, durationMs: 1250 });
  // Hermes reports cache_read and cache_write as additional usage; both are
  // combined into one `cachedInputTokens` count (10000 + 5000 = 15000).
  assert.deepEqual(parseHermesTerminalUsageV1(JSON.parse(await fixture("hermes-result-cache.json"))),
    { inputTokens: 50, outputTokens: 10, totalTokens: 15060, cachedInputTokens: 15_000, durationMs: 1250 });
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

test("cost never guesses a cache discount: unpriced cache tokens are unknown, priced ones are exact", () => {
  // Codex: cachedInputTokens is a SUBSET of inputTokens. 100 input, 90 of
  // which are cached, 20 output.
  const codexUsage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 90, wallTimeMs: 1000 };
  assert.deepEqual(costForUsageV1({ harness: "codex", model: "gpt-cache-unpriced", usage: codexUsage, priceTable: table }),
    { kind: "unknown", reason: "cache_pricing_not_recorded" },
    "a run with cache tokens must never be priced from the full input rate alone");
  assert.deepEqual(costForUsageV1({ harness: "codex", model: "gpt-cache-priced", usage: codexUsage, priceTable: table }),
    // (100 - 90) * 1000 + 20 * 2000 + 90 * 100 = 10000 + 40000 + 9000 = 59000
    { kind: "known", nanoUsd: "59000", priceEntryId: "codex-cache-priced", tableId: table.tableId });
  // A run with no cache tokens at all is unaffected by the unpriced cache entry.
  const codexNoCache = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0, wallTimeMs: 1000 };
  assert.deepEqual(costForUsageV1({ harness: "codex", model: "gpt-cache-unpriced", usage: codexNoCache, priceTable: table }),
    { kind: "known", nanoUsd: "140000", priceEntryId: "codex-cache-no-price", tableId: table.tableId });

  // Claude: cachedInputTokens is ADDITIONAL to inputTokens. 100 input, 20
  // output, 200,000 cache tokens on top.
  const claudeUsage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 200_000, wallTimeMs: 1000 };
  assert.deepEqual(costForUsageV1({ harness: "claude", model: "sonnet-cache-unpriced", usage: claudeUsage, priceTable: table }),
    { kind: "unknown", reason: "cache_pricing_not_recorded" });
  assert.deepEqual(costForUsageV1({ harness: "claude", model: "sonnet-cache-priced", usage: claudeUsage, priceTable: table }),
    // 100 * 1000 + 20 * 2000 + 200000 * 50 = 100000 + 40000 + 10000000 = 10140000
    { kind: "known", nanoUsd: "10140000", priceEntryId: "claude-cache-priced", tableId: table.tableId });
});

test("the model-match guard requires the exact model, not just the harness", () => {
  // Mutation guard for `usage-cost.ts`'s price lookup: if the predicate is
  // ever weakened to `harness === input.harness` alone, a run for a model the
  // owner never priced would silently match this codex entry instead of
  // returning `price_entry_not_recorded`.
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, wallTimeMs: 1000 };
  assert.deepEqual(costForUsageV1({ harness: "codex", model: "a-model-the-owner-never-priced", usage, priceTable: table }),
    { kind: "unknown", reason: "price_entry_not_recorded" });
});

test("a price table entry ID shorter than 3 characters is rejected at load time, never at detail()", () => {
  const short = { schema: "control-room.usage-price-table/v1" as const, tableId: "owner-prices-2026-09",
    recordedAt: "2026-09-28T00:00:00.000Z",
    entries: [{ entryId: "p", harness: "codex" as const, model: "gpt-fixture",
      billing: { kind: "token" as const, inputNanoUsdPerToken: "1250", outputNanoUsdPerToken: "10000" } }] };
  assert.throws(() => usagePriceTableSchemaV1.parse(short), /too_small|String must contain at least/);
  // The wire schema (`task-wire.ts`'s `id`) and this loader schema must agree:
  // an entry ID this short must never make it past the load into a table that
  // `costForUsageV1` and the detail response would otherwise accept.
  assert.throws(() => usagePriceTableSchemaV1.parse({ ...short, tableId: "pp" }));
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
