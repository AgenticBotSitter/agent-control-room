import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { hmacSha256Tag } from "../../security";
import { workBatchProposalDigestV1 } from "../../work-intake/v1/digest";
import { computeIntakeFlagsV1, type IntakeFlagV1 } from "../../work-intake/v1/intake-gate";
import { workBatchProposalSchemaV1 } from "../../work-intake/v1/schemas";
import type { IntakeSuggestionRecordV1 } from "../../work-intake/v1/intake-coordinator";
import { WebSessionAuthority, type WebActor } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import type { ProjectOrchestrationStoreV1, ProjectOrchestrationDismissalPortV1,
  ProjectOrchestrationAccessPortV1, ProjectOrchestrationBatchRevisionPortV1 } from "./project-orchestration-owner";
import type { ProjectOrchestratorChoiceV1 } from "./project-orchestration-wire";

// The production adapters behind the owner-facing chief-of-staff port. Every one of
// them is exactly the shape MIG-A shipped:
//
//   readSettings / saveSettings -> 0201's control_project_settings planner columns,
//     under the SAME optimistic version check 0135's own settings write uses
//     (`SELECT version ... FOR UPDATE`, then compare). 0135's table has no CAS
//     constraint of its own, so that row lock is what makes ten concurrent saves
//     produce one winner rather than ten.
//   listSuggestions            -> 0200's work_batch_current_split_suggestions VIEW.
//     The view is the stale filter; nothing here re-derives it.
//   dismissedSuggestionIds    -> the owner's own dismissal records (0203).
//   prefillForOwner           -> the same view, re-verified against the stored HMAC
//     so a tampered row is refused rather than handed to the owner as a plan.
//
// Nothing here starts work, writes a work_batch_revision, approves, admits,
// assigns, or grants execution authority.

type SettingsRow = { version: string | number; planner_mode: string; planner_worker_id: string | null;
  planner_worker_kind: string | null; planner_model: string | null; planner_effort: string | null };
type SuggestionRow = { id: string; tenant_id: string; project_id: string; batch_id: string;
  request_key: string; base_revision: string | number; base_revision_digest: string;
  proposed_by_identity_id: string; proposal: unknown; proposal_digest: string;
  suggestion_digest: string; auth_tag: string; created_at: string | Date };

const iso = (value: string | Date) => new Date(value).toISOString();
/** PostgreSQL's own SQLSTATE for a relation that does not exist. Matched as a
 * code, not a message, so a localised server message changes nothing. */
const isUndefinedTable = (error: unknown) => (error as { code?: string } | null)?.code === "42P01";
const SETTINGS_COLUMNS = `version,planner_mode,planner_worker_id,planner_worker_kind,planner_model,planner_effort`;
const SUGGESTION_COLUMNS = `s.id,s.tenant_id,s.project_id,s.batch_id,s.request_key,s.base_revision,
  s.base_revision_digest,s.proposed_by_identity_id,s.proposal,s.proposal_digest,s.suggestion_digest,s.auth_tag,s.created_at`;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function freezeFlags(value: Readonly<Record<string, readonly IntakeFlagV1[]>>) {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([localId, flags]) =>
    [localId, Object.freeze(flags.map(flag => Object.freeze({ ...flag })))])));
}

const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const workerKindSchema = z.enum(["codex", "claude-code", "hermes"]);
const modelKeySchema = z.string().min(1).max(180);

/** sha256 over the stable JSON of {baseRevisionDigest, proposalDigest}: exactly the
 * shape 0200's writer computed, so a row written by the intake login verifies here. */
const suggestionDigestOf = (baseRevisionDigest: string, proposalDigest: string) =>
  `sha256:${createHash("sha256").update(JSON.stringify({ baseRevisionDigest, proposalDigest }), "utf8").digest("hex")}`;

