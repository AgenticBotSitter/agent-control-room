import { z } from "zod";
import {
  PORTABLE_PRINTABLE_TEXT_V1,
  assertNoHiddenTextV1,
  assertNoPortablePrototypePollutionV1,
  assertPortableGuardedTextV1,
  assertPortableInputSizeV1,
} from "../../security/inert-portable-input";
// The barrel (`../../security`) re-exports digest.ts and rollback-checkpoint.ts,
// which import host-value.ts, which reads node:util intrinsics at import time and
// throws `host intrinsics unavailable` in a browser — blanking the page. The
// module registry is reachable from the client graph through
// src/config/v1/product-configuration, so importing the barrel here pulled that
// code into every browser chunk. sha256Digest itself lives in
// canonical-digest.ts, which only needs node:crypto's createHash and is
// browser-safe, so import it directly. See also the same split in
// src/modules/v1/install-approvals.ts, which is not in the client graph.
import { sha256Digest } from "../../security/canonical-digest";

/** Portable, inert module declaration. It contains data only and grants nothing by itself. */
export const MODULE_MANIFEST_SCHEMA_V1 = "control-room.module-manifest/v1" as const;

const MAX_MANIFEST_BYTES = 131_072;
const MODULE_ID_PATTERN = /^[a-z][A-Za-z0-9.-]{2,63}$/;
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9.-]{2,95}$/;
const RESOURCE_PATTERN = /^[a-z][a-z0-9_]{2,95}$/;
const SEMVER_SOURCE = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMVER_PATTERN = new RegExp(`^${SEMVER_SOURCE}$`);
const COMPATIBILITY_RANGE_PATTERN = new RegExp(
  `^(?:(?:\\^|~|>=|<=|>|<)?${SEMVER_SOURCE})(?: (?:(?:>=|<=|>|<)${SEMVER_SOURCE}))*$`,
);
const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+:-]{0,39}$/;
const moduleIdSchema = z.string().regex(MODULE_ID_PATTERN, "module_manifest_id_invalid");
const semverSchema = z.string().regex(SEMVER_PATTERN, "module_manifest_semver_invalid");
const identifierSchema = z.string().regex(CAPABILITY_ID_PATTERN, "module_manifest_identifier_invalid");
const resourceSchema = z.string().regex(RESOURCE_PATTERN, "module_manifest_resource_invalid");
const boundedText = z.string().min(1).max(200).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "module_manifest_text_not_printable");

const settingValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const settingSchema = z.object({
  type: z.enum(["string", "boolean", "integer", "number"]),
  title: boundedText,
  description: z.string().max(1000).refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "module_manifest_text_not_printable").optional(),
  default: settingValueSchema.optional(),
  enum: z.array(settingValueSchema).min(1).max(100).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  maxLength: z.number().int().min(1).max(10_000).optional(),
}).strict().superRefine((setting, context) => {
  if (setting.minimum !== undefined && setting.maximum !== undefined && setting.minimum > setting.maximum) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["minimum"], message: "module_manifest_setting_bounds_invalid" });
  }
  if (setting.default !== undefined && !settingValueMatchesType(setting.default, setting.type)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["default"], message: "module_manifest_setting_default_invalid" });
  }
  if (setting.enum?.some((value) => !settingValueMatchesType(value, setting.type))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enum"], message: "module_manifest_setting_enum_invalid" });
  }
});

function settingValueMatchesType(value: string | number | boolean, type: "string" | "boolean" | "integer" | "number"): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === "number";
}

const settingsSchema = z.object({
  type: z.literal("object"),
  properties: z.record(identifierSchema, settingSchema).refine(
    (properties) => Object.keys(properties).length <= 100,
    "module_manifest_too_many_settings",
  ),
  required: z.array(identifierSchema).max(100).default([]),
  additionalProperties: z.literal(false),
}).strict().superRefine((schema, context) => {
  if (new Set(schema.required).size !== schema.required.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["required"], message: "module_manifest_duplicate_setting" });
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(schema.properties, key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["required"], message: "module_manifest_unknown_required_setting" });
    }
  }
});

const permissionSchema = z.object({
  projectData: z.array(z.object({
    resource: resourceSchema,
    access: z.array(z.enum(["read", "write"])).min(1).max(2),
  }).strict()).max(100),
  taskTemplates: z.array(identifierSchema).max(100),
  pipelineTemplates: z.array(identifierSchema).max(100),
  workerCapabilities: z.array(identifierSchema).max(100),
  notifications: z.object({
    slots: z.array(identifierSchema).max(20),
    maxPerHour: z.number().int().min(0).max(10_000),
  }).strict(),
  attention: z.object({
    slots: z.array(identifierSchema).max(20),
    maxOpenPerProject: z.number().int().min(0).max(1_000),
  }).strict(),
  scheduledJobs: z.object({
    jobs: z.array(identifierSchema).max(50),
    maxConcurrent: z.number().int().min(0).max(100),
    maxRunsPerDay: z.number().int().min(0).max(10_000),
    maxRuntimeSeconds: z.number().int().min(0).max(86_400),
  }).strict(),
}).strict().superRefine((permissions, context) => {
  const resources = permissions.projectData.map(({ resource }) => resource);
  if (new Set(resources).size !== resources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectData"], message: "module_manifest_duplicate_resource" });
  }
  for (const [index, permission] of permissions.projectData.entries()) {
    if (new Set(permission.access).size !== permission.access.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["projectData", index, "access"], message: "module_manifest_duplicate_access" });
    }
  }
  for (const [field, values] of [
    ["taskTemplates", permissions.taskTemplates],
    ["pipelineTemplates", permissions.pipelineTemplates],
    ["workerCapabilities", permissions.workerCapabilities],
    ["notifications.slots", permissions.notifications.slots],
    ["attention.slots", permissions.attention.slots],
    ["scheduledJobs.jobs", permissions.scheduledJobs.jobs],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "module_manifest_duplicate_permission" });
    }
  }
  if (permissions.scheduledJobs.jobs.length === 0
    && (permissions.scheduledJobs.maxConcurrent !== 0
      || permissions.scheduledJobs.maxRunsPerDay !== 0
      || permissions.scheduledJobs.maxRuntimeSeconds !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduledJobs"], message: "module_manifest_schedule_limits_without_jobs" });
  }
});

