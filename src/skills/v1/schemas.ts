import { z } from "zod";

export const reusableSkillReferenceSchemaV1 = z.object({
  skillId: z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  version: z.number().int().positive().max(1_000_000),
}).strict();

export type ReusableSkillReferenceV1 = z.infer<typeof reusableSkillReferenceSchemaV1>;

export const reusableSkillReferencesSchemaV1 = z.array(reusableSkillReferenceSchemaV1).max(8)
  .refine((value) => new Set(value.map(reference => `${reference.skillId}:${reference.version}`)).size === value.length,
    "skill references must be unique")
  // Two VERSIONS of one skill cannot both be bound to a single task, and this
  // is where that is refused rather than deep inside an INSERT.
  // `control_task_skill_bindings` is keyed on (tenant_id, job_id, skill_id): the
  // version is a column, not part of the key. Two references to the same skill
  // at different versions therefore passed reference validation and collided
  // on a duplicate primary key, so the owner saw a raw constraint error
  // instead of a named invalid request. Refusing by skill id — not by
  // skill+version — is what matches the table, and it is also the honest
  // reading: a task uses one version of a skill, not two.
  .refine((value) => new Set(value.map(reference => reference.skillId)).size === value.length,
    "a task may reference each skill at one version only");

