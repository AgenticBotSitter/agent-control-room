import { posix } from "node:path";
import { types } from "node:util";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from
  "../../harness/hermes-021-v1/connector-profile";

export const MACOS_HERMES_RUNTIME_IMAGE_MANIFEST_V1 =
  "control-room.macos-hermes-runtime-image-manifest/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const relativePath = z.string().min(1).max(512);
const entrySchema = z.object({
  path: relativePath,
  kind: z.enum(["directory", "regular_file"]),
  mode: z.enum(["0444", "0555"]),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: digest.nullable(),
  linkCount: z.literal(1).nullable(),
}).strict();

const privacySchema = z.object({
  storesAbsolutePaths: z.literal(false),
  storesOwnerIdentity: z.literal(false),
  storesTimestamps: z.literal(false),
  inspectsFileContents: z.literal(false),
  credentialAbsenceVerified: z.literal(false),
  requiredNextStep: z.literal("owner_authorized_public_runtime_capture"),
}).strict();

const manifestSchema = z.object({
  schema: z.literal(MACOS_HERMES_RUNTIME_IMAGE_MANIFEST_V1),
  platform: z.literal("darwin"),
  architecture: z.enum(["arm64", "x64"]),
  hermesVersion: z.literal(HERMES_021_VERSION_V1),
  hermesSourceRevision: z.literal(HERMES_021_SOURCE_REVISION_V1),
  runtimeImageSha256: digest,
  entries: z.array(entrySchema).min(1).max(100_000),
  entryCount: z.number().int().min(1).max(100_000),
  totalFileBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  privacy: privacySchema,
  status: z.literal("inventory_only"),
  grantsPackagingAuthority: z.literal(false),
  grantsLaunchAuthority: z.literal(false),
  manifestDigest: digest,
}).strict();

export type MacosHermesRuntimeImageEntryV1 = Readonly<z.infer<typeof entrySchema>>;
export type MacosHermesRuntimeImageManifestV1 = Readonly<z.infer<typeof manifestSchema>>;

const inputNames = ["architecture", "entries", "expectedPaths", "runtimeImageSha256"] as const;
const entryNames = ["kind", "linkCount", "mode", "path", "sha256", "sizeBytes"] as const;
const manifestNames = ["architecture", "entries", "entryCount", "grantsLaunchAuthority",
  "grantsPackagingAuthority", "hermesSourceRevision", "hermesVersion", "manifestDigest", "platform", "privacy",
  "runtimeImageSha256", "schema", "status", "totalFileBytes"] as const;
const privacyNames = ["credentialAbsenceVerified", "inspectsFileContents", "requiredNextStep", "storesAbsolutePaths",
  "storesOwnerIdentity", "storesTimestamps"] as const;
const verificationNames = ["manifest", "observedEntries", "runtimeImageSha256"] as const;

function refuse(): never {
  const error = new Error("macos_hermes_runtime_image_manifest_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) refuse();
  const properties = Object.getOwnPropertyNames(value);
  if (properties.length !== names.length || properties.some(name => !names.includes(name))
    || names.some(name => !properties.includes(name))) refuse();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse();
  }
  return value as Readonly<Record<string, unknown>>;
}

function dataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) refuse();
  const properties = Object.getOwnPropertyNames(value);
  if (properties.length !== value.length + 1 || properties.at(-1) !== "length") refuse();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse();
  }
  return value;
}

function safePath(value: unknown): string {
  const parsed = relativePath.safeParse(value);
  if (!parsed.success || parsed.data.includes("\\") || parsed.data.includes("\0") || parsed.data.startsWith("/")
    || posix.normalize(parsed.data) !== parsed.data
    || parsed.data.split("/").some(part => part === "" || part === "." || part === "..")) refuse();
  return parsed.data;
}

function parseEntry(value: unknown): z.infer<typeof entrySchema> {
  exact(value, entryNames);
  const result = entrySchema.safeParse(value);
  if (!result.success) refuse();
  const entry = result.data;
  safePath(entry.path);
  if (entry.kind === "directory") {
    if (entry.mode !== "0555" || entry.sizeBytes !== 0 || entry.sha256 !== null || entry.linkCount !== null) refuse();
  } else if (entry.sha256 === null || entry.linkCount !== 1) refuse();
  return entry;
}

function parseEntries(value: unknown): z.infer<typeof entrySchema>[] {
  const values = dataArray(value);
  if (values.length < 1 || values.length > 100_000) refuse();
  return values.map(parseEntry);
}

function validateTree(entries: readonly z.infer<typeof entrySchema>[]): void {
  const seen = new Map<string, z.infer<typeof entrySchema>>();
  for (const entry of entries) {
    if (seen.has(entry.path)) refuse();
    seen.set(entry.path, entry);
  }
  for (const entry of entries) {
    let parent = posix.dirname(entry.path);
    while (parent !== ".") {
      const parentEntry = seen.get(parent);
      if (!parentEntry || parentEntry.kind !== "directory") refuse();
      parent = posix.dirname(parent);
    }
  }
}

