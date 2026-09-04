import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  exactHostErrorCodeV1,
  exactHostUint8ArrayV1,
  isHostProxyV1,
  ownDataPropertyValueV1,
} from "../../security/host-value";

const objectFreezeV1 = Object.freeze;
const objectHasOwnPropertyV1 = Object.prototype.hasOwnProperty;
const reflectApplyV1 = Reflect.apply;
const arrayPushV1 = Array.prototype.push;
const regexpExecV1 = RegExp.prototype.exec;
const stringCharCodeAtV1 = String.prototype.charCodeAt;
const stringSliceV1 = String.prototype.slice;
const jsonObjectV1 = JSON;
const jsonStringifyV1 = JSON.stringify;
const dateConstructorV1 = Date;
const dateParseV1 = Date.parse;
const dateGetTimeV1 = Date.prototype.getTime;
const dateToISOStringV1 = Date.prototype.toISOString;
const numberConstructorV1 = Number;
const numberIsFiniteV1 = Number.isFinite;
const numberIsSafeIntegerV1 = Number.isSafeInteger;

const idPatternV1 = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/;
const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const authTagPatternV1 = /^hmac-sha256:[a-f0-9]{64}$/;
const commitPatternV1 = /^[a-f0-9]{40}$/;
const sequencePatternV1 = /^(?:0|[1-9][0-9]{0,4})$/;
const maximumAuthorizationLifetimeMillisecondsV1 = 60_000;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_BODY_V1 =
  "control-room-connection-enrollment-private-loopback-invocation-authorization-body/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_ENVELOPE_V1 =
  "control-room-connection-enrollment-private-loopback-invocation-authorization-envelope/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_REGISTRATION_V1 =
  "control-room-connection-enrollment-private-loopback-invocation-authorization-registration/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_VALIDATION_V1 =
  "control-room-connection-enrollment-private-loopback-invocation-authorization-validation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_CONSUMPTION_V1 =
  "control-room-connection-enrollment-private-loopback-invocation-authorization-consumption/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_RECHECK_V1 =
  "control-room-connection-enrollment-private-loopback-invocation-authorization-recheck/v1" as const;

