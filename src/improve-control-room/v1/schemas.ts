import { z } from "zod";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const safeLabel = z.string().trim().min(1).max(180);

export const improvementRequestDraftSchemaV1 = z.object({
  description: z.string().trim().min(1).max(8000),
  pipelineTemplateId: id,
  selectedWorkerIds: z.array(id).min(1).max(16).refine(value => new Set(value).size === value.length),
  leadWorkerId: id,
}).strict();

export const improvementTemplateChoiceSchemaV1 = z.object({
  templateId: id,
  name: safeLabel,
  version: z.number().int().positive(),
  templateDigest: digest,
  workers: z.array(z.object({ ordinal: z.number().int().min(0).max(2), stage: z.enum(["build", "check", "signoff"]),
    workerId: id, model: safeLabel, effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]) }).strict()).length(3),
}).strict();

export const improvementRequestViewSchemaV1 = z.object({
  requestId: id, projectId: id, description: z.string().min(1).max(8000), pipelineTemplateId: id,
  pipelineTemplateVersion: z.number().int().positive(), pipelineTemplateDigest: digest,
  selectedWorkerIds: z.array(id).min(1).max(16), leadWorkerId: id, pipelineRunId: id,
  createdAt: z.string().datetime({ offset: true }), startsWork: z.literal(false), grantsDeployAuthority: z.literal(false),
}).strict();

export const improvementDeskViewSchemaV1 = z.object({
  projectId: id,
  templates: z.array(improvementTemplateChoiceSchemaV1).max(100),
  requests: z.array(improvementRequestViewSchemaV1).max(100),
  startsWork: z.literal(false),
  grantsDeployAuthority: z.literal(false),
}).strict();

export const updateCandidateTestResultSchemaV1 = z.object({
  profile: z.enum(["fast", "db", "full", "targeted"]),
  profileVersion: z.number().int().positive(),
  profileDigest: digest,
  commandIds: z.array(id).min(1).max(32),
  candidateRevision: revision,
  status: z.enum(["passed", "failed", "not_run", "blocked", "unavailable"]),
  summary: z.string().trim().min(1).max(1000),
  evidenceDigest: digest.nullable(),
  testCount: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  workerId: id,
  runner: z.object({ kind: z.enum(["candidate_worktree", "local_test_runner"]), serviceId: id }).strict(),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

export const updateCandidateDatabaseChangesSchemaV1 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("migrations"), migrationIds: z.array(z.string().regex(/^\d{4}_[a-z0-9_]+$/)).min(1).max(32),
    summary: z.string().trim().min(1).max(1000), compatibilityNotes: z.string().trim().min(1).max(1000),
    rollbackNotes: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("changes"), changedPaths: z.array(z.string().regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[\x21-\x7e]{1,512}$/)).min(1).max(1000),
    migrationIds: z.array(z.string().regex(/^\d{4}_[a-z0-9_]+$/)).max(32),
    summary: z.string().trim().min(1).max(1000), compatibilityNotes: z.string().trim().min(1).max(1000),
    rollbackNotes: z.string().trim().min(1).max(1000) }).strict(),
]);

export const updateCandidateRiskFlagSchemaV1 = z.object({
  kind: z.enum(["security", "database", "authority", "dependency"]),
  summary: z.string().trim().min(1).max(240),
  needsIndependentReview: z.literal(true),
}).strict();

export const updateCandidateIndependentReviewSchemaV1 = z.object({
  reviewId: id, reviewDigest: digest, reviewerWorkerId: id,
}).strict();

export const recordUpdateCandidateSchemaV1 = z.object({
  projectId: id, improvementRequestId: id, pipelineRunId: id, baseRevision: revision, candidateRevision: revision,
  summary: z.string().trim().min(1).max(4000),
  changedAreas: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
  testResults: z.array(updateCandidateTestResultSchemaV1).min(1).max(32),
  databaseChanges: updateCandidateDatabaseChangesSchemaV1,
  riskFlags: z.array(updateCandidateRiskFlagSchemaV1).max(4),
  independentReviews: z.array(updateCandidateIndependentReviewSchemaV1).max(32),
  leadWorkerId: id,
}).strict().refine(value => value.baseRevision !== value.candidateRevision, { path: ["candidateRevision"] })
  .refine(value => value.testResults.every(result => result.candidateRevision === value.candidateRevision),
    { path: ["testResults"], message: "test result revision mismatch" })
  .refine(value => value.riskFlags.length === 0 || value.independentReviews.length > 0,
    { path: ["independentReviews"], message: "independent review required" });

