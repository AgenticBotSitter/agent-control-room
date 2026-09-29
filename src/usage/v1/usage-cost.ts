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
   * still parses; treated as 0 wherever absent. */
  cachedInputTokens: count.nullable().optional() }).strict().superRefine((value, context) => {
  if (value.totalTokens !== null && value.inputTokens !== null && value.outputTokens !== null
    && value.totalTokens < value.inputTokens + value.outputTokens)
    context.addIssue({ code: "custom", message: "total tokens cannot be smaller than input plus output" });
});
export type UsageMeasurementV1 = z.infer<typeof usageMeasurementSchemaV1>;

export type UsageCostUnknownReasonV1 = "usage_not_reported" | "model_not_recorded" | "price_table_not_recorded"
  | "price_entry_not_recorded" | "partial_token_usage" | "cache_pricing_not_recorded";
export type UsageCostV1 = Readonly<
  | { kind: "known"; nanoUsd: string; priceEntryId: string; tableId: string }
  | { kind: "included_in_subscription"; priceEntryId: string; tableId: string }
  | { kind: "unknown"; reason: UsageCostUnknownReasonV1 }
>;

export function costForUsageV1(input: Readonly<{ harness: "codex" | "claude" | "hermes" | "other";
  model?: string; usage: UsageMeasurementV1 | null; priceTable?: UsagePriceTableV1 }>): UsageCostV1 {
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
  const cachedInputTokens = input.usage.cachedInputTokens ?? 0;
  // Never guess a discount: any recorded cache usage requires an explicit
  // owner-set cache price before a "known" figure is produced.
  if (cachedInputTokens > 0 && entry.billing.cachedInputNanoUsdPerToken === undefined)
    return { kind: "unknown", reason: "cache_pricing_not_recorded" };
  // Codex reports `cachedInputTokens` as a subset of `inputTokens`; Claude and
  // Hermes report it as additional usage. Only Codex's full input count needs
  // the cached portion removed before applying the full input rate.
  const billableInputTokens = input.harness === "codex" ? input.usage.inputTokens - cachedInputTokens : input.usage.inputTokens;
  if (billableInputTokens < 0) return { kind: "unknown", reason: "partial_token_usage" };
  const value = BigInt(billableInputTokens) * BigInt(entry.billing.inputNanoUsdPerToken)
    + BigInt(input.usage.outputTokens) * BigInt(entry.billing.outputNanoUsdPerToken)
    + BigInt(cachedInputTokens) * BigInt(entry.billing.cachedInputNanoUsdPerToken ?? "0");
  return { kind: "known", nanoUsd: value.toString(), priceEntryId: entry.entryId, tableId: table.tableId };
}

export type UsageRollupV1 = Readonly<{ runs: number; inputTokens: number | null; outputTokens: number | null;
  totalTokens: number | null; wallTimeMs: number | null; knownCostNanoUsd: string; knownCostRuns: number;
  subscriptionRuns: number; unknownCostRuns: number; unknownCostReasons: readonly UsageCostUnknownReasonV1[] }>;

export function rollupUsageV1(values: readonly Readonly<{ usage: UsageMeasurementV1 | null; cost: UsageCostV1 }>[]): UsageRollupV1 {
  const exact = (field: keyof UsageMeasurementV1) => values.every(value => value.usage?.[field] !== null && value.usage?.[field] !== undefined)
    ? values.reduce((sum, value) => sum + (value.usage![field] as number), 0) : null;
  const reasons = [...new Set(values.flatMap(value => value.cost.kind === "unknown" ? [value.cost.reason] : []))].sort();
  return Object.freeze({ runs: values.length, inputTokens: exact("inputTokens"), outputTokens: exact("outputTokens"),
    totalTokens: exact("totalTokens"), wallTimeMs: exact("wallTimeMs"),
    knownCostNanoUsd: values.reduce((sum, value) => sum + (value.cost.kind === "known" ? BigInt(value.cost.nanoUsd) : BigInt(0)), BigInt(0)).toString(),
    knownCostRuns: values.filter(value => value.cost.kind === "known").length,
    subscriptionRuns: values.filter(value => value.cost.kind === "included_in_subscription").length,
    unknownCostRuns: values.filter(value => value.cost.kind === "unknown").length,
    unknownCostReasons: reasons });
}

export function formatNanoUsdV1(value: string): string {
  const raw = BigInt(nanoUsd.parse(value)).toString().padStart(10, "0");
  const dollars = raw.slice(0, -9), fraction = raw.slice(-9).replace(/0+$/u, "");
  return `$${dollars}${fraction ? `.${fraction}` : ""}`;
}