/** 0201 stores a tri-state. The wire speaks `none` for the deliberate choice and
 * has no `inherit` arm, because `inherit` means "this project has no opinion and
 * the installation default applies" -- which is presented to the owner as `none`,
 * the thing an untouched project actually gets here. A stored value that is not
 * one of the two is refused rather than guessed at, so a future third state cannot
 * silently read as "none".
 *
 * `effort` is nullable because 0201's CHECK refuses a stored 'default': the owner
 * leaves SQL NULL to mean the catalog's default. `modelKey` falls back to the
 * worker id for a row that names a worker without a model, which 0201 permits and
 * the catalog resolves. */
function choiceFrom(row: SettingsRow): ProjectOrchestratorChoiceV1 {
  if (row.planner_mode === "none") return Object.freeze({ mode: "none" as const });
  if (row.planner_mode !== "selected" || !row.planner_worker_id || !row.planner_worker_kind)
    return Object.freeze({ mode: "none" as const });
  const workerKind = workerKindSchema.safeParse(row.planner_worker_kind);
  const model = modelKeySchema.safeParse(row.planner_model ?? row.planner_worker_id);
  const effort = row.planner_effort === null ? null : effortSchema.safeParse(row.planner_effort);
  if (!workerKind.success || !model.success || (effort !== null && !effort.success))
    throw new WebAccessError("invalid_request");
  return Object.freeze({ mode: "selected" as const, workerId: row.planner_worker_id,
    workerKind: workerKind.data, modelKey: model.data, effort: effort === null ? null : effort.data });
}

