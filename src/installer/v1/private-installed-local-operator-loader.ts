import { types } from "node:util";
import { exactHostDataSnapshotV1 } from "../../security/host-value";
import { capturePrivateInstalledClaudePostInstallInputV1 } from "./private-installed-claude-post-install-input";
import { canonicalJson } from "../../security/canonical-digest";
import { createPrivateInstalledConfigurationCustodyV2, createPrivateInstalledConfigurationCustodyV3,
  PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3 } from
  "./private-installed-configuration-custody";
import { createPrivateInstalledJournalCustodyCompositionV1,
  MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1,
  PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1,
  PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1 } from
  "./private-installed-journal-custody-composer";
import { createPrivateInstalledLocalHermesRuntimeComposerV1 } from
  "./private-installed-local-hermes-runtime-composer";
import { consumePrivateInstalledClaudeProcessSidecarStagingCapabilityV1,
  consumePrivateInstalledConfigurationNativeVerifierLoaderCapabilityV1 } from
  "./private-installed-configuration-native-verifier-custody";
import { retireMacosClaudeCodeProcessNativeFactoryInputV1 } from
  "./macos-claude-code-process-native-sidecar.mjs";
import { createPrivateMacosClaudeCodeInstalledPortComposerV1,
  PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1 } from
  "../../node-bridge/private-macos-claude-code-installed-port-composer";
import { composePrivateMacosClaudeCodePostInstallV1,
  PRIVATE_MACOS_CLAUDE_CODE_POST_INSTALL_BRIDGE_V1 } from
  "../../node-bridge/private-macos-claude-code-post-install-bridge";

/**
 * One installed-process handoff from protected v2 data to the reviewed Hermes
 * graph and the canonical held-session installation journal. The constructor
 * captures only explicitly injected owner/native inputs. It performs no read,
 * stages no native bytes, constructs no journal, and starts no runtime.
 */
export const PRIVATE_INSTALLED_LOCAL_OPERATOR_LOADER_V1 =
  "control-room.private-installed-local-operator-loader/v1" as const;

const refused = (): never => {
  const error = new Error("private_installed_local_operator_loader_refused");
  error.stack = undefined;
  throw error;
};

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

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const dataViewGetUint8 = DataView.prototype.getUint8;
const abortSignalPrototype = AbortSignal.prototype;
const abortSignalAborted = Object.getOwnPropertyDescriptor(abortSignalPrototype, "aborted")?.get;
const nativeAbortSignalSymbols = Object.freeze(Object.getOwnPropertySymbols(new AbortController().signal));

/** Copy bytes without consulting Symbol.iterator, a species constructor, an
 * own accessor, or a caller-selected prototype. */
function captureBytes(value: unknown): Uint8Array {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0
    || typeof typedArrayBuffer !== "function" || typeof typedArrayByteLength !== "function"
    || typeof typedArrayByteOffset !== "function") return refused();
  let buffer: ArrayBufferLike, byteLength: number, byteOffset: number;
  try {
    buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
    byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
  } catch { return refused(); }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isSafeInteger(byteOffset) || byteOffset < 0) return refused();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== byteLength) return refused();
  for (let index = 0; index < byteLength; index += 1) {
    if (names[index] !== String(index)) return refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)
      || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) return refused();
  }
  let source: DataView;
  try { source = new DataView(buffer, byteOffset, byteLength); }
  catch { return refused(); }
  const result = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    try { result[index] = Reflect.apply(dataViewGetUint8, source, [index]) as number; }
    catch { return refused(); }
  }
  return result;
}

function callable(value: unknown): (...args: never[]) => unknown {
  if (typeof value !== "function" || types.isProxy(value)) return refused();
  return value as (...args: never[]) => unknown;
}

function captureInertData(value: unknown, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refused();
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) return refused();
  if (Object.getPrototypeOf(value) === Uint8Array.prototype) return captureBytes(value);
  active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0
      || Object.getOwnPropertyNames(value).length !== (length.value as number) + 1) return refused();
    const result: unknown[] = new Array(length.value as number);
    for (let index = 0; index < result.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
      result[index] = captureInertData(descriptor.value, active);
    }
    active.delete(value); return Object.freeze(result);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const result: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "__proto__" || name === "prototype" || name === "constructor") return refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    result[name] = captureInertData(descriptor.value, active);
  }
  active.delete(value); return Object.freeze(result);
}

