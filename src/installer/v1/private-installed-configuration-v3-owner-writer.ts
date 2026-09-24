import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";
import {
  consumePrivateInstalledConfigurationV3MaterializationCapabilityV1,
} from "./private-installed-configuration-preparation";
import {
  consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1,
} from "./macos-local-launcher-bundle.mjs";
import {
  stageMacosInstalledConfigurationNativeFactoryInputV1,
  retireMacosInstalledConfigurationNativeFactoryInputV1,
} from "./macos-installed-configuration-native-sidecar.mjs";
import {
  createPrivateInstalledConfigurationNativeHostV1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
  type PrivateInstalledConfigurationNativeHostV1,
  type PrivateInstalledConfigurationNativePublicationReceiptV1,
} from "./private-installed-configuration-native-host";

/**
 * The only effectful bridge from a prepared V3 installation to the reviewed
 * macOS publisher. Construction is inert. The owner invocation has no path,
 * byte, configuration, helper, or callback inputs.
 */
export const PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITER_V1 =
  "control-room.private-installed-configuration-v3-owner-writer/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REQUEST_V1 =
  "control-room.private-installed-configuration-v3-owner-write-request/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REPORT_V1 =
  "control-room.private-installed-configuration-v3-owner-write-report/v1" as const;
export const PRIVATE_INSTALLED_CONFIGURATION_V3_POST_WRITE_VERIFICATION_CAPABILITY_V1 =
  "control-room.private-installed-configuration-v3-post-write-verification-capability/v1" as const;

type Materialization = ReturnType<typeof consumePrivateInstalledConfigurationV3MaterializationCapabilityV1>;
type WriterCustody = ReturnType<typeof consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1>;

export type PrivateInstalledConfigurationV3OwnerWriteReportV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REPORT_V1;
  outcome: "published" | "uncertain";
  planDigest: string;
  configurationSha256: string;
  manifestSha256: string;
  publicationEvidenceDigest?: string;
  postWriteVerificationCapability?: object;
  rollback: Readonly<{
    state: "not_required" | "inspect_before_repeat";
    atomicVisibilityBoundary: true;
    partialFinalRootVisible: false;
    automaticRetryAllowed: false;
    finalRootState: "complete" | "complete_or_absent";
    stagedHelperCleanup: "confirmed" | "unconfirmed";
    evidenceDigest: string;
  }>;
  writesProtectedFiles: true;
  startsService: false;
  startsWorker: false;
  invokesClaude: false;
}>;

export type PrivateInstalledConfigurationV3OwnerWriterV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITER_V1;
  status: "ready_for_explicit_owner_attended_write";
  oneUse: true;
  acceptsPath: false;
  acceptsBytes: false;
  acceptsConfiguration: false;
  acceptsNativeCallback: false;
  performsEffectOnConstruction: false;
  materialize(request: Readonly<{
    schema: typeof PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REQUEST_V1;
    ownerAttended: true;
    signal: AbortSignal;
    deadlineUnixMs: number;
  }>): Promise<PrivateInstalledConfigurationV3OwnerWriteReportV1>;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
type PostWriteVerificationCapability = Readonly<{
  installationId: string;
  releaseDigest: string;
  planDigest: string;
  protectedRootPath: string;
  expectedOwnerUid: number;
  verificationDeadlineMs: number;
  configurationBytes: Uint8Array;
  configurationSha256: string;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  nativeVerifierContinuation: object;
}>;
const postWriteVerificationCapabilities = new WeakMap<object, PostWriteVerificationCapability>();

