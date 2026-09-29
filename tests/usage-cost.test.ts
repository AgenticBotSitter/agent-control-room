import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseCodexJsonLineV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createClaudeCodeStreamDecoderV1 } from "../src/harness/claude-code-v1/stream-json-decode";
import { parseHermesTerminalUsageV1 } from "../src/harness/hermes-local-v1/owner-trusted-local-exec";
import { costForUsageV1, rollupUsageGroupsV1, usagePriceTableSchemaV1, type UsagePriceTableV1 } from "../src/usage/v1/usage-cost";

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
  // The per-run oracle this suite has always asserted against, written out here
  // rather than imported: the production rollup no longer takes per-run values
  // (it takes the SQL aggregate's groups), so the ORIGINAL definition is kept
  // as the independent statement of what "the totals are exact" means.
  const perRun = (values: readonly { usage: { inputTokens: number | null; outputTokens: number | null;
    totalTokens: number | null; wallTimeMs: number | null }; cost: { kind: string; nanoUsd?: string;
    reason?: string } }[]) => {
    const exact = (field: "inputTokens" | "outputTokens" | "totalTokens" | "wallTimeMs") =>
      values.every(value => value.usage[field] !== null) ? values.reduce((sum, value) => sum + value.usage[field]!, 0) : null;
    return { runs: values.length, inputTokens: exact("inputTokens"), outputTokens: exact("outputTokens"),
      totalTokens: exact("totalTokens"), wallTimeMs: exact("wallTimeMs"),
      knownCostNanoUsd: values.reduce((sum, value) => sum + (value.cost.kind === "known" ? BigInt(value.cost.nanoUsd!) : BigInt(0)), BigInt(0)).toString(),
      knownCostRuns: values.filter(value => value.cost.kind === "known").length,
      subscriptionRuns: values.filter(value => value.cost.kind === "included_in_subscription").length,
      unknownCostRuns: values.filter(value => value.cost.kind === "unknown").length,
      unknownCostReasons: [...new Set(values.flatMap(value => value.cost.kind === "unknown" ? [value.cost.reason!] : []))].sort() };
  };
  assert.deepEqual(perRun([priced, included, unknown]), { runs: 3, inputTokens: null, outputTokens: null,
    totalTokens: null, wallTimeMs: 1750, knownCostNanoUsd: "325000", knownCostRuns: 1,
    subscriptionRuns: 1, unknownCostRuns: 1, unknownCostReasons: ["usage_not_reported"] });

  // The same three runs, expressed the way PostgreSQL aggregates them: one group
  // per distinct pricing shape. The priced Codex run is alone in its group, so
  // its token sums are its own tokens.
  const groups = [
    { harness: "codex" as const, model: "gpt-fixture", runs: 1, inputTokens: "100", billableInputTokens: "100",
      outputTokens: "20", totalTokens: "120", wallTimeMs: "1000", cachedInputTokens: "0", negativeBillableRuns: 0 },
    { harness: "claude" as const, model: "sonnet-fixture", runs: 1, inputTokens: "80", billableInputTokens: "80",
      outputTokens: "20", totalTokens: "100", wallTimeMs: "500", cachedInputTokens: "0", negativeBillableRuns: 0 },
    // A priced model whose runs reported no tokens: the reason is
    // `usage_not_reported`, and it only survives here because the model's price
    // entry exists. A group with no model at all refuses earlier, at
    // `model_not_recorded`, which `no group of runs loses its price reason`
    // below pins separately.
    { harness: "codex" as const, model: "gpt-fixture", runs: 1, inputTokens: null, billableInputTokens: null,
      outputTokens: null, totalTokens: null, wallTimeMs: "250", cachedInputTokens: "0", negativeBillableRuns: 0 },
  ];
  assert.deepEqual(rollupUsageGroupsV1(groups, table), perRun([priced, included, unknown]),
    "the SQL aggregate rollup must equal the sum of the individual runs it replaces");

  // The refusal ORDER is the per-run path's, so a group that cannot name a price
  // says so rather than reporting a token problem it never had.
  assert.deepEqual(rollupUsageGroupsV1([{ harness: "codex", model: null, runs: 1, inputTokens: null,
    billableInputTokens: null, outputTokens: null, totalTokens: null, wallTimeMs: "250",
    cachedInputTokens: "0", negativeBillableRuns: 0 }], table).unknownCostReasons, ["model_not_recorded"]);
  assert.deepEqual(rollupUsageGroupsV1([{ harness: "codex", model: "gpt-fixture", runs: 1, inputTokens: null,
    billableInputTokens: null, outputTokens: null, totalTokens: null, wallTimeMs: "250",
    cachedInputTokens: "0", negativeBillableRuns: 0 }], undefined).unknownCostReasons, ["price_table_not_recorded"]);
});

