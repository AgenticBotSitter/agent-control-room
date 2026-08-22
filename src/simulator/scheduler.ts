import type {
  AuthorityMode,
  CapabilityRoute,
  ProjectSummaryProjection,
  WorkerProjection,
  WorkItemProjection,
} from "@/src/contracts/v1";

export interface RouteDecision {
  workItemId: string;
  selectedRouteId?: string;
  selectedWorkerId?: string;
  authorityAction: "assign" | "request_source_command" | "recommend_only" | "blocked";
  score?: number;
  estimatedDurationMinutes?: number;
  estimatedCostUsd?: number;
  explanation: string[];
  rejected: Array<{ routeId: string; reason: string }>;
}

export interface ScheduleCandidate {
  project: ProjectSummaryProjection;
  workItem: WorkItemProjection;
  projectShare: number;
  recentShareUsed: number;
}

export interface ScheduleDecision {
  selected?: ScheduleCandidate;
  explanation: string[];
  rejected: Array<{ workItemId: string; reason: string }>;
}

function capabilityMatches(required: string | undefined, route: CapabilityRoute): boolean {
  if (!required) return true;
  return route.capability === required || route.capability.startsWith(`${required}.`);
}

function actionFor(mode: AuthorityMode): RouteDecision["authorityAction"] {
  if (mode === "control_room_native") return "assign";
  if (mode === "source_scheduled") return "request_source_command";
  return "recommend_only";
}

