import { z } from "zod";
import { DOMAIN_CONTRACT_VERSION, jobRecordSchema, requestRecordSchema, workflowRecordSchema } from "../../../domain/v1";
import { computeAuthorityDigest, sha256Digest } from "../../../security";
import { localId } from "../../../harness/v1/native-run-identifiers";
import { absFeedCollectionConfigurationSchema } from "./feed-collection";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
// Existing network authority uses host/port tuples; the complete path is bound by inputDigest.
const destination = (endpoint: string) => `https://${new URL(endpoint).hostname}:443`;
export const absFeedJobPlanSchema = z.object({ schema: z.literal("control-room.abs-feed-plan/v1"),
  jobId: localId, configuration: absFeedCollectionConfigurationSchema, plannedAt: instant,
}).strict();
export const ABS_FEED_JOB = Object.freeze({ jobType: "abs.feed.collection", specVersion: "abs-feed-collection/v1",
  operation: "abs.feed.collect", capability: "news.public_feed.read", maximumDurationSeconds: 60 });

/** Builds proposed records only. No persistence, approval, ready transition or network authority
 * is granted by this function. Source text and queued data must never select these inputs. */
export function buildAbsFeedProposedWork(value: unknown) {
  const input = z.object({ plan: absFeedJobPlanSchema, requestId: localId, workflowId: localId,
    ownerId: localId, executorId: localId, expiresAt: instant }).strict().parse(value);
  const { plan, expiresAt } = input, { tenantId, projectId } = plan.configuration;
  if (input.executorId === "executor:unassigned" || Date.parse(expiresAt) - Date.parse(plan.plannedAt) < 60_000)
    throw new Error("abs_feed_plan_invalid");
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId, version: 0, createdAt: plan.plannedAt, updatedAt: plan.plannedAt };
  const inputDigest = sha256Digest(plan);
  const authority = { projectId, allowedExecutor: input.executorId, allowedOperations: [ABS_FEED_JOB.operation],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "allowlist" as const,
    allowedNetworkDestinations: [destination(plan.configuration.source.endpointUrl)], effectPolicy: "approval_required" as const,
    maxRisk: "low" as const, maxDurationSeconds: ABS_FEED_JOB.maximumDurationSeconds, maxConcurrentEffects: 1,
    maxCostUsd: 0, expiresAt, digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const request = requestRecordSchema.parse({ ...common, kind: "request", id: input.requestId, projectId,
    title: "Collect configured public news feed", objective: "Read one approved RSS/Atom source and retain review-only discoveries; no agent or publishing work.",
    state: "draft", priority: 50, requestedBy: { actorId: input.ownerId, actorType: "human" },
    idempotencyKey: `abs-feed-request:${inputDigest.slice(7)}` });
  const workflow = workflowRecordSchema.parse({ ...common, kind: "workflow", id: input.workflowId, requestId: request.id,
    projectId, definitionVersion: ABS_FEED_JOB.specVersion, definitionDigest: sha256Digest(ABS_FEED_JOB),
    authorityMode: "control_room_native", state: "proposed", jobIds: [plan.jobId] });
  const job = jobRecordSchema.parse({ ...common, kind: "job", id: plan.jobId, workflowId: workflow.id, projectId,
    jobType: ABS_FEED_JOB.jobType, specVersion: ABS_FEED_JOB.specVersion, inputDigest, state: "proposed", priority: 50,
    requiredCapability: ABS_FEED_JOB.capability, dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } });
  return { plan, request, workflow, job, startsWork: false as const };
}

/** Structural binding only, not current approval/lease/project/owner validation. Caller must
 * perform those reads before admission. Returns a freshly parsed configuration, never a URL
 * from a queue entry. State is deliberately checked by the lifecycle service, not this parser. */
export function verifyAbsFeedJobPlan(jobValue: unknown, planValue: unknown) {
  const job = jobRecordSchema.parse(jobValue), plan = absFeedJobPlanSchema.parse(planValue);
  const config = plan.configuration, a = job.authority, r = job.retryPolicy;
  if (job.id !== plan.jobId || job.tenantId !== config.tenantId || job.projectId !== config.projectId
    || job.inputDigest !== sha256Digest(plan) || job.createdAt !== plan.plannedAt
    || job.jobType !== ABS_FEED_JOB.jobType || job.specVersion !== ABS_FEED_JOB.specVersion
    || job.requiredCapability !== ABS_FEED_JOB.capability || job.dependsOnJobIds.length
    || a.allowedExecutor === "executor:unassigned" || a.allowedOperations.length !== 1 || a.allowedOperations[0] !== ABS_FEED_JOB.operation
    || a.credentialRefs.length || a.filesystemRoots.length || a.networkPolicy !== "allowlist"
    || a.allowedNetworkDestinations.length !== 1 || a.allowedNetworkDestinations[0] !== destination(config.source.endpointUrl)
    || a.effectPolicy !== "approval_required" || a.maxRisk !== "low" || a.maxConcurrentEffects !== 1
    || a.maxDurationSeconds !== ABS_FEED_JOB.maximumDurationSeconds || a.maxCostUsd !== 0 || a.parentDigest !== undefined
    || computeAuthorityDigest(a) !== a.digest || Date.parse(a.expiresAt) - Date.parse(plan.plannedAt) < 60_000
    || r.maxAttempts !== 1 || r.backoffSeconds !== 0 || r.retryableFailureCodes.length || r.retryAfterOrphan || r.ambiguousEffectPolicy !== "attention")
    throw new Error("abs_feed_plan_mismatch");
  return config;
}
