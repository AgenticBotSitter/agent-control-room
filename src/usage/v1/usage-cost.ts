import { z } from "zod";
import { catalogProjectIdSchema } from "../../web/v1/project-wire";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Shared with the detail wire schema (`task-wire.ts`'s `id`, itself
// `catalogProjectIdSchema`): a price table that passes only this module's own
// loader must never fail the detail read downstream, so both accept and
// reject the exact same entry/table IDs.
const id = catalogProjectIdSchema;
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/);
const nanoUsd = z.string().regex(/^(?:0|[1-9][0-9]*)$/);

export const usagePriceTableSchemaV1 = z.object({
  schema: z.literal("control-room.usage-price-table/v1"), tableId: id, recordedAt: z.string().datetime(),
  entries: z.array(z.object({ entryId: id, harness: z.enum(["codex", "claude", "hermes", "other"]), model,
    billing: z.discriminatedUnion("kind", [z.object({ kind: z.literal("subscription") }).strict(),
      // `cachedInputNanoUsdPerToken` is optional: an owner who never sets it gets
      // `unknown`/`cache_pricing_not_recorded` for any run with cache tokens,
      // never a cost silently computed as if the cache tokens were free.
      z.object({ kind: z.literal("token"), inputNanoUsdPerToken: nanoUsd, outputNanoUsdPerToken: nanoUsd,
        cachedInputNanoUsdPerToken: nanoUsd.optional() }).strict()]) }).strict()).max(256),
}).strict().superRefine((value, context) => {
  if (new Set(value.entries.map(entry => entry.entryId)).size !== value.entries.length)
    context.addIssue({ code: "custom", message: "price entry ids must be unique" });
  if (new Set(value.entries.map(entry => `${entry.harness}\0${entry.model}`)).size !== value.entries.length)
    context.addIssue({ code: "custom", message: "price entry matches must be unique" });
});
export type UsagePriceTableV1 = z.infer<typeof usagePriceTableSchemaV1>;

export const usageMeasurementSchemaV1 = z.object({ inputTokens: count.nullable(), outputTokens: count.nullable(),
  totalTokens: count.nullable(), wallTimeMs: count.nullable(),
  /** Codex: a subset of `inputTokens`, billed at the cache rate instead of the
   * full input rate. Claude/Hermes: additional to `inputTokens`, never a
   * subset. Optional so every existing caller that predates cache tracking
   * still parses; absent or null counts remain unknown. */
  cachedInputTokens: count.nullable().optional() }).strict().superRefine((value, context) => {
  if (value.totalTokens !== null && value.inputTokens !== null && value.outputTokens !== null
    && value.totalTokens < value.inputTokens + value.outputTokens)
    context.addIssue({ code: "custom", message: "total tokens cannot be smaller than input plus output" });
});
export type UsageMeasurementV1 = z.infer<typeof usageMeasurementSchemaV1>;

export type UsageCostUnknownReasonV1 = "usage_not_reported" | "model_not_recorded" | "price_table_not_recorded"
  | "price_entry_not_recorded" | "partial_token_usage" | "cache_pricing_not_recorded" | "cached_usage_not_reported";
export type UsageCostV1 = Readonly<
  | { kind: "known"; nanoUsd: string; priceEntryId: string; tableId: string }
  | { kind: "included_in_subscription"; priceEntryId: string; tableId: string }
  | { kind: "unknown"; reason: UsageCostUnknownReasonV1 }
>;

export type UsagePricingInputV1 = Readonly<{ harness: "codex" | "claude" | "hermes" | "other";
  model?: string; usage: UsageMeasurementV1 | null; priceTable?: UsagePriceTableV1 }>;

/** The branch one measurement prices under and — when it is `known` — the
 * per-token rates that branch bills at. Split from `costForUsageV1` so a group
 * of runs that share a branch can be priced from its token SUMS: the group's
 * figure is `Σ(billableInput)·inputRate + Σ(output)·outputRate +
 * Σ(cached)·cacheRate`, which is exact rather than an average multiplied back
 * by a count. */
export type UsageCostPlanV1 = Readonly<
  | { kind: "known"; inputNanoUsdPerToken: string; outputNanoUsdPerToken: string;
      cachedInputNanoUsdPerToken: string; priceEntryId: string; tableId: string }
  | { kind: "included_in_subscription"; priceEntryId: string; tableId: string }
  | { kind: "unknown"; reason: UsageCostUnknownReasonV1 }
>;

/** Decide which branch a measurement prices under. Never guesses: an absent
 * model, an absent table, an absent entry, missing usage, partial usage,
 * unpriced cache tokens, or a negative billable input count each yield their own
 * named refusal, and this is the only place that decides which. */