const migrationSchema = z.object({
  version: semverSchema,
  upFile: z.string().regex(/^[a-z0-9][a-z0-9._/-]*\.sql$/, "module_manifest_migration_path_invalid"),
  downFile: z.string().regex(/^[a-z0-9][a-z0-9._/-]*\.sql$/, "module_manifest_migration_path_invalid"),
}).strict();

const sharedSkillSchema = z.object({
  id: identifierSchema,
  version: z.number().int().positive().max(1_000_000),
  name: boundedText,
  instructions: z.string().min(1).max(12_000)
    .refine((value) => PORTABLE_PRINTABLE_TEXT_V1.test(value), "module_manifest_text_not_printable"),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((skill, context) => {
  const expected = sha256Digest({ schema: "control-room.module-shared-skill/v1", id: skill.id,
    version: skill.version, name: skill.name, instructions: skill.instructions });
  if (skill.contentDigest !== expected)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contentDigest"], message: "module_manifest_skill_digest_invalid" });
});

const moduleManifestSchemaV1 = z.object({
  schema: z.literal(MODULE_MANIFEST_SCHEMA_V1),
  id: moduleIdSchema,
  version: semverSchema,
  name: boundedText,
  publisher: boundedText,
  license: z.string().min(1).max(40).regex(LICENSE_PATTERN, "module_manifest_license_invalid"),
  controlRoomCompatibility: z.string().max(120).regex(COMPATIBILITY_RANGE_PATTERN, "module_manifest_compatibility_invalid"),
  class: z.enum(["declarative", "code"]),
  skills: z.array(sharedSkillSchema).max(50).optional(),
  permissions: permissionSchema,
  data: z.object({
    schemaNamespace: z.string().regex(/^module_[a-z][a-z0-9_]{2,55}$/, "module_manifest_namespace_invalid"),
    tenantScoped: z.literal(true),
    projectScoped: z.literal(true),
    migrations: z.array(migrationSchema).max(100),
  }).strict().optional(),
  ui: z.object({
    projectTabs: z.array(z.object({ id: identifierSchema, label: boundedText }).strict()).max(20),
    settings: settingsSchema.optional(),
    navEntry: z.object({ id: identifierSchema, label: boundedText }).strict().optional(),
    needsYou: z.boolean(),
  }).strict(),
  events: z.object({
    subscribe: z.array(identifierSchema).max(100),
    emitNotifications: z.boolean(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (manifest.skills?.length && manifest.class !== "declarative")
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["skills"], message: "module_manifest_skills_require_declarative_class" });
  if (manifest.skills && new Set(manifest.skills.map(skill => `${skill.id}:${skill.version}`)).size !== manifest.skills.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["skills"], message: "module_manifest_duplicate_skill" });
  if (manifest.data !== undefined) {
    const expectedNamespace = `module_${manifest.id
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[.-]/g, "_")
      .toLowerCase()}`;
    if (manifest.data.schemaNamespace !== expectedNamespace) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["data", "schemaNamespace"], message: "module_manifest_namespace_mismatch" });
    }
    const versions = manifest.data.migrations.map(({ version }) => version);
    if (new Set(versions).size !== versions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["data", "migrations"], message: "module_manifest_duplicate_migration" });
    }
  }
});

export type ModuleManifestV1 = z.infer<typeof moduleManifestSchemaV1>;

function assertGuardedText(value: unknown, path: string): void {
  if (typeof value === "string") {
    assertPortableGuardedTextV1("module_manifest", path, value);
    // The shared guard blocks script and credential/authority wording, but not
    // invisible or direction-changing characters: the owner's approval card
    // shows `name` and `publisher` verbatim, so every manifest string gets the
    // same character allowlist as declarative file text.
    assertNoHiddenTextV1(value, `module_manifest_${path}_hidden_text`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertGuardedText(item, `${path}_${index}`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertGuardedText(item, `${path}_${key}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Strictly parses untrusted inert data. Unknown keys and unsafe text fail closed. */
export function parseModuleManifestV1(value: unknown): Readonly<ModuleManifestV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("module_manifest_malformed");
  assertPortableInputSizeV1("module_manifest", value, MAX_MANIFEST_BYTES);
  if ((value as Record<string, unknown>).schema !== MODULE_MANIFEST_SCHEMA_V1) throw new Error("module_manifest_unknown_version");
  assertNoPortablePrototypePollutionV1("module_manifest", value, 12);
  assertGuardedText(value, "value");
  const parsed = moduleManifestSchemaV1.safeParse(value);
  if (!parsed.success) {
    // Prefer this schema's own module_manifest_* code over zod's generic issue text (shape or
    // path-based failures, e.g. an unrecognized key or a missing nested field), which callers
    // already match against the raw ZodError below.
    const specific = parsed.error.issues.find(issue => /^module_manifest_/.test(issue.message));
    throw specific ? new Error(specific.message) : parsed.error;
  }
  return deepFreeze(structuredClone(parsed.data));
}

export function isModuleSemverV1(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}
