import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, hmacSha256Tag } from "../../security";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority } from "./session-authority";
import { operationsModeReceiptSchemaV1, operationsModeViewSchemaV1, operationsModeV1,
  type OperationsModeReceiptV1 } from "./operations-mode-wire";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const recordSchema = z.object({ schema: z.literal("control-room.installation-operations-mode/v1"),
  tenantId: id, revision: z.number().int().positive(), mode: operationsModeV1, reason: z.string(),
  setByIdentityId: id, setAt: z.string() }).strict();
export type OperationsModeRecordV1 = z.infer<typeof recordSchema>;
type Row = { tenant_id: string; revision: string | number; mode: string; reason: string;
  set_by_identity_id: string; set_at: string | Date; record: unknown; auth_tag: string };

/** The installation's running work, as the coordinator's login sees it. */
export type OperationsModeRunningLeaseV1 = Readonly<{ jobId: string; attemptId: string; leaseId: string;
  leaseEpoch: number; attemptVersion: number; jobVersion: number; projectId: string }>;

/** The set itself starts and stops nothing; only `stopped` asks running work to
 * stop, through the ordinary lease-revocation path below.
 *
 * It runs on the coordinator's own login, in its own transactions, after the
 * mode revision has committed: the private web login holds no grant on the
 * canonical transition tables, so it cannot revoke anything, and a recorded
 * `stopped` must stand on its own whether or not these requests succeed. */
export type OperationsModeStopAuthorityV1 = Readonly<{
  listRunningInSession: (tenantId: string) => Promise<readonly OperationsModeRunningLeaseV1[]>;
  revokeRunning: (input: Readonly<{ tenantId: string; jobId: string; attemptId: string; leaseId: string;
    leaseEpoch: number; attemptVersion: number; jobVersion: number; projectId: string; actorId: string; now: string }>)
    => Promise<"revoked" | "already_terminal">;
}>;

const tag = (key: Uint8Array, tenantId: string, record: OperationsModeRecordV1) => hmacSha256Tag(key,
  { purpose: "installation-operations-mode/v1", tenantId, record });
const fail = (): never => { throw new Error("operations_mode_unavailable"); };

function verifyRow(key: Uint8Array, tenantId: string, value: unknown): OperationsModeRecordV1 {
  const row = value as Row;
  const record = recordSchema.parse(row.record);
  const expected = Buffer.from(tag(key, tenantId, record)), actual = Buffer.from(row.auth_tag ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
    || row.tenant_id !== tenantId || Number(row.revision) !== record.revision
    || row.mode !== record.mode || row.reason !== record.reason
    || row.set_by_identity_id !== record.setByIdentityId
    || new Date(row.set_at).toISOString() !== record.setAt) fail();
  return record;
}

/** The whole journal, verified revision by revision. A single unverifiable row
 * fails the read: the mode is a security-relevant fact and a partially trusted
 * one is worse than none. */
async function journal(tx: DatabaseSession, key: Uint8Array, tenantId: string) {
  const rows = (await tx.query<Row>(`SELECT tenant_id,revision,mode,reason,set_by_identity_id,set_at,record,auth_tag
    FROM installation_operations_mode_revisions WHERE tenant_id=$1 ORDER BY revision ASC`, [tenantId])).rows;
  const records = rows.map(row => verifyRow(key, tenantId, row));
  for (const [index, record] of records.entries()) {
    if (record.revision !== index + 1 || (index > 0 && record.setAt < records[index - 1]!.setAt)) fail();
  }
  return Object.freeze(records);
}

const DEFAULT_VIEW = Object.freeze({ mode: "running" as const, revision: 0, reason: "",
  setByIdentityId: "", setAt: "" });

/**
 * The installation-wide Pause / Drain / Stop switch, server-side.
 *
 * The state is an authenticated append-only revision chain, so "who changed it
 * and when" is a property of the record rather than a convention layered on
 * top. Only the owner session can append: the service requires an owner-only
 * action, and 0155's guard trigger independently refuses any identity that is
 * not a live human owner, so a future code path cannot write this by mistake.
 *
 * Enforcement is not here. 0156 puts the refusal in the database, on the same
 * transaction that would create a claim, an admission or a start, so no
 * application-side check can be skipped, missed or raced.
 */
