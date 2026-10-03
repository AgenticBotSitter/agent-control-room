import type { TaskPage } from "../../src/web/v1/task-wire";

/** Shared by rendered status and the guide contract. */
export const ownerStatusLabels = Object.freeze({
  task: Object.freeze({
    proposed: "Proposal saved", ready: "Ready for assignment", leased: "Assigned", running: "In progress",
    waiting_approval: "Waiting for approval", succeeded: "Completed", failed: "Job failed", cancelled: "Job cancelled",
    orphaned: "Assignment lost", rejected: "Proposal rejected",
  } satisfies Record<TaskPage["tasks"][number]["state"], string>),
  taskOutcome: Object.freeze({ accepted: "Completed · Accepted", ownerRejected: "Rejected by you" }),
  operations: Object.freeze({ running: "Running", paused: "Paused", draining: "Draining", stopped: "Stopped" }),
  fleet: Object.freeze({ working: "Working", connected: "Connected", offline: "Offline",
    revoked: "Removed", needs_new_key: "Needs a new key", blocked: "Blocked" }),
  worker: Object.freeze({ working: "Working", online: "Online — workload unknown", idle: "Idle", offline: "Offline",
    stuck: "Stuck", lastSeen: "Last seen", lastSeenUnknown: "Last seen unknown" }),
  attention: Object.freeze({ clear: "All clear.", refreshFailed: "Couldn’t refresh — showing the last known state." }),
  updater: Object.freeze({ off: "Self-update: Off" }),
  cost: Object.freeze({ unknown: "Unknown", subscription: "Included in subscription" }),
});
