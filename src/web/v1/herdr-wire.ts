import { z } from 'zod';
import { catalogProjectIdSchema } from './project-wire';

export const herdrObservationPageSchema = z.object({
  projectId: catalogProjectIdSchema,
  status: z.enum(['online', 'offline', 'not_configured']),
  rows: z.array(z.object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']),
    duplicateSession: z.boolean(), stateSource: z.literal('advisory'),
    executionAuthority: z.literal(false), completionVerified: z.literal(false), cleanupVerified: z.literal(false),
  }).strict()).max(1024),
  ageMs: z.number().finite().nonnegative().nullable(),
  executionAuthority: z.literal(false), completionVerified: z.literal(false), cleanupVerified: z.literal(false),
}).strict().superRefine((page, context) => {
  if (new Set(page.rows.map(row => row.key)).size !== page.rows.length
      || page.status === 'not_configured' && (page.rows.length !== 0 || page.ageMs !== null)
      || page.rows.length > 0 && page.ageMs === null
      || page.status === 'online' && (page.ageMs === null || page.ageMs >= 5000))
    context.addIssue({ code: 'custom', message: 'invalid_observation_page' });
});
export type HerdrObservationPage = z.infer<typeof herdrObservationPageSchema>;
export const herdrObservationFleetSchema = z.object({
  projectId: catalogProjectIdSchema,
  sources: z.array(z.object({ sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
    observation: herdrObservationPageSchema }).strict()).max(16),
}).strict().superRefine((fleet, context) => {
  if (new Set(fleet.sources.map(source => source.sourceKey)).size !== fleet.sources.length
      || fleet.sources.some(source => source.observation.projectId !== fleet.projectId)
      || fleet.sources.reduce((sum, source) => sum + source.observation.rows.length, 0) > 1024)
    context.addIssue({ code: 'custom', message: 'invalid_observation_fleet' });
});
export type HerdrObservationFleet = z.infer<typeof herdrObservationFleetSchema>;
