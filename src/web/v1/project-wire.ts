import { z } from "zod";
import { PRODUCT_CONFIGURATION_MODULES_V1 } from "../../config/v1/product-configuration";
import { PROJECT_PRESENTATION_SCHEMA_V1, projectTemplateSelectionSchemaV1 } from "../../config/v1/project-presentation";

const text = (max: number, multiline = false) => z.string().trim().max(max).refine(value => ![...value].some(char =>
  (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !(multiline && ["\n", "\r", "\t"].includes(char))));
const moduleName = z.enum(PRODUCT_CONFIGURATION_MODULES_V1);

/** Effective presentation derived on read. Carries the immutable historical snapshot
 * and the currently-available module list separately so the browser can render
 * unavailable features honestly without rewriting history. */
export const effectiveProjectPresentationSchemaV1 = z.object({ schema: z.literal(PROJECT_PRESENTATION_SCHEMA_V1),
  templateId: z.string(), templateDisplayName: z.string(), displayName: z.string(),
  enabledModules: z.array(moduleName).max(PRODUCT_CONFIGURATION_MODULES_V1.length),
  availableModules: z.array(moduleName).max(PRODUCT_CONFIGURATION_MODULES_V1.length),
  templateRemoved: z.boolean(), source: z.enum(["saved", "legacy_global"]) }).strict();
export type EffectiveProjectPresentation = z.infer<typeof effectiveProjectPresentationSchemaV1>;

/** Optional selection alongside title/summary. The browser never supplies modules or display names. */
export const projectCreateSchema = z.object({
  title: text(120).pipe(z.string().min(1)),
  summary: text(1000, true),
  templateSelection: projectTemplateSelectionSchemaV1.optional(),
}).strict();
export const lifecycleSchema = z.enum(["active", "paused", "completed", "archived"]);
export const projectTransitionSchema = z.object({ lifecycle: lifecycleSchema,
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) }).strict();
export const webProjectSchema = z.object({ projectId: z.string().regex(/^project:[A-Za-z0-9:_-]{1,160}$/),
  title: text(120).pipe(z.string().min(1)), summary: text(1000, true), lifecycle: lifecycleSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  presentation: effectiveProjectPresentationSchemaV1.optional() }).strict();
export type WebProject = z.infer<typeof webProjectSchema>;

// Idea projects retain their existing logical ID alphabet; this is navigation, never authority.
export const catalogProjectIdSchema = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const ideaProjectActionSchema = z.enum(["pause", "resume", "complete", "archive", "reopen"]);
export type IdeaProjectAction = z.infer<typeof ideaProjectActionSchema>;
export const ideaProjectActionTarget = { pause: "paused", resume: "active", complete: "completed", archive: "archived", reopen: "active" } as const;
export const ideaProjectTransitionSchema = z.object({ action: ideaProjectActionSchema,
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) }).strict();
export const ideaLifecycleProjectSchema = webProjectSchema.extend({ projectId: catalogProjectIdSchema }).strict();
export const projectViewSchema = webProjectSchema.extend({ projectId: catalogProjectIdSchema,
  origin: z.enum(["ordinary", "idea_lab"]), lifecycleEditable: z.boolean(),
  sourceIdeaSessionId: catalogProjectIdSchema.optional(),
  ideaLifecycleActions: z.array(ideaProjectActionSchema).max(5).optional(),
  presentation: effectiveProjectPresentationSchemaV1.optional() }).strict()
  .refine(project => project.origin === "ordinary" ? project.ideaLifecycleActions === undefined && project.sourceIdeaSessionId === undefined
    : project.lifecycleEditable === !!project.ideaLifecycleActions?.length
      && new Set(project.ideaLifecycleActions).size === (project.ideaLifecycleActions?.length ?? 0));
export const projectCatalogPageSchema = z.object({ projects: z.array(projectViewSchema).max(50),
  nextCursor: catalogProjectIdSchema.nullable(), canCreate: z.boolean(),
  sources: z.object({ ordinary: z.enum(["included", "not_authorized"]),
    ideas: z.enum(["included", "not_authorized", "not_configured"]) }).strict() }).strict();
export type ProjectView = z.infer<typeof projectViewSchema>;
export type ProjectCatalogPage = z.infer<typeof projectCatalogPageSchema>;
