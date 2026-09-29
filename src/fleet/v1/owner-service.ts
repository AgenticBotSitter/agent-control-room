import { appendAuditWith } from "../../audit/audit-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { WebSessionAuthority, type WebActor } from "../../web/v1/session-authority";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { fleetFail } from "./errors";
import { FLEET_CAPABILITY_PATTERN_V1, FLEET_CODE_LIFETIME_MS_V1, FLEET_ENTITY_ID_PATTERN_V1,
  FLEET_PROJECT_ID_PATTERN_V1, FLEET_WORKER_ID_PATTERN_V1, FLEET_WORKER_KIND_PATTERN_V1, newFleetCodeV1,
  plainSha256V1, randomHexV1 } from "./identifiers";

/** Worker kinds offered in the owner form. "mcp-agent" is any other agent
 * that connects only through the MCP tools. */
export const FLEET_WORKER_KINDS_V1 = Object.freeze(["codex", "claude-code", "hermes", "mcp-agent"] as const);
/** Plain capability labels an owner can grant and an offer can require. */
export const FLEET_CAPABILITIES_V1 = Object.freeze(["code.change", "code.review", "research", "writing", "testing"] as const);

const iso = (value: string | Date) => new Date(value).toISOString();
const displayPattern = /^[^\u0000-\u001F\u007F]{1,80}$/u;

export type FleetOwnerServiceOptionsV1 = Readonly<{ tenantId: string; workspaceId: string; clock?: () => number;
  /** Server composition hook: apply owner decisions to canonical state now,
   * on the gateway login. Never supplied by a browser. */
  afterDecision?: () => Promise<unknown> }>;

function list(value: unknown, pattern: RegExp, max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || value.some(item => typeof item !== "string" || !pattern.test(item)))
    return fleetFail("invalid");
  const items = [...new Set(value as string[])];
  if (items.length !== value.length) return fleetFail("invalid");
  return items;
}

export class FleetOwnerServiceV1 {
  readonly #authority: WebSessionAuthority;
  readonly #tenantId: string;
  readonly #clock: () => number;
  readonly #after?: () => Promise<unknown>;
  constructor(private readonly db: DatabaseClient, options: FleetOwnerServiceOptionsV1) {
    this.#tenantId = options.tenantId;
    this.#clock = options.clock ?? Date.now;
    this.#after = options.afterDecision;
    this.#authority = new WebSessionAuthority(db, { tenantId: options.tenantId, workspaceId: options.workspaceId }, this.#clock);
  }

  async #settle() {
    // Canonical application is best-effort here and repeated on the gateway's
    // timer; the owner's recorded decision is already durable.
    try { await this.#after?.(); } catch { /* retried by the gateway reconcile loop */ }
  }

