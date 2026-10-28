import { z } from "zod";
import { updateCandidateDatabaseChangesSchemaV1 } from "./schemas";

export const loopCandidateIdV1 = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/);
export const loopCandidateDigestV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/), revision = z.string().regex(/^[a-f0-9]{40}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), positive = count.min(1);
export const loopCandidateInputVersionV1 = z.union([z.string().min(1).max(180), positive]);
const utc = z.string().datetime();
// Only bounded display text crosses this wire. Retained command argv and paths stay server-side.
const text = (max: number) => z.string().min(1).max(max).refine(v => !/(?:\/Users\/|\/home\/|\/Volumes\/|[A-Z]:\\|\u0000)/u.test(v));
const label = text(240), digest = loopCandidateDigestV1, id = loopCandidateIdV1;
const status = z.enum(["PASS", "FAIL", "INCOMPLETE", "NOT RUN"]);
const check = z.object({ id, required: z.boolean(), commandLabel: label, receiptDigest: digest, outputDigest: digest,
  candidateRevision: revision, status, exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
  completed: count, passed: count, failed: count, skipped: count, durationMs: count, startedAt: utc, endedAt: utc }).strict();
const review = z.object({ current: z.boolean(), stepId: id, role: label, attempt: positive,
  requestedModel: label.nullable(), observedModel: label.nullable(), identityVerified: z.boolean(), family: label.nullable(),
  verdict: z.enum(["CLEAN", "NEEDS-FIX"]), candidateRevision: revision, inputVersion: loopCandidateInputVersionV1,
  reportDigest: digest, sidecarDigest: digest, startedAt: utc, endedAt: utc }).strict();
export const loopCandidateEvidenceSchemaV1 = z.object({ schemaVersion: z.literal(1),
  binding: z.object({ projectId: id, requestId: id, runLinkId: id, localVersion: positive, adapterId: id, loopRunId: id,
    toolingRevision: digest, a2SchemaVersion: z.literal(1), a2InputVersion: loopCandidateInputVersionV1, engineRevision: count,
    requestSha256: hash, settingsSha256: hash, baseRevision: revision, candidateRevision: revision,
    inputsDigest: digest, recipeDigest: digest, environmentDigest: digest }).strict(),
  summary: text(4000), changedAreas: z.array(label).min(1).max(100), databaseChanges: updateCandidateDatabaseChangesSchemaV1,
  checks: z.array(check).min(1).max(32), reviews: z.array(review).min(1).max(32),
  findings: z.array(z.object({ origin: id, id, severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
    disposition: z.enum(["OPEN", "FIXED", "REJECTED_WITH_EVIDENCE"]), summary: text(1000), evidenceDigest: digest }).strict()).max(100),
  rounds: z.object({ attempts: count, reviewRejections: count, repairs: count, redesigns: count }).strict(),
  timing: z.object({ startedAt: utc, finishedAt: utc, durationMs: count }).strict(),
  assumptions: z.array(z.object({ id, text: text(1000), status: z.enum(["validated", "unverified"]), evidenceDigest: digest.nullable() }).strict()).max(32),
  validations: z.array(z.object({ id, text: text(1000), status, evidenceDigest: digest.nullable() }).strict()).max(32),
  overrides: z.object({ allowSameFamilyReview: z.boolean(), allowStandardFinal: z.boolean(),
    waivedConflicts: z.array(label).max(32), fallback: text(1000).nullable() }).strict(),
  completionDigest: digest, retentionDigest: digest,
}).strict().superRefine((v, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message });
  if (new TextEncoder().encode(JSON.stringify(v)).length > 65536) bad("evidence byte budget");
  if (v.binding.baseRevision === v.binding.candidateRevision) bad("distinct base and head required");
  if (Date.parse(v.timing.finishedAt) - Date.parse(v.timing.startedAt) !== v.timing.durationMs) bad("run duration mismatch");
  if (new Set(v.checks.map(c => c.id)).size !== v.checks.length) bad("duplicate check");
  if (!v.checks.some(c => c.required)) bad("required recipe checks absent");
  for (const c of v.checks) {
    if (c.completed !== c.passed + c.failed + c.skipped || Date.parse(c.endedAt) - Date.parse(c.startedAt) !== c.durationMs
      || c.candidateRevision !== v.binding.candidateRevision || Date.parse(c.startedAt) < Date.parse(v.timing.startedAt)
      || Date.parse(c.endedAt) > Date.parse(v.timing.finishedAt)) bad("check binding or counts mismatch");
    if (c.required && (c.status !== "PASS" || c.exitCode !== 0 || c.completed === 0 || c.failed !== 0 || c.skipped !== 0)) bad("required check incomplete");
  }
  const current = v.reviews.filter(r => r.current);
  if (!current.some(r => r.role === "final")) bad("current final required");
  for (const r of v.reviews) {
    if (Date.parse(r.endedAt) < Date.parse(r.startedAt) || r.identityVerified && (!r.observedModel || !r.family)) bad("review identity or time mismatch");
    if (r.current && (r.verdict !== "CLEAN" || r.candidateRevision !== v.binding.candidateRevision
      || r.inputVersion !== v.binding.a2InputVersion)) bad("current review binding mismatch");
  }
  if (current.some(r => !r.identityVerified || !r.family)) bad("current review independence unverified");
  if (v.findings.some(f => f.disposition === "OPEN" && f.severity !== "LOW")) bad("open blocking finding");
  if (v.assumptions.some(a => a.status === "validated" && a.evidenceDigest === null)
    || v.validations.some(a => a.status === "PASS" && a.evidenceDigest === null)) bad("validation evidence absent");
});
export type LoopCandidateEvidenceV1 = z.infer<typeof loopCandidateEvidenceSchemaV1>;
export const loopCandidateCardSchemaV1 = z.object({ candidateId: id, projectId: id, requestId: id, localVersion: positive,
  a2InputVersion: loopCandidateInputVersionV1, candidateRevision: revision, recordDigest: digest, version: z.union([z.literal(1), z.literal(2)]),
  state: z.enum(["ready", "accepted", "declined"]), evidence: loopCandidateEvidenceSchemaV1, freshness: z.enum(["current", "stale"]),
  createdAt: utc, decidedAt: utc.nullable(), canDecide: z.boolean() }).strict().superRefine((c, ctx) => {
    const b = c.evidence.binding;
    if (c.projectId !== b.projectId || c.requestId !== b.requestId || c.localVersion !== b.localVersion
      || c.a2InputVersion !== b.a2InputVersion || c.candidateRevision !== b.candidateRevision
      || (c.state === "ready" ? c.version !== 1 || c.decidedAt !== null : c.version !== 2 || c.decidedAt === null)
      || c.canDecide && (c.state !== "ready" || c.freshness !== "current")) ctx.addIssue({ code: "custom", message: "card binding mismatch" });
  });