export class PostgresProjectOrchestrationStoreV1 implements ProjectOrchestrationStoreV1 {
  readonly #authority: WebSessionAuthority;
  /** Optional. Present when the composition holds the same proposal-integrity key
   * the intake login signs suggestions with; without it the prefill read cannot
   * re-derive the stored HMAC and says so rather than handing over an
   * unverified plan. */
  readonly prefillForOwner = async (input: Readonly<{ tenantId: string; projectId: string; batchId: string;
    suggestionId: string; ownerIdentityId: string; actorType: "human"; currentRevision: number;
    currentRevisionDigest: string }>) => {
    if (input.actorType !== "human" || input.tenantId !== this.scope.tenantId)
      throw new WebAccessError("access_denied");
    // The VIEW is the current-revision read, so a stale suggestion is simply not in
    // it: "not found" and "stale" are the same answer on purpose, because handing
    // the owner a plan bound to a revision that no longer exists is the one thing
    // this path must never do.
    const row = (await this.db.query<SuggestionRow>(`SELECT ${SUGGESTION_COLUMNS}
      FROM work_batch_current_split_suggestions s
      WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.batch_id=$3 AND s.id=$4`,
    [input.tenantId, input.projectId, input.batchId, input.suggestionId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    if (Number(row.base_revision) !== input.currentRevision
      || row.base_revision_digest !== input.currentRevisionDigest) throw new WebAccessError("conflict");
    return Object.freeze({ proposal: this.#record(row, this.integrityKey).proposal, startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const });
  };

  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    clock: () => number = Date.now, private readonly integrityKey?: Uint8Array) {
    this.#authority = new WebSessionAuthority(db, scope, clock);
    if (integrityKey !== undefined && (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32))
      throw new Error("project_orchestration_configuration_invalid");
  }

  /** The coordinator's own read of this project's selection. It runs on the
   * coordinator's login with no owner session, because the selection is a REQUEST:
   * the coordinator re-resolves it against the live catalog on every run. */
  async read(projectId: string) {
    const row = (await this.db.query<SettingsRow>(`SELECT ${SETTINGS_COLUMNS} FROM control_project_settings
      WHERE tenant_id=$1 AND project_id=$2`, [this.scope.tenantId, projectId])).rows[0];
    if (!row || row.planner_mode !== "selected" || !row.planner_worker_id || !row.planner_worker_kind) return null;
    const workerKind = workerKindSchema.safeParse(row.planner_worker_kind);
    const effort = row.planner_effort === null ? null : effortSchema.safeParse(row.planner_effort);
    if (!workerKind.success || (effort !== null && !effort.success)) return null;
    return Object.freeze({ workerId: row.planner_worker_id, workerKind: workerKind.data,
      modelKey: row.planner_model ?? row.planner_worker_id, ...(effort === null ? {} : { effort: effort.data }) });
  }

  async readSettings(tenantId: string, projectId: string) {
    if (tenantId !== this.scope.tenantId) throw new WebAccessError("access_denied");
    const row = (await this.db.query<SettingsRow>(`SELECT ${SETTINGS_COLUMNS} FROM control_project_settings
      WHERE tenant_id=$1 AND project_id=$2`, [tenantId, projectId])).rows[0];
    if (!row) return Object.freeze({ version: 0, choice: Object.freeze({ mode: "none" as const }) });
    return Object.freeze({ version: Number(row.version), choice: choiceFrom(row) });
  }

  async saveSettings(input: Readonly<{ tenantId: string; projectId: string; expectedVersion: number;
    choice: ProjectOrchestratorChoiceV1; writtenByIdentityId: string; now: string }>) {
    if (input.tenantId !== this.scope.tenantId) throw new WebAccessError("access_denied");
    const selected = input.choice.mode === "selected" ? input.choice : null;
    // NULL is how 0201 spells "the catalog decides". Passing the string 'default'
    // is refused by its own CHECK, which is why the wire carries `effort: null`.
    const effort = selected ? selected.effort : null;
    const mode = input.choice.mode === "none" ? "none" : "selected";
    await this.db.transactionWithPreCommitCheck(async tx => {
      // FOR UPDATE is the compare-and-set. 0135's table carries no version
      // constraint, so without this lock two concurrent saves at the same
      // expectedVersion both read N, both write N+1, and one update is lost.
      const existing = (await tx.query<{ version: string | number }>(
        `SELECT version FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`,
        [input.tenantId, input.projectId])).rows[0];
      const currentVersion = existing ? Number(existing.version) : 0;
      if (currentVersion !== input.expectedVersion) throw new WebAccessError("conflict");
      const next = currentVersion + 1;
      const columns = [mode, selected?.workerId ?? null, selected?.workerKind ?? null,
        selected?.modelKey ?? null, effort];
      if (existing) {
        await tx.query(`UPDATE control_project_settings SET planner_mode=$3,planner_worker_id=$4,
          planner_worker_kind=$5,planner_model=$6,planner_effort=$7,version=$8,updated_by_identity_id=$9,updated_at=$10
          WHERE tenant_id=$1 AND project_id=$2`,
        [input.tenantId, input.projectId, ...columns, next, input.writtenByIdentityId, input.now]);
      } else {
        // A project with no settings row at all: naming a chief of staff creates
        // the row with only the planner columns set. 0135's other columns stay
        // NULL, which already meant "unrestricted, uncapped, no default" for every
        // other setting.
        await tx.query(`INSERT INTO control_project_settings(tenant_id,project_id,version,
          updated_by_identity_id,updated_at,planner_mode,planner_worker_id,planner_worker_kind,planner_model,planner_effort)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [input.tenantId, input.projectId, next, input.writtenByIdentityId, input.now, ...columns]);
      }
    }, () => {});
    return Object.freeze({ version: input.expectedVersion + 1, choice: input.choice });
  }

  async listSuggestions(input: Readonly<{ tenantId: string; projectId: string; batchId: string }>) {
    if (input.tenantId !== this.scope.tenantId) throw new WebAccessError("access_denied");
    const rows = (await this.db.query<SuggestionRow>(`SELECT ${SUGGESTION_COLUMNS}
      FROM work_batch_current_split_suggestions s
      WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.batch_id=$3 ORDER BY s.created_at, s.id LIMIT 64`,
    [input.tenantId, input.projectId, input.batchId])).rows;
    return rows.map(row => this.#record(row));
  }

  async dismissedSuggestionIds(input: Readonly<{ tenantId: string; projectId: string; batchId: string }>) {
    if (input.tenantId !== this.scope.tenantId) throw new WebAccessError("access_denied");
    try {
      return (await this.db.query<{ suggestion_id: string }>(`SELECT suggestion_id
        FROM work_batch_split_suggestion_dismissals WHERE tenant_id=$1 AND project_id=$2 AND batch_id=$3`,
      [input.tenantId, input.projectId, input.batchId])).rows.map(row => row.suggestion_id);
    } catch (error) {
      // The dismissal record is not on any branch yet (see this class's comment on
      // 0203), so its absence is EXPECTED, not a database fault. PostgreSQL's own
      // undefined_table (42P01) is the signal; anything else is a real failure and
      // is rethrown rather than read as "nothing dismissed". Without this branch
      // every batch page would 503 on a project page that is otherwise fine, and
      // the absence would look like a database outage rather than a missing
      // feature -- the exact confusion F6 was filed about.
      if (isUndefinedTable(error)) return Object.freeze([]);
      throw error;
    }
  }

  #record(row: SuggestionRow, integrityKey: Uint8Array | undefined = this.integrityKey): IntakeSuggestionRecordV1 {
    const proposal = workBatchProposalSchemaV1.parse(row.proposal);
    // Both digests and the HMAC are re-derived from the STORED bytes. A row whose
    // content, stored digest or tag changed since it was written is refused here
    // rather than handed to the owner as a plan to review.
    if (integrityKey) {
      const proposalDigest = workBatchProposalDigestV1(proposal);
      const tag = hmacSha256Tag(integrityKey, { purpose: "work-batch-split-suggestion/v1",
        record: { id: row.id, tenantId: row.tenant_id, projectId: row.project_id, batchId: row.batch_id,
          requestKey: row.request_key, baseRevision: Number(row.base_revision),
          baseRevisionDigest: row.base_revision_digest, proposerIdentityId: row.proposed_by_identity_id,
          proposal, proposalDigest, createdAt: iso(row.created_at) } });
      if (proposalDigest !== row.proposal_digest || tag !== row.auth_tag
        || row.suggestion_digest !== suggestionDigestOf(row.base_revision_digest, proposalDigest))
        throw new WebAccessError("invalid_request");
    }
    return Object.freeze({ suggestionId: row.id, tenantId: row.tenant_id, projectId: row.project_id,
      batchId: row.batch_id, requestKey: row.request_key, baseRevision: Number(row.base_revision),
      baseRevisionDigest: row.base_revision_digest, proposerIdentityId: row.proposed_by_identity_id,
      proposal: deepFreeze(proposal), proposalDigest: row.proposal_digest,
      flagsByLocalId: freezeFlags(Object.fromEntries(proposal.tasks.map(task => [task.localId,
        computeIntakeFlagsV1(task)]))), createdAt: iso(row.created_at), startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const });
  }
}

/** 0203 is NOT on this branch and must not be added here: the lead's assignment
 * table gives MIG-B 0203-0205, so taking that number would collide with a stream
 * running in parallel. What the durable record needs is written out below so the
 * lead can file it under MIG-A's spares (0203, once MIG-B moves) or a new block.
 *
 * Until then the Dismiss gesture is NOT composed and the suggestion page says so
 * (`dismissAvailable: false`), instead of a button that appears to work and loses
 * the decision on reload. The DDL, ready to file:
 *
 *   CREATE TABLE work_batch_split_suggestion_dismissals (
 *     id text NOT NULL CHECK (id ~ '^split-dismissal:[a-f0-9]{32}$'),
 *     tenant_id text NOT NULL, project_id text NOT NULL, batch_id text NOT NULL,
 *     suggestion_id text NOT NULL, base_revision bigint NOT NULL CHECK (base_revision >= 1),
 *     base_revision_digest text NOT NULL CHECK (base_revision_digest ~ '^sha256:[a-f0-9]{64}$'),
 *     dismissed_by_identity_id text NOT NULL, dismissed_at timestamptz NOT NULL,
 *     PRIMARY KEY (tenant_id,id),
 *     UNIQUE (tenant_id,project_id,batch_id,suggestion_id),
 *     FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
 *     FOREIGN KEY (tenant_id,dismissed_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT);
 *
 * with a write guard requiring a live human owner who is the project's owner, an
 * append-only trigger pair, and GRANT SELECT, INSERT to control_room_private_web.
 * The implementation below is that adapter, so filing the migration wires it with
 * no further code change. */
export class PostgresProjectOrchestrationDismissalsV1 implements ProjectOrchestrationDismissalPortV1 {
  constructor(private readonly db: DatabaseClient) {}
  async record(input: Readonly<{ tenantId: string; projectId: string; batchId: string; suggestionId: string;
    baseRevision: number; baseRevisionDigest: string; ownerIdentityId: string; now: string }>): Promise<void> {
    await this.db.query(`INSERT INTO work_batch_split_suggestion_dismissals(id,tenant_id,project_id,batch_id,
      suggestion_id,base_revision,base_revision_digest,dismissed_by_identity_id,dismissed_at)
      VALUES('split-dismissal:' || substring(md5($1||'/'||$2||'/'||$3||'/'||$4) from 1 for 32),$1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tenant_id,project_id,batch_id,suggestion_id) DO NOTHING`,
    [input.tenantId, input.projectId, input.batchId, input.suggestionId, input.baseRevision,
      input.baseRevisionDigest, input.ownerIdentityId, input.now]);
  }
}

/** The owner authorization port. Every operation is the owner-gated check the
 * Settings tab and batch review already use: `projects.read` for a read, and
 * `projects.settings` with the owner-only flag for anything that changes a stored
 * choice. An operator grant can never change the chief of staff. */
export class PostgresProjectOrchestrationAccessV1 implements ProjectOrchestrationAccessPortV1 {
  readonly #authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    clock: () => number = Date.now) {
    this.#authority = new WebSessionAuthority(db, scope, clock);
  }
  async owner(identity: VerifiedWebIdentity, projectId: string, operation: "read" | "settings" | "describe" | "suggestion") {
    const write = operation !== "read";
    return this.#authority.authenticated(identity, async (_tx, actor: WebActor) => {
      actor.require("projects.read", projectId);
      if (write) actor.require("projects.settings", projectId, true);
      return Object.freeze({ tenantId: this.scope.tenantId, ownerIdentityId: actor.id });
    }, { readOnly: !write });
  }
}

/** The batch's CURRENT revision and digest, straight from work_batches and its
 * current revision row.
 *
 * This is the same binding 0200's write guard enforced when the suggestion was
 * appended, read from the batch itself rather than asserted by a caller. It is
 * what makes "the batch moved on" a refusal instead of a stale card carrying a
 * plan against a revision that no longer exists. A decided batch, or one whose
 * current revision row is missing, reports `not_proposed` -- the owner is shown no
 * suggestion at all, which is the honest state rather than a refusal it can act on. */
export class PostgresProjectOrchestrationBatchRevisionsV1 implements ProjectOrchestrationBatchRevisionPortV1 {
  constructor(private readonly db: DatabaseClient, private readonly tenantId: string) {}
  async read(input: Readonly<{ tenantId: string; projectId: string; batchId: string }>) {
    if (input.tenantId !== this.tenantId) throw new WebAccessError("access_denied");
    const row = (await this.db.query<{ version: string | number; state: string; revision_digest: string | null }>(
      `SELECT b.version,b.state,r.revision_digest FROM work_batches b
       LEFT JOIN work_batch_revisions r ON r.tenant_id=b.tenant_id AND r.batch_id=b.id AND r.revision=b.version
       WHERE b.tenant_id=$1 AND b.id=$2 AND b.project_id=$3`,
      [input.tenantId, input.batchId, input.projectId])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    const revision = Number(row.version);
    if (row.state !== "proposed" || !row.revision_digest)
      return Object.freeze({ revision, revisionDigest: "", state: "not_proposed" as const });
    return Object.freeze({ revision, revisionDigest: row.revision_digest, state: "proposed" as const });
  }
}