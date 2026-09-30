import { startSupervisorLoopV1, type SupervisorLoopHandleV1 } from "../../supervisor/v1/loop";
import { OwnerPushDispatcherV1, type OwnerPushDispatchOutcomeV1 } from "./dispatcher";
import type { OwnerNotificationChannelV1, OwnerPushStoreV1 } from "./types";
import type { DatabaseClient } from "../../persistence/database";

/** How often the dispatcher looks for due work. Matches the supervisor's own 30 s
 * cycle, so a push never lands meaningfully later than the stall that caused it. */
export const OWNER_PUSH_DISPATCH_INTERVAL_MS_V1 = 30_000;

/**
 * The owner phone alert loop (MIG-I, plan v4.3 §2.11).
 *
 * A Needs-you item -- the second lease lapse on a job, or a service incident --
 * becomes a web-push to the owner's phone, with bounded retry, exactly once per
 * item, surviving a host restart.
 *
 * It reuses the existing push channel, delivery ledger (0174) and subscription
 * tables (0173-0176) rather than a second notification system. The only new
 * durable object is the per-item retry head (0224).
 *
 * The loop is the SAME reviewed one the supervisor uses: one verified cycle
 * before returning, then no overlap, a failed cycle reported and retried by the
 * next tick, and a crash recoverable because every decision lives in the
 * database rather than in this process. A dispatcher that failed is not
 * retried in-process from memory -- it re-reads its due rows on the next tick,
 * and a row left 'reserved' by a killed process is recovered by
 * `recoverStaleReservations`.
 *
 * `toleratesFirstCycleFailure` is on, as it is for the supervisor: a busy
 * machine at startup must not fail the host's startup path because the push
 * service happened to be down at that instant. The item is still in the inbox and
 * still undelivered, and the next tick picks it up.
 */
export function startOwnerPushLoopV1(input: Readonly<{
  db: DatabaseClient;
  tenantId: string;
  store: OwnerPushStoreV1;
  channel: OwnerNotificationChannelV1;
  intervalMs?: number;
  clock?: () => number;
  report?: (error: unknown) => void;
}>): Promise<SupervisorLoopHandleV1> {
  if (!input || !input.db || typeof input.db.query !== "function" || typeof input.db.transaction !== "function"
    || !input.store || typeof input.store.list !== "function"
    || !input.channel || typeof input.channel.send !== "function")
    throw new Error("owner_push_loop_input_invalid");
  const dispatcher = new OwnerPushDispatcherV1({ db: input.db, tenantId: input.tenantId,
    store: input.store, channel: input.channel, ...(input.clock ? { clock: input.clock } : {}) });
  const report = input.report ?? ((error: unknown) => {
    // A reason code only. A push endpoint URL, an HTTP body or a task text must
    // never reach the host log.
    const code = typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message).split("\n")[0]!.slice(0, 120)
      : "owner_push_cycle_failed";
    process.stderr.write(`owner_push_cycle_unavailable ${code}\n`);
  });
  return startSupervisorLoopV1({
    toleratesFirstCycleFailure: true,
    intervalMs: input.intervalMs ?? OWNER_PUSH_DISPATCH_INTERVAL_MS_V1,
    service: Object.freeze({ cycle: async () => {
      const outcomes: readonly OwnerPushDispatchOutcomeV1[] = await dispatcher.dispatch();
      return Object.freeze({ outcomes });
    } }),
    runtime: Object.freeze({ setInterval: (run, milliseconds) => setInterval(run, milliseconds),
      clearInterval: timer => clearInterval(timer), report }),
  });
}
