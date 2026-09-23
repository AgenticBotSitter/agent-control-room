import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { types } from "node:util";
import { canonicalJson } from "../../security/canonical-digest";

export const PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1 =
  "control-room.private-installed-configuration-custody/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2 =
  "control-room.private-installed-configuration-custody/v2" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1 =
  "control-room.private-installed-configuration-native-custody/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 =
  "control-room.private-installed-configuration-native-sidecar-identity/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1 =
  "control-room.private-installed-configuration-manifest-bound-preparation/v1" as const;

const openReadOnly = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const openDirectory = openReadOnly | (constants.O_DIRECTORY ?? 0);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const safeNamePattern = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const maximumManifestBytes = 16 * 1024;
const maximumConfigurationBytes = 256 * 1024;
const maximumVerificationDeadlineMs = 30_000;

type Identity = Readonly<{ device: number; inode: number; ownerUid: number; mode: number; size: number;
  linkCount: number; modifiedMs: number; changedMs: number }>;
type NativeKind = "ancestor" | "manifest" | "configuration" | "journal";
type ManifestV1 = Readonly<{
  installationId: string;
  ownerUid: number;
  configurationName: string;
  configurationBytes: number;
  configurationSha256: string;
  journalDirectoryName: string;
}>;
export type PrivateInstalledConfigurationNativeSidecarIdentityV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1;
  releaseVersion: string;
  portableReleaseManifestSha256: string;
  outerLauncherManifestSha256: string;
  sidecarManifestSha256: string;
  archiveSha256: string;
  artifactManifestSha256: string;
  executableSha256: string;
  platform: "darwin";
  protocol: "ACRJNL1";
  architecture: "arm64" | "x64";
}>;
type ManifestV2 = ManifestV1 & Readonly<{
  nativeSidecar: PrivateInstalledConfigurationNativeSidecarIdentityV1;
}>;
type NativePort = Readonly<{ verifyProtectedPath(request: Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1;
  kind: NativeKind;
  descriptor: number;
  identity: Identity;
  signal: AbortSignal;
}>): Promise<unknown> }>;
type CapturedInput = Readonly<{ manifestPath: string; manifestBytes: number; manifestSha256: string;
  expectedOwnerUid: number; verificationDeadlineMs: number; native: NativePort }>;

export type PrivateInstalledConfigurationCustodyBlockedV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1;
  status: "blocked";
  blocker: "native_custody_verifier_missing";
  performsEffect: false;
  createsDirectory: false;
  repairsDirectory: false;
  loadsModule: false;
  loadsCallback: false;
}>;
export type PrivateInstalledConfigurationCustodyBlockedV2 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2;
  status: "blocked";
  blocker: "native_custody_verifier_missing";
  performsEffect: false;
  createsDirectory: false;
  repairsDirectory: false;
  loadsModule: false;
  loadsCallback: false;
}>;
export type PrivateInstalledConfigurationCustodyConfigurationReadyV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1;
  status: "configuration_ready";
  custody: Readonly<{ loadPrivateConfigurationData(signal?: AbortSignal): Promise<unknown> }>;
  operatorComposition: Readonly<{
    status: "blocked";
    blocker: "native_journal_operation_custody_missing";
  }>;
  dataOnly: true;
  operatorDependencies: "injected_separately";
  performsEffect: false;
  createsDirectory: false;
  repairsDirectory: false;
  loadsModule: false;
  loadsCallback: false;
}>;
export type PrivateInstalledConfigurationManifestBoundPreparationV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1;
  installationId: string;
  privateConfigurationData: unknown;
  journal: Readonly<{
    rootPath: string;
    expectedRootIdentity: Readonly<{ device: number; inode: number }>;
    expectedOwnerUid: number;
    expectedRootMode: 0o700;
  }>;
  nativeSidecar: PrivateInstalledConfigurationNativeSidecarIdentityV1;
  dataOnly: true;
  opensJournal: false;
  constructsJournal: false;
  stagesNativeSidecar: false;
  performsNativeOperation: false;
  writesInstalledManifest: false;
  autoUpgradesManifest: false;
}>;
export type PrivateInstalledConfigurationCustodyManifestReadyV2 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2;
  status: "manifest_bound_configuration_ready";
  custody: Readonly<{
    loadManifestBoundPrivateConfigurationData(signal?: AbortSignal):
      Promise<PrivateInstalledConfigurationManifestBoundPreparationV1>;
  }>;
  operatorComposition: Readonly<{
    status: "blocked";
    blocker: "native_journal_operation_custody_missing";
  }>;
  dataOnly: true;
  operatorDependencies: "injected_separately";
  performsEffect: false;
  createsDirectory: false;
  repairsDirectory: false;
  loadsModule: false;
  loadsCallback: false;
  writesInstalledManifest: false;
  autoUpgradesManifest: false;
  stagesNativeSidecar: false;
  constructsJournal: false;
}>;