  async #projectsExist(tx: DatabaseSession, projectIds: readonly string[]) {
    const rows = (await tx.query<{ id: string }>(`SELECT id FROM projects WHERE tenant_id=$1 AND id=ANY($2::text[])`,
      [this.#tenantId, [...projectIds]])).rows;
    if (rows.length !== projectIds.length) fleetFail("invalid");
  }

  /** "Add a worker": one short-lived, single-use code scoped to what this
   * machine may do. The code is returned once and never stored. */
  async createEnrollmentCode(identity: VerifiedWebIdentity, input: Readonly<{ displayName: unknown; workerKind: unknown;
    projectIds: unknown; capabilities: unknown; maxConcurrent?: unknown }>) {
    const displayName = typeof input.displayName === "string" && displayPattern.test(input.displayName.trim())
      ? input.displayName.trim() : fleetFail("invalid");
    const workerKind = typeof input.workerKind === "string" && FLEET_WORKER_KIND_PATTERN_V1.test(input.workerKind)
      && (FLEET_WORKER_KINDS_V1 as readonly string[]).includes(input.workerKind) ? input.workerKind : fleetFail("invalid");
    const projectIds = list(input.projectIds, FLEET_PROJECT_ID_PATTERN_V1, 20);
    const capabilities = list(input.capabilities, FLEET_CAPABILITY_PATTERN_V1, 16);
    const maxConcurrent = input.maxConcurrent === undefined ? 1 : Number.isSafeInteger(input.maxConcurrent)
      && (input.maxConcurrent as number) >= 1 && (input.maxConcurrent as number) <= 8 ? input.maxConcurrent as number : fleetFail("invalid");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("workers.enroll", undefined, true, "high");
      for (const projectId of projectIds) actor.require("tasks.assign", projectId, true);
      await this.#projectsExist(tx, projectIds);
      return this.#issueCode(tx, actor, { purpose: "join", workerId: `fleet-worker:${randomHexV1()}`, workerKind,
        displayName, projectIds, capabilities, maxConcurrent });
    });
  }

  async #issueCode(tx: DatabaseSession, actor: WebActor, input: Readonly<{ purpose: "join" | "rekey"; workerId: string;
    workerKind: string; displayName: string; projectIds: readonly string[]; capabilities: readonly string[]; maxConcurrent: number }>) {
    const code = newFleetCodeV1(), codeId = `fleet-code:${randomHexV1()}`;
    const createdAt = actor.now, expiresAt = iso(new Date(Date.parse(createdAt) + FLEET_CODE_LIFETIME_MS_V1));
    await tx.query(`UPDATE fleet_enrollment_codes SET state='revoked' WHERE tenant_id=$1 AND worker_id=$2 AND state='issued'`,
      [this.#tenantId, input.workerId]);
    await tx.query(`INSERT INTO fleet_enrollment_codes(tenant_id,id,code_digest,purpose,worker_id,worker_kind,display_name,
      project_ids,capabilities,max_concurrent,created_by_identity_id,created_at,expires_at,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'issued')`,
    [this.#tenantId, codeId, plainSha256V1(code), input.purpose, input.workerId, input.workerKind, input.displayName,
      [...input.projectIds], [...input.capabilities], input.maxConcurrent, actor.id, createdAt, expiresAt]);
    await appendAuditWith(tx, { id: `audit:fleet-code:${codeId.slice(11)}`, tenantId: this.#tenantId, actorId: actor.id,
      actorType: "human", action: input.purpose === "join" ? "fleet.enrollment_code.issued" : "fleet.rekey_code.issued",
      targetType: "fleet_worker", targetId: input.workerId, occurredAt: createdAt,
      safeMetadata: { codeId, workerKind: input.workerKind, projectIds: [...input.projectIds],
        capabilities: [...input.capabilities], expiresAt } });
    return Object.freeze({ codeId, code, workerId: input.workerId, expiresAt, purpose: input.purpose });
  }

  /** "New key": a single-use code that replaces the machine's credential. The
   * scope is copied, never widened. */
  async issueRekeyCode(identity: VerifiedWebIdentity, workerIdValue: unknown) {
    const workerId = typeof workerIdValue === "string" && FLEET_WORKER_ID_PATTERN_V1.test(workerIdValue) ? workerIdValue : fleetFail("not_found");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("workers.manage", undefined, true, "high");
      const worker = (await tx.query<{ worker_kind: string; display_name: string; project_ids: string[]; capabilities: string[];
        max_concurrent: number; state: string }>(`SELECT worker_kind,display_name,project_ids,capabilities,max_concurrent,state
        FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2`, [this.#tenantId, workerId])).rows[0];
      if (!worker) return fleetFail("not_found");
      if (worker.state !== "active") return fleetFail("conflict");
      return this.#issueCode(tx, actor, { purpose: "rekey", workerId, workerKind: worker.worker_kind,
        displayName: worker.display_name, projectIds: worker.project_ids, capabilities: worker.capabilities,
        maxConcurrent: Number(worker.max_concurrent) });
    });
  }

  async cancelCode(identity: VerifiedWebIdentity, codeIdValue: unknown) {
    const codeId = typeof codeIdValue === "string" && /^fleet-code:[a-f0-9]{32}$/u.test(codeIdValue) ? codeIdValue : fleetFail("not_found");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("workers.manage", undefined, true);
      const updated = await tx.query(`UPDATE fleet_enrollment_codes SET state='revoked' WHERE tenant_id=$1 AND id=$2
        AND state='issued' RETURNING id`, [this.#tenantId, codeId]);
      return Object.freeze({ cancelled: updated.rows.length === 1 });
    });
  }

  /** Revocation is immediate: the credential stops working in this same
   * transaction. Any live lease simply elapses; nothing is marked done. */
  async revokeWorker(identity: VerifiedWebIdentity, workerIdValue: unknown) {
    const workerId = typeof workerIdValue === "string" && FLEET_WORKER_ID_PATTERN_V1.test(workerIdValue) ? workerIdValue : fleetFail("not_found");
    const result = await this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("workers.manage", undefined, true, "high");
      const worker = (await tx.query<{ state: string }>(`SELECT state FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2 FOR UPDATE`,
        [this.#tenantId, workerId])).rows[0];
      if (!worker) return fleetFail("not_found");
      if (worker.state === "revoked") return Object.freeze({ workerId, revoked: true, replayed: true });
      await tx.query(`UPDATE fleet_workers SET state='revoked',revoked_at=$3,revoked_by_identity_id=$4
        WHERE tenant_id=$1 AND worker_id=$2`, [this.#tenantId, workerId, actor.now, actor.id]);
      await tx.query(`UPDATE fleet_worker_credentials SET state='revoked',ended_at=GREATEST(issued_at,$3::timestamptz)
        WHERE tenant_id=$1 AND worker_id=$2 AND state='active'`, [this.#tenantId, workerId, actor.now]);
      await tx.query(`UPDATE fleet_enrollment_codes SET state='revoked' WHERE tenant_id=$1 AND worker_id=$2 AND state='issued'`,
        [this.#tenantId, workerId]);
      await appendAuditWith(tx, { id: `audit:fleet-revoke:${workerId.slice(13)}`, tenantId: this.#tenantId, actorId: actor.id,
        actorType: "human", action: "fleet.worker.revoked", targetType: "fleet_worker", targetId: workerId, occurredAt: actor.now });
      return Object.freeze({ workerId, revoked: true, replayed: false });
    });
    await this.#settle();
    return result;
  }

  /** Workers board: status first, with honest "last seen" and no secrets. */
  async listWorkers(identity: VerifiedWebIdentity) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("workers.manage", undefined, true);
      const now = Date.parse(actor.now);
      const workers = (await tx.query<{ worker_id: string; display_name: string; worker_kind: string; project_ids: string[];
        capabilities: string[]; max_concurrent: number; state: string; enrolled_at: string | Date; last_seen_at: string | Date | null;
        platform: string | null; connector_version: string | null; active_claims: string; credential_expires_at: string | Date | null }>(
        `SELECT w.worker_id,w.display_name,w.worker_kind,w.project_ids,w.capabilities,w.max_concurrent,w.state,w.enrolled_at,
          p.last_seen_at,p.platform,p.connector_version,
          (SELECT count(*)::text FROM fleet_claims fc JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
            WHERE fc.tenant_id=w.tenant_id AND fc.worker_id=w.worker_id AND l.state='active') AS active_claims,
          (SELECT c.expires_at FROM fleet_worker_credentials c WHERE c.tenant_id=w.tenant_id AND c.worker_id=w.worker_id
            AND c.state='active') AS credential_expires_at
        FROM fleet_workers w LEFT JOIN fleet_worker_presence p ON p.tenant_id=w.tenant_id AND p.worker_id=w.worker_id
        WHERE w.tenant_id=$1 ORDER BY w.state,w.display_name LIMIT 100`, [this.#tenantId])).rows;
      const codes = (await tx.query<{ id: string; purpose: string; worker_id: string; display_name: string; expires_at: string | Date }>(
        `SELECT id,purpose,worker_id,display_name,expires_at FROM fleet_enrollment_codes WHERE tenant_id=$1 AND state='issued'
          AND expires_at>$2::timestamptz ORDER BY created_at DESC LIMIT 20`, [this.#tenantId, actor.now])).rows;
      return Object.freeze({
        workers: workers.map(row => {
          const seen = row.last_seen_at ? Date.parse(iso(row.last_seen_at)) : undefined;
          const status = row.state === "revoked" ? "revoked" : !row.credential_expires_at ? "needs_new_key"
            : seen !== undefined && now - seen < 5 * 60_000 ? (Number(row.active_claims) > 0 ? "working" : "connected") : "offline";
          return Object.freeze({ workerId: row.worker_id, displayName: row.display_name, workerKind: row.worker_kind, status,
            projectIds: row.project_ids, capabilities: row.capabilities, maxConcurrent: Number(row.max_concurrent),
            activeClaims: Number(row.active_claims), enrolledAt: iso(row.enrolled_at),
            lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null, platform: row.platform,
            connectorVersion: row.connector_version,
            credentialExpiresAt: row.credential_expires_at ? iso(row.credential_expires_at) : null });
        }),
        pendingCodes: codes.map(row => Object.freeze({ codeId: row.id, purpose: row.purpose, workerId: row.worker_id,
          displayName: row.display_name, expiresAt: iso(row.expires_at) })),
      });
    });
  }

  /** Opens one proposed task to fleet claiming: the owner's execution consent. */
  async offerTask(identity: VerifiedWebIdentity, input: Readonly<{ projectId: unknown; jobId: unknown; capability: unknown;
    allowedWorkerIds?: unknown }>) {
    const projectId = typeof input.projectId === "string" && FLEET_PROJECT_ID_PATTERN_V1.test(input.projectId) ? input.projectId : fleetFail("not_found");
    const jobId = typeof input.jobId === "string" && FLEET_PROJECT_ID_PATTERN_V1.test(input.jobId) ? input.jobId : fleetFail("not_found");
    const capability = typeof input.capability === "string" && FLEET_CAPABILITY_PATTERN_V1.test(input.capability) ? input.capability : fleetFail("invalid");
    const allowed = input.allowedWorkerIds === undefined || input.allowedWorkerIds === null ? null
      : list(input.allowedWorkerIds, FLEET_WORKER_ID_PATTERN_V1, 20);
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      const existing = (await tx.query<{ offer_id: string; state: string; capability: string }>(`SELECT offer_id,state,capability
        FROM fleet_work_offers WHERE tenant_id=$1 AND job_id=$2`, [this.#tenantId, jobId])).rows[0];
      if (existing) {
        if (existing.state === "open" && existing.capability === capability) return Object.freeze({ offerId: existing.offer_id, replayed: true });
        return fleetFail("conflict");
      }
      const offerId = `fleet-offer:${randomHexV1()}`;
      try {
        await tx.query(`INSERT INTO fleet_work_offers(tenant_id,offer_id,project_id,job_id,capability,allowed_worker_ids,
          offered_by_identity_id,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8)`,
        [this.#tenantId, offerId, projectId, jobId, capability, allowed, actor.id, actor.now]);
      } catch (error) {
        if (["P0001", "23503", "23505"].includes((error as { code?: string }).code ?? "")) return fleetFail("conflict");
        throw error;
      }
      await appendAuditWith(tx, { id: `audit:fleet-offer:${offerId.slice(12)}`, tenantId: this.#tenantId, projectId,
        actorId: actor.id, actorType: "human", action: "fleet.task.offered", targetType: "job", targetId: jobId,
        occurredAt: actor.now, safeMetadata: { offerId, capability, allowedWorkerIds: allowed } });
      return Object.freeze({ offerId, replayed: false });
    });
  }

  /** Withdraws an offer nobody is working on. A live claim must finish or
   * elapse first, so withdrawal never strands running work. */
  async withdrawOffer(identity: VerifiedWebIdentity, offerIdValue: unknown) {
    const offerId = typeof offerIdValue === "string" && FLEET_ENTITY_ID_PATTERN_V1.test(offerIdValue)
      && offerIdValue.startsWith("fleet-offer:") ? offerIdValue : fleetFail("not_found");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      const offer = (await tx.query<{ project_id: string; job_id: string; state: string }>(`SELECT project_id,job_id,state
        FROM fleet_work_offers WHERE tenant_id=$1 AND offer_id=$2 FOR UPDATE`, [this.#tenantId, offerId])).rows[0];
      if (!offer) return fleetFail("not_found");
      actor.require("tasks.assign", offer.project_id, true);
      if (offer.state !== "open") return fleetFail("conflict");
      const live = (await tx.query(`SELECT 1 FROM control_leases l WHERE l.tenant_id=$1 AND l.job_id=$2 AND l.state='active'`,
        [this.#tenantId, offer.job_id])).rows.length;
      const waiting = (await tx.query(`SELECT 1 FROM control_jobs WHERE tenant_id=$1 AND id=$2 AND state='waiting_approval'`,
        [this.#tenantId, offer.job_id])).rows.length;
      if (live || waiting) return fleetFail("conflict");
      await tx.query(`UPDATE fleet_work_offers SET state='closed',close_reason='withdrawn',closed_at=$3
        WHERE tenant_id=$1 AND offer_id=$2`, [this.#tenantId, offerId, actor.now]);
      await appendAuditWith(tx, { id: `audit:fleet-withdraw:${offerId.slice(12)}`, tenantId: this.#tenantId,
        projectId: offer.project_id, actorId: actor.id, actorType: "human", action: "fleet.task.withdrawn",
        targetType: "job", targetId: offer.job_id, occurredAt: actor.now, safeMetadata: { offerId } });
      return Object.freeze({ offerId, withdrawn: true });
    });
  }

  /** Results waiting for the owner, newest first; only projects the owner
   * may review appear. Worker text is returned as data, never markup. */
  async listResults(identity: VerifiedWebIdentity, input: Readonly<{ awaitingOnly?: boolean }> = {}) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      const rows = (await tx.query<{ result_id: string; project_id: string; job_id: string; worker_id: string; display_name: string;
        title: string; summary: string; file_count: number; total_file_bytes: number; submitted_at: string | Date;
        decision: string | null; note: string | null; job_state: string }>(`SELECT r.result_id,r.project_id,r.job_id,r.worker_id,
          w.display_name,rq.payload->>'title' AS title,r.summary,r.file_count,r.total_file_bytes,r.submitted_at,rv.decision,rv.note,
          j.state AS job_state
        FROM fleet_results r JOIN fleet_workers w ON w.tenant_id=r.tenant_id AND w.worker_id=r.worker_id
        JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.id=r.job_id
        JOIN control_workflows wf ON wf.tenant_id=j.tenant_id AND wf.id=j.workflow_id
        JOIN control_requests rq ON rq.tenant_id=wf.tenant_id AND rq.id=wf.request_id
        LEFT JOIN fleet_result_reviews rv ON rv.tenant_id=r.tenant_id AND rv.result_id=r.result_id
        WHERE r.tenant_id=$1 AND ($2::boolean IS NOT TRUE OR rv.review_id IS NULL)
        ORDER BY r.submitted_at DESC LIMIT 50`, [this.#tenantId, input.awaitingOnly === true])).rows;
      return rows.filter(row => actor.can("tasks.results.read", row.project_id)).map(row => Object.freeze({
        resultId: row.result_id, projectId: row.project_id, jobId: row.job_id, workerId: row.worker_id,
        workerName: row.display_name, title: row.title ?? "", summary: row.summary, fileCount: Number(row.file_count),
        totalFileBytes: Number(row.total_file_bytes), submittedAt: iso(row.submitted_at), decision: row.decision,
        note: row.note, taskState: row.job_state }));
    }, { readOnly: true });
  }

  async readResultFile(identity: VerifiedWebIdentity, resultIdValue: unknown, ordinalValue: unknown) {
    const resultId = typeof resultIdValue === "string" && /^fleet-result:[a-f0-9]{32}$/u.test(resultIdValue) ? resultIdValue : fleetFail("not_found");
    const ordinal = Number.isSafeInteger(ordinalValue) && (ordinalValue as number) >= 1 && (ordinalValue as number) <= 8
      ? ordinalValue as number : fleetFail("not_found");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      const row = (await tx.query<{ project_id: string; file_name: string; media_type: string; content: Buffer }>(`SELECT r.project_id,
        f.file_name,f.media_type,f.content FROM fleet_result_files f JOIN fleet_results r ON r.tenant_id=f.tenant_id
        AND r.result_id=f.result_id WHERE f.tenant_id=$1 AND f.result_id=$2 AND f.ordinal=$3`, [this.#tenantId, resultId, ordinal])).rows[0];
      if (!row) return fleetFail("not_found");
      actor.require("tasks.results.read", row.project_id);
      return Object.freeze({ fileName: row.file_name, mediaType: row.media_type, content: new Uint8Array(row.content) });
    }, { readOnly: true });
  }

  async listResultFiles(identity: VerifiedWebIdentity, resultIdValue: unknown) {
    const resultId = typeof resultIdValue === "string" && /^fleet-result:[a-f0-9]{32}$/u.test(resultIdValue) ? resultIdValue : fleetFail("not_found");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      const rows = (await tx.query<{ project_id: string; ordinal: number; file_name: string; media_type: string; size_bytes: number }>(
        `SELECT r.project_id,f.ordinal,f.file_name,f.media_type,f.size_bytes FROM fleet_results r
        LEFT JOIN fleet_result_files f ON f.tenant_id=r.tenant_id AND f.result_id=r.result_id
        WHERE r.tenant_id=$1 AND r.result_id=$2 ORDER BY f.ordinal`, [this.#tenantId, resultId])).rows;
      if (!rows.length) return fleetFail("not_found");
      actor.require("tasks.results.read", rows[0]!.project_id);
      return rows.filter(row => row.ordinal !== null).map(row => Object.freeze({ ordinal: Number(row.ordinal),
        fileName: row.file_name, mediaType: row.media_type, sizeBytes: Number(row.size_bytes) }));
    }, { readOnly: true });
  }

  /** The owner's decision. Accept, ask for changes, or reject; the gateway then
   * applies it to the canonical task. A worker can never write this row. */
  async review(identity: VerifiedWebIdentity, input: Readonly<{ resultId: unknown; decision: unknown; note?: unknown }>) {
    const resultId = typeof input.resultId === "string" && /^fleet-result:[a-f0-9]{32}$/u.test(input.resultId) ? input.resultId : fleetFail("not_found");
    const decision = ["accepted", "revision_requested", "rejected"].includes(input.decision as string)
      ? input.decision as string : fleetFail("invalid");
    const note = input.note === undefined || input.note === null || input.note === "" ? null
      : typeof input.note === "string" && input.note.trim().length <= 2000 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input.note)
        ? input.note.trim() || null : fleetFail("invalid");
    if (decision === "revision_requested" && !note) return fleetFail("invalid");
    const result = await this.#authority.authenticated(identity, async (tx, actor) => {
      const row = (await tx.query<{ project_id: string; job_id: string }>(`SELECT project_id,job_id FROM fleet_results
        WHERE tenant_id=$1 AND result_id=$2`, [this.#tenantId, resultId])).rows[0];
      if (!row) return fleetFail("not_found");
      actor.require("tasks.reviews.record", row.project_id, true);
      const prior = (await tx.query<{ review_id: string; decision: string }>(`SELECT review_id,decision FROM fleet_result_reviews
        WHERE tenant_id=$1 AND result_id=$2`, [this.#tenantId, resultId])).rows[0];
      if (prior) {
        if (prior.decision !== decision) return fleetFail("conflict");
        return Object.freeze({ reviewId: prior.review_id, decision, replayed: true });
      }
      const reviewId = `fleet-review:${randomHexV1()}`;
      try {
        await tx.query(`INSERT INTO fleet_result_reviews(tenant_id,review_id,result_id,decision,note,reviewed_by_identity_id,reviewed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [this.#tenantId, reviewId, resultId, decision, note, actor.id, actor.now]);
      } catch (error) {
        if (["P0001", "23505"].includes((error as { code?: string }).code ?? "")) return fleetFail("conflict");
        throw error;
      }
      await appendAuditWith(tx, { id: `audit:fleet-review:${reviewId.slice(13)}`, tenantId: this.#tenantId,
        projectId: row.project_id, actorId: actor.id, actorType: "human", action: "fleet.result.reviewed",
        targetType: "job", targetId: row.job_id, occurredAt: actor.now, safeMetadata: { resultId, reviewId, decision } });
      return Object.freeze({ reviewId, decision, replayed: false });
    });
    await this.#settle();
    return result;
  }

  /** Owner view of fleet offers in one project with their current status. */
  async projectOffers(identity: VerifiedWebIdentity, projectIdValue: unknown) {
    const projectId = typeof projectIdValue === "string" && FLEET_PROJECT_ID_PATTERN_V1.test(projectIdValue) ? projectIdValue : fleetFail("not_found");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const rows = (await tx.query<{ offer_id: string; job_id: string; capability: string; state: string; close_reason: string | null;
        job_state: string }>(`SELECT o.offer_id,o.job_id,o.capability,o.state,o.close_reason,j.state AS job_state
        FROM fleet_work_offers o JOIN control_jobs j ON j.tenant_id=o.tenant_id AND j.id=o.job_id
        WHERE o.tenant_id=$1 AND o.project_id=$2 ORDER BY o.created_at DESC LIMIT 100`, [this.#tenantId, projectId])).rows;
      return rows.map(row => Object.freeze({ offerId: row.offer_id, jobId: row.job_id, capability: row.capability,
        state: row.state, closeReason: row.close_reason, taskState: row.job_state }));
    }, { readOnly: true });
  }
}
