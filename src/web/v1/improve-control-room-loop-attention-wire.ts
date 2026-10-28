import { z } from "zod";
import { loopImprovementRequestViewSchemaV1, loopImprovementStatusSchemaV1 } from "../../improve-control-room/v1/schemas";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(180)]);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const loopApprovalDescriptorSchemaV1 = z.object({ step: z.enum(["plan", "spec"]), inputVersion: scalar,
  head: z.string().regex(/^[a-f0-9]{40}$/), reportSha256: hash }).strict();
const blockedCode = z.enum(["QUESTION_LIMIT", "INPUT_CHANGED", "UNAVAILABLE"]);
function questionFits(text: string) {
  let bytes = 0;
  for (const character of JSON.stringify(text)) { const code = character.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
  return bytes <= 12288;
}
export const loopDecisionGateSchemaV1 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm") }).strict(), z.object({ kind: z.literal("approve") }).strict(),
  z.object({ kind: z.literal("question"), text: z.string().refine(questionFits).nullable() }).strict(),
  z.object({ kind: z.literal("blocked"), code: blockedCode, message: z.string().min(1).max(1000) }).strict(),
]);
export const loopImprovementDecisionsSchemaV1 = z.object({ gate: loopDecisionGateSchemaV1.nullable(), observedAt: z.string().datetime() }).strict();
export type LoopImprovementDecisionsV1 = z.infer<typeof loopImprovementDecisionsSchemaV1>;
export const unavailableLoopGate = () => ({ kind: "blocked" as const, code: "UNAVAILABLE" as const,
  message: "The saved decision could not be verified. Check the request again." });
// Step identifiers and roles come from the reviewed A2 decoder (including
// numbered steps and review roles); they are not a product-owned workflow enum.
export const loopProgressSchemaV1 = z.object({ step: z.string().min(1).max(180).nullable(),
  completed: z.number().int().nonnegative().max(100000), attention: z.enum(["none", "owner", "blocked"]),
  role: z.string().min(1).max(240).nullish(), attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
  requestedModel: z.string().min(1).max(240).nullish(), observedModel: z.string().min(1).max(240).nullish(),
  identityVerified: z.boolean().nullish(), repairCount: revision.nullish() }).strict();
const engineSchema = z.object({ revision, state: z.enum(["draft", "ready", "running", "waiting", "stopped", "finished", "refused"]),
  draft: z.string().min(1).max(8000), requestSha256: hash, settingsSha256: hash, inputVersion: scalar,
  confirmation: z.object({ sha256: hash, at: z.string().datetime(), who: z.literal("owner"), inputVersion: scalar }).strict().nullable(),
  progress: loopProgressSchemaV1,
  approval: loopApprovalDescriptorSchemaV1.nullable(),
  question: z.object({ questionId: id, inputVersion: scalar, reportSha256: hash, owner: z.boolean(), changesInput: z.boolean() }).strict().nullable(),
  identity: z.literal("unverified") }).strict();
