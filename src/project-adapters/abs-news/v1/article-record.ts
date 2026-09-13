import { z } from "zod";
import { absNewsCanonicalUrlSchemaV1 } from "./schemas";
// This schema is also parsed by the browser article reader. Import the leaf
// validators directly so the client bundle never traverses the server-only
// project-workspace catalog/session exports.
import { projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceDigestSchemaV1 as digest } from "../../../project-workspace/v1/schemas";

export const articleDetailRecordSchema = z.object({ tenantId: id, workspaceId: id, projectId: id,
  storyId: id, storyDigest: digest, canonicalUrl: absNewsCanonicalUrlSchemaV1,
  status: z.literal("extracted"), sourceHash: digest,
  extractor: z.literal("@mozilla/readability@0.6.0+jsdom@26.1.0"),
  text: z.string().min(1).max(131072).refine(value => new TextEncoder().encode(value).length <= 131072),
  detailDigest: digest }).strict();
export type ArticleDetailRecord = z.infer<typeof articleDetailRecordSchema>;