export function usageCostPlanV1(input: UsagePricingInputV1): UsageCostPlanV1 {
  if (!input.model) return { kind: "unknown", reason: "model_not_recorded" };
  if (!input.priceTable) return { kind: "unknown", reason: "price_table_not_recorded" };
  const table = usagePriceTableSchemaV1.parse(input.priceTable);
  const entry = table.entries.find(value => value.harness === input.harness && value.model === input.model);
  if (!entry) return { kind: "unknown", reason: "price_entry_not_recorded" };
  if (entry.billing.kind === "subscription") return { kind: "included_in_subscription",
    priceEntryId: entry.entryId, tableId: table.tableId };
  if (!input.usage || input.usage.inputTokens === null && input.usage.outputTokens === null && input.usage.totalTokens === null)
    return { kind: "unknown", reason: "usage_not_reported" };
  if (input.usage.inputTokens === null || input.usage.outputTokens === null)
    return { kind: "unknown", reason: "partial_token_usage" };
  if (input.usage.cachedInputTokens == null) return { kind: "unknown", reason: "cached_usage_not_reported" };
  const cachedInputTokens = input.usage.cachedInputTokens;
  // Never guess a discount: any recorded cache usage requires an explicit
  // owner-set cache price before a "known" figure is produced.
  if (cachedInputTokens > 0 && entry.billing.cachedInputNanoUsdPerToken === undefined)
    return { kind: "unknown", reason: "cache_pricing_not_recorded" };
  // Codex reports `cachedInputTokens` as a subset of `inputTokens`; Claude and
  // Hermes report it as additional usage. Only Codex's full input count needs
  // the cached portion removed before applying the full input rate.
  const billableInputTokens = input.harness === "codex" ? input.usage.inputTokens - cachedInputTokens : input.usage.inputTokens;
  if (billableInputTokens < 0) return { kind: "unknown", reason: "partial_token_usage" };
  return { kind: "known", inputNanoUsdPerToken: entry.billing.inputNanoUsdPerToken,
    outputNanoUsdPerToken: entry.billing.outputNanoUsdPerToken,
    cachedInputNanoUsdPerToken: entry.billing.cachedInputNanoUsdPerToken ?? "0",
    priceEntryId: entry.entryId, tableId: table.tableId };
}

export function costForUsageV1(input: UsagePricingInputV1): UsageCostV1 {
  const plan = usageCostPlanV1(input);
  if (plan.kind !== "known") return plan;
  const usage = input.usage;
  // The known plan has already refused null input, output and cache counts.
  // Keep the existing input/output invariant check; the cache assertion carries
  // the same guarantee into the arithmetic below.
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) throw new Error("usage cost plan mismatch");
  const cachedInputTokens = usage.cachedInputTokens!;
  const billableInputTokens = input.harness === "codex" ? usage.inputTokens - cachedInputTokens : usage.inputTokens;
  const value = BigInt(billableInputTokens) * BigInt(plan.inputNanoUsdPerToken)
    + BigInt(usage.outputTokens) * BigInt(plan.outputNanoUsdPerToken)
    + BigInt(cachedInputTokens) * BigInt(plan.cachedInputNanoUsdPerToken);
  return { kind: "known", nanoUsd: value.toString(), priceEntryId: plan.priceEntryId, tableId: plan.tableId };
}

export type UsageRollupV1 = Readonly<{ runs: number; inputTokens: number | string | null; outputTokens: number | string | null;
  totalTokens: number | string | null; wallTimeMs: number | string | null; knownCostNanoUsd: string; knownCostRuns: number;
  subscriptionRuns: number; unknownCostRuns: number; unknownCostReasons: readonly UsageCostUnknownReasonV1[] }>;

/** One priced group of runs, as PostgreSQL aggregated it.
 *
 * Every run in a group shares the values that decide its pricing BRANCH —
 * harness, model, and the nullness of each token field — so a group is one
 * branch of `usageCostPlanV1`, and the figure for the whole group is the sum of
 * its tokens times that branch's rates. That is what makes the aggregate exact
 * rather than an average multiplied back by a count.
 *
 * Token sums arrive as decimal strings because PostgreSQL returns `sum()` as
 * `numeric`/`bigint`, and money stays `BigInt` end to end.
 */
