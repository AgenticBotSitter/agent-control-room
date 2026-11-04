import { z } from "zod";
import { assertNoSecretMaterial } from "../../security/redaction";
import { WebAccessError } from "./access-verifier";
import { loopProviderRouteSchemaV1 } from "./improve-control-room-loop-adapter";
import { composeLoopSettingsV1, parseLoopSettingsV1 } from "./loop-policy-compose";

const invalid = () => new WebAccessError("invalid_request");
const safeString = z.string().min(1).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).superRefine((value, ctx) => {
  try { assertNoSecretMaterial(value); } catch { ctx.addIssue({ code: "custom", message: "invalid selection value" }); }
});
export const loopSelectionEffortSchemaV1 = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);
export const loopSelectionSlotSchemaV1 = z.object({ model: safeString, route: safeString, effort: loopSelectionEffortSchemaV1 }).strict();
export type LoopSelectionSlotV1 = z.infer<typeof loopSelectionSlotSchemaV1>;
export const loopSelectionSchemaV1 = z.object({
  roles: z.object({ plan: loopSelectionSlotSchemaV1, spec: loopSelectionSlotSchemaV1,
    build: loopSelectionSlotSchemaV1, final: loopSelectionSlotSchemaV1,
    plan_reviews: z.array(loopSelectionSlotSchemaV1).max(3), spec_reviews: z.array(loopSelectionSlotSchemaV1).max(3),
    code_reviews: z.array(loopSelectionSlotSchemaV1).min(1).max(3) }).strict(),
  plan_review_count: z.number().int().min(0).max(3), spec_review_count: z.number().int().min(0).max(3),
  code_review_count: z.number().int().min(1).max(3),
}).strict().superRefine((value, ctx) => {
  for (const role of ["plan", "spec", "code"] as const) {
    if (value[`${role}_review_count`] !== value.roles[`${role}_reviews`].length)
      ctx.addIssue({ code: "custom", path: [`${role}_review_count`], message: "review count mismatch" });
  }
});
export type LoopSelectionV1 = z.infer<typeof loopSelectionSchemaV1>;
/** D01a's stored projection has five keys and derives counts only when picked. */
export const loopSelectionPresetSchemaV1 = z.object({ spec: loopSelectionSlotSchemaV1,
  spec_reviews: z.array(loopSelectionSlotSchemaV1).max(3), build: loopSelectionSlotSchemaV1,
  code_reviews: z.array(loopSelectionSlotSchemaV1).min(1).max(3), final: loopSelectionSlotSchemaV1 }).strict();
export const loopSelectionRunOverridesSchemaV1 = z.object({ reviewFamily: z.boolean().default(false),
  standardFinal: z.boolean().default(false) }).strict();
