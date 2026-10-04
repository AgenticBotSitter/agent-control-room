// The ONE admissible-lifecycle read for automatic proposal admission.
//
// Archive is the owner's own transition. `WebProjectService.transition()` opens its
// command with a `SELECT ... FOR UPDATE OF p,h` over `projects p JOIN
// control_manual_project_heads h`, then writes `heads.lifecycle`. Admission is a
// different transaction that INSERTS new work, and before this module it read only
// `projects`, which has no lifecycle column: a project the owner had archived still
// looked live to the recurring scheduler, to canonical scheduled admission, and to the
// machine intake lane. The observable result was new proposals, a new open approval
// and a new owner notification after the owner had explicitly stopped caring.
//
// Two facts, both measured on PostgreSQL 17 against real production logins, decide the
// shape of this query (see the probe ledger; re-measuring is cheap, guessing is not):
//
//   1. `FOR SHARE`/`FOR UPDATE` over BOTH tables needs UPDATE privilege on the head
//      table. `control_room_work_intake_agent` holds SELECT on `projects` and a
//      column-level UPDATE on `projects.coordinator_lock` only; `control_room_schedule_
//      admissions` holds SELECT and no UPDATE at all. A fence that locked the head row
//      would therefore be refused 42501 by both restricted logins that run these paths.
//   2. `FOR SHARE OF p,h` is refused outright where `h` is the nullable side of an
//      outer join, and a LEFT JOIN is required here because not every project has a
//      head row at all (see below).
//
// So this reads the head WITHOUT locking it and locks `projects` instead. That is a
// real fence, not a weaker stand-in, because archive's own write path cannot reach the
// head row without first taking the `projects` row lock: its `FOR UPDATE OF p,h` locks
// `p` and `h` together before it writes. An archive that arrives while this read holds
// that lock waits for this transaction to commit. Measured on PostgreSQL 17, at READ
// COMMITTED, twenty deterministic two-connection runs per ordering: an archive that
// commits while an admission is already waiting on `projects` makes the waiting
// admission REFUSE, and an admission that holds `projects` first commits before the
// archive. Whichever transaction wins that lock, the proposal is ordered strictly
// before or strictly after the archive. Neither interleaves.
//
// ## Why this is TWO statements and not one joined SELECT
//
// The first version read `p.workspace_id, h.lifecycle, p.domain_state` from a single
// `LEFT JOIN` with `FOR SHARE OF p`. Measured on PostgreSQL 17, that admits work into a
// project the owner had already archived, and the reason is the executor rather than
// the query: `ExecLockRows` fetches the JOINED tuple before it locks anything, so the
// head tuple is already bound when the statement blocks on `projects`, and
// `EvalPlanQualFetchRowMark` then refetches only the LOCKED relation's row (by its
// original CTID, under SnapshotAny). The recheck therefore refreshes `projects` and
// leaves the unlocked `control_manual_project_heads` tuple at the value it had when the
// statement started -- an OLD 'active' head beside a NEW
// 'manual_project_archived' `projects` row. The guard below prefers the head, so it
// admitted. Reproduced deterministically against real production logins; see
// tests/r6proj-project-admission-postgres.test.ts.
//
// So the `projects` row is read and locked ALONE, and the head is read in a SEPARATE
// statement afterwards, while the `projects` lock is still held. Under READ COMMITTED
// each statement takes a fresh snapshot, so the second statement sees every head write
// that committed before it began -- including the archive that was waiting when the
// first statement was, and every archive before it. Nothing writes the head without
// taking the `projects` lock first (src/web/v1/project-service.ts is the only writer of
// the head row, and it locks `p` and `h` together), so there is no window in which the
// second statement can miss an archive.
//
// Two statements also cost no extra lock and no extra privilege: the head is still only
// SELECTed, never locked, so neither restricted login needs UPDATE on it.
//
// ## Why the lifecycle vocabulary is read from two places
//
// `control_manual_project_heads.lifecycle` is where ORDINARY projects keep it. IDEA
// projects do not get a head row: idea-lab's store writes `projects.domain_state` as
// `idea_project_<state>` and keeps the authoritative snapshot in
// `control_project_lifecycle_events`. Both spellings use the same four words
// (active/paused/completed/archived), so this reads whichever the project actually has.
//
// A project whose lifecycle cannot be established from either place yields
// `lifecycle: undefined`, and every caller treats that as NOT admissible. Unknown is not
// active: admitting new work into a project whose lifecycle we cannot read would be the
// same defect this module exists to close.
//
// ## Replay
//
// Both callers consult their own durable idempotency record BEFORE calling this, so an
// already-committed exact replay is returned rather than re-decided. This module never
// sees a replay, which is what lets it be a single unconditional gate on NEW work.