export function chooseRoute(
  project: ProjectSummaryProjection,
  workItem: WorkItemProjection,
  workers: WorkerProjection[],
  override?: { pinnedWorkerId?: string; pinnedRouteId?: string },
): RouteDecision {
  const policy = workItem.placementPolicy;
  const rejected: RouteDecision["rejected"] = [];
  const candidates: Array<{
    worker: WorkerProjection;
    route: CapabilityRoute;
    score: number;
    reasons: string[];
  }> = [];

  for (const worker of workers) {
    for (const route of worker.capabilities) {
      if (!capabilityMatches(workItem.requiredCapability, route)) continue;

      const reject = (reason: string) => rejected.push({ routeId: route.id, reason });

      if (override?.pinnedWorkerId && worker.id !== override.pinnedWorkerId) {
        reject(`Operator simulation pinned ${override.pinnedWorkerId}.`);
        continue;
      }
      if (override?.pinnedRouteId && route.id !== override.pinnedRouteId) {
        reject(`Operator simulation pinned ${override.pinnedRouteId}.`);
        continue;
      }
      if (policy?.pinnedWorkerId && worker.id !== policy.pinnedWorkerId) {
        reject(`Work policy pins ${policy.pinnedWorkerId}.`);
        continue;
      }
      if (policy?.avoidedWorkerIds?.includes(worker.id)) {
        reject("Worker is excluded by placement policy.");
        continue;
      }
      if (policy?.allowedRouteIds?.length && !policy.allowedRouteIds.includes(route.id)) {
        reject("Route is not certified for this work item.");
        continue;
      }
      if (worker.state === "offline" || worker.state === "maintenance" || worker.state === "draining") {
        reject(`Worker is ${worker.state}.`);
        continue;
      }
      if (worker.availableSlots <= 0) {
        reject(worker.stateReason ?? "Worker has no available slot.");
        continue;
      }
      if (worker.allocationMode === "manual" && !override?.pinnedWorkerId) {
        reject("Worker requires an explicit operator assignment.");
        continue;
      }
      if (route.verification === "unavailable" || route.verification === "expired") {
        reject(`Route verification is ${route.verification}.`);
        continue;
      }
      if (route.verification === "provisional" && policy?.allowQualityFallback === false) {
        reject("Provisional quality is forbidden by work policy.");
        continue;
      }
      if (route.privacyClass === "approved_provider" && policy?.allowPaidProvider === false) {
        reject("Provider processing is not allowed for this work item.");
        continue;
      }
      const cost = route.estimatedCostUsd ?? 0;
      if (policy?.maxCostUsd !== undefined && cost > policy.maxCostUsd) {
        reject(`Estimated cost $${cost.toFixed(2)} exceeds the configured limit.`);
        continue;
      }

      const reasons: string[] = [];
      let score = 100;
      const duration = route.estimatedDurationMinutes ?? 60;
      score -= Math.min(duration, 180) * 0.22;
      score -= cost * 20;

      if (route.verification === "verified") {
        score += 16;
        reasons.push("verified route");
      } else {
        score -= 7;
        reasons.push("provisional route");
      }
      if (policy?.preferredWorkerIds?.includes(worker.id)) {
        score += 18;
        reasons.push("preferred worker");
      }
      if (worker.preferredProjectIds?.includes(project.id)) {
        score += 8;
        reasons.push("worker prefers this project");
      }
      if (route.privacyClass === "local") {
        score += 4;
        reasons.push("local processing");
      }
      if (worker.state === "idle") {
        score += 6;
        reasons.push("worker is idle");
      }
      if (override?.pinnedWorkerId || override?.pinnedRouteId) {
        score += 40;
        reasons.push("operator simulation override");
      }

      candidates.push({ worker, route, score, reasons });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.route.id.localeCompare(b.route.id));
  const selected = candidates[0];

  if (!selected) {
    return {
      workItemId: workItem.id,
      authorityAction: "blocked",
      explanation: [
        "No currently eligible route satisfies capability, policy, verification, availability, and cost constraints.",
      ],
      rejected,
    };
  }

  const authorityAction = actionFor(project.authorityMode);
  const explanation = [
    `${selected.worker.displayName} via ${selected.route.runtime} is the highest eligible route.`,
    `Estimated duration is ${selected.route.estimatedDurationMinutes ?? "unknown"} minutes at $${(selected.route.estimatedCostUsd ?? 0).toFixed(2)} estimated incremental cost.`,
    `Selection factors: ${selected.reasons.join(", ")}.`,
  ];

  if (authorityAction === "request_source_command") {
    explanation.push("Content Blooms remains lease authority; Control Room would request this preference rather than assigning the job directly.");
  } else if (authorityAction === "recommend_only") {
    explanation.push("This adapter is advisory, so the result is a recommendation only.");
  } else {
    explanation.push("This project delegates scheduling authority to Control Room, so the route may be assigned at a safe boundary.");
  }

  return {
    workItemId: workItem.id,
    selectedRouteId: selected.route.id,
    selectedWorkerId: selected.worker.id,
    authorityAction,
    score: Math.round(selected.score * 10) / 10,
    estimatedDurationMinutes: selected.route.estimatedDurationMinutes,
    estimatedCostUsd: selected.route.estimatedCostUsd ?? 0,
    explanation,
    rejected,
  };
}

export function chooseNextProjectWork(candidates: ScheduleCandidate[]): ScheduleDecision {
  const rejected: ScheduleDecision["rejected"] = [];
  const eligible = candidates.filter((candidate) => {
    if (!["ready", "blocked", "waiting"].includes(candidate.workItem.normalizedState)) {
      rejected.push({ workItemId: candidate.workItem.id, reason: `State ${candidate.workItem.normalizedState} is not schedulable.` });
      return false;
    }
    if (candidate.workItem.normalizedState === "blocked" && !candidate.workItem.requiredCapability) {
      rejected.push({ workItemId: candidate.workItem.id, reason: "Blocker has no machine-resolvable capability." });
      return false;
    }
    if (candidate.workItem.placementPolicy?.mode === "manual") {
      rejected.push({ workItemId: candidate.workItem.id, reason: "Manual work requires an operator decision." });
      return false;
    }
    return true;
  });

  const scored = eligible.map((candidate) => {
    const shareDebt = Math.max(0, candidate.projectShare - candidate.recentShareUsed);
    const ageMinutes = Math.max(
      0,
      (Date.parse("2026-08-22T17:30:00.000Z") - Date.parse(candidate.workItem.createdAt)) / 60000,
    );
    const score =
      candidate.project.priority * 0.5 +
      candidate.workItem.priority * 0.7 +
      shareDebt * 1.3 +
      Math.min(ageMinutes, 360) * 0.04 +
      (candidate.workItem.downstreamUnlockCount ?? 0) * 4;
    return { candidate, score, shareDebt };
  });

  scored.sort((a, b) => b.score - a.score || a.candidate.workItem.id.localeCompare(b.candidate.workItem.id));
  const selected = scored[0];
  if (!selected) {
    return { explanation: ["No schedulable work is ready."], rejected };
  }

  return {
    selected: selected.candidate,
    explanation: [
      `${selected.candidate.project.title} is ${selected.shareDebt.toFixed(0)} share points below its target.`,
      `${selected.candidate.workItem.title} has priority ${selected.candidate.workItem.priority} and unlocks ${selected.candidate.workItem.downstreamUnlockCount ?? 0} downstream items.`,
      "The decision combines fair-share debt, project priority, job priority, age, and downstream impact; it is not first-in-first-out or purely greedy.",
    ],
    rejected,
  };
}