export type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_BODY_V1;
  live330ProductCommit: "06be655d188c45902c015f85225673dfc31c445d";
  live340ProductCommit: "3108a8759863c4692ade2d5532e88cd28f259779";
  acceptedLive340ReviewSha256: "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af";
  tenantId: string;
  projectId: string;
  connectionId: string;
  nodeId: string;
  targetPlatformFamily: "macos";
  targetRuntimeFamily: "node";
  candidateId: string;
  attemptId: string;
  operation: "observe_target_runtime_once";
  authorizationId: string;
  nonceDigest: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  sealingKeyIdDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationEnvelopeV1 = Readonly<{
  envelopeVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_ENVELOPE_V1;
  body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1;
  bodyDigest: string;
  authorizationAuthTag: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRegistrationV1 = Readonly<{
  registrationVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_REGISTRATION_V1;
  registrationReference: string;
  authorizationIdDigest: string;
  nonceDigest: string;
  bodyDigest: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  state: "registered_unconsumed";
  exactReplayInert: true;
  validityEvaluated: false;
  authorizationConsumed: false;
  sourceLookupPerformed: false;
  sourceInvocationPerformed: false;
  nativeReadPerformed: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  registrationDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationValidationV1 = Readonly<{
  validationVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_VALIDATION_V1;
  validationReference: string;
  authorizationIdDigest: string;
  nonceDigest: string;
  bodyDigest: string;
  validatedAt: string;
  state: "validated_unconsumed";
  authenticatedLineageValidated: true;
  replayReservationValidated: true;
  currentWindowValidated: true;
  authorizationConsumed: false;
  sourceLookupPerformed: false;
  sourceInvocationPerformed: false;
  nativeReadPerformed: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  validationDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1 = Readonly<{
  consumptionVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_CONSUMPTION_V1;
  consumptionReference: string;
  authorizationIdDigest: string;
  nonceDigest: string;
  bodyDigest: string;
  consumedAt: string;
  state: "consumed_pending_post_transaction_time_recheck" | "already_consumed_terminal";
  freshConsumption: boolean;
  exactReplayReturnsNoAuthority: true;
  postTransactionTimeRechecked: false;
  sourceLookupPerformed: false;
  sourceInvocationPerformed: false;
  nativeReadPerformed: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  consumptionDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1 = Readonly<{
  recheckVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_RECHECK_V1;
  recheckReference: string;
  authorizationIdDigest: string;
  nonceDigest: string;
  bodyDigest: string;
  consumedAt: string;
  recheckedAt: string;
  state: "consumed_and_post_transaction_time_rechecked";
  consumptionStateAuthenticated: true;
  postTransactionTimeRechecked: true;
  exactReplayReturnsNoAuthority: true;
  sourceLookupPerformed: false;
  sourceInvocationPerformed: false;
  nativeReadPerformed: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  recheckDigest: string;
}>;

export class ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1 extends Error {
  readonly safeCode: "invalid_input" | "authentication_failed" | "replay_conflict" | "authorization_unavailable"
    | "consumption_unavailable" | "not_yet_valid" | "expired" | "terminal_ambiguity" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_input" || code === "authentication_failed" || code === "replay_conflict"
      || code === "authorization_unavailable" || code === "not_yet_valid" || code === "expired"
      || code === "consumption_unavailable" || code === "terminal_ambiguity"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

interface HeadRowV1 {
  tenant_id: string;
  last_sequence: number | string;
  last_record_digest: string;
  head_auth_tag: string;
}

interface AuthorizationRowV1 {
  tenant_id: string;
  sequence: number | string;
  authorization_id_digest: string;
  nonce_digest: string;
  body_digest: string;
  authorization_auth_tag: string;
  previous_record_digest: string | null;
  record_digest: string;
  record_auth_tag: string;
  body: unknown;
}

interface NonceRowV1 {
  tenant_id: string;
  nonce_digest: string;
  authorization_id_digest: string;
  body_digest: string;
  reservation_digest: string;
  reservation_auth_tag: string;
}

interface VerifiedAuthorizationV1 {
  row: AuthorizationRowV1;
  body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1;
}

interface ConsumptionHeadRowV1 {
  tenant_id: string;
  last_sequence: number | string;
  last_record_digest: string;
  head_auth_tag: string;
}

interface ConsumptionRowV1 {
  tenant_id: string;
  sequence: number | string;
  authorization_id_digest: string;
  nonce_digest: string;
  body_digest: string;
  consumed_at: string;
  previous_record_digest: string | null;
  record_digest: string;
  record_auth_tag: string;
}

const storeErrorPrototypeV1 = ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1.prototype;

function failV1(code: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1(code);
}

function sameTextV1(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (reflectApplyV1(stringCharCodeAtV1, left, [index]) as number)
      ^ (reflectApplyV1(stringCharCodeAtV1, right, [index]) as number);
  }
  return mismatch === 0;
}

function sameKeyMaterialV1(left: Readonly<{ byteLength: number; byteAt(index: number): number | undefined }>,
  right: Readonly<{ byteLength: number; byteAt(index: number): number | undefined }>): boolean {
  let mismatch = left.byteLength ^ right.byteLength;
  const maximum = left.byteLength > right.byteLength ? left.byteLength : right.byteLength;
  for (let index = 0; index < maximum; index += 1) {
    mismatch |= (left.byteAt(index) ?? 0) ^ (right.byteAt(index) ?? 0);
  }
  return mismatch === 0;
}

function exactInstantMillisecondsV1(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = dateParseV1(value);
  if (!numberIsFiniteV1(milliseconds)) return undefined;
  try {
    const parsed = new dateConstructorV1(milliseconds);
    const epoch = reflectApplyV1(dateGetTimeV1, parsed, []) as number;
    const canonical = reflectApplyV1(dateToISOStringV1, parsed, []) as string;
    return epoch === milliseconds && canonical === value ? milliseconds : undefined;
  } catch { return undefined; }
}

function validIdV1(value: unknown): value is string {
  return typeof value === "string" && reflectApplyV1(regexpExecV1, idPatternV1, [value]) !== null;
}

function validDigestV1(value: unknown): value is string {
  return typeof value === "string" && reflectApplyV1(regexpExecV1, digestPatternV1, [value]) !== null;
}

function validAuthTagV1(value: unknown): value is string {
  return typeof value === "string" && reflectApplyV1(regexpExecV1, authTagPatternV1, [value]) !== null;
}

function exactSequenceV1(value: unknown): number | undefined {
  if (typeof value === "number") return numberIsSafeIntegerV1(value) && value >= 0 && value <= 10_000
    ? value : undefined;
  if (typeof value !== "string" || reflectApplyV1(regexpExecV1, sequencePatternV1, [value]) === null) return undefined;
  const sequence = numberConstructorV1(value);
  return numberIsSafeIntegerV1(sequence) && sequence >= 0 && sequence <= 10_000 ? sequence : undefined;
}

function parseBodyV1(value: unknown): ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1 {
  const body = exactHostDataSnapshotV1(value, [
    "contractVersion", "live330ProductCommit", "live340ProductCommit", "acceptedLive340ReviewSha256", "tenantId",
    "projectId", "connectionId", "nodeId", "targetPlatformFamily", "targetRuntimeFamily", "candidateId",
    "attemptId", "operation", "authorizationId", "nonceDigest", "issuedAt", "notBefore", "expiresAt",
    "sealingKeyIdDigest",
  ]);
  if (!body || body.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_BODY_V1
    || body.live330ProductCommit !== "06be655d188c45902c015f85225673dfc31c445d"
    || body.live340ProductCommit !== "3108a8759863c4692ade2d5532e88cd28f259779"
    || body.acceptedLive340ReviewSha256 !== "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af"
    || reflectApplyV1(regexpExecV1, commitPatternV1, [body.live330ProductCommit]) === null
    || reflectApplyV1(regexpExecV1, commitPatternV1, [body.live340ProductCommit]) === null
    || !validIdV1(body.tenantId) || !validIdV1(body.projectId) || !validIdV1(body.connectionId)
    || !validIdV1(body.nodeId) || !validIdV1(body.candidateId) || !validIdV1(body.attemptId)
    || !validIdV1(body.authorizationId) || body.targetPlatformFamily !== "macos"
    || body.targetRuntimeFamily !== "node" || body.operation !== "observe_target_runtime_once"
    || !validDigestV1(body.nonceDigest) || !validDigestV1(body.sealingKeyIdDigest)) failV1("invalid_input");
  const issued = exactInstantMillisecondsV1(body.issuedAt), notBefore = exactInstantMillisecondsV1(body.notBefore),
    expires = exactInstantMillisecondsV1(body.expiresAt);
  if (issued === undefined || notBefore === undefined || expires === undefined || issued > notBefore
    || notBefore >= expires || expires - issued > maximumAuthorizationLifetimeMillisecondsV1) failV1("invalid_input");
  const parsed = objectFreezeV1({
    contractVersion: body.contractVersion,
    live330ProductCommit: body.live330ProductCommit,
    live340ProductCommit: body.live340ProductCommit,
    acceptedLive340ReviewSha256: body.acceptedLive340ReviewSha256,
    tenantId: body.tenantId,
    projectId: body.projectId,
    connectionId: body.connectionId,
    nodeId: body.nodeId,
    targetPlatformFamily: body.targetPlatformFamily,
    targetRuntimeFamily: body.targetRuntimeFamily,
    candidateId: body.candidateId,
    attemptId: body.attemptId,
    operation: body.operation,
    authorizationId: body.authorizationId,
    nonceDigest: body.nonceDigest,
    issuedAt: body.issuedAt,
    notBefore: body.notBefore,
    expiresAt: body.expiresAt,
    sealingKeyIdDigest: body.sealingKeyIdDigest,
  }) as ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1;
  try { assertNoSecretMaterial(parsed, "native observation invocation authorization body"); }
  catch { failV1("invalid_input"); }
  return parsed;
}

function authorizationTagMaterialV1(body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1,
  bodyDigest: string) {
  return { kind: "private_native_observation_invocation_authorization", body, bodyDigest };
}

function parseEnvelopeV1(value: unknown, authorizationKey: Uint8Array, authorizationKeyIdDigest: string):
ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationEnvelopeV1 {
  const captured = exactHostDataSnapshotV1(value,
    ["envelopeVersion", "body", "bodyDigest", "authorizationAuthTag"]);
  if (!captured || captured.envelopeVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_ENVELOPE_V1
    || !validDigestV1(captured.bodyDigest) || typeof captured.authorizationAuthTag !== "string"
    || reflectApplyV1(regexpExecV1, authTagPatternV1, [captured.authorizationAuthTag]) === null) failV1("invalid_input");
  const body = parseBodyV1(captured.body), bodyDigest = sha256Digest(body);
  if (!sameTextV1(body.sealingKeyIdDigest, authorizationKeyIdDigest)
    || !sameTextV1(bodyDigest, captured.bodyDigest)
    || !sameTextV1(hmacSha256Tag(authorizationKey, authorizationTagMaterialV1(body, bodyDigest)),
      captured.authorizationAuthTag)) failV1("authentication_failed");
  return objectFreezeV1({
    envelopeVersion: captured.envelopeVersion,
    body,
    bodyDigest,
    authorizationAuthTag: captured.authorizationAuthTag,
  });
}

async function safeQueryV1<T>(session: DatabaseSession, statement: string, params: unknown[] = [],
  maximum = 10_000): Promise<T[]> {
  if (!session || typeof session !== "object" || isHostProxyV1(session)) failV1("integrity_failed");
  const query = dataMethodV1(session, "query");
  if (!query) failV1("integrity_failed");
  let raw: unknown;
  try { raw = await reflectApplyV1(query, session, [statement, params]); }
  catch { failV1("integrity_failed"); }
  const rows = exactHostDataArrayV1(ownDataPropertyValueV1(raw, "rows"), maximum);
  if (!rows) failV1("integrity_failed");
  return rows as T[];
}

function authorizationIdDigestV1(body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1): string {
  return sha256Digest({ authorizationId: body.authorizationId });
}

function recordMaterialV1(row: Omit<AuthorizationRowV1, "record_digest" | "record_auth_tag" | "body">) {
  return {
    kind: "private_native_observation_invocation_authorization_record",
    tenantId: row.tenant_id,
    sequence: numberConstructorV1(row.sequence),
    authorizationIdDigest: row.authorization_id_digest,
    nonceDigest: row.nonce_digest,
    bodyDigest: row.body_digest,
    authorizationAuthTag: row.authorization_auth_tag,
    previousRecordDigest: row.previous_record_digest,
  };
}

function nonceMaterialV1(row: Omit<NonceRowV1, "reservation_digest" | "reservation_auth_tag">) {
  return {
    kind: "private_native_observation_invocation_nonce_reservation",
    tenantId: row.tenant_id,
    nonceDigest: row.nonce_digest,
    authorizationIdDigest: row.authorization_id_digest,
    bodyDigest: row.body_digest,
  };
}

function headMaterialV1(row: Omit<HeadRowV1, "head_auth_tag">) {
  return { kind: "private_native_observation_invocation_authorization_head", tenantId: row.tenant_id,
    lastSequence: numberConstructorV1(row.last_sequence), lastRecordDigest: row.last_record_digest };
}

function consumptionRecordMaterialV1(row: Omit<ConsumptionRowV1, "record_digest" | "record_auth_tag">) {
  return {
    kind: "private_native_observation_invocation_authorization_consumption",
    tenantId: row.tenant_id,
    sequence: numberConstructorV1(row.sequence),
    authorizationIdDigest: row.authorization_id_digest,
    nonceDigest: row.nonce_digest,
    bodyDigest: row.body_digest,
    consumedAt: row.consumed_at,
    previousRecordDigest: row.previous_record_digest,
  };
}

function consumptionHeadMaterialV1(row: Omit<ConsumptionHeadRowV1, "head_auth_tag">) {
  return {
    kind: "private_native_observation_invocation_authorization_consumption_head",
    tenantId: row.tenant_id,
    lastSequence: numberConstructorV1(row.last_sequence),
    lastRecordDigest: row.last_record_digest,
  };
}

function buildRegistrationV1(body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1,
  bodyDigest: string): ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRegistrationV1 {
  const material = {
    registrationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_REGISTRATION_V1,
    registrationReference: `authorization-registration:${reflectApplyV1(stringSliceV1, bodyDigest, [7, 31]) as string}`,
    authorizationIdDigest: authorizationIdDigestV1(body),
    nonceDigest: body.nonceDigest,
    bodyDigest,
    issuedAt: body.issuedAt,
    notBefore: body.notBefore,
    expiresAt: body.expiresAt,
    state: "registered_unconsumed" as const,
    exactReplayInert: true as const,
    validityEvaluated: false as const,
    authorizationConsumed: false as const,
    sourceLookupPerformed: false as const,
    sourceInvocationPerformed: false as const,
    nativeReadPerformed: false as const,
    grantsApproval: false as const,
    grantsQualificationAuthority: false as const,
    grantsCandidateAuthority: false as const,
    grantsActivationAuthority: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const receipt = objectFreezeV1({ ...material, registrationDigest: sha256Digest(material) });
  try { assertNoSecretMaterial(receipt, "native observation authorization registration"); }
  catch { failV1("integrity_failed"); }
  return receipt;
}

function buildValidationV1(body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1,
  bodyDigest: string, validatedAt: string): ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationValidationV1 {
  const material = {
    validationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_VALIDATION_V1,
    validationReference: `authorization-validation:${reflectApplyV1(stringSliceV1, bodyDigest, [7, 31]) as string}`,
    authorizationIdDigest: authorizationIdDigestV1(body),
    nonceDigest: body.nonceDigest,
    bodyDigest,
    validatedAt,
    state: "validated_unconsumed" as const,
    authenticatedLineageValidated: true as const,
    replayReservationValidated: true as const,
    currentWindowValidated: true as const,
    authorizationConsumed: false as const,
    sourceLookupPerformed: false as const,
    sourceInvocationPerformed: false as const,
    nativeReadPerformed: false as const,
    grantsApproval: false as const,
    grantsQualificationAuthority: false as const,
    grantsCandidateAuthority: false as const,
    grantsActivationAuthority: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const receipt = objectFreezeV1({ ...material, validationDigest: sha256Digest(material) });
  try { assertNoSecretMaterial(receipt, "native observation authorization validation"); }
  catch { failV1("integrity_failed"); }
  return receipt;
}

function buildConsumptionV1(body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1,
  bodyDigest: string, consumedAt: string, freshConsumption: boolean):
ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1 {
  const material = {
    consumptionVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_CONSUMPTION_V1,
    consumptionReference: `authorization-consumption:${reflectApplyV1(stringSliceV1, bodyDigest, [7, 31]) as string}`,
    authorizationIdDigest: authorizationIdDigestV1(body),
    nonceDigest: body.nonceDigest,
    bodyDigest,
    consumedAt,
    state: freshConsumption ? "consumed_pending_post_transaction_time_recheck" as const
      : "already_consumed_terminal" as const,
    freshConsumption,
    exactReplayReturnsNoAuthority: true as const,
    postTransactionTimeRechecked: false as const,
    sourceLookupPerformed: false as const,
    sourceInvocationPerformed: false as const,
    nativeReadPerformed: false as const,
    grantsApproval: false as const,
    grantsQualificationAuthority: false as const,
    grantsCandidateAuthority: false as const,
    grantsActivationAuthority: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const receipt = objectFreezeV1({ ...material, consumptionDigest: sha256Digest(material) });
  try { assertNoSecretMaterial(receipt, "native observation authorization consumption"); }
  catch { failV1("integrity_failed"); }
  return receipt;
}

function parseFreshConsumptionV1(value: unknown,
  body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1, bodyDigest: string):
ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1 {
  const captured = exactHostDataSnapshotV1(value, [
    "consumptionVersion", "consumptionReference", "authorizationIdDigest", "nonceDigest", "bodyDigest",
    "consumedAt", "state", "freshConsumption", "exactReplayReturnsNoAuthority", "postTransactionTimeRechecked",
    "sourceLookupPerformed", "sourceInvocationPerformed", "nativeReadPerformed", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority",
    "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority", "consumptionDigest",
  ]);
  if (!captured || typeof captured.consumptionReference !== "string"
    || !validDigestV1(captured.authorizationIdDigest) || !validDigestV1(captured.nonceDigest)
    || !validDigestV1(captured.bodyDigest) || typeof captured.consumedAt !== "string"
    || exactInstantMillisecondsV1(captured.consumedAt) === undefined
    || !validDigestV1(captured.consumptionDigest)) failV1("invalid_input");
  const expected = buildConsumptionV1(body, bodyDigest, captured.consumedAt, true);
  if (captured.consumptionVersion !== expected.consumptionVersion
    || !sameTextV1(captured.consumptionReference, expected.consumptionReference)
    || !sameTextV1(captured.authorizationIdDigest, expected.authorizationIdDigest)
    || !sameTextV1(captured.nonceDigest, expected.nonceDigest)
    || !sameTextV1(captured.bodyDigest, expected.bodyDigest)
    || captured.consumedAt !== expected.consumedAt || captured.state !== expected.state
    || captured.freshConsumption !== true || captured.exactReplayReturnsNoAuthority !== true
    || captured.postTransactionTimeRechecked !== false || captured.sourceLookupPerformed !== false
    || captured.sourceInvocationPerformed !== false || captured.nativeReadPerformed !== false
    || captured.grantsApproval !== false || captured.grantsQualificationAuthority !== false
    || captured.grantsCandidateAuthority !== false || captured.grantsActivationAuthority !== false
    || captured.grantsNetworkAuthority !== false || captured.grantsCommandAuthority !== false
    || captured.grantsLeaseAuthority !== false || captured.grantsExecutionAuthority !== false
    || !sameTextV1(captured.consumptionDigest, expected.consumptionDigest)) failV1("replay_conflict");
  return expected;
}

function buildRecheckV1(body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1,
  bodyDigest: string, consumedAt: string, recheckedAt: string):
ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1 {
  const material = {
    recheckVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_RECHECK_V1,
    recheckReference: `authorization-recheck:${reflectApplyV1(stringSliceV1, bodyDigest, [7, 31]) as string}`,
    authorizationIdDigest: authorizationIdDigestV1(body),
    nonceDigest: body.nonceDigest,
    bodyDigest,
    consumedAt,
    recheckedAt,
    state: "consumed_and_post_transaction_time_rechecked" as const,
    consumptionStateAuthenticated: true as const,
    postTransactionTimeRechecked: true as const,
    exactReplayReturnsNoAuthority: true as const,
    sourceLookupPerformed: false as const,
    sourceInvocationPerformed: false as const,
    nativeReadPerformed: false as const,
    grantsApproval: false as const,
    grantsQualificationAuthority: false as const,
    grantsCandidateAuthority: false as const,
    grantsActivationAuthority: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const receipt = objectFreezeV1({ ...material, recheckDigest: sha256Digest(material) });
  try { assertNoSecretMaterial(receipt, "native observation authorization post-transaction recheck"); }
  catch { failV1("integrity_failed"); }
  return receipt;
}

export class ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1 {
  readonly #transaction: DatabaseClient["transaction"];
  readonly #authorizationKey: Uint8Array;
  readonly #authorizationKeyIdDigest: string;
  readonly #stateKey: Uint8Array;
  readonly #consumptionStateKey?: Uint8Array;

  constructor(database: DatabaseClient, keysValue: unknown) {
    const transaction = dataMethodV1(database, "transaction") as DatabaseClient["transaction"] | undefined;
    const keys = exactHostDataSnapshotV1(keysValue,
      ["authorizationKey", "authorizationKeyIdDigest", "stateKey"], ["consumptionStateKey"]);
    const consumptionStateKeyPresent = !!keys
      && reflectApplyV1(objectHasOwnPropertyV1, keys, ["consumptionStateKey"]) === true;
    const authorizationKey = keys ? exactHostUint8ArrayV1(keys.authorizationKey, 32) : undefined;
    const stateKey = keys ? exactHostUint8ArrayV1(keys.stateKey, 32) : undefined;
    const consumptionStateKey = !consumptionStateKeyPresent ? undefined
      : exactHostUint8ArrayV1(keys.consumptionStateKey, 32);
    if (!database || typeof database !== "object" || isHostProxyV1(database) || !transaction
      || !authorizationKey || !validDigestV1(keys?.authorizationKeyIdDigest) || !stateKey
      || authorizationKey.byteLength !== 32 || stateKey.byteLength !== 32
      || sameKeyMaterialV1(authorizationKey, stateKey)
      || (consumptionStateKeyPresent && (!consumptionStateKey
        || consumptionStateKey.byteLength !== 32 || sameKeyMaterialV1(authorizationKey, consumptionStateKey)
        || sameKeyMaterialV1(stateKey, consumptionStateKey)))) {
      failV1("invalid_input");
    }
    this.#transaction = ((callback) => reflectApplyV1(transaction, database, [callback])) as
      DatabaseClient["transaction"];
    this.#authorizationKey = authorizationKey.copy();
    this.#authorizationKeyIdDigest = keys.authorizationKeyIdDigest;
    this.#stateKey = stateKey.copy();
    this.#consumptionStateKey = consumptionStateKey?.copy();
    objectFreezeV1(this);
  }

  #headTag(row: Omit<HeadRowV1, "head_auth_tag">): string {
    return hmacSha256Tag(this.#stateKey, headMaterialV1(row));
  }

  #recordTag(row: Omit<AuthorizationRowV1, "record_auth_tag" | "body">): string {
    const { record_digest: recordDigest, ...withoutDigest } = row;
    return hmacSha256Tag(this.#stateKey, { ...recordMaterialV1(withoutDigest), recordDigest });
  }

  #nonceTag(row: Omit<NonceRowV1, "reservation_auth_tag">): string {
    const { reservation_digest: reservationDigest, ...withoutDigest } = row;
    return hmacSha256Tag(this.#stateKey, { ...nonceMaterialV1(withoutDigest), reservationDigest });
  }

  #verifyAuthorizationRow(value: unknown, tenantId: string, expectedSequence: number,
    expectedPreviousDigest: string | null): VerifiedAuthorizationV1 {
    const captured = exactHostDataSnapshotV1(value, ["tenant_id", "sequence", "authorization_id_digest",
      "nonce_digest", "body_digest", "authorization_auth_tag", "previous_record_digest", "record_digest",
      "record_auth_tag", "body"]);
    if (!captured) failV1("integrity_failed");
    const row = captured as unknown as AuthorizationRowV1, sequence = exactSequenceV1(row.sequence);
    if (sequence === undefined || !validIdV1(row.tenant_id) || !validDigestV1(row.authorization_id_digest)
      || !validDigestV1(row.nonce_digest) || !validDigestV1(row.body_digest)
      || !validAuthTagV1(row.authorization_auth_tag)
      || (row.previous_record_digest !== null && !validDigestV1(row.previous_record_digest))
      || !validDigestV1(row.record_digest) || !validAuthTagV1(row.record_auth_tag)) failV1("integrity_failed");
    let body: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationBodyV1;
    try { body = parseBodyV1(row.body); }
    catch { failV1("integrity_failed"); }
    const withoutTags: Omit<AuthorizationRowV1, "record_digest" | "record_auth_tag" | "body"> = {
      tenant_id: row.tenant_id,
      sequence,
      authorization_id_digest: row.authorization_id_digest,
      nonce_digest: row.nonce_digest,
      body_digest: row.body_digest,
      authorization_auth_tag: row.authorization_auth_tag,
      previous_record_digest: row.previous_record_digest,
    };
    if (row.tenant_id !== tenantId || !numberIsSafeIntegerV1(sequence) || sequence !== expectedSequence
      || row.previous_record_digest !== expectedPreviousDigest || body.tenantId !== tenantId
      || row.authorization_id_digest !== authorizationIdDigestV1(body) || row.nonce_digest !== body.nonceDigest
      || row.body_digest !== sha256Digest(body)
      || !sameTextV1(row.authorization_auth_tag,
        hmacSha256Tag(this.#authorizationKey, authorizationTagMaterialV1(body, row.body_digest)))
      || row.record_digest !== sha256Digest(recordMaterialV1(withoutTags))
      || !sameTextV1(row.record_auth_tag, this.#recordTag({ ...withoutTags, record_digest: row.record_digest }))) {
      failV1("integrity_failed");
    }
    return { row: { ...row, sequence }, body };
  }

  #verifyNonceRow(value: unknown, authorization: VerifiedAuthorizationV1): NonceRowV1 {
    const captured = exactHostDataSnapshotV1(value, ["tenant_id", "nonce_digest", "authorization_id_digest",
      "body_digest", "reservation_digest", "reservation_auth_tag"]);
    if (!captured) failV1("integrity_failed");
    const row = captured as unknown as NonceRowV1;
    if (!validIdV1(row.tenant_id) || !validDigestV1(row.nonce_digest)
      || !validDigestV1(row.authorization_id_digest) || !validDigestV1(row.body_digest)
      || !validDigestV1(row.reservation_digest) || !validAuthTagV1(row.reservation_auth_tag)) {
      failV1("integrity_failed");
    }
    const withoutTags = { tenant_id: row.tenant_id, nonce_digest: row.nonce_digest,
      authorization_id_digest: row.authorization_id_digest, body_digest: row.body_digest };
    if (row.tenant_id !== authorization.row.tenant_id || row.nonce_digest !== authorization.row.nonce_digest
      || row.authorization_id_digest !== authorization.row.authorization_id_digest
      || row.body_digest !== authorization.row.body_digest
      || row.reservation_digest !== sha256Digest(nonceMaterialV1(withoutTags))
      || !sameTextV1(row.reservation_auth_tag,
        this.#nonceTag({ ...withoutTags, reservation_digest: row.reservation_digest }))) failV1("integrity_failed");
    return row;
  }

  async #verifiedStream(session: DatabaseSession, tenantId: string): Promise<{
    head?: HeadRowV1;
    authorizations: VerifiedAuthorizationV1[];
  }> {
    const headRows = await safeQueryV1<HeadRowV1>(session, `SELECT tenant_id,last_sequence,last_record_digest,
      head_auth_tag FROM control_native_observation_authorization_heads WHERE tenant_id=$1 FOR UPDATE`, [tenantId], 1);
    const rawAuthorizations = await safeQueryV1<AuthorizationRowV1>(session, `SELECT tenant_id,sequence,
      authorization_id_digest,nonce_digest,body_digest,authorization_auth_tag,previous_record_digest,record_digest,
      record_auth_tag,body FROM control_native_observation_authorizations WHERE tenant_id=$1 ORDER BY sequence FOR UPDATE`,
    [tenantId]);
    const rawNonces = await safeQueryV1<NonceRowV1>(session, `SELECT tenant_id,nonce_digest,authorization_id_digest,
      body_digest,reservation_digest,reservation_auth_tag FROM control_native_observation_authorization_nonces
      WHERE tenant_id=$1 ORDER BY authorization_id_digest FOR UPDATE`, [tenantId]);
    if (!headRows.length) {
      if (rawAuthorizations.length || rawNonces.length) failV1("integrity_failed");
      return { authorizations: [] };
    }
    if (headRows.length !== 1 || rawAuthorizations.length !== rawNonces.length) failV1("integrity_failed");
    const headCaptured = exactHostDataSnapshotV1(headRows[0],
      ["tenant_id", "last_sequence", "last_record_digest", "head_auth_tag"]);
    if (!headCaptured) failV1("integrity_failed");
    const head = headCaptured as unknown as HeadRowV1, lastSequence = exactSequenceV1(head.last_sequence);
    if (lastSequence === undefined || !validIdV1(head.tenant_id) || !validDigestV1(head.last_record_digest)
      || !validAuthTagV1(head.head_auth_tag)) failV1("integrity_failed");
    let previous: string | null = null;
    const authorizations: VerifiedAuthorizationV1[] = [];
    for (let index = 0; index < rawAuthorizations.length; index += 1) {
      const verified = this.#verifyAuthorizationRow(rawAuthorizations[index], tenantId, index + 1, previous);
      reflectApplyV1(arrayPushV1, authorizations, [verified]);
      previous = verified.row.record_digest;
    }
    if (head.tenant_id !== tenantId
      || lastSequence !== authorizations.length || head.last_record_digest !== previous
      || !sameTextV1(head.head_auth_tag,
        this.#headTag({ tenant_id: tenantId, last_sequence: lastSequence, last_record_digest: head.last_record_digest }))) {
      failV1("integrity_failed");
    }
    const matchedAuthorizationDigests: string[] = [];
    for (let nonceIndex = 0; nonceIndex < rawNonces.length; nonceIndex += 1) {
      const rawNonce = rawNonces[nonceIndex];
      const nonceId = ownDataPropertyValueV1(rawNonce, "authorization_id_digest");
      let match: VerifiedAuthorizationV1 | undefined;
      for (let authorizationIndex = 0; authorizationIndex < authorizations.length; authorizationIndex += 1) {
        const authorization = authorizations[authorizationIndex]!;
        if (authorization.row.authorization_id_digest === nonceId) {
          if (match) failV1("integrity_failed");
          match = authorization;
        }
      }
      if (!match) failV1("integrity_failed");
      for (let matchedIndex = 0; matchedIndex < matchedAuthorizationDigests.length; matchedIndex += 1) {
        if (matchedAuthorizationDigests[matchedIndex] === nonceId) failV1("integrity_failed");
      }
      this.#verifyNonceRow(rawNonce, match);
      reflectApplyV1(arrayPushV1, matchedAuthorizationDigests, [match.row.authorization_id_digest]);
    }
    return { head: { ...head, last_sequence: lastSequence }, authorizations };
  }

  #consumptionRecordTag(key: Uint8Array, row: Omit<ConsumptionRowV1, "record_auth_tag">): string {
    const { record_digest: recordDigest, ...withoutDigest } = row;
    return hmacSha256Tag(key, { ...consumptionRecordMaterialV1(withoutDigest), recordDigest });
  }

  #consumptionHeadTag(key: Uint8Array, row: Omit<ConsumptionHeadRowV1, "head_auth_tag">): string {
    return hmacSha256Tag(key, consumptionHeadMaterialV1(row));
  }

  #verifyConsumptionRow(value: unknown, tenantId: string, expectedSequence: number,
    expectedPreviousDigest: string | null, key: Uint8Array): ConsumptionRowV1 {
    const captured = exactHostDataSnapshotV1(value, ["tenant_id", "sequence", "authorization_id_digest",
      "nonce_digest", "body_digest", "consumed_at", "previous_record_digest", "record_digest", "record_auth_tag"]);
    if (!captured) failV1("integrity_failed");
    const row = captured as unknown as ConsumptionRowV1, sequence = exactSequenceV1(row.sequence);
    if (sequence === undefined || !validIdV1(row.tenant_id) || !validDigestV1(row.authorization_id_digest)
      || !validDigestV1(row.nonce_digest) || !validDigestV1(row.body_digest)
      || exactInstantMillisecondsV1(row.consumed_at) === undefined
      || (row.previous_record_digest !== null && !validDigestV1(row.previous_record_digest))
      || !validDigestV1(row.record_digest) || !validAuthTagV1(row.record_auth_tag)) failV1("integrity_failed");
    const withoutTags: Omit<ConsumptionRowV1, "record_digest" | "record_auth_tag"> = {
      tenant_id: row.tenant_id,
      sequence,
      authorization_id_digest: row.authorization_id_digest,
      nonce_digest: row.nonce_digest,
      body_digest: row.body_digest,
      consumed_at: row.consumed_at,
      previous_record_digest: row.previous_record_digest,
    };
    if (row.tenant_id !== tenantId || sequence !== expectedSequence
      || row.previous_record_digest !== expectedPreviousDigest
      || row.record_digest !== sha256Digest(consumptionRecordMaterialV1(withoutTags))
      || !sameTextV1(row.record_auth_tag,
        this.#consumptionRecordTag(key, { ...withoutTags, record_digest: row.record_digest }))) {
      failV1("integrity_failed");
    }
    return { ...row, sequence };
  }

  async #verifiedConsumptionStream(session: DatabaseSession, tenantId: string, key: Uint8Array): Promise<{
    head?: ConsumptionHeadRowV1;
    consumptions: ConsumptionRowV1[];
  }> {
    const headRows = await safeQueryV1<ConsumptionHeadRowV1>(session, `SELECT tenant_id,last_sequence,
      last_record_digest,head_auth_tag FROM control_native_observation_authorization_consumption_heads
      WHERE tenant_id=$1 FOR UPDATE`, [tenantId], 1);
    const rawConsumptions = await safeQueryV1<ConsumptionRowV1>(session, `SELECT tenant_id,sequence,
      authorization_id_digest,nonce_digest,body_digest,
      to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS consumed_at,
      previous_record_digest,record_digest,record_auth_tag
      FROM control_native_observation_authorization_consumptions WHERE tenant_id=$1 ORDER BY sequence FOR UPDATE`,
    [tenantId]);
    if (!headRows.length) {
      if (rawConsumptions.length) failV1("integrity_failed");
      return { consumptions: [] };
    }
    if (headRows.length !== 1) failV1("integrity_failed");
    const captured = exactHostDataSnapshotV1(headRows[0],
      ["tenant_id", "last_sequence", "last_record_digest", "head_auth_tag"]);
    if (!captured) failV1("integrity_failed");
    const head = captured as unknown as ConsumptionHeadRowV1, lastSequence = exactSequenceV1(head.last_sequence);
    if (lastSequence === undefined || !validIdV1(head.tenant_id) || !validDigestV1(head.last_record_digest)
      || !validAuthTagV1(head.head_auth_tag)) failV1("integrity_failed");
    const consumptions: ConsumptionRowV1[] = [];
    let previous: string | null = null;
    for (let index = 0; index < rawConsumptions.length; index += 1) {
      const verified = this.#verifyConsumptionRow(rawConsumptions[index], tenantId, index + 1, previous, key);
      reflectApplyV1(arrayPushV1, consumptions, [verified]);
      previous = verified.record_digest;
    }
    if (head.tenant_id !== tenantId || lastSequence !== consumptions.length || head.last_record_digest !== previous
      || !sameTextV1(head.head_auth_tag, this.#consumptionHeadTag(key,
        { tenant_id: tenantId, last_sequence: lastSequence, last_record_digest: head.last_record_digest }))) {
      failV1("integrity_failed");
    }
    return { head: { ...head, last_sequence: lastSequence }, consumptions };
  }

  async register(value: unknown): Promise<ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRegistrationV1> {
    const envelope = parseEnvelopeV1(value, this.#authorizationKey, this.#authorizationKeyIdDigest), body = envelope.body;
    try {
      return await this.#transaction(async (session) => {
        const tenants = await safeQueryV1(session, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, [body.tenantId], 1);
        const tenant = tenants.length === 1 ? exactHostDataSnapshotV1(tenants[0], ["id"]) : undefined;
        if (!tenant || tenant.id !== body.tenantId) failV1("integrity_failed");
        const stream = await this.#verifiedStream(session, body.tenantId), authorizationIdDigest = authorizationIdDigestV1(body);
        let identityMatch: VerifiedAuthorizationV1 | undefined, nonceMatch: VerifiedAuthorizationV1 | undefined;
        for (let existingIndex = 0; existingIndex < stream.authorizations.length; existingIndex += 1) {
          const existing = stream.authorizations[existingIndex]!;
          if (existing.row.authorization_id_digest === authorizationIdDigest) {
            if (identityMatch) failV1("integrity_failed");
            identityMatch = existing;
          }
          if (existing.row.nonce_digest === body.nonceDigest) {
            if (nonceMatch) failV1("integrity_failed");
            nonceMatch = existing;
          }
        }
        if (identityMatch || nonceMatch) {
          if (!identityMatch || identityMatch !== nonceMatch || identityMatch.row.body_digest !== envelope.bodyDigest
            || !sameTextV1(identityMatch.row.authorization_auth_tag, envelope.authorizationAuthTag)) {
            failV1("replay_conflict");
          }
          return buildRegistrationV1(identityMatch.body, identityMatch.row.body_digest);
        }
        const sequence = stream.authorizations.length + 1;
        if (sequence > 10_000) failV1("integrity_failed");
        const rowBase: Omit<AuthorizationRowV1, "record_digest" | "record_auth_tag" | "body"> = {
          tenant_id: body.tenantId,
          sequence,
          authorization_id_digest: authorizationIdDigest,
          nonce_digest: body.nonceDigest,
          body_digest: envelope.bodyDigest,
          authorization_auth_tag: envelope.authorizationAuthTag,
          previous_record_digest: stream.head?.last_record_digest ?? null,
        };
        const recordDigest = sha256Digest(recordMaterialV1(rowBase));
        const recordAuthTag = this.#recordTag({ ...rowBase, record_digest: recordDigest });
        const insertedAuthorization = await safeQueryV1(session, `INSERT INTO
          control_native_observation_authorizations(tenant_id,sequence,authorization_id_digest,nonce_digest,
          body_digest,authorization_auth_tag,previous_record_digest,record_digest,record_auth_tag,body)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING tenant_id`, [body.tenantId, sequence,
          authorizationIdDigest, body.nonceDigest, envelope.bodyDigest, envelope.authorizationAuthTag,
          rowBase.previous_record_digest, recordDigest, recordAuthTag,
          reflectApplyV1(jsonStringifyV1, jsonObjectV1, [body]) as string], 1);
        const authorizationInserted = insertedAuthorization.length === 1
          ? exactHostDataSnapshotV1(insertedAuthorization[0], ["tenant_id"]) : undefined;
        if (!authorizationInserted || authorizationInserted.tenant_id !== body.tenantId) failV1("integrity_failed");
        const nonceBase = { tenant_id: body.tenantId, nonce_digest: body.nonceDigest,
          authorization_id_digest: authorizationIdDigest, body_digest: envelope.bodyDigest };
        const reservationDigest = sha256Digest(nonceMaterialV1(nonceBase));
        const reservationAuthTag = this.#nonceTag({ ...nonceBase, reservation_digest: reservationDigest });
        const insertedNonce = await safeQueryV1(session, `INSERT INTO
          control_native_observation_authorization_nonces(tenant_id,nonce_digest,authorization_id_digest,body_digest,
          reservation_digest,reservation_auth_tag) VALUES($1,$2,$3,$4,$5,$6) RETURNING tenant_id`, [body.tenantId,
          body.nonceDigest, authorizationIdDigest, envelope.bodyDigest, reservationDigest, reservationAuthTag], 1);
        const nonceInserted = insertedNonce.length === 1
          ? exactHostDataSnapshotV1(insertedNonce[0], ["tenant_id"]) : undefined;
        if (!nonceInserted || nonceInserted.tenant_id !== body.tenantId) {
          failV1("integrity_failed");
        }
        const nextHead = { tenant_id: body.tenantId, last_sequence: sequence, last_record_digest: recordDigest };
        const headTag = this.#headTag(nextHead);
        const headResult = stream.head
          ? await safeQueryV1(session, `UPDATE control_native_observation_authorization_heads SET last_sequence=$1,
            last_record_digest=$2,head_auth_tag=$3 WHERE tenant_id=$4 RETURNING tenant_id`, [sequence, recordDigest,
            headTag, body.tenantId], 1)
          : await safeQueryV1(session, `INSERT INTO control_native_observation_authorization_heads
            (tenant_id,last_sequence,last_record_digest,head_auth_tag) VALUES($1,$2,$3,$4) RETURNING tenant_id`,
          [body.tenantId, sequence, recordDigest, headTag], 1);
        const headStored = headResult.length === 1 ? exactHostDataSnapshotV1(headResult[0], ["tenant_id"]) : undefined;
        if (!headStored || headStored.tenant_id !== body.tenantId) {
          failV1("integrity_failed");
        }
        return buildRegistrationV1(body, envelope.bodyDigest);
      });
    } catch (error) {
      const code = exactHostErrorCodeV1(error, storeErrorPrototypeV1, "safeCode");
      if (code === "invalid_input" || code === "authentication_failed" || code === "replay_conflict"
        || code === "integrity_failed") failV1(code);
      failV1("integrity_failed");
    }
  }

  async validateForConsumption(value: unknown):
  Promise<ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationValidationV1> {
    const envelope = parseEnvelopeV1(value, this.#authorizationKey, this.#authorizationKeyIdDigest), body = envelope.body;
    try {
      return await this.#transaction(async (session) => {
        const tenants = await safeQueryV1(session, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, [body.tenantId], 1);
        const tenant = tenants.length === 1 ? exactHostDataSnapshotV1(tenants[0], ["id"]) : undefined;
        if (!tenant || tenant.id !== body.tenantId) failV1("authorization_unavailable");
        const stream = await this.#verifiedStream(session, body.tenantId), authorizationIdDigest = authorizationIdDigestV1(body);
        let identityMatch: VerifiedAuthorizationV1 | undefined, nonceMatch: VerifiedAuthorizationV1 | undefined;
        for (let index = 0; index < stream.authorizations.length; index += 1) {
          const existing = stream.authorizations[index]!;
          if (existing.row.authorization_id_digest === authorizationIdDigest) {
            if (identityMatch) failV1("integrity_failed");
            identityMatch = existing;
          }
          if (existing.row.nonce_digest === body.nonceDigest) {
            if (nonceMatch) failV1("integrity_failed");
            nonceMatch = existing;
          }
        }
        if (!identityMatch && !nonceMatch) failV1("authorization_unavailable");
        if (!identityMatch || !nonceMatch || identityMatch !== nonceMatch
          || identityMatch.row.body_digest !== envelope.bodyDigest
          || !sameTextV1(identityMatch.row.authorization_auth_tag, envelope.authorizationAuthTag)) {
          failV1("replay_conflict");
        }
        const timeRows = await safeQueryV1<{ trusted_now: string }>(session, `SELECT
          to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS trusted_now`, [], 1);
        const timeRow = timeRows.length === 1 ? exactHostDataSnapshotV1(timeRows[0], ["trusted_now"]) : undefined;
        const trustedNow = timeRow ? exactInstantMillisecondsV1(timeRow.trusted_now) : undefined;
        if (trustedNow === undefined) failV1("integrity_failed");
        const notBefore = exactInstantMillisecondsV1(identityMatch.body.notBefore);
        const expires = exactInstantMillisecondsV1(identityMatch.body.expiresAt);
        if (notBefore === undefined || expires === undefined) failV1("integrity_failed");
        if (trustedNow < notBefore) failV1("not_yet_valid");
        if (trustedNow >= expires) failV1("expired");
        return buildValidationV1(identityMatch.body, identityMatch.row.body_digest,
          reflectApplyV1(dateToISOStringV1, new dateConstructorV1(trustedNow), []) as string);
      });
    } catch (error) {
      const code = exactHostErrorCodeV1(error, storeErrorPrototypeV1, "safeCode");
      if (code === "invalid_input" || code === "authentication_failed" || code === "replay_conflict"
        || code === "authorization_unavailable" || code === "not_yet_valid" || code === "expired"
        || code === "integrity_failed") failV1(code);
      failV1("integrity_failed");
    }
  }

  async consumeForInvocation(value: unknown):
  Promise<ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1> {
    const consumptionKey = this.#consumptionStateKey;
    if (!consumptionKey) failV1("consumption_unavailable");
    const envelope = parseEnvelopeV1(value, this.#authorizationKey, this.#authorizationKeyIdDigest), body = envelope.body;
    let transactionPrepared = false;
    try {
      return await this.#transaction(async (session) => {
        const tenants = await safeQueryV1(session, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, [body.tenantId], 1);
        const tenant = tenants.length === 1 ? exactHostDataSnapshotV1(tenants[0], ["id"]) : undefined;
        if (!tenant || tenant.id !== body.tenantId) failV1("authorization_unavailable");
        const stream = await this.#verifiedStream(session, body.tenantId), authorizationIdDigest = authorizationIdDigestV1(body);
        let identityMatch: VerifiedAuthorizationV1 | undefined, nonceMatch: VerifiedAuthorizationV1 | undefined;
        for (let index = 0; index < stream.authorizations.length; index += 1) {
          const existing = stream.authorizations[index]!;
          if (existing.row.authorization_id_digest === authorizationIdDigest) {
            if (identityMatch) failV1("integrity_failed");
            identityMatch = existing;
          }
          if (existing.row.nonce_digest === body.nonceDigest) {
            if (nonceMatch) failV1("integrity_failed");
            nonceMatch = existing;
          }
        }
        if (!identityMatch && !nonceMatch) failV1("authorization_unavailable");
        if (!identityMatch || !nonceMatch || identityMatch !== nonceMatch
          || identityMatch.row.body_digest !== envelope.bodyDigest
          || !sameTextV1(identityMatch.row.authorization_auth_tag, envelope.authorizationAuthTag)) {
          failV1("replay_conflict");
        }
        const consumptionStream = await this.#verifiedConsumptionStream(session, body.tenantId, consumptionKey);
        let consumedIdentity: ConsumptionRowV1 | undefined, consumedNonce: ConsumptionRowV1 | undefined;
        for (let index = 0; index < consumptionStream.consumptions.length; index += 1) {
          const existing = consumptionStream.consumptions[index]!;
          if (existing.authorization_id_digest === authorizationIdDigest) consumedIdentity = existing;
          if (existing.nonce_digest === body.nonceDigest) consumedNonce = existing;
        }
        if (consumedIdentity || consumedNonce) {
          if (!consumedIdentity || !consumedNonce || consumedIdentity !== consumedNonce
            || consumedIdentity.body_digest !== envelope.bodyDigest) failV1("replay_conflict");
          const receipt = buildConsumptionV1(identityMatch.body, identityMatch.row.body_digest,
            consumedIdentity.consumed_at, false);
          transactionPrepared = true;
          return receipt;
        }
        const timeRows = await safeQueryV1<{ trusted_now: string }>(session, `SELECT
          to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS trusted_now`, [], 1);
        const timeRow = timeRows.length === 1 ? exactHostDataSnapshotV1(timeRows[0], ["trusted_now"]) : undefined;
        const trustedNow = timeRow ? exactInstantMillisecondsV1(timeRow.trusted_now) : undefined;
        if (trustedNow === undefined) failV1("integrity_failed");
        const notBefore = exactInstantMillisecondsV1(identityMatch.body.notBefore);
        const expires = exactInstantMillisecondsV1(identityMatch.body.expiresAt);
        if (notBefore === undefined || expires === undefined) failV1("integrity_failed");
        if (trustedNow < notBefore) failV1("not_yet_valid");
        if (trustedNow >= expires) failV1("expired");
        const consumedAt = reflectApplyV1(dateToISOStringV1, new dateConstructorV1(trustedNow), []) as string;
        const sequence = consumptionStream.consumptions.length + 1;
        if (sequence > 10_000) failV1("integrity_failed");
        const rowBase: Omit<ConsumptionRowV1, "record_digest" | "record_auth_tag"> = {
          tenant_id: body.tenantId,
          sequence,
          authorization_id_digest: authorizationIdDigest,
          nonce_digest: body.nonceDigest,
          body_digest: envelope.bodyDigest,
          consumed_at: consumedAt,
          previous_record_digest: consumptionStream.head?.last_record_digest ?? null,
        };
        const recordDigest = sha256Digest(consumptionRecordMaterialV1(rowBase));
        const recordAuthTag = this.#consumptionRecordTag(consumptionKey, { ...rowBase, record_digest: recordDigest });
        const inserted = await safeQueryV1(session, `INSERT INTO
          control_native_observation_authorization_consumptions(tenant_id,sequence,authorization_id_digest,
          nonce_digest,body_digest,consumed_at,previous_record_digest,record_digest,record_auth_tag)
          VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9) RETURNING tenant_id`, [body.tenantId, sequence,
          authorizationIdDigest, body.nonceDigest, envelope.bodyDigest, consumedAt, rowBase.previous_record_digest,
          recordDigest, recordAuthTag], 1);
        const insertedRow = inserted.length === 1 ? exactHostDataSnapshotV1(inserted[0], ["tenant_id"]) : undefined;
        if (!insertedRow || insertedRow.tenant_id !== body.tenantId) failV1("integrity_failed");
        const nextHead = { tenant_id: body.tenantId, last_sequence: sequence, last_record_digest: recordDigest };
        const headTag = this.#consumptionHeadTag(consumptionKey, nextHead);
        const headResult = consumptionStream.head
          ? await safeQueryV1(session, `UPDATE control_native_observation_authorization_consumption_heads
            SET last_sequence=$1,last_record_digest=$2,head_auth_tag=$3 WHERE tenant_id=$4 RETURNING tenant_id`,
          [sequence, recordDigest, headTag, body.tenantId], 1)
          : await safeQueryV1(session, `INSERT INTO control_native_observation_authorization_consumption_heads
            (tenant_id,last_sequence,last_record_digest,head_auth_tag) VALUES($1,$2,$3,$4) RETURNING tenant_id`,
          [body.tenantId, sequence, recordDigest, headTag], 1);
        const headStored = headResult.length === 1 ? exactHostDataSnapshotV1(headResult[0], ["tenant_id"]) : undefined;
        if (!headStored || headStored.tenant_id !== body.tenantId) failV1("integrity_failed");
        const receipt = buildConsumptionV1(identityMatch.body, identityMatch.row.body_digest, consumedAt, true);
        transactionPrepared = true;
        return receipt;
      });
    } catch (error) {
      if (transactionPrepared) failV1("terminal_ambiguity");
      const code = exactHostErrorCodeV1(error, storeErrorPrototypeV1, "safeCode");
      if (code === "invalid_input" || code === "authentication_failed" || code === "replay_conflict"
        || code === "authorization_unavailable" || code === "consumption_unavailable"
        || code === "not_yet_valid" || code === "expired" || code === "integrity_failed") failV1(code);
      failV1("terminal_ambiguity");
    }
  }

  async recheckAfterConsumption(value: unknown, consumptionValue: unknown):
  Promise<ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1> {
    const consumptionKey = this.#consumptionStateKey;
    if (!consumptionKey) failV1("consumption_unavailable");
    const envelope = parseEnvelopeV1(value, this.#authorizationKey, this.#authorizationKeyIdDigest), body = envelope.body;
    const consumption = parseFreshConsumptionV1(consumptionValue, body, envelope.bodyDigest);
    try {
      return await this.#transaction(async (session) => {
        const tenants = await safeQueryV1(session, `SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, [body.tenantId], 1);
        const tenant = tenants.length === 1 ? exactHostDataSnapshotV1(tenants[0], ["id"]) : undefined;
        if (!tenant || tenant.id !== body.tenantId) failV1("authorization_unavailable");
        const stream = await this.#verifiedStream(session, body.tenantId);
        const authorizationIdDigest = authorizationIdDigestV1(body);
        let identityMatch: VerifiedAuthorizationV1 | undefined, nonceMatch: VerifiedAuthorizationV1 | undefined;
        for (let index = 0; index < stream.authorizations.length; index += 1) {
          const existing = stream.authorizations[index]!;
          if (existing.row.authorization_id_digest === authorizationIdDigest) {
            if (identityMatch) failV1("integrity_failed");
            identityMatch = existing;
          }
          if (existing.row.nonce_digest === body.nonceDigest) {
            if (nonceMatch) failV1("integrity_failed");
            nonceMatch = existing;
          }
        }
        if (!identityMatch && !nonceMatch) failV1("authorization_unavailable");
        if (!identityMatch || !nonceMatch || identityMatch !== nonceMatch
          || identityMatch.row.body_digest !== envelope.bodyDigest
          || !sameTextV1(identityMatch.row.authorization_auth_tag, envelope.authorizationAuthTag)) {
          failV1("replay_conflict");
        }
        const consumptionStream = await this.#verifiedConsumptionStream(session, body.tenantId, consumptionKey);
        let consumedIdentity: ConsumptionRowV1 | undefined, consumedNonce: ConsumptionRowV1 | undefined;
        for (let index = 0; index < consumptionStream.consumptions.length; index += 1) {
          const existing = consumptionStream.consumptions[index]!;
          if (existing.authorization_id_digest === authorizationIdDigest) {
            if (consumedIdentity) failV1("integrity_failed");
            consumedIdentity = existing;
          }
          if (existing.nonce_digest === body.nonceDigest) {
            if (consumedNonce) failV1("integrity_failed");
            consumedNonce = existing;
          }
        }
        if (!consumedIdentity && !consumedNonce) failV1("consumption_unavailable");
        if (!consumedIdentity || !consumedNonce || consumedIdentity !== consumedNonce
          || consumedIdentity.body_digest !== envelope.bodyDigest
          || consumedIdentity.consumed_at !== consumption.consumedAt) failV1("replay_conflict");
        const timeRows = await safeQueryV1<{ trusted_now: string }>(session, `SELECT
          to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS trusted_now`, [], 1);
        const timeRow = timeRows.length === 1 ? exactHostDataSnapshotV1(timeRows[0], ["trusted_now"]) : undefined;
        const trustedNow = timeRow ? exactInstantMillisecondsV1(timeRow.trusted_now) : undefined;
        const consumedAt = exactInstantMillisecondsV1(consumedIdentity.consumed_at);
        const notBefore = exactInstantMillisecondsV1(identityMatch.body.notBefore);
        const expires = exactInstantMillisecondsV1(identityMatch.body.expiresAt);
        if (trustedNow === undefined || consumedAt === undefined || notBefore === undefined || expires === undefined
          || trustedNow < consumedAt || trustedNow < notBefore) failV1("integrity_failed");
        if (trustedNow >= expires) failV1("expired");
        const recheckedAt = reflectApplyV1(dateToISOStringV1, new dateConstructorV1(trustedNow), []) as string;
        return buildRecheckV1(identityMatch.body, identityMatch.row.body_digest,
          consumedIdentity.consumed_at, recheckedAt);
      });
    } catch (error) {
      const code = exactHostErrorCodeV1(error, storeErrorPrototypeV1, "safeCode");
      if (code === "invalid_input" || code === "authentication_failed" || code === "replay_conflict"
        || code === "authorization_unavailable" || code === "consumption_unavailable" || code === "expired"
        || code === "integrity_failed") failV1(code);
      failV1("integrity_failed");
    }
  }
}

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_INVOCATION_AUTHORIZATION_STORE_DISABLED_V1 = objectFreezeV1({
  state: "disabled_pending_protected_keys_and_database" as const,
  readOnlyValidationImplemented: true as const,
  atomicConsumptionImplemented: true as const,
  postTransactionTimeRecheckImplemented: true as const,
  trustedDatabaseTimeRequired: true as const,
  productionDatabaseConfigured: false as const,
  authorizationKeyConfigured: false as const,
  stateKeyConfigured: false as const,
  consumptionStateKeyConfigured: false as const,
  productionIssuerImplemented: false as const,
  authorizationValidations: 0 as const,
  databaseClockReads: 0 as const,
  authorizationConsumptions: 0 as const,
  sourceLookups: 0 as const,
  sourceInvocations: 0 as const,
  nativeReads: 0 as const,
  physicalAttempts: 0 as const,
  listenerAttempts: 0 as const,
  networkIoEvents: 0 as const,
  providerCalls: 0 as const,
  externalEffectOccurred: false as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
});

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.register);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.validateForConsumption);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.consumeForInvocation);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.recheckAfterConsumption);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1);
