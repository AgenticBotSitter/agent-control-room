import { randomBytes, timingSafeEqual } from "node:crypto";
import { hmacSha256Tag, sha256Digest } from "../../security/digest";
import { exactHostDataSnapshotV1, exactHostUint8ArrayV1, wipeHostUint8ArrayV1 } from "../../security/host-value";

/**
 * A source-only verifier for the health evidence that may accompany a macOS
 * platform-service journal success. It has no launchctl, filesystem, process,
 * credential-loader, journal, or service capability. A separately reviewed
 * native owner/root publisher must obtain the facts and sign the reply.
 */
export const PRIVATE_MACOS_SERVICE_HEALTH_EVIDENCE_V1 =
  "control-room.private-macos-service-health-evidence/v1" as const;
export const PRIVATE_MACOS_SERVICE_HEALTH_CHALLENGE_V1 =
  "control-room.private-macos-service-health-challenge/v1" as const;
export const PRIVATE_MACOS_SERVICE_HEALTH_RESPONSE_V1 =
  "control-room.private-macos-service-health-response/v1" as const;

const serviceLabel = "xyz.agentcontrolroom.local" as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const authTagPattern = /^hmac-sha256:[a-f0-9]{64}$/u;
const noncePattern = /^[A-Za-z0-9_-]{43}$/u;
const maximumChallengeLifetimeMs = 120_000;

type HealthBinding = Readonly<{
  installationId: string;
  installationPlanDigest: string;
  installationPlanRevision: number;
  ownerUid: number;
  ownerIdentityDigest: string;
  publisher: "owner" | "root";
  publisherUid: number;
  launchctlDomain: string;
  launchctlTarget: string;
  serviceLabel: typeof serviceLabel;
  serviceIdentityDigest: string;
  releaseDigest: string;
  configurationDigest: string;
  serviceInstanceDigest: string;
  databaseAuthorityDigest: string;
  protectedDataBindingDigest: string;
  supervisorReadinessDigest: string;
  readinessDigest: string;
}>;

export type PrivateMacosServiceHealthChallengeV1 = Readonly<HealthBinding & {
  schema: typeof PRIVATE_MACOS_SERVICE_HEALTH_CHALLENGE_V1;
  nonce: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  challengeDigest: string;
}>;

export type PrivateMacosServiceHealthResponseV1 = Readonly<HealthBinding & {
  schema: typeof PRIVATE_MACOS_SERVICE_HEALTH_RESPONSE_V1;
  challengeDigest: string;
  nonce: string;
  issuedAtUnixMs: number;
  expiresAtUnixMs: number;
  observedAtUnixMs: number;
  healthState: "healthy";
  healthObservationDigest: string;
  authTag: string;
}>;

export type PrivateMacosServiceHealthEvidenceV1 = Readonly<HealthBinding & {
  schema: typeof PRIVATE_MACOS_SERVICE_HEALTH_EVIDENCE_V1;
  challengeDigest: string;
  healthObservationDigest: string;
  observedAtUnixMs: number;
  healthEvidenceDigest: string;
  freshAuthenticatedHealth: true;
  eligibleForJournalSuccess: true;
  createsJournalRecord: false;
  startsService: false;
  grantsAgentReadiness: false;
}>;

export type PrivateMacosServiceHealthEvidenceVerifierV1 = Readonly<{
  issueChallenge(input: unknown): PrivateMacosServiceHealthChallengeV1;
  verifyResponse(challenge: unknown, response: unknown): PrivateMacosServiceHealthEvidenceV1;
  close(): void;
}>;

const refused = (): never => {
  const error = new Error("private_macos_service_health_evidence_refused");
  error.stack = undefined;
  throw error;
};

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  const snapshot = exactHostDataSnapshotV1(value, names);
  if (!snapshot) return refused();
  return snapshot;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function installationId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(value)) return refused();
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return refused();
  return value as number;
}