export const updateCandidateViewSchemaV1 = recordUpdateCandidateSchemaV1.safeExtend({
  candidateId: id,
  state: z.enum(["ready", "accepted", "declined"]),
  version: z.number().int().positive(),
  recordDigest: digest,
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  startsDeploy: z.literal(false),
  signedDeployApprovalCreated: z.literal(false),
}).strict();

export const updateCandidatePageSchemaV1 = z.object({
  candidates: z.array(updateCandidateViewSchemaV1).max(100),
  startsDeploy: z.literal(false), signedDeployApprovalCreated: z.literal(false),
}).strict();

export const updateCandidateDecisionDraftSchemaV1 = z.object({
  candidateId: id, expectedVersion: z.number().int().positive(), candidateRecordDigest: digest,
  decision: z.enum(["accept", "decline"]),
}).strict();

export const updateCandidateDecisionReceiptSchemaV1 = z.object({
  decisionId: id, candidateId: id, projectId: id, decision: z.enum(["accept", "decline"]),
  candidateVersion: z.number().int().positive(), decidedAt: z.string().datetime({ offset: true }), replayed: z.boolean(),
  startsDeploy: z.literal(false), signedDeployApprovalCreated: z.literal(false), grantsDeployAuthority: z.literal(false),
}).strict();

export type ImprovementRequestDraftV1 = z.infer<typeof improvementRequestDraftSchemaV1>;
export type ImprovementDeskViewV1 = z.infer<typeof improvementDeskViewSchemaV1>;
export type RecordUpdateCandidateV1 = z.infer<typeof recordUpdateCandidateSchemaV1>;
export type UpdateCandidateViewV1 = z.infer<typeof updateCandidateViewSchemaV1>;

// Loop records are independent of legacy pipeline requests. Preserve input bytes.
const loopVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const rawHash = z.string().regex(/^[a-f0-9]{64}$/);
const loopDescription = z.string().min(1).max(8000).refine(value => value.trim().length > 0);
const loopSettings = z.string().refine(value => {
  if (new TextEncoder().encode(value).byteLength > 65536) return false;
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed); }
  catch { return false; }
});
export const loopImprovementDraftSchemaV1 = z.object({ description: loopDescription, settingsText: loopSettings }).strict();
export const loopImprovementEditSchemaV1 = loopImprovementDraftSchemaV1.extend({ requestId: id, expectedVersion: loopVersion }).strict();
export const loopImprovementRunIdentitySchemaV1 = z.object({ adapterId: id, loopRunId: id,
  toolingRevision: digest, a2SchemaVersion: z.literal(1) }).strict();
export const loopImprovementRunLinkSchemaV1 = z.object({ projectId: id, requestId: id,
  initialInputVersion: loopVersion, run: loopImprovementRunIdentitySchemaV1 }).strict();
export const loopImprovementStartSchemaV1 = z.object({ requestId: id, expectedVersion: loopVersion,
  runLinkId: id, requestSha256: rawHash, settingsSha256: rawHash }).strict();
export const loopImprovementConfirmationSchemaV1 = z.object({
  path: z.string().min(1).max(512).regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[A-Za-z0-9._/-]+$/),
  sha256: rawHash, at: z.string().datetime(), who: z.literal("owner"),
  input_version: z.union([z.string().min(1).max(180), loopVersion]),
}).strict();
export const loopImprovementObservationSchemaV1 = z.object({
  inputVersion: z.union([z.string().min(1).max(180), loopVersion]), settingsDigest: z.string().min(1).max(180),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), confirmation: loopImprovementConfirmationSchemaV1,
}).strict();
export const loopImprovementRunViewSchemaV1 = loopImprovementRunIdentitySchemaV1.extend({
  runLinkId: id, initialInputVersion: loopVersion,
}).strict();
export const loopImprovementRequestViewSchemaV1 = z.object({ requestId: id, projectId: id,
  currentVersion: loopVersion, description: loopDescription, requestSha256: rawHash, settingsSha256: rawHash,
  runLink: loopImprovementRunViewSchemaV1.nullable(), savedAuthorization: z.boolean(),
  createdAt: z.string().datetime({ offset: true }), startsWork: z.literal(false), grantsDeployAuthority: z.literal(false),
}).strict();
export const loopImprovementDeskViewSchemaV1 = z.object({ legacy: improvementDeskViewSchemaV1,
  loopRequests: z.array(loopImprovementRequestViewSchemaV1).max(100),
}).strict();
export type LoopImprovementRunIdentityV1 = z.infer<typeof loopImprovementRunIdentitySchemaV1>;
export type LoopImprovementObservationV1 = z.infer<typeof loopImprovementObservationSchemaV1>;
/** Reviewed server boundary only. It decodes actual A2 types and independently binds
 * its observation to the effective bytes and the run's normalized current path.
 * There is deliberately no dispatcher. Omission disables admission. */
