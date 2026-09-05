import { sha256Digest } from "../../security";
import { verifyArtifactSignature } from "../../node-policy/v1/crypto";
import type { SqliteEffectClaimStore } from "../../node-policy/v1/effect-claim-store";
import type { SqliteExecutionStateStore } from "../../node-policy/v1/execution-state-store";
import { bindingSchema, enrollmentSchema, snapshotSchema,
  type NativeAuthority, type NativeBinding, type NativeEnrollment, type NativeRunJournal, type NativeOperation } from "./contracts";

import { nativeRecoveryPermissionSchema } from "../v1/native-approval-packet";
export { nativeRecoveryPermissionSchema, nativeRecoveryPermissionBodySchema, type NativeRecoveryPermissionBody } from "../v1/native-approval-packet";
export type NativeRecoveryCurrent = {
  approvalKey: { keyId: string; publicKeySpki: string };
  credentialAvailable: boolean;
  /** Trusted current owner cleanup policy/revocation result, independent of expired work permission. */
  recoveryAllowed: boolean;
  /** Verified compositions fence owner trust/local policy across profile and controller awaits. */
  assertFresh?: () => void;
};
export type NativeRecoveryDependencies = {
  readCurrent: (signal: AbortSignal) => Promise<NativeRecoveryCurrent>;
  assertProfileCurrent: (enrollment: Readonly<NativeEnrollment>, now: number, signal: AbortSignal) => Promise<void | (() => void)>;
  journal: Pick<NativeRunJournal, "load">;
  effects: Pick<SqliteEffectClaimStore, "load">;
  executions: Pick<SqliteExecutionStateStore, "load">;
  clock?: () => number; checkMs?: number;
};
const unavailable = (): never => { throw new Error("native_recovery_authority_unavailable"); };

/** Inert, exact-known-run status/stop permission. Does not extend work authority or settle effects.
 * The separately signed permission must precede admission; there is no signer or default trust source.
 */
export function createNativeRecoveryAuthority(config: { enrollment: unknown; binding: unknown; permission: unknown }, deps: NativeRecoveryDependencies) {
  const enrollment = Object.freeze(enrollmentSchema.parse(config.enrollment)), binding = bindingSchema.parse(config.binding);
  const permission = nativeRecoveryPermissionSchema.parse(config.permission), digest = sha256Digest(binding), body = permission.body;
  if (binding.enrollmentDigest !== sha256Digest(enrollment) || binding.tenantId !== enrollment.tenantId
    || binding.nodeId !== enrollment.nodeId || body.bindingDigest !== digest || body.issuedAt >= binding.deadline
    || body.expiresAt <= body.issuedAt || body.expiresAt > Math.min(enrollment.validUntil, binding.deadline + 300_000)) unavailable();
  const checkMs = deps.checkMs ?? 5000;
  if (!Number.isSafeInteger(checkMs) || checkMs < 1 || checkMs > 5000) unavailable();
  const read = deps.readCurrent.bind(deps), profile = deps.assertProfileCurrent.bind(deps), clock = deps.clock ?? Date.now;
  const journal = deps.journal.load.bind(deps.journal), effects = deps.effects.load.bind(deps.effects), executions = deps.executions.load.bind(deps.executions);
  let closed = false, highWater = -1, active = 0;
  const pending = new Set<AbortController>();
  function time() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < highWater) return unavailable();
    highWater = now; return now;
  }
  function live(current: NativeBinding) {
    if (closed || sha256Digest(bindingSchema.parse(current)) !== digest || time() < body.issuedAt
      || time() >= Math.min(body.expiresAt, enrollment.validUntil)) unavailable();
  }
  function durable() {
    const raw = journal(binding.runId); if (!raw) return unavailable();
    const run = snapshotSchema.parse(raw), claim = effects(binding.effectClaimKey);
    if (sha256Digest(run.binding) !== digest || !run.nativeRunId || !claim || claim.kind !== "full"
      || !claim.snapshot.markerDigest || !["executing", "ambiguous"].includes(claim.snapshot.state)) return unavailable();
    const c = claim.snapshot, execution = executions(c.executionId);
    const identity = { tenantId: binding.tenantId, nodeId: binding.nodeId, projectId: binding.projectId,
      jobId: binding.jobId, attemptId: binding.attemptId, operationDigest: binding.operationDigest };
    if (sha256Digest(c.identity) !== sha256Digest(identity) || c.claimKey !== binding.effectClaimKey
      || c.effectiveDeadline !== new Date(binding.deadline).toISOString() || body.issuedAt > Date.parse(c.createdAt)
      || !execution || body.issuedAt > Date.parse(execution.createdAt) || execution.state === "admitted" || sha256Digest(execution.identity) !== sha256Digest(identity)
      || execution.authorityDigest !== c.authorityDigest || execution.deadline.effectiveDeadline !== c.effectiveDeadline) unavailable();
  }
  const authority: NativeAuthority = Object.freeze({
    async markStart() { return unavailable(); },
    async check(operation: NativeOperation, current: NativeBinding) {
      if (operation !== "status" && operation !== "stop") return unavailable();
      live(current); if (active >= 8) return unavailable(); active++;
      const controller = new AbortController(); pending.add(controller);
      let timer: ReturnType<typeof setTimeout> | undefined, started = false;
      try {
        const deadline = Math.min(time() + checkMs, body.expiresAt, enrollment.validUntil);
        const work = (async () => {
          const { assertFresh, ...observed } = await read(controller.signal);
          const trust = structuredClone(observed);
          if (controller.signal.aborted) return unavailable(); live(current);
          if (trust.credentialAvailable !== true || trust.recoveryAllowed !== true
            || trust.approvalKey.keyId !== body.approvalKeyId
            || !verifyArtifactSignature(permission, trust.approvalKey.publicKeySpki)) return unavailable();
          const profileFresh = await profile(enrollment, time(), controller.signal);
          if (controller.signal.aborted || time() >= deadline) return unavailable();
          live(current); profileFresh?.(); assertFresh?.(); durable();
          return () => { profileFresh?.(); assertFresh?.(); };
        })();
        started = true; void work.then(() => { active--; }, () => { active--; });
        const assertFresh = await Promise.race([work, new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("native_recovery_authority_unavailable")), { once: true });
          timer = setTimeout(() => controller.abort(), Math.max(1, deadline - time()));
        })]);
        if (controller.signal.aborted || time() >= deadline) return unavailable();
        live(current); assertFresh?.(); durable();
      } catch { return unavailable(); }
      finally { clearTimeout(timer); controller.abort(); pending.delete(controller); if (!started) active--; }
    },
  });
  return Object.freeze({ authority, close() { closed = true; for (const controller of pending) controller.abort(); } });
}

/** No fallback from failed permission checks: observations/stops always use their explicit permission. */
export function composeNativeRunAuthority(start: NativeAuthority, recovery: NativeAuthority): NativeAuthority {
  const startCheck = start.check.bind(start), recoveryCheck = recovery.check.bind(recovery), mark = start.markStart.bind(start);
  return Object.freeze({ check: (operation: NativeOperation, binding: NativeBinding) => operation === "status" || operation === "stop"
    ? recoveryCheck(operation, binding) : startCheck(operation, binding), markStart: mark });
}
