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

import type { DatabaseClient, DatabaseSession, QueryResult } from "../../persistence/database";
import { createHash } from "node:crypto";
import { CanonicalStore } from "../../persistence/canonical-store";
import { findResourceConflictsV1 } from "../../project-coordination/v1/resource-conflict";
import type { ProjectWorkResourceScopeV1 } from "../../contracts/v1/project-coordination-boundaries";
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
  /**
   * Optional projection read for the active-work ledger. Returns the canonical
   * jobs currently leased/running on the project. When omitted, the page
   * surfaces an empty array.
   */
  readActiveWork?: (
    projectId: string,
  ) => Promise<Array<{
    jobId: string;
    title: string;
    state: "proposed" | "leased" | "running" | "waiting" | "review" | "finished" | "failed" | "blocked";
    updatedAt: string;
    proposalId: string;
    proposalDigest: string;
    readScopes: string[];
    writeScopes: string[];
  }>>;
  /**
   * Optional projection read for the dependency-edge ledger. Returns the
   * directed edges between active jobs. When omitted, the page surfaces an
   * empty array.
   */
  readDependencies?: (
    projectId: string,
  ) => Promise<Array<{
    fromJobId: string;
    toJobId: string;
    required: boolean;
  }>>;
  /**
   * Optional projection read for the conflict ledger. Returns the canonical
   * resource conflicts raised against the project. When omitted, the page
   * surfaces an empty array.
   */
  readConflicts?: (
    projectId: string,
  ) => Promise<Array<{
    ledgerId: string;
    projectId: string;
    repository: string;
    resourceKind: "tree" | "file" | "logical";
    resourcePath: string;
    conflictingAdmissionId: string;
    conflictingJobId: string;
    conflictingLeaseId: string;
    reasonCode: string;
    raisedAt: string;
    resolvedAt: string | null;
    resolutionKind: "retired" | "released" | "expired" | "superseded" | "unspecified" | null;
  }>>;
  /**
   * Optional projection read for the attention ledger. Returns the canonical
   * attention items raised against the project. When omitted, the page
   * surfaces an empty array.
   */
  readAttention?: (
    projectId: string,
  ) => Promise<Array<{
    attentionId: string;
    projectId: string;
    severity: "urgent" | "soon" | "normal";
    category: "uncertainty" | "failure" | "approval" | "review" | "preparation";
    ownerQuestion: string;
    observedAt: string;
    referencedJobId: string | null;
    referencedAdmissionId: string | null;
  }>>;
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
  /**
   * Rebind this adapter to an ambient transaction session. The HTTP service
   * calls this with the `tx` it already holds inside `authenticated()`, so
   * every canonical read and lifecycle write joins that transaction instead
   * of opening a second connection: on a pooled production database that
   * keeps the page snapshot consistent, and on a single-connection embedded
   * database it avoids self-deadlock. Stores that carry no database handle
   * (in-memory fakes) omit this and the service keeps using them as-is.
   */
  bindSession?: (session: DatabaseSession) => ProjectCoordinationCanonicalStoreAdapter;
}

export interface ProjectCoordinationHttpServiceOptions {
  database: DatabaseClient;
  scope: { tenantId: string; workspaceId: string };
  clock: () => number;
  store: ProjectCoordinationCanonicalStoreAdapter;
  /**
   * Test instrumentation for the page read. Called inside the
   * authorization transaction after the action check and before the page
   * snapshot composes, so tests can interleave clock/row changes
   * deterministically. Never set in production wiring.
   */
  readProbe?: { beforeSnapshot?: (tx: DatabaseSession, actor: WebActor) => Promise<void> };
}

export type ProjectCoordinationReasonCode =
  | "stale_revision"
  | "no_coordinator"
  | "coordinator_already_active"
  | "coordinator_replay_conflict"
  | "policy_required"
  | "policy_already_active"
  | "policy_already_revoked"
  | "policy_already_paused"
  | "policy_replay_conflict"
  | "policy_revoked"
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
  /**
   * The route's exact Idempotency-Key, passed through to the merged
   * coordinator service. The PG transaction records one permanent receipt
   * per key and returns it on exact retry.
   */
  idempotencyKey: string;
}