test("a group of runs sharing one pricing shape is priced from its sums, not an average", () => {
  // Three identical-branched Codex runs on a cache-priced model. The group is
  // exact only because the cost is linear in the sums: 3 × (1000 in, 500 out)
  // with 900 cached per run is 3 × (100 in × 1000 + 500 out × 2000 + 900 cached × 100).
  const cost = costForUsageV1({ harness: "codex", model: "gpt-cache-priced",
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cachedInputTokens: 900, wallTimeMs: 10 },
    priceTable: table });
  assert.deepEqual(cost, { kind: "known", nanoUsd: (100 * 1000 + 500 * 2000 + 900 * 100).toString(),
    priceEntryId: "codex-cache-priced", tableId: table.tableId });
  const single = rollupUsageGroupsV1([{ harness: "codex", model: "gpt-cache-priced", runs: 1,
    inputTokens: "1000", billableInputTokens: "100", outputTokens: "500", totalTokens: "1500", wallTimeMs: "10",
    cachedInputTokens: "900", negativeBillableRuns: 0 }], table);
  const tripled = rollupUsageGroupsV1([{ harness: "codex", model: "gpt-cache-priced", runs: 3,
    inputTokens: "3000", billableInputTokens: "300", outputTokens: "1500", totalTokens: "4500", wallTimeMs: "30",
    cachedInputTokens: "2700", negativeBillableRuns: 0 }], table);
  assert.equal(tripled.knownCostNanoUsd, (BigInt(cost.nanoUsd) * BigInt(3)).toString(),
    "three runs in one group must cost three times one, from the summed tokens");
  assert.equal(tripled.knownCostRuns, 3);
  assert.equal(tripled.runs, 3);
  assert.equal(single.knownCostNanoUsd, cost.nanoUsd);
});

test("a group holding one Codex run with more cached tokens than input refuses, as the per-run path does", () => {
  // Codex reports cached tokens as a SUBSET of input, so cached > input is a
  // contradiction and the per-run path returns partial_token_usage. The group's
  // SUM is still positive, so without the negative-run count carried alongside
  // the aggregate would report a confident `known` figure for a contradiction.
  const group = { harness: "codex" as const, model: "gpt-cache-priced", runs: 2,
    inputTokens: "3100", billableInputTokens: "1500", outputTokens: "1000", totalTokens: "2500", wallTimeMs: "20",
    cachedInputTokens: "1600", negativeBillableRuns: 1 };
  // The token TOTALS are still displayed — the per-run rollup showed them for a
  // refused run too — so what must change is the cost: unknown, zero, and named.
  const refused = rollupUsageGroupsV1([group], table);
  assert.deepEqual(refused, { runs: 2, inputTokens: 3100, outputTokens: 1000, totalTokens: 2500,
    wallTimeMs: 20, knownCostNanoUsd: "0", knownCostRuns: 0, subscriptionRuns: 0, unknownCostRuns: 2,
    unknownCostReasons: ["partial_token_usage"] });
  // With the count absent (the un-flagged mutation) it prices instead, which is
  // the exact regression this count exists to prevent.
  assert.equal(rollupUsageGroupsV1([{ ...group, negativeBillableRuns: 0 }], table).knownCostRuns, 2);
});

test("cache tokens without a recorded cache price stay unknown in a group", () => {
  const rollup = rollupUsageGroupsV1([{ harness: "codex", model: "gpt-cache-unpriced", runs: 2,
    inputTokens: "2000", billableInputTokens: "200", outputTokens: "200", totalTokens: "400", wallTimeMs: "20",
    cachedInputTokens: "1800", negativeBillableRuns: 0 }], table);
  assert.deepEqual(rollup.unknownCostReasons, ["cache_pricing_not_recorded"]);
  assert.equal(rollup.unknownCostRuns, 2);
  assert.equal(rollup.knownCostRuns, 0);
});

test("no groups rolls up to zeros, exactly as no runs did", () => {
  assert.deepEqual(rollupUsageGroupsV1([], table), { runs: 0, inputTokens: 0, outputTokens: 0,
    totalTokens: 0, wallTimeMs: 0, knownCostNanoUsd: "0", knownCostRuns: 0, subscriptionRuns: 0,
    unknownCostRuns: 0, unknownCostReasons: [] });
});

test("a field reported by some runs in scope is not presented as a total", () => {
  // One group measured, one that reported nothing: the whole rollup is
  // `null` for that field rather than the sum of the runs that happened to
  // answer — the same `every()` rule the per-run rollup used.
  const rollup = rollupUsageGroupsV1([
    { harness: "codex", model: "gpt-fixture", runs: 3, inputTokens: "300", billableInputTokens: "300",
      outputTokens: "60", totalTokens: "360", wallTimeMs: "30", cachedInputTokens: "0", negativeBillableRuns: 0 },
    { harness: "codex", model: "gpt-fixture", runs: 1, inputTokens: null, billableInputTokens: null,
      outputTokens: null, totalTokens: null, wallTimeMs: "10", cachedInputTokens: "0", negativeBillableRuns: 0 },
  ], table);
  assert.equal(rollup.runs, 4);
  assert.equal(rollup.inputTokens, null);
  assert.equal(rollup.outputTokens, null);
  assert.equal(rollup.totalTokens, null);
  assert.equal(rollup.wallTimeMs, 40, "the one field every run answered is still exact");
  assert.equal(rollup.knownCostRuns, 3);
  assert.deepEqual(rollup.unknownCostReasons, ["usage_not_reported"]);
});
