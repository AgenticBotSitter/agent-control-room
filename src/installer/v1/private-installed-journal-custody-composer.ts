import { isAbsolute, basename, dirname, normalize } from "node:path";
import { types } from "node:util";
import { canonicalJson } from "../../security/canonical-digest";
import { InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import type { InstallationPlanJournalStorageSessionFactoryV1 } from
  "./installation-plan-journal-storage-session";
import { createPrivateInstallationJournalHeldSessionAdapterV1,
  PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
  type PrivateInstallationJournalHeldSessionPortV1 } from
  "./private-installation-journal-held-session-adapter";
import { preparePrivateInstallationJournalNativeCustodyV1,
  PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1 } from
  "./private-installation-journal-native-custody-preparation";
import { createPrivateInstallationJournalNativeSessionPortV1 } from
  "./private-installation-journal-native-session";
import { PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
  type PrivateInstalledConfigurationManifestBoundPreparationV1,
  type PrivateInstalledConfigurationNativeSidecarIdentityV1 } from
  "./private-installed-configuration-custody";

/**
 * Source-only composition of the already-reviewed installation-journal
 * boundaries. Construction captures inert data and trusted factories only.
 * It does not stage or execute native bytes, open a journal operation, create
 * a directory, or start any Control Room runtime.
 */
export const PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1 =
  "control-room.private-installed-journal-custody-composer/v1" as const;
export const PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1 =
  "control-room.private-installed-journal-custody-ports/v1" as const;
export const MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1 =
  "control-room.macos-installation-journal-native-sidecar/v1" as const;

type NativeSessionPortFactory = (input: Readonly<{ executablePath: string; executableSha256: string }>) =>
  PrivateInstallationJournalHeldSessionPortV1;

export type PrivateInstalledJournalCustodyPortsV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1;
  createNativeSessionPort(input: Readonly<{ executablePath: string; executableSha256: string }> ):
    PrivateInstallationJournalHeldSessionPortV1;
}>;

/** Canonical production port selection. Creating this record is inert; the
 * native session factory itself does not read or execute bytes until a journal
 * operation is explicitly invoked through the retained journal. */
export function createPrivateInstalledJournalCustodyPortsV1(): PrivateInstalledJournalCustodyPortsV1 {
  return Object.freeze({ schema: PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1,
    createNativeSessionPort: createPrivateInstallationJournalNativeSessionPortV1 });
}

type RootBinding = Readonly<{ rootPath: string; expectedRootIdentity: Readonly<{ device: number; inode: number }>;
  expectedOwnerUid: number; expectedRootMode: 0o700 }>;
type CapturedPreparation = Readonly<{ installationId: string; privateConfigurationData: unknown;
  journal: RootBinding; nativeSidecar: PrivateInstalledConfigurationNativeSidecarIdentityV1 }>;
type NativeArtifact = Readonly<{ schema: typeof MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1; verified: true;
  releaseVersion: string; platform: "darwin"; architecture: "arm64" | "x64"; minimumMacos: string;
  protocol: "ACRJNL1"; sidecarManifestSha256: string; archiveSha256: string;
  artifactManifestSha256: string; executableSha256: string; sourceSha256: string; toolchain: unknown;
  files: unknown; compiles: false; downloads: false; installs: false }>;
type StagedFactoryInput = Readonly<{ nativeArtifact: NativeArtifact;
  factoryInput: Readonly<{ executablePath: string; executableSha256: string }> }>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sourceDigestPattern = /^[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function refused(): never {
  const error = new Error("private_installed_journal_custody_composer_refused");
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

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return refused();
  return value as number;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/"
    || value.endsWith("/") || Buffer.byteLength(value, "utf8") > 4096
    || Buffer.from(value, "utf8").toString("utf8") !== value || /[\u0000-\u001f\u007f]/u.test(value)) return refused();
  return value;
}

