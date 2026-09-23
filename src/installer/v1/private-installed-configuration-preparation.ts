import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { types } from "node:util";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1 } from "../../harness/v1/installation-topology";
import { PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "./private-installed-configuration-custody";
import { PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1 } from
  "./private-installed-local-hermes-runtime-composer";
import { capturePrivatePostgresEndpointPolicyV1 } from "../../web/v1/private-postgres-endpoint";

/**
 * Inert bridge from the already-reviewed installed Hermes configuration to
 * the existing v2 installed-configuration custody input. It plans bytes and
 * fingerprints only. Publication and native verification remain owner-held.
 */
export const PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1 =
  "control-room.private-installed-configuration-preparation/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_PUBLICATION_V1 =
  "control-room.private-installed-configuration-publication/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const rolePattern = /^[a-z][a-z0-9_]{0,62}$/u;
const standardRootPattern = /^\/Users\/[^/\u0000-\u001f\u007f]{1,255}\/Library\/Application Support\/Agent Control Room\/Protected$/u;
const forbiddenNames = new Set(["password", "secret", "token", "apikey", "privatekey", "credential", "connectionstring",
  "command", "commands", "shell", "callback", "callbacks", "handler", "module", "script", "argv", "args", "env"]);
const suspiciousValue = /(?:postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]+-----|\bBearer\s+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,})/u;
const maximumConfigurationBytes = 256 * 1024;

type NativePort = Readonly<{ verifyProtectedPath(request: unknown): Promise<unknown> }>;
type Captured = Readonly<{
  rootPath: string;
  ownerUid: number;
  configurationBytes: Uint8Array;
  manifestBytes: Uint8Array;
  verificationDeadlineMs: number;
  planDigest: string;
}>;

export type PrivateInstalledConfigurationPlanV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1;
  status: "configuration_plan_ready";
  installationId: string;
  releaseDigest: string;
  protectedPlacement: Readonly<{
    kind: "macos_standard_protected_root";
    rootPathFingerprint: string;
    manifestPathFingerprint: string;
    configurationPathFingerprint: string;
    journalPathFingerprint: string;
    manifestName: "installed-manifest.json";
    configurationName: "operator.json";
    journalDirectoryName: "installation-journal";
  }>;
  configuration: Readonly<{
    schema: typeof PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1;
    bytes: number;
    sha256: string;
  }>;
  manifest: Readonly<{
    schema: typeof PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2;
    bytes: number;
    sha256: string;
  }>;
  databaseAuthority: Readonly<{
    provider: "postgresql";
    majorVersion: 17;
    database: "control_room";
    networkClass: "private_network";
    databaseAuthorityDigest: string;
    targetIdentityDigest: string;
    endpointFingerprint: string;
    credentialReferenceFingerprint: string;
    privateRouteEvidenceDigest: string;
  }>;
  planDigest: string;
  dataOnly: true;
  containsCredentialValue: false;
  containsCommand: false;
  containsCallback: false;
  performsEffect: false;
  writesProtectedFiles: false;
  readsProtectedFiles: false;
  opensDatabase: false;
  usesNetwork: false;
  startsService: false;
  startsWorker: false;
}>;

export type PrivateInstalledConfigurationPreflightV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1;
  status: "ready" | "blocked";
  blocker?: "installed_configuration_plan_invalid";
  performsEffect: false;
  writesProtectedFiles: false;
  readsProtectedFiles: false;
  opensDatabase: false;
  usesNetwork: false;
  startsService: false;
  startsWorker: false;
}>;

const capturedPlans = new WeakMap<object, Captured>();

function refused(): never {
  const error = new Error("private_installed_configuration_preparation_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name))
    || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))) return refused();
  for (const name of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
  }
  return value as Readonly<Record<string, unknown>>;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function standardRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value
    || value.endsWith("/") || !standardRootPattern.test(value) || Buffer.byteLength(value, "utf8") > 4096) return refused();
  return value;
}

function captureReference(value: unknown): string {
  return digest(value);
}

