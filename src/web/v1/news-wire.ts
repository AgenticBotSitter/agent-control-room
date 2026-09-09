import { z } from "zod";
import { projectViewSchema, catalogProjectIdSchema as id } from "./project-wire";
import { taskDraftSchema } from "./task-wire";

export const newsSourceSchema = z.object({ sourceId: id, label: z.string().min(1).max(180),
  mode: z.enum(["synthetic", "configured"]), state: z.enum(["available", "partial", "stale", "unavailable", "disabled"]),
  checkedAt: z.string().datetime({ offset: true }), lastSuccessfulAt: z.string().datetime({ offset: true }).optional(),
  itemCount: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine(s => (s.state !== "unavailable" || s.itemCount === undefined)
  && (!s.lastSuccessfulAt || Date.parse(s.lastSuccessfulAt) <= Date.parse(s.checkedAt)));

export const newsArticleActions = [
  { id: "research_brief", label: "Research this" },
  { id: "setup_guide", label: "Write a setup guide" },
  { id: "product_comparison", label: "Compare products" },
  { id: "abs_article_draft", label: "Draft an article" },
] as const;
export type NewsArticleAction = typeof newsArticleActions[number]["id"];
export const newsResearchInputSchema = z.object({ storyId: id,
  storyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  action: z.enum(["research_brief", "setup_guide", "product_comparison", "abs_article_draft"]), goal: z.string().trim().min(1).max(1200),
}).strict();
export const newsResearchPreviewSchema = z.object({ projectId: id, storyId: id,
  storyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), draft: taskDraftSchema,
  saved: z.literal(false), dispatch: z.literal("not_requested"),
}).strict();

export const newsPageSchema = z.object({ project: projectViewSchema,
  availability: z.enum(["configured", "not_configured"]), observedAt: z.string().datetime(), canPrepare: z.boolean(), canArchive: z.boolean().default(false),
  sources: z.array(newsSourceSchema).max(50), sourcesNextCursor: id.nullable(),
  stories: z.array(z.object({ storyId: id, storyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    title: z.string().min(1).max(240), summary: z.string().max(4000),
    canonicalUrl: z.string().url().max(2048).refine(value => {
      const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password;
    }), queue: z.enum(["important_now", "earlier", "archive"]), verificationState: z.enum(["verified", "review_only"]),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    discoveredAt: z.string().datetime({ offset: true }).optional(), archiveRevision: z.number().int().min(0).max(2_147_483_647).optional(),
    sourceLabel: z.string().min(1).max(180).optional(), priorityScore: z.number().min(0).max(100).optional(),
  }).strict()).max(50), nextCursor: id.nullable(),
}).strict().refine(page => page.availability !== "not_configured" || (!page.stories.length && !page.sources.length && page.sourcesNextCursor === null && page.nextCursor === null && !page.canPrepare && !page.canArchive));
export type NewsPage = z.infer<typeof newsPageSchema>;
