import { z } from "zod";
import { DOMAIN_CONTRACT_VERSION, jobRecordSchema, requestRecordSchema, workflowRecordSchema } from "../../../domain/v1";
import { computeAuthorityDigest, sha256Digest } from "../../../security";
import { localId } from "../../../harness/v1/native-run-identifiers";
import { newsFeedCollectionConfigurationSchema } from "./feed-collection";
import { NEWS_DISCOVERY_JOB, newsDiscoveryJobConfigurationSchema } from "./discovery-job-configuration";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
// Existing network authority uses host/port tuples; the complete path is bound by inputDigest.
const destination = (endpoint: string) => `https://${new URL(endpoint).hostname}:443`;
const legacyPlanSchema = z.object({ schema: z.literal("control-room.news-feed-plan/v1"),
  jobId: localId, configuration: newsFeedCollectionConfigurationSchema, plannedAt: instant,
}).strict();
export const newsFeedJobPlanSchema = z.discriminatedUnion("schema", [legacyPlanSchema,
  z.object({ schema: z.literal("control-room.news-discovery-plan/v1"), jobId: localId,
    configuration: newsDiscoveryJobConfigurationSchema, plannedAt: instant }).strict()]);
export const NEWS_FEED_JOB = Object.freeze({ jobType: "news.feed.collection", specVersion: "news-feed-collection/v1",
  operation: "news.feed.collect", capability: "news.public_feed.read", maximumDurationSeconds: 60 });

/** Builds proposed records only. No persistence, approval, ready transition or network authority
 * is granted by this function. Source text and queued data must never select these inputs. */
export function buildNewsFeedProposedWork(value: unknown) {
  const input = z.object({ plan: newsFeedJobPlanSchema, requestId: localId, workflowId: localId,
    ownerId: localId, executorId: localId, expiresAt: instant }).strict().parse(value);
  const { plan, expiresAt } = input, { tenantId, projectId } = plan.configuration;
  const spec = plan.schema === "control-room.news-discovery-plan/v1" ? NEWS_DISCOVERY_JOB : NEWS_FEED_JOB;
  const destinations = plan.schema === "control-room.news-discovery-plan/v1"
    ? plan.configuration.allowedOrigins.map(destination) : [destination(plan.configuration.source.endpointUrl)];
  if (input.executorId === "executor:unassigned" || Date.parse(expiresAt) - Date.parse(plan.plannedAt) < 60_000)
    throw new Error("news_feed_plan_invalid");
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId, version: 0, createdAt: plan.plannedAt, updatedAt: plan.plannedAt };
  const inputDigest = sha256Digest(plan);
  const authority = { projectId, allowedExecutor: input.executorId, allowedOperations: [spec.operation],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "allowlist" as const,
    allowedNetworkDestinations: destinations, effectPolicy: "approval_required" as const,
    maxRisk: "low" as const, maxDurationSeconds: NEWS_FEED_JOB.maximumDurationSeconds, maxConcurrentEffects: 1,
    maxCostUsd: 0, expiresAt, digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const request = requestRecordSchema.parse({ ...common, kind: "request", id: input.requestId, projectId,
    title: plan.schema === "control-room.news-discovery-plan/v1" ? "Refresh configured news source" : "Collect configured public news feed",
    objective: plan.schema === "control-room.news-discovery-plan/v1"
      ? "Run bounded borrowed feed/sitemap discovery for the approved source revision and origins; retain review-only articles, with no agent or publishing work."
      : "Read one approved RSS/Atom source and retain review-only discoveries; no agent or publishing work.",
    state: "draft", priority: 50, requestedBy: { actorId: input.ownerId, actorType: "human" },
    idempotencyKey: `news-feed-request:${inputDigest.slice(7)}` });
  const workflow = workflowRecordSchema.parse({ ...common, kind: "workflow", id: input.workflowId, requestId: request.id,
    projectId, definitionVersion: spec.specVersion, definitionDigest: sha256Digest(spec),
    authorityMode: "control_room_native", state: "proposed", jobIds: [plan.jobId] });
  const job = jobRecordSchema.parse({ ...common, kind: "job", id: plan.jobId, workflowId: workflow.id, projectId,
    jobType: spec.jobType, specVersion: spec.specVersion, inputDigest, state: "proposed", priority: 50,
    requiredCapability: spec.capability, dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } });
  return { plan, request, workflow, job, startsWork: false as const };
}

/** Structural binding only, not current approval/lease/project/owner validation. Caller must
 * perform those reads before admission. Returns a freshly parsed configuration, never a URL
 * from a queue entry. State is deliberately checked by the lifecycle service, not this parser. */
export function verifyNewsFeedJobPlan(jobValue: unknown, planValue: unknown) {
  const job = jobRecordSchema.parse(jobValue), plan = newsFeedJobPlanSchema.parse(planValue);
  const config = plan.configuration, a = job.authority, r = job.retryPolicy;
  const spec = plan.schema === "control-room.news-discovery-plan/v1" ? NEWS_DISCOVERY_JOB : NEWS_FEED_JOB;
  const destinations = plan.schema === "control-room.news-discovery-plan/v1"
    ? plan.configuration.allowedOrigins.map(destination) : [destination(config.source.endpointUrl)];
  if (job.id !== plan.jobId || job.tenantId !== config.tenantId || job.projectId !== config.projectId
    || job.inputDigest !== sha256Digest(plan) || job.createdAt !== plan.plannedAt
    || job.jobType !== spec.jobType || job.specVersion !== spec.specVersion
    || job.requiredCapability !== spec.capability || job.dependsOnJobIds.length
    || a.allowedExecutor === "executor:unassigned" || a.allowedOperations.length !== 1 || a.allowedOperations[0] !== spec.operation
    || a.credentialRefs.length || a.filesystemRoots.length || a.networkPolicy !== "allowlist"
    || sha256Digest(a.allowedNetworkDestinations) !== sha256Digest(destinations)
    || a.effectPolicy !== "approval_required" || a.maxRisk !== "low" || a.maxConcurrentEffects !== 1
    || a.maxDurationSeconds !== NEWS_FEED_JOB.maximumDurationSeconds || a.maxCostUsd !== 0 || a.parentDigest !== undefined
    || computeAuthorityDigest(a) !== a.digest || Date.parse(a.expiresAt) - Date.parse(plan.plannedAt) < 60_000
    || r.maxAttempts !== 1 || r.backoffSeconds !== 0 || r.retryableFailureCodes.length || r.retryAfterOrphan || r.ambiguousEffectPolicy !== "attention")
    throw new Error("news_feed_plan_mismatch");
  return config;
}