/** Redacts the exact protected endpoint while binding configuration to it. */
export function privateInstalledPostgresEndpointFingerprintV1(value: unknown): string {
  const endpoint = exact(value, ["host", "port", "database", "majorVersion"]);
  if (typeof endpoint.host !== "string" || endpoint.host.length < 1 || endpoint.host.length > 255
    || /[\u0000-\u0020\u007f/@?#]/u.test(endpoint.host) || !Number.isInteger(endpoint.port)
    || (endpoint.port as number) < 1 || (endpoint.port as number) > 65_535
    || endpoint.database !== "control_room" || endpoint.majorVersion !== 17) return refused();
  return sha256Digest({ purpose: "private-installed-postgres-endpoint/v1", host: endpoint.host,
    port: endpoint.port, database: endpoint.database, majorVersion: endpoint.majorVersion });
}

function captureData(value: unknown, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refused();
  if (typeof value === "string") return suspiciousValue.test(value) ? refused() : value;
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) return refused();
  if (Object.getOwnPropertySymbols(value).length !== 0) return refused();
  active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return refused();
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0
      || Object.getOwnPropertyNames(value).length !== length.value + 1) return refused();
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
      result.push(captureData(descriptor.value, active));
    }
    active.delete(value);
    return Object.freeze(result);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return refused();
  const result: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    const normalized = name.replace(/[-_]/gu, "").toLowerCase();
    if (name === "__proto__" || name === "prototype" || name === "constructor" || forbiddenNames.has(normalized)) return refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    if ((normalized === "credentialref" || normalized === "credentialrefs")
      && typeof descriptor.value !== "string" && !Array.isArray(descriptor.value)) return refused();
    result[name] = captureData(descriptor.value, active);
  }
  active.delete(value);
  return Object.freeze(result);
}

function databaseBinding(value: unknown) {
  const binding = exact(value, ["provider", "majorVersion", "database", "networkClass", "databaseAuthorityDigest",
    "targetIdentityDigest", "endpointFingerprint", "credentialReferenceFingerprint", "privateRouteEvidenceDigest"]);
  if (binding.provider !== "postgresql" || binding.majorVersion !== 17 || binding.database !== "control_room"
    || binding.networkClass !== "private_network") return refused();
  return Object.freeze({ provider: "postgresql" as const, majorVersion: 17 as const, database: "control_room" as const,
    networkClass: "private_network" as const, databaseAuthorityDigest: digest(binding.databaseAuthorityDigest),
    targetIdentityDigest: digest(binding.targetIdentityDigest), endpointFingerprint: captureReference(binding.endpointFingerprint),
    credentialReferenceFingerprint: captureReference(binding.credentialReferenceFingerprint),
    privateRouteEvidenceDigest: digest(binding.privateRouteEvidenceDigest) });
}

function sidecar(value: unknown, releaseDigest: string) {
  const item = exact(captureData(value), ["schema", "releaseVersion", "portableReleaseManifestSha256",
    "outerLauncherManifestSha256", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256",
    "executableSha256", "platform", "protocol", "architecture"]);
  if (item.schema !== PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1
    || item.portableReleaseManifestSha256 !== releaseDigest || item.platform !== "darwin" || item.protocol !== "ACRJNL1"
    || item.architecture !== "arm64" && item.architecture !== "x64"
    || typeof item.releaseVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(item.releaseVersion)) return refused();
  for (const name of ["portableReleaseManifestSha256", "outerLauncherManifestSha256", "sidecarManifestSha256",
    "archiveSha256", "artifactManifestSha256", "executableSha256"] as const) digest(item[name]);
  return Object.freeze(item);
}