import type { DatabaseSession } from "./database";

/**
 * The lifecycle states that admit NEW automatic work.
 *
 * Read from the product's stored vocabulary rather than repeated per call site, so
 * adding a lifecycle state to the product is a change here and the tests below fail
 * when the two encodings stop agreeing.
 */
const ADMISSIBLE_LIFECYCLE_STATES: ReadonlySet<string> = Object.freeze(new Set(["active"]));

/** The Idea mirror's spelling, exactly as idea-lab's store writes it. */
const IDEA_PREFIX = "idea_project_";

export type AdmissibleProjectLifecycleV1 = Readonly<{
  workspaceId: string;
  lifecycle: string | undefined;
}>;

/**
 * Read one project's current lifecycle inside the caller's own transaction, taking
 * the `projects` row lock that serialises this read against a concurrent archive.
 *
 * `FOR UPDATE` rather than `FOR SHARE` on purpose: both admit new work, and `FOR
 * UPDATE` is what archive itself takes, so the two cannot both hold it. The caller
 * must already hold whatever other locks its own lock order requires; this is called
 * before the idempotency row is touched, so no cycle can form with it.
 *
 * Requires READ COMMITTED, which is the product default everywhere these paths run
 * (src/web/v1/session-authority.ts opts into REPEATABLE READ only for the read-only
 * page composition, never for a write transaction). The second statement is only a
 * correct fence under READ COMMITTED: a REPEATABLE READ transaction would keep the
 * snapshot its FIRST statement took, and would see the same stale head this module was
 * changed to stop reading.
 *
 * Returns `undefined` only when the project does not exist.
 */
export async function readAdmissibleProjectLifecycleInSessionV1(
  tx: DatabaseSession,
  tenantId: string,
  projectId: string,
  lockClause: "FOR SHARE" | "FOR UPDATE" = "FOR SHARE",
): Promise<AdmissibleProjectLifecycleV1 | undefined> {
  // TWO statements, deliberately, and the second one is what makes the fence a fence.
  //
  // The lock clause interpolates only from the closed set above -- never from caller
  // text.
  //
  // 1. `projects` ALONE, under the caller's chosen row lock. This is the row the
  //    owner's archive transition has to take before it can write the head, so holding
  //    it is what serialises the two transactions. Blocking here is correct and brief:
  //    the lock is released at this transaction's commit or rollback.
  const projects = await tx.query<{ workspace_id: string; domain_state: string }>(
    `SELECT p.workspace_id, p.domain_state
       FROM projects p
      WHERE p.tenant_id=$1 AND p.id=$2
      ${lockClause} OF p`, [tenantId, projectId]);
  const project = projects.rows[0];
  if (!project) return undefined;
  // 2. The head, in a SEPARATE statement while the `projects` lock is still held.
  //
  //    A single joined SELECT with `OF p` would be WRONG here, and was: PostgreSQL
  //    binds the joined tuple before it locks, and its recheck after the lock wait
  //    refreshes only the locked relation, so a waiting admission could recheck the
  //    UPDATED `projects` row and keep the OLD unlocked `h.lifecycle` -- and prefer it,
  //    because this module reads the head first. Measured on PostgreSQL 17 against the
  //    real production logins; see the header. Read committed means this statement
  //    gets a fresh snapshot, so it sees the head as of after the archive committed,
  //    and the `projects` lock proves no archive is still in flight behind it.
  const heads = await tx.query<{ lifecycle: string | null }>(
    `SELECT h.lifecycle
       FROM control_manual_project_heads h
      WHERE h.tenant_id=$1 AND h.project_id=$2`, [tenantId, projectId]);
  return Object.freeze({ workspaceId: project.workspace_id,
    lifecycle: heads.rows[0]?.lifecycle ?? (project.domain_state.startsWith(IDEA_PREFIX)
      ? project.domain_state.slice(IDEA_PREFIX.length) : undefined) });
}

/**
 * Whether this lifecycle admits new automatic work.
 *
 * `undefined` is refused on purpose: it means the project's lifecycle could not be
 * established, which is not evidence that the project is live.
 */
export function admitsNewAutomaticWorkV1(lifecycle: string | undefined): boolean {
  return lifecycle !== undefined && ADMISSIBLE_LIFECYCLE_STATES.has(lifecycle);
}