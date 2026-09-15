import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * Operator-supplied durable result-storage settings.
 *
 * This module owns the single place where an untrusted operator file becomes
 * the captured storage configuration the private server binds. It resolves
 * exactly one explicit persistent directory, derives the namespace digest
 * rather than accepting one, and refuses every shape that would silently
 * produce an unusable or unbounded store.
 *
 * The private host path is deployment data, never public product content: it
 * is retained only inside the captured configuration and is deliberately
 * absent from the portable export, which carries the public namespace and its
 * digest instead. The digest binds the public namespace to one canonical path
 * without publishing that path.
 *
 * Local filesystem storage is the first public-release mode. `r2` is refused
 * here with a named reason so an operator cannot advertise object storage as
 * supported before a separately tested bounded adapter exists.
 */
export const ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1 = "control-room.artifact-storage-settings/v1" as const;

/** The bounded result ceiling shared with the byte store and result contracts. */
export const ARTIFACT_STORAGE_RESULT_LIMIT_BYTES_V1 = 65_536 as const;

/** Upper bound on one storage operation; a slower disk fails closed rather than hanging startup. */
const MAXIMUM_OPERATION_TIMEOUT_MS = 2_000;

const localId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export class ArtifactStorageSettingsError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ArtifactStorageSettingsError";
  }
}

function refuse(reason: string): never {
  throw new ArtifactStorageSettingsError(reason);
}

/**
 * One explicit persistent directory. The path must already be absolute and
 * canonical: `resolve()` is used to detect `..`, `.`, duplicate separators and
 * trailing separators, never to repair them. A configuration that needed
 * repair is refused so the operator's recorded intent and the opened directory
 * can never differ.
 */
function canonicalPersistentDirectory(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) refuse("artifact_storage_root_invalid");
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) refuse("artifact_storage_root_invalid");
  if (!isAbsolute(value) || resolve(value) !== value) refuse("artifact_storage_root_not_canonical");
  // "/" is never a Control Room-owned namespace: the store would claim the host.
  if (value === "/") refuse("artifact_storage_root_not_owned");
  return value;
}

const boundsSchema = z.object({
  maximumArtifacts: z.number().int().min(1).max(10_000),
  maximumFileBytes: z.number().int().min(1).max(ARTIFACT_STORAGE_RESULT_LIMIT_BYTES_V1),
  maximumTotalBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  operationTimeoutMs: z.number().int().min(1).max(MAXIMUM_OPERATION_TIMEOUT_MS),
}).strict();

const settingsSchema = z.object({
  schema: z.literal(ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1),
  storageClass: z.string(),
  storageNamespace: localId,
  rootPath: z.string(),
}).merge(boundsSchema).strict();

/** Release and schema identity carried into the backup inventory header. */
const releaseSchema = z.object({
  releaseId: localId,
  releaseDigest: digest,
  databaseSchemaVersion: localId,
  databaseSchemaDigest: digest,
}).strict();

export type ArtifactStorageSettingsV1 = z.infer<typeof settingsSchema>;
export type ArtifactStorageReleaseV1 = z.infer<typeof releaseSchema>;

export type CapturedArtifactStorageConfigurationV1 = Readonly<{
  local: Readonly<{
    rootPath: string;
    maximumArtifacts: number;
    maximumFileBytes: number;
    maximumTotalBytes: number;
    operationTimeoutMs: number;
  }>;
  inventory: Readonly<{
    releaseId: string;
    releaseDigest: string;
    databaseSchemaVersion: string;
    databaseSchemaDigest: string;
    storageNamespace: string;
    storageNamespaceDigest: string;
  }>;
}>;

/**
 * Binds a public namespace identity to one trusted canonical operator path
 * without returning or publishing that path. Callers compare the digest; they
 * never learn the directory from it.
 */
export function artifactStorageNamespaceDigestV1(storageNamespace: string, rootPath: string): string {
  return sha256Digest({ purpose: "private-artifact-storage-namespace/v1", storageNamespace, rootPath });
}

/**
 * Parses untrusted operator settings. The returned value is frozen and carries
 * the canonical directory; it grants no storage, publication or completion
 * authority and opens nothing.
 */
export function captureArtifactStorageSettingsV1(value: unknown): Readonly<ArtifactStorageSettingsV1> {
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) refuse("artifact_storage_settings_invalid");
  const settings = parsed.data;
  // Named refusal: an operator must not be able to advertise object storage
  // before a separately tested bounded adapter exists.
  if (settings.storageClass === "r2") refuse("artifact_storage_r2_unsupported");
  if (settings.storageClass !== "local") refuse("artifact_storage_class_unsupported");
  const rootPath = canonicalPersistentDirectory(settings.rootPath);
  // A total smaller than one file silently accepts a store that can never hold
  // a single result. Refuse it at capture instead of at the first write.
  if (settings.maximumTotalBytes < settings.maximumFileBytes) refuse("artifact_storage_total_below_file");
  return Object.freeze({ ...settings, rootPath });
}

/**
 * Produces the captured configuration the private server binds. The namespace
 * digest is always derived from the settings actually captured, so a supplied
 * or stale digest can never bind a namespace to a different directory.
 */
export function captureArtifactStorageConfigurationV1(
  settings: unknown,
  release: unknown,
): CapturedArtifactStorageConfigurationV1 {
  const captured = captureArtifactStorageSettingsV1(settings);
  const parsedRelease = releaseSchema.safeParse(release);
  if (!parsedRelease.success) refuse("artifact_storage_release_invalid");
  return Object.freeze({
    local: Object.freeze({
      rootPath: captured.rootPath,
      maximumArtifacts: captured.maximumArtifacts,
      maximumFileBytes: captured.maximumFileBytes,
      maximumTotalBytes: captured.maximumTotalBytes,
      operationTimeoutMs: captured.operationTimeoutMs,
    }),
    inventory: Object.freeze({
      ...parsedRelease.data,
      storageNamespace: captured.storageNamespace,
      storageNamespaceDigest: artifactStorageNamespaceDigestV1(captured.storageNamespace, captured.rootPath),
    }),
  });
}

/**
 * Portable, non-secret export. The private host directory is deliberately
 * omitted; the namespace and its digest travel instead, so two installations
 * can be compared without either publishing its filesystem layout.
 */
export function exportArtifactStorageSettingsV1(value: unknown): string {
  const captured = captureArtifactStorageSettingsV1(value);
  return JSON.stringify({
    schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1,
    storageClass: captured.storageClass,
    storageNamespace: captured.storageNamespace,
    storageNamespaceDigest: artifactStorageNamespaceDigestV1(captured.storageNamespace, captured.rootPath),
    maximumArtifacts: captured.maximumArtifacts,
    maximumFileBytes: captured.maximumFileBytes,
    maximumTotalBytes: captured.maximumTotalBytes,
    operationTimeoutMs: captured.operationTimeoutMs,
  });
}
