import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";
import { MACOS_HERMES_CLI_NATIVE_PROTOCOL_V1 } from "./macos-hermes-cli-release-sidecar-contract";

/**
 * This is the deliberately inert, fixture-only handoff shape for a future
 * Hermes native launch host.  It is not a host implementation: no pathname,
 * environment, runtime root, process option, or executable reaches it.
 */
export const PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_CUSTODY_V1 =
  "control-room.private-macos-hermes-native-launch-host-custody/v1" as const;
export const PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_FRAME_REQUEST_V1 =
  "control-room.private-macos-hermes-native-launch-host-frame-request/v1" as const;
export const PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_FRAME_V1 =
  "control-room.private-macos-hermes-native-launch-host-frame/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const frameMagic = "ACRHNL1\n";
const frameHeaderBytes = 24;
const frameDigestCount = 8;
const maximumFrameBytes = frameHeaderBytes + frameDigestCount * 32;

type CapturedInput = Readonly<{
  architecture: "arm64" | "x64";
  releaseVersion: string;
  releaseSha256: string;
  sidecarContractDigest: string;
  runtimeImageSha256: string;
  runtimeManifestDigest: string;
  importPolicyDigest: string;
  nativeHostArtifactSha256: string;
  nativeHostSourceSha256: string;
  bindingDigest: string;
}>;

const frameCustodies = new WeakMap<object, CapturedInput>();
const expectedBlockerCodes = Object.freeze([
  "native_runtime_image_not_verified",
  "native_launch_host_not_verified",
  "release_sidecar_not_bound",
  "protected_installed_manifest_not_materialized",
  "owner_attended_requalification_required",
  "runtime_import_policy_incompatible",
] as const);

function refused(): never {
  const error = new Error("private_macos_hermes_native_launch_host_custody_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name))
    || names.some(name => !actual.includes(name))) return refused();
  const copied: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    copied[name] = descriptor.value;
  }
  return Object.freeze(copied);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

/** Captures only ordinary, dense, fixed blocker data.  Do not call Array
 * methods on caller-owned arrays: an own method or indexed getter is code. */
function blockerCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0 || value.length !== expectedBlockerCodes.length) return refused();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names.some(name => name !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(name))) return refused();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || length.enumerable || !("value" in length)
    || length.value !== expectedBlockerCodes.length) return refused();
  const copied: string[] = [];
  for (const [index, expected] of expectedBlockerCodes.entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) || descriptor.value !== expected) return refused();
    copied.push(expected);
  }
  return Object.freeze(copied);
}

function captureInput(value: unknown): CapturedInput {
  const names = ["schema", "platform", "architecture", "releaseVersion", "releaseSha256", "sidecarContractDigest",
    "runtimeImageSha256", "runtimeManifestDigest", "importPolicyDigest", "nativeHostArtifactSha256",
    "nativeHostSourceSha256", "protocol", "status", "readyForLaunch", "filesystemCustodyVerified",
    "grantsLaunchAuthority", "grantsPackagingAuthority", "blockerCodes", "bindingDigest"] as const;
  const input = exact(value, names);
  const releaseSha256 = digest(input.releaseSha256), sidecarContractDigest = digest(input.sidecarContractDigest);
  const runtimeImageSha256 = digest(input.runtimeImageSha256), runtimeManifestDigest = digest(input.runtimeManifestDigest);
  const importPolicyDigest = digest(input.importPolicyDigest), nativeHostArtifactSha256 = digest(input.nativeHostArtifactSha256);
  const nativeHostSourceSha256 = digest(input.nativeHostSourceSha256), bindingDigest = digest(input.bindingDigest);
  const capturedBlockerCodes = blockerCodes(input.blockerCodes);
  if (input.schema !== "control-room.macos-hermes-native-host-input-contract/v1" || input.platform !== "darwin"
    || input.architecture !== "arm64" && input.architecture !== "x64" || typeof input.releaseVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.releaseVersion)
    || input.protocol !== MACOS_HERMES_CLI_NATIVE_PROTOCOL_V1 || input.status !== "input_consistency_only"
    || input.readyForLaunch !== false || input.filesystemCustodyVerified !== false
    || input.grantsLaunchAuthority !== false || input.grantsPackagingAuthority !== false) return refused();
  const material = { schema: input.schema, platform: input.platform, architecture: input.architecture,
    releaseVersion: input.releaseVersion, releaseSha256,
    sidecarContractDigest, runtimeImageSha256,
    runtimeManifestDigest, importPolicyDigest,
    nativeHostArtifactSha256, nativeHostSourceSha256,
    protocol: input.protocol, status: input.status, readyForLaunch: input.readyForLaunch,
    filesystemCustodyVerified: input.filesystemCustodyVerified, grantsLaunchAuthority: input.grantsLaunchAuthority,
    grantsPackagingAuthority: input.grantsPackagingAuthority, blockerCodes: capturedBlockerCodes };
  if (sha256Digest(material) !== bindingDigest) return refused();
  return Object.freeze({ architecture: input.architecture, releaseVersion: input.releaseVersion,
    releaseSha256, sidecarContractDigest, runtimeImageSha256, runtimeManifestDigest, importPolicyDigest,
    nativeHostArtifactSha256, nativeHostSourceSha256, bindingDigest });
}

