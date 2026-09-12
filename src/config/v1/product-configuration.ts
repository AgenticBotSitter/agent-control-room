import { z } from "zod";

/**
 * Portable, non-secret product presentation/configuration.  This deliberately
 * excludes deployment and runtime wiring (origins, credentials, paths,
 * database settings, audiences, and factories belong to their respective
 * owner-attended/runtime contracts).
 */
export const PRODUCT_CONFIGURATION_SCHEMA_V1 = "control-room.product-configuration/v1" as const;

export const PRODUCT_CONFIGURATION_MODULES_V1 = ["ideaLab", "news", "sessionObservations"] as const;
type ProductConfigurationModuleV1 = typeof PRODUCT_CONFIGURATION_MODULES_V1[number];

const templateId = z.string().min(3).max(96).regex(/^[a-z][a-z0-9-]*$/);
const displayName = z.string().trim().min(1).max(120);
const moduleName = z.enum(PRODUCT_CONFIGURATION_MODULES_V1);

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

const modulesSchema = z.object({
  ideaLab: z.boolean().default(false),
  news: z.boolean().default(false),
  sessionObservations: z.boolean().default(false),
}).strict().default({ ideaLab: false, news: false, sessionObservations: false });

/** Finite UI ceilings, not scheduling, authorization, or runtime limits. */
const limitsSchema = z.object({
  maxProjects: z.number().int().min(1).max(1_000),
  maxTasksPerProject: z.number().int().min(1).max(10_000),
  maxResultsPerTask: z.number().int().min(1).max(1_000),
  maxArticleSources: z.number().int().min(0).max(1_000),
  maxIdeaParticipants: z.number().int().min(0).max(100),
}).strict();

const templateSchema = z.object({
  id: templateId,
  displayName,
  enabledModules: z.array(moduleName).max(PRODUCT_CONFIGURATION_MODULES_V1.length),
}).strict().superRefine((template, context) => {
  if (new Set(template.enabledModules).size !== template.enabledModules.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledModules"], message: "duplicate_template_module" });
  }
});

export const productConfigurationSchemaV1 = z.object({
  schema: z.literal(PRODUCT_CONFIGURATION_SCHEMA_V1),
  displayName,
  defaultTimezone: z.string().min(1).max(100).refine(isTimezone, "invalid_timezone"),
  modules: modulesSchema,
  limits: limitsSchema,
  projectTemplates: z.array(templateSchema).min(1).max(100),
}).strict().superRefine((configuration, context) => {
  const ids = new Set<string>();
  for (const [index, template] of configuration.projectTemplates.entries()) {
    if (ids.has(template.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectTemplates", index, "id"], message: "duplicate_template_id" });
    }
    ids.add(template.id);
    for (const module of template.enabledModules) {
      if (!configuration.modules[module]) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectTemplates", index, "enabledModules"], message: "template_module_not_enabled" });
      }
    }
  }
});

export type ProductConfigurationV1 = z.infer<typeof productConfigurationSchemaV1>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(configuration: ProductConfigurationV1): ProductConfigurationV1 {
  const modules = Object.fromEntries(PRODUCT_CONFIGURATION_MODULES_V1.map((module) => [module, configuration.modules[module]])) as ProductConfigurationV1["modules"];
  return {
    schema: PRODUCT_CONFIGURATION_SCHEMA_V1,
    displayName: configuration.displayName,
    defaultTimezone: configuration.defaultTimezone,
    modules,
    limits: { ...configuration.limits },
    projectTemplates: configuration.projectTemplates
      .map((template) => ({ ...template, enabledModules: PRODUCT_CONFIGURATION_MODULES_V1.filter((module) => template.enabledModules.includes(module)) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/** Parses an untrusted JSON-safe value into an isolated, immutable portable configuration. */
export function parseProductConfigurationV1(value: unknown): Readonly<ProductConfigurationV1> {
  return deepFreeze(canonicalize(productConfigurationSchemaV1.parse(value)));
}

/** Canonical JSON is stable across equivalent template/module ordering and safe to export. */
export function exportProductConfigurationV1(value: unknown): string {
  return JSON.stringify(parseProductConfigurationV1(value));
}