function inertData(value: unknown, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refused();
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) return refused();
  active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value)
      || Object.getOwnPropertyNames(value).length !== length.value + 1) return refused();
    const copy: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
      copy.push(inertData(descriptor.value, active));
    }
    active.delete(value); return Object.freeze(copy);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const copy: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "__proto__" || name === "prototype" || name === "constructor") return refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    copy[name] = inertData(descriptor.value, active);
  }
  active.delete(value); return Object.freeze(copy);
}

function sidecarIdentity(value: unknown): PrivateInstalledConfigurationNativeSidecarIdentityV1 {
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
    sidecarManifestSha256: digest(identity.sidecarManifestSha256), archiveSha256: digest(identity.archiveSha256),
    artifactManifestSha256: digest(identity.artifactManifestSha256), executableSha256: digest(identity.executableSha256),
    platform: "darwin", protocol: "ACRJNL1", architecture: identity.architecture });
}

function capturePreparation(value: unknown): CapturedPreparation {
  const prepared = exact(value, ["schema", "installationId", "privateConfigurationData", "journal", "nativeSidecar",
    "dataOnly", "opensJournal", "constructsJournal", "stagesNativeSidecar", "performsNativeOperation",
    "writesInstalledManifest", "autoUpgradesManifest"]);
  if (prepared.schema !== PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1
    || typeof prepared.installationId !== "string" || !installationIdPattern.test(prepared.installationId)
    || prepared.dataOnly !== true || prepared.opensJournal !== false || prepared.constructsJournal !== false
    || prepared.stagesNativeSidecar !== false || prepared.performsNativeOperation !== false
    || prepared.writesInstalledManifest !== false || prepared.autoUpgradesManifest !== false) return refused();
  const journal = exact(prepared.journal, ["rootPath", "expectedRootIdentity", "expectedOwnerUid", "expectedRootMode"]);
  const identity = exact(journal.expectedRootIdentity, ["device", "inode"]);
  if (journal.expectedRootMode !== 0o700) return refused();
  return Object.freeze({ installationId: prepared.installationId,
    privateConfigurationData: inertData(prepared.privateConfigurationData),
    journal: Object.freeze({ rootPath: absolutePath(journal.rootPath),
      expectedRootIdentity: Object.freeze({ device: safeInteger(identity.device), inode: safeInteger(identity.inode) }),
      expectedOwnerUid: safeInteger(journal.expectedOwnerUid, 0x7fffffff), expectedRootMode: 0o700 as const }),
    nativeSidecar: sidecarIdentity(prepared.nativeSidecar) });
}

function capturePorts(value: unknown): Readonly<{ createNativeSessionPort: NativeSessionPortFactory }> {
  const ports = exact(value, ["schema", "createNativeSessionPort"]);
  if (ports.schema !== PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1
    || typeof ports.createNativeSessionPort !== "function" || types.isProxy(ports.createNativeSessionPort)) return refused();
  const createNativeSessionPort = Function.prototype.bind.call(ports.createNativeSessionPort, value) as NativeSessionPortFactory;
  return Object.freeze({ createNativeSessionPort });
}

function captureNativeArtifact(value: unknown): NativeArtifact {
  const artifact = exact(value, ["schema", "verified", "releaseVersion", "platform", "architecture", "minimumMacos",
    "protocol", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256", "executableSha256",
    "sourceSha256", "toolchain", "files", "compiles", "downloads", "installs"]);
  if (artifact.schema !== MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1 || artifact.verified !== true
    || typeof artifact.releaseVersion !== "string" || !releaseVersionPattern.test(artifact.releaseVersion)
    || artifact.platform !== "darwin" || artifact.architecture !== "arm64" && artifact.architecture !== "x64"
    || typeof artifact.minimumMacos !== "string" || !/^1[3-9]\.0$/u.test(artifact.minimumMacos)
    || artifact.protocol !== "ACRJNL1" || artifact.compiles !== false || artifact.downloads !== false
    || artifact.installs !== false) return refused();
  return Object.freeze({ schema: MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1, verified: true,
    releaseVersion: artifact.releaseVersion, platform: "darwin", architecture: artifact.architecture,
    minimumMacos: artifact.minimumMacos, protocol: "ACRJNL1",
    sidecarManifestSha256: digest(artifact.sidecarManifestSha256), archiveSha256: digest(artifact.archiveSha256),
    artifactManifestSha256: digest(artifact.artifactManifestSha256), executableSha256: digest(artifact.executableSha256),
    sourceSha256: typeof artifact.sourceSha256 === "string" && sourceDigestPattern.test(artifact.sourceSha256)
      ? artifact.sourceSha256 : refused(),
    toolchain: inertData(artifact.toolchain), files: inertData(artifact.files),
    compiles: false, downloads: false, installs: false });
}

