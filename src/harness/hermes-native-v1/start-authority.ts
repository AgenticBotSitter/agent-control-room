import { sha256Digest } from "../../security";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { computeAdmissionId, type SqliteLocalAdmissionStore } from "../../node-policy/v1/admission-store";
import { computeExecutionId, type ExecutionIdentityV1 } from "../../node-policy/v1/execution-authority";
import type { SqliteExecutionStateStore } from "../../node-policy/v1/execution-state-store";
import type { SqliteEffectClaimStore } from "../../node-policy/v1/effect-claim-store";
import { createPreEffectMarker } from "../../node-policy/v1/effect-claim";
import { evaluateLocalPolicy } from "../../node-policy/v1/policy-evaluator";
import { normalizedLocalPolicyRequestSchema } from "../../node-policy/v1/schemas";
import type { LocalPolicyEvaluationInputV1 } from "../../node-policy/v1/types";
import { bindingSchema, enrollmentSchema, startSchema, type NativeAuthority, type NativeBinding, type NativeEnrollment,
  type NativeOperation } from "./contracts";
import { verifyNativeTaskApprovalBinding } from "./task-approval-binding";

/** activeExternalEffects includes this effect once its durable claim is executing/ambiguous. */
export type NativeCurrentPolicy = Omit<LocalPolicyEvaluationInputV1, "request"> & {
  paused: boolean;
  /** Verified store compositions supply a synchronous fence across subsequent awaits. */
  assertFresh?: () => void;
};
export type NativeStartAuthorityDependencies = {
  /** Trusted local resolvers: verified owner ceiling and signed lease provenance are mandatory upstream.
   * These are not browser callbacks, reported capability flags or self-issued qualification evidence. */
  readCurrent: (signal: AbortSignal) => Promise<NativeCurrentPolicy>;
  assertProfileCurrent: (enrollment: Readonly<NativeEnrollment>, now: number, signal: AbortSignal) => Promise<void | (() => void)>;
  admissions: Pick<SqliteLocalAdmissionStore, "record" | "findEquivalent">;
  executions: Pick<SqliteExecutionStateStore, "create" | "load" | "apply">;
  effects: Pick<SqliteEffectClaimStore, "claim" | "load" | "commitPreEffectMarker" | "recover">;
  clock?: () => number; checkMs?: number;
};
const denied = (): never => { throw new Error("native_start_authority_unavailable"); };

/** One exact native start and live-deadline observation authority. No credentials, SQL connections,
 * journals, listeners or transport are opened here. Supplied stores remain owned by the caller.
 * Stop and post-deadline observation need separate typed recovery authority and are denied here.
 */