function captureCustodyInput(value: unknown): unknown {
  const input = exact(value, ["schema", "manifestPath", "manifestBytes", "manifestSha256", "expectedOwnerUid",
    "verificationDeadlineMs", "native"]);
  if (input.schema !== PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2
    && input.schema !== PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3) return refused();
  const native = exact(input.native, ["verifyProtectedPath"]), verifyProtectedPath = callable(native.verifyProtectedPath);
  return Object.freeze({ schema: input.schema,
    manifestPath: input.manifestPath, manifestBytes: input.manifestBytes, manifestSha256: input.manifestSha256,
    expectedOwnerUid: input.expectedOwnerUid, verificationDeadlineMs: input.verificationDeadlineMs,
    native: Object.freeze({ verifyProtectedPath }) });
}

function captureStagedSidecar(value: unknown): unknown {
  const staged = exact(value, ["schema", "nativeArtifact", "installationJournalNativeFactoryInput", "staged",
    "compiles", "downloads", "installs"]);
  if (staged.schema !== MACOS_INSTALLATION_JOURNAL_NATIVE_SIDECAR_V1 || staged.staged !== true
    || staged.compiles !== false || staged.downloads !== false || staged.installs !== false) return refused();
  const artifact = exact(staged.nativeArtifact, ["schema", "verified", "releaseVersion", "platform", "architecture",
    "minimumMacos", "protocol", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256",
    "executableSha256", "sourceSha256", "toolchain", "files", "compiles", "downloads", "installs"]);
  const factory = exact(staged.installationJournalNativeFactoryInput, ["executablePath", "executableSha256"]);
  return Object.freeze({ schema: staged.schema,
    nativeArtifact: captureInertData(artifact),
    installationJournalNativeFactoryInput: captureInertData(factory),
    staged: true as const, compiles: false as const, downloads: false as const, installs: false as const });
}

function captureJournalPorts(value: unknown): unknown {
  const ports = exact(value, ["schema", "createNativeSessionPort"]);
  if (ports.schema !== PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1) return refused();
  return Object.freeze({ schema: PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1,
    createNativeSessionPort: callable(ports.createNativeSessionPort) });
}

function permittedHermesOpaque(path: string, value: object): boolean {
  // The runner is a process-local branded capability. Copying it as ordinary
  // JSON would lose its custody; preserve it only for the installed composer,
  // which verifies its exact installation binding before selecting it.
  if (path === "hermesRuntimePorts.ownerAuthorizedLocalHermesRunner"
    || path === "hermesRuntimePorts.ownerAuthorizedLocalHermesRunnerProvider") return true;
  if (/^hermesRuntimePorts\.setupRuntimes\.[^.]+\.[^.]+\.signal$/u.test(path)) {
    if (Object.getPrototypeOf(value) !== abortSignalPrototype
      || Object.getOwnPropertyNames(value).length !== 0) return refused();
    const symbols = Object.getOwnPropertySymbols(value);
    if (nativeAbortSignalSymbols.some(symbol => !symbols.includes(symbol))
      || symbols.some(symbol => {
        const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
        return !descriptor || !("value" in descriptor);
      }) || typeof abortSignalAborted !== "function") return refused();
    try { Reflect.apply(abortSignalAborted, value, []); }
    catch { return refused(); }
    return true;
  }
  return path === "hermesRuntimePorts.startupBase.coordinator.approvals.store"
    || path === "hermesRuntimePorts.startupBase.web.tasks.results.storage"
    || /^hermesRuntimePorts\.startupBase\.web\.tasks\.(?:reviews|ownerReviews)\.checkpoints$/u.test(path);
}

function captureHermesGraph(value: unknown, path: string, active = new WeakSet<object>(),
  seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refused();
  if (typeof value === "function") return callable(value);
  if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) return refused();
  if (Object.getPrototypeOf(value) === Uint8Array.prototype) return captureBytes(value);
  if (permittedHermesOpaque(path, value)) return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== Array.prototype)
    return refused();
  if (Object.getOwnPropertySymbols(value).length !== 0) return refused();
  active.add(value);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0
      || Object.getOwnPropertyNames(value).length !== (length.value as number) + 1) return refused();
    const result: unknown[] = new Array(length.value as number); seen.set(value, result);
    for (let index = 0; index < result.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
      result[index] = captureHermesGraph(descriptor.value, `${path}[${index}]`, active, seen);
    }
    active.delete(value); return Object.freeze(result);
  }
  const result: Record<string, unknown> = {}; seen.set(value, result);
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === "__proto__" || name === "prototype" || name === "constructor") return refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    result[name] = captureHermesGraph(descriptor.value, `${path}.${name}`, active, seen);
  }
  active.delete(value); return Object.freeze(result);
}