export type LoopImprovementContractV1 = {
  toolingRevision: string;
  decodeRunIdentity: (input: unknown) => LoopImprovementRunIdentityV1;
  decodeObservation: (input: unknown) => LoopImprovementObservationV1;
  matchesSavedInput: (run: LoopImprovementRunIdentityV1, observation: LoopImprovementObservationV1,
    input: { description: string; settingsText: string; requestSha256: string; settingsSha256: string }) => boolean;
};

// B1b: browser input is closed; configured engine identity never comes from it.
const engineRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const loopExpected = { expectedVersion: loopVersion, expectedRevision: engineRevision };
export const loopBridgeOperationSchemaV1 = z.enum(["intake", "confirm", "start", "stop", "approve", "answer"]);
export type LoopBridgeOperationV1 = z.infer<typeof loopBridgeOperationSchemaV1>;
const startRoute = z.object({providerId:z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  model:z.string().min(1).max(180).regex(/^[^\x00-\x1f\x7f-\x9f]*$/)}).strict();
const paidAdmission = z.object({optIn:z.literal(true),capNanoUsd:z.string().regex(/^[1-9][0-9]{0,29}$/)}).strict();
export const loopPaidPinSchemaV1 = z.object({
  providerId:startRoute.shape.providerId,model:startRoute.shape.model,
  servedModelId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/),
  providerVersion:loopVersion,priceRowDigest:digest,capNanoUsd:paidAdmission.shape.capNanoUsd,
}).strict();
/** Calendar validation shared by signed binding decoding; Date.parse alone normalizes impossible dates. */
export function loopSelectionAcknowledgementTimestampV1(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (!year || month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59) return null;
  const calendar = new Date(0); calendar.setUTCFullYear(year!, month!, 0);
  if (day! > calendar.getUTCDate()) return null;
  if (m[7] !== "Z" && (Number(m[7]!.slice(1, 3)) > 15 || Number(m[7]!.slice(4)) > 59)) return null;
  const parsed = Date.parse(text); return Number.isFinite(parsed) ? parsed : null;
}
export const loopSameFamilyAcknowledgementSchemaV1 = z.object({ schema_version: z.literal(1), rule: z.literal("R296"),
  run: id, by: z.literal("owner"), accepted_at: z.string().refine(value => loopSelectionAcknowledgementTimestampV1(value) !== null),
  acknowledgement: z.literal("same-family-risk-accepted") }).strict();