function freezeManifest(value: z.infer<typeof manifestSchema>): MacosHermesRuntimeImageManifestV1 {
  for (const entry of value.entries) Object.freeze(entry);
  Object.freeze(value.entries);
  Object.freeze(value.privacy);
  return Object.freeze(value);
}

function materialFor(
  architecture: "arm64" | "x64",
  runtimeImageSha256: string,
  entries: readonly z.infer<typeof entrySchema>[],
): Omit<z.infer<typeof manifestSchema>, "manifestDigest"> {
  const sorted = entries.map(entry => ({ ...entry })).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  validateTree(sorted);
  let totalFileBytes = 0;
  for (const entry of sorted) {
    if (entry.kind === "regular_file") {
      totalFileBytes += entry.sizeBytes;
      if (!Number.isSafeInteger(totalFileBytes)) refuse();
    }
  }
  return {
    schema: MACOS_HERMES_RUNTIME_IMAGE_MANIFEST_V1,
    platform: "darwin",
    architecture,
    hermesVersion: HERMES_021_VERSION_V1,
    hermesSourceRevision: HERMES_021_SOURCE_REVISION_V1,
    runtimeImageSha256,
    entries: sorted,
    entryCount: sorted.length,
    totalFileBytes,
    privacy: {
      storesAbsolutePaths: false,
      storesOwnerIdentity: false,
      storesTimestamps: false,
      inspectsFileContents: false,
      credentialAbsenceVerified: false,
      requiredNextStep: "owner_authorized_public_runtime_capture",
    },
    status: "inventory_only",
    grantsPackagingAuthority: false,
    grantsLaunchAuthority: false,
  };
}

/**
 * Builds a deterministic, non-authorizing inventory from observations made by
 * a future owner-authorized runtime packager. This function does not walk a
 * filesystem or inspect file contents. `expectedPaths` is the reviewed closure
 * boundary: a missing or extra observation refuses the complete manifest.
 */
export function buildMacosHermesRuntimeImageManifestV1(value: unknown): MacosHermesRuntimeImageManifestV1 {
  const input = exact(value, inputNames);
  const architecture = z.enum(["arm64", "x64"]).safeParse(input.architecture);
  const imageDigest = digest.safeParse(input.runtimeImageSha256);
  if (!architecture.success || !imageDigest.success) refuse();
  const expectedPaths = dataArray(input.expectedPaths).map(safePath);
  if (expectedPaths.length < 1 || new Set(expectedPaths).size !== expectedPaths.length) refuse();
  const entries = parseEntries(input.entries);
  const observed = new Set(entries.map(entry => entry.path));
  if (observed.size !== expectedPaths.length || expectedPaths.some(path => !observed.has(path))) refuse();
  const material = materialFor(architecture.data, imageDigest.data, entries);
  return freezeManifest(manifestSchema.parse({ ...material, manifestDigest: sha256Digest(material) }));
}

/** Parses saved inventory data for display or later release assembly. It grants no authority. */
export function parseMacosHermesRuntimeImageManifestV1(value: unknown): MacosHermesRuntimeImageManifestV1 {
  const outer = exact(value, manifestNames);
  exact(outer.privacy, privacyNames);
  const entries = parseEntries(outer.entries);
  const result = manifestSchema.safeParse({ ...outer, entries });
  if (!result.success) refuse();
  const material = { ...result.data } as Record<string, unknown>;
  delete material.manifestDigest;
  const rebuilt = materialFor(result.data.architecture, result.data.runtimeImageSha256, entries);
  if (canonicalJson(material) !== canonicalJson(rebuilt) || sha256Digest(material) !== result.data.manifestDigest) refuse();
  return freezeManifest(result.data);
}

/**
 * Rebuilds the manifest from a later image observation and requires exact byte,
 * mode, kind, link-count, path and image-digest equality. No launch capability
 * is returned.
 */
export function verifyMacosHermesRuntimeImageManifestV1(value: unknown): MacosHermesRuntimeImageManifestV1 {
  const input = exact(value, verificationNames);
  const saved = parseMacosHermesRuntimeImageManifestV1(input.manifest);
  const observed = parseEntries(input.observedEntries);
  const imageDigest = digest.safeParse(input.runtimeImageSha256);
  if (!imageDigest.success || imageDigest.data !== saved.runtimeImageSha256) refuse();
  const rebuilt = buildMacosHermesRuntimeImageManifestV1({
    architecture: saved.architecture,
    entries: observed,
    expectedPaths: saved.entries.map(entry => entry.path),
    runtimeImageSha256: imageDigest.data,
  });
  if (serializeMacosHermesRuntimeImageManifestV1(rebuilt) !== serializeMacosHermesRuntimeImageManifestV1(saved)) refuse();
  return saved;
}

export function serializeMacosHermesRuntimeImageManifestV1(value: unknown): string {
  return `${canonicalJson(parseMacosHermesRuntimeImageManifestV1(value))}\n`;
}
