import { appendAuditWith } from "../../audit/audit-store";
import { CanonicalStore, TaskModelSelectionUnresolvedError } from "../../persistence/canonical-store";
import { databaseSqlStateIsAnyV1, type DatabaseClient, type DatabaseSession } from "../../persistence/database";
import { DOMAIN_CONTRACT_VERSION, nodeRecordSchema, requestRecordSchema, workflowRecordSchema,
  type JobRecord } from "../../domain/v1";
import { sha256Digest } from "../../security";
import { moveFleetEntityV1, readFleetEntityV1, type Entity, type FleetActorV1 } from "./canonical-transitions";
import { ROLLBACK_SQL_STATES_V1, rollbackSqlStateNameV1 } from "../../web/v1/bounded-database";
import { fleetFail, FleetErrorV1 } from "./errors";
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
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 30_000 || this.#leaseMs > 3_600_000)
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
   * rather than a refused tool call -- if anything ever collides again. */
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
        return Object.freeze({ recorded: true, replayed: true });
      }
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
    const platform = platforms[input.platform as keyof typeof platforms] ?? fleetFail("invalid");
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
    const platform = platforms[input.platform as keyof typeof platforms] ?? "other";
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
      canApprove: false, canAcceptResults: false, canMerge: false, canChangePermissions: false,
      workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 });
  }

  /** A parked wait is liveness only. It updates the existing presence row and
   * deliberately never reads or writes a claim, attempt, or lease. */
  async recordWaitPresence(principal: FleetWorkerPrincipalV1) {
    const now = this.#now();
    const rows = (await this.db.query<{ worker_id: string }>(`UPDATE fleet_worker_presence p SET last_seen_at=GREATEST(
        p.last_seen_at,$3::timestamptz) FROM fleet_workers w,fleet_worker_credentials c
      WHERE p.tenant_id=$1 AND p.worker_id=$2 AND w.tenant_id=p.tenant_id AND w.worker_id=p.worker_id
        AND w.state='active' AND c.tenant_id=p.tenant_id AND c.worker_id=p.worker_id AND c.credential_id=$4
        AND c.state='active' AND c.expires_at>statement_timestamp() RETURNING p.worker_id`,
    [this.#tenantId, principal.workerId, now, principal.credentialId])).rows;
    if (rows.length !== 1) return fleetFail("unauthenticated");
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

  /** Replaces the caller's credential with one it generated locally. */
  async rotate(principal: FleetWorkerPrincipalV1, input: Readonly<{ newCredentialDigest: unknown }>) {
    const digest = typeof input.newCredentialDigest === "string" && FLEET_DIGEST_PATTERN_V1.test(input.newCredentialDigest)
      ? input.newCredentialDigest : fleetFail("invalid");
    const now = this.#now();
    return this.db.transaction(async tx => {
      const current = (await tx.query<{ credential_id: string }>(`SELECT credential_id FROM fleet_worker_credentials
        WHERE tenant_id=$1 AND credential_id=$2 AND worker_id=$3 AND state='active' FOR UPDATE`,
      [this.#tenantId, principal.credentialId, principal.workerId])).rows[0];
      if (!current) return fleetFail("unauthenticated");
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
        throw error;
      }
      await appendAuditWith(tx, { id: `audit:fleet-rotate:${credentialId.slice(17)}`, tenantId: this.#tenantId,
        actorId: principal.identityId, actorType: "worker", action: "fleet.credential.rotated", targetType: "fleet_worker",
        targetId: principal.workerId, occurredAt: now, safeMetadata: { from: current.credential_id, to: credentialId } });
      return Object.freeze({ credentialExpiresAt: expiresAt });
    });
  }

  /** Open offers this worker may claim: its projects, its capabilities, and
   * no live lease. Other projects are invisible, not merely refused. */
  async listWork(principal: FleetWorkerPrincipalV1) {
    const rows = (await this.db.query<{ offer_id: string; project_id: string; job_id: string; capability: string;
      state: string; payload: { title?: string; objective?: string } }>(`SELECT o.offer_id,o.project_id,o.job_id,o.capability,
        j.state,r.payload
      FROM fleet_work_offers o
      JOIN control_jobs j ON j.tenant_id=o.tenant_id AND j.id=o.job_id
      JOIN control_workflows wf ON wf.tenant_id=j.tenant_id AND wf.id=j.workflow_id
      JOIN control_requests r ON r.tenant_id=wf.tenant_id AND r.id=wf.request_id
      JOIN control_manual_project_heads h ON h.tenant_id=o.tenant_id AND h.project_id=o.project_id
      WHERE o.tenant_id=$1 AND o.state='open' AND o.project_id=ANY($2::text[]) AND o.capability=ANY($3::text[])
        AND (o.allowed_worker_ids IS NULL OR $4=ANY(o.allowed_worker_ids)) AND h.lifecycle='active'
        AND j.state IN ('proposed','ready')
        AND NOT EXISTS (SELECT 1 FROM control_leases l WHERE l.tenant_id=j.tenant_id AND l.job_id=j.id AND l.state='active')
      ORDER BY j.priority DESC,o.created_at LIMIT 50`,
    [this.#tenantId, [...principal.projectIds], [...principal.capabilities], principal.workerId])).rows;
    return Promise.all(rows.map(async row => {
      const binding = await this.#toolBinding(principal, row.job_id);
      return Object.freeze({ offerId: row.offer_id, projectId: row.project_id, jobId: row.job_id, capability: row.capability,
        title: String(row.payload.title ?? ""), objective: String(row.payload.objective ?? "").slice(0, 600),
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
    return this.#contending(() => this.#claimInTransaction(principal, offerId, idempotencyKey, mode, now),
      () => fleetFail("conflict"));
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
        // The database guard refuses revoked, out-of-scope, over-capacity and doubly-leased claims.
        if (databaseSqlStateIsAnyV1(error, ["P0001", "23505", "23503"])) return fleetFail("conflict");
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
        if (databaseSqlStateIsAnyV1(error, ["23P01", "23514"])) return fleetFail("conflict");
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
    const detail = (await tx.query<{ title: string; objective: string; lease_state: string; lease_expires_at: string | Date;
      job_state: string }>(`SELECT r.payload->>'title' AS title,r.payload->>'objective' AS objective,l.state AS lease_state,
        l.expires_at AS lease_expires_at,j.state AS job_state
      FROM control_jobs j JOIN control_workflows wf ON wf.tenant_id=j.tenant_id AND wf.id=j.workflow_id
      JOIN control_requests r ON r.tenant_id=wf.tenant_id AND r.id=wf.request_id
      JOIN control_leases l ON l.tenant_id=j.tenant_id AND l.id=$3
      WHERE j.tenant_id=$1 AND j.id=$2`, [this.#tenantId, row.job_id, row.lease_id])).rows[0];
    const binding = await this.#toolBinding(principal, row.job_id);
    return Object.freeze({ claimId: row.claim_id, offerId: row.offer_id, projectId: row.project_id, jobId: row.job_id,
      title: detail?.title ?? "", instructions: detail?.objective ?? "", leaseState: detail?.lease_state ?? "unknown",
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

  /** Records progress and renews the claim's lease within the job authority. */
  async progress(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; message: unknown; idempotencyKey: unknown }>) {
    const message = text(input.message, FLEET_RESULT_LIMITS_V1.messageChars), idempotencyKey = key(input.idempotencyKey);
    const now = this.#now();
    // A progress note also renews the lease, so losing it to contention would
    // shorten the worker's own runway. Replay it instead.
    return this.#contending(() => this.db.transaction(async tx => {
      const claim = await this.#liveClaim(tx, principal, input.claimId);
      const replay = (await tx.query(`SELECT 1 FROM fleet_worker_events WHERE tenant_id=$1 AND worker_id=$2 AND idempotency_key=$3`,
        [this.#tenantId, principal.workerId, idempotencyKey])).rows.length > 0;
      if (replay) return { ...(await this.#event(tx, principal, claim, "progress", message, idempotencyKey, now)), leaseExpiresAt: null };
      const { job, lease } = await this.#start(tx, principal, claim, now);
      const event = await this.#event(tx, principal, claim, "progress", message, idempotencyKey, now);
      const target = Math.min(Date.parse(now) + this.#leaseMs, Date.parse(job.authority.expiresAt),
        Date.parse(lease.acquiredAt) + job.authority.maxDurationSeconds * 1000);
      let leaseExpiresAt = lease.expiresAt;
      if (target > Date.parse(lease.expiresAt)) {
        const renewed = await new CanonicalStore(joined(tx)).renewLease({ tenantId: this.#tenantId, leaseId: lease.id,
          expectedVersion: lease.version, epoch: lease.epoch, renewalId: `outbox:fleet-renew:${event.eventId.slice(12)}`,
          idempotencyKey: `fleet-renew:${event.eventId.slice(12)}`, renewedAt: now, expiresAt: iso(new Date(target)) });
        leaseExpiresAt = renewed.lease.expiresAt;
      }
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
   * request reaches the worker that did the work. */
  async myClaims(principal: FleetWorkerPrincipalV1) {
    const rows = (await this.db.query<{ claim_id: string; project_id: string; job_id: string; claimed_at: string | Date;
      lease_state: string; job_state: string; result_id: string | null; decision: string | null; note: string | null }>(
      `SELECT fc.claim_id,fc.project_id,fc.job_id,fc.claimed_at,l.state AS lease_state,j.state AS job_state,
        r.result_id,rv.decision,rv.note
      FROM fleet_claims fc JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
      JOIN control_jobs j ON j.tenant_id=fc.tenant_id AND j.id=fc.job_id
      LEFT JOIN fleet_results r ON r.tenant_id=fc.tenant_id AND r.claim_id=fc.claim_id
      LEFT JOIN fleet_result_reviews rv ON rv.tenant_id=r.tenant_id AND rv.result_id=r.result_id
      WHERE fc.tenant_id=$1 AND fc.worker_id=$2 ORDER BY fc.claimed_at DESC LIMIT 50`,
    [this.#tenantId, principal.workerId])).rows;
    return rows.map(row => Object.freeze({ claimId: row.claim_id, projectId: row.project_id, jobId: row.job_id,
      claimedAt: iso(row.claimed_at), leaseState: row.lease_state, taskState: row.job_state, resultId: row.result_id,
      ownerDecision: row.decision, ownerNote: row.note }));
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
