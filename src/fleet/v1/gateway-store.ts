import { appendAuditWith } from "../../audit/audit-store";
import { CanonicalStore, JobAuthorityExpiredError, TaskModelSelectionUnresolvedError } from "../../persistence/canonical-store";
import { databaseSqlStateIsAnyV1, type DatabaseClient, type DatabaseSession } from "../../persistence/database";
import { DOMAIN_CONTRACT_VERSION, nodeRecordSchema, requestRecordSchema, workflowRecordSchema,
  type JobRecord, type LeaseRecord } from "../../domain/v1";
import { sha256Digest } from "../../security";
import { moveFleetEntityV1, readFleetEntityV1, type Entity, type FleetActorV1 } from "./canonical-transitions";
import { ROLLBACK_SQL_STATES_V1, rollbackSqlStateNameV1 } from "../../web/v1/bounded-database";
import { composeWorkerInstructionsV1, verifiedTaskHandoffInstructionsV1 } from "../../web/v1/task-handoff";
import { fleetFail, FleetErrorV1 } from "./errors";
import { FLEET_CLAIM_INSERT_REFUSAL_SQL_STATES_V1, FLEET_LEASE_SCOPE_REFUSAL_SQL_STATES_V1 } from "./database-failure";
import { bytesSha256V1, fleetDerivedIdV1, fleetWorkerLinkedIdsV1, FLEET_CAPABILITY_PATTERN_V1, FLEET_CODE_PATTERN_V1,
  FLEET_CREDENTIAL_LIFETIME_MS_V1, FLEET_DIGEST_PATTERN_V1, FLEET_ENTITY_ID_PATTERN_V1, FLEET_IDEMPOTENCY_PATTERN_V1,
  FLEET_LEASE_MS_V1, FLEET_PROJECT_ID_PATTERN_V1, FLEET_SECRET_PATTERN_V1, FLEET_WORKER_ID_PATTERN_V1,
  FLEET_WORKER_KINDS_V1, plainSha256V1, randomHexV1 } from "./identifiers";
import type { TaskProjectEventWriterV1 } from "../../project-events/v1/task-lifecycle";
import { FLEET_WORKING_AGREEMENT_METADATA_V1 } from "./working-agreement";
import type { FleetToolCapabilityEvidencePortV1, FleetToolTaskBindingPortV1 } from "./tool-capability-evidence";

/** Authenticated machine principal. It is derived from the credential digest
 * and the stored worker row only; nothing in a request body can change it. */
export type FleetWorkerPrincipalV1 = Readonly<{ tenantId: string; workerId: string; nodeId: string;
  identityId: string; workerKind: string; displayName: string; projectIds: readonly string[];
  capabilities: readonly string[]; maxConcurrent: number; credentialId: string; credentialExpiresAt: string }>;

export const FLEET_MAX_LEASE_MS_V1 = 3_600_000;

export const FLEET_RESULT_LIMITS_V1 = Object.freeze({ summaryBytes: 65_536, files: 8, fileBytes: 262_144,
  totalFileBytes: 1_048_576, messageChars: 2000 });
export const FLEET_MEDIA_TYPES_V1 = Object.freeze(["text/plain", "text/markdown", "text/csv", "application/json",
  "image/png", "image/jpeg", "application/pdf"] as const);
const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const mcpCallPattern = /^mcp-call:[a-f0-9]{32}$/u;
const mcpToolNames = Object.freeze(["list_eligible_work", "claim", "post_progress", "submit_result",
  "report_blocker", "propose_work", "unsupported"] as const);
const platforms = Object.freeze({ macos: "macos", linux: "linux", windows: "windows" } as const);

const iso = (value: string | Date) => new Date(value).toISOString();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });
const gatewayActor: FleetActorV1 = Object.freeze({ actorId: "service:fleet-gateway", actorType: "service" });
const workerActor = (p: FleetWorkerPrincipalV1): FleetActorV1 => ({ actorId: p.identityId, actorType: "agent" });

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return fleetFail("invalid");
  const trimmed = value.trim();
  // Control characters other than tab/newline never enter stored worker text.
  if (!trimmed.length || trimmed.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(trimmed))
    return fleetFail("invalid");
  return trimmed;
}
function key(value: unknown): string {
  return typeof value === "string" && FLEET_IDEMPOTENCY_PATTERN_V1.test(value) ? value : fleetFail("invalid");
}
function entityId(value: unknown, prefix: string): string {
  return typeof value === "string" && FLEET_ENTITY_ID_PATTERN_V1.test(value) && value.startsWith(`fleet-${prefix}:`)
    ? value : fleetFail("not_found");
}
function observedToolCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== "string"
    || !FLEET_CAPABILITY_PATTERN_V1.test(item)) || new Set(value).size !== value.length) return fleetFail("invalid");
  return Object.freeze([...value].sort());
}

type WorkerRow = { worker_id: string; node_id: string; identity_id: string; worker_kind: string; display_name: string;
  project_ids: string[]; capabilities: string[]; max_concurrent: number; state: string };
type ClaimRow = { claim_id: string; offer_id: string; worker_id: string; node_id: string; project_id: string;
  job_id: string; attempt_id: string; lease_id: string; idempotency_key: string; claimed_at: string | Date };

/** The installation-wide Pause / Drain / Stop switch as the gateway reports
 * it to connectors. Only "running" admits a new claim. */
export const FLEET_OPERATIONS_MODES_V1 = Object.freeze(["running", "paused", "draining", "stopped"] as const);
export type FleetOperationsModeV1 = (typeof FLEET_OPERATIONS_MODES_V1)[number];

export type FleetGatewayStoreOptionsV1 = Readonly<{ tenantId: string; clock?: () => number;
  leaseMs?: number; connectorVersionLimit?: number;
  /** Reads the owner's current Pause / Drain / Stop decision. A missing port,
   * a failed read or an unexpected answer is unknown and refuses new claims. */
  operationsMode?: () => Promise<FleetOperationsModeV1>;
  /** Presentation-only task timeline. Without it, a hand-off is still recorded
   * in the audit log and worker events, but not shown on the Activity page. */
  projectEvents?: Pick<TaskProjectEventWriterV1, "appendInSession">;
  toolCapabilityEvidence?: FleetToolCapabilityEvidencePortV1;
  toolTasks?: FleetToolTaskBindingPortV1 }>;

/** PostgreSQL aborts a transaction when two of them contend (40P01), when the
 * engine cannot order their writes (40001), or when the pool's own
 * `lock_timeout` elapses under that same contention (55P03). The whole
 * transaction rolled back and the bounded pool proved the connection reusable,
 * so the operation did nothing and may be replayed verbatim — every
 * worker-facing write here is idempotent on its own key. This is contention,
 * not an outage, and the only correct answer is to try again rather than to
 * tell a worker its completed work was lost. The set itself lives in
 * `bounded-database` beside the one reader, so it can never drift.
 *
 * Written inline at the single call site rather than kept as a named
 * predicate, so there is exactly one shape here to keep honest. */
/** Bounded and jittered: under twenty bots the same statement can collide more
 * than once, and an unbounded retry would hide a genuine deadlock instead. */
const RETRYABLE_FLEET_TRANSACTION_ATTEMPTS_V1 = 4;
/** One operator-log line per replayed transaction. Retries are meant to be rare
 * now that the lock order is fixed, so this is how a returning deadlock becomes
 * visible instead of being silently absorbed. Only the SQLSTATE, the attempt and
 * the outcome are recorded -- no tenant, worker or payload. */
const fleetContentionLog = (outcome: "retry" | "giving_up", state: string, attempt: number): void => {
  process.stderr.write(`[fleet-gateway] contention ${outcome} sqlstate=${state} attempt=${attempt}\n`);
};

export class FleetGatewayStoreV1 {
  readonly #tenantId: string;
  readonly #clock: () => number;
  readonly #leaseMs: number;
  readonly #operationsMode: (() => Promise<FleetOperationsModeV1>) | undefined;
  readonly #projectEvents: Pick<TaskProjectEventWriterV1, "appendInSession"> | undefined;
  readonly #toolCapabilityEvidence: FleetToolCapabilityEvidencePortV1 | undefined;
  readonly #toolTasks: FleetToolTaskBindingPortV1 | undefined;
  constructor(private readonly db: DatabaseClient, options: FleetGatewayStoreOptionsV1) {
    if (!FLEET_PROJECT_ID_PATTERN_V1.test(options.tenantId)) throw new Error("fleet_gateway_configuration_invalid");
    this.#tenantId = options.tenantId;
    this.#clock = options.clock ?? Date.now;
    this.#leaseMs = options.leaseMs ?? FLEET_LEASE_MS_V1;
    this.#operationsMode = options.operationsMode;
    this.#projectEvents = options.projectEvents;
    this.#toolCapabilityEvidence = options.toolCapabilityEvidence;
    this.#toolTasks = options.toolTasks;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 30_000 || this.#leaseMs > FLEET_MAX_LEASE_MS_V1)
      throw new Error("fleet_gateway_configuration_invalid");
  }

