import type { DatabaseClient } from "../../persistence/database";
import type { AuthenticatedPrincipal } from "../../security";
import type { IntakeCoordinatorResultV1, IntakeSuggestionStoreV1 } from
  "../../work-intake/v1/intake-coordinator";
import { PostgresIntakeOwnerRetryStoreV1 } from "../../work-intake/v1/intake-coordinator-store";
import type { WorkBatchQueueCatalogV1 } from "../../work-intake/v1/queue-catalog";
import { createProjectOrchestrationOwnerAdapterV1, type ProjectOrchestrationOwnerPortV1 } from
  "./project-orchestration-owner";
import { PostgresProjectOrchestrationAccessV1, PostgresProjectOrchestrationBatchRevisionsV1,
  PostgresProjectOrchestrationStoreV1 } from "./project-orchestration-postgres-store";

// The production composition of the owner-facing chief of staff. Until now the
// port had NO composition at all: `options.orchestration` was accepted by both web
// processes and supplied by nobody, so the routes fell through to the generic
// project handler and every ordinary project page paid for that with a 404 and a
// "not connected" alert where the setting should have been.
//
// This builds it from what the installation already has: the same database the
// Settings tab uses, the same protected queue catalog batch review is admitted
// against, and the same proposal-integrity key the work-intake login signs
// suggestions with.
//
// It composes only what is real. Two things are NOT yet real, and are reported as
// such rather than faked:
//
//   planner        -- the planner host. Without one, describing a job is
//     unavailable and the panel says so in plain words. The stored choice still
//     reads and saves, so the owner's selection survives waiting for the switch.
//   dismissals     -- the durable dismissal record. 0200 is append-only and
//     agent-insert-only, so it cannot hold one (see the store's doc comment), and
//     the Dismiss gesture is offered only when a record port is supplied.

/** The coordinator surface the owner adapter needs. It is the work-intake
 * coordinator's own two methods, not a new abstraction: the adapter already speaks
 * the coordinator's result and prefill shapes. */
export interface ProjectOrchestrationCoordinatorHostV1 {
  coordinateInitial(input: Readonly<{ principal: AuthenticatedPrincipal; projectId: string; ownerRequest: string;
    idempotencyKey: string; now: string; signal?: AbortSignal }>): Promise<IntakeCoordinatorResultV1>;
  ownerPrefill(input: Parameters<IntakeSuggestionStoreV1["prefillForOwner"]>[0]):
    ReturnType<IntakeSuggestionStoreV1["prefillForOwner"]>;
}

/** The planner host, when one is running.
 *
 * `principal` is the chief-of-staff agent identity: an ACTIVE agent of this tenant
 * holding exactly `work_batches.propose`, which is what 0200's write guard requires
 * before it accepts a split suggestion. It is never the owner's browser identity,
 * and the adapter refuses to be constructed with any other kind. */
export interface ProjectOrchestrationPlannerHostV1 {
  principal: AuthenticatedPrincipal;
  /** False while a configured planner host is not yet running. Describe is then
   * refused as unavailable rather than run and failing. */
  available: boolean;
}

/** The durable place an owner's dismissal is written. Kept as its own small type so
 * a composition has to supply it explicitly rather than discover it at runtime. */
export interface ProjectOrchestrationDismissalHostV1 {
  record(input: Readonly<{ tenantId: string; projectId: string; batchId: string; suggestionId: string;
    baseRevision: number; baseRevisionDigest: string; ownerIdentityId: string; now: string }>): Promise<void>;
}

/** Builds the owner-facing chief-of-staff service over the installation's own
 * database and catalog.
 *
 * With no coordinator, prefill uses the same durable store directly. Settings
 * and retained suggestions remain usable; description preparation requires
 * both an available planner and its coordinator. */
/** The durable place an owner's deliberate retry is recorded.
 *
 * It is its own type for the same reason the dismissal host is: 0202 gives the
 * owner's web login no privilege at all on the failure counters, so the retry has
 * to be a separate granted operation rather than a method on a store. The default
 * is 0205's SECURITY DEFINER function, and the returned count is what lets the
 * panel say "nothing was granted" instead of silently doing nothing. */
