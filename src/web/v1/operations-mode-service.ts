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
type InstallationOperationsModeViewV1 = OperationsModeRecordV1 | typeof DEFAULT_VIEW;
const isRecordedModeV1 = (value: InstallationOperationsModeViewV1): value is OperationsModeRecordV1 =>
  value.revision > 0;

/** The automatic recovery authority is intentionally narrower than “paused”.
 * It belongs only to the exact recorded auto-pause, never a human decision. */
export function machineHealthAutoResumeAllowedV1(current: Pick<OperationsModeRecordV1, "mode" | "reason"> | undefined,
  pauseReason: string): boolean {
  return current?.mode === "paused" && current.reason === pauseReason;
}

/**
 * Reads the installation's authenticated, server-owned mode. The Mac host,
 * supervisor and fleet gateway all use this reader so they cannot derive
 * different answers from the same revision journal.
 */
export async function readInstallationOperationsModeV1(tx: DatabaseSession, tenantId: string,
  integrityKey: Uint8Array) {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) fail();
  return (await journal(tx, integrityKey, tenantId)).at(-1) ?? DEFAULT_VIEW;
}

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
  /** The coordinator's stop authority, when one has been composed. It is
   * attached after construction because the coordinator only exists once the
   * task application has been built, while the service must exist before it
   * so the supervisor port and the HTTP endpoint are the same object. */
  #stop: OperationsModeStopAuthorityV1 | undefined;
  readonly #clock: () => number;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey: Uint8Array, clock: () => number = Date.now,
    stopAuthority?: OperationsModeStopAuthorityV1) {
    this.#clock = clock;
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("operations_mode_config_invalid");
    if (stopAuthority && (typeof stopAuthority.revokeRunning !== "function" || typeof stopAuthority.listRunningInSession !== "function"))
      throw new Error("operations_mode_config_invalid");
    this.#key = Uint8Array.from(integrityKey);
    this.#authority = new WebSessionAuthority(db, scope, clock, "installation");
    this.#stop = stopAuthority ? Object.freeze({ listRunningInSession: stopAuthority.listRunningInSession.bind(stopAuthority),
      revokeRunning: stopAuthority.revokeRunning.bind(stopAuthority) }) : undefined;
  }

  /**
   * Attaches the coordinator's stop authority once it exists.
   *
   * A second attachment is refused rather than silently replacing the first:
   * two different coordinators' stop paths would mean two answers to "what was
   * running", and a receipt reporting the counts of the wrong one is exactly
   * the false all-clear this control exists to prevent.
   */
  attachStopAuthority(stopAuthority: OperationsModeStopAuthorityV1) {
    if (typeof stopAuthority?.revokeRunning !== "function" || typeof stopAuthority?.listRunningInSession !== "function")
      throw new Error("operations_mode_config_invalid");
    if (this.#stop) throw new Error("operations_mode_stop_authority_attached");
    this.#stop = Object.freeze({ listRunningInSession: stopAuthority.listRunningInSession.bind(stopAuthority),
      revokeRunning: stopAuthority.revokeRunning.bind(stopAuthority) });
  }

  async read(identity: VerifiedWebIdentity) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      // Reading the mode is an owner-visible read of an already-recorded fact.
      // It schedules, assigns, reserves and authorizes nothing.
      actor.require("operations.read", undefined, true);
      const current = await readInstallationOperationsModeV1(tx, this.scope.tenantId, this.#key);
      return operationsModeViewSchemaV1.parse({ schema: "control-room.installation-operations-mode-view/v1",
        mode: current.mode, reason: current.reason, setByIdentityId: current.setByIdentityId ?? "",
        setAt: current.setAt, revision: current.revision, replayed: false,
        admitsNewWork: current.mode === "running", stopRequests: null,
        startsWork: false, grantsExecutionAuthority: false });
    });
  }

  async set(identity: VerifiedWebIdentity, value: unknown): Promise<OperationsModeReceiptV1> {
    const decided = await this.#authority.authenticated(identity, async (tx, actor) => {
      // Owner-only, and reachable only by an owner grant: this is the one
      // switch that stops an entire installation, so an operator's wildcard is
      // not enough and 0155's trigger refuses anything but a live human owner.
      actor.require("operations.read", undefined, true);
      actor.require("operations.set_mode", undefined, true);
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      return this.#decide(tx, { id: actor.id, now: actor.now }, value);
    });
    return this.#finish(decided);
  }

  /**
   * The same decision, made by the installation itself rather than by a signed
   * web session. The supervisor's machine-health check is the only caller: it
   * runs on a timer, with no browser, no cookie and no token to present.
   *
   * This is deliberately NOT a way around the owner-only rule, and it is worth
   * being precise about what it does and does not remove:
   *
   * - It does not mint a session. A synthetic token digest would be a forgery
   *   of the web session authority, so this path never calls `authenticated()`
   *   and never claims a person was at a browser.
   * - The owner is resolved from `control_identities` and `control_role_grants`
   *   directly, under the same conditions 0155's trigger then re-checks
   *   independently. Two owners, no owner, a revoked grant or a non-human
   *   identity are all refused here, and refused again by the database.
   * - Only `paused` is reachable. A machine-health failure must not be able to
   *   drain, stop or otherwise escalate the installation's state.
   *
   * The single-tenant installation case is required: this resolves "the" owner
   * from the database, and with two live owners there is no correct one to
   * choose, so it refuses rather than guessing. The owner pauses and drains
   * from the Home control in that situation.
   */
  async pauseForMachineHealth(reason: string) {
    const parsed = z.object({ mode: z.literal("paused"), reason: z.string().min(1).max(240) }).strict();
    const value = parsed.safeParse({ mode: "paused", reason });
    if (!value.success) throw new WebAccessError("invalid_request");
    const now = new Date(this.#clock()).toISOString();
    const decided = await this.db.transaction(async tx => {
      // Same first lock as every other installation-wide decision and as
      // assignment, so this cannot deadlock and cannot interleave with an
      // owner pressing the button at the same moment.
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      const owner = await this.#liveOwnerInSession(tx, now);
      // Only pause a running installation, so a health check on a timer does
      // not append a revision every cycle and bury the owner's own decisions in
      // the history. An installation that has never recorded a decision is
      // `running` by the same rule every gate uses, so it takes the pause below
      // and produces revision 1.
      if (owner.modes.current !== "running" && owner.modes.record) {
        return { record: owner.modes.record, replayed: true };
      }
      return this.#decide(tx, { id: owner.identityId, now }, value.data, "machine_health_pause");
    });
    return this.#finish(decided);
  }

  /** Resume only the exact automatic pause that is still the latest revision.
   * A later owner Pause, Drain, Stop, or manual resume is a different record,
   * so it is a no-op even if the machine is otherwise healthy. Three automatic
   * pauses in the last hour convert the current one into an owner-required
   * pause instead of starting work again. */
  async resumeAfterMachineHealth(input: Readonly<{ pauseReason: string; resumeReason: string; capReason: string }>) {
    const parsed = z.object({ pauseReason: z.string().min(1).max(240), resumeReason: z.string().min(1).max(240),
      capReason: z.string().min(1).max(240) }).strict().safeParse(input);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const now = new Date(this.#clock()).toISOString();
    const decided = await this.db.transaction(async tx => {
      await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [this.scope.tenantId]);
      const owner = await this.#liveOwnerInSession(tx, now);
      const current = owner.modes.record;
      if (!machineHealthAutoResumeAllowedV1(current, parsed.data.pauseReason))
        return undefined;
      const count = await this.#automaticPauseCount(tx, parsed.data.pauseReason, now);
      if (count >= 3) return this.#decide(tx, { id: owner.identityId, now }, { mode: "paused", reason: parsed.data.capReason }, "machine_health_cap");
      return this.#decide(tx, { id: owner.identityId, now }, { mode: "running", reason: parsed.data.resumeReason }, "machine_health_resume");
    });
    if (!decided) return Object.freeze({ skipped: true as const });
    return this.#finish(decided);
  }

  /** The installation's one live human owner holding a live `operations.set_mode`
   * grant, resolved inside the caller's transaction. `LIMIT 2` is deliberate:
   * two owners is a refusal, not a choice. */
  async #liveOwnerInSession(tx: DatabaseSession, at: string) {
    const rows = (await tx.query<{ id: string; mode: string }>(`SELECT i.id, coalesce(
        (SELECT m.mode FROM installation_operations_mode_revisions m WHERE m.tenant_id=i.tenant_id
          ORDER BY m.revision DESC LIMIT 1), 'running') AS mode
      FROM control_identities i JOIN control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=$1 AND i.actor_type='human' AND i.state='active' AND g.role_key='owner'
        AND (g.allowed_actions @> '["operations.set_mode"]'::jsonb OR g.allowed_actions @> '["*"]'::jsonb)
        AND (g.revoked_at IS NULL OR g.revoked_at > $2::timestamptz)
        AND (g.expires_at IS NULL OR g.expires_at > $2::timestamptz)
      ORDER BY i.id LIMIT 2`, [this.scope.tenantId, at])).rows;
    if (rows.length !== 1) throw new Error("operations_mode_owner_unavailable");
    const current = await readInstallationOperationsModeV1(tx, this.scope.tenantId, this.#key);
    return Object.freeze({ identityId: rows[0]!.id,
      modes: Object.freeze({ current: current.mode, record: isRecordedModeV1(current) ? current : undefined }) });
  }

  async #automaticPauseCount(tx: DatabaseSession, pauseReason: string, at: string): Promise<number> {
    const hourAgo = new Date(Date.parse(at) - 60 * 60_000).toISOString();
    const row = (await tx.query<{ count: number | string }>(`SELECT count(*) AS count
      FROM installation_operations_mode_revisions WHERE tenant_id=$1 AND mode='paused' AND reason=$2 AND set_at>$3`,
    [this.scope.tenantId, pauseReason, hourAgo])).rows[0];
    return Number(row?.count ?? 0);
  }

  /** The decision itself, shared by both entry points so the owner session and
   * the installation's own health check cannot drift apart: the same lock
   * order, the same replay rule, the same record, the same audit event. */
  async #decide(tx: DatabaseSession, actor: { id: string; now: string }, value: unknown,
    automaticAction?: "machine_health_pause" | "machine_health_resume" | "machine_health_cap") {
    const parsed = z.object({ mode: operationsModeV1, reason: z.string().max(240) }).strict().safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const mode = parsed.data.mode, reason = parsed.data.reason.trim();
    {
      const current = await readInstallationOperationsModeV1(tx, this.scope.tenantId, this.#key);
      // An exact repeat is a replay, not a second decision. The same mode with a
      // different reason is a new recorded decision, which is what the owner
      // means by pressing the button again with new words.
      if (isRecordedModeV1(current) && current.mode === mode && current.reason === reason)
        return { record: current, replayed: true };
      // The tenant row is the existing lock order for an installation-wide
      // decision, so this cannot deadlock against assignment (which takes the
      // same first lock), and it serializes two owners setting the mode at once.
      const latest = await readInstallationOperationsModeV1(tx, this.scope.tenantId, this.#key);
      if (isRecordedModeV1(latest) && latest.mode === mode && latest.reason === reason)
        return { record: latest, replayed: true };
      const record: OperationsModeRecordV1 = { schema: "control-room.installation-operations-mode/v1",
        tenantId: this.scope.tenantId, revision: latest.revision + 1, mode, reason,
        setByIdentityId: actor.id, setAt: actor.now };
      assertNoSecretMaterial(record, "operations mode record");
      const inserted = await tx.query(`INSERT INTO installation_operations_mode_revisions
        (tenant_id,revision,mode,reason,set_by_identity_id,set_at,record,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(tenant_id,revision) DO NOTHING RETURNING revision`,
      [this.scope.tenantId, record.revision, record.mode, record.reason, record.setByIdentityId,
        record.setAt, JSON.stringify(record), tag(this.#key, this.scope.tenantId, record)]);
      if (!inserted.rows.length) throw new WebAccessError("conflict");
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope,
        actorId: automaticAction ? "service:supervisor:v1" : actor.id, actorType: automaticAction ? "service" : "human",
        action: `operations.mode.${record.mode}`, targetType: "installation", targetId: this.scope.tenantId,
        occurredAt: record.setAt, safeMetadata: { revision: record.revision, mode: record.mode,
          previousMode: latest.mode, reason, admitsNewWork: record.mode === "running",
          ...(automaticAction ? { automaticAction } : {}) } });
      return { record, replayed: false };
    }
  }

  async #finish(decided: { record: OperationsModeRecordV1; replayed: boolean }): Promise<OperationsModeReceiptV1> {
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
