import { z } from "zod";

export const reusableSkillReferenceSchemaV1 = z.object({
  skillId: z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  version: z.number().int().positive().max(1_000_000),
}).strict();

export type ReusableSkillReferenceV1 = z.infer<typeof reusableSkillReferenceSchemaV1>;

export const reusableSkillReferencesSchemaV1 = z.array(reusableSkillReferenceSchemaV1).max(8)
  .refine((value) => new Set(value.map(reference => `${reference.skillId}:${reference.version}`)).size === value.length,
    "skill references must be unique");