export type LoopSelectionRunOverridesV1 = z.infer<typeof loopSelectionRunOverridesSchemaV1>;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
export function parseSelectionRunOverridesV1(input: unknown = {}): LoopSelectionRunOverridesV1 {
  return parse(loopSelectionRunOverridesSchemaV1, input);
}
export function encodeSelectionEditsV1(selection: LoopSelectionV1, overrides: Partial<LoopSelectionRunOverridesV1> = {}): string {
  return composeLoopSettingsV1({ defaultsText: "{}", runEdits: JSON.stringify({
    ...parse(loopSelectionSchemaV1, selection), overrides: parseSelectionRunOverridesV1(overrides),
  }) }).text;
}
export function decodeSelectionEditsV1(text: string): { selection: LoopSelectionV1; overrides: LoopSelectionRunOverridesV1 } {
  const value = parseLoopSettingsV1(text);
  assertNoSelectionAuthority(value);
  if (Object.hasOwn(value, "providerRoute")) parse(loopProviderRouteSchemaV1, value.providerRoute);
  // The persisted selection is closed; a P71 run edit may also contain other roles.
  const roles = value.roles;
  const projectedRoles = object(roles) ? Object.fromEntries(
    ["plan", "spec", "build", "final", "plan_reviews", "spec_reviews", "code_reviews"].map(key => [key, roles[key]]),
  ) : roles;
  return { selection: parse(loopSelectionSchemaV1, { roles: projectedRoles, plan_review_count: value.plan_review_count,
    spec_review_count: value.spec_review_count, code_review_count: value.code_review_count }),
  overrides: parseSelectionRunOverridesV1(value.overrides) };
}
const forbiddenAuthority = ["sameFamilyAcknowledgement", "acceptSameFamilyRisk", "consent", "cap", "accepted_at", "by", "run"];
function assertNoSelectionAuthority(value: Record<string, unknown>): void {
  if (forbiddenAuthority.some(key => Object.hasOwn(value, key))) throw invalid();
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** At the P71 consumer boundary, legacy scalar roles retain their old behavior.
 * A count, review array or structured B8 slot opts into the complete B8 codec. */
export function normalizeSelectionRunEditsV1(text: string): string {
  const value = parseLoopSettingsV1(text), roles = value.roles;
  const b8 = ["plan_review_count", "spec_review_count", "code_review_count"].some(key => Object.hasOwn(value, key))
    || object(roles) && (["plan_reviews", "spec_reviews", "code_reviews"].some(key => Object.hasOwn(roles, key))
      || ["plan", "spec", "build", "final"].some(key => object(roles[key])));
  if (!b8 && !Object.hasOwn(value, "overrides")) return text;
  const overrides = b8 ? decodeSelectionEditsV1(text).overrides : parseSelectionRunOverridesV1(value.overrides);
  return composeLoopSettingsV1({ defaultsText: "{}", runEdits: JSON.stringify({ ...value, overrides }) }).text;
}
export function mergeSelectionLayerV1(currentLayerText: string, selection: LoopSelectionV1): string {
  const current = parseLoopSettingsV1(currentLayerText, true), next = parse(loopSelectionSchemaV1, selection);
  assertNoSelectionAuthority(current);
  if (Object.hasOwn(current, "providerRoute")) parse(loopProviderRouteSchemaV1, current.providerRoute);
  if (current.roles !== undefined && !object(current.roles)) throw invalid();
  const merged = { ...current, ...next, roles: { ...(current.roles as Record<string, unknown> | undefined), ...next.roles } };
  // One whole-layer canonical write; providerRoute and non-B8 role members survive.
  return composeLoopSettingsV1({ defaultsText: "{}", selection: JSON.stringify(merged) }).text;
}
export const loopSelectionPreviewBodySchemaV1 = z.object({ selection: loopSelectionSchemaV1,
  overrides: loopSelectionRunOverridesSchemaV1.default({ reviewFamily: false, standardFinal: false }) }).strict();
export type LoopSelectionPreviewBodyV1 = z.input<typeof loopSelectionPreviewBodySchemaV1>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.object({ code: safeString, explanation: safeString }).strict();
export const loopSelectionCheckSchemaV1 = z.object({ eligible: z.boolean(), reasons: z.array(reason).max(100) }).strict()
  .refine(value => value.eligible || value.reasons.length > 0);
const effectiveSlot = loopSelectionSlotSchemaV1.extend({ family: safeString, class: safeString, cost: z.enum(["free", "subscription", "paid"]) }).strict();
const projectedSlot = z.object({ role: z.enum(["plan", "plan_reviews", "spec", "spec_reviews", "build", "code_reviews", "final"]),
  index: z.number().int().min(0).max(2), requested: loopSelectionSlotSchemaV1.extend({
    family: safeString.nullable(), class: safeString.nullable(), cost: z.enum(["free", "subscription", "paid"]).nullable() }).strict(),
  effective: effectiveSlot.nullable(), refusals: z.array(reason).max(100), fallback: z.boolean() }).strict();
/** Product-side projection contract only. The released tools decoder/pin belongs to T-TOOLS. */
export const loopSelectionProjectionSchemaV1 = z.object({ family_policy: z.literal("review-only"),
  lineup: z.array(projectedSlot).min(5).max(13), reservedFinal: effectiveSlot.nullable(), waivedReasons: z.array(reason).max(100),
  rosterDigest: digest, availabilityDigest: digest, lineupDigest: digest }).strict();
export type LoopSelectionProjectionV1 = z.infer<typeof loopSelectionProjectionSchemaV1>;
export const loopSelectionPreviewSchemaV1 = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason }).strict(),
  z.object({ available: z.literal(true), check: loopSelectionCheckSchemaV1, blockers: z.array(reason).max(100),
    settingsSha256: digest, defaultsSha256: digest, layerVersions: z.object({ project: z.number().int().min(0), selection: z.number().int().min(0) }).strict(),
    projection: loopSelectionProjectionSchemaV1, paidExecutionReady: z.literal(false) }).strict(),
]);
export type LoopSelectionPreviewV1 = z.infer<typeof loopSelectionPreviewSchemaV1>;
