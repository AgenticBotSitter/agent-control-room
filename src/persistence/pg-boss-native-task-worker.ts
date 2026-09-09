import { MAX_NATIVE_UNSENT_RECOVERIES, nativeTaskSubmissionReferenceSchema, type NativeTaskSubmissionReference } from "./native-task-submission";
import { assertPgBossNativeQueue, nativeTaskSubmissionId, PG_BOSS_NATIVE_SUBMISSION } from "./pg-boss-native-task-submission";
import { startPgBossBoundedWorker, type BoundedDeliveryDisposition, type BoundedDeliveryHandler,
  type BoundedRecoveryVerifier, type PgBossBoundedWorkerClient } from "./pg-boss-bounded-worker";

export type NativeDeliveryDisposition = BoundedDeliveryDisposition;
export type NativeTaskDeliveryHandler = BoundedDeliveryHandler<NativeTaskSubmissionReference>;
export type NativeTaskRecoveryVerifier = BoundedRecoveryVerifier<NativeTaskSubmissionReference>;
export type PgBossNativeWorkerClient = PgBossBoundedWorkerClient;

/** Native-only wrapper preserves its exact reference, queue, recovery and error contract.
 * Delivery must revalidate canonical authority and record delivery/hold before returning. */
export function startPgBossNativeTaskWorker(client: PgBossNativeWorkerClient, input: {
  concurrency?: number; deliver: NativeTaskDeliveryHandler; verifyRecovery?: NativeTaskRecoveryVerifier;
}) {
  return startPgBossBoundedWorker(client, {
    name: PG_BOSS_NATIVE_SUBMISSION.name, maximumRecoveries: MAX_NATIVE_UNSENT_RECOVERIES,
    parse: value => nativeTaskSubmissionReferenceSchema.parse(value), identify: nativeTaskSubmissionId,
    assertQueue: assertPgBossNativeQueue,
    errors: { unresolved: "native_task_delivery_unresolved", config: "native_task_worker_config_invalid", close: "native_task_worker_close_uncertain" },
  }, input);
}