function sanitized(message: "refused" | "deadline"): Error {
  const error = new Error(`private_installed_configuration_custody_${message}`);
  error.stack = undefined;
  return error;
}
const refused = (): never => { throw sanitized("refused"); };
const blocked = (): PrivateInstalledConfigurationCustodyBlockedV1 => Object.freeze({
  schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
  status: "blocked" as const,
  blocker: "native_custody_verifier_missing" as const,
  performsEffect: false as const,
  createsDirectory: false as const,
  repairsDirectory: false as const,
  loadsModule: false as const,
  loadsCallback: false as const,
});
const blockedV2 = (): PrivateInstalledConfigurationCustodyBlockedV2 => Object.freeze({
  schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
  status: "blocked" as const,
  blocker: "native_custody_verifier_missing" as const,
  performsEffect: false as const,
  createsDirectory: false as const,
  repairsDirectory: false as const,
  loadsModule: false as const,
  loadsCallback: false as const,
});

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(name => !keys.includes(name))) return refused();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return refused();
  }
  return value as Readonly<Record<string, unknown>>;
}
function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/" || value.endsWith("/")
    || Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) return refused();
  return value;
}
function identity(value: { dev: number; ino: number; uid: number; mode: number; size: number; nlink: number;
  mtimeMs: number; ctimeMs: number }): Identity {
  return Object.freeze({ device: value.dev, inode: value.ino, ownerUid: value.uid, mode: value.mode & 0o7777,
    size: value.size, linkCount: value.nlink, modifiedMs: value.mtimeMs, changedMs: value.ctimeMs });
}
function same(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode && left.ownerUid === right.ownerUid
    && left.mode === right.mode && left.size === right.size && left.linkCount === right.linkCount
    && left.modifiedMs === right.modifiedMs && left.changedMs === right.changedMs;
}
function safeName(value: unknown): string {
  if (typeof value !== "string" || !safeNamePattern.test(value) || basename(value) !== value || value === "." || value === "..") return refused();
  return value;
}
function digest(value: unknown): string { if (typeof value !== "string" || !digestPattern.test(value)) return refused(); return value; }
function sha256(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function boundedPositiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) return refused();
  return value as number;
}

function captureNative(value: unknown): NativePort {
  const input = exact(value, ["verifyProtectedPath"]), descriptor = Object.getOwnPropertyDescriptor(input, "verifyProtectedPath");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || types.isProxy(descriptor.value)) return refused();
  return Object.freeze({ verifyProtectedPath: Function.prototype.bind.call(descriptor.value, value) }) as NativePort;
}
function hasDataNative(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "native");
  if (!descriptor || !("value" in descriptor)) return false;
  try { captureNative(descriptor.value); return true; } catch { return false; }
}
function captureInput(value: unknown, schema: typeof PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1
  | typeof PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2): CapturedInput {
  const input = exact(value, ["schema", "manifestPath", "manifestBytes", "manifestSha256", "expectedOwnerUid",
    "verificationDeadlineMs", "native"]);
  if (input.schema !== schema || !Number.isSafeInteger(input.expectedOwnerUid)
    || (input.expectedOwnerUid as number) < 0 || (input.expectedOwnerUid as number) > 0x7fffffff) return refused();
  return Object.freeze({ manifestPath: absolutePath(input.manifestPath),
    manifestBytes: boundedPositiveInteger(input.manifestBytes, maximumManifestBytes),
    manifestSha256: digest(input.manifestSha256), expectedOwnerUid: input.expectedOwnerUid as number,
    verificationDeadlineMs: boundedPositiveInteger(input.verificationDeadlineMs, maximumVerificationDeadlineMs),
    native: captureNative(input.native) });
}