function frame(input: CapturedInput): Buffer {
  const header = Buffer.alloc(frameHeaderBytes);
  header.write(frameMagic, "ascii");
  header[8] = input.architecture === "arm64" ? 1 : 2;
  header.writeUInt32BE(maximumFrameBytes, 12);
  header.writeUInt32BE(frameDigestCount, 16);
  const digests = [input.releaseSha256, input.sidecarContractDigest, input.runtimeImageSha256,
    input.runtimeManifestDigest, input.importPolicyDigest, input.nativeHostArtifactSha256,
    input.nativeHostSourceSha256, input.bindingDigest].map(value => Buffer.from(value.slice("sha256:".length), "hex"));
  const result = Buffer.concat([header, ...digests]);
  if (result.byteLength !== maximumFrameBytes) return refused();
  return result;
}

export type PrivateMacosHermesNativeLaunchHostCustodyV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_CUSTODY_V1;
  status: "fixture_frame_custody_ready";
  fixtureFrameCapability: object;
  maximumFrameBytes: number;
  acceptsCallerPath: false;
  acceptsPathEnvironment: false;
  acceptsRuntimeRoot: false;
  acceptsProfile: false;
  acceptsModel: false;
  acceptsProvider: false;
  acceptsWorkingDirectory: false;
  launchesHermes: false;
  grantsLaunchAuthority: false;
  remainingBlocker: "protected_installed_manifest_and_owner_attended_native_custody_missing";
}>;

/** Captures the pre-verified immutable record; construction performs no I/O or launch. */
export function createPrivateMacosHermesNativeLaunchHostCustodyV1(value: unknown): PrivateMacosHermesNativeLaunchHostCustodyV1 {
  const input = exact(value, ["schema", "verifiedImmutableInput"]);
  if (input.schema !== PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_CUSTODY_V1) return refused();
  const capability = Object.freeze({ schema: "control-room.private-macos-hermes-native-launch-host-frame-capability/v1" });
  frameCustodies.set(capability, captureInput(input.verifiedImmutableInput));
  return Object.freeze({ schema: PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_CUSTODY_V1,
    status: "fixture_frame_custody_ready" as const, fixtureFrameCapability: capability, maximumFrameBytes,
    acceptsCallerPath: false as const, acceptsPathEnvironment: false as const, acceptsRuntimeRoot: false as const,
    acceptsProfile: false as const, acceptsModel: false as const, acceptsProvider: false as const,
    acceptsWorkingDirectory: false as const, launchesHermes: false as const, grantsLaunchAuthority: false as const,
    remainingBlocker: "protected_installed_manifest_and_owner_attended_native_custody_missing" as const });
}

/** Burns one opaque capability and emits only a bounded test frame. It never starts Hermes. */
export function consumePrivateMacosHermesNativeLaunchHostFixtureFrameCapabilityV1(capability: unknown, request: unknown) {
  if (!capability || typeof capability !== "object" || types.isProxy(capability)) return refused();
  const captured = frameCustodies.get(capability);
  if (!captured || !frameCustodies.delete(capability)) return refused();
  const input = exact(request, ["schema"]);
  if (input.schema !== PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_FRAME_REQUEST_V1) return refused();
  const bytes = frame(captured);
  return Object.freeze({ schema: PRIVATE_MACOS_HERMES_NATIVE_LAUNCH_HOST_FRAME_V1,
    protocol: MACOS_HERMES_CLI_NATIVE_PROTOCOL_V1, bytes, byteLength: bytes.byteLength,
    launchesHermes: false as const, grantsLaunchAuthority: false as const });
}