const bindingNames = ["installationId", "installationPlanDigest", "installationPlanRevision", "ownerUid",
    "ownerIdentityDigest", "publisher", "publisherUid", "launchctlDomain", "launchctlTarget", "serviceLabel",
    "serviceIdentityDigest", "releaseDigest", "configurationDigest", "serviceInstanceDigest", "databaseAuthorityDigest",
    "protectedDataBindingDigest", "supervisorReadinessDigest", "readinessDigest"] as const;

function captureBindingRecord(input: Readonly<Record<string, unknown>>): HealthBinding {
  const ownerUid = safeInteger(input.ownerUid, 1, 2_147_483_647);
  const publisherUid = safeInteger(input.publisherUid, 0, 2_147_483_647);
  if ((input.publisher !== "owner" && input.publisher !== "root")
    || (input.publisher === "owner" && publisherUid !== ownerUid)
    || (input.publisher === "root" && publisherUid !== 0)
    || input.launchctlDomain !== `gui/${ownerUid}`
    || input.launchctlTarget !== `gui/${ownerUid}/${serviceLabel}`
    || input.serviceLabel !== serviceLabel) return refused();
  return Object.freeze({ installationId: installationId(input.installationId),
    installationPlanDigest: digest(input.installationPlanDigest),
    installationPlanRevision: safeInteger(input.installationPlanRevision, 0, 2_147_483_647), ownerUid,
    ownerIdentityDigest: digest(input.ownerIdentityDigest), publisher: input.publisher, publisherUid,
    launchctlDomain: input.launchctlDomain, launchctlTarget: input.launchctlTarget, serviceLabel,
    serviceIdentityDigest: digest(input.serviceIdentityDigest), releaseDigest: digest(input.releaseDigest),
    configurationDigest: digest(input.configurationDigest), serviceInstanceDigest: digest(input.serviceInstanceDigest),
    databaseAuthorityDigest: digest(input.databaseAuthorityDigest),
    protectedDataBindingDigest: digest(input.protectedDataBindingDigest),
    supervisorReadinessDigest: digest(input.supervisorReadinessDigest), readinessDigest: digest(input.readinessDigest) });
}

function captureBinding(value: unknown): HealthBinding {
  return captureBindingRecord(exact(value, bindingNames));
}

function challengeDigest(binding: HealthBinding, nonce: string, issuedAtUnixMs: number, expiresAtUnixMs: number): string {
  return sha256Digest({ purpose: "private-macos-service-health-challenge/v1", binding, nonce, issuedAtUnixMs, expiresAtUnixMs });
}

function captureChallenge(value: unknown): PrivateMacosServiceHealthChallengeV1 {
  const input = exact(value, ["schema", "installationId", "installationPlanDigest", "installationPlanRevision", "ownerUid",
    "ownerIdentityDigest", "publisher", "publisherUid", "launchctlDomain", "launchctlTarget", "serviceLabel",
    "serviceIdentityDigest", "releaseDigest", "configurationDigest", "serviceInstanceDigest", "databaseAuthorityDigest",
    "protectedDataBindingDigest", "supervisorReadinessDigest", "readinessDigest", "nonce", "issuedAtUnixMs",
    "expiresAtUnixMs", "challengeDigest"]);
  if (input.schema !== PRIVATE_MACOS_SERVICE_HEALTH_CHALLENGE_V1 || typeof input.nonce !== "string"
    || !noncePattern.test(input.nonce)) return refused();
  const issuedAtUnixMs = safeInteger(input.issuedAtUnixMs, 0, Number.MAX_SAFE_INTEGER);
  const expiresAtUnixMs = safeInteger(input.expiresAtUnixMs, 0, Number.MAX_SAFE_INTEGER);
  if (expiresAtUnixMs <= issuedAtUnixMs || expiresAtUnixMs - issuedAtUnixMs > maximumChallengeLifetimeMs) return refused();
  const binding = captureBindingRecord(input);
  const computed = challengeDigest(binding, input.nonce, issuedAtUnixMs, expiresAtUnixMs);
  if (input.challengeDigest !== computed) return refused();
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_HEALTH_CHALLENGE_V1, ...binding, nonce: input.nonce,
    issuedAtUnixMs, expiresAtUnixMs, challengeDigest: computed });
}