interface ProjectCoordinatorRevokePolicyInput extends ProjectCoordinationActionRequest {
  policyId: string;
  /**
   * The route's exact Idempotency-Key, passed through to the durable policy
   * service. The PG transaction records one permanent receipt per key and
   * returns it on exact retry.
   */
  idempotencyKey: string;
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

/**
 * Engine refusal codes the HTTP layer translates into the wire envelope.
 * Most pass through verbatim; `coordinator_version_stale` becomes the
 * long-standing `stale_revision` wire code and `coordinator_absent` becomes
 * `no_coordinator` so revoke-missing keeps its historic shape.
 */
type EngineRefusalCode = ProjectCoordinationReasonCode | "coordinator_version_stale" | "coordinator_absent"
  | "policy_version_stale" | "policy_revoked";

function coerceReasonCode(value: unknown): EngineRefusalCode | undefined {
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
    case "coordinator_replay_conflict":
    case "coordinator_version_stale":
    case "coordinator_absent":
    case "policy_required":
    case "policy_already_active":
    case "policy_already_revoked":
    case "policy_already_paused":
    case "policy_replay_conflict":
    case "policy_version_stale":
    case "policy_revoked":
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
    // Authorization and page snapshot share one repeatable-read
    // transaction: the identity/session locks are held through every page
    // query, so a revocation committed mid-read blocks until this commit
    // (already-running wins) and can never slip between the check and the
    // data. The pre-commit freshness check still refuses a read whose
    // session or identity expired while composing; the post-compose assert
    // re-runs the same boundary before any byte leaves the service.
    // Content and versions therefore always pair from one snapshot.
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require(ACTIONS.read, projectId);
      await this.options.readProbe?.beforeSnapshot?.(tx, actor);
      const page = await this.composeProjectCoordinationPage(tx, actor, projectId) as ProjectCoordinationPagePayload;
      actor.assertTimeCurrent();
      return page;
    }, { repeatableReadSnapshot: true });
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
    return this.runPolicyAction(identity, ACTIONS.pause, input);
  }

  async resumeDelegationPolicy(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorRevokePolicyInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runPolicyAction(identity, ACTIONS.resume, input);
  }

  async revokeDelegationPolicy(
    identity: VerifiedWebIdentity,
    input: ProjectCoordinatorRevokePolicyInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.runPolicyAction(identity, ACTIONS.revokePolicy, input);
  }

  private async runCoordinatorAction(
    identity: VerifiedWebIdentity,
    action: string,
    input: ProjectCoordinatorAppointInput,
    requireExistingHead: boolean,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require(action, input.projectId, true);
      const store = this.sessionStore(tx);
      const projectHead = await this.readProjectHead(actor, input.projectId, store);
      const currentCoordinatorVersion = await store.coordinatorVersion(input.projectId);
      const currentPolicyVersion = await store.policyVersion(input.projectId);
      const currentConflictsVersion = await store.conflictsVersion(input.projectId);
      const currentAttentionVersion = await store.attentionVersion(input.projectId);
      const observedAt = new Date(this.options.clock()).toISOString();

      // Revision gate, minus the coordinator version. The coordinator version
      // is owned by the merged engine: the PG transaction probes the
      // idempotency ledger first (exact retry returns its saved receipt) and
      // only then enforces expectedVersion. Refusing a coordinator mismatch
      // here would make durable replay unreachable, so a mismatch defers to
      // the engine instead. Policy/conflict/attention versions are outside
      // the receipt's scope and still refuse immediately.
      const versionCheck = this.checkRevisions(
        input,
        currentCoordinatorVersion,
        currentPolicyVersion,
        currentConflictsVersion,
        currentAttentionVersion,
        observedAt,
        true,
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
      // No already_active pre-check: the merged canonical engine treats
      // appoint as version-checked upsert and decides in PostgreSQL. An exact
      // retry must reach the engine to collect its saved receipt; a
      // same-key/changed-content retry is refused there with
      // coordinator_replay_conflict.

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
      const coordinatorService = new ProjectCoordinatorServiceV1(store.coordinator);
      // The merged service requires the route's exact Idempotency-Key and the
      // submitted expected version. Its PG transaction returns the saved
      // receipt on an exact retry, refuses changed content under the same key,
      // and refuses stale versions — the durable authority for this route.
      const operation = action === ACTIONS.revoke ? "revoke" : action === ACTIONS.replace ? "replace" : "appoint";
      try {
        const receipt = await coordinatorService[operation](
          appointment,
          input.idempotencyKey,
          input.revision.expectedCoordinatorVersion,
        );
        return this.accepted(observedAt, {
          expectedCoordinatorVersion: receipt.version,
          expectedPolicyVersion: currentPolicyVersion,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        },
          input.projectId);;
      } catch (error: unknown) {
        // Pass the error itself: the engine throws ProjectCoordinationErrorV1
        // carrying safeCode (no `code` field), and coerce reads all surfaces.
        const code = coerceReasonCode(error);
        const wireCode: ProjectCoordinationReasonCode | undefined =
          code === "coordinator_version_stale" ? "stale_revision"
          : code === "coordinator_absent" ? "no_coordinator"
          : code === "policy_version_stale" || code === "policy_revoked" ? undefined
          : code;
        if (wireCode) {
          // Re-read the head version so the stale envelope reports the
          // version the engine actually saw, not the pre-call read.
          const latestCoordinatorVersion = await store.coordinatorVersion(input.projectId).catch(
            () => currentCoordinatorVersion,
          );
          return this.refused(wireCode, observedAt, {
            expectedCoordinatorVersion: latestCoordinatorVersion,
            expectedPolicyVersion: currentPolicyVersion,
            expectedConflictsVersion: currentConflictsVersion,
            expectedAttentionVersion: currentAttentionVersion,
          },
          input.projectId);;
        }
        throw error;
      }
    });
  }

  private async runPolicyAction(
    identity: VerifiedWebIdentity,
    action: string,
    input: ProjectCoordinatorRevokePolicyInput,
  ): Promise<ProjectCoordinationActionOutcome> {
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require(action, input.projectId, true);
      const store = this.sessionStore(tx);
      const projectHead = await this.readProjectHead(actor, input.projectId, store);
      const currentCoordinatorVersion = await store.coordinatorVersion(input.projectId);
      const currentPolicyVersion = await store.policyVersion(input.projectId);
      const currentConflictsVersion = await store.conflictsVersion(input.projectId);
      const currentAttentionVersion = await store.attentionVersion(input.projectId);
      const observedAt = new Date(this.options.clock()).toISOString();

      // Revision gate, minus the policy version. The policy version is owned
      // by the durable engine: the PG transaction probes the idempotency
      // ledger first (exact retry returns its saved receipt) and only then
      // enforces expectedVersion. Refusing a policy mismatch here would make
      // durable replay unreachable, so a mismatch defers to the engine.
      // Coordinator/conflict/attention versions are outside the receipt's
      // scope and still refuse immediately.
      const versionCheck = this.checkRevisions(
        input,
        currentCoordinatorVersion,
        currentPolicyVersion,
        currentConflictsVersion,
        currentAttentionVersion,
        observedAt,
        false,
        true,
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

      actor.require(action, input.projectId);
      const delegationService = new ProjectCoordinatorServiceV1(store.coordinator);
      // The durable service requires the route's exact Idempotency-Key and
      // the submitted expected version. Its PG transaction returns the saved
      // receipt on an exact retry, refuses changed content under the same
      // key with policy_replay_conflict, and refuses stale versions — the
      // durable authority for this route. The already-state outcomes
      // originate in PostgreSQL; this layer maps them and never invents them.
      const operation = action === ACTIONS.revokePolicy ? "revokeDelegation"
        : action === ACTIONS.resume ? "resumeDelegation" : "pauseDelegation";
      try {
        const receipt = await delegationService[operation]({
          tenantId: projectHead.tenantId,
          projectId: projectHead.projectId,
          policyId: input.policyId,
          ownerIdentityId: actor.id,
          idempotencyKey: input.idempotencyKey,
          expectedVersion: input.revision.expectedPolicyVersion,
          occurredAt: observedAt,
        });
        if (receipt.alreadyState) {
          return this.refused(receipt.alreadyState, observedAt, {
            expectedCoordinatorVersion: currentCoordinatorVersion,
            expectedPolicyVersion: receipt.version,
            expectedConflictsVersion: currentConflictsVersion,
            expectedAttentionVersion: currentAttentionVersion,
          },
          input.projectId);;
        }
        return this.accepted(observedAt, {
          expectedCoordinatorVersion: currentCoordinatorVersion,
          expectedPolicyVersion: receipt.version,
          expectedConflictsVersion: currentConflictsVersion,
          expectedAttentionVersion: currentAttentionVersion,
        },
        input.projectId);;
      } catch (error: unknown) {
        const code = coerceReasonCode(error);
        const wireCode: ProjectCoordinationReasonCode | undefined =
          code === "policy_version_stale" ? "stale_revision"
          : code === "coordinator_version_stale" || code === "coordinator_absent" ? undefined
          : code;
        if (wireCode) {
          // Re-read the head version so the stale envelope reports the
          // version the engine actually saw, not the pre-call read.
          const latestPolicyVersion = await store.policyVersion(input.projectId).catch(
            () => currentPolicyVersion,
          );
          return this.refused(wireCode, observedAt, {
            expectedCoordinatorVersion: currentCoordinatorVersion,
            expectedPolicyVersion: latestPolicyVersion,
            expectedConflictsVersion: currentConflictsVersion,
            expectedAttentionVersion: currentAttentionVersion,
          },
          input.projectId);;
        }
        throw error;
      }
    });
  }

  /** Store bound to the ambient transaction session when it offers one. */
  private sessionStore(tx: unknown): ProjectCoordinationCanonicalStoreAdapter {
    if (tx && typeof tx === "object" && this.store.bindSession) {
      return this.store.bindSession(tx as DatabaseSession);
    }
    return this.store;
  }

  private async readProjectHead(
    actor: WebActor,
    projectId: string,
    store: ProjectCoordinationCanonicalStoreAdapter = this.store,
  ): Promise<{ tenantId: string; projectId: string }> {
    const project = await store.project(projectId).catch(() => null);
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
    // When true, the coordinator-version equality is skipped: the merged
    // coordinator engine owns that check (replay probe first, then
    // expectedVersion enforcement). Policy/conflict/attention versions are
    // outside the receipt's scope and always compare here.
    skipCoordinatorVersion = false,
    // When true, the policy-version equality is skipped: the durable policy
    // engine owns that check (saved-receipt probe first, then
    // expectedVersion enforcement). An exact retry must reach the engine to
    // collect its receipt even when the policy has since moved on.
    skipPolicyVersion = false,
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
      (!skipCoordinatorVersion && input.revision.expectedCoordinatorVersion !== currentCoordinatorVersion)
      || (!skipPolicyVersion && input.revision.expectedPolicyVersion !== currentPolicyVersion)
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
    tx: unknown,
    actor: WebActor,
    projectId: string,
  ): Promise<ProjectCoordinationPagePayload> {
    const store = this.sessionStore(tx);
    const project = await store.project(projectId).catch(() => null);
    if (!project) throw new WebAccessError("not_found");
    const enabled = await store.coordinationEnabled();
    const observedAt = new Date(this.options.clock()).toISOString();
    const headVersion = await store.coordinatorVersion(projectId);
    const headProjection = await this.buildCoordinatorHeadForPage(store, projectId, headVersion, observedAt);
    // The exact saved versions the guards enforce: read here once so the
    // page and every later write on this revision compare the same values.
    // Nothing here is derived from array lengths or presence flags.
    const policyVersion = await store.policyVersion(projectId);
    const conflicts = (await store.readConflicts?.(projectId)) ?? [];
    const attention = (await store.readAttention?.(projectId)) ?? [];
    // Ledger revisions come from the same store methods the write guards
    // enforce — never from array lengths — so the page and every later
    // write on this revision compare the same values.
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
      delegationPolicy: (await store.readDelegationPolicySummary?.(projectId)) ?? null,
      activeWork: (await store.readActiveWork?.(projectId)) ?? [],
      dependencies: (await store.readDependencies?.(projectId)) ?? [],
      conflicts,
      attention,
      nextAction: headVersion === 0 ? "appoint-coordinator" : "view-active-work",
      versions: {
        coordinatorVersion: headVersion,
        policyVersion,
        conflictsVersion: await store.conflictsVersion(projectId),
        attentionVersion: await store.attentionVersion(projectId),
      },
      viewerOwnerIdentityId: actor.id,
    };
  }

  private async buildCoordinatorHeadForPage(
    store: ProjectCoordinationCanonicalStoreAdapter,
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
    const head = await store.readActiveHead?.(projectId);
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

/**
 * Production adapter: every read runs against the accepted canonical
 * PostgreSQL tables for the requesting tenant and project. No fakes, no
 * empty hooks, no second authority.
 *
 * Honest derivations used where no stored version exists (all documented at
 * the call site):
 * - conflicts are DERIVED open overlaps computed with the accepted
 *   findResourceConflictsV1 rules over currently-held admissions; they carry
 *   the stable reasonCode "resource_overlap" (a derivation marker, not a
 *   stored engine refusal) and ledgerIds derived from the saved admission id.
 * - conflictsVersion/attentionVersion are the counts of those derived/saved
 *   rows. They are staleness guards, not monotonic sequences: any change
 *   refuses with fresh versions and the owner re-reads.
 * - concurrencyUnitsUsed counts currently-active coordination-adopted jobs;
 *   task/microUSD usage sums the saved operation receipts for the policy.
 * - coordinationEnabled is always true: there is no coordination product
 *   module, so the disabled path is reachable only in composed fixtures.
 */
/**
 * Join the ambient transaction the HTTP service already holds: every query
 * runs on that session, and nested transaction boundaries collapse into it
 * (the outer commit still decides). This is what lets the production adapter
 * serve reads and lifecycle writes from inside `authenticated()` without
 * opening a second connection.
 */
function joinAmbientSession(session: DatabaseSession): DatabaseClient {
  return {
    query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<QueryResult<T>> {
      return session.query<T>(statement, params);
    },
    transaction<T>(callback: (nested: DatabaseSession) => Promise<T>): Promise<T> {
      return callback(session);
    },
    transactionWithPreCommitCheck<T>(callback: (nested: DatabaseSession) => Promise<T>,
      preCommitCheck: () => void | Promise<void>): Promise<T> {
      return (async () => {
        const result = await callback(session);
        await preCommitCheck();
        return result;
      })();
    },
  };
}

export function createProjectCoordinationCanonicalStoreAdapterV1(options: {
  database: DatabaseClient;
  tenantId: string;
  now?: () => number;
}): ProjectCoordinationCanonicalStoreAdapter {
  const tenantId = options.tenantId;
  const now = options.now ?? Date.now;
  const db = options.database;
  // Builder so bindSession can rebind every helper and the lifecycle port to
  // the ambient transaction session. The parameter shadows the outer client
  // on purpose, so every closure below keeps working unchanged.
  const buildAdapter = (db: DatabaseClient): ProjectCoordinationCanonicalStoreAdapter => {
  const coordinator = new CanonicalStore(db);

  const iso = (value: unknown): string => new Date(value as string | number | Date).toISOString();
  /**
   * Content revision for the unversioned ledgers (conflicts, attention).
   * These ledgers have no version column, so the revision is a 52-bit
   * digest over the ordered persisted tuples that constitute the ledger:
   * it changes if and only if saved ledger content changes, which is
   * exactly the optimistic-concurrency property the revision guards need.
   * Clock-derived display fields (e.g. attention severity) are excluded so
   * the mere passage of time never invalidates a revision. Empty ledger
   * reads 0, matching the "no ledger" guard convention.
   */
  const ledgerRevision = (tuples: string[]): number => {
    if (tuples.length === 0) return 0;
    const digest = createHash("sha256").update([...tuples].sort().join("\n")).digest("hex");
    return Number.parseInt(digest.slice(0, 13), 16);
  };
  const cleanId = (value: string): string => value.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 160);
  const isJobId = (value: string): boolean => /^job:[A-Za-z0-9:_-]{1,160}$/.test(value);
  const isAdmissionId = (value: string): boolean => /^admission:[A-Za-z0-9:_-]{1,160}$/.test(value);
  const isLeaseId = (value: string): boolean => /^lease:[A-Za-z0-9:_-]{1,160}$/.test(value);
  const isProposalId = (value: string): boolean => /^proposal:[A-Za-z0-9:_-]{1,160}$/.test(value);
  const isRelativePath = (value: string): boolean => value === ""
    || /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$/.test(value);

  type HeadRow = {
    version: string | number; state: string; coordinator_identity_id: string;
    coordinator_actor_type: string; executor_id: string | null; adapter_id: string | null;
    connector_profile_digest: string | null; execution_binding_digest: string | null;
    assigned_at: unknown; assigned_by_owner_identity_id: string;
  };
  async function headRow(projectId: string): Promise<HeadRow | undefined> {
    return (await db.query<HeadRow>(
      `SELECT version,state,coordinator_identity_id,coordinator_actor_type,executor_id,adapter_id,
        connector_profile_digest,execution_binding_digest,assigned_at,assigned_by_owner_identity_id
       FROM control_project_coordinator_heads WHERE tenant_id=$1 AND project_id=$2`,
      [tenantId, projectId])).rows[0];
  }

  type PolicyRow = {
    id: string; state: string; version: string | number; coordinator_version: string | number;
    allowed_actions: unknown; valid_from: unknown; valid_until: unknown;
    max_total_tasks: string | number; max_total_cost_microusd: string | number;
    max_concurrent_tasks: string | number;
  };
  async function policyRow(projectId: string): Promise<PolicyRow | undefined> {
    return (await db.query<PolicyRow>(
      `SELECT id,state,version,coordinator_version,allowed_actions,valid_from,valid_until,
        max_total_tasks,max_total_cost_microusd,max_concurrent_tasks
       FROM control_project_delegation_policies WHERE tenant_id=$1 AND project_id=$2
       ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, projectId])).rows[0];
  }

  type ConflictSeed = {
    admissionId: string; jobId: string; leaseId: string; acquiredAt: string;
    repository: string; scopes: Array<{ scopeKind: "file" | "tree" | "logical"; path: string; accessMode: "read" | "write" }>;
  };
  async function openConflicts(projectId: string): Promise<Array<{
    ledgerId: string; projectId: string; repository: string;
    resourceKind: "tree" | "file" | "logical"; resourcePath: string;
    conflictingAdmissionId: string; conflictingJobId: string; conflictingLeaseId: string;
    reasonCode: string; raisedAt: string; resolvedAt: null; resolutionKind: null;
  }>> {
    const admissions = (await db.query<{
      id: string; job_id: string; lease_id: string; acquired_at: unknown; canonical_key: string;
    }>(
      `SELECT a.id,a.job_id,a.lease_id,a.acquired_at,r.canonical_key
       FROM control_attempt_resource_admissions a
       JOIN control_work_resources r ON r.tenant_id=a.tenant_id AND r.id=a.repository_resource_id
       WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.state='held'
       ORDER BY a.acquired_at ASC,a.id ASC`,
      [tenantId, projectId])).rows;
    if (admissions.length < 2) return [];
    const scopes = (await db.query<{
      admission_id: string; resource_id: string; access_mode: string; scope_kind: string; path: string;
    }>(
      `SELECT admission_id,resource_id,access_mode,scope_kind,path
       FROM control_attempt_resource_scopes WHERE tenant_id=$1 AND admission_id=ANY($2::text[])`,
      [tenantId, admissions.map((a) => a.id)])).rows;
    const byAdmission = new Map<string, ConflictSeed["scopes"]>();
    for (const scope of scopes) {
      if (scope.scope_kind !== "file" && scope.scope_kind !== "tree" && scope.scope_kind !== "logical") continue;
      if (scope.access_mode !== "read" && scope.access_mode !== "write") continue;
      if (!isRelativePath(scope.path)) continue;
      const list = byAdmission.get(scope.admission_id) ?? [];
      list.push({ scopeKind: scope.scope_kind, path: scope.path, accessMode: scope.access_mode });
      byAdmission.set(scope.admission_id, list);
    }
    const seeds: ConflictSeed[] = [];
    for (const admission of admissions) {
      const admissionScopes = byAdmission.get(admission.id) ?? [];
      if (admissionScopes.length === 0) continue;
      seeds.push({
        admissionId: admission.id, jobId: admission.job_id, leaseId: admission.lease_id,
        acquiredAt: iso(admission.acquired_at), repository: admission.canonical_key,
        scopes: admissionScopes,
      });
    }
    // One conflict per (requesting admission, resource): the earliest held
    // overlap from a different job. Ordered by acquisition so ledgerIds are
    // stable derivations of saved rows.
    const out: Awaited<ReturnType<typeof openConflicts>> = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const held = seeds
        .filter((other) => other.admissionId !== seed.admissionId
          && other.jobId !== seed.jobId
          && other.acquiredAt <= seed.acquiredAt)
        .flatMap((other) => other.scopes.map((scope) => ({
          admissionId: other.admissionId, resourceId: other.repository, accessMode: scope.accessMode,
          scopeKind: scope.scopeKind, path: scope.path,
        })));
      // findResourceConflictsV1 matches on resourceId; compute per scope so
      // the surviving scope details stay attached to the right repository.
      for (const scope of seed.scopes) {
        const key = `${seed.admissionId}${seed.repository}`;
        if (seen.has(key)) continue;
        const resourceHeld = held.filter((candidate) => candidate.resourceId === seed.repository);
        // The digest is a type-level placeholder: the overlap rule only reads
        // resourceId/accessMode/scopeKind/path, never the digest.
        const requested: ProjectWorkResourceScopeV1 = {
          resourceId: seed.repository,
          resourceKind: "repository",
          resourceConfigurationDigest: `sha256:${"0".repeat(64)}`,
          accessMode: scope.accessMode,
          scopeKind: scope.scopeKind,
          path: scope.path,
        };
        const hits = findResourceConflictsV1([requested], resourceHeld);
        if (hits.length === 0) continue;
        const heldAdmission = seeds.find((candidate) => candidate.admissionId === hits[0]!.heldAdmissionId);
        if (!heldAdmission
          || !isAdmissionId(seed.admissionId) || !isJobId(seed.jobId) || !isLeaseId(seed.leaseId)) continue;
        seen.add(key);
        out.push({
          ledgerId: `conflict:${cleanId(seed.admissionId)}`,
          projectId,
          repository: seed.repository,
          resourceKind: scope.scopeKind,
          resourcePath: scope.path,
          conflictingAdmissionId: seed.admissionId,
          conflictingJobId: seed.jobId,
          conflictingLeaseId: seed.leaseId,
          reasonCode: "resource_overlap",
          raisedAt: seed.acquiredAt,
          resolvedAt: null,
          resolutionKind: null,
        });
      }
    }
    return out.slice(0, 100);
  }

  type AttentionSeed = {
    attentionId: string; projectId: string; severity: "urgent" | "soon" | "normal";
    category: "uncertainty" | "approval" | "review" | "preparation";
    ownerQuestion: string; observedAt: string;
    referencedJobId: string | null; referencedAdmissionId: null;
  };
  async function attentionList(projectId: string): Promise<AttentionSeed[]> {
    // Saved needs-me rows for this project. The stored attention_type
    // vocabulary (approval/question/review/decision) is folded onto the
    // coordination categories the page renders; severity comes from the
    // stored due date against the server clock.
    const rows = (await db.query<{
      id: string; attention_type: string; summary: string; title: string;
      due_at: unknown; observed_at: unknown; work_item_id: string | null;
    }>(
      `SELECT id,attention_type,summary,title,due_at,observed_at,work_item_id
       FROM attention_items WHERE tenant_id=$1 AND project_id=$2
       ORDER BY observed_at DESC LIMIT 50`,
      [tenantId, projectId])).rows;
    const out: AttentionSeed[] = [];
    for (const row of rows) {
      const category = row.attention_type === "approval" || row.attention_type === "decision" ? "approval"
        : row.attention_type === "review" ? "review"
        : row.attention_type === "question" ? "uncertainty" : null;
      if (!category) continue;
      const due = row.due_at ? Date.parse(iso(row.due_at)) : NaN;
      const current = now();
      const severity = Number.isFinite(due) && due <= current ? "urgent"
        : Number.isFinite(due) && due <= current + 86_400_000 ? "soon" : "normal";
      const text = (row.summary || row.title).slice(0, 280);
      if (!text) continue;
      out.push({
        attentionId: `attention:${cleanId(row.id)}`,
        projectId,
        severity,
        category,
        ownerQuestion: text,
        observedAt: iso(row.observed_at),
        referencedJobId: row.work_item_id && isJobId(row.work_item_id) ? row.work_item_id : null,
        referencedAdmissionId: null,
      });
    }
    return out;
  }

  return {
    coordinator,
    async coordinatorVersion(projectId) {
      const head = await headRow(projectId);
      return head ? Number(head.version) : 0;
    },
    async readActiveHead(projectId) {
      const head = await headRow(projectId);
      if (!head) return null;
      return {
        tenantId,
        projectId,
        version: Number(head.version),
        state: head.state as "active" | "revoked",
        coordinatorActorType: head.coordinator_actor_type as "human" | "agent",
        coordinatorIdentityId: head.coordinator_identity_id,
        executorId: head.executor_id,
        adapterId: head.adapter_id,
        connectorProfileDigest: head.connector_profile_digest,
        executionBindingDigest: head.execution_binding_digest,
        appointedAt: iso(head.assigned_at),
        appointedByOwnerIdentityId: head.assigned_by_owner_identity_id,
      };
    },
    async policyVersion(projectId) {
      const policy = await policyRow(projectId);
      return policy ? Number(policy.version) : 0;
    },
    async readDelegationPolicySummary(projectId) {
      const policy = await policyRow(projectId);
      if (!policy) return null;
      const usage = (await db.query<{ task_units: string | number; micro_usd: string | number }>(
        `SELECT COALESCE(SUM(task_units),0) AS task_units,
          COALESCE(SUM(admitted_cost_microusd),0) AS micro_usd
         FROM control_project_coordination_operation_receipts
         WHERE tenant_id=$1 AND policy_id=$2`,
        [tenantId, policy.id])).rows[0];
      const concurrent = (await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM control_jobs j
         WHERE j.tenant_id=$1 AND j.project_id=$2
           AND j.state IN ('leased','running','waiting_approval')
           AND EXISTS (SELECT 1 FROM control_project_coordination_operation_jobs oj
             WHERE oj.tenant_id=j.tenant_id AND oj.canonical_job_id=j.id)`,
        [tenantId, projectId])).rows[0];
      const allowed = typeof policy.allowed_actions === "string"
        ? JSON.parse(policy.allowed_actions) as string[]
        : policy.allowed_actions as string[];
      return {
        tenantId,
        projectId,
        policyId: policy.id,
        coordinatorVersion: Number(policy.coordinator_version),
        state: policy.state as "active" | "paused" | "revoked",
        allowedActions: allowed,
        validFrom: iso(policy.valid_from),
        validUntil: iso(policy.valid_until),
        taskAllowance: Number(policy.max_total_tasks),
        taskUnitsUsed: Number(usage?.task_units ?? 0),
        microUsdCeiling: String(policy.max_total_cost_microusd),
        microUsdUsed: String(usage?.micro_usd ?? 0),
        concurrencyAllowance: Number(policy.max_concurrent_tasks),
        concurrencyUnitsUsed: Number(concurrent?.count ?? 0),
      };
    },
    async conflictsVersion(projectId) {
      const conflicts = await openConflicts(projectId);
      return ledgerRevision(conflicts.map((c) =>
        [c.ledgerId, c.conflictingAdmissionId, c.conflictingJobId, c.conflictingLeaseId,
          c.repository, c.resourceKind, c.resourcePath, c.reasonCode, c.raisedAt].join("|")));
    },
    async attentionVersion(projectId) {
      // Same list the page surfaces: version and payload cannot disagree.
      // Only persisted fields enter the digest (see ledgerRevision).
      const items = await attentionList(projectId);
      return ledgerRevision(items.map((a) =>
        [a.attentionId, a.category, a.ownerQuestion, a.observedAt, a.referencedJobId ?? ""].join("|")));
    },
    async readActiveWork(projectId) {
      // Only coordinator-adopted jobs: the INNER JOINs through the operation
      // ledger mean a job without a saved adoption (and its proposal digest)
      // never appears here. Title comes from the saved request payload the
      // task service itself validates.
      const rows = (await db.query<{
        job_id: string; state: string; updated_at: unknown;
        proposal_id: string; proposal_digest: string | null; title: string | null;
      }>(
        `SELECT j.id AS job_id,j.state,j.updated_at,r.proposal_id,p.proposal_digest,
           req.payload->>'title' AS title
         FROM control_jobs j
         JOIN control_project_coordination_operation_jobs oj
           ON oj.tenant_id=j.tenant_id AND oj.canonical_job_id=j.id
         JOIN control_project_coordination_operation_receipts r
           ON r.tenant_id=oj.tenant_id AND r.id=oj.operation_receipt_id
         JOIN control_project_coordination_proposals p
           ON p.tenant_id=r.tenant_id AND p.id=r.proposal_id
         JOIN control_workflows w ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id
         JOIN control_requests req ON req.tenant_id=w.tenant_id AND req.id=w.request_id
         WHERE j.tenant_id=$1 AND j.project_id=$2
           AND j.state IN ('proposed','ready','leased','running','waiting_approval')
           AND p.proposal_digest IS NOT NULL
         ORDER BY j.updated_at DESC LIMIT 100`,
        [tenantId, projectId])).rows;
      const scopes = (await db.query<{ job_id: string; path: string; access_mode: string }>(
        `SELECT a.job_id,s.path,s.access_mode
         FROM control_attempt_resource_scopes s
         JOIN control_attempt_resource_admissions a
           ON a.tenant_id=s.tenant_id AND a.id=s.admission_id
         WHERE s.tenant_id=$1 AND a.project_id=$2 AND a.state='held'`,
        [tenantId, projectId])).rows;
      const scopesByJob = new Map<string, { read: string[]; write: string[] }>();
      for (const scope of scopes) {
        if (!isRelativePath(scope.path)) continue;
        const entry = scopesByJob.get(scope.job_id) ?? { read: [], write: [] };
        const bucket = scope.access_mode === "write" ? entry.write : entry.read;
        if (!bucket.includes(scope.path) && bucket.length < 20) bucket.push(scope.path);
        scopesByJob.set(scope.job_id, entry);
      }
      const stateMap: Record<string, "proposed" | "leased" | "running" | "waiting" | "review"> = {
        proposed: "proposed", ready: "proposed", leased: "leased",
        running: "running", waiting_approval: "review",
      };
      const out: NonNullable<Awaited<ReturnType<NonNullable<ProjectCoordinationCanonicalStoreAdapter["readActiveWork"]>>>> = [];
      for (const row of rows) {
        const state = stateMap[row.state];
        if (!state || !isJobId(row.job_id) || !isProposalId(row.proposal_id)
          || !row.proposal_digest || !row.title) continue;
        const entry = scopesByJob.get(row.job_id) ?? { read: [], write: [] };
        out.push({
          jobId: row.job_id,
          title: row.title.slice(0, 280),
          state,
          updatedAt: iso(row.updated_at),
          proposalId: row.proposal_id,
          proposalDigest: row.proposal_digest,
          readScopes: entry.read,
          writeScopes: entry.write,
        });
      }
      return out;
    },
    async readDependencies(projectId) {
      // Recorded edges are ordering prerequisites between two saved jobs of
      // this project; every stored edge is required.
      const rows = (await db.query<{ from_job: string; to_job: string }>(
        `SELECT d.job_id AS from_job,d.depends_on_job_id AS to_job
         FROM control_job_dependencies d
         JOIN control_jobs j1 ON j1.tenant_id=d.tenant_id AND j1.id=d.job_id AND j1.project_id=$2
         JOIN control_jobs j2 ON j2.tenant_id=d.tenant_id AND j2.id=d.depends_on_job_id AND j2.project_id=$2
         WHERE d.tenant_id=$1 LIMIT 500`,
        [tenantId, projectId])).rows;
      return rows
        .filter((row) => isJobId(row.from_job) && isJobId(row.to_job))
        .map((row) => ({ fromJobId: row.from_job, toJobId: row.to_job, required: true }));
    },
    async readConflicts(projectId) {
      return openConflicts(projectId);
    },
    async readAttention(projectId) {
      return attentionList(projectId);
    },
    async project(projectId) {
      const row = (await db.query<{
        projectId: string; title: string; summary: string; lifecycle: string;
        version: string | number; createdAt: unknown; updatedAt: unknown;
      }>(
        `SELECT p.id AS "projectId",p.title,coalesce(p.description,'') AS summary,
           h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt"
         FROM projects p
         JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
         WHERE p.tenant_id=$1 AND p.id=$2`,
        [tenantId, projectId])).rows[0];
      if (!row || (row.lifecycle !== "active" && row.lifecycle !== "paused"
        && row.lifecycle !== "completed" && row.lifecycle !== "archived")) {
        throw new WebAccessError("not_found");
      }
      return {
        projectId: row.projectId,
        title: row.title,
        summary: row.summary,
        lifecycle: row.lifecycle,
        version: Number(row.version),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
    async coordinationEnabled() {
      return true;
    },
    bindSession: (session) => buildAdapter(joinAmbientSession(session)),
  };
  };
  return buildAdapter(db);
}