export const loopDecisionStatusSchemaV1 = z.object({ schemaVersion: z.literal(1), request: loopImprovementRequestViewSchemaV1,
  display: loopImprovementStatusSchemaV1, engine: engineSchema, decisions: loopImprovementDecisionsSchemaV1.optional() }).strict().superRefine((s, ctx) => {
  const r = s.request, d = s.display, e = s.engine, g = s.decisions?.gate;
  if (r.currentVersion !== d.localVersion
    || (r.runLink?.runLinkId ?? null) !== d.runLinkId || d.engineRevision !== e.revision
    || e.approval && JSON.stringify(e.approval.inputVersion) !== JSON.stringify(e.inputVersion)
    || e.question && JSON.stringify(e.question.inputVersion) !== JSON.stringify(e.inputVersion)
    || r.description !== d.description || r.requestSha256 !== d.requestSha256 || r.settingsSha256 !== d.settingsSha256
    || g?.kind === "approve" && !e.approval || g?.kind === "question" && !e.question
    || g?.kind === "confirm" && d.confirmationCurrent)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "loop_status_binding_invalid" });
});
export type LoopDecisionStatusV1 = z.infer<typeof loopDecisionStatusSchemaV1>;
/** Both owner surfaces use the same localized missing-text policy. */
export function currentLoopGate(status: LoopDecisionStatusV1) {
  if (["stopped", "finished"].includes(status.engine.state)) return null;
  const gate = status.decisions?.gate;
  return gate === undefined || gate?.kind === "question" && gate.text === null ? unavailableLoopGate() : gate;
}
export const loopApprovalDocumentSchemaV1 = z.object({ schemaVersion: z.literal(1), projectId: id, requestId: id,
  runLinkId: id, localVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), engineRevision: revision,
  approval: loopApprovalDescriptorSchemaV1, text: z.string(), observedAt: z.string().datetime() }).strict();
export type LoopApprovalDocumentV1 = z.infer<typeof loopApprovalDocumentSchemaV1>;
export function loopDocumentBinding(status: LoopDecisionStatusV1) {
  return JSON.stringify([status.request.projectId, status.request.requestId, status.display.runLinkId,
    status.display.localVersion, status.engine.revision, status.engine.approval]);
}
export function documentMatchesStatus(document: LoopApprovalDocumentV1, status: LoopDecisionStatusV1) {
  return JSON.stringify([document.projectId, document.requestId, document.runLinkId, document.localVersion,
    document.engineRevision, document.approval]) === loopDocumentBinding(status);
}
const identity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirmation"), requestSha256: hash, settingsSha256: hash }).strict(),
  loopApprovalDescriptorSchemaV1.extend({ kind: z.literal("approval") }).strict(),
  z.object({ kind: z.literal("question"), questionId: id, inputVersion: scalar, questionReportSha256: hash }).strict(),
  z.object({ kind: z.literal("blocked"), code: blockedCode }).strict(),
]);
export const loopAttentionItemSchemaV1 = z.object({ projectId: id, requestId: id, runLinkId: id.nullable(),
  localVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), engineRevision: revision.nullable(),
  kind: z.enum(["confirmation", "approval", "question", "blocked"]), identity,
  title: z.string().min(1).max(180), summary: z.string().min(1).max(1000), observedAt: z.string().datetime() }).strict().refine(item =>
    item.kind === item.identity.kind && (item.runLinkId !== null && item.engineRevision !== null
      || item.identity.kind === "blocked" && item.identity.code === "UNAVAILABLE"));
export type LoopAttentionItemV1 = z.infer<typeof loopAttentionItemSchemaV1>;
export const loopAttentionSourceSchemaV1 = z.discriminatedUnion("state", [
  z.object({ schemaVersion: z.literal(1), state: z.literal("available"), items: z.array(loopAttentionItemSchemaV1).max(10), truncated: z.boolean() }).strict(),
  z.object({ schemaVersion: z.literal(1), state: z.literal("unavailable"), code: z.literal("unavailable") }).strict(),
]);
export const loopAttentionKey = (item: LoopAttentionItemV1) => JSON.stringify([item.projectId, item.requestId,
  item.runLinkId, item.localVersion, item.identity]);

export function loopAttentionComplete(source?: z.infer<typeof loopAttentionSourceSchemaV1>) {
  return !source || source.state === "available" && !source.truncated
    && !source.items.some(item => item.runLinkId !== null && item.identity.kind === "blocked" && item.identity.code === "UNAVAILABLE");
}
export function loopAttentionUnknown(source?: z.infer<typeof loopAttentionSourceSchemaV1>) {
  // A fresh per-root refusal is a counted unavailable item, so it makes the
  // lower bound incomplete. Only a failed whole source makes its count unknown.
  return source?.state === "unavailable";
}
