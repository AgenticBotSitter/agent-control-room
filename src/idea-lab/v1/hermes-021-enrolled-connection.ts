import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security";
import { exactHostDataArrayV1, exactHostDataSnapshotV1 } from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { ideaLabHermes021FixedOperationSetSchemaV1 } from "./hermes-021-fixed-operation-set";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
} from "./hermes-021-panel-packet";
import { capturedIdeaTimeMillisecondsV1, capturedPatternMatchesV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaTimeSchemaV1 } from "./schemas";

const rosterArrayIsArrayV1 = Array.isArray;
const rosterArraySortV1 = Array.prototype.sort;
const rosterJsonStringifyV1 = JSON.stringify;
const rosterNumberIsFiniteV1 = Number.isFinite;
const rosterObjectFreezeV1 = Object.freeze;
const rosterObjectGetOwnPropertyDescriptorV1 = Object.getOwnPropertyDescriptor;
const rosterObjectGetPrototypeOfV1 = Object.getPrototypeOf;
const rosterObjectKeysV1 = Object.keys;
const rosterReflectApplyV1 = Reflect.apply;
const rosterHashProbeV1 = createHash("sha256");
const rosterHashPrototypeV1 = rosterObjectGetPrototypeOfV1(rosterHashProbeV1);
const rosterHashUpdateCandidateV1 = rosterObjectGetOwnPropertyDescriptorV1(rosterHashPrototypeV1, "update")?.value;
const rosterHashDigestCandidateV1 = rosterObjectGetOwnPropertyDescriptorV1(rosterHashPrototypeV1, "digest")?.value;
if (typeof rosterHashUpdateCandidateV1 !== "function" || typeof rosterHashDigestCandidateV1 !== "function") {
  throw new Error("SHA-256 runtime unavailable");
}
const rosterHashUpdateV1 = rosterHashUpdateCandidateV1 as (...args: unknown[]) => unknown;
const rosterHashDigestV1 = rosterHashDigestCandidateV1 as (...args: unknown[]) => unknown;