export interface ProjectOrchestrationRetryHostV1 {
  grant(input: Readonly<{ tenantId: string; projectId: string; requestKey: string;
    ownerRequest: string }>): Promise<number>;
}

export function createProjectOrchestrationServiceV1(options: Readonly<{ db: DatabaseClient;
  tenantId: string; workspaceId: string; queueCatalog: WorkBatchQueueCatalogV1;
  /** The proposal-integrity key the work-intake login signs split suggestions
   * with. The prefill read re-derives that HMAC, so a row tampered with since it
   * was written is refused rather than handed to the owner as a plan. */
  integrityKey: Uint8Array; coordinator?: ProjectOrchestrationCoordinatorHostV1;
  planner?: ProjectOrchestrationPlannerHostV1; dismissals?: ProjectOrchestrationDismissalHostV1;
  /** The durable owner-retry grant. The default is 0205's
   * `control_room_planner_grant_owner_retry`, which needs no privilege on the
   * counters beyond EXECUTE on that one function -- so the owner can ask for one
   * more run of an escalated description without the web login ever holding
   * UPDATE on the table. Supply `undefined` to compose a service that does not
   * offer the gesture at all, which is how a partial install behaves. */
  retry?: ProjectOrchestrationRetryHostV1 | false; clock?: () => number }>): ProjectOrchestrationOwnerPortV1 {
  const clock = options.clock ?? Date.now, scope = { tenantId: options.tenantId, workspaceId: options.workspaceId };
  const describeAvailable = !!options.planner?.available && !!options.coordinator;
  if (options.planner && (options.planner.principal.tenantId !== options.tenantId
    || options.planner.principal.actorType !== "agent"))
    throw new Error("project_orchestration_configuration_invalid");
  // Without a planner there is no agent principal to act as, and inventing one
  // would let a describe reach a coordinator as an identity that does not exist.
  // The adapter still needs a value to construct against; describe is refused
  // before the coordinator is ever reached, so the sentinel cannot be used.
  const coordinatorPrincipal = options.planner?.principal
    ?? Object.freeze({ tenantId: options.tenantId, identityId: "identity:chief-of-staff-unavailable",
      actorType: "agent" as const, authenticatedAt: new Date(clock()).toISOString(),
      expiresAt: new Date(clock() + 60_000).toISOString() });
  const store = new PostgresProjectOrchestrationStoreV1(options.db, scope, clock, options.integrityKey);
  return Object.freeze(createProjectOrchestrationOwnerAdapterV1({
    tenantId: options.tenantId, coordinatorPrincipal,
    coordinator: Object.freeze({
      // The last gate before a planner run: a composition with no available planner
      // host throws here rather than reaching a coordinator as a principal that
      // does not exist. Defence in depth behind `describeAvailable: false`.
      coordinateInitial: (input: Readonly<{ principal: AuthenticatedPrincipal; projectId: string;
        ownerRequest: string; idempotencyKey: string; now: string; signal?: AbortSignal }>) => {
        if (!describeAvailable) throw new Error("project_orchestration_planner_unavailable");
        return options.coordinator!.coordinateInitial(input);
      },
      ownerPrefill: (input: Parameters<ProjectOrchestrationCoordinatorHostV1["ownerPrefill"]>[0]) =>
        options.coordinator ? options.coordinator.ownerPrefill(input) : store.prefillForOwner(input) }),
    store,
    access: new PostgresProjectOrchestrationAccessV1(options.db, scope, clock),
    batches: new PostgresProjectOrchestrationBatchRevisionsV1(options.db, options.tenantId),
    queueCatalog: options.queueCatalog, describeAvailable,
    ...(options.dismissals ? { dismissals: options.dismissals } : {}),
    // `false` is an explicit "no retry record here", and is honoured as such: a
    // default that cannot be switched off would offer a button whose call
    // 404s, which is the F8 dead end this feature exists to close.
    ...(options.retry === false ? {}
      : { retry: options.retry ?? new PostgresIntakeOwnerRetryStoreV1(options.db) }),
    clock }));
}