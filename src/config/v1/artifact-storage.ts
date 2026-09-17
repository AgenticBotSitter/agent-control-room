import { isAbsolute, posix, resolve, win32 } from "node:path";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { containsSecretMaterial } from "../../security/redaction";

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
 * Local filesystem storage is the first public-release mode. Provider-neutral
 * object storage is the second: one `s3-compatible` class whose store is
 * selected by the captured deployment identity, never by a provider brand.
 * `r2` stays refused as a class name, so an operator file cannot advertise
 * provider support this contract does not qualify; R2 is reached through the
 * neutral class instead.
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
 * Credential material is refused by name wherever it appears in an operator
 * file, before any other rule, so a settings document that carries a password,
 * an access key, a signed URL or a personal-access token is reported as
 * credential material rather than as an anonymous schema violation. The
 * captured configuration and the portable export therefore cannot carry a
 * credential even by accident.
 *
 * The detection itself is the shared redaction primitive: this module owns the
 * refusal, not a second pattern list. Note the deliberate limit — an operator
 * file legitimately names a *reference* (`...Ref`, `...Id`, `...Digest`) and
 * that is not a credential.
 */
function refuseCredentialMaterial(value: unknown): void {
  if (containsSecretMaterial(value).length) refuse("artifact_storage_credential_material_refused");
}

/** The storage class a raw, untrusted value advertises, or an empty string. */
function advertisedStorageClass(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as { storageClass?: unknown }).storageClass;
  return typeof candidate === "string" ? candidate : "";
}

/**
 * A filesystem root, in either platform's spelling.
 *
 * Both parsers are consulted on every host rather than only the running
 * platform's. An operator file is portable data: a Windows-shaped root must be
 * refused for the same reason on a Linux server as on Windows, and the refusal
 * must be reproducible from any contributor's machine. This covers the POSIX
 * root, a drive root in either separator or case (`C:\`, `D:/`, `c:\`), a UNC
 * share root with or without its trailing separator, and the extended-length
 * and device forms (`\\?\C:\`, `\\.\C:\`).
 *
 * Note that `win32.parse` already returns `/` as the root of `/`, so today the
 * win32 branch alone would catch every case and the posix branch adds no
 * unique coverage — it is retained only so the POSIX root stays refused if
 * that win32 behavior ever narrows. Do not read it as separately tested.
 */
function isFilesystemRoot(value: string): boolean {
  return posix.parse(value).root === value || win32.parse(value).root === value;
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
  // A whole drive, share or host root is never a Control Room-owned namespace:
  // the store would claim everything beneath it. Checked before canonical form
  // so the refusal names the real problem on every platform.
  if (isFilesystemRoot(value)) refuse("artifact_storage_root_not_owned");
  if (!isAbsolute(value) || resolve(value) !== value) refuse("artifact_storage_root_not_canonical");
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
  refuseCredentialMaterial(value);
  const advertised = advertisedStorageClass(value);
  // Named refusal before the local schema: object settings are a different
  // variant, and reporting them as an unknown key would hide the real cause.
  if (advertised === ARTIFACT_STORAGE_S3_COMPATIBLE_CLASS_V1) refuse("artifact_storage_object_configuration_required");
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) refuse("artifact_storage_settings_invalid");
  const settings = parsed.data;
  // Named refusal: an operator must not be able to advertise a provider brand
  // as a supported class.
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

/**
 * Provider-neutral object storage.
 *
 * One class, `s3-compatible`, covers every S3-compatible service. What selects
 * a store is the captured deployment identity — endpoint, region, bucket and
 * namespace — and what authenticates it is the injected client's own
 * credential. This module never sees, carries or exports a credential: the
 * contract has no credential field at all, so an operator file cannot smuggle
 * one in, and `artifact_storage_credential_material_refused` is raised when a
 * document tries.
 *
 * The endpoint policy is the deployment half of the "no public store" rule. An
 * anonymous object host (an R2 public bucket domain, an S3 static-website
 * endpoint) is refused by name, a non-TLS origin is refused as insecure, and
 * embedded credentials are refused as credentials. Only the account API origin
 * of a private store survives, and the bucket must be a DNS-style S3 bucket
 * name: no IP address, no empty or dotted-out name.
 */
export const ARTIFACT_STORAGE_S3_COMPATIBLE_CLASS_V1 = "s3-compatible" as const;

/** The one bounded private result media type an artifact store may hold. */
export const ARTIFACT_STORAGE_RESULT_CONTENT_TYPE_V1 = "text/plain; charset=utf-8" as const;

const bucketSchema = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const ipv4Schema = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * Anonymous, publicly readable object hosts. Reaching one of these means the
 * store is readable by anyone who knows the bucket name, which is not a
 * Control Room private artifact store.
 */