const sameFamilyIntent = { acceptSameFamilyRisk: z.literal(true).optional() };
export const loopBridgeBodiesV1 = {
  intake: z.object({ description: loopDescription, settingsEdits: z.string().optional(), waiverId: id.optional(), ...sameFamilyIntent }).strict(),
  confirm: z.object({ ...loopExpected, requestSha256: rawHash, settingsSha256: rawHash, ...sameFamilyIntent }).strict(),
  start: z.object({ ...loopExpected, runLinkId: id, route:startRoute.optional(),paid:paidAdmission.optional(), ...sameFamilyIntent }).strict()
    .refine(value => !value.paid || !!value.route),
  stop: z.object({ runLinkId: id }).strict(),
  approve: z.object({ ...loopExpected, step: z.enum(["plan", "spec"]),
    inputVersion: z.union([loopVersion, z.string().min(1).max(180)]), head: revision, reportSha256: rawHash }).strict(),
  answer: z.object({ ...loopExpected, questionId: id, inputVersion: z.union([loopVersion, z.string().min(1).max(180)]),
    questionReportSha256: rawHash, text: loopDescription }).strict(),
} as const;
export const loopBridgeOutcomeSchemaV1 = z.object({
  state: z.enum(["accepted", "waiting", "refused"]), revision: engineRevision,
  adapterId: id, loopRunId: id, toolingRevision: digest,
  evidenceDigest: digest, error: z.enum(["REFUSED", "INELIGIBLE"]).nullable(),
}).strict();
export const loopBridgeBindingSchemaV1 = z.object({
  schemaVersion: z.literal(1), body: z.record(z.string(), z.unknown()), localVersion: loopVersion,
  adapterId: id, loopRunId: id, toolingRevision: digest, a2SchemaVersion: z.literal(1), schemaDigest: digest,
  requestSha256: rawHash, settingsSha256: rawHash,
  runLinkId: id.nullable(), authorizationId: id.nullable(),
  inputVersion: z.union([loopVersion, z.string().min(1).max(180)]).nullable(),
  expectedRevision: engineRevision.nullable(), evidence: digest.nullable(), paidPin:loopPaidPinSchemaV1.optional(),
  sameFamilyAcknowledgement: loopSameFamilyAcknowledgementSchemaV1.optional(),
}).strict().refine(value => !value.sameFamilyAcknowledgement || value.sameFamilyAcknowledgement.run === value.loopRunId)
.refine(value => !value.body.acceptSameFamilyRisk || !!value.sameFamilyAcknowledgement).refine(value => {
  if (!Object.hasOwn(value, "paidPin")) return !Object.hasOwn(value.body,"paid");
  const body=loopBridgeBodiesV1.start.safeParse(value.body);
  return body.success && !!body.data.paid && !!body.data.route
    && body.data.route.providerId === value.paidPin!.providerId && body.data.route.model === value.paidPin!.model
    && body.data.paid.capNanoUsd === value.paidPin!.capNanoUsd;
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65536);
export type LoopBridgeBindingV1 = z.infer<typeof loopBridgeBindingSchemaV1>;
export type LoopBridgeOutcomeV1 = z.infer<typeof loopBridgeOutcomeSchemaV1>;
export const loopBridgeReceiptSchemaV1 = z.object({ schemaVersion: z.literal(1), requestId: id,
  localVersion: loopVersion, commandId: id, state: z.enum(["accepted", "waiting", "refused", "uncertain"]),
  replayed: z.boolean(), engineRevision: engineRevision.nullable(),
  error: z.enum(["REFUSED", "INELIGIBLE", "LAUNCH_UNCERTAIN"]).nullable(),
}).strict();


// Product display only. Unknown engine evidence stays null, never guessed.
export const loopImprovementStatusSchemaV1 = z.object({
  schemaVersion: z.literal(1), projectId: id, requestId: id, localVersion: loopVersion,
  description: loopDescription, requestSha256: rawHash, settingsSha256: rawHash, runLinkId: id.nullable(),
  engineRevision: engineRevision.nullable(),
  state: z.enum(["ready", "running", "waiting_approval", "waiting_question", "waiting_owner", "blocked", "stopped", "candidate_ready"]).nullable(),
  startState: z.enum(["not_started", "dispatched", "started", "uncertain"]),
  confirmationCurrent: z.boolean(), canStart: z.boolean(), canStop: z.boolean(), providerRoute:startRoute.optional(),
  progress: z.object({ stepId: z.string().min(1).max(180).nullable(), role: z.string().min(1).max(240).nullable(),
    attempt: loopVersion.nullable(), requestedModel: z.string().min(1).max(240).nullable(),
    observedModel: z.string().min(1).max(240).nullable(), identityVerified: z.boolean(),
    repairCount: engineRevision.nullable() }).strict().nullable(),
  attention: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(1000),
    nextAction: z.string().min(1).max(1000) }).strict().nullable(), observedAt: z.string().datetime(),
}).strict();
export type LoopImprovementStatusV1 = z.infer<typeof loopImprovementStatusSchemaV1>;
export type LoopImprovementDeskViewV1 = z.infer<typeof loopImprovementDeskViewSchemaV1>;
export type LoopImprovementRequestViewV1 = z.infer<typeof loopImprovementRequestViewSchemaV1>;
