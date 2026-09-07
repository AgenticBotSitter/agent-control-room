import { z } from "zod";
import { catalogProjectIdSchema } from "../web/v1/project-wire";

/** Feedback is inert sample text, never a command or provider prompt. */
export const contributorRevisionSchema = z.object({
  parentArtifactId: catalogProjectIdSchema,
  feedback: z.string().trim().min(1).max(500),
}).strict();
export type ContributorRevision = z.infer<typeof contributorRevisionSchema>;
