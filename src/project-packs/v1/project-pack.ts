import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { PRODUCT_CONFIGURATION_MODULES_V1 } from "../../config/v1/product-configuration";
import {
  PORTABLE_PRINTABLE_TEXT_V1,
  assertNoPortablePrototypePollutionV1,
  assertPortableGuardedTextV1,
  assertPortableInputSizeV1,
} from "../../security/inert-portable-input";

/**
 * Portable project packs (v1): effect-free, inert descriptors.
 *
 * A pack carries only sanitized descriptive fields — purpose, title/summary,
 * optional locally supported modules, human-readable setup guidance.  It never
 * carries project IDs, tasks, results, reviews, credentials, worker
 * identities, host paths, credentialed URLs, authority grants, schedules,
 * live connector settings, database identifiers, or executable code.
 *
 * Everything here is pure: no reads of project records, no writes, no
 * network, no permission grants.  Existing modules are imported, never edited.
 */

export const PROJECT_PACK_SCHEMA_V1 = "control-room.project-pack/v1" as const;

type ProjectPackModuleV1 = (typeof PRODUCT_CONFIGURATION_MODULES_V1)[number];

/** Finite text ceilings for every free-text field. */
const TITLE_MIN = 1;
const TITLE_MAX = 120;
const SUMMARY_MIN = 1;
const SUMMARY_MAX = 2000;
const GUIDANCE_ITEMS_MAX = 10;
const GUIDANCE_ITEM_MIN = 1;
const GUIDANCE_ITEM_MAX = 1000;
/** Raw-input ceiling: the field ceilings bound legitimate packs near ~13KB. */
export const PROJECT_PACK_MAX_BYTES_V1 = 65536;
/** SPDX-expression shape: starts alnum, then alnum and . + - : markers. */
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+:-]{0,39}$/;
const ATTRIBUTION_MIN = 1;
const ATTRIBUTION_MAX = 120;

const moduleName = z.enum(PRODUCT_CONFIGURATION_MODULES_V1);

function assertGuardedText(field: string, value: string): void {
  assertPortableGuardedTextV1("project_pack", field, value);
}

const projectPackSchemaV1 = z
  .object({
    schema: z.literal(PROJECT_PACK_SCHEMA_V1),
    title: z.string().min(TITLE_MIN).max(TITLE_MAX).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_title_not_printable"),
    summary: z.string().min(SUMMARY_MIN).max(SUMMARY_MAX).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_summary_not_printable"),
    optionalModules: z.array(moduleName).max(PRODUCT_CONFIGURATION_MODULES_V1.length),
    setupGuidance: z
      .array(z.string().min(GUIDANCE_ITEM_MIN).max(GUIDANCE_ITEM_MAX).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_guidance_not_printable"))
      .max(GUIDANCE_ITEMS_MAX),
    attribution: z
      .string()
      .min(ATTRIBUTION_MIN)
      .max(ATTRIBUTION_MAX)
      .refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_attribution_not_printable")
      .optional(),
    license: z
      .string()
      .min(1)
      .max(40)
      .refine((value) => LICENSE_PATTERN.test(value), "project_pack_license_not_spdx_shaped")
      .optional(),
  })
  .strict()
  .superRefine((pack, context) => {
    if (new Set(pack.optionalModules).size !== pack.optionalModules.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["optionalModules"], message: "project_pack_duplicate_module" });
    }
    const canonical = PRODUCT_CONFIGURATION_MODULES_V1.filter((module) => pack.optionalModules.includes(module));
    if (canonical.join(",") !== pack.optionalModules.join(",")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["optionalModules"], message: "project_pack_non_canonical_module_order" });
    }
  });

export type ProjectPackV1 = z.infer<typeof projectPackSchemaV1>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function guardAllText(pack: ProjectPackV1): void {
  assertGuardedText("title", pack.title);
  assertGuardedText("summary", pack.summary);
  for (const item of pack.setupGuidance) assertGuardedText("guidance", item);
  if (pack.attribution !== undefined) assertGuardedText("attribution", pack.attribution);
  if (pack.license !== undefined) assertGuardedText("license", pack.license);
}

/**
 * Parse untrusted input into an isolated, immutable pack.  Unknown schema
 * versions are refused visibly and never reinterpreted as v1.
 */