function capture(inputValue: unknown) {
  const input = exact(inputValue, ["schema", "installationId", "releaseDigest", "standardProtectedRootPath",
    "expectedOwnerUid", "privateConfigurationData", "nativeSidecar", "databaseAuthority", "verificationDeadlineMs"]);
  if (input.schema !== PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1 || typeof input.installationId !== "string"
    || !installationIdPattern.test(input.installationId) || !Number.isSafeInteger(input.expectedOwnerUid)
    || (input.expectedOwnerUid as number) < 0 || (input.expectedOwnerUid as number) > 0x7fffffff
    || !Number.isSafeInteger(input.verificationDeadlineMs) || (input.verificationDeadlineMs as number) < 1
    || (input.verificationDeadlineMs as number) > 30_000) return refused();
  const installationId = input.installationId, releaseDigest = digest(input.releaseDigest), rootPath = standardRoot(input.standardProtectedRootPath);
  const configuration = exact(captureData(input.privateConfigurationData), ["schema", "installationId", "releaseDigest",
    "installedManifestBindingDigest", "runtimeIdentityDigest", "prerequisiteInput", "settledInstallationPlan", "hermes",
    "operator", "database", "artifactStorage", "setupSources"]);
  if (configuration.schema !== PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1
    || configuration.installationId !== installationId || configuration.releaseDigest !== releaseDigest) return refused();
  digest(configuration.installedManifestBindingDigest); digest(configuration.runtimeIdentityDigest);
  const prerequisite = exact(configuration.prerequisiteInput,
    ["installationId", "topologyPlan", "releaseDigest", "releasePreflight", "privatePlacement"]);
  const topology = verifyInstallationTopologyPlanV1(prerequisite.topologyPlan);
  if (prerequisite.installationId !== installationId || prerequisite.releaseDigest !== releaseDigest) return refused();
  const authority = databaseBinding(input.databaseAuthority);
  if (topology.databaseAuthorityDigest !== authority.databaseAuthorityDigest) return refused();
  const databaseKeys = ["host", "port", "database", "majorVersion", "roles", "queueConcurrency"];
  if (Object.prototype.hasOwnProperty.call(configuration.database, "privateEndpoint")) databaseKeys.push("privateEndpoint");
  const database = exact(configuration.database, databaseKeys);
  if (database.database !== authority.database || database.majorVersion !== authority.majorVersion
    || typeof database.host !== "string" || database.host.length < 1 || database.host.length > 255
    || !Number.isInteger(database.port) || (database.port as number) < 1 || (database.port as number) > 65_535
    || !Number.isInteger(database.queueConcurrency) || (database.queueConcurrency as number) < 1
    || (database.queueConcurrency as number) > 8) return refused();
  if (privateInstalledPostgresEndpointFingerprintV1({ host: database.host, port: database.port,
    database: database.database, majorVersion: database.majorVersion }) !== authority.endpointFingerprint) return refused();
  if (database.privateEndpoint !== undefined) {
    const endpoint = capturePrivatePostgresEndpointPolicyV1({ host: database.host,
      port: database.port as number, database: database.database, majorVersion: database.majorVersion }, database.privateEndpoint);
    if (!endpoint || endpoint.privateRouteEvidenceDigest !== authority.privateRouteEvidenceDigest) return refused();
  }
  const roles = exact(database.roles, ["web", "coordinator", "results", "evidence", "queueWorker"]);
  if (Object.values(roles).some(role => typeof role !== "string" || !rolePattern.test(role as string))
    || new Set(Object.values(roles)).size !== 5) return refused();
  const nativeSidecar = sidecar(input.nativeSidecar, releaseDigest);
  const configurationBytes = canonicalBytes(configuration);
  if (configurationBytes.byteLength < 1 || configurationBytes.byteLength > maximumConfigurationBytes) return refused();
  const configurationName = "operator.json", manifestName = "installed-manifest.json",
    journalDirectoryName = "installation-journal";
  const manifest = Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2, installationId,
    ownerUid: input.expectedOwnerUid as number,
    configuration: Object.freeze({ name: configurationName, bytes: configurationBytes.byteLength,
      sha256: sha256Bytes(configurationBytes) }),
    journal: Object.freeze({ directoryName: journalDirectoryName, nativeSidecar }) });
  const manifestBytes = canonicalBytes(manifest);
  const fingerprints = Object.freeze({ kind: "macos_standard_protected_root" as const,
    rootPathFingerprint: sha256Digest({ purpose: "private-installed-configuration-path/v1", kind: "root", path: rootPath }),
    manifestPathFingerprint: sha256Digest({ purpose: "private-installed-configuration-path/v1", kind: "manifest",
      path: join(rootPath, manifestName) }),
    configurationPathFingerprint: sha256Digest({ purpose: "private-installed-configuration-path/v1", kind: "configuration",
      path: join(rootPath, configurationName) }),
    journalPathFingerprint: sha256Digest({ purpose: "private-installed-configuration-path/v1", kind: "journal",
      path: join(rootPath, journalDirectoryName) }), manifestName, configurationName, journalDirectoryName });
  return Object.freeze({ installationId, releaseDigest, rootPath, ownerUid: input.expectedOwnerUid as number,
    verificationDeadlineMs: input.verificationDeadlineMs as number, configurationBytes, manifestBytes,
    configurationSha256: sha256Bytes(configurationBytes), manifestSha256: sha256Bytes(manifestBytes),
    fingerprints, authority });
}

