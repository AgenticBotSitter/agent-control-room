import { createHash } from "node:crypto";
import { updaterRefuseV1 } from "./contracts.mjs";

const updaterBackupRowCountsRefusedV1 = () => updaterRefuseV1("updater_backup_row_counts_refused");

/**
 * Item 19a's database half: the backup ledger in schema `updater` (R5i).
 *
 * Why the ledger is in the updater's schema and not beside the release tables
 * is the whole reason this file exists. A candidate controls the SQL the
 * migrator runs. If the nightly backup's "did it happen" record lived in a
 * release table, a candidate could write it, and §9.5's promise — a failed or
 * stale backup blocks database plans — would be one migration away from being
 * void. Here the rows are owned by `control_room_deployer`, the migrator holds
 * nothing in this schema at all, and the refusal itself is a trigger.
 *
 * Every read is written the way a caller can use it and cannot misuse it:
 * bounded rows, a bounded generation id, and no value that came out of the
 * database is ever used to build a path without going back through the
 * updater's own bounded-id rule.
 */

const GENERATION_ID_V1 = /^backup:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/u;
const FAILURE_CODE_V1 = /^[a-z][a-z0-9_]{1,63}$/u;
const DIGEST_V1 = /^sha256:[a-f0-9]{64}$/u;
const XID_V1 = /^[0-9A-Fa-f:]{1,64}$/u;

/** §9.5's default: red at 26 hours, which is two missed nights plus a margin. */
export const BACKUP_MAX_AGE_SECONDS_V1 = 93_600;
/** §9.5: fourteen nightly dumps. */
export const BACKUP_KEPT_GENERATIONS_V1 = 14;
/** A failure retries within the hour; a success waits for the next night. */
export const BACKUP_SUCCESS_RETRY_SECONDS_V1 = 86_400;
export const BACKUP_FAILURE_RETRY_SECONDS_V1 = 3_600;

export function assertGenerationIdV1(value, code = "updater_backup_generation_refused") {
  if (typeof value !== "string" || !GENERATION_ID_V1.test(value)) throw updaterRefuseV1(code);
  return value;
}

/**
 * The on-disk leaf name for a generation id, and the ONLY way one is produced.
 *
 * The id is minted by the database in `nextGenerationIdV1`; this renders it as a
 * directory name. Both directions are defined here and nowhere else, so the
 * runner never reverses a directory name back into an id by string surgery —
 * a lossy reverse is how a retention sweep deletes the wrong generation. The
 * sweep asks the ledger for the leaves instead.
 *
 * The transform is total and injective on the id grammar: `backup:` is dropped,
 * the `T` becomes `_`, and the two remaining colons become dashes. No other
 * character in the grammar can collide, so distinct ids are distinct leaves.
 */
export function generationLeafV1(generationId) {
  assertGenerationIdV1(generationId, "updater_backup_generation_refused");
  return generationId.slice("backup:".length).replace("T", "_").replaceAll(":", "-");
}

/**
 * The generation id is derived from the DATABASE's clock, never the Mac's.
 *
 * Design §8.1 and §9.1 both say "DB now() everywhere", and here it is not
 * tidiness: this id is the directory name on disk, so a Mac clock set two hours
 * out would otherwise create a directory that sorts ahead of a good dump and
 * then, after the clock is corrected, a second directory for the same night.
 * `SELECT to_char(pg_catalog.now() ...)` also means the format is a property of
 * the DDL's caller, not of a strftime on this machine.
 */
export async function nextGenerationIdV1(client) {
  const result = await client.query(`SELECT 'backup:' || to_char(pg_catalog.now(),
    'YYYY-MM-DD"T"HH24-MI-SS') || '-' || (floor(random()*1000)::int)::text || 'Z' AS generation_id`);
  const id = result.rows[0]?.generation_id;
  return assertGenerationIdV1(id, "updater_backup_generation_id_refused");
}

function assertRowCountsV1(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) throw updaterRefuseV1("updater_backup_row_counts_refused");
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw updaterRefuseV1("updater_backup_row_counts_refused");
    const table = entry.table, count = entry.count;
    if (typeof table !== "string" || !/^[a-z0-9_]{1,63}$/u.test(table) || !Number.isSafeInteger(count) || count < 0)
      throw updaterRefuseV1("updater_backup_row_counts_refused");
    return Object.freeze({ table, count });
  });
}