function responseAuthMaterial(response: Omit<PrivateMacosServiceHealthResponseV1, "authTag">) {
  return { purpose: "private-macos-service-health-response-auth/v1", response };
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function captureResponse(value: unknown): PrivateMacosServiceHealthResponseV1 {
  const input = exact(value, ["schema", "installationId", "installationPlanDigest", "installationPlanRevision", "ownerUid",
    "ownerIdentityDigest", "publisher", "publisherUid", "launchctlDomain", "launchctlTarget", "serviceLabel",
    "serviceIdentityDigest", "releaseDigest", "configurationDigest", "serviceInstanceDigest", "databaseAuthorityDigest",
    "protectedDataBindingDigest", "supervisorReadinessDigest", "readinessDigest", "challengeDigest", "nonce",
    "issuedAtUnixMs", "expiresAtUnixMs", "observedAtUnixMs", "healthState", "healthObservationDigest", "authTag"]);
  if (input.schema !== PRIVATE_MACOS_SERVICE_HEALTH_RESPONSE_V1 || input.healthState !== "healthy"
    || typeof input.nonce !== "string" || !noncePattern.test(input.nonce)
    || typeof input.authTag !== "string" || !authTagPattern.test(input.authTag)) return refused();
  const binding = captureBindingRecord(input);
  const response = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_HEALTH_RESPONSE_V1, ...binding,
    challengeDigest: digest(input.challengeDigest), nonce: input.nonce,
    issuedAtUnixMs: safeInteger(input.issuedAtUnixMs, 0, Number.MAX_SAFE_INTEGER),
    expiresAtUnixMs: safeInteger(input.expiresAtUnixMs, 0, Number.MAX_SAFE_INTEGER),
    observedAtUnixMs: safeInteger(input.observedAtUnixMs, 0, Number.MAX_SAFE_INTEGER), healthState: "healthy" as const,
    healthObservationDigest: digest(input.healthObservationDigest), authTag: input.authTag });
  if (response.expiresAtUnixMs <= response.issuedAtUnixMs
    || response.expiresAtUnixMs - response.issuedAtUnixMs > maximumChallengeLifetimeMs) return refused();
  return response;
}

function sameBinding(left: HealthBinding, right: HealthBinding): boolean {
  return left.installationId === right.installationId && left.installationPlanDigest === right.installationPlanDigest
    && left.installationPlanRevision === right.installationPlanRevision && left.ownerUid === right.ownerUid
    && left.ownerIdentityDigest === right.ownerIdentityDigest && left.publisher === right.publisher
    && left.publisherUid === right.publisherUid && left.launchctlDomain === right.launchctlDomain
    && left.launchctlTarget === right.launchctlTarget && left.serviceLabel === right.serviceLabel
    && left.serviceIdentityDigest === right.serviceIdentityDigest && left.releaseDigest === right.releaseDigest
    && left.configurationDigest === right.configurationDigest && left.serviceInstanceDigest === right.serviceInstanceDigest
    && left.databaseAuthorityDigest === right.databaseAuthorityDigest
    && left.protectedDataBindingDigest === right.protectedDataBindingDigest
    && left.supervisorReadinessDigest === right.supervisorReadinessDigest && left.readinessDigest === right.readinessDigest;
}

function captureKey(value: unknown): Uint8Array {
  const bytes = exactHostUint8ArrayV1(value, 128);
  if (!bytes || bytes.byteLength < 32) return refused();
  return bytes.copy();
}

/**
 * Captures one installation binding and its private HMAC key. Construction is
 * inert. The key is copied into closure state, never returned, logged, or
 * accepted from a challenge or response. One verifier issues one bounded
 * challenge; only an exact response replay is accepted after first success.
 * Its explicit close operation erases the copied key and permanently refuses
 * further use; production custody must call it in a finally block.
 */
