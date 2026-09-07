import { z } from "zod";
import { catalogProjectIdSchema } from "../../web/v1/project-wire";

export const syntheticResultSchemaV1 = z.object({
  schema: z.literal("control-room.local-synthetic-result/v1"),
  tenantId: catalogProjectIdSchema, projectId: catalogProjectIdSchema,
  jobId: catalogProjectIdSchema, artifactId: catalogProjectIdSchema,
  text: z.string().max(65_536), contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  sizeBytes: z.number().int().min(0).max(65_536),
  simulationOnly: z.literal(true), untrustedContent: z.literal(true),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