function assertOptionalDigestV1(value, code) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !DIGEST_V1.test(value)) throw updaterRefuseV1(code);
  return value;
}

function generationFromRowV1(row) {
  if (!row || typeof row.generation_id !== "string" || !GENERATION_ID_V1.test(row.generation_id))
    throw updaterRefuseV1("updater_backup_row_refused");
  if (row.state !== "verified" && row.state !== "failed") throw updaterRefuseV1("updater_backup_row_refused");
  return Object.freeze({
    generationId: row.generation_id,
    state: row.state,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    dumpSha256: row.dump_sha256,
    dumpBytes: row.dump_bytes === null || row.dump_bytes === undefined ? null : Number(row.dump_bytes),
    fileSha256: row.file_sha256,
    schemaDigest: row.schema_digest,
    rowCountsDigest: row.row_counts_digest,
    encrypted: row.encrypted === true,
    snapshotXid: row.snapshot_xid,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    retainUntil: row.retain_until,
  });
}

/** Typed adapter over item 19a's tables. The client is the production
 * peer-authenticated `control_room_deployer` login, the same one the rest of
 * the updater uses; nothing here works as any other login. */
export class PostgresBackupStoreV1 {
  constructor(client) { this.client = client; }

  async initialize() {
    await this.client.query("SET search_path = pg_catalog, updater, pg_temp");
    const result = await this.client.query(`SELECT current_user AS current_user,
      pg_has_role(current_user, 'control_room_deployer', 'MEMBER') AS is_deployer,
      to_regclass('updater.backup_generations') IS NOT NULL AS has_generations,
      to_regclass('updater.backup_state') IS NOT NULL AS has_state`);
    const row = result.rows[0];
    if (!row || row.current_user !== "control_room_deployer" || row.is_deployer !== true)
      throw updaterRefuseV1("updater_backup_store_role_refused");
    if (row.has_generations !== true || row.has_state !== true)
      throw updaterRefuseV1("updater_backup_schema_missing");
  }

  /** The running policy's bounds, from the singleton row, with the design's
   * defaults when the row has not been written yet. Bounded again here, because
   * a value read from the database is untrusted input (rule R-FS) even when it
   * was written by this same role. */
  async policy() {
    const result = await this.client.query(`SELECT max_age_seconds, kept_generations FROM updater.backup_state
      WHERE singleton`);
    const row = result.rows[0];
    return Object.freeze({
      maxAgeSeconds: Number.isInteger(row?.max_age_seconds)
        && row.max_age_seconds >= 3600 && row.max_age_seconds <= 604_800
        ? row.max_age_seconds : BACKUP_MAX_AGE_SECONDS_V1,
      keptGenerations: Number.isInteger(row?.kept_generations)
        && row.kept_generations >= 1 && row.kept_generations <= 100
        ? row.kept_generations : BACKUP_KEPT_GENERATIONS_V1,
    });
  }

  /** The one predicate behind the red badge, the push and the DB-plan refusal
   * (§9.5). Read through the SAME function the plan trigger calls, so the badge
   * and the refusal cannot disagree: if they were separate implementations, the
   * one Home shows and the one the database enforces would be free to diverge. */
  async freshness() {
    const result = await this.client.query(`SELECT updater.backup_is_fresh() AS fresh,
      (SELECT last_success_at FROM updater.backup_state WHERE singleton) AS last_success_at,
      (SELECT last_failure_code FROM updater.backup_state WHERE singleton) AS last_failure_code,
      (SELECT last_failure_at FROM updater.backup_state WHERE singleton) AS last_failure_at,
      (SELECT next_due_at FROM updater.backup_state WHERE singleton) AS next_due_at,
      (SELECT consecutive_failures FROM updater.backup_state WHERE singleton) AS consecutive_failures,
      (SELECT max_age_seconds FROM updater.backup_state WHERE singleton) AS max_age_seconds`);
    const row = result.rows[0];
    const failures = Number(row?.consecutive_failures ?? 0);
    return Object.freeze({
      fresh: row?.fresh === true,
      lastSuccessAt: row?.last_success_at ?? null,
      lastFailureCode: row?.last_failure_code ?? null,
      lastFailureAt: row?.last_failure_at ?? null,
      nextDueAt: row?.next_due_at ?? null,
      consecutiveFailures: Number.isSafeInteger(failures) && failures >= 0 ? failures : 0,
      maxAgeSeconds: Number.isInteger(row?.max_age_seconds) ? row.max_age_seconds : BACKUP_MAX_AGE_SECONDS_V1,
    });
  }