function freezeJson(value: unknown, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refused();
  if (!value || typeof value !== "object" || active.has(value)
    || Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return refused();
  active.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => freezeJson(item, active)); active.delete(value); return Object.freeze(result);
  }
  const result: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "__proto__" || name === "prototype" || name === "constructor") return refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return refused();
    Object.defineProperty(result, name, { value: freezeJson(descriptor.value, active), enumerable: true,
      writable: false, configurable: false });
  }
  active.delete(value); return Object.freeze(result);
}
function parseCanonical(bytes: Buffer): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return refused(); }
  const frozen = freezeJson(parsed);
  if (!Buffer.from(`${canonicalJson(frozen)}\n`, "utf8").equals(bytes)) return refused();
  return frozen;
}
function parseManifestV1(bytes: Buffer, expectedOwnerUid: number): ManifestV1 {
  const value = exact(parseCanonical(bytes), ["schema", "installationId", "ownerUid", "configuration", "journal"]);
  const configuration = exact(value.configuration, ["name", "bytes", "sha256"]);
  const journal = exact(value.journal, ["directoryName"]);
  if (value.schema !== PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1 || typeof value.installationId !== "string"
    || !installationIdPattern.test(value.installationId) || value.ownerUid !== expectedOwnerUid) return refused();
  return Object.freeze({ installationId: value.installationId, ownerUid: expectedOwnerUid,
    configurationName: safeName(configuration.name),
    configurationBytes: boundedPositiveInteger(configuration.bytes, maximumConfigurationBytes),
    configurationSha256: digest(configuration.sha256), journalDirectoryName: safeName(journal.directoryName) });
}

function nativeSidecarIdentity(value: unknown): PrivateInstalledConfigurationNativeSidecarIdentityV1 {
  const identity = exact(value, ["schema", "releaseVersion", "portableReleaseManifestSha256",
    "outerLauncherManifestSha256", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256",
    "executableSha256", "platform", "protocol", "architecture"]);
  if (identity.schema !== PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1
    || typeof identity.releaseVersion !== "string" || !releaseVersionPattern.test(identity.releaseVersion)
    || identity.platform !== "darwin" || identity.protocol !== "ACRJNL1"
    || identity.architecture !== "arm64" && identity.architecture !== "x64") return refused();
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: identity.releaseVersion,
    portableReleaseManifestSha256: digest(identity.portableReleaseManifestSha256),
    outerLauncherManifestSha256: digest(identity.outerLauncherManifestSha256),
    sidecarManifestSha256: digest(identity.sidecarManifestSha256),
    archiveSha256: digest(identity.archiveSha256),
    artifactManifestSha256: digest(identity.artifactManifestSha256),
    executableSha256: digest(identity.executableSha256), platform: "darwin" as const,
    protocol: "ACRJNL1" as const, architecture: identity.architecture });
}

function parseManifestV2(bytes: Buffer, expectedOwnerUid: number): ManifestV2 {
  const value = exact(parseCanonical(bytes), ["schema", "installationId", "ownerUid", "configuration", "journal"]);
  const configuration = exact(value.configuration, ["name", "bytes", "sha256"]);
  const journal = exact(value.journal, ["directoryName", "nativeSidecar"]);
  if (value.schema !== PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2 || typeof value.installationId !== "string"
    || !installationIdPattern.test(value.installationId) || value.ownerUid !== expectedOwnerUid) return refused();
  return Object.freeze({ installationId: value.installationId, ownerUid: expectedOwnerUid,
    configurationName: safeName(configuration.name),
    configurationBytes: boundedPositiveInteger(configuration.bytes, maximumConfigurationBytes),
    configurationSha256: digest(configuration.sha256), journalDirectoryName: safeName(journal.directoryName),
    nativeSidecar: nativeSidecarIdentity(journal.nativeSidecar) });
}

