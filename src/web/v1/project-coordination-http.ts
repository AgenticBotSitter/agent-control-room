// Server-side composition for the project-coordination HTTP surface.
//
// The web v1 layer composes the existing project-coordination engine against
// the human-only WebSessionAuthority. Coordinator appointment, replacement,
// revocation, and delegation-policy state changes all run through this
// service. Every action carries the exact revision the page was rendered with,
// and every read returns the new revision the page must adopt before its
// next action. Coordinator self-approval — the case where the acting owner
// identity names itself as the coordinator identity — is a refused outcome the
// service surfaces, never an accepted one.
//
// This module does not import the canonical store directly: it composes the
// existing `ProjectCoordinationCanonicalPortV1` port and constructs the engine
// service through the server composition. No second store, no second port,
// no second database path is introduced.

import type { DatabaseClient } from "../../persistence/database";
import {
  ProjectCoordinationCanonicalPortV1,
  ProjectCoordinatorServiceV1,
  type CoordinationOperationRequestV1,
  type CoordinatorAppointmentV1,
} from "../../project-coordination/v1";
import { projectCoordinatorExecutionBindingDigestV1 } from "../../contracts/v1/project-coordination-boundaries";
import {
  PROJECT_COORDINATOR_EXECUTION_BINDING_V1,
} from "../../contracts/v1/project-coordination-boundaries";
import { sha256Digest } from "../../security/digest";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import type {
  ProjectCoordinationPage,
  ProjectCoordinationRevision,
} from "./project-coordination-wire";

export interface ProjectCoordinationPagePayload extends ProjectCoordinationPage {}
export interface ProjectCoordinationRevisionPayload extends ProjectCoordinationRevision {}

export interface ProjectCoordinationCanonicalStoreAdapter {
  /** The full set of engine port methods the coordinator lifecycle needs. */
  coordinator: ProjectCoordinationCanonicalPortV1;
  /** Version of the active coordinator head. 0 when no head exists. */
  coordinatorVersion: (projectId: string) => Promise<number>;
  /**
   * Optional projection read for the active coordinator head. The HTTP service
   * uses this to render a populated coordinatorHead in the page payload so the
   * workspace component does not have to fetch the canonical row to render
   * "who is the coordinator now". When the fixture-only store omits this, the
   * service falls back to the empty `state: "none"` branch.
   */
  readActiveHead?: (
    projectId: string,
  ) => Promise<{
    tenantId: string;
    projectId: string;
    version: number;
    state: "active" | "revoked";
    coordinatorActorType: "human" | "agent";
    coordinatorIdentityId: string;
    executorId: string | null;
    adapterId: string | null;
    connectorProfileDigest: string | null;
    executionBindingDigest: string | null;
    appointedAt: string;
    appointedByOwnerIdentityId: string;
  } | null>;
  /** Version of the policy row tied to a project. 0 when no policy exists. */
  policyVersion: (projectId: string) => Promise<number>;
  /**
   * Optional summary read for the policy row tied to a project. When the
   * service is composed against the real canonical store, this returns a
   * shaped `DelegationPolicySummary` shaped object; when the service is
   * composed against a fakes-only fixture, it returns `null`.
   */
  readDelegationPolicySummary?: (
    projectId: string,
  ) => Promise<
    | {
        tenantId: string;
        projectId: string;
        policyId: string;
        coordinatorVersion: number;
        state: "active" | "paused" | "revoked";
        allowedActions: string[];
        validFrom: string;
        validUntil: string;
        taskAllowance: number;
        taskUnitsUsed: number;
        microUsdCeiling: string;
        microUsdUsed: string;
        concurrencyAllowance: number;
        concurrencyUnitsUsed: number;
      }
    | null
  >;
  /** Version used for the conflict ledger. 0 when no conflict version is recorded. */
  conflictsVersion: (projectId: string) => Promise<number>;
  /** Version used for the attention ledger. 0 when no attention version is recorded. */
  attentionVersion: (projectId: string) => Promise<number>;
  /** Project metadata lookup. Throws `not_found` when the project does not exist. */
  project: (projectId: string) => Promise<{
    projectId: string;
    title: string;
    summary: string;
    lifecycle: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  }>;
  /** Whether the coordination surface is enabled. False disables all writes; reads still succeed. */
  coordinationEnabled: () => Promise<boolean>;
}