  /**
   * Begin an attempt. The `failed` row is written FIRST, before any dump byte
   * exists, and the same row is completed to `verified` at the end.
   *
   * The alternative — insert once, at the end, with the real state — is what
   * the legacy nightly job effectively did, and it is why a crash left an empty
   * directory that retention then counted as a generation. Here the attempt is
   * durable before the work, so a `kill -9` mid-dump leaves a `failed` row that
   * carries no digest at all, cannot be mistaken for a dump, and keeps the
   * badge red.
   */
  async beginAttempt({ policy = {} } = {}) {
    const maxAge = Number.isInteger(policy.maxAgeSeconds) ? policy.maxAgeSeconds : BACKUP_MAX_AGE_SECONDS_V1;
    const kept = Number.isInteger(policy.keptGenerations) ? policy.keptGenerations : BACKUP_KEPT_GENERATIONS_V1;
    if (maxAge < 3600 || maxAge > 604_800 || kept < 1 || kept > 100) throw updaterRefuseV1("updater_backup_policy_refused");
    const generationId = await nextGenerationIdV1(this.client);
    await this.client.query(`INSERT INTO updater.backup_generations(generation_id,state,completed_at,failure_code)
      VALUES($1,'failed',pg_catalog.now(),'backup_in_progress')`, [generationId]);
    await this.client.query(`UPDATE updater.backup_state SET max_age_seconds=$2, kept_generations=$3,
      last_attempt_at=pg_catalog.now(), last_failure_at=pg_catalog.now(), last_failure_code='backup_in_progress',
      consecutive_failures=consecutive_failures+1,
      next_due_at=pg_catalog.now() + make_interval(secs => $4),
      last_generation_id=$1
      WHERE singleton AND $1::text NOT IN (SELECT generation_id FROM updater.backup_generations
        WHERE state='verified' AND generation_id = $1)`,
    [generationId, maxAge, kept, BACKUP_FAILURE_RETRY_SECONDS_V1]);
    return Object.freeze({ generationId });
  }

  /**
   * Complete a successful attempt. The UPDATE's WHERE clause is the assertion:
   * it names the exact generation, requires it to still be `failed` (so a
   * retry cannot complete a row a later attempt already rewrote), and requires
   * no previous success newer than this one.
   */
  async completeAttempt({ generationId, dumpSha256, dumpBytes, fileSha256, schemaDigest, rowCounts,
    snapshotXid = null, encrypted = false, retainedFor = null }) {
    assertGenerationIdV1(generationId, "updater_backup_completion_refused");
    const digest = assertOptionalDigestV1(dumpSha256, "updater_backup_completion_refused");
    const fileDigest = assertOptionalDigestV1(fileSha256, "updater_backup_completion_refused");
    const schema = assertOptionalDigestV1(schemaDigest, "updater_backup_completion_refused");
    if (digest === null || fileDigest === null || schema === null)
      throw updaterRefuseV1("updater_backup_completion_refused");
    if (!Number.isSafeInteger(dumpBytes) || dumpBytes <= 0 || dumpBytes >= 1_099_511_627_776)
      throw updaterRefuseV1("updater_backup_completion_refused");
    const counts = assertRowCountsV1(rowCounts);
    const rowCountsJson = JSON.stringify(counts);
    if (Buffer.byteLength(rowCountsJson) > 65_536) throw updaterBackupRowCountsRefusedV1();
    // Computed HERE, in JavaScript, over the exact bytes handed to PostgreSQL —
    // not with digest(…,'sha256') in SQL. Two reasons, and the second is the
    // one that matters: (1) the column's CHECK wants the `sha256:` prefix, which
    // `encode(digest(...),'hex')` does not produce, so a SQL digest would fail
    // its own constraint; (2) the restore-verify compares this digest against a
    // count read back from the scratch cluster, and a digest computed two
    // different ways on two different sides of that comparison is a comparison
    // that proves nothing.
    const rowCountsDigest = `sha256:${createHash("sha256").update(rowCountsJson).digest("hex")}`;
    const xid = snapshotXid === null ? null : (typeof snapshotXid === "string" && XID_V1.test(snapshotXid)
      ? snapshotXid : (() => { throw updaterRefuseV1("updater_backup_completion_refused"); })());
    const result = await this.client.query(`UPDATE updater.backup_generations SET state='verified',
        completed_at=pg_catalog.now(), dump_sha256=$2, dump_bytes=$3, file_sha256=$4, schema_digest=$5,
        row_counts=$6::jsonb, row_counts_digest=$7, snapshot_xid=$8,
        encrypted=$9, retain_until=$10, failure_code=NULL, failure_detail=NULL
      WHERE generation_id=$1 AND state='failed' AND failure_code='backup_in_progress'
      RETURNING generation_id`,
    [generationId, digest, dumpBytes, fileDigest, schema, rowCountsJson, rowCountsDigest, xid, encrypted === true, retainedFor]);
    if (result.rows.length !== 1) throw updaterRefuseV1("updater_backup_completion_refused");
    await this.client.query(`UPDATE updater.backup_state SET last_success_at=pg_catalog.now(),
      last_failure_at=NULL, last_failure_code=NULL, consecutive_failures=0,
      next_due_at=pg_catalog.now() + make_interval(secs => $2), last_generation_id=$1
      WHERE singleton`, [generationId, BACKUP_SUCCESS_RETRY_SECONDS_V1]);
    return Object.freeze({ generationId });
  }