async function bounded<T>(start: (signal: AbortSignal) => Promise<T>, outer: AbortSignal | undefined,
  deadlineMs: number): Promise<T> {
  outer?.throwIfAborted();
  const controller = new AbortController();
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { controller.abort(); rejectAbort?.(sanitized("refused")); };
  outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { controller.abort(); rejectAbort?.(sanitized("deadline")); }, deadlineMs);
  const work = Promise.resolve().then(() => start(controller.signal));
  void work.catch(() => {});
  try { return await Promise.race([work, aborted]); }
  finally { clearTimeout(timer); outer?.removeEventListener("abort", onAbort); }
}
async function boundedOpen(path: string, flags: number, signal: AbortSignal | undefined, deadlineMs: number): Promise<FileHandle> {
  const opening = open(path, flags);
  try {
    const handle = await bounded(() => opening, signal, deadlineMs);
    if (signal?.aborted) { await handle.close().catch(() => {}); signal.throwIfAborted(); }
    return handle;
  } catch (error) {
    // open(2) itself is not AbortSignal-aware. If the deadline/abort wins,
    // close a descriptor that arrives later rather than leaking it.
    void opening.then(handle => handle.close().catch(() => {}), () => {});
    throw error;
  }
}
async function verifyNative(port: NativePort, kind: NativeKind, handle: FileHandle, observed: Identity,
  signal: AbortSignal | undefined, deadlineMs: number, allowExtendedAncestorAcl = false): Promise<void> {
  let result: unknown;
  try {
    result = await bounded(nativeSignal => port.verifyProtectedPath(Object.freeze({
      schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, kind, descriptor: handle.fd,
      identity: observed, signal: nativeSignal })), signal, deadlineMs);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.message === "private_installed_configuration_custody_deadline") throw error;
    return refused();
  }
  const value = exact(result, ["schema", "outcome", "descriptor", "device", "inode", "ownerUid", "mode",
    "extendedAcl", "ancestorVerified"]);
  if (value.schema !== PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1 || value.outcome !== "verified"
    || value.descriptor !== handle.fd || value.device !== observed.device || value.inode !== observed.inode
    || value.ownerUid !== observed.ownerUid || value.mode !== observed.mode || typeof value.extendedAcl !== "boolean"
    || value.extendedAcl === true && (kind !== "ancestor" || !allowExtendedAncestorAcl)
    || value.ancestorVerified !== true) return refused();
}
async function protectedDirectory(path: string, ownerUid: number, port: NativePort, signal: AbortSignal | undefined,
  deadlineMs: number, kind: "ancestor" | "journal" = "ancestor", allowExtendedAncestorAcl = false): Promise<Identity> {
  let handle: FileHandle | undefined;
  try {
    handle = await boundedOpen(path, openDirectory, signal, deadlineMs);
    const statBefore = await handle.stat(), before = identity(statBefore), named = identity(await lstat(path));
    const writableSharedStickyRoot = before.ownerUid === 0 && (before.mode & 0o1000) !== 0;
    if (!statBefore.isDirectory() || !same(before, named) || ((before.mode & 0o022) !== 0 && !writableSharedStickyRoot)
      || ![0, ownerUid].includes(before.ownerUid) || await realpath(path) !== path) return refused();
    if (kind === "journal" && (before.ownerUid !== ownerUid || before.mode !== 0o700)) return refused();
    await verifyNative(port, kind, handle, before, signal, deadlineMs, allowExtendedAncestorAcl);
    if (!same(before, identity(await handle.stat())) || !same(before, identity(await lstat(path)))) return refused();
    return before;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.message === "private_installed_configuration_custody_deadline") throw error;
    return refused();
  } finally { await handle?.close().catch(() => {}); }
}
async function protectedAncestors(path: string, ownerUid: number, port: NativePort, signal: AbortSignal | undefined,
  deadlineMs: number): Promise<void> {
  const protectedRoot = dirname(path), ancestors: string[] = []; let current = protectedRoot;
  while (true) { ancestors.push(current); if (current === "/") break; current = dirname(current); }
  for (const ancestor of ancestors.reverse())
    await protectedDirectory(ancestor, ownerUid, port, signal, deadlineMs, "ancestor", ancestor !== protectedRoot);
}
async function readProtectedFile(path: string, ownerUid: number, expectedMode: number, exactBytes: number,
  expectedDigest: string, port: NativePort, kind: "manifest" | "configuration", signal: AbortSignal | undefined,
  deadlineMs: number): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    await protectedAncestors(path, ownerUid, port, signal, deadlineMs);
    handle = await boundedOpen(path, openReadOnly, signal, deadlineMs);
    const statBefore = await handle.stat(), before = identity(statBefore), named = identity(await lstat(path));
    if (!statBefore.isFile() || !same(before, named) || before.ownerUid !== ownerUid || before.mode !== expectedMode
      || before.size !== exactBytes || before.linkCount !== 1 || await realpath(path) !== path) return refused();
    await verifyNative(port, kind, handle, before, signal, deadlineMs);
    const bytes = await bounded(() => handle!.readFile(), signal, deadlineMs);
    const after = identity(await handle.stat());
    if (!same(before, after) || !same(before, identity(await lstat(path))) || bytes.length !== exactBytes
      || sha256(bytes) !== expectedDigest) return refused();
    return bytes;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.message === "private_installed_configuration_custody_deadline") throw error;
    return refused();
  } finally { await handle?.close().catch(() => {}); }
}