export class WebOperationsModeServiceV1 {
  readonly #key: Uint8Array;
  readonly #authority: WebSessionAuthority;
  readonly #stop: OperationsModeStopAuthorityV1 | undefined;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey: Uint8Array, clock: () => number = Date.now,
    stopAuthority?: OperationsModeStopAuthorityV1) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("operations_mode_config_invalid");
    if (stopAuthority && (typeof stopAuthority.revokeRunning !== "function" || typeof stopAuthority.listRunningInSession !== "function"))
      throw new Error("operations_mode_config_invalid");
    this.#key = Uint8Array.from(integrityKey);
    this.#authority = new WebSessionAuthority(db, scope, clock, "installation");
    this.#stop = stopAuthority ? Object.freeze({ listRunningInSession: stopAuthority.listRunningInSession.bind(stopAuthority),
      revokeRunning: stopAuthority.revokeRunning.bind(stopAuthority) }) : undefined;
  }

  async read(identity: VerifiedWebIdentity) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      // Reading the mode is an owner-visible read of an already-recorded fact.
      // It schedules, assigns, reserves and authorizes nothing.
      actor.require("operations.read", undefined, true);
      const current = (await journal(tx, this.#key, this.scope.tenantId)).at(-1) ?? DEFAULT_VIEW;
      return operationsModeViewSchemaV1.parse({ schema: "control-room.installation-operations-mode-view/v1",
        mode: current.mode, reason: current.reason, setByIdentityId: current.setByIdentityId ?? "",
        setAt: current.setAt, revision: current.revision, replayed: false,
        admitsNewWork: current.mode === "running", stopRequests: null,
        startsWork: false, grantsExecutionAuthority: false });
    });
  }

  async set(identity: VerifiedWebIdentity, value: unknown): Promise<OperationsModeReceiptV1> {
    const parsed = z.object({ mode: operationsModeV1, reason: z.string().max(240) }).strict().safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const mode = parsed.data.mode, reason = parsed.data.reason.trim();
    const decided = await this.#authority.authenticated(identity, async (tx, actor) => {
      // Owner-only, and reachable only by an owner grant: this is the one
      // switch that stops an entire installation, so an operator's wildcard is
      // not enough and 0155's trigger refuses anything but a live human owner.
      actor.require("operations.read", undefined, true);
      actor.require("operations.set_mode", undefined, true);
      const current = (await journal(tx, this.#key, this.scope.tenantId)).at(-1);
      // An exact repeat is a replay, not a second decision. The same mode with a
      // different reason is a new recorded decision, which is what the owner
      // means by pressing the button again with new words.
      if (current && current.mode === mode && current.reason === reason) return { record: current, replayed: true };
      // The tenant row is the existing lock order for an installation-wide
      // decision, so this cannot deadlock against assignment (which takes the
      // same first lock), and it serializes two owners setting the mode at once.
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      const latest = (await journal(tx, this.#key, this.scope.tenantId)).at(-1);
      if (latest && latest.mode === mode && latest.reason === reason) return { record: latest, replayed: true };
      const record: OperationsModeRecordV1 = { schema: "control-room.installation-operations-mode/v1",
        tenantId: this.scope.tenantId, revision: (latest?.revision ?? 0) + 1, mode, reason,
        setByIdentityId: actor.id, setAt: actor.now };
      assertNoSecretMaterial(record, "operations mode record");
      const inserted = await tx.query(`INSERT INTO installation_operations_mode_revisions
        (tenant_id,revision,mode,reason,set_by_identity_id,set_at,record,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(tenant_id,revision) DO NOTHING RETURNING revision`,
      [this.scope.tenantId, record.revision, record.mode, record.reason, record.setByIdentityId,
        record.setAt, JSON.stringify(record), tag(this.#key, this.scope.tenantId, record)]);
      if (!inserted.rows.length) throw new WebAccessError("conflict");
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, actorId: actor.id, actorType: "human",
        action: `operations.mode.${record.mode}`, targetType: "installation", targetId: this.scope.tenantId,
        occurredAt: record.setAt, safeMetadata: { revision: record.revision, mode: record.mode,
          previousMode: latest?.mode ?? "running", reason, admitsNewWork: record.mode === "running" } });
      return { record, replayed: false };
    });
    // The stop requests run AFTER the mode commits, on the coordinator's own
    // login, in their own transactions. The private web login holds no grant on
    // the canonical transition tables, so it cannot perform a revoke at all,
    // and the recorded mode must not depend on that succeeding: the refusal of
    // new claims and starts is already durable in the committed revision, and
    // 0156 is what enforces it.
    //
    // A replayed press never re-sends them. The request belongs to the
    // revision, and a replay proves that revision already exists and was
    // already acted on.
    if (decided.replayed || decided.record.mode !== "stopped" || !this.#stop) return this.#receipt(decided.record, decided.replayed, null);
    return this.#receipt(decided.record, false, await this.#stopRunningWork(decided.record.setByIdentityId, decided.record.setAt));
  }

  #receipt(record: OperationsModeRecordV1, replayed: boolean, stopRequests: OperationsModeReceiptV1["stopRequests"]) {
    return operationsModeReceiptSchemaV1.parse({ schema: "control-room.installation-operations-mode-receipt/v1",
      mode: record.mode, revision: record.revision, setAt: record.setAt, replayed, stopRequests,
      startsWork: false, grantsExecutionAuthority: false });
  }

  /**
   * Asks running work to stop through the existing revocation path: the same
   * canonical lease/attempt/job transition the owner's ordinary task revoke
   * uses, on the coordinator's own login, one bounded transaction per job.
   *
   * It records the request; it does not and cannot confirm that a process on a
   * worker observed it. Every job that refuses is named in `uncertainJobIds`
   * rather than reported as stopped, and a job that was already terminal counts
   * as a definite no-op rather than an uncertainty.
   *
   * A read that cannot be completed is an uncertainty, not a silent success:
   * a `stopped` receipt that claimed to have stopped everything when it never
   * learned what was running would be the exact false all-clear this control
   * exists to avoid.
   */
  async #stopRunningWork(actorId: string, now: string) {
    if (!this.#stop) return null;
    let leases: readonly OperationsModeRunningLeaseV1[];
    try { leases = await this.#stop.listRunningInSession(this.scope.tenantId); }
    catch { return { requested: null, revoked: 0, uncertainJobIds: [] }; }
    let revoked = 0;
    const uncertainJobIds: string[] = [];
    for (const lease of leases) {
      try {
        const outcome = await this.#stop.revokeRunning({ ...lease, tenantId: this.scope.tenantId, actorId, now });
        if (outcome === "revoked") revoked += 1;
      } catch { uncertainJobIds.push(lease.jobId); }
    }
    return { requested: leases.length, revoked, uncertainJobIds };
  }
}

/** The coordinator's own revocation, so `stopped` uses exactly the transition
 * the owner's task revoke uses rather than a second, weaker stop path. It runs
 * on the coordinator login, which is the only one holding the canonical
 * transition grants; the private web login cannot perform a revoke at all. */
export function operationsModeStopAuthorityV1(coordinator: { listRunning?: unknown; revokeRunning?: unknown }): OperationsModeStopAuthorityV1 | undefined {
  if (!coordinator || typeof coordinator.revokeRunning !== "function" || typeof coordinator.listRunning !== "function") return undefined;
  return { listRunningInSession: (coordinator.listRunning as OperationsModeStopAuthorityV1["listRunningInSession"]).bind(coordinator),
    revokeRunning: (coordinator.revokeRunning as OperationsModeStopAuthorityV1["revokeRunning"]).bind(coordinator) };
}
