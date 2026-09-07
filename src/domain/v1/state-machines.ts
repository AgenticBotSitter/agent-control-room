import type {
  ApprovalState,
  ArtifactState,
  AttemptState,
  CheckpointState,
  EffectIntentState,
  IncidentState,
  JobState,
  LeaseState,
  NodeState,
  RequestState,
  ScheduleState,
  ServiceState,
  WorkflowState,
} from "./types";

export type TransitionTable<TState extends string> = Readonly<Record<TState, readonly TState[]>>;

export const requestTransitions: TransitionTable<RequestState> = {
  draft: ["submitted", "cancelled"],
  submitted: ["accepted", "rejected", "cancelled"],
  accepted: ["fulfilled", "cancelled"],
  fulfilled: [],
  rejected: [],
  cancelled: [],
};

export const workflowTransitions: TransitionTable<WorkflowState> = {
  proposed: ["active", "cancelled"],
  active: ["paused", "succeeded", "failed", "cancelled"],
  paused: ["active", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const jobTransitions: TransitionTable<JobState> = {
  proposed: ["ready", "rejected", "cancelled"],
  ready: ["leased", "cancelled"],
  leased: ["running", "ready", "cancelled", "orphaned"],
  running: ["waiting_approval", "succeeded", "failed", "cancelled", "orphaned"],
  waiting_approval: ["running", "cancelled", "failed", "orphaned"],
  failed: ["ready"],
  orphaned: ["ready", "failed", "cancelled"],
  succeeded: [],
  cancelled: [],
  rejected: [],
};

export const attemptTransitions: TransitionTable<AttemptState> = {
  offered: ["leased", "cancelled"],
  leased: ["running", "cancelled", "orphaned"],
  running: ["waiting", "succeeded", "failed", "cancelled", "orphaned"],
  waiting: ["running", "succeeded", "failed", "cancelled", "orphaned"],
  succeeded: [],
  failed: [],
  cancelled: [],
  orphaned: [],
};

export const leaseTransitions: TransitionTable<LeaseState> = {
  active: ["expired", "released", "revoked"],
  expired: [],
  released: [],
  revoked: [],
};

export const checkpointTransitions: TransitionTable<CheckpointState> = {
  declared: ["stored", "rejected"],
  stored: ["verified", "rejected"],
  verified: [],
  rejected: [],
};

export const effectIntentTransitions: TransitionTable<EffectIntentState> = {
  proposed: ["authorized", "cancelled"],
  authorized: ["executing", "cancelled"],
  executing: ["confirmed", "failed", "ambiguous"],
  ambiguous: ["confirmed", "failed", "cancelled"],
  confirmed: [],
  failed: [],
  cancelled: [],
};

export const approvalTransitions: TransitionTable<ApprovalState> = {
  pending: ["approved", "denied", "expired"],
  approved: ["revoked"],
  denied: [],
  expired: [],
  revoked: [],
};

export const serviceTransitions: TransitionTable<ServiceState> = {
  active: ["degraded", "paused", "failed", "retired"],
  degraded: ["active", "paused", "failed", "retired"],
  paused: ["active", "retired"],
  failed: ["active", "retired"],
  retired: [],
};

export const scheduleTransitions: TransitionTable<ScheduleState> = {
  active: ["paused", "disabled"],
  paused: ["active", "disabled"],
  disabled: [],
};

export const incidentTransitions: TransitionTable<IncidentState> = {
  open: ["acknowledged", "mitigating", "resolved"],
  acknowledged: ["mitigating", "resolved"],
  mitigating: ["resolved"],
  resolved: ["open", "closed"],
  closed: [],
};

export const artifactTransitions: TransitionTable<ArtifactState> = {
  declared: ["uploaded", "quarantined", "rejected"],
  uploaded: ["verified", "quarantined", "rejected"],
  verified: ["quarantined", "deleted"],
  quarantined: ["verified", "rejected", "deleted"],
  rejected: ["deleted"],
  deleted: [],
};

export const nodeTransitions: TransitionTable<NodeState> = {
  pending_enrollment: ["active", "revoked"],
  active: ["draining", "offline", "quarantined", "revoked"],
  draining: ["active", "offline", "quarantined", "revoked"],
  offline: ["active", "quarantined", "revoked"],
  quarantined: ["active", "revoked"],
  revoked: [],
};

export function canTransition<TState extends string>(
  table: TransitionTable<TState>,
  from: TState,
  to: TState,
): boolean {
  return table[from].includes(to);
}

export function assertTransition<TState extends string>(
  name: string,
  table: TransitionTable<TState>,
  from: TState,
  to: TState,
): void {
  if (!canTransition(table, from, to)) {
    throw new Error(`Illegal ${name} transition: ${from} -> ${to}`);
  }
}