export interface ProjectCoordinationHttpServiceOptions {
  database: DatabaseClient;
  scope: { tenantId: string; workspaceId: string };
  clock: () => number;
  store: ProjectCoordinationCanonicalStoreAdapter;
}

export type ProjectCoordinationReasonCode =
  | "stale_revision"
  | "no_coordinator"
  | "coordinator_already_active"
  | "policy_required"
  | "policy_already_active"
  | "policy_already_revoked"
  | "policy_already_paused"
  | "coordinator_self_approval"
  | "invalid_input"
  | "unknown_tenant"
  | "unknown_project";

export interface ProjectCoordinationActionOutcome {
  status: "accepted" | "refused";
  reasonCode?: ProjectCoordinationReasonCode;
  revision: {
    projectId: string;
    expectedCoordinatorVersion: number;
    expectedPolicyVersion: number;
    expectedConflictsVersion: number;
    expectedAttentionVersion: number;
    observedAt: string;
  };
}

interface ProjectCoordinationActionRequest {
  projectId: string;
  revision: {
    projectId: string;
    expectedCoordinatorVersion: number;
    expectedPolicyVersion: number;
    expectedConflictsVersion: number;
    expectedAttentionVersion: number;
    observedAt: string;
  };
}

interface ProjectCoordinatorAppointInput extends ProjectCoordinationActionRequest {
  coordinatorActorType: "human" | "agent";
  coordinatorIdentityId: string;
  executorId?: string;
  adapterId?: string;
  connectorProfileDigest?: string;
}

interface ProjectCoordinatorRevokePolicyInput extends ProjectCoordinationActionRequest {
  policyId: string;
}

const ACTIONS = {
  appoint: "coordination.coordinator.appoint",
  replace: "coordination.coordinator.replace",
  revoke: "coordination.coordinator.revoke",
  pause: "coordination.policy.pause",
  resume: "coordination.policy.resume",
  revokePolicy: "coordination.policy.revoke",
  read: "coordination.read",
} as const;

function coerceReasonCode(value: unknown): ProjectCoordinationReasonCode | undefined {
  // The real engine throws ProjectCoordinationErrorV1 with a `safeCode`. The
  // transport and a few first-party wrappers use a `code` field instead. The
  // fixtures throw `Error("…")` with the code on the message. Take whichever
  // surface carried the code.
  const code = (() => {
    if (value && typeof value === "object") {
      if ("code" in value) return (value as { code?: unknown }).code;
      if ("safeCode" in value) return (value as { safeCode?: unknown }).safeCode;
    }
    if (value instanceof Error && typeof value.message === "string") {
      return value.message;
    }
    return undefined;
  })();
  switch (code) {
    case "stale_revision":
    case "no_coordinator":
    case "coordinator_already_active":
    case "policy_required":
    case "policy_already_active":
    case "policy_already_revoked":
    case "policy_already_paused":
    case "coordinator_self_approval":
    case "invalid_input":
    case "unknown_tenant":
    case "unknown_project":
      return code;
    default:
      return undefined;
  }
}

export class ProjectCoordinationHttpService {
  private readonly authority: WebSessionAuthority;
  private readonly store: ProjectCoordinationCanonicalStoreAdapter;

  constructor(private readonly options: ProjectCoordinationHttpServiceOptions) {
    this.authority = new WebSessionAuthority(options.database, options.scope, options.clock);
    this.store = options.store;
  }

