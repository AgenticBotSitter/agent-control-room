import { z } from "zod";
import { localId } from "../../../harness/v1/native-run-identifiers";
import { absNewsDiscoveryEndpointSchemaV1 } from "./schemas";
import { controlCenterCollectionLimitsSchema } from "./control-center-reader";

// Exact public HTTPS origins, not suffix patterns. Discovered paths and queries may
// vary within these origins; redirects to another origin need an explicit entry.
const origin = absNewsDiscoveryEndpointSchemaV1.refine(value => new URL(value).origin + "/" === value);
export const absDiscoveryJobConfigurationSchema = z.object({
  tenantId: localId, workspaceId: localId, projectId: localId,
  source: z.object({ sourceId: localId, sourceLabel: z.string().min(1).max(180),
    sourceKind: z.literal("discovery"), endpointUrl: absNewsDiscoveryEndpointSchemaV1 }).strict(),
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  allowedOrigins: z.array(origin).min(1).max(16),
  limits: controlCenterCollectionLimitsSchema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.allowedOrigins).size !== value.allowedOrigins.length
    || !value.allowedOrigins.includes(new URL(value.source.endpointUrl).origin + "/"))
    ctx.addIssue({ code: "custom", message: "discovery_origins_invalid" });
});

export const ABS_DISCOVERY_JOB = Object.freeze({ jobType: "abs.feed.collection", specVersion: "abs-news-discovery/v1",
  operation: "abs.news.discover", capability: "news.public_discovery.read", maximumDurationSeconds: 60 });
