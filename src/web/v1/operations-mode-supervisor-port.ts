import { createHash } from "node:crypto";
import type { SupervisorOperationsModePortV1, SupervisorOperationsPauseReceiptV1 } from "../../supervisor/v1/operations-mode";
import type { OperationsModeReceiptV1 } from "./operations-mode-wire";

/** The machine-health reason is a fixed, non-secret phrase. It is recorded
 * verbatim in the installation's append-only history next to the owner's own
 * decisions, so the owner can later see why the installation paused itself. */
export const OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1 =
  "Paused automatically: this machine failed a health check.";

/** The one thing the supervisor may ask of the server-owned mode. It is the
 * narrowest surface that still lets a health check stop new starts: there is no
 * resume here, because a machine that failed a health check must not be able to
 * put itself back to running. Only the owner resumes. */
export type OperationsModePauseTargetV1 = Readonly<{
  pauseForMachineHealth(reason: string): Promise<OperationsModeReceiptV1>;
}>;

/**
 * Connects the supervisor's `SupervisorOperationsModePortV1` to the
 * server-owned operations mode, so a failed machine-health check pauses new
 * starts through exactly the same authenticated, append-only, owner-guarded
 * record the owner writes from the Home control.
 *
 * The port never writes an operations record itself — that is the property
 * cook/superv's own comment demands of it, and it is why this adapter exists
 * rather than the supervisor reaching for the service directly.
 *
 * `already_paused` covers every non-running mode, not just `paused`: from the
 * supervisor's point of view the thing it wanted (new starts refused) already
 * holds, and re-writing the reason would replace the owner's own recorded
 * decision with a machine's.
 *
 * A failure to pause is surfaced as a thrown error, which is what
 * `SupervisorWatchdogV1` already handles by opening an
 * `operations_pause_unavailable` incident. Swallowing it here would turn a
 * broken pause into a silently unprotected installation.
 */
export function createOperationsModeSupervisorPortV1(input: Readonly<{
  target: OperationsModePauseTargetV1;
}>): SupervisorOperationsModePortV1 {
  if (!input || !input.target || typeof input.target.pauseForMachineHealth !== "function")
    throw new Error("operations_mode_supervisor_port_invalid");
  return Object.freeze({
    async pauseNewStarts(request: Readonly<{ reasonCode: "machine_health_failed"; observedAt: string }>):
      Promise<SupervisorOperationsPauseReceiptV1> {
      // A receipt id that is derived from the health observation, not random:
      // two cycles observing the same failure at the same instant produce the
      // same id, so a duplicated cycle is visibly a duplicate in the record.
      const receiptId = `supervisor-pause:${createHash("sha256").update(
        `${request.reasonCode}:${request.observedAt}`).digest("hex").slice(0, 32)}`;
      const receipt = await input.target.pauseForMachineHealth(OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1);
      return Object.freeze({ state: receipt.replayed ? "already_paused" as const : "paused" as const, receiptId });
    },
  });
}