function sameSidecarBinding(expected: PrivateInstalledConfigurationNativeSidecarIdentityV1,
  observed: NativeArtifact): boolean {
  return expected.releaseVersion === observed.releaseVersion && expected.platform === observed.platform
    && expected.protocol === observed.protocol && expected.architecture === observed.architecture
    && expected.sidecarManifestSha256 === observed.sidecarManifestSha256
    && expected.archiveSha256 === observed.archiveSha256
    && expected.artifactManifestSha256 === observed.artifactManifestSha256
    && expected.executableSha256 === observed.executableSha256;
}

function captureStaged(value: unknown, expected: PrivateInstalledConfigurationNativeSidecarIdentityV1): StagedFactoryInput {
  const staged = exact(value, ["schema", "nativeArtifact", "installationJournalNativeFactoryInput", "staged",
    "compiles", "downloads", "installs"]);
  if (staged.schema !== MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1 || staged.staged !== true
    || staged.compiles !== false || staged.downloads !== false || staged.installs !== false) return refused();
  const nativeArtifact = captureNativeArtifact(staged.nativeArtifact);
  if (!sameSidecarBinding(expected, nativeArtifact)) return refused();
  const factory = exact(staged.installationJournalNativeFactoryInput, ["executablePath", "executableSha256"]);
  const executablePath = absolutePath(factory.executablePath);
  const stagingName = basename(dirname(executablePath));
  if (basename(executablePath) !== "installation-journal-session-v1"
    || !/^\.acr-installation-journal-sidecar-[A-Za-z0-9_-]+$/u.test(stagingName)
    || digest(factory.executableSha256) !== nativeArtifact.executableSha256) return refused();
  return Object.freeze({ nativeArtifact,
    factoryInput: Object.freeze({ executablePath, executableSha256: nativeArtifact.executableSha256 }) });
}

function capturePort(value: unknown): PrivateInstallationJournalHeldSessionPortV1 {
  const port = exact(value, ["schema", "openSession"]);
  if (port.schema !== PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1 || typeof port.openSession !== "function"
    || types.isProxy(port.openSession)) return refused();
  return Object.freeze({ schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
    openSession: Function.prototype.bind.call(port.openSession, value) });
}

function guardStorageFactory(factory: InstallationPlanJournalStorageSessionFactoryV1, prepared: CapturedPreparation,
  staged: StagedFactoryInput): InstallationPlanJournalStorageSessionFactoryV1 {
  const expectedSidecar = canonicalJson(prepared.nativeSidecar);
  const capturedObserved = canonicalJson(staged.nativeArtifact);
  return async open => {
    // Keep the complete installed sidecar tuple and the complete staged
    // identity captured for every operation. Never refresh either identity
    // from a replacement path after cancellation or an uncertain reply.
    if (canonicalJson(prepared.nativeSidecar) !== expectedSidecar
      || canonicalJson(staged.nativeArtifact) !== capturedObserved
      || !sameSidecarBinding(prepared.nativeSidecar, staged.nativeArtifact)
      || open.rootDirectory !== prepared.journal.rootPath || open.installationId !== prepared.installationId
      || open.ownerUid !== prepared.journal.expectedOwnerUid) return refused();
    return factory(open);
  };
}