const publicObjectHosts = [
  /(?:^|\.)r2\.dev$/u,
  /\.s3-website[.-][a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u,
] as const;

const objectSettingsSchema = z.object({
  schema: z.literal(ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1),
  storageClass: z.string(),
  storageNamespace: localId,
  endpoint: z.string(),
  region: localId,
  bucket: z.string(),
  contentType: z.string(),
}).merge(boundsSchema).strict();

export type ArtifactObjectStorageSettingsV1 = z.infer<typeof objectSettingsSchema>;

export type CapturedArtifactObjectStorageConfigurationV1 = Readonly<{
  object: Readonly<{
    endpoint: string;
    region: string;
    bucket: string;
    contentType: string;
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
 * One private, credential-free account API origin.
 *
 * The origin must already be canonical: `new URL` is used to detect a trailing
 * separator, mixed case, a default port, a path, a query or a fragment, never
 * to repair one, because the captured deployment identity and the origin the
 * client dials must not be able to differ.
 */
export function captureS3CompatibleEndpointV1(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) refuse("artifact_storage_endpoint_invalid");
  if (/\s/u.test(value) || value.includes("\0")) refuse("artifact_storage_endpoint_invalid");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refuse("artifact_storage_endpoint_invalid");
  }
  if (parsed.protocol !== "https:") refuse("artifact_storage_endpoint_insecure");
  // Credentials are named before shape: an origin that carries a key must be
  // reported as credential material, not as a malformed URL.
  if (parsed.username !== "" || parsed.password !== "") refuse("artifact_storage_endpoint_credentials");
  if (parsed.port !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    refuse("artifact_storage_endpoint_not_canonical");
  }
  const host = parsed.hostname.toLowerCase();
  if (value !== `https://${host}`) refuse("artifact_storage_endpoint_not_canonical");
  for (const pattern of publicObjectHosts) if (pattern.test(host)) refuse("artifact_storage_endpoint_public");
  return `https://${host}`;
}

/** One DNS-style S3 bucket name. IP-addressed and dotted-out names are refused. */
export function captureS3CompatibleBucketV1(value: unknown): string {
  if (typeof value !== "string" || !bucketSchema.test(value) || value.includes("..") || ipv4Schema.test(value)) {
    refuse("artifact_storage_bucket_invalid");
  }
  return value;
}

/**
 * Binds the public namespace identity to one exact private deployment without
 * publishing it. Two installations compare the digest; neither learns the
 * other's endpoint or bucket from it.
 */
export function objectArtifactStorageNamespaceDigestV1(
  storageNamespace: string,
  endpoint: string,
  region: string,
  bucket: string,
): string {
  return sha256Digest({
    purpose: "private-artifact-storage-object-namespace/v1",
    storageNamespace,
    endpoint,
    region,
    bucket,
  });
}

/**
 * Parses untrusted operator object-storage settings. The returned value is
 * frozen, carries no credential field and opens nothing.
 */
export function captureS3CompatibleArtifactStorageSettingsV1(value: unknown): Readonly<ArtifactObjectStorageSettingsV1> {
  refuseCredentialMaterial(value);
  const advertised = advertisedStorageClass(value);
  if (advertised === "r2") refuse("artifact_storage_r2_unsupported");
  if (advertised === "local") refuse("artifact_storage_local_configuration_required");
  const parsed = objectSettingsSchema.safeParse(value);
  if (!parsed.success) refuse("artifact_storage_settings_invalid");
  const settings = parsed.data;
  if (settings.storageClass !== ARTIFACT_STORAGE_S3_COMPATIBLE_CLASS_V1) refuse("artifact_storage_class_unsupported");
  const endpoint = captureS3CompatibleEndpointV1(settings.endpoint);
  const bucket = captureS3CompatibleBucketV1(settings.bucket);
  if (settings.contentType !== ARTIFACT_STORAGE_RESULT_CONTENT_TYPE_V1) refuse("artifact_storage_content_type_unsupported");
  if (settings.maximumTotalBytes < settings.maximumFileBytes) refuse("artifact_storage_total_below_file");
  return Object.freeze({ ...settings, endpoint, bucket });
}

/**
 * The captured object-storage configuration the private server binds. The
 * namespace digest is derived from the settings actually captured, so a
 * supplied, stale or forged digest cannot bind this namespace to another store.
 */
export function captureS3CompatibleArtifactStorageConfigurationV1(
  settings: unknown,
  release: unknown,
): CapturedArtifactObjectStorageConfigurationV1 {
  const captured = captureS3CompatibleArtifactStorageSettingsV1(settings);
  const parsedRelease = releaseSchema.safeParse(release);
  if (!parsedRelease.success) refuse("artifact_storage_release_invalid");
  return Object.freeze({
    object: Object.freeze({
      endpoint: captured.endpoint,
      region: captured.region,
      bucket: captured.bucket,
      contentType: captured.contentType,
      maximumArtifacts: captured.maximumArtifacts,
      maximumFileBytes: captured.maximumFileBytes,
      maximumTotalBytes: captured.maximumTotalBytes,
      operationTimeoutMs: captured.operationTimeoutMs,
    }),
    inventory: Object.freeze({
      ...parsedRelease.data,
      storageNamespace: captured.storageNamespace,
      storageNamespaceDigest: objectArtifactStorageNamespaceDigestV1(
        captured.storageNamespace, captured.endpoint, captured.region, captured.bucket,
      ),
    }),
  });
}

/**
 * Portable, non-secret object-storage export. The endpoint, region and bucket
 * are deployment data and are deliberately omitted; the namespace and its
 * digest travel instead. A settings document carrying credential material is
 * refused rather than exported.
 */
export function exportS3CompatibleArtifactStorageSettingsV1(value: unknown): string {
  const captured = captureS3CompatibleArtifactStorageSettingsV1(value);
  return JSON.stringify({
    schema: ARTIFACT_STORAGE_SETTINGS_SCHEMA_V1,
    storageClass: captured.storageClass,
    storageNamespace: captured.storageNamespace,
    storageNamespaceDigest: objectArtifactStorageNamespaceDigestV1(
      captured.storageNamespace, captured.endpoint, captured.region, captured.bucket,
    ),
    contentType: captured.contentType,
    maximumArtifacts: captured.maximumArtifacts,
    maximumFileBytes: captured.maximumFileBytes,
    maximumTotalBytes: captured.maximumTotalBytes,
    operationTimeoutMs: captured.operationTimeoutMs,
  });
}