export function createNativeStartAuthority(config: { enrollment: unknown; request: unknown; start: unknown }, input: NativeStartAuthorityDependencies) {
  const enrollment = Object.freeze(enrollmentSchema.parse(config.enrollment));
  const request = normalizedLocalPolicyRequestSchema.parse(config.request), start = startSchema.parse(config.start);
  if (!request.approval) throw new Error("native_start_authority_config_invalid");
  const { binding } = verifyNativeTaskApprovalBinding(enrollment, request, start);
  const bindingDigest = sha256Digest(binding), requestDigest = sha256Digest(request);
  const identity: ExecutionIdentityV1 = { tenantId: request.tenantId, nodeId: request.nodeId, projectId: request.projectId,
    jobId: request.jobId, attemptId: request.attemptId, operationDigest: request.operationDigest };
  const checkMs = input.checkMs ?? 5000;
  if (!Number.isSafeInteger(checkMs) || checkMs < 1 || checkMs > 5000) throw new Error("native_start_authority_config_invalid");
  const readCurrent = input.readCurrent.bind(input), profileCurrent = input.assertProfileCurrent.bind(input), clock = input.clock ?? Date.now;
  const admissions = { record: input.admissions.record.bind(input.admissions), find: input.admissions.findEquivalent.bind(input.admissions) };
  const executions = { create: input.executions.create.bind(input.executions), load: input.executions.load.bind(input.executions), apply: input.executions.apply.bind(input.executions) };
  const effects = { claim: input.effects.claim.bind(input.effects), load: input.effects.load.bind(input.effects),
    mark: input.effects.commitPreEffectMarker.bind(input.effects), recover: input.effects.recover.bind(input.effects) };
  let phase: "fresh" | "marking" | "marked" | "uncertain" | "closed" = "fresh", highWater = -1, active = 0;
  let ownMarker: string | undefined, ownExecution: string | undefined;
  const pending = new Set<AbortController>();
  function time() {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < highWater) return denied();
    highWater = now; return now;
  }
  function live(current: NativeBinding) {
    if (phase === "closed" || phase === "uncertain" || sha256Digest(bindingSchema.parse(current)) !== bindingDigest
      || time() >= Math.min(binding.deadline, enrollment.validUntil)) denied();
  }
  async function currentPolicy(current: NativeBinding) {
    live(current); if (active >= 8) return denied(); active++;
    const controller = new AbortController(); pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    try {
      const deadline = Math.min(binding.deadline, enrollment.validUntil, time() + checkMs);
      const operation = (async () => {
        // Copy resolver output before another await; nobody can mutate an already-read decision input.
        const { assertFresh, ...observed } = await readCurrent(controller.signal);
        const policy = structuredClone(observed);
        if (controller.signal.aborted) return denied(); live(current);
        const profileFresh = await profileCurrent(enrollment, time(), controller.signal);
        if (controller.signal.aborted || time() >= deadline) return denied(); live(current);
        const freshness = () => {
          if (profileFresh !== undefined) assertSynchronousFence(profileFresh, denied);
          if (assertFresh !== undefined) assertSynchronousFence(assertFresh, denied);
        };
        freshness();
        const now = time(), at = new Date(now).toISOString();
        if (policy.paused !== false) return denied();
        const existing = effects.load(binding.effectClaimKey);
        const alreadyCounted = existing?.kind === "full" && existing.snapshot.markerDigest
          && ["executing", "ambiguous"].includes(existing.snapshot.state)
          && sha256Digest(existing.snapshot.identity) === sha256Digest(identity);
        // Rechecking an admitted effect is not a second concurrency reservation. The trusted count
        // includes this already-durable claim; subtract only the exact verified active claim.
        const activeExternalEffects = policy.activeExternalEffects - (alreadyCounted ? 1 : 0);
        const decision = evaluateLocalPolicy({ ...policy, activeExternalEffects, request }, { now: () => at });
        if (!decision.accepted) return denied();
        // Never let the native task outlive narrower local ceiling or owner-approval authority.
        if (binding.deadline > Math.min(Date.parse(policy.lease.expiresAt), Date.parse(policy.lease.authority.expiresAt),
          Date.parse(request.approval!.body.expiresAt), now + policy.ceiling.maxDurationSeconds * 1000,
          now + policy.lease.authority.maxDurationSeconds * 1000)) return denied();
        return { policy, decision, now, at, assertFresh: freshness };
      })();
      started = true;
      // Cancellation is advisory. An unresolved resolver retains its slot even after the caller
      // times out; release only when the underlying work actually settles, handling both outcomes.
      void operation.then(() => { active--; }, () => { active--; });
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        const abort = () => reject(new Error("native_start_authority_unavailable"));
        controller.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => controller.abort(), Math.max(1, deadline - time()));
      })]);
    } catch { return denied(); }
    finally { clearTimeout(timer); controller.abort(); pending.delete(controller); if (!started) active--; }
  }
  function markedClaim() {
    const claim = effects.load(binding.effectClaimKey);
    if (!claim || claim.kind !== "full" || !claim.snapshot.markerDigest || claim.snapshot.claimKey !== binding.effectClaimKey
      || sha256Digest(claim.snapshot.identity) !== sha256Digest(identity)
      || claim.snapshot.identity.operationDigest !== request.operationDigest || claim.snapshot.authorityDigest !== request.authorityDigest
      || claim.snapshot.effectiveDeadline !== new Date(binding.deadline).toISOString()) return denied();
    const execution = executions.load(claim.snapshot.executionId);
    if (!execution || !["executing", "expiring_soon"].includes(execution.state)
      || sha256Digest(execution.identity) !== sha256Digest(identity) || execution.authorityDigest !== request.authorityDigest
      || execution.leaseEpoch !== request.leaseEpoch || execution.deadline.effectiveDeadline !== claim.snapshot.effectiveDeadline) return denied();
    return claim.snapshot;
  }
  function quarantine(ownsClaim: boolean) {
    if (phase !== "closed") phase = "uncertain";
    if (ownsClaim) {
      try { effects.recover(binding.effectClaimKey, `event:native-uncertain:${binding.effectClaimKey.slice(7)}`, new Date(time()).toISOString()); }
      catch { /* Storage uncertainty stays quarantined; never retry the marker or a native request. */ }
    }
  }
  const authority: NativeAuthority = Object.freeze({
    async check(operation: NativeOperation, current: NativeBinding) {
      try {
        if (!["capabilities", "start", "status", "events"].includes(operation)) return denied();
        const result = await currentPolicy(current); live(current); result.assertFresh?.();
        if (operation === "status" || operation === "events") { markedClaim(); return; }
        if (phase === "fresh") { if (effects.load(binding.effectClaimKey)) denied(); return; }
        if (phase !== "marked" || operation !== "start") return denied();
        const claim = markedClaim(), execution = ownExecution ? executions.load(ownExecution) : undefined;
        if (claim.state !== "executing" || claim.markerDigest !== ownMarker || !execution || execution.state !== "executing"
          || execution.leaseEpoch !== request.leaseEpoch || execution.authorityDigest !== request.authorityDigest) denied();
      } catch { if (operation === "start" && ownMarker) quarantine(true); return denied(); }
    },
    async markStart(current: NativeBinding) {
      if (phase !== "fresh") return denied();
      phase = "marking";
      let ownsClaim = false;
      try {
        const { policy, decision, at, assertFresh } = await currentPolicy(current); live(current); assertFresh?.();
        if (effects.load(binding.effectClaimKey)) return denied();
        // Reuse identical admission evidence only; never reuse a prior execution or marked claim.
        const prior = admissions.find(identity, requestDigest, decision.ceilingDigest, decision.authorityDigest);
        const recorded = prior?.decision ?? decision;
        if (!recorded.accepted) return denied();
        const admissionId = computeAdmissionId(identity, recorded), executionId = computeExecutionId(admissionId, request.operationDigest);
        if (executions.load(executionId)) return denied();
        admissions.record({ messageId: `message:native-admission:${binding.effectClaimKey.slice(7)}`, identity,
          decision: recorded, recordedAt: prior?.recordedAt ?? at });
        const deadlineSources = { admittedAt: at, ceilingDurationSeconds: policy.ceiling.maxDurationSeconds,
          authorityDurationSeconds: policy.lease.authority.maxDurationSeconds, authorityExpiresAt: policy.lease.authority.expiresAt,
          leaseExpiresAt: policy.lease.expiresAt, approvalExpiresAt: request.approval!.body.expiresAt,
          reservationExpiresAt: new Date(binding.deadline).toISOString() };
        if (executions.create({ executionId, admissionId, identity, authorityDigest: request.authorityDigest,
          deadlineSources, leaseEpoch: request.leaseEpoch, createdAt: at }) !== "created") return denied();
        ownExecution = executionId; live(current);
        const execution = executions.apply(executionId, { eventId: `event:native-start:${binding.effectClaimKey.slice(7)}`,
          kind: "start", occurredAt: at }).snapshot;
        const claimed = effects.claim({ messageId: `message:native-effect:${binding.effectClaimKey.slice(7)}`, execution, claimedAt: at,
          maximumActiveEffects: Math.min(policy.ceiling.maxConcurrentEffects, policy.lease.authority.maxConcurrentEffects) });
        if (!claimed.created || claimed.disposition !== "dispatch_permitted" || claimed.lookup.kind !== "full") return denied();
        ownsClaim = true; live(current);
        const marker = createPreEffectMarker({ markerId: `marker:native-start:${binding.effectClaimKey.slice(7)}`,
          claim: claimed.lookup.snapshot, request, authorityDigest: request.authorityDigest,
          effectiveDeadline: new Date(binding.deadline).toISOString(), markedAt: new Date(time()).toISOString() });
        const committed = effects.mark(marker);
        if (committed.disposition !== "committed" || committed.snapshot.state !== "executing"
          || committed.snapshot.markerDigest !== sha256Digest(marker)) return denied();
        live(current); ownMarker = committed.snapshot.markerDigest; phase = "marked";
      } catch {
        quarantine(ownsClaim);
        return denied();
      }
    },
  });
  return Object.freeze({ authority, close() { phase = "closed"; for (const controller of pending) controller.abort(); } });
}
