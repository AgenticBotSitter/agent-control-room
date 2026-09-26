import { types } from "node:util";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from
  "../../harness/hermes-021-v1/connector-profile";

export const MACOS_HERMES_CLI_RELEASE_SIDECAR_CONTRACT_V1 =
  "control-room.macos-hermes-cli-release-sidecar-contract/v1" as const;
export const MACOS_HERMES_CLI_NATIVE_PROTOCOL_V1 = "ACRHCP1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const blockers = [
  "native_runtime_image_not_verified",
  "native_launch_host_not_verified",
  "release_sidecar_not_bound",
  "protected_installed_manifest_not_materialized",
  "owner_attended_requalification_required",
] as const;

const runtimePackagingSchema = z.object({
  kind: z.literal("read_only_complete_runtime_image"),
  runtimeImageSha256: digest,
  runtimeManifestSha256: digest,
  modifiesHermesSource: z.literal(false),
  includesCredentials: z.literal(false),
  includesPrivateConfiguration: z.literal(false),
  rejectsLinks: z.literal(true),
  rejectsSpecialFiles: z.literal(true),
  rejectsExtraEntries: z.literal(true),
}).strict();

const nativeHostSchema = z.object({
  protocol: z.literal(MACOS_HERMES_CLI_NATIVE_PROTOCOL_V1),
  artifactSha256: digest,
  sourceSha256: digest,
  acceptsCallerExecutablePath: z.literal(false),
  acceptsCallerRuntimePath: z.literal(false),
  usesPathLookup: z.literal(false),
  trustsMutablePathname: z.literal(false),
  launchesOnlyFromVerifiedReadOnlyRuntimeImage: z.literal(true),
  requiresInstalledManifestBinding: z.literal(true),
}).strict();

const contractSchema = z.object({
  schema: z.literal(MACOS_HERMES_CLI_RELEASE_SIDECAR_CONTRACT_V1),
  releaseVersion: version,
  releaseSha256: digest,
  platform: z.literal("darwin"),
  architecture: z.enum(["arm64", "x64"]),
  minimumMacos: z.literal("13.0"),
  hermesVersion: z.literal(HERMES_021_VERSION_V1),
  hermesSourceRevision: z.literal(HERMES_021_SOURCE_REVISION_V1),
  runtimePackaging: runtimePackagingSchema,
  nativeHost: nativeHostSchema,
  status: z.literal("contract_only"),
  blockerCodes: z.tuple(blockers.map(value => z.literal(value)) as [
    z.ZodLiteral<(typeof blockers)[0]>, z.ZodLiteral<(typeof blockers)[1]>,
    z.ZodLiteral<(typeof blockers)[2]>, z.ZodLiteral<(typeof blockers)[3]>,
    z.ZodLiteral<(typeof blockers)[4]>,
  ]),
  grantsLaunchAuthority: z.literal(false),
  grantsQualificationAuthority: z.literal(false),
  stagesArtifact: z.literal(false),
  mountsRuntimeImage: z.literal(false),
  startsProcess: z.literal(false),
  readsCredentials: z.literal(false),
  nativeAttemptsMade: z.literal(0),
  contractDigest: digest,
}).strict();

export type MacosHermesCliReleaseSidecarContractV1 = Readonly<z.infer<typeof contractSchema>>;

const inputNames = ["architecture", "nativeHostArtifactSha256", "nativeHostSourceSha256", "releaseSha256",
  "releaseVersion", "runtimeImageSha256", "runtimeManifestSha256"] as const;
const contractNames = ["architecture", "blockerCodes", "contractDigest", "grantsLaunchAuthority",
  "grantsQualificationAuthority", "hermesSourceRevision", "hermesVersion", "minimumMacos", "mountsRuntimeImage",
  "nativeAttemptsMade", "nativeHost", "platform", "readsCredentials", "releaseSha256", "releaseVersion", "runtimePackaging",
  "schema", "stagesArtifact", "startsProcess", "status"] as const;
const runtimeNames = ["includesCredentials", "includesPrivateConfiguration", "kind", "modifiesHermesSource",
  "rejectsExtraEntries", "rejectsLinks", "rejectsSpecialFiles", "runtimeImageSha256", "runtimeManifestSha256"] as const;
const nativeNames = ["acceptsCallerExecutablePath", "acceptsCallerRuntimePath", "artifactSha256",
  "launchesOnlyFromVerifiedReadOnlyRuntimeImage", "protocol", "requiresInstalledManifestBinding", "sourceSha256",
  "trustsMutablePathname", "usesPathLookup"] as const;