export type LoopCandidateCardV1 = z.infer<typeof loopCandidateCardSchemaV1>;
export const loopCandidatePageSchemaV1 = z.object({ schemaVersion: z.literal(1), candidates: z.array(loopCandidateCardSchemaV1).max(10),
  truncated: z.boolean(), observedAt: utc, startsDeploy: z.literal(false), signedDeployApprovalCreated: z.literal(false) }).strict()
  .refine(v => new TextEncoder().encode(JSON.stringify(v)).length <= 1048576);
export const loopCandidateDetailSchemaV1 = z.object({ schemaVersion: z.literal(1), candidate: loopCandidateCardSchemaV1.nullable(), observedAt: utc }).strict();
export const loopCandidateDecisionBodySchemaV1 = z.object({ candidateId: id, expectedVersion: z.literal(1), candidateRecordDigest: digest,
  candidateRevision: revision, localVersion: positive, a2InputVersion: loopCandidateInputVersionV1, decision: z.enum(["accept", "decline"]) }).strict();
export type LoopCandidateDecisionBodyV1 = z.infer<typeof loopCandidateDecisionBodySchemaV1>;
export const loopCandidateDecisionReceiptSchemaV1 = z.object({ schemaVersion: z.literal(1), decisionId: id, candidateId: id, projectId: id,
  decision: z.enum(["accept", "decline"]), candidateVersion: z.literal(1), candidateRevision: revision, candidateRecordDigest: digest,
  decidedAt: utc, replayed: z.boolean(), startsDeploy: z.literal(false), signedDeployApprovalCreated: z.literal(false), grantsDeployAuthority: z.literal(false) }).strict();
export const loopCandidateCompletionReceiptSchemaV1 = z.object({ schemaVersion: z.literal(1), state: z.enum(["recorded", "replayed"]),
  projectId: id, requestId: id, runLinkId: id, localVersion: positive, a2InputVersion: loopCandidateInputVersionV1, engineRevision: count,
  completionDigest: digest, retentionDigest: digest, candidate: z.object({ candidateId: id, candidateRevision: revision, recordDigest: digest }).strict(),
  finishedAt: utc, href: z.string().min(1).max(1200) }).strict().refine(v => v.href ===
    `/projects/${encodeURIComponent(v.projectId)}/improvements#request=${encodeURIComponent(v.requestId)}`);
export type LoopCandidateCompletionReceiptV1 = z.infer<typeof loopCandidateCompletionReceiptSchemaV1>;