  /** Runs one worker-facing transaction, replaying it a bounded number of
   * times when PostgreSQL rolled the whole thing back under contention. A
   * claim maps the final contention to an ordinary conflict so a worker moves
   * to its next offer; every other write either replays to completion or
   * reports the contention honestly rather than losing completed work.
   *
   * This is a SAFETY NET, not the fix for contention. The lock order is fixed
   * at the root (see `#tenantMutex`), so a replay here should be rare. Every
   * replay is logged with its SQLSTATE, because a returning 40P01 must be
   * visible to the operator rather than absorbed silently -- if the log ever
   * fills with retries, the lock order has regressed. */
  async #contending<T>(work: () => Promise<T>, onGiveUp?: (error: unknown) => T): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try { return await work(); }
      catch (error) {
        if (!databaseSqlStateIsAnyV1(error, ROLLBACK_SQL_STATES_V1)) throw error;
        const state = rollbackSqlStateNameV1(error) ?? "unknown";
        if (attempt >= RETRYABLE_FLEET_TRANSACTION_ATTEMPTS_V1) {
          fleetContentionLog("giving_up", state, attempt);
          if (onGiveUp) return onGiveUp(error);
          throw error;
        }
        fleetContentionLog("retry", state, attempt);
        await new Promise(done => setTimeout(done, 10 * attempt * attempt));
      }
    }
  }

  /** The installation-wide tenant mutex.
   *
   * Every transaction that counts ready work, or that appends to the audit
   * chain after touching the tenant, takes this row first. It is
   * `FOR NO KEY UPDATE` and NOT `FOR UPDATE`, and that difference is the whole
   * fix for the 40P01 that used to deadlock the fleet:
   *
   *   - `FOR NO KEY UPDATE` still conflicts with itself, so mutex holders
   *     serialise exactly as before and the "ready counts cannot race" rule
   *     above (canonical-store) is unchanged.
   *   - It does NOT conflict with `FOR KEY SHARE`, which is the lock every
   *     foreign-key check takes. `recordMcpCall` appends to the audit chain
   *     first and its `INSERT INTO audit_events` then checks `tenants(id)`.
   *     With `FOR UPDATE` that check closed the cycle (tenant row -> chain
   *     head -> FK check -> tenant row) and PostgreSQL killed one transaction
   *     per collision, failing workers' MCP calls with `deadlock_detected`.
   *
   * It needs no privilege `FOR UPDATE` did not already need: both require
   * UPDATE on a column, and every mutex holder already has
   * `UPDATE (coordinator_lock)` from the role grants. No migration, no grant
   * change and no ledger change.
   *
   * Every fleet `-> ready` move MUST call this first. It used to rely on an
   * accident -- a foreign-key wait against a `FOR UPDATE` holder -- and that
   * accident disappears the moment the mutex weakens, so the release path
   * takes it explicitly. */
  async #tenantMutex(tx: DatabaseSession): Promise<void> {
    await tx.query("SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE", [this.#tenantId]);
  }

  #now(): string {
    const now = this.#clock();
    if (!Number.isSafeInteger(now)) return fleetFail("unavailable");
    return new Date(now).toISOString();
  }

  /** The mode connectors see. "unknown" (an unreadable switch) never admits work. */
  async operationsMode(): Promise<FleetOperationsModeV1 | "unknown"> {
    if (!this.#operationsMode) return "unknown";
    try {
      const mode = await this.#operationsMode();
      return (FLEET_OPERATIONS_MODES_V1 as readonly unknown[]).includes(mode) ? mode : "unknown";
    } catch { return "unknown"; }
  }

  /** Records an authenticated MCP tool attempt before the tool is validated or
   * executed. The event contains no arguments or credential material.
   *
   * This transaction takes the audit chain head FIRST and only reaches the
   * tenant row through the `audit_events` foreign-key check, so it is the
   * other half of the old deadlock. It is idempotent on the derived audit id,
   * so replaying it is safe and it goes through `#contending` too: the fix at
   * the root is the lock order, and this is what keeps a single survivor --
   * rather than a refused tool call -- if anything ever collides again.
   *
   * It is also where an MCP-only machine records that it is here. Before
   * R7C-03, presence was written only by enrollment, the install-time heartbeat
   * and the long-poll wait, and an MCP-only bot (Claude Desktop, Cursor, generic
   * MCP, and a Claude Code or Codex installed without "unattended") never runs
   * the `run` loop at all -- so it was shown "Offline, last seen 6 min ago"
   * while it was actively claiming, posting progress and submitting results.
   *
   * The touch is deliberately NOT conditional on the audit write being new. A
   * replayed call id is still a machine doing work, and a long MCP session
   * lives on retries, so it sits BESIDE the idempotency check rather than
   * inside it -- which is the same statement issued twice in the two branches,
   * not a branch chosen by whether the audit row already existed.
   *
   * On ordering: this statement takes no audit-chain head. It does reach the
   * tenant row, but through the foreign-key check on `fleet_worker_presence`,
   * which is a `FOR KEY SHARE` that `FOR NO KEY UPDATE` (the tenant mutex)
   * does not conflict with. That is the same reason `recordMcpCall` takes the
   * audit chain head first, and it is why the touch cannot deadlock against a
   * claim holding the mutex -- see `#tenantMutex`. */
  async recordMcpCall(principal: FleetWorkerPrincipalV1, input: Readonly<{ callId: unknown; toolName: unknown }>) {
    if (typeof input.callId !== "string" || !mcpCallPattern.test(input.callId)
      || typeof input.toolName !== "string" || !mcpToolNames.includes(input.toolName as never)) return fleetFail("invalid");
    const callId = input.callId, toolName = input.toolName;
    const auditId = `audit:fleet-mcp:${callId.slice("mcp-call:".length)}`;
    return this.#contending(() => this.db.transaction(async tx => {
      const prior = (await tx.query<{ actor_id: string; target_id: string; safe_metadata: { toolName?: string } }>(
        "SELECT actor_id,target_id,safe_metadata FROM audit_events WHERE id=$1", [auditId])).rows[0];
      if (prior) {
        if (prior.actor_id !== principal.identityId || prior.target_id !== principal.workerId
          || prior.safe_metadata.toolName !== toolName) return fleetFail("conflict");
        await this.#touchPresenceIn(tx, principal, this.#now());
        return Object.freeze({ recorded: true, replayed: true });
      }
      await this.#touchPresenceIn(tx, principal, this.#now());
      await appendAuditWith(tx, { id: auditId, tenantId: this.#tenantId, actorId: principal.identityId,
        actorType: "worker", action: "fleet.mcp.called", targetType: "worker", targetId: principal.workerId,
        correlationId: callId, occurredAt: this.#now(), safeMetadata: { toolName } });
      return Object.freeze({ recorded: true, replayed: false });
    }));
  }

  /** A previously issued credential can still identify a revoked or expired
   * machine for audit attribution. This never authenticates it or reads the
   * request body, and an unknown secret creates no attacker-chosen audit row.
   * Idempotent on the derived audit id, so it replays safely through
   * `#contending` for the same reason as `recordMcpCall`. */
  async recordRefusedMcpAuthentication(input: Readonly<{ bearer: unknown; declaredWorkerId: unknown;
    callId: unknown; toolName: unknown }>) {
    if (typeof input.bearer !== "string" || !FLEET_SECRET_PATTERN_V1.test(input.bearer)
      || typeof input.declaredWorkerId !== "string" || !FLEET_WORKER_ID_PATTERN_V1.test(input.declaredWorkerId)
      || typeof input.callId !== "string" || !mcpCallPattern.test(input.callId)
      || typeof input.toolName !== "string" || !mcpToolNames.includes(input.toolName as never)) return false;
    const digest = plainSha256V1(input.bearer), declaredWorkerId = input.declaredWorkerId,
      callId = input.callId, toolName = input.toolName;
    const auditId = `audit:fleet-mcp-denied:${callId.slice("mcp-call:".length)}`;
    return this.#contending(() => this.db.transaction(async tx => {
      const worker = (await tx.query<{ identity_id: string }>(`SELECT w.identity_id FROM fleet_worker_credentials c
        JOIN fleet_workers w ON w.tenant_id=c.tenant_id AND w.worker_id=c.worker_id
        WHERE c.tenant_id=$1 AND c.secret_digest=$2 AND c.worker_id=$3`,
      [this.#tenantId, digest, declaredWorkerId])).rows[0];
      if (!worker) return false;
      const prior = (await tx.query<{ actor_id: string; safe_metadata: { toolName?: string } }>(
        "SELECT actor_id,safe_metadata FROM audit_events WHERE id=$1", [auditId])).rows[0];
      if (prior) return prior.actor_id === worker.identity_id && prior.safe_metadata.toolName === toolName;
      await appendAuditWith(tx, { id: auditId, tenantId: this.#tenantId, actorId: worker.identity_id,
        actorType: "worker", action: "fleet.mcp.authentication_refused", targetType: "worker",
        targetId: declaredWorkerId, correlationId: callId, occurredAt: this.#now(),
        safeMetadata: { toolName, reasonCode: "unauthenticated" } });
      return true;
    }));
  }

  /** Redeems one enrollment code. The machine generated its credential locally
   * and sends only the digest, so no secret travels back in the response. */
  async enroll(input: Readonly<{ code: unknown; workerKind: unknown; credentialDigest: unknown; platform: unknown; architecture: unknown;
    connectorVersion: unknown; clientNonce: unknown; adapterCapabilities?: unknown }>) {
    const code = typeof input.code === "string" && FLEET_CODE_PATTERN_V1.test(input.code) ? input.code : fleetFail("unauthenticated");
    const credentialDigest = typeof input.credentialDigest === "string" && FLEET_DIGEST_PATTERN_V1.test(input.credentialDigest)
      ? input.credentialDigest : fleetFail("invalid");
    const workerKind = typeof input.workerKind === "string" && FLEET_WORKER_KINDS_V1.includes(input.workerKind as never)
      ? input.workerKind : fleetFail("invalid");
    const platform = typeof input.platform === "string" && Object.hasOwn(platforms, input.platform)
      ? platforms[input.platform as keyof typeof platforms] : fleetFail("invalid");
    const architecture = typeof input.architecture === "string" && /^[a-z0-9_]{2,16}$/u.test(input.architecture)
      ? input.architecture : fleetFail("invalid");
    const connectorVersion = typeof input.connectorVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/u.test(input.connectorVersion)
      ? input.connectorVersion : fleetFail("invalid");
    const clientNonce = typeof input.clientNonce === "string" && /^crn_[A-Za-z0-9_-]{43}$/u.test(input.clientNonce)
      ? input.clientNonce : fleetFail("invalid");
    const adapterCapabilities = observedToolCapabilities(input.adapterCapabilities ?? []);
    const clientNonceDigest = plainSha256V1(clientNonce);
    const now = this.#now();
    const result = await this.db.transaction(async tx => {
      const row = (await tx.query<{ id: string; purpose: "join" | "rekey"; worker_id: string; worker_kind: string;
        display_name: string; project_ids: string[]; capabilities: string[]; max_concurrent: number;
        redeemed_at: string | Date; replayed: boolean }>(`SELECT * FROM redeem_fleet_enrollment($1,$2,$3,$4,$5)`,
      [this.#tenantId, code, clientNonceDigest, credentialDigest, now])).rows[0];
      // One refusal for unknown, cancelled and expired codes. A committed
      // redemption remains replayable only by the same pending connector.
      if (!row) return fleetFail("unauthenticated");
      // This check is in the redemption transaction, so a mismatch consumes
      // nothing and creates no worker or credential.
      if (row.worker_kind !== workerKind) return fleetFail("worker_kind_mismatch");
      const linked = fleetWorkerLinkedIdsV1(row.worker_id);
      if (row.replayed) {
        const credential = (await tx.query<{ expires_at: string | Date }>(`SELECT expires_at FROM fleet_worker_credentials
          WHERE tenant_id=$1 AND source_code_id=$2 AND worker_id=$3 AND secret_digest=$4 AND state='active'`,
        [this.#tenantId, row.id, row.worker_id, credentialDigest])).rows[0];
        const worker = (await tx.query<{ state: string }>(`SELECT state FROM fleet_workers
          WHERE tenant_id=$1 AND worker_id=$2`, [this.#tenantId, row.worker_id])).rows[0];
        if (!credential || worker?.state !== "active") return fleetFail("unauthenticated");
        await this.#presence(tx, row.worker_id, connectorVersion, platform, now);
        return Object.freeze({ workerId: row.worker_id, nodeId: linked.nodeId, displayName: row.display_name,
          workerKind: row.worker_kind, projectIds: row.project_ids, capabilities: row.capabilities,
          maxConcurrent: Number(row.max_concurrent), credentialExpiresAt: iso(credential.expires_at), purpose: row.purpose,
          replayed: true, workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 });
      }
      if (row.purpose === "join") {
        const node = nodeRecordSchema.parse({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: linked.nodeId,
          tenantId: this.#tenantId, displayName: row.display_name, state: "active", version: 1, platform, architecture,
          identityKeyId: linked.identityKeyId,
          // Not measured on the machine: these record only what the connector declared.
          hardwareFingerprint: sha256Digest({ declared: "fleet-connector/v1", platform, architecture }),
          softwareFingerprint: sha256Digest({ declared: "fleet-connector/v1", connectorVersion }),
          policyVersion: "fleet-connector/v1", minimumProtocolVersion: "fleet-http/v1",
          enrolledAt: now, createdAt: now, updatedAt: now });
        await tx.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
          VALUES($1,$2,'active',1,$3,$4::jsonb,$5,$5)`, [node.id, this.#tenantId, node.identityKeyId, JSON.stringify(node), now]);
        await tx.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,
          state,created_at,updated_at) VALUES($1,$2,'agent',$3,'work-intake',$4,'active',$5,$5)`,
        [linked.identityId, this.#tenantId, `Fleet worker ${row.display_name}`, linked.authSubjectDigest, now]);
        await tx.query(`INSERT INTO fleet_workers(tenant_id,worker_id,node_id,identity_id,worker_kind,display_name,project_ids,
          capabilities,max_concurrent,enrolled_from_code_id,state,enrolled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)`,
        [this.#tenantId, row.worker_id, linked.nodeId, linked.identityId, row.worker_kind, row.display_name, row.project_ids,
          row.capabilities, row.max_concurrent, row.id, now]);
        // The one grant a fleet worker holds: proposal-only intake in its projects.
        await tx.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
          risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
          VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
        [linked.grantId, this.#tenantId, linked.identityId, JSON.stringify(row.project_ids), now]);
      } else {
        const worker = (await tx.query<{ state: string }>(`SELECT state FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2`,
          [this.#tenantId, row.worker_id])).rows[0];
        if (worker?.state !== "active") return fleetFail("unauthenticated");
        // A re-key replaces whatever credential the machine held.
        await tx.query(`UPDATE fleet_worker_credentials SET state='revoked',ended_at=$3
          WHERE tenant_id=$1 AND worker_id=$2 AND state='active'`, [this.#tenantId, row.worker_id, now]);
      }
      const credentialId = `fleet-credential:${randomHexV1()}`;
      const expiresAt = iso(new Date(Date.parse(now) + FLEET_CREDENTIAL_LIFETIME_MS_V1));
      try {
        await tx.query(`INSERT INTO fleet_worker_credentials(tenant_id,credential_id,worker_id,secret_digest,state,issued_at,
          expires_at,source_code_id) VALUES($1,$2,$3,$4,'active',$5,$6,$7)`,
        [this.#tenantId, credentialId, row.worker_id, credentialDigest, now, expiresAt, row.id]);
      } catch (error) {
        if (databaseSqlStateIsAnyV1(error, ["23505"])) return fleetFail("conflict");
        throw error;
      }
      await this.#presence(tx, row.worker_id, connectorVersion, platform, now);
      await appendAuditWith(tx, { id: `audit:fleet-enroll:${row.id.slice(11)}`, tenantId: this.#tenantId,
        actorId: linked.identityId, actorType: "worker", action: row.purpose === "join" ? "fleet.worker.enrolled" : "fleet.worker.rekeyed",
        targetType: "fleet_worker", targetId: row.worker_id, occurredAt: now,
        safeMetadata: { codeId: row.id, credentialId, platform, architecture, connectorVersion } });
      return Object.freeze({ workerId: row.worker_id, nodeId: linked.nodeId, displayName: row.display_name,
        workerKind: row.worker_kind, projectIds: row.project_ids, capabilities: row.capabilities,
        maxConcurrent: Number(row.max_concurrent), credentialExpiresAt: expiresAt, purpose: row.purpose, replayed: false,
        workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 });
    });
    await this.#toolCapabilityEvidence?.observe(Object.freeze({ tenantId: this.#tenantId, workerId: result.workerId,
      observedAt: now, phase: "enrollment", connectorVersion, platform, capabilities: adapterCapabilities }));
    return result;
  }

  async #presence(tx: DatabaseSession, workerId: string, connectorVersion: string, platform: string, now: string) {
    await tx.query(`INSERT INTO fleet_worker_presence(tenant_id,worker_id,last_seen_at,connector_version,platform)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,worker_id) DO UPDATE SET last_seen_at=GREATEST(
        fleet_worker_presence.last_seen_at,EXCLUDED.last_seen_at),connector_version=EXCLUDED.connector_version,
        platform=EXCLUDED.platform`, [this.#tenantId, workerId, now, connectorVersion, platform]);
  }

  /** Contact, and nothing else.
   *
   * One UPDATE of one row, and the ONLY statement that answers "is this
   * machine here?". It is shared by two callers -- the long-poll wait and an
   * MCP tool call -- rather than existing twice, because the question has one
   * answer and two copies of it are two things to keep honest. It takes the
   * caller's session rather than reaching for `this.db`, so the wait can run
   * it bare while the MCP audit runs it inside its own transaction.
   *
   * Every condition in it is the same condition the wait already had to
   * satisfy, and each one exists:
   *   - `state='active'` on the worker and the credential: presence is a fact
   *     about a live machine, so a revoked or expired machine cannot buy its
   *     way back to "Connected" with a request it should not have got this far
   *     to make anyway.
   *   - bound to THIS principal's `credential_id`, not merely "some active
   *     credential": a worker that rotated its key has a new credential id, and
   *     an old request still in flight must not speak for it.
   *   - `GREATEST(last_seen_at, now)`: a clock that steps backwards must not
   *     make a machine look less recently seen than it is.
   * It reads no claim, attempt or lease, so it can never revive, extend or
   * steal running work. That is the whole difference between this and a
   * heartbeat, which also renews the credential's evidence and takes locks.
   *
   * The returned row count is the answer to "was this principal still live?",
   * which the long-poll wait refuses on. An MCP tool call already authenticated
   * at the start of its request and deliberately ignores it: a presence row
   * that is missing or stale says nothing about whether the CALL is allowed,
   * and refusing a tool call on it would invent an authority check that does
   * not exist. */
  async #touchPresenceIn(tx: DatabaseSession, principal: FleetWorkerPrincipalV1, now: string): Promise<number> {
    return (await tx.query<{ worker_id: string }>(`UPDATE fleet_worker_presence p SET last_seen_at=GREATEST(
        p.last_seen_at,$3::timestamptz) FROM fleet_workers w,fleet_worker_credentials c
      WHERE p.tenant_id=$1 AND p.worker_id=$2 AND w.tenant_id=p.tenant_id AND w.worker_id=p.worker_id
        AND w.state='active' AND c.tenant_id=p.tenant_id AND c.worker_id=p.worker_id AND c.credential_id=$4
        AND c.state='active' AND c.expires_at>statement_timestamp() RETURNING p.worker_id`,
    [this.#tenantId, principal.workerId, now, principal.credentialId])).rows.length;
  }

  /** Supplies the digest-only startup cache through the gateway's existing
   * least-privilege read grant. Expired and revoked credentials stay out. */
  async activeAdmissionCredentials() {
    const now = this.#now();
    const rows = (await this.db.query<{ worker_id: string; secret_digest: string }>(`SELECT c.worker_id,c.secret_digest
      FROM fleet_worker_credentials c JOIN fleet_workers w ON w.tenant_id=c.tenant_id AND w.worker_id=c.worker_id
      WHERE c.tenant_id=$1 AND c.state='active' AND w.state='active'
        AND c.expires_at>statement_timestamp() AND c.expires_at>$2::timestamptz
      ORDER BY c.worker_id`, [this.#tenantId, now])).rows;
    return Object.freeze(rows.map(row => Object.freeze({ workerId: row.worker_id, credentialDigest: row.secret_digest })));
  }

  /** Resolves the bearer to exactly one worker. The declared worker id must
   * match the credential's own worker, so a stolen credential cannot pose as
   * another machine, and nothing about the refusal says which check failed. */
  async authenticate(input: Readonly<{ bearer: unknown; declaredWorkerId: unknown }>): Promise<FleetWorkerPrincipalV1> {
    const bearer = typeof input.bearer === "string" && FLEET_SECRET_PATTERN_V1.test(input.bearer) ? input.bearer : undefined;
    const declared = typeof input.declaredWorkerId === "string" && FLEET_WORKER_ID_PATTERN_V1.test(input.declaredWorkerId)
      ? input.declaredWorkerId : undefined;
    if (!bearer || !declared) return fleetFail("unauthenticated");
    const now = this.#now();
    const row = (await this.db.query<WorkerRow & { credential_id: string; expires_at: string | Date }>(
      `SELECT w.worker_id,w.node_id,w.identity_id,w.worker_kind,w.display_name,w.project_ids,w.capabilities,
        w.max_concurrent,w.state,c.credential_id,c.expires_at
      FROM fleet_worker_credentials c JOIN fleet_workers w ON w.tenant_id=c.tenant_id AND w.worker_id=c.worker_id
      WHERE c.tenant_id=$1 AND c.secret_digest=$2 AND c.state='active' AND w.state='active'
        AND c.expires_at>statement_timestamp() AND c.expires_at>$3::timestamptz`,
    [this.#tenantId, plainSha256V1(bearer), now])).rows[0];
    if (!row || row.worker_id !== declared) return fleetFail("unauthenticated");
    return Object.freeze({ tenantId: this.#tenantId, workerId: row.worker_id, nodeId: row.node_id,
      identityId: row.identity_id, workerKind: row.worker_kind, displayName: row.display_name,
      projectIds: Object.freeze([...row.project_ids]), capabilities: Object.freeze([...row.capabilities]),
      maxConcurrent: Number(row.max_concurrent), credentialId: row.credential_id, credentialExpiresAt: iso(row.expires_at) });
  }

  async heartbeat(principal: FleetWorkerPrincipalV1, input: Readonly<{ connectorVersion: unknown; platform: unknown; adapterCapabilities?: unknown }>) {
    const version = typeof input.connectorVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/u.test(input.connectorVersion)
      ? input.connectorVersion : fleetFail("invalid");
    const platform = typeof input.platform === "string" && Object.hasOwn(platforms, input.platform)
      ? platforms[input.platform as keyof typeof platforms] : fleetFail("invalid");
    const adapterCapabilities = observedToolCapabilities(input.adapterCapabilities ?? []);
    const now = this.#now();
    await this.db.transaction(tx => this.#presence(tx, principal.workerId, version, platform, now));
    await this.#toolCapabilityEvidence?.observe(Object.freeze({ tenantId: this.#tenantId, workerId: principal.workerId,
      observedAt: now, phase: "heartbeat", connectorVersion: version, platform, capabilities: adapterCapabilities }));
    const operationsMode = await this.operationsMode();
    return Object.freeze({ ...this.me(principal), operationsMode, claimsAllowed: operationsMode === "running" });
  }

  me(principal: FleetWorkerPrincipalV1) {
    return Object.freeze({ workerId: principal.workerId, displayName: principal.displayName,
      workerKind: principal.workerKind, projectIds: principal.projectIds, capabilities: principal.capabilities,
      maxConcurrent: principal.maxConcurrent, credentialExpiresAt: principal.credentialExpiresAt,
      // How much life this credential has LEFT, measured on the server clock
      // rather than restated as a wall-clock instant. A machine whose own clock
      // is wrong by days cannot compare two absolute dates correctly, but it
      // can compare a duration against its own elapsed time, so the connector
      // schedules renewal from this instead of from `credentialExpiresAt`.
      credentialExpiresInMs: this.#remainingLifetimeMs(principal.credentialExpiresAt),
      canApprove: false, canAcceptResults: false, canMerge: false, canChangePermissions: false,
      workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 });
  }

  /** Remaining lifetime in milliseconds, floored at zero. An expiry that is not
   * a parseable instant is reported as zero rather than as NaN, so a caller can
   * never be handed a value it would have to special-case. */
  #remainingLifetimeMs(credentialExpiresAt: string): number {
    const at = Date.parse(credentialExpiresAt);
    if (!Number.isFinite(at)) return 0;
    return Math.max(0, at - this.#clock());
  }

  /** A parked wait is liveness only. It goes through the same one-statement
   * presence touch an MCP tool call uses, and deliberately never reads or
   * writes a claim, attempt, or lease. The touch's own row count is what proves
   * this principal's worker and credential are still both live, so a revoked or
   * rotated machine is refused exactly as it was before.
   *
   * It is a bare query, not a transaction, and that is deliberate: there is
   * nothing to pair this statement with. The audit-chain append that needs a
   * transaction belongs to `recordMcpCall`, and wrapping a single UPDATE in one
   * only buys a BEGIN/COMMIT per long-poll wake-up. */
  async recordWaitPresence(principal: FleetWorkerPrincipalV1) {
    const now = this.#now();
    const touched = await this.#touchPresenceIn(this.db, principal, now);
    if (touched !== 1) return fleetFail("unauthenticated");
    return Object.freeze({ presentAt: now, renewsLease: false as const });
  }

  /** Full long-poll re-query. Pause/Drain/Stop and an unreadable mode return no
   * work, and the current credential is checked again after the request parked. */
  async waitWork(principal: FleetWorkerPrincipalV1) {
    const current = (await this.db.query<{ active: boolean }>(`SELECT EXISTS(SELECT 1 FROM fleet_workers w
      JOIN fleet_worker_credentials c ON c.tenant_id=w.tenant_id AND c.worker_id=w.worker_id
      WHERE w.tenant_id=$1 AND w.worker_id=$2 AND w.state='active' AND c.credential_id=$3
        AND c.state='active' AND c.expires_at>statement_timestamp()) AS active`,
    [this.#tenantId, principal.workerId, principal.credentialId])).rows[0]?.active === true;
    if (!current) return fleetFail("unauthenticated");
    const operationsMode = await this.operationsMode();
    const offers = operationsMode === "running" ? await this.listWork(principal) : [];
    return Object.freeze({ offers: Object.freeze(offers), operationsMode });
  }

  /** Replaces the caller's credential with one it generated locally.
   *
   * A renewal queued before its predecessor expires must not publish a live
   * successor after that expiry: waiting for a pool connection or for the row
   * lock can carry the request across the boundary, and a credential stamped
   * from a `now` captured outside the transaction would then be born already
   * expired-but-active, outliving the revocation that should have stopped the
   * machine. So the authority check and the stamp happen together, INSIDE the
   * transaction, under the credential row lock, against the database clock
   * (`statement_timestamp()`), not against the caller's captured time.
   *
   * The worker row is deliberately NOT locked here. The gateway login holds
   * SELECT but no UPDATE on `fleet_workers`, and `SELECT ... FOR UPDATE` needs
   * UPDATE, DELETE or SELECT-FOR-UPDATE privilege on a column -- locking it
   * would have failed every renewal on privilege and looked like a refusal
   * rather than a guard. The active-worker check this also wanted is already
   * enforced at the write itself: 0141's `guard_fleet_credential_write` refuses
   * any credential insert whose worker is not `state='active'`, and
   * `authenticate` refuses the request outright before `rotate` is reached. */
  async rotate(principal: FleetWorkerPrincipalV1, input: Readonly<{ newCredentialDigest: unknown }>) {
    const digest = typeof input.newCredentialDigest === "string" && FLEET_DIGEST_PATTERN_V1.test(input.newCredentialDigest)
      ? input.newCredentialDigest : fleetFail("invalid");
    return this.db.transaction(async tx => {
      // The locked read carries the validated database time. `issued_at` is
      // this exact value, so the credential guard's
      // `prior.expires_at > NEW.issued_at` check compares against the same
      // clock reading that proved the predecessor unexpired, rather than
      // against a second, possibly later, one.
      const current = (await tx.query<{ credential_id: string; now: string }>(`SELECT credential_id,
        statement_timestamp() AS now FROM fleet_worker_credentials
        WHERE tenant_id=$1 AND credential_id=$2 AND worker_id=$3 AND state='active'
          FOR UPDATE`,
      [this.#tenantId, principal.credentialId, principal.workerId])).rows[0];
      if (!current) return fleetFail("unauthenticated");
      const now = iso(current.now);
      await tx.query(`UPDATE fleet_worker_credentials SET state='retired',ended_at=$3 WHERE tenant_id=$1 AND credential_id=$2`,
        [this.#tenantId, current.credential_id, now]);
      const credentialId = `fleet-credential:${randomHexV1()}`;
      const expiresAt = iso(new Date(Date.parse(now) + FLEET_CREDENTIAL_LIFETIME_MS_V1));
      try {
        await tx.query(`INSERT INTO fleet_worker_credentials(tenant_id,credential_id,worker_id,secret_digest,state,issued_at,
          expires_at,rotated_from_credential_id) VALUES($1,$2,$3,$4,'active',$5,$6,$7)`,
        [this.#tenantId, credentialId, principal.workerId, digest, now, expiresAt, current.credential_id]);
      } catch (error) {
        if (databaseSqlStateIsAnyV1(error, ["23505"])) return fleetFail("conflict");
        // 0141's `guard_fleet_credential_write` raises P0001 when the predecessor
        // is no longer the active, unexpired credential this request locked --
        // which is what an owner revocation or an expiry racing the renewal
        // looks like from here. That is a refusal of THIS credential, exactly
        // like the locked read above, not an outage, so the connector is told to
        // stop instead of being sent round the backoff again. Mapping it here
        // also keeps the two guards speaking one language: whichever fires
        // first, the answer is `unauthenticated`.
        if (databaseSqlStateIsAnyV1(error, ["P0001"])) return fleetFail("unauthenticated");
        throw error;
      }
      await appendAuditWith(tx, { id: `audit:fleet-rotate:${credentialId.slice(17)}`, tenantId: this.#tenantId,
        actorId: principal.identityId, actorType: "worker", action: "fleet.credential.rotated", targetType: "fleet_worker",
        targetId: principal.workerId, occurredAt: now, safeMetadata: { from: current.credential_id, to: credentialId } });
      return Object.freeze({ credentialExpiresAt: expiresAt });
    });
  }

  /** Open offers this worker may claim: its projects, its capabilities, and
   * no live lease. Other projects are invisible, not merely refused.

   * An offer whose job's authority envelope has already lapsed is NOT listed.
   * It is claimable by nobody and there is no way to make it claimable, so
   * listing it only spends a worker's claim (and, before R7C-01, ended the
   * whole pass). The offer row stays open so the owner can see it and act. */
  async listWork(principal: FleetWorkerPrincipalV1) {
    const now = this.#now();
    const rows = (await this.db.query<{ offer_id: string; project_id: string; job_id: string; capability: string;
      state: string; payload: { title?: string; objective?: string }; handoff_title: string | null;
      handoff_instructions: string | null; acceptance_criteria: string | null; acceptance_tests: string | null;
      instructions_digest: string | null; handoff_stage_ordinal: string | number | null;
      handoff_stage_kind: string | null }>(
      `SELECT o.offer_id,o.project_id,o.job_id,o.capability,
        j.state,r.payload,
        th.title AS handoff_title,th.instructions AS handoff_instructions,th.acceptance_criteria,th.acceptance_tests,
        th.instructions_digest,th.stage_ordinal AS handoff_stage_ordinal,th.stage_kind AS handoff_stage_kind
      FROM fleet_work_offers o
      JOIN control_jobs j ON j.tenant_id=o.tenant_id AND j.id=o.job_id
      JOIN control_workflows wf ON wf.tenant_id=j.tenant_id AND wf.id=j.workflow_id
      JOIN control_requests r ON r.tenant_id=wf.tenant_id AND r.id=wf.request_id
      JOIN control_manual_project_heads h ON h.tenant_id=o.tenant_id AND h.project_id=o.project_id
      -- 0290: the listing shows what the claim would hand over, joined in here
      -- rather than read per row: this runs on every poll of every waiting bot,
      -- so one statement matters more than one round trip.
      LEFT JOIN control_task_handoffs th ON th.tenant_id=j.tenant_id AND th.job_id=j.id
      WHERE o.tenant_id=$1 AND o.state='open' AND o.project_id=ANY($2::text[]) AND o.capability=ANY($3::text[])
        AND (o.allowed_worker_ids IS NULL OR $4=ANY(o.allowed_worker_ids)) AND h.lifecycle='active'
        AND j.state IN ('proposed','ready')
        AND (j.payload#>>'{authority,expiresAt}')::timestamptz>$5::timestamptz
        AND NOT EXISTS (SELECT 1 FROM control_leases l WHERE l.tenant_id=j.tenant_id AND l.job_id=j.id AND l.state='active')
      ORDER BY j.priority DESC,o.created_at LIMIT 50`,
    [this.#tenantId, [...principal.projectIds], [...principal.capabilities], principal.workerId, now])).rows;
    return Promise.all(rows.map(async row => {
      const binding = await this.#toolBinding(principal, row.job_id);
      // 0290: the pre-claim listing shows the same text the claim would hand over,
      // so a worker can see a stage's own instructions before it commits a lease.
      const handoff = verifiedTaskHandoffInstructionsV1({ jobId: row.job_id, title: row.handoff_title,
        instructions: row.handoff_instructions, acceptanceCriteria: row.acceptance_criteria,
        acceptanceTests: row.acceptance_tests, stageKind: row.handoff_stage_kind,
        stageOrdinal: row.handoff_stage_ordinal,
        instructionsDigest: row.instructions_digest }, String(row.payload.objective ?? ""));
      return Object.freeze({ offerId: row.offer_id, projectId: row.project_id, jobId: row.job_id, capability: row.capability,
        title: handoff.title ?? String(row.payload.title ?? ""),
        objective: composeWorkerInstructionsV1(handoff).slice(0, 600),
        ...(binding ? { adapterId: binding.adapterId } : {}) });
    }));
  }

  async #toolBinding(principal: FleetWorkerPrincipalV1, jobId: string) {
    return principal.workerKind === "tool" ? this.#toolTasks?.read(this.#tenantId, jobId) : undefined;
  }

  /** Claims one offered task through the shared canonical claim path. */
  async claim(principal: FleetWorkerPrincipalV1, input: Readonly<{ offerId: unknown; idempotencyKey: unknown }>) {
    const offerId = entityId(input.offerId, "offer"), idempotencyKey = key(input.idempotencyKey);
    const now = this.#now();
    // Read the mode before the transaction: the provider uses its own pool
    // connection, and reading it inside would hold two per claim. The 0156
    // trigger still decides inside the transaction, so a race costs nothing.
    const mode = await this.operationsMode();
    // A deadlock (40P01) or a serialization failure (40001) is claim-level
    // contention, not an outage: some other claim transaction on this project
    // won, and this one rolled back entirely. It is replayed a bounded number
    // of times, and if it never wins the worker gets the same ordinary 409 it
    // already knows to handle by moving to its next offer. Without this the
    // refusal travels as `400 refused`, which the connector reads as terminal
    // and ends the whole pass, stranding the job it had begun.
    //
    // The refusal mapping is where a LAPSED AUTHORITY becomes a refusal with a
    // name. `JobAuthorityExpiredError` is raised by the canonical store on
    // whichever of its three authority reads runs first for this job -- the
    // `proposed -> ready` transition, `claimReadyTaskJob`, or an effect -- so it
    // can surface from anywhere inside the claim, not only from the one branch
    // that checks the envelope up front. Before this it escaped as an
    // unexpected error and the gateway answered an anonymous HTTP 400
    // `refused`: the finding R7C-01(b) is about. `expired` is in the connector's
    // fixed set, so a bot now skips this offer and takes the next one instead
    // of abandoning its pass.
    //
    // It is caught HERE rather than passed to `#contending` as its on-give-up
    // handler, because that handler only runs for a ROLLBACK sqlstate
    // (40P01/40001/55P03). A lapsed authority is an ordinary application
    // refusal, not contention, so it never reaches it -- a fact this comment
    // records because getting it wrong makes the mapping silently dead.
    try {
      return await this.#contending(() => this.#claimInTransaction(principal, offerId, idempotencyKey, mode, now),
        () => fleetFail("conflict"));
    } catch (error) {
      if (error instanceof JobAuthorityExpiredError) fleetFail("expired");
      throw error;
    }
  }

  async #claimInTransaction(principal: FleetWorkerPrincipalV1, offerId: string, idempotencyKey: string,
    mode: string, now: string) {
    return this.db.transaction(async tx => {
      const prior = (await tx.query<ClaimRow>(`SELECT * FROM fleet_claims WHERE tenant_id=$1 AND worker_id=$2
        AND idempotency_key=$3`, [this.#tenantId, principal.workerId, idempotencyKey])).rows[0];
      if (prior) {
        if (prior.offer_id !== offerId) return fleetFail("conflict");
        return this.#claimView(tx, principal, prior, true);
      }
      // Pause, Drain and Stop all stop new claims; a replay above is not new.
      if (mode !== "running") return fleetFail("paused");
      await this.#tenantMutex(tx);
      const offer = (await tx.query<{ project_id: string; job_id: string; capability: string; state: string;
        allowed_worker_ids: string[] | null }>(`SELECT project_id,job_id,capability,state,allowed_worker_ids
        FROM fleet_work_offers WHERE tenant_id=$1 AND offer_id=$2`, [this.#tenantId, offerId])).rows[0];
      // An offer outside the worker's scope is reported as missing.
      if (!offer || !principal.projectIds.includes(offer.project_id) || !principal.capabilities.includes(offer.capability)
        || (offer.allowed_worker_ids && !offer.allowed_worker_ids.includes(principal.workerId))) return fleetFail("not_found");
      if (offer.state !== "open") return fleetFail("conflict");
      const head = (await tx.query<{ lifecycle: string }>(`SELECT lifecycle FROM control_manual_project_heads
        WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`, [this.#tenantId, offer.project_id])).rows[0];
      if (head?.lifecycle !== "active") return fleetFail("conflict");
      let job = await readFleetEntityV1(tx, this.#tenantId, "job", offer.job_id);
      if (job.projectId !== offer.project_id) return fleetFail("conflict");
      const selection = (await tx.query<{ worker_kind: string | null }>(`SELECT worker_kind FROM control_task_model_selections
        WHERE tenant_id=$1 AND job_id=$2`, [this.#tenantId, job.id])).rows[0];
      if (selection?.worker_kind && selection.worker_kind !== principal.workerKind) return fleetFail("conflict");
      // Project Settings (Settings tab) restricts which worker kinds may claim
      // this project's work at all. The coordinator enforces it on the
      // coordinator path; the fleet claim path must enforce it too, or a
      // project that restricted itself to one kind would still be claimable by
      // every other kind. Fails closed when a restriction is configured and
      // this worker's kind is not in it, and when the kind is not one the
      // setting can name.
      const settings = (await tx.query<{ eligible_worker_kinds: string[] | null }>(
        "SELECT eligible_worker_kinds FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [this.#tenantId, offer.project_id])).rows[0];
      if (settings?.eligible_worker_kinds !== null && settings?.eligible_worker_kinds !== undefined
        && !settings.eligible_worker_kinds.includes(principal.workerKind)) return fleetFail("conflict");
      const canonical = new CanonicalStore(joined(tx));
      const actor = { actorId: principal.identityId, actorType: "agent" as const };
      const suffix = sha256Digest({ offerId, workerId: principal.workerId, idempotencyKey }).slice(7, 39);
      if (job.state === "proposed") {
        const workflow = workflowRecordSchema.parse(await canonical.get(this.#tenantId, "workflow", job.workflowId));
        const request = requestRecordSchema.parse(await canonical.get(this.#tenantId, "request", workflow.requestId));
        const steps: Array<[kind: "request" | "workflow", id: string, version: number, from: string, to: string]> = [];
        if (request.state === "draft") steps.push(["request", request.id, request.version, "draft", "submitted"],
          ["request", request.id, request.version + 1, "submitted", "accepted"]);
        else if (request.state === "submitted") steps.push(["request", request.id, request.version, "submitted", "accepted"]);
        else if (request.state !== "accepted") return fleetFail("conflict");
        if (workflow.state === "proposed") steps.push(["workflow", workflow.id, workflow.version, "proposed", "active"]);
        else if (workflow.state !== "active") return fleetFail("conflict");
        for (const [kind, id, version, from, to] of steps) await canonical.transition({ tenantId: this.#tenantId, kind,
          entityId: id, expectedVersion: version, toState: to as never, transitionId: `transition:fleet-claim:${suffix}:${kind}:${from}`,
          idempotencyKey: `fleet-claim:${suffix}:${kind}:${from}`, actor, occurredAt: now });
        job = (await canonical.transition({ tenantId: this.#tenantId, kind: "job", entityId: job.id,
          expectedVersion: job.version, toState: "ready", transitionId: `transition:fleet-claim:${suffix}:ready`,
          idempotencyKey: `fleet-claim:${suffix}:ready`, actor, occurredAt: now })).entity as JobRecord;
      }
      if (job.state !== "ready") return fleetFail("conflict");
      // An authority envelope that has already lapsed cannot be honoured by any
      // lease, and the window below is capped by it. Read that FIRST and say
      // `expired`, because the window check one line below cannot distinguish
      // "this envelope has lapsed" from "the lease window is zero for some other
      // reason": both answered `conflict`, which the connector reads as "someone
      // else already has this task" and the owner reads as nothing at all.
      if (Date.parse(job.authority.expiresAt) <= Date.parse(now)) return fleetFail("expired");
      const claimId = `fleet-claim:${suffix}`;
      const attemptId = `attempt:fleet:${suffix}`, leaseId = `lease:fleet:${suffix}`;
      const expiresAt = iso(new Date(Math.min(Date.parse(now) + this.#leaseMs, Date.parse(job.authority.expiresAt),
        Date.parse(now) + job.authority.maxDurationSeconds * 1000)));
      if (Date.parse(expiresAt) <= Date.parse(now)) return fleetFail("conflict");
      try {
        await tx.query(`INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,project_id,job_id,attempt_id,
          lease_id,idempotency_key,claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [this.#tenantId, claimId, offerId, principal.workerId, principal.nodeId, offer.project_id, job.id, attemptId, leaseId,
          idempotencyKey, now]);
      } catch (error) {
        // The database guards refuse revoked, out-of-scope, over-capacity and
        // doubly-leased claims, each with a SQLSTATE the store reads wherever
        // the transport put it. At the ceiling this is a conflict the connector
        // moves past to the next offer, not a fault that ends the pass.
        //
        // 54000 is 0234's capacity refusal and MUST stay in this set: without
        // it every claim by a worker at its own limit escapes as an unexpected
        // error, the gateway answers a bare HTTP 400 `refused`, and the
        // connector abandons its whole pass instead of moving to the next offer.
        //
        // 0A000 is deliberately NOT here. 0234 raises it on a REPEATABLE READ
        // caller, whose transaction cannot enforce the ceiling for ANY claim;
        // answering that with `conflict` would send the connector back to the
        // next offer in the same unusable transaction.
        if (databaseSqlStateIsAnyV1(error, FLEET_CLAIM_INSERT_REFUSAL_SQL_STATES_V1)) return fleetFail("conflict");
        throw error;
      }
      // The canonical store's own transaction wraps anything it does not recognise,
// so an unresolved selection must be turned into a fleet refusal AFTER the
// store's transaction has unwound, never inside it.
let claimed: Awaited<ReturnType<CanonicalStore["claimReadyTaskJob"]>>;
      try {
        claimed = await canonical.claimReadyTaskJob({ tenantId: this.#tenantId, jobId: job.id,
          expectedJobVersion: job.version, nodeId: principal.nodeId, workerId: principal.workerId, attemptId, leaseId,
          transitionId: `transition:fleet-claim:${suffix}:lease`, idempotencyKey: `fleet-claim:${suffix}:lease`,
          actor, acquiredAt: now, expiresAt });
      } catch (error) {
        // An unresolved model selection is a refusal with a fixed code, not a
        // server fault: the owner asked for a model this worker cannot honour.
        if (error instanceof TaskModelSelectionUnresolvedError) fleetFail("conflict");
        // An expired authority envelope is likewise a refusal, and `expired`
        // is the code that says so: it is in the connector's fixed set, so a
        // worker skips this offer and moves to the next one instead of
        // abandoning its whole pass and reporting Control Room unreachable.
        //
        // It must be checked BEFORE the lease window is computed, because the
        // computed window is capped by the same `expiresAt`: with the old
        // five-minute proposal stamp, `expiresAt` was already past and the
        // claim failed one line earlier as a bare `conflict`, which reads as
        // "someone else has it" and hides the real reason forever. Checking it
        // here is what turns "this offer can't be taken" into a code the bot
        // and the owner can both read.
        if (error instanceof JobAuthorityExpiredError) fleetFail("expired");
        throw error;
      }
      const declared = (await tx.query<{ scope_kind: "file" | "tree"; path_fold: string }>(`SELECT scope_kind,path_fold
        FROM control_task_declared_scopes WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 ORDER BY scope_kind,path_fold`,
      [this.#tenantId, offer.project_id, job.id])).rows;
      // Absence of a declaration never means conflict-free: hold the whole tree.
      const scopes = declared.length ? declared : [{ scope_kind: "tree" as const, path_fold: "" }];
      try {
        for (const scope of scopes) await tx.query(`INSERT INTO control_assignment_lease_scopes
          (tenant_id,lease_id,project_id,job_id,attempt_id,node_id,scope_kind,path,path_fold)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [this.#tenantId, claimed.lease.id, offer.project_id, job.id,
          claimed.attempt.id, principal.nodeId, scope.scope_kind, scope.path_fold]);
      } catch (error) {
        // 0100 raises exactly two codes on this insert -- 23P01 for a scope
        // collision and 23514 for a scope the job never declared -- so it gets
        // its OWN set rather than the claim insert's. A 23514 on the CLAIM row
        // means the gateway built a row the schema forbids, which is a bug to
        // report, not a busy worker to move past.
        if (databaseSqlStateIsAnyV1(error, FLEET_LEASE_SCOPE_REFUSAL_SQL_STATES_V1)) return fleetFail("conflict");
        throw error;
      }
      await appendAuditWith(tx, { id: `audit:fleet-claim:${suffix}`, tenantId: this.#tenantId, projectId: offer.project_id,
        actorId: principal.identityId, actorType: "worker", action: "fleet.task.claimed", targetType: "job", targetId: job.id,
        idempotencyKey: `fleet-claim:${suffix}`, occurredAt: now,
        safeMetadata: { claimId, offerId, workerId: principal.workerId, attemptId, leaseId, leaseExpiresAt: expiresAt } });
      const row = (await tx.query<ClaimRow>("SELECT * FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2",
        [this.#tenantId, claimId])).rows[0]!;
      return this.#claimView(tx, principal, row, false);
    });
  }

  async #claimView(tx: DatabaseSession, principal: FleetWorkerPrincipalV1, row: ClaimRow, replayed: boolean) {
    // 0290: the worker is handed THIS job's authenticated instructions, not the
    // one objective its workflow shares with its sibling stages, and with the
    // owner-approved acceptance requirements attached. The request objective is
    // the fallback for a task proposed before 0290 and for any row that fails
    // its own digest check, so this read can never be the reason a claim fails.
    //
    // The hand-off is a LEFT JOIN into the statement that was already here, not
    // a second round trip. A claim is the hot path of every fleet worker, and
    // the burst lane measures that honestly: it runs a fixed number of
    // sequential passes over a fixed pool of jobs, so an extra round trip per
    // claim starves a late pass and the lane fails on latency rather than on any
    // wrong answer. The join changes no row count and takes no row lock this
    // statement did not already hold.
    const detail = (await tx.query<{ title: string; objective: string; lease_state: string; lease_expires_at: string | Date;
      job_state: string; handoff_title: string | null; handoff_instructions: string | null;
      acceptance_criteria: string | null; acceptance_tests: string | null;
      instructions_digest: string | null; handoff_stage_ordinal: string | number | null;
      handoff_stage_kind: string | null }>(
      `SELECT r.payload->>'title' AS title,r.payload->>'objective' AS objective,l.state AS lease_state,
        l.expires_at AS lease_expires_at,j.state AS job_state,
        h.title AS handoff_title,h.instructions AS handoff_instructions,h.acceptance_criteria,h.acceptance_tests,
        h.instructions_digest,h.stage_ordinal AS handoff_stage_ordinal,h.stage_kind AS handoff_stage_kind
      FROM control_jobs j JOIN control_workflows wf ON wf.tenant_id=j.tenant_id AND wf.id=j.workflow_id
      JOIN control_requests r ON r.tenant_id=wf.tenant_id AND r.id=wf.request_id
      JOIN control_leases l ON l.tenant_id=j.tenant_id AND l.id=$3
      LEFT JOIN control_task_handoffs h ON h.tenant_id=j.tenant_id AND h.job_id=j.id
      WHERE j.tenant_id=$1 AND j.id=$2`, [this.#tenantId, row.job_id, row.lease_id])).rows[0];
    const handoff = verifiedTaskHandoffInstructionsV1({
      jobId: row.job_id, title: detail?.handoff_title, instructions: detail?.handoff_instructions,
      acceptanceCriteria: detail?.acceptance_criteria, acceptanceTests: detail?.acceptance_tests,
      stageKind: detail?.handoff_stage_kind,
      stageOrdinal: detail?.handoff_stage_ordinal, instructionsDigest: detail?.instructions_digest },
    detail?.objective ?? "");
    const binding = await this.#toolBinding(principal, row.job_id);
    return Object.freeze({ claimId: row.claim_id, offerId: row.offer_id, projectId: row.project_id, jobId: row.job_id,
      title: handoff.title ?? detail?.title ?? "",
      instructions: composeWorkerInstructionsV1(handoff),
      leaseState: detail?.lease_state ?? "unknown",
      leaseExpiresAt: detail ? iso(detail.lease_expires_at) : null, taskState: detail?.job_state ?? "unknown",
      ...(binding ? { adapterId: binding.adapterId, inputs: binding.inputs } : {}),
      replayed, grantsApproval: false, grantsMerge: false });
  }

  async #liveClaim(tx: DatabaseSession, principal: FleetWorkerPrincipalV1, claimIdValue: unknown) {
    const claimId = entityId(claimIdValue, "claim");
    const row = (await tx.query<ClaimRow>(`SELECT * FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2`,
      [this.#tenantId, claimId])).rows[0];
    // Another worker's claim is indistinguishable from a missing one.
    if (!row || row.worker_id !== principal.workerId) return fleetFail("not_found");
    return row;
  }

  async #start(tx: DatabaseSession, principal: FleetWorkerPrincipalV1, claim: ClaimRow, now: string) {
    let job = await readFleetEntityV1(tx, this.#tenantId, "job", claim.job_id);
    let attempt = await readFleetEntityV1(tx, this.#tenantId, "attempt", claim.attempt_id);
    const lease = await readFleetEntityV1(tx, this.#tenantId, "lease", claim.lease_id);
    if (lease.state !== "active" || Date.parse(lease.expiresAt) <= Date.parse(now)) return fleetFail("expired");
    const base = { key: claim.claim_id, occurredAt: now, actor: workerActor(principal) };
    if (attempt.state === "leased") attempt = await moveFleetEntityV1(tx, attempt, "running", { ...base, patch: { startedAt: now } });
    if (job.state === "leased") job = await moveFleetEntityV1(tx, job, "running", base);
    if (job.state !== "running" || attempt.state !== "running") return fleetFail("conflict");
    return { job, attempt, lease };
  }

  async #event(tx: DatabaseSession, principal: FleetWorkerPrincipalV1, claim: ClaimRow, kind: "progress" | "blocker",
    message: string, idempotencyKey: string, now: string) {
    const eventId = fleetDerivedIdV1("event", principal.workerId, idempotencyKey);
    const prior = (await tx.query<{ claim_id: string; kind: string; message: string }>(`SELECT claim_id,kind,message
      FROM fleet_worker_events WHERE tenant_id=$1 AND worker_id=$2 AND idempotency_key=$3`,
    [this.#tenantId, principal.workerId, idempotencyKey])).rows[0];
    if (prior) {
      if (prior.claim_id !== claim.claim_id || prior.kind !== kind || prior.message !== message) return fleetFail("conflict");
      return { eventId, replayed: true };
    }
    try {
      await tx.query(`INSERT INTO fleet_worker_events(tenant_id,event_id,claim_id,worker_id,kind,message,idempotency_key,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [this.#tenantId, eventId, claim.claim_id, principal.workerId, kind, message,
        idempotencyKey, now]);
    } catch (error) {
      if (databaseSqlStateIsAnyV1(error, ["P0001"])) return fleetFail("expired");
      throw error;
    }
    return { eventId, replayed: false };
  }

  /** Extends the claim's lease by one lease length from `now`, within the job
   * authority, and returns the lease's stored expiry.
   *
   * Called on a first note AND on a repeat of one already recorded, which is
   * the whole point: a bot that keeps saying the same thing is the signal that
   * keeps its work (see `progress`). One mechanism, one place.
   *
   * The three authority clamps are exactly the ones the claim itself used: the
   * lease length from now, the job's authority expiry, and the job's maximum
   * duration measured from when the lease was ACQUIRED rather than from each
   * renewal -- so no amount of repetition buys a bot more time than the owner
   * approved, and a long job still ends when its authority does.
   */
  async #renew(tx: DatabaseSession, job: JobRecord, lease: LeaseRecord, eventId: string, now: string): Promise<string> {
    const target = Math.min(Date.parse(now) + this.#leaseMs, Date.parse(job.authority.expiresAt),
      Date.parse(lease.acquiredAt) + job.authority.maxDurationSeconds * 1000);
    if (target <= Date.parse(lease.expiresAt)) return lease.expiresAt;
    // The renewal's idempotency key carries the lease version it renews FROM,
    // not the note's event id alone. `renewLease` refuses a key it has already
    // seen carrying different content ("Renewal idempotency key reused with
    // different content"), and a repeat of one note necessarily asks for a
    // LATER expiry than the first time -- so a key derived from the event alone
    // would turn the very case this fix exists for into an unexpected error.
    // The version is the honest identity of a renewal: `renewLease` bumps it,
    // and `#start` above holds this lease row FOR UPDATE for the rest of the
    // transaction, so a rolled-back attempt and a committed one can never
    // present the same version.
    const suffix = `${eventId.slice(12)}.v${lease.version}`;
    const renewed = await new CanonicalStore(joined(tx)).renewLease({ tenantId: this.#tenantId, leaseId: lease.id,
      expectedVersion: lease.version, epoch: lease.epoch, renewalId: `outbox:fleet-renew:${suffix}`,
      idempotencyKey: `fleet-renew:${suffix}`, renewedAt: now, expiresAt: iso(new Date(target)) });
    return renewed.lease.expiresAt;
  }

  /** Records progress and renews the claim's lease within the job authority. */
  async progress(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; message: unknown; idempotencyKey: unknown }>) {
    const message = text(input.message, FLEET_RESULT_LIMITS_V1.messageChars), idempotencyKey = key(input.idempotencyKey);
    const now = this.#now();
    // A progress note also renews the lease, so losing it to contention would
    // shorten the worker's own runway. Replay it instead.
    return this.#contending(() => this.db.transaction(async tx => {
      const claim = await this.#liveClaim(tx, principal, input.claimId);
      // R6C-03. This used to answer a replay of the NOTE as a replay of the
      // RENEWAL and returned before reading any lease:
      //
      //   const replay = (await tx.query(`SELECT 1 FROM fleet_worker_events ...
      //     AND idempotency_key=$3`, ...)).rows.length > 0;
      //   if (replay) return { ...event, leaseExpiresAt: null };
      //
      // The connector derives ONE operation key from (tool, arguments) when a
      // caller supplies none (connector.mjs `key`), so a bot's recurring "Still
      // working" heartbeat is the same key every minute. From the second note
      // onward that heartbeat took the replay branch: it recorded no event, read
      // no lease, renewed nothing, and answered SUCCESS with a null expiry --
      // indistinguishable from a keepalive that had renewed. A long job's lease
      // then walked into the supervisor's stall sweep and was taken away from a
      // bot that was still reporting in. Measured on real PostgreSQL 17 as the
      // production fleet login: five identical notes moved no expiry at all.
      //
      // A repeat from the HOLDER now renews exactly as the first one did, and
      // BOTH paths report the lease's real stored expiry instead of a null. The
      // note is still ONE event row -- only the lease moves -- so a retry of a lost
      // reply with its original key records no second note and answers
      // `replayed: true` with the CURRENT expiry.
      //
      // One row per RENEWAL is the cost of that: `renewLease` writes a
      // `lease.renewed` outbox row on every renewal, and nothing prunes
      // `control_outbox`, so a bot beating every 30 seconds adds one small row
      // per 30 seconds. That is the same rate at which the lease itself moves,
      // and one mechanism (this call) beats a second scan or resend path, whose
      // steady-state cost on an idle call would be paid whether or not anything
      // needed renewing.
      //
      // What makes that safe is unchanged and is now load-bearing: `#liveClaim`
      // above already refuses anything but this worker's own claim, and
      // `#start` refuses a lease that is released, revoked or elapsed. A foreign
      // worker, a stolen claim and an old lease therefore extend nothing, and the
      // elapsed-lease refusal is unchanged. The order of the two calls is the
      // same as it was before this fix -- rows locked by `#start`, then the event
      // insert -- because that is the lock order the deadlock measurements here
      // describe.
      const { job, lease } = await this.#start(tx, principal, claim, now);
      const event = await this.#event(tx, principal, claim, "progress", message, idempotencyKey, now);
      const leaseExpiresAt = await this.#renew(tx, job, lease, event.eventId, now);
      return { ...event, leaseExpiresAt };
    }));
  }

  /** A blocker is reported honestly. With release, the task goes back to the
   * open offer for another eligible worker; nothing is marked as done. */
  async blocker(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; message: unknown;
    idempotencyKey: unknown; release?: unknown }>) {
    const message = text(input.message, FLEET_RESULT_LIMITS_V1.messageChars), idempotencyKey = key(input.idempotencyKey);
    if (input.release !== undefined && typeof input.release !== "boolean") return fleetFail("invalid");
    const now = this.#now();
    // A blocker with release is how a failed run hands its task back. Losing it
    // to contention would abandon owner-visible work instead, so replay it.
    return this.#contending(() => this.db.transaction(async tx => {
      const claim = await this.#liveClaim(tx, principal, input.claimId);
      const event = await this.#event(tx, principal, claim, "blocker", message, idempotencyKey, now);
      if (event.replayed || input.release !== true) return { ...event, released: false };
      // This release returns owner-visible work to the open offer, so it takes the
      // tenant mutex, and it takes it BEFORE any job/attempt/lease row lock: every
      // coordinator mutex holder locks the mutex first and rows second, so taking it
      // after the row locks would close a deadlock cycle with them.
      await this.#tenantMutex(tx);
      let job = await readFleetEntityV1(tx, this.#tenantId, "job", claim.job_id);
      const attempt = await readFleetEntityV1(tx, this.#tenantId, "attempt", claim.attempt_id);
      const lease = await readFleetEntityV1(tx, this.#tenantId, "lease", claim.lease_id);
      if (lease.state !== "active") return fleetFail("conflict");
      const base = { key: `${claim.claim_id}:release`, occurredAt: now, actor: workerActor(principal),
        metadata: { reason: "worker_reported_blocker", eventId: event.eventId } };
      await moveFleetEntityV1(tx, lease, "released", base);
      await moveFleetEntityV1(tx, attempt, attempt.state === "leased" ? "cancelled" : "failed",
        { ...base, patch: { finishedAt: now, safeFailureCode: "worker_blocked" } });
      if (job.state === "running") job = await moveFleetEntityV1(tx, job, "orphaned", base);
      await moveFleetEntityV1(tx, job, "ready", base);
      await tx.query("DELETE FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2", [this.#tenantId, lease.id]);
      await appendAuditWith(tx, { id: `audit:fleet-release:${event.eventId.slice(12)}`, tenantId: this.#tenantId,
        projectId: claim.project_id, actorId: principal.identityId, actorType: "worker", action: "fleet.task.released",
        targetType: "job", targetId: claim.job_id, occurredAt: now, safeMetadata: { claimId: claim.claim_id, eventId: event.eventId } });
      if (this.#projectEvents) {
        const project = (await tx.query<{ workspace_id: string }>(`SELECT workspace_id FROM projects
          WHERE tenant_id=$1 AND id=$2`, [this.#tenantId, claim.project_id])).rows[0];
        // A project row must already exist for a fleet offer to have been made
        // against it; a missing row here would mean stored data disagreed with
        // itself, so the hand-off note is skipped rather than guessed.
        if (project) await this.#projectEvents.appendInSession(tx, { tenantId: this.#tenantId,
          workspaceId: project.workspace_id, projectId: claim.project_id, subjectId: claim.job_id,
          action: "task_handed_off", sourceId: claim.job_id, sourceVersion: "1", occurredAt: now,
          safeDetail: message.length > 800 ? `${message.slice(0, 799)}…` : message });
      }
      return { ...event, released: true };
    }));
  }

  /** Stores one bounded result and moves the task to "awaiting review". The
   * worker's capacity is freed; only the owner can accept the result. */
  async submitResult(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; summary: unknown;
    files?: unknown; idempotencyKey: unknown }>) {
    const idempotencyKey = key(input.idempotencyKey);
    if (typeof input.summary !== "string") return fleetFail("invalid");
    const summary = input.summary.trim();
    if (!summary.length || Buffer.byteLength(summary, "utf8") > FLEET_RESULT_LIMITS_V1.summaryBytes
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(summary)) return fleetFail(summary.length ? "too_large" : "invalid");
    const rawFiles = input.files ?? [];
    if (!Array.isArray(rawFiles)) return fleetFail("invalid");
    if (rawFiles.length > FLEET_RESULT_LIMITS_V1.files) return fleetFail("too_large");
    const files = rawFiles.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fleetFail("invalid");
      const file = value as Record<string, unknown>;
      if (Object.keys(file).sort().join(",") !== "content,mediaType,name") return fleetFail("invalid");
      if (typeof file.name !== "string" || !fileNamePattern.test(file.name) || file.name.includes("..")) return fleetFail("invalid");
      if (!FLEET_MEDIA_TYPES_V1.includes(file.mediaType as never)) return fleetFail("invalid");
      if (!(file.content instanceof Uint8Array)) return fleetFail("invalid");
      if (file.content.byteLength > FLEET_RESULT_LIMITS_V1.fileBytes) return fleetFail("too_large");
      return { name: file.name, mediaType: file.mediaType as string, content: Uint8Array.from(file.content) };
    });
    if (new Set(files.map(file => file.name)).size !== files.length) return fleetFail("invalid");
    const total = files.reduce((sum, file) => sum + file.content.byteLength, 0);
    if (total > FLEET_RESULT_LIMITS_V1.totalFileBytes) return fleetFail("too_large");
    const contentDigest = sha256Digest({ summary, files: files.map(file => ({ name: file.name, mediaType: file.mediaType,
      digest: bytesSha256V1(file.content) })) });
    const now = this.#now();
    // A result is finished work. Losing it to contention would tell a worker
    // its completed answer was never delivered, so it is replayed: every step
    // below is idempotent on `idempotencyKey` or on the derived result id.
    return this.#contending(() => this.db.transaction(async tx => {
      const claim = await this.#liveClaim(tx, principal, input.claimId);
      const prior = (await tx.query<{ result_id: string; claim_id: string; content_digest: string }>(`SELECT result_id,claim_id,
        content_digest FROM fleet_results WHERE tenant_id=$1 AND (claim_id=$2 OR (worker_id=$3 AND idempotency_key=$4))`,
      [this.#tenantId, claim.claim_id, principal.workerId, idempotencyKey])).rows;
      if (prior.length) {
        if (prior.length !== 1 || prior[0]!.claim_id !== claim.claim_id || prior[0]!.content_digest !== contentDigest)
          return fleetFail("conflict");
        return Object.freeze({ resultId: prior[0]!.result_id, replayed: true, taskState: "waiting_approval", accepted: false });
      }
      const { job, attempt, lease } = await this.#start(tx, principal, claim, now);
      const resultId = fleetDerivedIdV1("result", claim.claim_id);
      try {
        await tx.query(`INSERT INTO fleet_results(tenant_id,result_id,claim_id,worker_id,project_id,job_id,attempt_id,summary,
          file_count,total_file_bytes,content_digest,idempotency_key,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [this.#tenantId, resultId, claim.claim_id, principal.workerId, claim.project_id, claim.job_id, claim.attempt_id, summary,
          files.length, total, contentDigest, idempotencyKey, now]);
        for (const [index, file] of files.entries()) await tx.query(`INSERT INTO fleet_result_files(tenant_id,result_id,ordinal,
          file_name,media_type,size_bytes,content_digest,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [this.#tenantId, resultId, index + 1, file.name, file.mediaType, file.content.byteLength, bytesSha256V1(file.content),
          Buffer.from(file.content)]);
      } catch (error) {
        if (databaseSqlStateIsAnyV1(error, ["P0001"])) return fleetFail("expired");
        throw error;
      }
      const base = { key: claim.claim_id, occurredAt: now, actor: workerActor(principal), metadata: { resultId } };
      await moveFleetEntityV1(tx, attempt, "waiting", base);
      await moveFleetEntityV1(tx, job, "waiting_approval", base);
      await moveFleetEntityV1(tx, lease, "released", base);
      await tx.query("DELETE FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2", [this.#tenantId, lease.id]);
      await appendAuditWith(tx, { id: `audit:fleet-result:${resultId.slice(13)}`, tenantId: this.#tenantId,
        projectId: claim.project_id, actorId: principal.identityId, actorType: "worker", action: "fleet.result.submitted",
        targetType: "job", targetId: claim.job_id, occurredAt: now,
        safeMetadata: { claimId: claim.claim_id, resultId, contentDigest, fileCount: files.length, totalFileBytes: total } });
      return Object.freeze({ resultId, replayed: false, taskState: "waiting_approval", accepted: false });
    }));
  }

  /** The worker's own claims and the owner's decision on each, so a revision
   * request reaches the worker that did the work.
   *
   * Each claim carries the instant its lease ENDS. A worker holding a finished
   * answer it could not yet deliver has to decide how long to keep waiting, and
   * that is a fact only this row holds: a progress note renews the lease, so the
   * deadline in the original claim reply goes stale the moment the worker keeps
   * reporting. `leaseState` says whether it can still report at all. */
  async myClaims(principal: FleetWorkerPrincipalV1) {
    const rows = (await this.db.query<{ claim_id: string; project_id: string; job_id: string; claimed_at: string | Date;
      lease_state: string; lease_expires_at: string | Date; job_state: string; result_id: string | null;
      decision: string | null; note: string | null }>(
      `SELECT fc.claim_id,fc.project_id,fc.job_id,fc.claimed_at,l.state AS lease_state,l.expires_at AS lease_expires_at,
        j.state AS job_state,r.result_id,rv.decision,rv.note
      FROM fleet_claims fc JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
      JOIN control_jobs j ON j.tenant_id=fc.tenant_id AND j.id=fc.job_id
      LEFT JOIN fleet_results r ON r.tenant_id=fc.tenant_id AND r.claim_id=fc.claim_id
      LEFT JOIN fleet_result_reviews rv ON rv.tenant_id=r.tenant_id AND rv.result_id=r.result_id
      WHERE fc.tenant_id=$1 AND fc.worker_id=$2 ORDER BY fc.claimed_at DESC LIMIT 50`,
    [this.#tenantId, principal.workerId])).rows;
    return rows.map(row => Object.freeze({ claimId: row.claim_id, projectId: row.project_id, jobId: row.job_id,
      claimedAt: iso(row.claimed_at), leaseState: row.lease_state, leaseExpiresAt: iso(row.lease_expires_at),
      taskState: row.job_state, resultId: row.result_id, ownerDecision: row.decision, ownerNote: row.note }));
  }

  /**
   * Applies owner decisions and revocations to canonical state. Idempotent and
   * bounded; safe to call after every owner action and on a timer. Lease expiry
   * belongs exclusively to SupervisorReconcilerV1, including for fleet work,
   * so one durable lapse counter decides whether another attempt is allowed.
   * The database refuses any job move here that the owner did not record.
   */
  async reconcile() {
    const now = this.#now();
    const applied = { reviews: 0, revocations: 0, leaseRevocations: 0 };
    const reviews = (await this.db.query<{ review_id: string; result_id: string; decision: string; claim_id: string;
      job_id: string; attempt_id: string; project_id: string }>(`SELECT rv.review_id,rv.result_id,rv.decision,r.claim_id,
        r.job_id,r.attempt_id,r.project_id FROM fleet_result_reviews rv
      JOIN fleet_results r ON r.tenant_id=rv.tenant_id AND r.result_id=rv.result_id
      JOIN control_jobs j ON j.tenant_id=r.tenant_id AND j.id=r.job_id
      JOIN control_attempts a ON a.tenant_id=r.tenant_id AND a.id=r.attempt_id
      WHERE rv.tenant_id=$1 AND j.state='waiting_approval' AND a.state='waiting' ORDER BY rv.reviewed_at LIMIT 50`,
    [this.#tenantId])).rows;
    for (const review of reviews) {
      await this.db.transaction(async tx => {
        // A requested revision returns the job to the open offer, which needs the
        // tenant mutex. Take it before the row locks (mutex first, rows second).
        if (review.decision === "revision_requested") await this.#tenantMutex(tx);
        let job = await readFleetEntityV1(tx, this.#tenantId, "job", review.job_id);
        const attempt = await readFleetEntityV1(tx, this.#tenantId, "attempt", review.attempt_id);
        if (job.state !== "waiting_approval" || attempt.state !== "waiting") return;
        const base = { key: review.review_id, occurredAt: now, actor: gatewayActor,
          metadata: { reviewId: review.review_id, resultId: review.result_id, decision: review.decision } };
        if (review.decision === "accepted") {
          await moveFleetEntityV1(tx, attempt, "succeeded", { ...base, patch: { finishedAt: now } });
          job = await moveFleetEntityV1(tx, job, "running", base);
          await moveFleetEntityV1(tx, job, "succeeded", base);
        } else if (review.decision === "revision_requested") {
          await moveFleetEntityV1(tx, attempt, "failed", { ...base, patch: { finishedAt: now, safeFailureCode: "revision_requested" } });
          job = await moveFleetEntityV1(tx, job, "failed", base);
          await moveFleetEntityV1(tx, job, "ready", base);
        } else {
          await moveFleetEntityV1(tx, attempt, "failed", { ...base, patch: { finishedAt: now, safeFailureCode: "result_rejected" } });
          await moveFleetEntityV1(tx, job, "cancelled", base);
        }
        await appendAuditWith(tx, { id: `audit:fleet-apply:${review.review_id.slice(13)}`, tenantId: this.#tenantId,
          projectId: review.project_id, actorId: gatewayActor.actorId, actorType: "service", action: "fleet.review.applied",
          targetType: "job", targetId: review.job_id, occurredAt: now,
          safeMetadata: { reviewId: review.review_id, decision: review.decision } });
        applied.reviews += 1;
      });
    }
    const revoked = (await this.db.query<{ worker_id: string; node_id: string; identity_id: string }>(`SELECT w.worker_id,w.node_id,
        w.identity_id FROM fleet_workers w JOIN control_identities i ON i.tenant_id=w.tenant_id AND i.id=w.identity_id
      WHERE w.tenant_id=$1 AND w.state='revoked' AND i.state='active' LIMIT 50`, [this.#tenantId])).rows;
    for (const worker of revoked) {
      await this.db.transaction(async tx => {
        await tx.query(`UPDATE control_identities SET state='revoked',updated_at=GREATEST(updated_at,$3::timestamptz)
          WHERE tenant_id=$1 AND id=$2 AND state='active'`, [this.#tenantId, worker.identity_id, now]);
        await tx.query(`UPDATE control_role_grants SET revoked_at=GREATEST(created_at,$3::timestamptz),
          updated_at=GREATEST(updated_at,$3::timestamptz) WHERE tenant_id=$1 AND identity_id=$2 AND revoked_at IS NULL`,
        [this.#tenantId, worker.identity_id, now]);
        const node = await readFleetEntityV1(tx, this.#tenantId, "node", worker.node_id);
        // Every one of these steps is a compare-and-set against a row another
        // reconciler may have moved first. A conflict here means the other one
        // already applied the revocation, which is the outcome this pass exists
        // to produce, so it is not an error: the pass is idempotent by design.
        try {
          if (node.state !== "revoked") await moveFleetEntityV1(tx, node, "revoked", { key: worker.worker_id,
            occurredAt: now, actor: gatewayActor, metadata: { reason: "owner_revoked_worker" } });
        } catch (error) {
          if (!isFleetErrorV1(error) || error.code !== "conflict") throw error;
        }
        // Fleet's counterpart of the local Stop path. The owner's revocation is
        // a deliberate withdrawal, not a stall, so the in-flight lease leaves
        // the active set exactly as the supervisor's candidate query looks for
        // one. Without this, the supervisor -- now the sole expiry owner --
        // would find the abandoned lease just as it finds a genuine stall,
        // count a lapse, and on a second lapse raise a Needs-you item for work
        // the owner took back on purpose.
        //
        // The move runs through moveFleetEntityV1, not CanonicalStore
        // .revokeLease, because 0140's gateway job guard admits `orphaned` but
        // not `cancelled`, and that guard cannot be widened here: the fleet
        // login is not allowed to cancel work on its own. `ready` is likewise
        // refused once the claim has been withdrawn, so the job is left
        // `orphaned`, where the owner's own flows (task-service's Needs-you
        // query, the assignment coordinator's reassignment) already pick it
        // up. Nothing is marked done.
        applied.leaseRevocations += await this.#revokeWorkerLeases(tx, worker, now);
        applied.revocations += 1;
      });
    }
    return Object.freeze(applied);
  }

  /** Moves an entity unless a racing reconciler already did. `skipWhen` names
   * the states this path deliberately leaves alone -- an attempt waiting on an
   * owner decision keeps its stored result, and a job awaiting the owner is
   * theirs to decide. A conflict means the other reconciler won, which is the
   * outcome this pass exists for, so it is reported as already-applied rather
   * than thrown. Any other error propagates. */
  async #moveOrAlready<T extends Entity>(tx: DatabaseSession, entity: T, toState: T["state"],
    base: Readonly<{ key: string; occurredAt: string; actor: FleetActorV1; metadata?: Record<string, unknown>;
      patch?: Record<string, unknown> }>, skipWhen?: string): Promise<boolean> {
    if (entity.state === toState || (skipWhen && entity.state === skipWhen)) return false;
    try {
      await moveFleetEntityV1(tx, entity, toState, base);
      return true;
    } catch (error) {
      if (isFleetErrorV1(error) && error.code === "conflict") return false;
      throw error;
    }
  }

  /** Every live lease this worker's claims still hold, revoked through the
   * shared fleet transition path. Bounded and idempotent: a lease already out
   * of `active` is left alone, so a repeated reconcile, a concurrent sweep or
   * a second revocation neither throws nor double-counts. */
  async #revokeWorkerLeases(tx: DatabaseSession, worker: { worker_id: string }, now: string): Promise<number> {
    const rows = (await tx.query<{ job_id: string; attempt_id: string; lease_id: string }>(
      `SELECT l.job_id,l.attempt_id,l.id AS lease_id FROM fleet_claims fc
      JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
      WHERE fc.tenant_id=$1 AND fc.worker_id=$2 AND l.state='active' ORDER BY fc.claimed_at LIMIT 50`,
    [this.#tenantId, worker.worker_id])).rows;
    let revoked = 0;
    for (const row of rows) {
      // Lock the lease before reading it. The candidate list above is a snapshot
      // taken before any lock, so a second reconciler can hold the same row; the
      // lock is what serializes them, and the re-read after it is what decides
      // who wins. Without the lock the loser's re-read races the winner's write
      // and both proceed to the same deterministic transition id, where the
      // unique constraint on (tenant, entity_kind, entity_id, idempotency_key)
      // turns an ordinary race into a 23505 that escapes reconcile().
      const locked = await tx.query<{ id: string; state: string }>(
        "SELECT id,state FROM control_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [this.#tenantId, row.lease_id]);
      const lease = await readFleetEntityV1(tx, this.#tenantId, "lease", row.lease_id);
      // Re-read under the lock: the reconciler that lost the race sees a lease
      // that is no longer active and stops here.
      if (!locked.rows.length || locked.rows[0]!.state !== "active" || lease.state !== "active") continue;
      const attempt = await readFleetEntityV1(tx, this.#tenantId, "attempt", row.attempt_id);
      const job = await readFleetEntityV1(tx, this.#tenantId, "job", row.job_id);
      const base = { key: `${worker.worker_id}:${lease.id}`, occurredAt: now, actor: gatewayActor,
        metadata: { reason: "owner_revoked_worker", leaseId: lease.id } };
      // As with the node above, a losing compare-and-set means the twin already
      // applied this revocation. Each move is independent, so a skipped one
      // never skips the rest, and the scope release always runs. Only the lease
      // move decides the count: this pass revoked this worker's lease, whether
      // it won the move or found it already made by its twin.
      const leaseMoved = await this.#moveOrAlready(tx, lease, "revoked", base);
      await this.#moveOrAlready(tx, attempt, "cancelled",
        { ...base, patch: { finishedAt: now, safeFailureCode: "worker_revoked" } }, "waiting");
      await this.#moveOrAlready(tx, job, "orphaned", base, "waiting_approval");
      await tx.query("DELETE FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
        [this.#tenantId, lease.id]);
      if (leaseMoved) revoked += 1;
    }
    return revoked;
  }
}

export function isFleetErrorV1(error: unknown): error is FleetErrorV1 { return error instanceof FleetErrorV1; }
export { FLEET_CAPABILITY_PATTERN_V1 };