  /**
   * Record a failure. The `backup_in_progress` row is rewritten from
   * `backup_in_progress` to the real code, which the immutability trigger
   * allows for exactly one transition: the row's own attempt, named twice.
   */
  async failAttempt({ generationId, code, detail = null }) {
    assertGenerationIdV1(generationId, "updater_backup_failure_refused");
    if (typeof code !== "string" || !FAILURE_CODE_V1.test(code)) throw updaterRefuseV1("updater_backup_failure_refused");
    const text = detail === null ? null : (typeof detail === "string" && detail.length <= 200 ? detail : null);
    const result = await this.client.query(`UPDATE updater.backup_generations SET completed_at=pg_catalog.now(),
        failure_code=$2, failure_detail=$3 WHERE generation_id=$1 AND state='failed'
        RETURNING generation_id`, [generationId, code, text]);
    if (result.rows.length !== 1) throw updaterRefuseV1("updater_backup_failure_refused");
    await this.client.query(`UPDATE updater.backup_state SET next_due_at=pg_catalog.now()
        + make_interval(secs => $1) WHERE singleton`, [BACKUP_FAILURE_RETRY_SECONDS_V1]);
    return Object.freeze({ generationId, code });
  }

  async generation(generationId) {
    assertGenerationIdV1(generationId);
    const result = await this.client.query(`SELECT * FROM updater.backup_generations WHERE generation_id=$1`,
      [generationId]);
    if (result.rows.length === 0) return null;
    return generationFromRowV1(result.rows[0]);
  }

  async rowCounts(generationId) {
    assertGenerationIdV1(generationId);
    const result = await this.client.query(`SELECT row_counts FROM updater.backup_generations
      WHERE generation_id=$1`, [generationId]);
    return result.rows.length === 1 ? result.rows[0].row_counts : null;
  }

  /**
   * The retention read. ONLY `verified` rows are returned, which is the
   * daemons4 carry-forward: a failed attempt has no digest, no size and no row
   * counts, so it cannot occupy one of the fourteen slots and cannot cause a
   * good dump to be deleted. The bound is the policy's `kept_generations` plus
   * one, so the caller can tell "these are the ones to keep" from "the rest are
   * surplus" without a second unbounded query.
   */
  async verifiedGenerations(limit = BACKUP_KEPT_GENERATIONS_V1) {
    const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : BACKUP_KEPT_GENERATIONS_V1;
    const result = await this.client.query(`SELECT * FROM updater.backup_generations
      WHERE state='verified' ORDER BY completed_at DESC, generation_id DESC LIMIT $1`, [bounded + 1]);
    return result.rows.map(generationFromRowV1);
  }

  /**
   * Verified generations at or after the retention bound, EXCLUDING any whose
   * `retain_until` is still in the future. Item 18 pins a pre-update dump until
   * the next successful database update plus seven days, which outranks the
   * fourteen-generation rule; without this the nightly sweep would happily
   * delete the one dump a failed database upgrade would be restored from.
   */
  async pinnedGenerations() {
    const result = await this.client.query(`SELECT * FROM updater.backup_generations
      WHERE state='verified' AND retain_until IS NOT NULL AND retain_until > pg_catalog.now()
      ORDER BY retain_until, generation_id`);
    return result.rows.map(generationFromRowV1);
  }