function refuse(): never {
  const error = new Error("macos_hermes_cli_release_sidecar_contract_refused");
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

function parsedContract(value: unknown): z.infer<typeof contractSchema> {
  const outer = exact(value, contractNames);
  exact(outer.runtimePackaging, runtimeNames);
  exact(outer.nativeHost, nativeNames);
  if (!Array.isArray(outer.blockerCodes) || types.isProxy(outer.blockerCodes)) refuse();
  const result = contractSchema.safeParse(value);
  if (!result.success) refuse();
  const material = { ...result.data } as Record<string, unknown>;
  delete material.contractDigest;
  if (sha256Digest(material) !== result.data.contractDigest) refuse();
  return result.data;
}

function freezeContract(value: z.infer<typeof contractSchema>): MacosHermesCliReleaseSidecarContractV1 {
  Object.freeze(value.runtimePackaging);
  Object.freeze(value.nativeHost);
  Object.freeze(value.blockerCodes);
  return Object.freeze(value);
}

/**
 * Defines only the immutable release inputs a later macOS Hermes launch sidecar
 * must bind. Digest strings are expected pins, not provenance. The result is
 * deliberately blocked and is never accepted as launch or qualification
 * authority.
 */
export function prepareMacosHermesCliReleaseSidecarContractV1(value: unknown):
  MacosHermesCliReleaseSidecarContractV1 {
  const input = exact(value, inputNames);
  const parsed = z.object({
    architecture: z.enum(["arm64", "x64"]),
    nativeHostArtifactSha256: digest,
    nativeHostSourceSha256: digest,
    releaseSha256: digest,
    releaseVersion: version,
    runtimeImageSha256: digest,
    runtimeManifestSha256: digest,
  }).strict().safeParse(input);
  if (!parsed.success) refuse();
  const material = {
    schema: MACOS_HERMES_CLI_RELEASE_SIDECAR_CONTRACT_V1,
    releaseVersion: parsed.data.releaseVersion,
    releaseSha256: parsed.data.releaseSha256,
    platform: "darwin" as const,
    architecture: parsed.data.architecture,
    minimumMacos: "13.0" as const,
    hermesVersion: HERMES_021_VERSION_V1,
    hermesSourceRevision: HERMES_021_SOURCE_REVISION_V1,
    runtimePackaging: {
      kind: "read_only_complete_runtime_image" as const,
      runtimeImageSha256: parsed.data.runtimeImageSha256,
      runtimeManifestSha256: parsed.data.runtimeManifestSha256,
      modifiesHermesSource: false as const,
      includesCredentials: false as const,
      includesPrivateConfiguration: false as const,
      rejectsLinks: true as const,
      rejectsSpecialFiles: true as const,
      rejectsExtraEntries: true as const,
    },
    nativeHost: {
      protocol: MACOS_HERMES_CLI_NATIVE_PROTOCOL_V1,
      artifactSha256: parsed.data.nativeHostArtifactSha256,
      sourceSha256: parsed.data.nativeHostSourceSha256,
      acceptsCallerExecutablePath: false as const,
      acceptsCallerRuntimePath: false as const,
      usesPathLookup: false as const,
      trustsMutablePathname: false as const,
      launchesOnlyFromVerifiedReadOnlyRuntimeImage: true as const,
      requiresInstalledManifestBinding: true as const,
    },
    status: "contract_only" as const,
    blockerCodes: blockers,
    grantsLaunchAuthority: false as const,
    grantsQualificationAuthority: false as const,
    stagesArtifact: false as const,
    mountsRuntimeImage: false as const,
    startsProcess: false as const,
    readsCredentials: false as const,
    nativeAttemptsMade: 0 as const,
  };
  return freezeContract(contractSchema.parse({ ...material, contractDigest: sha256Digest(material) }));
}

/** Parses a saved contract for display or release planning. It still grants no authority. */
export function parseMacosHermesCliReleaseSidecarContractV1(value: unknown):
  MacosHermesCliReleaseSidecarContractV1 {
  return freezeContract(parsedContract(value));
}

/** Canonical serialization for a future deterministic sidecar manifest. */
export function serializeMacosHermesCliReleaseSidecarContractV1(value: unknown): string {
  return `${canonicalJson(parseMacosHermesCliReleaseSidecarContractV1(value))}\n`;
}