export function parseProjectPackV1(value: unknown): Readonly<ProjectPackV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("project_pack_malformed");
  assertPortableInputSizeV1("project_pack", value, PROJECT_PACK_MAX_BYTES_V1);
  const schema = (value as Record<string, unknown>)["schema"];
  if (schema !== PROJECT_PACK_SCHEMA_V1) throw new Error("project_pack_unknown_version");
  assertNoPortablePrototypePollutionV1("project_pack", value, 8);
  const parsed = projectPackSchemaV1.parse(value);
  guardAllText(parsed);
  const canonicalModules = PRODUCT_CONFIGURATION_MODULES_V1.filter((module) => parsed.optionalModules.includes(module));
  return deepFreeze({ ...parsed, optionalModules: canonicalModules });
}

export interface ProjectPackBuildInputV1 {
  title: string;
  summary: string;
  optionalModules?: readonly string[];
  setupGuidance?: readonly string[];
  attribution?: string;
  license?: string;
}

/**
 * Build a pack from explicitly supplied sanitized descriptive fields only.
 * Nothing is read from a project record and no runtime data is copied in.
 */
export function buildProjectPackV1(input: ProjectPackBuildInputV1): Readonly<ProjectPackV1> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("project_pack_malformed");
  const keys = new Set(Object.keys(input));
  for (const key of keys) {
    if (key !== "title" && key !== "summary" && key !== "optionalModules" && key !== "setupGuidance" && key !== "attribution" && key !== "license") {
      throw new Error("project_pack_unknown_key");
    }
  }
  const modules = [...(input.optionalModules ?? [])];
  if (new Set(modules).size !== modules.length) throw new Error("project_pack_duplicate_module");
  for (const module of modules) {
    if (!(PRODUCT_CONFIGURATION_MODULES_V1 as readonly string[]).includes(module)) throw new Error("project_pack_unknown_module");
  }
  const canonicalModules = (PRODUCT_CONFIGURATION_MODULES_V1 as readonly string[]).filter((module) => modules.includes(module));
  const candidate = {
    schema: PROJECT_PACK_SCHEMA_V1,
    title: input.title,
    summary: input.summary,
    optionalModules: canonicalModules,
    setupGuidance: [...(input.setupGuidance ?? [])],
    ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    ...(input.license === undefined ? {} : { license: input.license }),
  };
  return parseProjectPackV1(candidate);
}

/** Deterministic canonical JSON: stable across equivalent key ordering. */
export function exportProjectPackV1(pack: Readonly<ProjectPackV1>): string {
  return canonicalJson(parseProjectPackV1(pack));
}

/**
 * Domain-separated digest.  A changed byte that changes meaning changes the
 * digest; pure key-ordering differences do not.
 */
export function projectPackDigestV1(pack: Readonly<ProjectPackV1>): string {
  return sha256Digest({ namespace: PROJECT_PACK_SCHEMA_V1, value: parseProjectPackV1(pack) });
}

const localModulesSchema = z
  .object({
    ideaLab: z.boolean(),
    news: z.boolean(),
    sessionObservations: z.boolean(),
  })
  .strict();

export interface ProjectPackPreviewV1 {
  title: string;
  summary: string;
  setupGuidance: readonly string[];
  attribution: string | null;
  license: string | null;
  supportedModules: readonly ProjectPackModuleV1[];
  unsupportedModules: readonly ProjectPackModuleV1[];
  warnings: readonly string[];
}

/**
 * Resolve a pack against the trusted local product configuration and return
 * an inert preview.  Performs no write and grants no permission.
 */
export function previewProjectPackV1(
  pack: Readonly<ProjectPackV1>,
  localConfiguration: unknown,
): Readonly<ProjectPackPreviewV1> {
  const parsed = parseProjectPackV1(pack);
  const local = localModulesSchema.parse(localConfiguration);
  const supported = parsed.optionalModules.filter((module) => local[module]);
  const unsupported = parsed.optionalModules.filter((module) => !local[module]);
  const warnings = unsupported.map((module) => `module_not_supported_locally:${module}`);
  return deepFreeze({
    title: parsed.title,
    summary: parsed.summary,
    setupGuidance: [...parsed.setupGuidance],
    attribution: parsed.attribution ?? null,
    license: parsed.license ?? null,
    supportedModules: [...supported],
    unsupportedModules: [...unsupported],
    warnings,
  });
}
