import { z } from "zod";
const distinct = (values: string[]) => new Set(values).size === values.length;
export const documentStructureRulesSchema = z.object({
  version: z.literal("document-structure/v1"), minUtf8Bytes: z.number().int().min(1).max(65_536),
  maxUtf8Bytes: z.number().int().min(1).max(65_536),
  requiredHeadings: z.array(z.string().trim().min(1).max(120).regex(/^[^\r\n\x00-\x1f\x7f]+$/)).max(30).refine(distinct),
  forbiddenTerms: z.array(z.string().trim().min(1).max(120).regex(/^[^\r\n\x00-\x1f\x7f]+$/)).max(30).refine(distinct),
}).strict().refine(value => value.minUtf8Bytes <= value.maxUtf8Bytes);
export type DocumentStructureRules = z.infer<typeof documentStructureRulesSchema>;
export type DocumentStructureVerdict = { outcome: "passed" | "failed"; reasonCodes: ("too_short" | "too_long" | "missing_heading" | "forbidden_term")[] };