function capturedRosterCanonicalJsonV1(value: unknown, path = "$", depth = 0): string {
  if (depth > 64) throw new Error(`Canonical depth exceeded at ${path}`);
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return rosterReflectApplyV1(rosterJsonStringifyV1, JSON, [value]) as string;
  }
  if (typeof value === "number") {
    if (!rosterReflectApplyV1(rosterNumberIsFiniteV1, Number, [value])) {
      throw new Error(`Non-finite number at ${path}`);
    }
    return rosterReflectApplyV1(rosterJsonStringifyV1, JSON, [value]) as string;
  }
  if (rosterReflectApplyV1(rosterArrayIsArrayV1, Array, [value])) {
    const values = value as readonly unknown[];
    let result = "[";
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) result += ",";
      result += capturedRosterCanonicalJsonV1(values[index], `${path}[${index}]`, depth + 1);
    }
    return `${result}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = rosterReflectApplyV1(rosterObjectKeysV1, Object, [record]) as string[];
    rosterReflectApplyV1(rosterArraySortV1, keys, []);
    let result = "{";
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!, child = record[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol"
        || typeof child === "bigint") throw new Error(`Non-JSON value at ${path}.${key}`);
      if (index > 0) result += ",";
      const encodedKey = rosterReflectApplyV1(rosterJsonStringifyV1, JSON, [key]) as string;
      result += `${encodedKey}:${capturedRosterCanonicalJsonV1(child, `${path}.${key}`, depth + 1)}`;
    }
    return `${result}}`;
  }
  throw new Error(`Non-JSON value at ${path}`);
}

function capturedRosterDigestV1(value: unknown): string {
  const hash = createHash("sha256");
  rosterReflectApplyV1(rosterHashUpdateV1, hash, [capturedRosterCanonicalJsonV1(value), "utf8"]);
  return `sha256:${rosterReflectApplyV1(rosterHashDigestV1, hash, ["hex"]) as string}`;
}

export const IDEA_LAB_HERMES_021_CONNECTION_SOURCE_V1 =
  "control-room-hermes-021-built-in-connection-source/v1" as const;
export const IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1 =
  "control-room-hermes-021-connection-enrollment/v1" as const;
export const IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1 =
  "control-room-hermes-021-connection-safe-result/v1" as const;
export const IDEA_LAB_HERMES_021_CONNECTION_ROSTER_V1 =
  "control-room-hermes-021-connection-roster/v1" as const;
export const IDEA_LAB_HERMES_021_CONNECTION_REASSESSMENT_V1 =
  "control-room-hermes-021-connection-reassessment/v1" as const;

const sourceFiles = Object.freeze([
  Object.freeze({ pathId: "hermes_cli_auth", sha256: "sha256:98d96872425c1e4564fe6a5cc27731166266b1b6795d0187db1d42cf1c92b84e" }),
  Object.freeze({ pathId: "hermes_cli_profiles", sha256: "sha256:edeafa558cea28cc42ce4e80a21489a3176454a48bae9f767d8c179b954e0981" }),
  Object.freeze({ pathId: "desktop_ssh_connection", sha256: "sha256:bde4d38d26dd1688b822189a118f69ad07a7ed8b3e058705b2f422ca40a4f304" }),
  Object.freeze({ pathId: "desktop_connection_registry", sha256: "sha256:1fd7ac3446a0fecb0e31189fe324eb8d8f0da376808c1a3749e757eeaec6f1cc" }),
  Object.freeze({ pathId: "desktop_bot_roster", sha256: "sha256:b7397b45aa93b3f3c3383f20d7533b712c333582c476049fd76f2645f70ea9b8" }),
  Object.freeze({ pathId: "desktop_json_rpc_gateway", sha256: "sha256:a18dbcffedae4772d082c38b3c58c2e59e74f2b4919ca99e45ad3492ebc4421b" }),
  Object.freeze({ pathId: "desktop_gateway_store", sha256: "sha256:b929060a9542b7271ef4c3a649752a499486cc34b54ddc6c6379e613278c8b89" }),
  Object.freeze({ pathId: "gateway_session_methods", sha256: "sha256:c4c0b3355be3ecc7f7fdf8ebcbd46fb3f360f9dded5ca9908f96ed0ce7e561d0" }),
  Object.freeze({ pathId: "gateway_iso_certify", sha256: "sha256:d8919e69de6e02d03baecd819486ac6398d4b5a93c621d026e9589758e4c833b" }),
] as const);

const sourceCandidateMaterial = {
  contractVersion: IDEA_LAB_HERMES_021_CONNECTION_SOURCE_V1,
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  priorSourcePreflightDigest: IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
  reviewedSourceFiles: sourceFiles,
  capabilities: Object.freeze({
    freshNoSkillsProfile: true as const,
    freshProfileCopiesSoul: false as const,
    freshProfileCopiesMemory: false as const,
    freshProfileCopiesSkills: false as const,
    profileProtectedValueFallback: "global_root_read_only_per_provider" as const,
    profileProtectedValueWrites: "profile_local_only" as const,
    protectedValueMaterialReturnedToControlRoom: false as const,
    sshConnectionRegistry: true as const,
    sshKeyAuthentication: true as const,
    sshBatchMode: true as const,
    sshHostKeyChangesFailClosed: true as const,
    sshConnectOnDemand: true as const,
    crossGatewayDelegation: "explicit_bridge_required" as const,
  }),
  hermesModificationRequired: false as const,
  sourceCompatible: true as const,
  nativeQualified: false as const,
  livePanelEligible: false as const,
  grantsApproval: false as const,
  grantsCommandAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

export const ideaLabHermes021BuiltInConnectionSourceV1 = Object.freeze({
  ...sourceCandidateMaterial,
  sourceCandidateDigest: sha256Digest(sourceCandidateMaterial),
});

const base64url = z.string().min(40).max(256)
  .refine((value) => capturedPatternMatchesV1(/^[A-Za-z0-9_-]+$/, value));

const routeSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("local_loopback"),
    sshHostKeyFingerprintDigest: z.null(),
    sshPublicKeyOnly: z.literal(false),
    sshBatchMode: z.literal(false),
    ownerVerifiedFirstHostKey: z.literal(false),
    hostKeyChangesFailClosed: z.literal(false),
  }).strict(),
  z.object({
    transport: z.literal("ssh_tunnel"),
    sshHostKeyFingerprintDigest: ideaDigestSchemaV1,
    sshPublicKeyOnly: z.literal(true),
    sshBatchMode: z.literal(true),
    ownerVerifiedFirstHostKey: z.literal(true),
    hostKeyChangesFailClosed: z.literal(true),
  }).strict(),
]);

const enrollmentBodySchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_CONNECTION_ENROLLMENT_V1),
  enrollmentId: ideaIdSchemaV1,
  connectionId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1,
  nodeId: ideaIdSchemaV1,
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  sourceCandidateDigest: z.literal(ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest),
  route: routeSchema,
  connectorRouteDigest: ideaDigestSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  gatewayEndpointVisibility: z.literal("connector_private_loopback"),
  gatewaySessionValueCustody: z.literal("connector_private"),
  gatewayOperations: ideaLabHermes021FixedOperationSetSchemaV1,
  arbitraryRemoteCommandAllowed: z.literal(false),
  genericShellExposedToControlRoom: z.literal(false),
  freshProfileNoSkills: z.literal(true),
  protectedValueResolution: z.literal("global_root_read_only_per_provider"),
  protectedValueMaterialReturned: z.literal(false),
  copiedContextCounts: z.object({
    soul: z.literal(0), memory: z.literal(0), skills: z.literal(0), plugins: z.literal(0),
    mcpConfiguration: z.literal(0), rules: z.literal(0), sessions: z.literal(0),
  }).strict(),
  toolsEnabled: z.literal(false),
  mcpEnabled: z.literal(false),
  pluginsEnabled: z.literal(false),
  gatewayStartsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  issuedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  bodyDigest: ideaDigestSchemaV1,
}).strict();

const enrollmentEnvelopeSchema = z.object({
  body: enrollmentBodySchema,
  attestation: z.object({
    algorithm: z.literal("ed25519"),
    keyId: ideaIdSchemaV1,
    publicKeySpki: base64url,
    signature: base64url,
  }).strict(),
}).strict();

const enrollmentContextSchema = z.object({
  evaluatedAt: ideaTimeSchemaV1,
  expectedTenantId: ideaIdSchemaV1,
  expectedNodeId: ideaIdSchemaV1,
  expectedConnectionId: ideaIdSchemaV1,
  expectedConnectorRouteDigest: ideaDigestSchemaV1,
  expectedProfileIdentityDigest: ideaDigestSchemaV1,
  expectedSshHostKeyFingerprintDigest: ideaDigestSchemaV1.nullable(),
  trustedNodeKeyId: ideaIdSchemaV1,
  trustedNodePublicKeySpki: base64url,
  inputMode: z.literal("injected_signed_node_enrollment_only"),
}).strict();

const safeResultSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1),
  sourceMode: z.literal("injected_signed_node_enrollment_only"),
  enrollmentId: ideaIdSchemaV1,
  connectionId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1,
  nodeId: ideaIdSchemaV1,
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  transport: z.enum(["local_loopback", "ssh_tunnel"]),
  connectorRouteDigest: ideaDigestSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  sshHostKeyFingerprintDigest: ideaDigestSchemaV1.nullable(),
  issuerKeyDigest: ideaDigestSchemaV1,
  sourceCandidateDigest: z.literal(ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest),
  issuedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  evaluatedAt: ideaTimeSchemaV1,
  hermesModificationRequired: z.literal(false),
  protectedValueMaterialRetained: z.literal(false),
  nativeLocatorRetained: z.literal(false),
  genericShellAvailable: z.literal(false),
  privateContextRetained: z.literal(false),
  routeEnrollmentAccepted: z.literal(true),
  qualificationProfileEligible: z.literal(true),
  nativeQualified: z.literal(false),
  livePanelEligible: z.literal(false),
  blockerCodes: z.tuple([
    z.literal("native_qualification_missing"),
    z.literal("owner_effect_window_missing"),
    z.literal("admission_authority_not_configured"),
    z.literal("live_driver_not_configured"),
  ]),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  resultDigest: ideaDigestSchemaV1,
}).strict();

const rosterSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_CONNECTION_ROSTER_V1),
  tenantId: ideaIdSchemaV1,
  evaluatedAt: ideaTimeSchemaV1,
  connections: z.array(safeResultSchema).max(32),
  connectionCount: z.number().int().min(0).max(32),
  sshConnectionCount: z.number().int().min(0).max(32),
  localConnectionCount: z.number().int().min(0).max(32),
  qualificationReadyCount: z.number().int().min(0).max(32),
  nativeQualifiedCount: z.literal(0),
  livePanelEligibleCount: z.literal(0),
  containsNativeLocators: z.literal(false),
  containsProtectedValueMaterial: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  rosterDigest: ideaDigestSchemaV1,
}).strict();
const rosterHeaderSchema = z.object({ tenantId: ideaIdSchemaV1, evaluatedAt: ideaTimeSchemaV1 }).strict();

export type IdeaLabHermes021ConnectionEnrollmentEnvelopeV1 = z.infer<typeof enrollmentEnvelopeSchema>;
export type IdeaLabHermes021ConnectionEnrollmentContextV1 = z.infer<typeof enrollmentContextSchema>;
export type IdeaLabHermes021ConnectionSafeResultV1 = z.infer<typeof safeResultSchema>;
export type IdeaLabHermes021ConnectionRosterV1 = z.infer<typeof rosterSchema>;

/** Exact server-side capture for a protected intake before any routing field is read. */
export function parseIdeaLabHermes021ConnectionEnrollmentEnvelopeV1(
  value: unknown,
): IdeaLabHermes021ConnectionEnrollmentEnvelopeV1 {
  return parseExactIdeaLabV1(enrollmentEnvelopeSchema, value);
}

function freezeConnectionSafeResultV1(
  value: IdeaLabHermes021ConnectionSafeResultV1,
): IdeaLabHermes021ConnectionSafeResultV1 {
  rosterReflectApplyV1(rosterObjectFreezeV1, Object, [value.blockerCodes]);
  return rosterReflectApplyV1(rosterObjectFreezeV1, Object, [value]) as IdeaLabHermes021ConnectionSafeResultV1;
}

function canonicalEd25519Key(spki: string): { key: KeyObject; digest: string } {
  try {
    const supplied = Buffer.from(spki, "base64url");
    const key = createPublicKey({ key: supplied, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.isBuffer(canonical) || !supplied.equals(canonical)
      || spki !== canonical.toString("base64url")) throw new Error("invalid");
    return { key, digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
  } catch { throw new IdeaLabErrorV1("integrity_failed"); }
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function withoutDigest<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const result = { ...value }; delete result[key]; return result;
}

export function sanitizeIdeaLabHermes021ConnectionEnrollmentV1(
  envelopeValue: unknown,
  contextValue: unknown,
): IdeaLabHermes021ConnectionSafeResultV1 {
  const envelope = parseExactIdeaLabV1(enrollmentEnvelopeSchema, envelopeValue);
  const context = parseExactIdeaLabV1(enrollmentContextSchema, contextValue);
  if (!sameText(envelope.attestation.keyId, context.trustedNodeKeyId)
    || !sameText(envelope.attestation.publicKeySpki, context.trustedNodePublicKeySpki)) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const issuer = canonicalEd25519Key(envelope.attestation.publicKeySpki);
  let signatureValid = false;
  try {
    signatureValid = verify(null, Buffer.from(canonicalJson(envelope.body)), issuer.key,
      Buffer.from(envelope.attestation.signature, "base64url"));
  } catch { signatureValid = false; }
  if (!signatureValid || sha256Digest(withoutDigest(envelope.body, "bodyDigest")) !== envelope.body.bodyDigest) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const body = envelope.body;
  if (!sameText(body.tenantId, context.expectedTenantId) || !sameText(body.nodeId, context.expectedNodeId)
    || !sameText(body.connectionId, context.expectedConnectionId)
    || !sameText(body.connectorRouteDigest, context.expectedConnectorRouteDigest)
    || !sameText(body.profileIdentityDigest, context.expectedProfileIdentityDigest)
    || body.route.sshHostKeyFingerprintDigest !== context.expectedSshHostKeyFingerprintDigest) {
    throw new IdeaLabErrorV1("scope_mismatch");
  }
  const issued = capturedIdeaTimeMillisecondsV1(body.issuedAt), expires = capturedIdeaTimeMillisecondsV1(body.expiresAt);
  const evaluated = capturedIdeaTimeMillisecondsV1(context.evaluatedAt);
  if (issued === undefined || expires === undefined || evaluated === undefined || issued > evaluated || expires <= evaluated
    || expires <= issued || expires - issued > 86_400_000) throw new IdeaLabErrorV1("integrity_failed");
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
    sourceMode: "injected_signed_node_enrollment_only" as const,
    enrollmentId: body.enrollmentId,
    connectionId: body.connectionId,
    tenantId: body.tenantId,
    nodeId: body.nodeId,
    runtimeRevision: body.runtimeRevision,
    transport: body.route.transport,
    connectorRouteDigest: body.connectorRouteDigest,
    profileIdentityDigest: body.profileIdentityDigest,
    sshHostKeyFingerprintDigest: body.route.sshHostKeyFingerprintDigest,
    issuerKeyDigest: issuer.digest,
    sourceCandidateDigest: body.sourceCandidateDigest,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    evaluatedAt: context.evaluatedAt,
    hermesModificationRequired: false as const,
    protectedValueMaterialRetained: false as const,
    nativeLocatorRetained: false as const,
    genericShellAvailable: false as const,
    privateContextRetained: false as const,
    routeEnrollmentAccepted: true as const,
    qualificationProfileEligible: true as const,
    nativeQualified: false as const,
    livePanelEligible: false as const,
    blockerCodes: ["native_qualification_missing", "owner_effect_window_missing",
      "admission_authority_not_configured", "live_driver_not_configured"] as const,
    grantsApproval: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const parsed = safeResultSchema.parse({ ...material, resultDigest: sha256Digest(material) });
  return freezeConnectionSafeResultV1(parsed);
}

export function parseIdeaLabHermes021ConnectionSafeResultV1(value: unknown): IdeaLabHermes021ConnectionSafeResultV1 {
  const parsed = parseExactIdeaLabV1(safeResultSchema, value);
  if (sha256Digest(withoutDigest(parsed, "resultDigest")) !== parsed.resultDigest) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  return freezeConnectionSafeResultV1(parsed);
}

export function buildIdeaLabHermes021ConnectionRosterV1(input: {
  tenantId: string;
  evaluatedAt: string;
  connections: readonly unknown[];
}): IdeaLabHermes021ConnectionRosterV1 {
  const captured = exactHostDataSnapshotV1(input, ["tenantId", "evaluatedAt", "connections"]);
  if (!captured) throw new IdeaLabErrorV1("invalid_input");
  const header = parseExactIdeaLabV1(rosterHeaderSchema,
    { tenantId: captured.tenantId, evaluatedAt: captured.evaluatedAt });
  const rawConnections = exactHostDataArrayV1(captured.connections, 32);
  if (!rawConnections) throw new IdeaLabErrorV1("invalid_input");
  const connections: IdeaLabHermes021ConnectionSafeResultV1[] = [];
  for (let index = 0; index < rawConnections.length; index += 1) {
    connections[index] = parseIdeaLabHermes021ConnectionSafeResultV1(rawConnections[index]);
  }
  const evaluated = capturedIdeaTimeMillisecondsV1(header.evaluatedAt)!;
  let sshConnectionCount = 0, localConnectionCount = 0, qualificationReadyCount = 0;
  for (let left = 0; left < connections.length; left += 1) {
    const connection = connections[left]!;
    if (connection.tenantId !== header.tenantId
      || capturedIdeaTimeMillisecondsV1(connection.expiresAt)! <= evaluated) throw new IdeaLabErrorV1("integrity_failed");
    if (connection.transport === "ssh_tunnel") sshConnectionCount += 1; else localConnectionCount += 1;
    if (connection.qualificationProfileEligible) qualificationReadyCount += 1;
    for (let right = left + 1; right < connections.length; right += 1) {
      const candidate = connections[right]!;
      if (connection.connectionId === candidate.connectionId
        || connection.connectorRouteDigest === candidate.connectorRouteDigest
        || connection.profileIdentityDigest === candidate.profileIdentityDigest) throw new IdeaLabErrorV1("integrity_failed");
    }
  }
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_ROSTER_V1,
    ...header,
    connections,
    connectionCount: connections.length,
    sshConnectionCount,
    localConnectionCount,
    qualificationReadyCount,
    nativeQualifiedCount: 0 as const,
    livePanelEligibleCount: 0 as const,
    containsNativeLocators: false as const,
    containsProtectedValueMaterial: false as const,
    grantsExecutionAuthority: false as const,
  };
  const parsed = rosterSchema.parse({ ...material, rosterDigest: capturedRosterDigestV1(material) });
  for (let index = 0; index < parsed.connections.length; index += 1) {
    freezeConnectionSafeResultV1(parsed.connections[index]!);
  }
  rosterReflectApplyV1(rosterObjectFreezeV1, Object, [parsed.connections]);
  return rosterReflectApplyV1(rosterObjectFreezeV1, Object, [parsed]) as IdeaLabHermes021ConnectionRosterV1;
}

/** Capture and verify a complete protected roster without executing source behavior. */
export function parseIdeaLabHermes021ConnectionRosterV1(value: unknown): IdeaLabHermes021ConnectionRosterV1 {
  const parsed = parseExactIdeaLabV1(rosterSchema, value);
  const { rosterDigest, ...material } = parsed;
  if (capturedRosterDigestV1(material) !== rosterDigest) throw new IdeaLabErrorV1("integrity_failed");
  for (let index = 0; index < parsed.connections.length; index += 1) {
    freezeConnectionSafeResultV1(parsed.connections[index]!);
  }
  rosterReflectApplyV1(rosterObjectFreezeV1, Object, [parsed.connections]);
  return rosterReflectApplyV1(rosterObjectFreezeV1, Object, [parsed]) as IdeaLabHermes021ConnectionRosterV1;
}

const reassessmentMaterial = {
  contractVersion: IDEA_LAB_HERMES_021_CONNECTION_REASSESSMENT_V1,
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
  supersedesReadinessConclusion: "empty_profile_has_no_existing_authentication" as const,
  freshNoSkillsProfileEligible: true as const,
  existingAuthenticationAvailableByReadOnlyFallback: true as const,
  privateBotContextCopyRequired: false as const,
  sshConnectionSupported: true as const,
  hermesModificationRequired: false as const,
  ownerCommandEmitted: false as const,
  status: "blocked_before_owner_command" as const,
  blockerCodes: Object.freeze(["signed_node_enrollment_missing", "native_port_not_configured",
    "fresh_owner_authorization_missing"] as const),
  nativeAttemptsMade: 0 as const,
  providerCallsMade: 0 as const,
  protectedValuesAccessed: false as const,
  grantsApproval: false as const,
  grantsCommandAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

export const ideaLabHermes021ConnectionReassessmentV1 = Object.freeze({
  ...reassessmentMaterial,
  reassessmentDigest: sha256Digest(reassessmentMaterial),
});
