import { z } from "zod";
import { sha256Digest } from "../../security";
import { verifyArtifactSignature } from "../../node-policy/v1/crypto";
import { resolvePinnedApprovalKey, type PinnedApprovalTrustStore } from "../../node-policy/v1/pinned-approval-trust";
import type { SqliteNodeSecurityStateRepository } from "../../node-policy/v1/persistent-security-state";
import type { SqliteEffectClaimStore } from "../../node-policy/v1/effect-claim-store";
import { applyEffectClaimEvent, type EffectClaimSnapshotV1 } from "../../node-policy/v1/effect-claim";
import { bindingSchema, enrollmentSchema, snapshotSchema, type NativeRunJournal } from "./contracts";
import { digestSchema, localId } from "../v1/native-run-identifiers";

const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeCleanupAcceptanceBodySchema = z.object({
  schema: z.literal("control-room.native-cleanup-acceptance/v1"), enrollmentDigest: digestSchema,
  producerDigest: digestSchema, evidenceDigest: digestSchema, nodeClass: localId, approvalKeyId: localId,
  issuedAt: instant, expiresAt: instant,
  guarantees: z.object({ exactRunIsolation: z.literal(true), descendantsStoppedVerified: z.literal(true),
    nativeRequestsDrainedVerified: z.literal(true), durableRevisionTracking: z.literal(true) }).strict(),
  bodyDigest: digestSchema,
}).strict();
export type NativeCleanupAcceptanceBody = z.infer<typeof nativeCleanupAcceptanceBodySchema>;
const acceptanceSchema = z.object({ body: nativeCleanupAcceptanceBodySchema,
  signatureAlgorithm: z.literal("Ed25519"), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export const nativeCleanupSnapshotSchema = z.object({
  enrollmentDigest: digestSchema, producerDigest: digestSchema, bindingDigest: digestSchema,
  nativeRunId: snapshotSchema.shape.nativeRunId.unwrap(), snapshotDigest: digestSchema, markerDigest: digestSchema,
  revision: instant, observedAt: instant, validUntil: instant, state: z.literal("quiescent"),
  remainingDescendants: z.literal(0), pendingNativeRequests: z.literal(0),
}).strict();
export type NativeCleanupSnapshot = z.infer<typeof nativeCleanupSnapshotSchema>;
function fail(): never { throw new Error("native_cleanup_evidence_unavailable"); }

/** Read-only proof consumer. The separately accepted protected supervisor produces
 * physical evidence; terminal native JSON and successful close are not that proof.
 * No producer, signer, settlement, new execution or automatic recovery is provided. */
export function createNativeCleanupEvidence(config: { enrollment: unknown; binding: unknown; acceptance: unknown }, deps: {
  approvals: PinnedApprovalTrustStore;
  security: Pick<SqliteNodeSecurityStateRepository, "currentServerTrustRevision">;
  runs: Pick<NativeRunJournal, "load">;
  effects: Pick<SqliteEffectClaimStore, "load">;
  readSupervisedCleanup(): NativeCleanupSnapshot;
  clock?: () => number;
}) {
  const enrollment = enrollmentSchema.parse(config.enrollment), binding = bindingSchema.parse(config.binding),
    acceptance = acceptanceSchema.parse(config.acceptance), body = acceptance.body;
  const enrollmentDigest = sha256Digest(enrollment), bindingDigest = sha256Digest(binding);
  const scope = { tenantId: enrollment.tenantId, nodeId: enrollment.nodeId, nodeClass: body.nodeClass };
  if (binding.enrollmentDigest !== enrollmentDigest || binding.tenantId !== enrollment.tenantId || binding.nodeId !== enrollment.nodeId
    || body.enrollmentDigest !== enrollmentDigest || body.expiresAt <= body.issuedAt || body.expiresAt > enrollment.validUntil
    || sha256Digest(deps.approvals.binding()) !== sha256Digest(scope)) fail();
  const approvals = deps.approvals, revision = deps.security.currentServerTrustRevision.bind(deps.security),
    load = deps.runs.load.bind(deps.runs), claim = deps.effects.load.bind(deps.effects),
    read = deps.readSupervisedCleanup.bind(deps), clock = deps.clock?.bind(deps) ?? Date.now;
  let highTime = -1, highRevision = -1, previous: string | undefined, closed = false;
  function current(signal: AbortSignal, transition?: { before: EffectClaimSnapshotV1; afterDigest: string }) {
    if (closed || !(signal instanceof AbortSignal) || signal.aborted) fail();
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < highTime) fail(); highTime = now;
    if (now < body.issuedAt || now >= body.expiresAt) fail();
    const snapshot = snapshotSchema.parse(load(binding.runId)), retained = claim(binding.effectClaimKey);
    if (retained?.kind !== "full") fail();
    const retainedDigest = sha256Digest(retained.snapshot);
    // Only this verifier's exact computed transition may normalize to the prior
    // claim during the transactional post-write check. All other evidence stays exact.
    const effect = transition && retainedDigest === transition.afterDigest
      ? { kind: "full" as const, snapshot: transition.before } : retained;
    if (snapshot.state !== "completed" || snapshot.availability !== "current" || snapshot.nativeRunId === null
      || snapshot.resultText === null || snapshot.observedAt > now || sha256Digest(snapshot.binding) !== bindingDigest
      || effect?.kind !== "full" || !effect.snapshot.markerDigest || !["executing", "ambiguous"].includes(effect.snapshot.state)) fail();
    const identity = { tenantId: binding.tenantId, nodeId: binding.nodeId, projectId: binding.projectId,
      jobId: binding.jobId, attemptId: binding.attemptId, operationDigest: binding.operationDigest };
    if (effect.snapshot.claimKey !== binding.effectClaimKey || sha256Digest(effect.snapshot.identity) !== sha256Digest(identity)
      || effect.snapshot.effectiveDeadline !== new Date(binding.deadline).toISOString()) fail();
    const proof = nativeCleanupSnapshotSchema.parse(read()), digest = sha256Digest(proof);
    if (proof.enrollmentDigest !== enrollmentDigest || proof.producerDigest !== body.producerDigest
      || proof.bindingDigest !== bindingDigest || proof.nativeRunId !== snapshot.nativeRunId
      || proof.snapshotDigest !== sha256Digest(snapshot) || proof.markerDigest !== effect.snapshot.markerDigest
      || proof.revision < highRevision || proof.revision === highRevision && digest !== previous) fail();
    highRevision = proof.revision; previous = digest;
    if (proof.observedAt > now || proof.observedAt < snapshot.observedAt || proof.observedAt < Date.parse(effect.snapshot.updatedAt)
      || proof.validUntil <= now || proof.validUntil <= proof.observedAt || proof.validUntil > body.expiresAt
      || proof.validUntil - proof.observedAt > 30_000) fail();
    approvals.assertAvailable();
    const trust = revision(), after = clock();
    // Trusted synchronous readers may still take time or trigger revocation.
    // Their successful return cannot lend the earlier clock sample to this proof.
    if (closed || signal.aborted || !Number.isSafeInteger(after) || after < now || after < highTime
      || after >= body.expiresAt || after >= proof.validUntil) fail();
    highTime = after;
    return { digest: sha256Digest({ proof, acceptance: sha256Digest(acceptance), snapshot: sha256Digest(snapshot),
      claim: sha256Digest(effect.snapshot), trust }), retainedDigest, claim: effect.snapshot, snapshot, proof };
  }
  return Object.freeze({ close() { closed = true; }, async verify(signal: AbortSignal) {
    try {
      const deadline = performance.now() + 5000, before = current(signal);
      const key = await resolvePinnedApprovalKey(approvals, scope, body.approvalKeyId);
      if (!key || !verifyArtifactSignature(acceptance, key.publicKeySpki)) fail();
      const assertFresh = () => { try {
        if (performance.now() >= deadline || current(signal).digest !== before.digest || performance.now() >= deadline) fail();
      } catch { closed = true; fail(); } };
      assertFresh();
      const event = Object.freeze({ eventId: `event:cleanup:${before.digest.slice(7)}`, kind: "confirmed" as const,
        occurredAt: new Date(before.proof.observedAt).toISOString(), destinationReceiptDigest: before.digest });
      const afterDigest = sha256Digest(applyEffectClaimEvent(before.claim, event));
      const confirmation = Object.freeze({ event, expectedSnapshotDigest: before.retainedDigest,
        executionId: before.claim.executionId, admissionId: before.claim.admissionId,
        authorityDigest: before.claim.authorityDigest, identityDigest: sha256Digest(before.claim.identity),
        effectiveDeadline: before.claim.effectiveDeadline,
        executionEvent: Object.freeze({ eventId: `event:native-complete:${sha256Digest(before.snapshot).slice(7)}`,
          kind: "completed" as const, occurredAt: new Date(before.snapshot.observedAt).toISOString() }),
        verifyCurrent(expected: string): true {
          try {
            if (![before.retainedDigest, afterDigest].includes(expected) || performance.now() >= deadline) fail();
            const value = current(signal, { before: before.claim, afterDigest });
            if (value.retainedDigest !== expected || value.digest !== before.digest || performance.now() >= deadline) fail();
            return true;
          } catch { closed = true; fail(); }
        } });
      return Object.freeze({ evidenceDigest: before.digest, grantsExecutionAuthority: false as const,
        releasesCapacity: false as const, assertFresh, confirmation });
    } catch { closed = true; fail(); }
  } });
}