function captureHermesPorts(value: unknown): unknown {
  const ports = exactHostDataSnapshotV1(value,
    ["startupBase", "deliveryIntegrityKey", "assertCurrentDelivery", "setupRuntimes"],
    ["claudePostInstall", "ownerAuthorizedLocalHermesRunner", "ownerAuthorizedLocalHermesRunnerProvider"]);
  if (!ports) return refused();
  return Object.freeze({ startupBase: captureHermesGraph(ports.startupBase, "hermesRuntimePorts.startupBase"),
    deliveryIntegrityKey: captureBytes(ports.deliveryIntegrityKey),
    assertCurrentDelivery: callable(ports.assertCurrentDelivery),
    setupRuntimes: captureHermesGraph(ports.setupRuntimes, "hermesRuntimePorts.setupRuntimes"),
    ...(Object.prototype.hasOwnProperty.call(ports, "claudePostInstall")
      ? { claudePostInstall: capturePrivateInstalledClaudePostInstallInputV1(ports.claudePostInstall) } : {}),
    ...(Object.prototype.hasOwnProperty.call(ports, "ownerAuthorizedLocalHermesRunner")
      ? { ownerAuthorizedLocalHermesRunner: captureHermesGraph(ports.ownerAuthorizedLocalHermesRunner,
        "hermesRuntimePorts.ownerAuthorizedLocalHermesRunner") } : {}),
    ...(Object.prototype.hasOwnProperty.call(ports, "ownerAuthorizedLocalHermesRunnerProvider")
      ? { ownerAuthorizedLocalHermesRunnerProvider: captureHermesGraph(ports.ownerAuthorizedLocalHermesRunnerProvider,
        "hermesRuntimePorts.ownerAuthorizedLocalHermesRunnerProvider") } : {}) });
}

type ClaudeProtectedBinding = Readonly<{
  nativeVerifierCapability: object;
  nativeVerifier: ReturnType<typeof consumePrivateInstalledConfigurationNativeVerifierLoaderCapabilityV1>;
  claudePostInstall: unknown;
  processPortConfiguration: unknown;
}>;

function captureClaudeProtectedBinding(value: unknown): ClaudeProtectedBinding {
  const binding = exact(value, ["nativeVerifierCapability", "claudePostInstall", "processPortConfiguration"]);
  if (!binding.nativeVerifierCapability || typeof binding.nativeVerifierCapability !== "object"
    || types.isProxy(binding.nativeVerifierCapability)) return refused();
  const nativeVerifier = consumePrivateInstalledConfigurationNativeVerifierLoaderCapabilityV1(
    binding.nativeVerifierCapability);
  const tuple = exact(binding.claudePostInstall, ["admissionInput", "admissionRuntime", "compositionInput"]);
  const composition = exact(tuple.compositionInput, ["tenantId", "installedProcessConfiguration", "execution",
    "reviewCheckpoints", "assertCurrentProcess", "assertCurrentDelivery"]);
  // Insert only an inert local placeholder so the established capture and
  // post-install bridge can be reused. A caller-supplied `ports` field is not
  // accepted at this protected boundary.
  const claudePostInstall = capturePrivateInstalledClaudePostInstallInputV1(Object.freeze({
    admissionInput: tuple.admissionInput, admissionRuntime: tuple.admissionRuntime,
    compositionInput: Object.freeze({ tenantId: composition.tenantId,
      installedProcessConfiguration: composition.installedProcessConfiguration, ports: Object.freeze({}),
      execution: composition.execution, reviewCheckpoints: composition.reviewCheckpoints,
      assertCurrentProcess: composition.assertCurrentProcess, assertCurrentDelivery: composition.assertCurrentDelivery }),
  }));
  return Object.freeze({ nativeVerifierCapability: binding.nativeVerifierCapability as object, nativeVerifier,
    claudePostInstall,
    processPortConfiguration: captureHermesGraph(binding.processPortConfiguration,
      "claudeProtectedBinding.processPortConfiguration") });
}