function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_installed_configuration_v3_owner_writer_${kind}`);
  error.stack = undefined;
  return error;
}
const refused = (): never => { throw sanitized("refused"); };

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(name => !keys.includes(name))) return refused();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
  }
  return value as Readonly<Record<string, unknown>>;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function request(value: unknown) {
  const input = exact(value, ["schema", "ownerAttended", "signal", "deadlineUnixMs"]);
  if (input.schema !== PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REQUEST_V1
    || input.ownerAttended !== true || !(input.signal instanceof AbortSignal) || input.signal.aborted
    || !Number.isSafeInteger(input.deadlineUnixMs)) return refused();
  const deadlineUnixMs = input.deadlineUnixMs as number, remaining = deadlineUnixMs - Date.now();
  if (remaining <= 0 || remaining > 30_000) return refused();
  return Object.freeze({ signal: input.signal, deadlineUnixMs });
}

function binding(materialization: Materialization, custody: WriterCustody) {
  const expectedRoot = join(homedir(), "Library", "Application Support", "Agent Control Room", "Protected");
  if (dirname(materialization.manifestPath) !== expectedRoot
    || materialization.configurationPath !== join(expectedRoot, "operator.json")
    || materialization.journalPath !== join(expectedRoot, "installation-journal")
    || materialization.manifestPath !== join(expectedRoot, "installed-manifest.json")
    || typeof process.getuid !== "function" || typeof process.geteuid !== "function"
    || process.getuid() !== process.geteuid() || process.geteuid() === 0
    || materialization.expectedOwnerUid !== process.geteuid()
    || sha256(materialization.configurationBytes) !== materialization.configurationSha256
    || sha256(materialization.manifestBytes) !== materialization.manifestSha256
    || custody.releaseManifestDigest !== materialization.releaseDigest) return refused();
  const sidecar = exact(custody.sidecar, ["schema", "verified", "releaseVersion", "platform", "architecture",
    "minimumMacos", "protocol", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256",
    "executableSha256", "sourceSha256", "toolchain", "files", "compiles", "downloads", "installs"]);
  if (sidecar.verified !== true || sidecar.platform !== "darwin" || sidecar.protocol !== "ACRCFG1") return refused();
  for (const name of ["sidecarManifestSha256", "archiveSha256", "artifactManifestSha256", "executableSha256"])
    digest(sidecar[name]);
  return Object.freeze({ rootPath: expectedRoot, sidecar, sidecarRoot: custody.sidecarRoot,
    postWriteVerifierContinuation: custody.postWriteVerifierContinuation });
}

function report(materialization: Materialization, outcome: "published" | "uncertain",
  cleanupConfirmed: boolean, receipt?: PrivateInstalledConfigurationNativePublicationReceiptV1,
  postWriteVerificationCapability?: object): PrivateInstalledConfigurationV3OwnerWriteReportV1 {
  const finalRootState = receipt ? "complete" as const : "complete_or_absent" as const;
  const rollbackMaterial = Object.freeze({ planDigest: materialization.planDigest, outcome,
    finalRootState, atomicVisibilityBoundary: true as const, partialFinalRootVisible: false as const,
    automaticRetryAllowed: false as const, stagedHelperCleanup: cleanupConfirmed ? "confirmed" as const : "unconfirmed" as const });
  const publicationEvidenceDigest = receipt ? sha256Digest({
    purpose: "private-installed-configuration-v3-publication/v1", planDigest: materialization.planDigest,
    configurationSha256: receipt.configurationSha256, manifestSha256: receipt.manifestSha256,
    ownerUid: receipt.ownerUid, rootIdentity: receipt.rootIdentity, configurationIdentity: receipt.configurationIdentity,
    manifestIdentity: receipt.manifestIdentity, journalIdentity: receipt.journalIdentity,
  }) : undefined;
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITE_REPORT_V1, outcome,
    planDigest: materialization.planDigest, configurationSha256: materialization.configurationSha256,
    manifestSha256: materialization.manifestSha256,
    ...(publicationEvidenceDigest ? { publicationEvidenceDigest } : {}),
    ...(outcome === "published" && postWriteVerificationCapability ? { postWriteVerificationCapability } : {}),
    rollback: Object.freeze({ state: receipt && cleanupConfirmed ? "not_required" as const : "inspect_before_repeat" as const,
      atomicVisibilityBoundary: true as const, partialFinalRootVisible: false as const,
      automaticRetryAllowed: false as const, finalRootState,
      stagedHelperCleanup: cleanupConfirmed ? "confirmed" as const : "unconfirmed" as const,
      evidenceDigest: sha256Digest({ purpose: "private-installed-configuration-v3-owner-write-rollback/v1",
        rollback: rollbackMaterial }) }), writesProtectedFiles: true as const, startsService: false as const,
    startsWorker: false as const, invokesClaude: false as const });
}

export function createPrivateInstalledConfigurationV3OwnerWriterV1(materializationCapability: unknown):
PrivateInstalledConfigurationV3OwnerWriterV1 {
  const materialization = consumePrivateInstalledConfigurationV3MaterializationCapabilityV1(materializationCapability);
  const custody = consumeMacosLocalLauncherInstalledConfigurationWriterContinuationV1(
    materialization.nativeWriterContinuation);
  let bound: ReturnType<typeof binding>;
  try { bound = binding(materialization, custody); }
  catch (error) {
    materialization.configurationBytes.fill(0); materialization.manifestBytes.fill(0); throw error;
  }
  let spent = false;
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_V3_OWNER_WRITER_V1,
    status: "ready_for_explicit_owner_attended_write" as const, oneUse: true as const,
    acceptsPath: false as const, acceptsBytes: false as const, acceptsConfiguration: false as const,
    acceptsNativeCallback: false as const, performsEffectOnConstruction: false as const,
    async materialize(value: unknown) {
      if (spent) return refused();
      const invocation = request(value); spent = true;
      let staged: Awaited<ReturnType<typeof stageMacosInstalledConfigurationNativeFactoryInputV1>> | undefined;
      let native: PrivateInstalledConfigurationNativeHostV1 | undefined;
      let receipt: PrivateInstalledConfigurationNativePublicationReceiptV1 | undefined;
      let hostCleanupConfirmed = false, stagingCleanupConfirmed = false;
      try {
        staged = await stageMacosInstalledConfigurationNativeFactoryInputV1({
          expectedArchiveSha256: bound.sidecar.archiveSha256,
          expectedArtifactManifestSha256: bound.sidecar.artifactManifestSha256,
          expectedExecutableSha256: bound.sidecar.executableSha256,
          expectedReleaseVersion: bound.sidecar.releaseVersion,
          expectedSidecarManifestSha256: bound.sidecar.sidecarManifestSha256,
          sidecarRoot: bound.sidecarRoot, stagingParent: await realpath(tmpdir()),
        });
        invocation.signal.throwIfAborted();
        const host = exact(staged.installedConfigurationNativeHostInput, ["executablePath", "executableSha256"]);
        native = createPrivateInstalledConfigurationNativeHostV1({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1,
          executablePath: host.executablePath, executableSha256: host.executableSha256,
          installationId: materialization.installationId, releaseDigest: materialization.releaseDigest,
          planDigest: materialization.planDigest, rootPath: bound.rootPath,
          expectedOwnerUid: materialization.expectedOwnerUid,
          configurationBytes: materialization.configurationBytes,
          configurationSha256: materialization.configurationSha256,
          manifestBytes: materialization.manifestBytes, manifestSha256: materialization.manifestSha256 });
        receipt = await native.publish({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
          deadlineUnixMs: invocation.deadlineUnixMs, signal: invocation.signal });
      } catch { /* One burned attempt; exact cleanup and receipt state decide the report. */ }
      try {
        if (native) {
          const cleaned = await native.cleanup(new AbortController().signal);
          hostCleanupConfirmed = cleaned.outcome === "confirmed";
        } else hostCleanupConfirmed = true;
      } catch { hostCleanupConfirmed = false; }
      try {
        if (staged) await retireMacosInstalledConfigurationNativeFactoryInputV1(staged);
        stagingCleanupConfirmed = true;
      } catch { stagingCleanupConfirmed = false; }
      let postWriteVerificationCapability: object | undefined;
      if (receipt && hostCleanupConfirmed && stagingCleanupConfirmed) {
        postWriteVerificationCapability = Object.freeze({
          schema: PRIVATE_INSTALLED_CONFIGURATION_V3_POST_WRITE_VERIFICATION_CAPABILITY_V1,
        });
        postWriteVerificationCapabilities.set(postWriteVerificationCapability, Object.freeze({
          installationId: materialization.installationId, releaseDigest: materialization.releaseDigest,
          planDigest: materialization.planDigest, protectedRootPath: bound.rootPath,
          expectedOwnerUid: materialization.expectedOwnerUid,
          verificationDeadlineMs: materialization.verificationDeadlineMs,
          configurationBytes: Uint8Array.from(materialization.configurationBytes),
          configurationSha256: materialization.configurationSha256,
          manifestBytes: Uint8Array.from(materialization.manifestBytes),
          manifestSha256: materialization.manifestSha256,
          nativeVerifierContinuation: bound.postWriteVerifierContinuation,
        }));
      }
      materialization.configurationBytes.fill(0); materialization.manifestBytes.fill(0);
      const cleanupConfirmed = hostCleanupConfirmed && stagingCleanupConfirmed;
      if (receipt && cleanupConfirmed) return report(materialization, "published", true, receipt,
        postWriteVerificationCapability);
      return report(materialization, "uncertain", cleanupConfirmed, receipt);
    },
  });
}

/**
 * Burns the exact post-write binding for the native verifier composer. The
 * continuation and bytes from launcher A never appear in the public receipt
 * and cannot be recombined with a caller-selected launcher B.
 */
export function consumePrivateInstalledConfigurationV3PostWriteVerificationCapabilityV1(value: unknown) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const captured = postWriteVerificationCapabilities.get(value);
  if (!captured || !postWriteVerificationCapabilities.delete(value)) return refused();
  return Object.freeze({ schema: PRIVATE_INSTALLED_CONFIGURATION_V3_POST_WRITE_VERIFICATION_CAPABILITY_V1,
    installationId: captured.installationId, releaseDigest: captured.releaseDigest, planDigest: captured.planDigest,
    protectedRootPath: captured.protectedRootPath, expectedOwnerUid: captured.expectedOwnerUid,
    verificationDeadlineMs: captured.verificationDeadlineMs,
    configurationBytes: Uint8Array.from(captured.configurationBytes), configurationSha256: captured.configurationSha256,
    manifestBytes: Uint8Array.from(captured.manifestBytes), manifestSha256: captured.manifestSha256,
    nativeVerifierContinuation: captured.nativeVerifierContinuation });
}
