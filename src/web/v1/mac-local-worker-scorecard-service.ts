import { WebSessionAuthority, type WebActor } from "./session-authority";
import type { VerifiedWebIdentity } from "./access-verifier";
import type { DatabaseClient } from "../../persistence/database";
import { DatabaseWorkerScorecardReadSourceV1, type WorkerScorecardReadV1 } from "./worker-scorecard-read";

/**
 * The Mac-local owner read behind `/api/v1/workers-scorecard`.
 *
 * Two separate steps, in this order on purpose:
 *
 *  1. `authorize` completes the owner `projects.read` decision inside the web
 *     login's own read-only transaction, through the same `WebSessionAuthority`
 *     every other owner read uses. A signed-out caller is refused here, before
 *     any pipeline record is read.
 *  2. The grouped read then runs on the SAME web connection, but OUTSIDE that
 *     transaction. Holding a web transaction open while the scorecard query
 *     scans `pipeline_stage_runs` and the completion gate is how a single-
 *     database installation deadlocks itself: the gate's integrity head and the
 *     publisher that wants it both wait on locks this read is already holding.
 *     The scope is the immutable `{tenantId, workspaceId}` composition captured
 *     at construction, so nothing between the two steps can widen it.
 *
 * The tenant and workspace come from the composition, never from the request.
 * `DatabaseWorkerScorecardReadSourceV1` applies `workspaceId` in SQL, so another
 * workspace's build stages are never read into this process at all — not
 * filtered out afterwards, which would mean they had already been held.
 */
export class MacLocalWorkerScorecardServiceV1 {
  private readonly authority: WebSessionAuthority;

  constructor(db: DatabaseClient, private readonly scope: Readonly<{ tenantId: string; workspaceId: string }>,
    clock: () => number = Date.now,
    private readonly source: { read(input: { tenantId: string; workspaceId: string; now: string }): Promise<WorkerScorecardReadV1> }
      = new DatabaseWorkerScorecardReadSourceV1(db)) {
    this.authority = new WebSessionAuthority(db, scope, clock);
  }

  /** Owner-only. Read-only locks: concurrent scorecard reads may share a pool
   * connection, and a revocation still waits for the reads already admitted. */
  private async authorize(identity: VerifiedWebIdentity): Promise<WebActor> {
    return this.authority.authenticated(identity, async (_, actor) => {
      actor.require("projects.read", undefined, true);
      return actor;
    }, { readOnly: true });
  }

  async read(identity: VerifiedWebIdentity): Promise<WorkerScorecardReadV1> {
    const actor = await this.authorize(identity);
    return this.source.read({ tenantId: this.scope.tenantId, workspaceId: this.scope.workspaceId, now: actor.now });
  }
}