type CapturedInput = Readonly<{
  installedConfigurationCustodyInput: unknown;
  hermesRuntimePorts: unknown;
  journalCustodyPorts: unknown;
  stagedJournalSidecar: unknown;
  journalOperationDeadlineMs: number;
  claudeProtectedBinding?: ClaudeProtectedBinding;
}>;

function captureInput(value: unknown): CapturedInput {
  const input = exactHostDataSnapshotV1(value, ["schema", "installedConfigurationCustodyInput", "hermesRuntimePorts",
    "journalCustodyPorts", "stagedJournalSidecar", "journalOperationDeadlineMs"], ["claudeProtectedBinding"]);
  if (!input) return refused();
  if (input.schema !== PRIVATE_INSTALLED_LOCAL_OPERATOR_LOADER_V1
    || !Number.isSafeInteger(input.journalOperationDeadlineMs)
    || (input.journalOperationDeadlineMs as number) < 1
    || (input.journalOperationDeadlineMs as number) > 30_000) return refused();
  return Object.freeze({
    installedConfigurationCustodyInput: captureCustodyInput(input.installedConfigurationCustodyInput),
    hermesRuntimePorts: captureHermesPorts(input.hermesRuntimePorts),
    journalCustodyPorts: captureJournalPorts(input.journalCustodyPorts),
    stagedJournalSidecar: captureStagedSidecar(input.stagedJournalSidecar),
    journalOperationDeadlineMs: input.journalOperationDeadlineMs as number,
    ...(Object.prototype.hasOwnProperty.call(input, "claudeProtectedBinding")
      ? { claudeProtectedBinding: captureClaudeProtectedBinding(input.claudeProtectedBinding) } : {}),
  });
}

export type PrivateInstalledLocalOperatorLoaderV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_LOCAL_OPERATOR_LOADER_V1;
  status: "owner_inputs_captured";
  loadInstalledConfiguration(): Promise<Readonly<{ custody: unknown; journal: unknown }>>;
  retireClaudeProcessSidecar(): Promise<void>;
  performsEffectOnConstruction: false;
  readsProtectedConfigurationOnLoad: true;
  stagesNativeSidecar: boolean;
  opensNativeSessionOnConstruction: false;
  opensDatabase: false;
  startsService: false;
  startsWorker: false;
  invokesHermes: false;
}>;

/**
 * The returned loader is one-use. It is burned before the first protected
 * read, so a refusal, cancellation, or uncertain owner port can never be
 * retried by reconstructing journal authority in the same process.
 */