  async read(identity: VerifiedWebIdentity, projectId: string): Promise<ProjectCoordinationPagePayload> {
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require(ACTIONS.read, projectId);
      return this.composeProjectCoordinationPage(tx, actor, projectId) as Promise<ProjectCoordinationPagePayload>;
    });
  }

  /** Reports whether the coordination surface accepts writes. */
  async isEnabled(): Promise<boolean> {
    try {
      return await this.store.coordinationEnabled();
    } catch {
      return false;
    }
  }

  async appointCoordinator(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorAppointInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runCoordinatorAction(identity, ACTIONS.appoint, input, false);
  }

  async replaceCoordinator(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorAppointInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runCoordinatorAction(identity, ACTIONS.replace, input, true);
  }

  async revokeCoordinator(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorAppointInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runCoordinatorAction(identity, ACTIONS.revoke, input, false);
  }

  async pauseDelegationPolicy(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorRevokePolicyInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runPolicyAction(identity, ACTIONS.pause, input, "paused");
  }

  async resumeDelegationPolicy(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorRevokePolicyInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runPolicyAction(identity, ACTIONS.resume, input, "active");
  }

  async revokeDelegationPolicy(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorRevokePolicyInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runPolicyAction(identity, ACTIONS.revokePolicy, input, "revoked");
  }

  private async runCoordinatorAction(
    identity: VerifiedWebIdentity,
    action: string,
    input: ProjectCoordinatorAppointInput,
    requireExistingHead: boolean,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.authority.authenticated(identity, async (_tx, actor) => {
      actor.require(action, input.projectId, true);
      const projectHead = await this.readProjectHead(actor, input.projectId);
      const currentCoordinatorVersion = await this.store.coordinatorVersion(input.projectId);
      const currentPolicyVersion = await this.store.policyVersion(input.projectId);
      const currentConflictsVersion = await this.store.conflictsVersion(input.projectId);
      const currentAttentionVersion = await this.store.attentionVersion(input.projectId);
      const observedAt = new Date(this.options.clock()).toISOString();

      const versionCheck = this.checkRevisions(
        input,
        currentCoordinatorVersion,
        currentPolicyVersion,
        currentConflictsVersion,
        currentAttentionVersion,
        observedAt,
      );
      if (versionCheck) return versionCheck;

      if (requireExistingHead && currentCoordinatorVersion === 0) {
        return this.refused("no_coordinator", observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        }, input.projectId);
      }
      if (!requireExistingHead && currentCoordinatorVersion > 0) {
        return this.refused("coordinator_already_active", observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        }, input.projectId);
      }

      // Self-approval: the acting owner identity must not name itself as the
      // coordinator. This is the documented refusal surface for an agent that
      // tries to give itself coordinator authority.
      if (
        input.coordinatorActorType === "human"
        && input.coordinatorIdentityId === actor.id
      ) {
        return this.refused("coordinator_self_approval", observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        }, input.projectId);
      }

      const appointment: CoordinatorAppointmentV1 = {
        tenantId: projectHead.tenantId,
        projectId: projectHead.projectId,
        ownerIdentityId: actor.id,
        coordinatorActorType: input.coordinatorActorType,
        coordinatorIdentityId: input.coordinatorIdentityId,
        ...(input.coordinatorActorType === "agent" && input.executorId
          ? { executorId: input.executorId }
          : {}),
        ...(input.coordinatorActorType === "agent" && input.adapterId
          ? { adapterId: input.adapterId }
          : {}),
        ...(input.coordinatorActorType === "agent" && input.connectorProfileDigest
          ? { connectorProfileDigest: input.connectorProfileDigest }
          : {}),
        occurredAt: observedAt,
      };

      let executionBindingDigest: string | undefined;
      if (appointment.coordinatorActorType === "agent") {
        if (!appointment.executorId || !appointment.adapterId || !appointment.connectorProfileDigest) {
          return this.refused("invalid_input", observedAt, {
            expectedCoordinatorVersion: currentCoordinatorVersion,
            expectedPolicyVersion: currentPolicyVersion,
            expectedConflictsVersion: currentConflictsVersion,
            expectedAttentionVersion: currentAttentionVersion,
          },
        input.projectId);;
        }
        if (appointment.coordinatorIdentityId === appointment.executorId) {
          return this.refused("coordinator_self_approval", observedAt, {
            expectedCoordinatorVersion: currentCoordinatorVersion,
            expectedPolicyVersion: currentPolicyVersion,
            expectedConflictsVersion: currentConflictsVersion,
            expectedAttentionVersion: currentAttentionVersion,
          },
        input.projectId);;
        }
        executionBindingDigest = projectCoordinatorExecutionBindingDigestV1({
          schema: PROJECT_COORDINATOR_EXECUTION_BINDING_V1,
          tenantId: appointment.tenantId,
          projectId: appointment.projectId,
          coordinatorIdentityId: appointment.coordinatorIdentityId,
          executorId: appointment.executorId,
          adapterId: appointment.adapterId,
          connectorProfileDigest: appointment.connectorProfileDigest,
        });
      }

      actor.require(action, input.projectId);
      const coordinatorService = new ProjectCoordinatorServiceV1(this.store.coordinator);
      const operation = action === ACTIONS.revoke ? "revoke" : "assign";
      try {
        await coordinatorService[operation === "revoke" ? "revoke" : "appoint"](
          operation === "revoke" ? appointment : appointment,
        );
      } catch (error: unknown) {
        const code = coerceReasonCode(
          (error as { code?: unknown })?.code ?? (error as { reasonCode?: unknown })?.reasonCode,
        );
        if (code) return this.refused(code, observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        },
        input.projectId);;
        throw error;
      }
      return this.accepted(observedAt, {
        expectedCoordinatorVersion: currentCoordinatorVersion + 1,
        expectedPolicyVersion: currentPolicyVersion,
        expectedConflictsVersion: currentConflictsVersion,
        expectedAttentionVersion: currentAttentionVersion,
      },
        input.projectId);;
    });
  }

  private async runPolicyAction(
    identity: VerifiedWebIdentity,
    action: string,
    input: ProjectCoordinatorRevokePolicyInput,
    toState: "paused" | "active" | "revoked",
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.authority.authenticated(identity, async (_tx, actor) => {
      actor.require(action, input.projectId, true);
      const projectHead = await this.readProjectHead(actor, input.projectId);
      const currentCoordinatorVersion = await this.store.coordinatorVersion(input.projectId);
      const currentPolicyVersion = await this.store.policyVersion(input.projectId);
      const currentConflictsVersion = await this.store.conflictsVersion(input.projectId);
      const currentAttentionVersion = await this.store.attentionVersion(input.projectId);
      const observedAt = new Date(this.options.clock()).toISOString();

      const versionCheck = this.checkRevisions(
        input,
        currentCoordinatorVersion,
        currentPolicyVersion,
        currentConflictsVersion,
        currentAttentionVersion,
        observedAt,
      );
      if (versionCheck) return versionCheck;

      if (currentPolicyVersion === 0) {
        return this.refused("policy_required", observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        },
        input.projectId);;
      }

      const existingPolicyState = await this.store.coordinator
        .setProjectDelegationPolicyStateV1({
          tenantId: projectHead.tenantId,
          projectId: projectHead.projectId,
          policyId: input.policyId,
          ownerIdentityId: actor.id,
          toState,
          occurredAt: observedAt,
        })
        .then((result) => result.state as "active" | "paused" | "revoked")
        .catch((error: unknown) => {
          const code = coerceReasonCode(error);
          if (code === "policy_already_active" && toState === "active") {
            return "policy_already_active" as const;
          }
          if (code === "policy_already_revoked" && toState === "revoked") {
            return "policy_already_revoked" as const;
          }
          if (code === "policy_already_paused" && toState === "paused") {
            return "policy_already_paused" as const;
          }
          throw error;
        });

      if (existingPolicyState === "policy_already_active") {
        return this.refused("policy_already_active", observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        },
        input.projectId);;
      }
      if (existingPolicyState === "policy_already_revoked") {
        return this.refused("policy_already_revoked", observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        },
        input.projectId);;
      }
      if (existingPolicyState === "policy_already_paused") {
        return this.refused("policy_already_paused", observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        },
        input.projectId);;
      }

      actor.require(action, input.projectId);
      return this.accepted(observedAt, {
        expectedCoordinatorVersion: currentCoordinatorVersion,
        expectedPolicyVersion: currentPolicyVersion + 1,
        expectedConflictsVersion: currentConflictsVersion,
        expectedAttentionVersion: currentAttentionVersion,
      },
        input.projectId);;
    });
  }

  private async readProjectHead(
    actor: WebActor,
    projectId: string,
  ): Promise<{ tenantId: string; projectId: string }> {
    const project = await this.store.project(projectId).catch(() => null);
    if (!project) throw new WebAccessError("not_found");
    return { tenantId: this.options.scope.tenantId, projectId };
  }

  private checkRevisions(
    input: ProjectCoordinationActionRequest,
    currentCoordinatorVersion: number,
    currentPolicyVersion: number,
    currentConflictsVersion: number,
    currentAttentionVersion: number,
    observedAt: string,
  ): ProjectCoordinationActionOutcome | null {
    if (input.revision.projectId !== input.projectId) {
      return this.refused("invalid_input", observedAt, {
        expectedCoordinatorVersion: currentCoordinatorVersion,
        expectedPolicyVersion: currentPolicyVersion,
        expectedConflictsVersion: currentConflictsVersion,
        expectedAttentionVersion: currentAttentionVersion,
      },
        input.projectId);;
    }
    if (
      input.revision.expectedCoordinatorVersion !== currentCoordinatorVersion
      || input.revision.expectedPolicyVersion !== currentPolicyVersion
      || input.revision.expectedConflictsVersion !== currentConflictsVersion
      || input.revision.expectedAttentionVersion !== currentAttentionVersion
    ) {
      return this.refused("stale_revision", observedAt, {
        expectedCoordinatorVersion: currentCoordinatorVersion,
        expectedPolicyVersion: currentPolicyVersion,
        expectedConflictsVersion: currentConflictsVersion,
        expectedAttentionVersion: currentAttentionVersion,
      },
        input.projectId);;
    }
    return null;
  }

  private refused(
    reasonCode: ProjectCoordinationReasonCode,
    observedAt: string,
    expected: {
      expectedCoordinatorVersion: number;
      expectedPolicyVersion: number;
      expectedConflictsVersion: number;
      expectedAttentionVersion: number;
    },
    projectId: string,
  ): ProjectCoordinationActionOutcome {
    return {
      status: "refused",
      reasonCode,
      revision: {
        projectId,
        observedAt,
        expectedCoordinatorVersion: expected.expectedCoordinatorVersion,
        expectedPolicyVersion: expected.expectedPolicyVersion,
        expectedConflictsVersion: expected.expectedConflictsVersion,
        expectedAttentionVersion: expected.expectedAttentionVersion,
      },
    };
  }

  private accepted(
    observedAt: string,
    expected: {
      expectedCoordinatorVersion: number;
      expectedPolicyVersion: number;
      expectedConflictsVersion: number;
      expectedAttentionVersion: number;
    },
    projectId: string,
  ): ProjectCoordinationActionOutcome {
    return {
      status: "accepted",
      revision: {
        projectId,
        observedAt,
        expectedCoordinatorVersion: expected.expectedCoordinatorVersion,
        expectedPolicyVersion: expected.expectedPolicyVersion,
        expectedConflictsVersion: expected.expectedConflictsVersion,
        expectedAttentionVersion: expected.expectedAttentionVersion,
      },
    };
  }

  private async composeProjectCoordinationPage(
    _tx: unknown,
    _actor: WebActor,
    projectId: string,
  ): Promise<ProjectCoordinationPagePayload> {
    const project = await this.store.project(projectId).catch(() => null);
    if (!project) throw new WebAccessError("not_found");
    const enabled = await this.store.coordinationEnabled();
    const observedAt = new Date(this.options.clock()).toISOString();
    const headVersion = await this.store.coordinatorVersion(projectId);
    const headProjection = await this.buildCoordinatorHeadForPage(projectId, headVersion, observedAt);
    return {
      project: {
        projectId: project.projectId,
        title: project.title,
        summary: project.summary,
        lifecycle: project.lifecycle as "active",
        version: project.version,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        presentation: undefined,
      },
      coordinationEnabled: enabled,
      observedAt,
      coordinatorHead: headProjection.coordinatorHead,
      delegationPolicy: (await this.store.readDelegationPolicySummary?.(projectId)) ?? null,
      activeWork: [],
      dependencies: [],
      conflicts: [],
      attention: [],
      nextAction: headVersion === 0 ? "appoint-coordinator" : "view-active-work",
    };
  }

  private async buildCoordinatorHeadForPage(
    projectId: string,
    headVersion: number,
    _observedAt: string,
  ): Promise<{ coordinatorHead: ProjectCoordinationPagePayload["coordinatorHead"] }> {
    if (headVersion === 0) {
      return {
        coordinatorHead: {
          tenantId: this.options.scope.tenantId,
          projectId,
          version: 0,
          state: "none",
          coordinatorActorType: null,
          coordinatorIdentityId: null,
          executorId: null,
          adapterId: null,
          connectorProfileDigest: null,
          executionBindingDigest: null,
          appointedAt: null,
          appointedByOwnerIdentityId: null,
        },
      };
    }
    const head = await this.store.readActiveHead?.(projectId);
    if (!head) {
      // Fakes-only store: do not fabricate a populated head. The workspace
      // handles the empty-head view; the page does not invent coordinator
      // identity, executor, or binding fields it cannot honestly read.
      return {
        coordinatorHead: {
          tenantId: this.options.scope.tenantId,
          projectId,
          version: 0,
          state: "none",
          coordinatorActorType: null,
          coordinatorIdentityId: null,
          executorId: null,
          adapterId: null,
          connectorProfileDigest: null,
          executionBindingDigest: null,
          appointedAt: null,
          appointedByOwnerIdentityId: null,
        },
      };
    }
    return {
      coordinatorHead: head,
    };
  }
}