export function createPrivateMacosServiceHealthEvidenceVerifierV1(input: unknown): PrivateMacosServiceHealthEvidenceVerifierV1 {
  const envelope = exact(input, ["binding", "installationPrivateKey"]);
  const binding = captureBinding(envelope.binding), key = captureKey(envelope.installationPrivateKey);
  let issued: PrivateMacosServiceHealthChallengeV1 | undefined;
  let acceptedResponseDigest: string | undefined;
  let closed = false;
  const requireOpen = () => { if (closed) return refused(); };
  return Object.freeze({
    issueChallenge(value: unknown): PrivateMacosServiceHealthChallengeV1 {
      requireOpen();
      if (issued !== undefined) return refused();
      const request = exact(value, ["issuedAtUnixMs", "expiresAtUnixMs"]);
      const issuedAtUnixMs = safeInteger(request.issuedAtUnixMs, 0, Number.MAX_SAFE_INTEGER);
      const expiresAtUnixMs = safeInteger(request.expiresAtUnixMs, 0, Number.MAX_SAFE_INTEGER);
      const now = Date.now();
      if (issuedAtUnixMs > now || now - issuedAtUnixMs > maximumChallengeLifetimeMs || expiresAtUnixMs <= now
        || expiresAtUnixMs - issuedAtUnixMs > maximumChallengeLifetimeMs) return refused();
      const nonce = randomBytes(32).toString("base64url");
      if (!noncePattern.test(nonce)) return refused();
      const digestValue = challengeDigest(binding, nonce, issuedAtUnixMs, expiresAtUnixMs);
      issued = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_HEALTH_CHALLENGE_V1, ...binding, nonce,
        issuedAtUnixMs, expiresAtUnixMs, challengeDigest: digestValue });
      return issued;
    },
    verifyResponse(challengeValue: unknown, responseValue: unknown): PrivateMacosServiceHealthEvidenceV1 {
      requireOpen();
      const challenge = captureChallenge(challengeValue), response = captureResponse(responseValue);
      const now = Date.now();
      if (!issued || challenge.challengeDigest !== issued.challengeDigest || !sameBinding(challenge, binding)
        || challenge.nonce !== issued.nonce || challenge.issuedAtUnixMs !== issued.issuedAtUnixMs
        || challenge.expiresAtUnixMs !== issued.expiresAtUnixMs || challenge.issuedAtUnixMs > now
        || challenge.expiresAtUnixMs < now || response.challengeDigest !== challenge.challengeDigest
        || response.nonce !== challenge.nonce || response.issuedAtUnixMs !== challenge.issuedAtUnixMs
        || response.expiresAtUnixMs !== challenge.expiresAtUnixMs || response.observedAtUnixMs < challenge.issuedAtUnixMs
        || response.observedAtUnixMs > challenge.expiresAtUnixMs || response.observedAtUnixMs > now
        || !sameBinding(response, challenge)) return refused();
      const { authTag, ...unsigned } = response;
      const expected = hmacSha256Tag(key, responseAuthMaterial(unsigned));
      if (!same(expected, authTag)) return refused();
      const responseDigest = sha256Digest(response);
      if (acceptedResponseDigest !== undefined && acceptedResponseDigest !== responseDigest) return refused();
      acceptedResponseDigest = responseDigest;
      const evidence = { schema: PRIVATE_MACOS_SERVICE_HEALTH_EVIDENCE_V1, ...binding,
        challengeDigest: challenge.challengeDigest, healthObservationDigest: response.healthObservationDigest,
        observedAtUnixMs: response.observedAtUnixMs, freshAuthenticatedHealth: true as const,
        eligibleForJournalSuccess: true as const, createsJournalRecord: false as const, startsService: false as const,
        grantsAgentReadiness: false as const };
      return Object.freeze({ ...evidence,
        healthEvidenceDigest: sha256Digest({ purpose: "private-macos-service-health-evidence/v1", evidence }) });
    },
    close(): void {
      if (closed) return;
      closed = true; issued = undefined; acceptedResponseDigest = undefined;
      if (!wipeHostUint8ArrayV1(key)) return refused();
    },
  });
}
