import { z } from "zod";
import { sha256Digest } from "../../security";
import { verifyArtifactSignature } from "../../node-policy/v1/crypto";
import { resolvePinnedApprovalKey, type PinnedApprovalTrustStore } from "../../node-policy/v1/pinned-approval-trust";
import type { SqliteNodeSecurityStateRepository } from "../../node-policy/v1/persistent-security-state";
import { enrollmentSchema, digestSchema, localId, type NativeEnrollment } from "./contracts";

const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeProfileAcceptanceBodySchema = z.object({
  schema: z.literal("control-room.native-profile-acceptance/v1"),
  // Excluding the acceptance's own digest avoids circular signing; all other enrollment fields bind.
  enrollment: enrollmentSchema.omit({ qualificationDigest: true }),
  nodeClass: localId, approvalKeyId: localId, issuedAt: instant, evidenceDigest: digestSchema,
  guarantees: z.object({ dedicatedProfile: z.literal(true), toolPolicyEnforced: z.literal(true),
    mcpPolicyEnforced: z.literal(true), pluginPolicyEnforced: z.literal(true), skillPolicyEnforced: z.literal(true),
    hardDeadlineEnforced: z.literal(true), filesystemIsolationEnforced: z.literal(true), networkIsolationEnforced: z.literal(true) }).strict(),
  bodyDigest: digestSchema,
}).strict();
export type NativeProfileAcceptanceBody = z.infer<typeof nativeProfileAcceptanceBodySchema>;
const acceptanceSchema = z.object({ body: nativeProfileAcceptanceBodySchema,
  signatureAlgorithm: z.literal("Ed25519"), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const snapshotSchema = z.object({ enrollmentDigest: digestSchema, profilePolicyDigest: digestSchema,
  qualificationDigest: digestSchema, revision: instant, observedAt: instant, validUntil: instant,
  state: z.enum(["active", "disabled"]), credentialAvailable: z.boolean() }).strict();
export type NativeSupervisedProfileSnapshot = z.infer<typeof snapshotSchema>;

/** Checks owner-accepted qualification; never conducts qualification or opens a profile/credential.
 * readSupervisedState must be the trusted node supervisor, not native capabilities or user input.
 */
export function createNativeProfileEvidence(config: { enrollment: unknown; acceptance: unknown }, deps: {
  approvals: PinnedApprovalTrustStore;
  security: Pick<SqliteNodeSecurityStateRepository, "currentServerTrustRevision">;
  readSupervisedState: () => NativeSupervisedProfileSnapshot;
  clock?: () => number;
}) {
  const enrollment = enrollmentSchema.parse(config.enrollment), acceptance = acceptanceSchema.parse(config.acceptance);
  const { qualificationDigest, ...identity } = enrollment, digest = sha256Digest(enrollment), body = acceptance.body;
  const scope = { tenantId: enrollment.tenantId, nodeId: enrollment.nodeId, nodeClass: body.nodeClass };
  if (sha256Digest(identity) !== sha256Digest(body.enrollment) || qualificationDigest !== sha256Digest(acceptance)
    || body.issuedAt >= enrollment.validUntil || sha256Digest(deps.approvals.binding()) !== sha256Digest(scope)) throw new Error("native_profile_evidence_invalid");
  const approvals = deps.approvals, revision = deps.security.currentServerTrustRevision.bind(deps.security),
    read = deps.readSupervisedState.bind(deps), clock = deps.clock ?? Date.now;
  let highTime = -1, highRevision = -1, lastSnapshot: string | undefined;
  const current = () => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < highTime) throw new Error();
    highTime = now;
    if (now < body.issuedAt || now >= enrollment.validUntil) throw new Error();
    const state = snapshotSchema.parse(read()), snapshotDigest = sha256Digest(state);
    if (state.enrollmentDigest !== digest || state.profilePolicyDigest !== enrollment.profilePolicyDigest
      || state.qualificationDigest !== qualificationDigest
      || state.validUntil <= state.observedAt || state.validUntil > enrollment.validUntil
      || state.revision < highRevision
      || (state.revision === highRevision && snapshotDigest !== lastSnapshot)) throw new Error();
    highRevision = state.revision; lastSnapshot = snapshotDigest;
    if (state.observedAt > now || state.validUntil <= now || state.state !== "active" || !state.credentialAvailable) throw new Error();
    approvals.assertAvailable();
    return sha256Digest({ state, trust: revision() });
  };
  return async (value: Readonly<NativeEnrollment>, now: number, signal: AbortSignal): Promise<() => void> => {
    const unavailable = () => { throw new Error("native_profile_evidence_unavailable"); };
    try {
      if (signal.aborted || sha256Digest(enrollmentSchema.parse(value)) !== digest
        || !Number.isSafeInteger(now) || now < body.issuedAt || now > clock()) return unavailable();
      const before = current(), key = await resolvePinnedApprovalKey(approvals, scope, body.approvalKeyId);
      if (signal.aborted || !key || !verifyArtifactSignature(acceptance, key.publicKeySpki)) return unavailable();
      const assertFresh = () => { try { if (current() !== before) return unavailable(); } catch { return unavailable(); } };
      assertFresh(); return assertFresh;
    } catch { return unavailable(); }
  };
}