/**
 * Loads canonical data only. JSON never supplies executable operator ports.
 * The live journal/operator composition intentionally stays blocked because
 * the retained journal is path based and cannot preserve this native-held
 * descriptor custody through each read, recovery and append operation.
 */
export async function createPrivateInstalledConfigurationCustodyV1(inputValue: unknown,
  signal?: AbortSignal): Promise<PrivateInstalledConfigurationCustodyConfigurationReadyV1
    | PrivateInstalledConfigurationCustodyBlockedV1> {
  if (!hasDataNative(inputValue)) return blocked();
  const input = captureInput(inputValue, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1);
  signal?.throwIfAborted();
  const manifest = parseManifestV1(await readProtectedFile(input.manifestPath, input.expectedOwnerUid, 0o600,
    input.manifestBytes, input.manifestSha256, input.native, "manifest", signal, input.verificationDeadlineMs),
  input.expectedOwnerUid);
  const parent = dirname(input.manifestPath), journalPath = join(parent, manifest.journalDirectoryName);
  if (dirname(journalPath) !== parent) return refused();
  // This verifies readiness at this instant only. No journal object is exposed,
  // because this descriptor is closed before a future journal operation.
  await protectedAncestors(journalPath, manifest.ownerUid, input.native, signal, input.verificationDeadlineMs);
  await protectedDirectory(journalPath, manifest.ownerUid, input.native, signal, input.verificationDeadlineMs, "journal");

  const custody = Object.freeze({ async loadPrivateConfigurationData(operationSignal?: AbortSignal): Promise<unknown> {
    operationSignal?.throwIfAborted();
    const manifestBytes = await readProtectedFile(input.manifestPath, input.expectedOwnerUid, 0o600,
      input.manifestBytes, input.manifestSha256, input.native, "manifest", operationSignal, input.verificationDeadlineMs);
    const rereadManifest = parseManifestV1(manifestBytes, input.expectedOwnerUid);
    if (canonicalJson(rereadManifest) !== canonicalJson(manifest)) return refused();
    const configurationPath = join(parent, manifest.configurationName);
    if (dirname(configurationPath) !== parent) return refused();
    const configuration = parseCanonical(await readProtectedFile(configurationPath, manifest.ownerUid, 0o600,
      manifest.configurationBytes, manifest.configurationSha256, input.native, "configuration", operationSignal,
      input.verificationDeadlineMs));
    // Reverify the declared journal boundary only as data-binding evidence.
    // This still does not authorize a later path-based journal operation.
    await protectedAncestors(journalPath, manifest.ownerUid, input.native, operationSignal, input.verificationDeadlineMs);
    await protectedDirectory(journalPath, manifest.ownerUid, input.native, operationSignal,
      input.verificationDeadlineMs, "journal");
    operationSignal?.throwIfAborted();
    return configuration;
  } });
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1, status: "configuration_ready" as const,
    custody, operatorComposition: Object.freeze({ status: "blocked" as const,
      blocker: "native_journal_operation_custody_missing" as const }), dataOnly: true as const,
    operatorDependencies: "injected_separately" as const, performsEffect: false as const,
    createsDirectory: false as const, repairsDirectory: false as const, loadsModule: false as const,
    loadsCallback: false as const });
}

