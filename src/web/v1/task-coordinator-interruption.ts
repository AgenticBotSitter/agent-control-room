/** Internal lifecycle/budget failures must never be downgraded to per-result failures. */
export class TaskCoordinatorInterruption extends Error {
  constructor(message: "task_quality_unavailable" | "task_coordinator_unavailable" | "task_coordinator_session_closed" | "task_coordinator_save_uncertain") {
    super(message);
  }
}
