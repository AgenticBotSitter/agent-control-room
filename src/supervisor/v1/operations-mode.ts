export type SupervisorOperationsPauseReceiptV1 = Readonly<{
  state: "paused" | "already_paused";
  receiptId: string;
}>;

/** Integration seam for cook/pause. Implementations must use the server-side
 * operations-mode service; this port never writes an operations record itself. */
export interface SupervisorOperationsModePortV1 {
  pauseNewStarts(input: Readonly<{ reasonCode: "machine_health_failed"; observedAt: string }> ):
    Promise<SupervisorOperationsPauseReceiptV1>;
}

export type SupervisorRunModeV1 = "running" | "paused" | "draining" | "stopped";

/** Read-only integration seam for bounded unattended tools. The source remains
 * server-owned in production; a tool may observe the mode but cannot grant
 * itself permission to resume. */
export interface SupervisorRunModePortV1 {
  read(): SupervisorRunModeV1 | Promise<SupervisorRunModeV1>;
}

export type SupervisorRunModeDecisionV1 = "start" | "pause" | "drain" | "stop";

/** Translate the shared operations vocabulary into a start-boundary decision.
 * Drain never starts another unit. Stop and pause are also fail-closed. */
export function supervisorRunModeDecisionV1(mode: SupervisorRunModeV1): SupervisorRunModeDecisionV1 {
  if (mode === "running") return "start";
  if (mode === "paused") return "pause";
  if (mode === "draining") return "drain";
  return "stop";
}
