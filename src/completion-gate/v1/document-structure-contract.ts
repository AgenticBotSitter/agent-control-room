import { z } from "zod";
const distinct = (values: string[]) => new Set(values).size === values.length;
const literal = z.string().trim().min(1).max(120).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
export const documentStructureRulesSchema = z.object({
  version: z.literal("document-structure/v1"), minUtf8Bytes: z.number().int().min(1).max(65_536),
  maxUtf8Bytes: z.number().int().min(1).max(65_536),
  requiredHeadings: z.array(literal).max(30).refine(distinct),
  forbiddenTerms: z.array(literal).max(30).refine(distinct),
}).strict().refine(value => value.minUtf8Bytes <= value.maxUtf8Bytes);
export type DocumentStructureRules = z.infer<typeof documentStructureRulesSchema>;
export type DocumentStructureVerdict = { outcome: "passed" | "failed"; reasonCodes: ("too_short" | "too_long" | "missing_heading" | "forbidden_term" | "unsupported_markup")[] };
