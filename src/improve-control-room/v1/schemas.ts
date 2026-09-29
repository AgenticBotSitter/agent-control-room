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
  status: z.enum(["passed", "failed", "not_run", "blocked", "unavailable"]),
  summary: z.string().trim().min(1).max(1000),
  evidenceDigest: digest.nullable(),
}).strict();

export const updateCandidateDatabaseChangesSchemaV1 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("migrations"), migrationIds: z.array(z.string().regex(/^\d{4}_[a-z0-9_]+$/)).min(1).max(32),
    summary: z.string().trim().min(1).max(1000) }).strict(),
]);

export const recordUpdateCandidateSchemaV1 = z.object({
  projectId: id, improvementRequestId: id, pipelineRunId: id, baseRevision: revision, candidateRevision: revision,
  summary: z.string().trim().min(1).max(4000),
  changedAreas: z.array(z.string().trim().min(1).max(240)).min(1).max(100),
  testResults: z.array(updateCandidateTestResultSchemaV1).min(1).max(32),
  databaseChanges: updateCandidateDatabaseChangesSchemaV1,
  leadWorkerId: id,
}).strict().refine(value => value.baseRevision !== value.candidateRevision, { path: ["candidateRevision"] });

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