export type PrivateInstalledJournalCustodyCompositionV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1;
  status: "journal_custody_factory_ready";
  installationId: string;
  privateConfigurationData: unknown;
  journalBinding: RootBinding;
  nativeSidecar: PrivateInstalledConfigurationNativeSidecarIdentityV1;
  custody: Readonly<{ constructJournal(stagedFactoryInput: unknown, signal?: AbortSignal): Readonly<{
    journal: InstallationPlanFilesystemJournalV1;
    journalBinding: RootBinding;
    nativeSidecar: PrivateInstalledConfigurationNativeSidecarIdentityV1;
  }> }>;
  performsEffect: false;
  stagesNativeSidecar: false;
  opensNativeSession: false;
  createsDirectory: false;
  opensDatabase: false;
  startsService: false;
  startsWorker: false;
  invokesHermes: false;
  clearsOperatorBlocker: false;
  remainingOwnerBoundary: "stage_release_bound_journal_sidecar_and_qualify_owner_held_native_operation";
}>;

/**
 * Captures the v2 manifest-bound configuration and one owner-injected native
 * port factory. The returned journal constructor is deliberately one-use: a
 * cancellation or failed chain construction cannot mint a replacement native
 * port and thereby forget an uncertain operation.
 */
export function createPrivateInstalledJournalCustodyCompositionV1(inputValue: unknown):
PrivateInstalledJournalCustodyCompositionV1 {
  const input = exact(inputValue, ["schema", "manifestBoundPreparation", "operationDeadlineMs", "ports"]);
  if (input.schema !== PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1) return refused();
  const prepared = capturePreparation(input.manifestBoundPreparation as PrivateInstalledConfigurationManifestBoundPreparationV1);
  const operationDeadlineMs = safeInteger(input.operationDeadlineMs, 30_000);
  if (operationDeadlineMs < 1) return refused();
  const ports = capturePorts(input.ports);
  let spent = false;
  const custody = Object.freeze({ constructJournal(stagedValue: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const staged = captureStaged(stagedValue, prepared.nativeSidecar);
    if (spent) return refused();
    // Burn the composition before invoking any injected factory. Failure,
    // cancellation or uncertainty can never reconstruct the port/session.
    spent = true;
    try {
      signal?.throwIfAborted();
      const preparation = preparePrivateInstallationJournalNativeCustodyV1(Object.freeze({
        schema: PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1,
        journalRootPath: prepared.journal.rootPath, installationId: prepared.installationId,
        expectedRootIdentity: prepared.journal.expectedRootIdentity,
        expectedOwnerUid: prepared.journal.expectedOwnerUid, operationDeadlineMs,
      }));
      signal?.throwIfAborted();
      const nativePort = capturePort(ports.createNativeSessionPort(staged.factoryInput));
      signal?.throwIfAborted();
      const heldFactory = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation, nativePort });
      const guardedFactory = guardStorageFactory(heldFactory, prepared, staged);
      const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: prepared.journal.rootPath,
        installationId: prepared.installationId, ownerUid: prepared.journal.expectedOwnerUid }, guardedFactory);
      signal?.throwIfAborted();
      return Object.freeze({ journal, journalBinding: prepared.journal, nativeSidecar: prepared.nativeSidecar });
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      return refused();
    }
  } });
  return Object.freeze({ schema: PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1,
    status: "journal_custody_factory_ready" as const, installationId: prepared.installationId,
    privateConfigurationData: prepared.privateConfigurationData, journalBinding: prepared.journal,
    nativeSidecar: prepared.nativeSidecar, custody,
    performsEffect: false as const, stagesNativeSidecar: false as const, opensNativeSession: false as const,
    createsDirectory: false as const, opensDatabase: false as const, startsService: false as const,
    startsWorker: false as const, invokesHermes: false as const, clearsOperatorBlocker: false as const,
    remainingOwnerBoundary: "stage_release_bound_journal_sidecar_and_qualify_owner_held_native_operation" as const });
}
