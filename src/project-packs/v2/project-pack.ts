import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { isModuleSemverV1 } from "../../modules/v1/manifest";
import {
  PORTABLE_PRINTABLE_TEXT_V1,
  assertNoPortablePrototypePollutionV1,
  assertPortableGuardedTextV1,
  assertPortableInputSizeV1,
} from "../../security/inert-portable-input";

export const PROJECT_PACK_SCHEMA_V2 = "control-room.project-pack/v2" as const;

const MAX_PACK_BYTES = 65_536;
const MODULE_ID_PATTERN = /^[a-z][A-Za-z0-9.-]{2,63}$/;
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+:-]{0,39}$/;
const moduleReferenceSchema = z.object({
  id: z.string().regex(MODULE_ID_PATTERN, "project_pack_module_id_invalid"),
  version: z.string().refine(isModuleSemverV1, "project_pack_module_version_invalid"),
}).strict();

const projectPackSchemaV2 = z.object({
  schema: z.literal(PROJECT_PACK_SCHEMA_V2),
  title: z.string().min(1).max(120).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_title_not_printable"),
  summary: z.string().min(1).max(2000).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_summary_not_printable"),
  modules: z.array(moduleReferenceSchema).max(100),
  setupGuidance: z.array(
    z.string().min(1).max(1000).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_guidance_not_printable"),
  ).max(10),
  attribution: z.string().min(1).max(120).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "project_pack_attribution_not_printable").optional(),
  license: z.string().min(1).max(40).regex(LICENSE_PATTERN, "project_pack_license_not_spdx_shaped").optional(),
}).strict().superRefine((pack, context) => {
  const ids = pack.modules.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["modules"], message: "project_pack_duplicate_module" });
  }
  const canonical = [...pack.modules].sort((left, right) => left.id.localeCompare(right.id));
  if (canonical.some((module, index) => module.id !== pack.modules[index]?.id
    || module.version !== pack.modules[index]?.version)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["modules"], message: "project_pack_non_canonical_module_order" });
  }
});

export type ProjectPackV2 = z.infer<typeof projectPackSchemaV2>;
export type ProjectPackModuleReferenceV2 = ProjectPackV2["modules"][number];

function assertGuardedText(field: string, value: string): void {
  assertPortableGuardedTextV1("project_pack", field, value);
}

function guardAllText(pack: ProjectPackV2): void {
  assertGuardedText("title", pack.title);
  assertGuardedText("summary", pack.summary);
  for (const item of pack.setupGuidance) assertGuardedText("guidance", item);
  if (pack.attribution !== undefined) assertGuardedText("attribution", pack.attribution);
  if (pack.license !== undefined) assertGuardedText("license", pack.license);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export function parseProjectPackV2(value: unknown): Readonly<ProjectPackV2> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("project_pack_malformed");
  assertPortableInputSizeV1("project_pack", value, MAX_PACK_BYTES);
  if ((value as Record<string, unknown>).schema !== PROJECT_PACK_SCHEMA_V2) throw new Error("project_pack_unknown_version");
  assertNoPortablePrototypePollutionV1("project_pack", value, 8);
  const parsed = projectPackSchemaV2.parse(value);
  guardAllText(parsed);
  return deepFreeze({ ...parsed, modules: parsed.modules.map((module) => ({ ...module })) });
}

export interface ProjectPackBuildInputV2 {
  readonly title: string;
  readonly summary: string;
  readonly modules?: readonly ProjectPackModuleReferenceV2[];
  readonly setupGuidance?: readonly string[];
  readonly attribution?: string;
  readonly license?: string;
}

export function buildProjectPackV2(input: ProjectPackBuildInputV2): Readonly<ProjectPackV2> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("project_pack_malformed");
  const allowedKeys = new Set(["title", "summary", "modules", "setupGuidance", "attribution", "license"]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error("project_pack_unknown_key");
  }
  const modules = [...(input.modules ?? [])].map((module) => ({ ...module }));
  if (new Set(modules.map(({ id }) => id)).size !== modules.length) throw new Error("project_pack_duplicate_module");
  modules.sort((left, right) => left.id.localeCompare(right.id));
  return parseProjectPackV2({
    schema: PROJECT_PACK_SCHEMA_V2,
    title: input.title,
    summary: input.summary,
    modules,
    setupGuidance: [...(input.setupGuidance ?? [])],
    ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    ...(input.license === undefined ? {} : { license: input.license }),
  });
}

export function exportProjectPackV2(pack: Readonly<ProjectPackV2>): string {
  return canonicalJson(parseProjectPackV2(pack));
}

export function projectPackDigestV2(pack: Readonly<ProjectPackV2>): string {
  return sha256Digest({ namespace: PROJECT_PACK_SCHEMA_V2, value: parseProjectPackV2(pack) });
}
