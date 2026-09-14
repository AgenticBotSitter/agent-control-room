import { z } from "zod";
import { PRODUCT_CONFIGURATION_MODULES_V1, type ProductConfigurationV1 } from "./product-configuration";

/**
 * Per-project presentation snapshot.
 *
 * The browser never supplies a module list or display name; the server derives
 * them from a trusted product configuration at create time, captures the digest,
 * and persists the snapshot immutably. Reads recompute *current* availability
 * by intersecting the saved snapshot with the running global module flags, but
 * the historical receipt is preserved unchanged.
 */

export const PROJECT_PRESENTATION_SCHEMA_V1 = "control-room.project-presentation/v1" as const;
export type ProjectPresentationModuleV1 = typeof PRODUCT_CONFIGURATION_MODULES_V1[number];

const templateIdSchema = z.string().min(3).max(96).regex(/^[a-z][a-z0-9-]*$/);
const moduleNameSchema = z.enum(PRODUCT_CONFIGURATION_MODULES_V1);
const displayNameSchema = z.string().trim().min(1).max(120);

/** Saved presentation as persisted in `projects.payload.presentation`. */
export const projectPresentationSchemaV1 = z.object({
  schema: z.literal(PROJECT_PRESENTATION_SCHEMA_V1),
  templateId: templateIdSchema,
  configurationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  templateDisplayName: displayNameSchema,
  enabledModules: z.array(moduleNameSchema).max(PRODUCT_CONFIGURATION_MODULES_V1.length),
}).strict().superRefine((value, context) => {
  if (new Set(value.enabledModules).size !== value.enabledModules.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledModules"], message: "duplicate_presentation_module" });
  }
  const ordered = PRODUCT_CONFIGURATION_MODULES_V1.filter((module) => value.enabledModules.includes(module));
  if (ordered.length !== value.enabledModules.length
    || ordered.some((module, index) => module !== value.enabledModules[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledModules"], message: "presentation_module_order_invalid" });
  }
});

export type ProjectPresentationV1 = z.infer<typeof projectPresentationSchemaV1>;

/** Browser-supplied create-time selection. Only template id + digest, never modules or display names. */
export const projectTemplateSelectionSchemaV1 = z.object({
  templateId: templateIdSchema,
  configurationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export type ProjectTemplateSelectionV1 = z.infer<typeof projectTemplateSelectionSchemaV1>;

/** A template exists in trusted configuration and is selectable. */
export interface ProjectTemplateCandidateV1 {
  readonly templateId: string;
  readonly displayName: string;
  readonly enabledModules: readonly ProjectPresentationModuleV1[];
}

export class ProjectPresentationError extends Error {
  constructor(readonly code:
    "missing_configuration" | "unknown_template" | "stale_digest" | "disabled_modules" | "malformed_stored") {
    super(code);
  }
}

function canonicalizeEnabledModules(modules: readonly ProjectPresentationModuleV1[]): ProjectPresentationModuleV1[] {
  return PRODUCT_CONFIGURATION_MODULES_V1.filter((module) => modules.includes(module));
}

/** Resolve a template id to its trusted definition. Strict: no fallback. */
export function resolveProjectTemplateV1(productConfiguration: Readonly<ProductConfigurationV1>,
  templateId: string): ProjectTemplateCandidateV1 {
  const template = productConfiguration.projectTemplates.find((candidate) => candidate.id === templateId);
  if (!template) throw new ProjectPresentationError("unknown_template");
  return {
    templateId: template.id,
    displayName: template.displayName,
    enabledModules: canonicalizeEnabledModules(template.enabledModules),
  };
}

/** Verify a browser-supplied selection matches the trusted configuration exactly. */
export function verifyProjectTemplateSelectionV1(productConfiguration: Readonly<ProductConfigurationV1>,
  selection: ProjectTemplateSelectionV1, configurationDigest: string): ProjectTemplateCandidateV1 {
  if (selection.configurationDigest !== configurationDigest) throw new ProjectPresentationError("stale_digest");
  const template = resolveProjectTemplateV1(productConfiguration, selection.templateId);
  for (const module of template.enabledModules) {
    if (!productConfiguration.modules[module]) throw new ProjectPresentationError("disabled_modules");
  }
  return template;
}

/** Build the immutable presentation snapshot that gets stored in the project payload. */
export function buildProjectPresentationV1(template: ProjectTemplateCandidateV1, configurationDigest: string):
  Readonly<ProjectPresentationV1> {
  return Object.freeze({
    schema: PROJECT_PRESENTATION_SCHEMA_V1,
    templateId: template.templateId,
    configurationDigest,
    templateDisplayName: template.displayName,
    enabledModules: Object.freeze([...template.enabledModules]) as ProjectPresentationModuleV1[],
  });
}

/**
 * Read a stored presentation snapshot from either a bare presentation object or
 * a project payload that carries one under `.presentation`. Returns `undefined`
 * for legacy rows that carry no presentation field at all. Throws on malformed
 * stored presentation: a caller must never silently fall back to legacy behavior
 * when stored presentation is corrupt — only absence is legacy.
 */
export function parseStoredProjectPresentationV1(value: unknown): Readonly<ProjectPresentationV1> | undefined {
  const record = (typeof value === "object" && value !== null) ? value as Record<string, unknown> : null;
  if (!record) return undefined;
  // Distinguish a bare presentation object from a project payload. A bare presentation
  // carries the schema literal; a payload never does (payloads carry `projectKind`/`origin`).
  const looksLikeBarePresentation = "schema" in record && !("projectKind" in record) && !("origin" in record);
  const presentationValue = looksLikeBarePresentation
    ? value : ("presentation" in record ? record.presentation : undefined);
  if (presentationValue === undefined || presentationValue === null) return undefined;
  const parsed = projectPresentationSchemaV1.safeParse(presentationValue);
  if (!parsed.success) throw new ProjectPresentationError("malformed_stored");
  return Object.freeze({
    schema: PROJECT_PRESENTATION_SCHEMA_V1,
    templateId: parsed.data.templateId,
    configurationDigest: parsed.data.configurationDigest,
    templateDisplayName: parsed.data.templateDisplayName,
    enabledModules: Object.freeze([...parsed.data.enabledModules]) as ProjectPresentationModuleV1[],
  });
}

/** Compute current availability: stored snapshot intersected with currently enabled global modules. */
export function computeAvailableProjectModulesV1(stored: Readonly<ProjectPresentationV1>,
  productConfiguration: Readonly<ProductConfigurationV1>): ProjectPresentationModuleV1[] {
  return stored.enabledModules.filter((module) => productConfiguration.modules[module]);
}

/**
 * Effective presentation for the wire. Always carries the immutable historical
 * snapshot; reports availability separately so the client can render an
 * "unavailable-template" explanation without rewriting history.
 */
export interface EffectiveProjectPresentationV1 {
  readonly schema: typeof PROJECT_PRESENTATION_SCHEMA_V1;
  readonly templateId: string;
  readonly templateDisplayName: string;
  readonly enabledModules: readonly ProjectPresentationModuleV1[];
  readonly availableModules: readonly ProjectPresentationModuleV1[];
  readonly templateRemoved: boolean;
  readonly displayName: string;
  readonly source: "saved" | "legacy_global";
}

export function computeEffectiveProjectPresentationV1(stored: Readonly<ProjectPresentationV1> | undefined,
  productConfiguration: Readonly<ProductConfigurationV1> | undefined): EffectiveProjectPresentationV1 {
  if (stored) {
    const templateStillConfigured = productConfiguration
      ? productConfiguration.projectTemplates.some((template) => template.id === stored.templateId) : false;
    const available: ProjectPresentationModuleV1[] = productConfiguration && templateStillConfigured
      ? computeAvailableProjectModulesV1(stored, productConfiguration) : [];
    return Object.freeze({
      schema: PROJECT_PRESENTATION_SCHEMA_V1,
      templateId: stored.templateId,
      templateDisplayName: stored.templateDisplayName,
      enabledModules: Object.freeze([...stored.enabledModules]) as readonly ProjectPresentationModuleV1[],
      availableModules: Object.freeze(available) as readonly ProjectPresentationModuleV1[],
      templateRemoved: !templateStillConfigured,
      displayName: stored.templateDisplayName,
      source: "saved" as const,
    });
  }
  // Legacy project: the global modules that are currently enabled, no template id.
  const modules: ProjectPresentationModuleV1[] = productConfiguration
    ? PRODUCT_CONFIGURATION_MODULES_V1.filter((module) => productConfiguration.modules[module])
    : [];
  return Object.freeze({
    schema: PROJECT_PRESENTATION_SCHEMA_V1,
    templateId: "",
    templateDisplayName: "",
    enabledModules: Object.freeze([]) as readonly ProjectPresentationModuleV1[],
    availableModules: Object.freeze(modules) as readonly ProjectPresentationModuleV1[],
    templateRemoved: false,
    displayName: "",
    source: "legacy_global" as const,
  });
}