export function createPrivateInstalledLocalOperatorLoaderV1(inputValue: unknown):
PrivateInstalledLocalOperatorLoaderV1 {
  let input: CapturedInput;
  try { input = captureInput(inputValue); }
  catch { return refused(); }
  let spent = false;
  let retainedClaudeSidecar: Awaited<ReturnType<
    typeof consumePrivateInstalledClaudeProcessSidecarStagingCapabilityV1>> | undefined;
  const loadInstalledConfiguration = async () => {
    if (spent) return refused();
    spent = true;
    let stagedClaude: Awaited<ReturnType<typeof consumePrivateInstalledClaudeProcessSidecarStagingCapabilityV1>> | undefined;
    try {
      let prepared;
      if (input.claudeProtectedBinding) {
        prepared = await input.claudeProtectedBinding.nativeVerifier.custody
          .loadManifestBoundPrivateConfigurationData();
      } else {
        const custodySchema = (input.installedConfigurationCustodyInput as { schema?: unknown }).schema;
        const installed = custodySchema === PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V3
          ? await createPrivateInstalledConfigurationCustodyV3(input.installedConfigurationCustodyInput)
          : await createPrivateInstalledConfigurationCustodyV2(input.installedConfigurationCustodyInput);
        if (installed.status !== "manifest_bound_configuration_ready") return refused();
        prepared = await installed.custody.loadManifestBoundPrivateConfigurationData();
      }
      const { claudeCodeProcessReleaseCapability, ...journalPrepared } = prepared as typeof prepared &
        { claudeCodeProcessReleaseCapability?: unknown };
      let hermesRuntimePorts = input.hermesRuntimePorts;
      if (input.claudeProtectedBinding) {
        if (claudeCodeProcessReleaseCapability === undefined) return refused();
        stagedClaude = await consumePrivateInstalledClaudeProcessSidecarStagingCapabilityV1(
          input.claudeProtectedBinding.nativeVerifier.claudeProcessSidecarStagingCapability);
        const staged = exact(stagedClaude, ["schema", "nativeArtifact", "claudeCodeProcessPortFactoryInput",
          "stagingRoot", "staged", "compiles", "downloads", "installs"]);
        const factory = exact(staged.claudeCodeProcessPortFactoryInput, ["helperPath", "helperSha256"]);
        const portConfiguration = exact(input.claudeProtectedBinding.processPortConfiguration,
          ["schema", "executablePath", "executableSha256", "executableIdentity", "workingDirectory",
            "workingDirectoryIdentity", "workingDirectoryBindingDigest", "qualificationDigest", "ownerUid",
            "holdDeadlineMs", "runDeadlineMs", "maximumInputBytes", "maximumOutputBytes"]);
        const tuple = input.claudeProtectedBinding.claudePostInstall as {
          admissionInput: { qualificationReport?: unknown }; compositionInput: { installedProcessConfiguration?: unknown };
        };
        const composed = createPrivateMacosClaudeCodeInstalledPortComposerV1(Object.freeze({
          schema: PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_COMPOSER_V1,
          manifestReleaseCapability: claudeCodeProcessReleaseCapability,
          verifiedSidecar: staged.nativeArtifact,
          installedProcessConfiguration: tuple.compositionInput.installedProcessConfiguration,
          processPortConfiguration: Object.freeze({ ...portConfiguration,
            helperPath: factory.helperPath, helperSha256: factory.helperSha256 }),
          qualificationReport: tuple.admissionInput.qualificationReport,
        }));
        const bridged = composePrivateMacosClaudeCodePostInstallV1(Object.freeze({
          schema: PRIVATE_MACOS_CLAUDE_CODE_POST_INSTALL_BRIDGE_V1,
          claudePostInstall: input.claudeProtectedBinding.claudePostInstall, capability: composed.capability,
        }));
        hermesRuntimePorts = Object.freeze({ ...(input.hermesRuntimePorts as Readonly<Record<string, unknown>>),
          claudePostInstall: bridged });
      }
      const runtime = createPrivateInstalledLocalHermesRuntimeComposerV1(journalPrepared, hermesRuntimePorts);
      const journalComposition = createPrivateInstalledJournalCustodyCompositionV1(Object.freeze({
        schema: PRIVATE_INSTALLED_JOURNAL_CUSTODY_COMPOSER_V1,
        manifestBoundPreparation: journalPrepared,
        operationDeadlineMs: input.journalOperationDeadlineMs,
        ports: input.journalCustodyPorts,
      }));
      if (runtime.status !== "configuration_graph_ready"
        || journalComposition.status !== "journal_custody_factory_ready"
        || journalComposition.installationId !== prepared.installationId
        || canonicalJson(journalComposition.nativeSidecar) !== canonicalJson(prepared.nativeSidecar)) return refused();
      const activated = journalComposition.custody.constructJournal(input.stagedJournalSidecar);
      if (canonicalJson(activated.journalBinding) !== canonicalJson(prepared.journal)
        || canonicalJson(activated.nativeSidecar) !== canonicalJson(prepared.nativeSidecar)) return refused();
      retainedClaudeSidecar = stagedClaude;
      stagedClaude = undefined;
      return Object.freeze({ custody: runtime.custody, journal: activated.journal,
        ...(!input.claudeProtectedBinding && claudeCodeProcessReleaseCapability !== undefined
          ? { claudeCodeProcessReleaseCapability } : {}) });
    } catch {
      if (stagedClaude) await retireMacosClaudeCodeProcessNativeFactoryInputV1(stagedClaude).catch(() => undefined);
      return refused();
    }
  };
  const retireClaudeProcessSidecar = async () => {
    const staged = retainedClaudeSidecar;
    if (!staged) return;
    retainedClaudeSidecar = undefined;
    try { await retireMacosClaudeCodeProcessNativeFactoryInputV1(staged); }
    catch { return refused(); }
  };
  return Object.freeze({ schema: PRIVATE_INSTALLED_LOCAL_OPERATOR_LOADER_V1,
    status: "owner_inputs_captured" as const, loadInstalledConfiguration, retireClaudeProcessSidecar,
    performsEffectOnConstruction: false as const, readsProtectedConfigurationOnLoad: true as const,
    stagesNativeSidecar: Boolean(input.claudeProtectedBinding), opensNativeSessionOnConstruction: false as const,
    opensDatabase: false as const, startsService: false as const, startsWorker: false as const,
    invokesHermes: false as const });
}