/**
 * Reads only an explicitly versioned installed manifest. The returned packet
 * is inert data for a later sidecar stager and held-journal composition: this
 * boundary never writes or upgrades a manifest, stages native bytes, opens a
 * journal session, or invents an installed location inside the portable
 * release tree.
 */
export async function createPrivateInstalledConfigurationCustodyV2(inputValue: unknown,
  signal?: AbortSignal): Promise<PrivateInstalledConfigurationCustodyManifestReadyV2
    | PrivateInstalledConfigurationCustodyBlockedV2> {
  if (!hasDataNative(inputValue)) return blockedV2();
  const input = captureInput(inputValue, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2);
  signal?.throwIfAborted();
  const manifest = parseManifestV2(await readProtectedFile(input.manifestPath, input.expectedOwnerUid, 0o600,
    input.manifestBytes, input.manifestSha256, input.native, "manifest", signal, input.verificationDeadlineMs),
  input.expectedOwnerUid);
  const parent = dirname(input.manifestPath), journalPath = join(parent, manifest.journalDirectoryName);
  if (dirname(journalPath) !== parent) return refused();
  await protectedAncestors(journalPath, manifest.ownerUid, input.native, signal, input.verificationDeadlineMs);
  const originalJournalIdentity = await protectedDirectory(journalPath, manifest.ownerUid, input.native, signal,
    input.verificationDeadlineMs, "journal");
  const expectedRootIdentity = Object.freeze({ device: originalJournalIdentity.device,
    inode: originalJournalIdentity.inode });

  const custody = Object.freeze({
    async loadManifestBoundPrivateConfigurationData(operationSignal?: AbortSignal):
      Promise<PrivateInstalledConfigurationManifestBoundPreparationV1> {
      operationSignal?.throwIfAborted();
      const manifestBytes = await readProtectedFile(input.manifestPath, input.expectedOwnerUid, 0o600,
        input.manifestBytes, input.manifestSha256, input.native, "manifest", operationSignal,
        input.verificationDeadlineMs);
      const rereadManifest = parseManifestV2(manifestBytes, input.expectedOwnerUid);
      if (canonicalJson(rereadManifest) !== canonicalJson(manifest)) return refused();
      const configurationPath = join(parent, manifest.configurationName);
      if (dirname(configurationPath) !== parent) return refused();
      const configuration = parseCanonical(await readProtectedFile(configurationPath, manifest.ownerUid, 0o600,
        manifest.configurationBytes, manifest.configurationSha256, input.native, "configuration", operationSignal,
        input.verificationDeadlineMs));
      await protectedAncestors(journalPath, manifest.ownerUid, input.native, operationSignal,
        input.verificationDeadlineMs);
      const rereadJournalIdentity = await protectedDirectory(journalPath, manifest.ownerUid, input.native,
        operationSignal, input.verificationDeadlineMs, "journal");
      if (rereadJournalIdentity.device !== expectedRootIdentity.device
        || rereadJournalIdentity.inode !== expectedRootIdentity.inode) return refused();
      operationSignal?.throwIfAborted();
      const journal = Object.freeze({ rootPath: journalPath, expectedRootIdentity,
        expectedOwnerUid: manifest.ownerUid, expectedRootMode: 0o700 as const });
      return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
        installationId: manifest.installationId, privateConfigurationData: configuration, journal,
        nativeSidecar: manifest.nativeSidecar, dataOnly: true as const, opensJournal: false as const,
        constructsJournal: false as const, stagesNativeSidecar: false as const,
        performsNativeOperation: false as const, writesInstalledManifest: false as const,
        autoUpgradesManifest: false as const });
    },
  });
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2,
    status: "manifest_bound_configuration_ready" as const, custody,
    operatorComposition: Object.freeze({ status: "blocked" as const,
      blocker: "native_journal_operation_custody_missing" as const }), dataOnly: true as const,
    operatorDependencies: "injected_separately" as const, performsEffect: false as const,
    createsDirectory: false as const, repairsDirectory: false as const, loadsModule: false as const,
    loadsCallback: false as const, writesInstalledManifest: false as const, autoUpgradesManifest: false as const,
    stagesNativeSidecar: false as const, constructsJournal: false as const });
}
