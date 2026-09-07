import { z } from "zod";
import { projectViewSchema, catalogProjectIdSchema as id } from "./project-wire";
import { taskDraftSchema } from "./task-wire";

export const newsResearchInputSchema = z.object({ storyId: id,
  storyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  action: z.enum(["research_brief", "setup_guide"]), goal: z.string().trim().min(1).max(1500),
}).strict();
export const newsResearchPreviewSchema = z.object({ projectId: id, storyId: id,
  storyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), draft: taskDraftSchema,
  saved: z.literal(false), dispatch: z.literal("not_requested"),
}).strict();

export const newsPageSchema = z.object({ project: projectViewSchema,
  availability: z.enum(["configured", "not_configured"]), observedAt: z.string().datetime(), canPrepare: z.boolean(),
  stories: z.array(z.object({ storyId: id, storyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    title: z.string().min(1).max(240), summary: z.string().max(4000),
    canonicalUrl: z.string().url().max(2048).refine(value => {
      const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password;
    }), queue: z.enum(["important_now", "earlier", "archive"]), verificationState: z.enum(["verified", "review_only"]),
    publishedAt: z.string().datetime({ offset: true }).optional(),
  }).strict()).max(50), nextCursor: id.nullable(),
}).strict().refine(page => page.availability !== "not_configured" || (!page.stories.length && page.nextCursor === null && !page.canPrepare));
export type NewsPage = z.infer<typeof newsPageSchema>;