export interface UsageRollupGroupV1 {
  readonly harness: "codex" | "claude" | "hermes" | "other";
  /** `null` when no run in the group recorded a model selection. */
  readonly model: string | null;
  /** The attempt the group's runs belong to, when the caller asked for
   * per-attempt groups. A project-wide rollup omits it: attempts are retry
   * history and grow without limit, so grouping by them there would make the
   * row count track project age rather than the number of priceable shapes. */
  readonly attemptId?: string;
  readonly runs: number;
  /** `Σ` of the reported input count, displayed verbatim. Distinct from
   * `billableInputTokens` for Codex, whose cached tokens are a subset of its
   * input: the page has always shown the reported count, not the net one. */
  readonly inputTokens: string | null;
  /** `Σ` of the billable input count (Codex nets cached tokens off it), or
   * `null` when every run in the group reported no input count. This is the
   * figure the cost is computed from, never the displayed one. */
  readonly billableInputTokens: string | null;
  readonly outputTokens: string | null;
  readonly totalTokens: string | null;
  readonly wallTimeMs: string | null;
  /** `Σ` of cached tokens, or null when the group has unknown cache usage. */
  readonly cachedInputTokens: string | null;
  /** Runs in this group whose billable input count is negative. Only ever
   * non-zero in a group whose sums would otherwise price as `known`, where it
   * forces the `partial_token_usage` refusal the per-run path returns. */
  readonly negativeBillableRuns: number;
}

/** Roll a set of priced groups up, exactly as summing the individual runs would.
 *
 * Each group is internally uniform in which fields are `null` (that uniformity
 * is the group key), so a field is exact across the rollup precisely when every
 * group carries a sum for it — the same `every()` rule the per-run rollup used,
 * and the same empty-input behaviour: no groups yields `0`, not `null`.
 */
export function rollupUsageGroupsV1(groups: readonly UsageRollupGroupV1[],
  priceTable?: UsagePriceTableV1): UsageRollupV1 {
  let runs = 0, knownCost = BigInt(0), knownCostRuns = 0, subscriptionRuns = 0, unknownCostRuns = 0;
  const sums = { inputTokens: BigInt(0), outputTokens: BigInt(0), totalTokens: BigInt(0), wallTimeMs: BigInt(0) };
  const exact = { inputTokens: true, outputTokens: true, totalTokens: true, wallTimeMs: true };
  const reasons = new Set<UsageCostUnknownReasonV1>();
  for (const group of groups) {
    runs += group.runs;
    // Only NULLNESS and the cached>0 test may reach the plan, so the probe uses
    // sentinel MAGNITUDES: 1 for "reported", 0 for "absent", never the group's
    // own numbers. A sentinel of 0 for input with 1 for cached would make Codex's
    // own netting negative and have the plan refuse for the wrong reason, which
    // would hide the branch this count exists to reach.
    const plan = usageCostPlanV1({ harness: group.harness, ...(group.model === null ? {} : { model: group.model }),
      usage: { inputTokens: group.inputTokens === null ? null : 1,
        outputTokens: group.outputTokens === null ? null : 1,
        totalTokens: group.totalTokens === null ? null : 1,
        wallTimeMs: group.wallTimeMs === null ? null : 1,
        cachedInputTokens: group.cachedInputTokens === null ? null : BigInt(group.cachedInputTokens) > BigInt(0) ? 1 : 0 },
      ...(priceTable ? { priceTable } : {}) });
    if (plan.kind === "unknown") {
      unknownCostRuns += group.runs; reasons.add(plan.reason);
    } else if (plan.kind === "included_in_subscription") {
      subscriptionRuns += group.runs;
    } else if (group.negativeBillableRuns > 0) {
      unknownCostRuns += group.runs; reasons.add("partial_token_usage");
    } else {
      knownCostRuns += group.runs;
      knownCost += BigInt(group.billableInputTokens!) * BigInt(plan.inputNanoUsdPerToken)
        + BigInt(group.outputTokens!) * BigInt(plan.outputNanoUsdPerToken)
        + BigInt(group.cachedInputTokens!) * BigInt(plan.cachedInputNanoUsdPerToken);
    }
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "wallTimeMs"] as const) {
      const value = field === "inputTokens" ? group.inputTokens : group[field];
      if (value === null) { exact[field] = false; continue; }
      if (exact[field]) sums[field] += BigInt(value);
    }
  }
  const count = (field: keyof typeof sums) => !exact[field] ? null
    : sums[field] <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sums[field]) : sums[field].toString();
  return Object.freeze({ runs, inputTokens: count("inputTokens"), outputTokens: count("outputTokens"),
    totalTokens: count("totalTokens"), wallTimeMs: count("wallTimeMs"),
    knownCostNanoUsd: knownCost.toString(), knownCostRuns, subscriptionRuns, unknownCostRuns,
    unknownCostReasons: [...reasons].sort() });
}

export function formatNanoUsdV1(value: string): string {
  const raw = BigInt(nanoUsd.parse(value)).toString().padStart(10, "0");
  const dollars = raw.slice(0, -9), fraction = raw.slice(-9).replace(/0+$/u, "");
  return `$${dollars}${fraction ? `.${fraction}` : ""}`;
}