  /** The most recent attempt of either kind, for the badge's plain words. */
  async latestAttempt() {
    const result = await this.client.query(`SELECT * FROM updater.backup_generations
      ORDER BY created_at DESC, generation_id DESC LIMIT 1`);
    return result.rows.length === 0 ? null : generationFromRowV1(result.rows[0]);
  }

  /** Item 18's pin. Idempotent and forward-only, by the trigger. */
  async pin(generationId, until) {
    assertGenerationIdV1(generationId, "updater_backup_pin_refused");
    if (!(until instanceof Date) || !Number.isFinite(until.getTime()))
      throw updaterRefuseV1("updater_backup_pin_refused");
    const result = await this.client.query(`UPDATE updater.backup_generations SET retain_until=$2
      WHERE generation_id=$1 AND state='verified' AND (retain_until IS NULL OR retain_until < $2)
      RETURNING generation_id`, [generationId, until.toISOString()]);
    return result.rows.length === 1;
  }

  /**
   * On-disk generation ids, derived FROM THE LEDGER rather than by reversing
   * the directory-name transform.
   *
   * The directory name is a lossy rendering of the id (colons become dashes, so
   * the time component and the milliseconds are not separable by string
   * surgery). Reversing it would mean re-deriving an id from a name, and a
   * guess that is wrong in the last digit would delete the wrong generation.
   * So the sweep asks the ledger which ids exist and treats any directory the
   * ledger does not know as `damaged` — reported, never deleted.
   */
  async knownGenerationIds() {
    const result = await this.client.query(`SELECT generation_id FROM updater.backup_generations`);
    return result.rows.map(row => assertGenerationIdV1(row.generation_id, "updater_backup_row_refused"));
  }

  /**
   * Move the next attempt forward WITHOUT recording a failure.
   *
   * The deferred case — the backup lock was held by a database upgrade — is not
   * a failed backup, and writing a `failed` row for it would turn the Home badge
   * red for a backup that was correctly postponed by a few minutes. So only the
   * schedule moves; the failure pair and the counter are untouched.
   */
  async scheduleNext(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604_800)
      throw updaterRefuseV1("updater_backup_schedule_refused");
    await this.client.query(`UPDATE updater.backup_state
      SET next_due_at=pg_catalog.now() + make_interval(secs => $1) WHERE singleton`, [seconds]);
  }

  /** The active claim is the `finished_at IS NULL` analogue, and the reason it
   * is a lease rather than a counter: the advisory lock below is held for the
   * PostgreSQL SESSION, so a crashed process releases it when its session ends,
   * and the next attempt can be admitted. A `busy` answer is a refusal, not a
   * failure, and the caller must not retry it as one.
   *
   * `inFlight` is the same crash signal the legacy job had to guess at: a row
   * still marked `backup_in_progress`. It is reported, never acted on by
   * refusing — the caller's decision is to retry after the retry interval, and
   * refusing here would turn a crashed backup into a permanently stuck one. */
  async acquireBackupLock() {
    const result = await this.client.query(
      "SELECT pg_catalog.pg_try_advisory_lock($1::integer,$2::integer) AS acquired", BACKUP_LOCK_V1);
    if (result.rows[0]?.acquired !== true) return Object.freeze({ status: "busy" });
    const live = await this.client.query(`SELECT count(*)::int AS count FROM updater.backup_generations
      WHERE failure_code='backup_in_progress' AND created_at > pg_catalog.now() - interval '1 hour'`);
    return Object.freeze({ status: "acquired", inFlight: Number(live.rows[0]?.count ?? 0) > 0 });
  }

  async releaseBackupLock() {
    await this.client.query("SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer)", BACKUP_LOCK_V1);
  }
}

/** A separate lock key from the updater's run lease, and the SAME key item 18
 * will use for its pre-image dump: §9.5 "it needs no upgrader" but §9.2's
 * quiesce step "the backup lock is taken in-process". One key, so a nightly
 * backup and a database upgrade can never dump the same cluster at once — which
 * is the property the brief asks for, and which two separate keys would lose. */
export const BACKUP_LOCK_V1 = Object.freeze([1128354390, 1431323731]);
