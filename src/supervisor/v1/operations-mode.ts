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
