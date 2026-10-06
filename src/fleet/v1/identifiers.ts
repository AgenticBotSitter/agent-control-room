import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
export { FLEET_WORKER_KINDS_V1 } from "./catalog";

/** Opaque secrets are 43 base64url characters behind a short type prefix. The
 * code is shown to the owner once; the credential is generated on the worker
 * machine and only its digest ever reaches Control Room. */
export const FLEET_CODE_PATTERN_V1 = /^crj_[A-Za-z0-9_-]{43}$/u;
export const FLEET_SECRET_PATTERN_V1 = /^crf_[A-Za-z0-9_-]{43}$/u;
export const FLEET_DIGEST_PATTERN_V1 = /^sha256:[a-f0-9]{64}$/u;
export const FLEET_WORKER_ID_PATTERN_V1 = /^fleet-worker:[a-f0-9]{32}$/u;
export const FLEET_ENTITY_ID_PATTERN_V1 = /^fleet-(?:claim|result|offer|code|event|review|credential):[a-f0-9]{32}$/u;
export const FLEET_PROJECT_ID_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
export const FLEET_CAPABILITY_PATTERN_V1 = /^[a-z][a-z0-9._-]{1,63}$/u;
export const FLEET_WORKER_KIND_PATTERN_V1 = /^[a-z][a-z0-9-]{1,39}$/u;
export const FLEET_IDEMPOTENCY_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u;

export const FLEET_CODE_LIFETIME_MS_V1 = 10 * 60_000;
export const FLEET_CREDENTIAL_LIFETIME_MS_V1 = 30 * 86_400_000;
export const FLEET_LEASE_MS_V1 = 15 * 60_000;

/**
 * How long one observation of a machine stays current enough to read as
 * "here", in milliseconds.
 *
 * FIVE MINUTES, and it is the same five minutes as the fleet telemetry
 * lifetime this repository decided on 2026-10-02 (the node-fleet telemetry
 * port caps an observation at 300 seconds, and the operator read service
 * admits a telemetry row only while `expires_at <= observed_at + INTERVAL '5
 * minutes'`). A worker telemetry signal and a worker's presence row are the
 * same fact seen from two places, so they must not be given two different
 * budgets: the same machine would read as measured on one screen and stale on
 * another within the same minute.
 *
 * It is named HERE, beside the other fleet lifetimes, because that is the
 * module that owns the subject. `owner-service.listWorkers` is its only reader
 * and it now imports this instead of carrying its own `5 * 60_000`, so a second
 * screen cannot quietly introduce a second lifetime.
 *
 * What the number is NOT: a lease, a deadline or a claim window. Nothing about
 * running work depends on it. A machine that stops being seen simply stops
 * reading as here.
 */
export const FLEET_PRESENCE_LIFETIME_MS_V1 = 5 * 60_000;

export function plainSha256V1(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function bytesSha256V1(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sameDigestV1(a: string, b: string): boolean {
  const x = Buffer.from(a, "ascii"), y = Buffer.from(b, "ascii");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomHexV1 = () => randomBytes(16).toString("hex");
export const newFleetCodeV1 = () => `crj_${randomBytes(32).toString("base64url")}`;
export const newFleetSecretV1 = () => `crf_${randomBytes(32).toString("base64url")}`;

/** Every enrolled machine uses one random suffix for all of its linked rows. */
export function fleetWorkerLinkedIdsV1(workerId: string) {
  if (!FLEET_WORKER_ID_PATTERN_V1.test(workerId)) throw new Error("fleet_worker_id_invalid");
  const hex = workerId.slice("fleet-worker:".length);
  return Object.freeze({ workerId, nodeId: `node:fleet:${hex}`, identityId: `identity:fleet:${hex}`,
    grantId: `grant:fleet:${hex}`, identityKeyId: `fleet-key:${hex}`,
    authSubjectDigest: plainSha256V1(`fleet-worker/v1:${workerId}`) });
}

/** Deterministic child ids so an exact retry lands on the same rows. */
export function fleetDerivedIdV1(kind: "claim" | "result" | "event", ...parts: string[]) {
  return `fleet-${kind}:${createHash("sha256").update(JSON.stringify([kind, ...parts]), "utf8").digest("hex").slice(0, 32)}`;
}
