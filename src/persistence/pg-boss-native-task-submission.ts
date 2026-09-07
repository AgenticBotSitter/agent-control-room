import type { DatabaseSession } from "./database";
import { MAX_NATIVE_UNSENT_RECOVERIES, nativeTaskSubmissionReferenceSchema, type NativeTaskSubmissionReference } from "./native-task-submission";
import { sha256Digest } from "../security";
import { preparePgBossBoundedSubmission, type PgBossBoundedSubmissionClient, type PgBossBoundedSubmissionConstructor } from "./pg-boss-bounded-submission";

export const PG_BOSS_NATIVE_SUBMISSION = Object.freeze({
  packageVersion: "12.30.0", schema: "control_room_queue", name: "native-task-delivery", table: "job_common",
});
export type PgBossSubmissionClient = PgBossBoundedSubmissionClient<NativeTaskSubmissionReference>;
export type PgBossSubmissionConstructor = PgBossBoundedSubmissionConstructor<NativeTaskSubmissionReference>;
const unavailable = (): never => { throw new Error("native_task_submission_unavailable"); };

export function nativeTaskSubmissionId(value: NativeTaskSubmissionReference): string {
  const reference = nativeTaskSubmissionReferenceSchema.parse(value);
  const queueId = `native-queue:${sha256Digest({ tenantId: reference.tenantId, jobId: reference.jobId, attemptId: reference.attemptId }).slice(7)}`;
  if (reference.queueId !== queueId) return unavailable();
  // Operational UUID, not permanent canonical replay authority.
  const hex = sha256Digest({ purpose: "pg-boss-native-submission/v1", tenantId: reference.tenantId, queueId }).slice(7);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function assertPgBossNativeQueue(value: unknown): void {
  if (!value || typeof value !== "object") unavailable();
  const q = value as Record<string, unknown>;
  if (q.name !== PG_BOSS_NATIVE_SUBMISSION.name || q.table !== PG_BOSS_NATIVE_SUBMISSION.table
    || q.policy !== "standard" || q.partition !== false || q.retryLimit !== 0 || q.deadLetter != null || q.notify !== false) unavailable();
}
/** Exact native profile; shared submission preserves same-session metadata and INSERTs. */
export function preparePgBossNativeTaskSubmission(PgBoss: PgBossSubmissionConstructor, database: DatabaseSession,
  options: { backend: "postgres" | "pglite"; recovery?: true } = { backend: "postgres" }) {
  return preparePgBossBoundedSubmission(PgBoss, database, { name: PG_BOSS_NATIVE_SUBMISSION.name,
    maximumRecoveries: MAX_NATIVE_UNSENT_RECOVERIES, unavailableCode: "native_task_submission_unavailable",
    parse: value => nativeTaskSubmissionReferenceSchema.parse(value), identify: nativeTaskSubmissionId, assertQueue: assertPgBossNativeQueue,
  }, options);
}