function planFor(captured: ReturnType<typeof capture>): PrivateInstalledConfigurationPlanV1 {
  const material = Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1,
    status: "configuration_plan_ready" as const, installationId: captured.installationId,
    releaseDigest: captured.releaseDigest, protectedPlacement: captured.fingerprints,
    configuration: Object.freeze({ schema: PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1,
      bytes: captured.configurationBytes.byteLength, sha256: captured.configurationSha256 }),
    manifest: Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
      bytes: captured.manifestBytes.byteLength, sha256: captured.manifestSha256 }),
    databaseAuthority: captured.authority, dataOnly: true as const, containsCredentialValue: false as const,
    containsCommand: false as const, containsCallback: false as const, performsEffect: false as const,
    writesProtectedFiles: false as const, readsProtectedFiles: false as const, opensDatabase: false as const,
    usesNetwork: false as const, startsService: false as const, startsWorker: false as const });
  const plan = Object.freeze({ ...material,
    planDigest: sha256Digest({ purpose: "private-installed-configuration-preparation/v1", plan: material }) });
  capturedPlans.set(plan, Object.freeze({ rootPath: captured.rootPath, ownerUid: captured.ownerUid,
    configurationBytes: Uint8Array.from(captured.configurationBytes), manifestBytes: Uint8Array.from(captured.manifestBytes),
    verificationDeadlineMs: captured.verificationDeadlineMs, planDigest: plan.planDigest }));
  return plan;
}

/** Inspects only caller-supplied data and returns no path, credential, callback, command, or capability. */
export function preflightPrivateInstalledConfigurationPreparationV1(value: unknown): PrivateInstalledConfigurationPreflightV1 {
  try {
    capture(value);
    return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1, status: "ready" as const,
      performsEffect: false as const, writesProtectedFiles: false as const, readsProtectedFiles: false as const,
      opensDatabase: false as const, usesNetwork: false as const, startsService: false as const, startsWorker: false as const });
  } catch {
    return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1, status: "blocked" as const,
      blocker: "installed_configuration_plan_invalid" as const, performsEffect: false as const,
      writesProtectedFiles: false as const, readsProtectedFiles: false as const, opensDatabase: false as const,
      usesNetwork: false as const, startsService: false as const, startsWorker: false as const });
  }
}

/** Creates a redacted plan. Exact bytes and private paths stay process-local. */
export function preparePrivateInstalledConfigurationV1(value: unknown): PrivateInstalledConfigurationPlanV1 {
  try { return planFor(capture(value)); } catch { return refused(); }
}

function nativePort(value: unknown): NativePort {
  const record = exact(value, ["verifyProtectedPath"]), descriptor = Object.getOwnPropertyDescriptor(record, "verifyProtectedPath");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || types.isProxy(descriptor.value)) return refused();
  return Object.freeze({ verifyProtectedPath: Function.prototype.bind.call(descriptor.value, value) });
}

/**
 * Burns the process-local plan and returns the exact existing v2 custody input
 * plus inert publication bytes. It invokes no port and performs no write.
 */
export function composePrivateInstalledConfigurationPublicationV1(planValue: unknown, ownerPortsValue: unknown) {
  if (!planValue || typeof planValue !== "object" || types.isProxy(planValue)) return refused();
  const captured = capturedPlans.get(planValue);
  if (!captured || !capturedPlans.delete(planValue)) return refused();
  const ownerPorts = exact(ownerPortsValue, ["native"]), native = nativePort(ownerPorts.native);
  const manifestPath = join(captured.rootPath, "installed-manifest.json");
  const configurationPath = join(captured.rootPath, "operator.json");
  const journalPath = join(captured.rootPath, "installation-journal");
  const installedConfigurationCustodyInput = Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
    manifestPath, manifestBytes: captured.manifestBytes.byteLength, manifestSha256: sha256Bytes(captured.manifestBytes),
    expectedOwnerUid: captured.ownerUid, verificationDeadlineMs: captured.verificationDeadlineMs,
    native: Object.freeze({ verifyProtectedPath: native.verifyProtectedPath }) });
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_PUBLICATION_V1,
    status: "custody_input_ready" as const, planDigest: captured.planDigest, manifestPath, configurationPath, journalPath,
    configurationBytes: Uint8Array.from(captured.configurationBytes), manifestBytes: Uint8Array.from(captured.manifestBytes),
    installedConfigurationCustodyInput, performsEffect: false as const, writesProtectedFiles: false as const,
    readsProtectedFiles: false as const, opensDatabase: false as const, usesNetwork: false as const,
    invokesNativeVerifier: false as const, startsService: false as const, startsWorker: false as const });
}
