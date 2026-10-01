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

const GENERATION_ID_V1 = /^backup:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z$/u;
const FAILURE_CODE_V1 = /^[a-z][a-z0-9_]{1,63}$/u;
const DIGEST_V1 = /^sha256:[a-f0-9]{64}$/u;
// An exported snapshot id (`pg_export_snapshot()`, e.g. `00000003-0000001B-1`)
// or an xid-snapshot text. Bounded and never parsed back into a query.
const XID_V1 = /^[0-9A-Fa-f:-]{1,64}$/u;
/**
 * One row-count key: the SERVER-quoted qualified name, `format('%I.%I')`, so
 * every legal identifier — upper case, quotes, unicode — is representable, and
 * two tables can never share a key. Bounded by bytes: two quoted 63-byte names
 * with every byte a doubled quote is 2*(2*63+2)+1 = 257.
 */
const ROW_COUNT_TABLE_MAX_BYTES_V1 = 257;

/** §9.5's default: red at 26 hours, which is two missed nights plus a margin. */
export const BACKUP_MAX_AGE_SECONDS_V1 = 93_600;
/** §9.5: fourteen nightly dumps. */
export const BACKUP_KEPT_GENERATIONS_V1 = 14;
/** A failure retries within the hour; a success waits for the next night. */
export const BACKUP_SUCCESS_RETRY_SECONDS_V1 = 86_400;
export const BACKUP_FAILURE_RETRY_SECONDS_V1 = 3_600;

/**
 * The per-table row counts' shape, shared by the runner (which checks it BEFORE
 * the promote rename) and the completion (which checks it again before the
 * UPDATE). Exported so the runner refuses a shape the ledger would refuse while
 * nothing is promoted yet — review backup19b H1(b): a refusal raised only at
 * completion left a promoted `gen-` directory beside a `failed` row.
 *
 * ANY legal identifier is accepted (the first version accepted only
 * `[a-z0-9_]`, so one upper-case table made every backup fail).
 */
export function assertRowCountsV1(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) throw updaterRefuseV1("updater_backup_row_counts_refused");
  const counts = value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw updaterRefuseV1("updater_backup_row_counts_refused");
    const table = entry.table, count = entry.count;
    if (typeof table !== "string" || table.length < 1 || table.includes("\0")
        || Buffer.byteLength(table) > ROW_COUNT_TABLE_MAX_BYTES_V1 || !Number.isSafeInteger(count) || count < 0)
      throw updaterRefuseV1("updater_backup_row_counts_refused");
    return Object.freeze({ table, count });
  });
  if (Buffer.byteLength(JSON.stringify(counts)) > 65_536) throw updaterBackupRowCountsRefusedV1();
  return counts;
}

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
  // The trailing `Z` goes too, not just the `backup:` prefix. Keeping it would
  // be harmless for uniqueness, but a leaf that reads `...-471Z` invites
  // someone to strip it in an operator command and then find nothing.
  return generationId.slice("backup:".length, -1).replace("T", "_").replaceAll(":", "-");
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
  // The FOUR trailing digits are zero-PADDED, and they are drawn from
  // `pg_catalog.random()` rather than a sequence for a reason worth stating: a
  // sequence would make the id's middle component PREDICTABLE from an observed
  // one, so someone who saw one generation name could guess the next night's name
  // before it was written. They exist only to break ties inside one second; the
  // primary key is still what guarantees uniqueness.
  //
  // FOUR digits rather than three, because THREE was not enough for the density
  // the RETENTION TEST creates: twenty-seven draws from 1,000 values collide about
  // 70% of the time by the birthday bound, and that test mints twenty-seven
  // generations inside one second — so the collision was the common case, not the
  // rare one, and it failed the lane.
  //
  // FOUR digits made it rare but still not acceptable as a silent failure.
  // Twenty-seven draws from 10,000 collide about 0.02% of the time, which is a
  // real failure rate for a job that runs unattended — and two mutation baselines
  // hit it with `23505 unique_violation` at "success 8" and "success 11". A
  // version of this comment claimed "~3%", which is wrong by more than two orders
  // of magnitude; the point stands either way, and the wrong number is worth
  // recording because someone would otherwise trust it.
  //
  // Zero-padding is not cosmetic: `floor(random()*10000)::int::text` yields "47"
  // as often as "875", and an unpadded value fails the `{4}` group in the DDL's
  // CHECK. `lpad` is applied to a `text` cast, not to an integer, because the
  // integer form has no width to pad.
  const result = await client.query(`SELECT 'backup:' || to_char(pg_catalog.now(),
    'YYYY-MM-DD"T"HH24-MI-SS') || '-' || lpad((floor(pg_catalog.random()*10000)::int)::text, 4, '0')
    || 'Z' AS generation_id`);
  const id = result.rows[0]?.generation_id;
  return assertGenerationIdV1(id, "updater_backup_generation_id_refused");
}

/**
 * Everything `completeAttempt` will refuse, checked without touching the
 * database. The runner calls this BEFORE the promote rename, so a completion
 * the ledger would refuse is refused while the generation is still an
 * `.inprogress-` directory (review backup19b H1b), and `completeAttempt` calls
 * it again so the two can never disagree.
 */
export function assertCompletionV1({ generationId, dumpSha256, dumpBytes, fileSha256, shapeDigest, rowCounts,
  snapshotXid = null, encrypted = false, retainedFor = null }) {
  assertGenerationIdV1(generationId, "updater_backup_completion_refused");
  const digest = assertOptionalDigestV1(dumpSha256, "updater_backup_completion_refused");
  const fileDigest = assertOptionalDigestV1(fileSha256, "updater_backup_completion_refused");
  const shape = assertOptionalDigestV1(shapeDigest, "updater_backup_completion_refused");
  if (digest === null || fileDigest === null || shape === null)
    throw updaterRefuseV1("updater_backup_completion_refused");
  if (!Number.isSafeInteger(dumpBytes) || dumpBytes <= 0 || dumpBytes >= 1_099_511_627_776)
    throw updaterRefuseV1("updater_backup_completion_refused");
  const counts = assertRowCountsV1(rowCounts);
  const xid = snapshotXid === null ? null : (typeof snapshotXid === "string" && XID_V1.test(snapshotXid)
    ? snapshotXid : (() => { throw updaterRefuseV1("updater_backup_completion_refused"); })());
  return Object.freeze({ generationId, digest, dumpBytes, fileDigest, shape, counts, xid,
    encrypted: encrypted === true, retainedFor });
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
    shapeDigest: row.shape_digest,
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
 * the updater uses; nothing here works as any other login.
 *
 * `connectLock` opens a SECOND deployer session, which holds the backup lock
 * (see `acquireBackupLock`). It is a factory, not a client, because the lock is
 * a transaction held open for the whole attempt and the ledger writes must
 * commit on their own as they happen — one session cannot do both. */
export class PostgresBackupStoreV1 {
  #lockClient = null;
  constructor(client, { connectLock = null } = {}) { this.client = client; this.connectLock = connectLock; }

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
    // The id is minted by the DATABASE and the INSERT is retried ON A COLLISION,
    // because a collision is not a failure of anything: it is two attempts in the
    // same second drawing the same four random digits, and the right answer is to
    // draw again.
    //
    // Refusing instead — which an earlier version did, on the reasoning that "a
    // retry loop would be a silent way of hiding two real attempts" — cost a
    // nightly backup an entire night, twice: `23505 unique_violation` at
    // "success 8" and "success 11" of the retention test. The primary key still
    // arbitrates, so two real attempts can never share a generation; the loop only
    // changes what happens when the RANDOM SUFFIX repeats, which is not a fact
    // about two attempts at all.
    //
    // ONLY `23505` is retried. Any other SQLSTATE — a missing table, a permission
    // denial, a CHECK failure — is raised as-is, because retrying those would
    // hide a real fault behind a retry loop.
    let generationId = null;
    for (let draw = 0; draw < 12; draw += 1) {
      const candidate = await nextGenerationIdV1(this.client);
      try {
        await this.client.query(`INSERT INTO updater.backup_generations(generation_id,state,completed_at,failure_code)
          VALUES($1,'failed',pg_catalog.now(),'backup_in_progress')`, [candidate]);
        generationId = candidate;
        break;
      } catch (error) {
        // node-postgres puts the SQLSTATE on `code`. A refusal raised by the store
        // itself has no SQLSTATE and must not be retried either.
        if (error?.code !== "23505") throw error;
      }
    }
    if (generationId === null) throw updaterRefuseV1("updater_backup_generation_id_refused");
    // The failure counter is NOT incremented here. An attempt is a failure once
    // it has FAILED, not once it has started: a `kill -9` mid-dump leaves an
    // in-flight row that never completes, and counting it twice — once on start
    // and again on the next attempt's start — let the guard's one-step rule refuse
    // the retry, which is a real deadlock in the recovery path. Measured: a
    // killed child followed by a retry produced "updater backup failure counter
    // moved by more than one" and the backup could not recover without help.
    //
    // So `beginAttempt` only records that an attempt HAPPENED (the badge goes
    // red, the retry is scheduled an hour out) and `failAttempt` is what counts
    // it. An in-flight row that is never completed is visible as
    // `failure_code='backup_in_progress'`, which is a better signal than a
    // counter anyway: it names a run that is stuck rather than one that failed.
    await this.client.query(`UPDATE updater.backup_state SET max_age_seconds=$2, kept_generations=$3,
      last_attempt_at=pg_catalog.now(), last_failure_at=pg_catalog.now(), last_failure_code='backup_in_progress',
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
  async completeAttempt(fields) {
    const { generationId, digest, dumpBytes, fileDigest, shape, counts, xid, encrypted, retainedFor }
      = assertCompletionV1(fields);
    const rowCountsJson = JSON.stringify(counts);
    // Computed HERE, in JavaScript, over the exact bytes handed to PostgreSQL —
    // not with digest(…,'sha256') in SQL. Two reasons, and the second is the
    // one that matters: (1) the column's CHECK wants the `sha256:` prefix, which
    // `encode(digest(...),'hex')` does not produce, so a SQL digest would fail
    // its own constraint; (2) the restore-verify compares this digest against a
    // count read back from the scratch cluster, and a digest computed two
    // different ways on two different sides of that comparison is a comparison
    // that proves nothing.
    const rowCountsDigest = `sha256:${createHash("sha256").update(rowCountsJson).digest("hex")}`;
    const result = await this.client.query(`UPDATE updater.backup_generations SET state='verified',
        completed_at=pg_catalog.now(), dump_sha256=$2, dump_bytes=$3, file_sha256=$4, shape_digest=$5,
        row_counts=$6::jsonb, row_counts_digest=$7, snapshot_xid=$8,
        encrypted=$9, retain_until=$10, failure_code=NULL, failure_detail=NULL
      WHERE generation_id=$1 AND state='failed' AND failure_code='backup_in_progress'
      RETURNING generation_id`,
    [generationId, digest, dumpBytes, fileDigest, shape, rowCountsJson, rowCountsDigest, xid, encrypted, retainedFor]);
    if (result.rows.length !== 1) throw updaterRefuseV1("updater_backup_completion_refused");
    await this.client.query(`UPDATE updater.backup_state SET last_success_at=pg_catalog.now(),
      last_failure_at=NULL, last_failure_code=NULL, consecutive_failures=0,
      next_due_at=pg_catalog.now() + make_interval(secs => $2), last_generation_id=$1
      WHERE singleton`, [generationId, BACKUP_SUCCESS_RETRY_SECONDS_V1]);
    return Object.freeze({ generationId });
  }

  /**
   * Record a failure. The `backup_in_progress` row is rewritten to the real code
   * — the one transition the immutability trigger permits besides completion —
   * and THIS is where the consecutive-failure counter moves, one step, because
   * this is the point at which an attempt is known to have failed.
   *
   * The row must still be in flight (`failure_code='backup_in_progress'`). A
   * failure recorded against an already-failed row, or against a completed one,
   * is a caller reporting something that did not just happen, and is refused.
   */
  async failAttempt({ generationId, code, detail = null }) {
    assertGenerationIdV1(generationId, "updater_backup_failure_refused");
    if (typeof code !== "string" || !FAILURE_CODE_V1.test(code) || code === "backup_in_progress")
      throw updaterRefuseV1("updater_backup_failure_refused");
    const text = detail === null ? null : (typeof detail === "string" && detail.length <= 200 ? detail : null);
    const result = await this.client.query(`UPDATE updater.backup_generations SET completed_at=pg_catalog.now(),
        failure_code=$2, failure_detail=$3
      WHERE generation_id=$1 AND state='failed' AND failure_code='backup_in_progress'
      RETURNING generation_id`, [generationId, code, text]);
    if (result.rows.length !== 1) throw updaterRefuseV1("updater_backup_failure_refused");
    // The failure pair (code + time) and the counter move together, which is
    // what the state guard requires: it refuses a half-cleared pair, and it
    // refuses a counter that moved by more than one. The attempt that just
    // failed is counted exactly once, here.
    await this.client.query(`UPDATE updater.backup_state SET consecutive_failures=consecutive_failures+1,
      last_failure_at=pg_catalog.now(), last_failure_code=$2,
      next_due_at=pg_catalog.now() + make_interval(secs => $1) WHERE singleton`,
    [BACKUP_FAILURE_RETRY_SECONDS_V1, code]);
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
   * Move the next attempt forward. Only the schedule moves here; a busy lock is
   * ALSO recorded as a failed attempt by the runner (review backup19b H1: a skip
   * that recorded nothing let a held lock stop every backup silently). The badge
   * is driven by freshness, not by the failure row, so a backup deferred for a
   * few minutes by a database upgrade does not turn Home red while the last
   * backup is still fresh.
   */
  async scheduleNext(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604_800)
      throw updaterRefuseV1("updater_backup_schedule_refused");
    await this.client.query(`UPDATE updater.backup_state
      SET next_due_at=pg_catalog.now() + make_interval(secs => $1) WHERE singleton`, [seconds]);
  }

  /**
   * The rows still marked in flight. Called only while the backup lock is HELD,
   * so every one of them belongs to a run that is no longer alive: the lock is
   * a transaction on a session, and a dead process's session ends with it.
   * Bounded, because a ledger with a thousand stuck rows is itself a fault and
   * settling them a hundred at a time per run still converges.
   */
  async inFlightGenerations() {
    const result = await this.client.query(`SELECT * FROM updater.backup_generations
      WHERE state='failed' AND failure_code='backup_in_progress' ORDER BY created_at, generation_id LIMIT 100`);
    return result.rows.map(generationFromRowV1);
  }

  /**
   * Every ledger row, newest first, for the sweep: the state is what decides
   * whether a directory on disk may be removed (only a `verified` one, once it
   * is surplus) or must be kept (a `failed` row whose directory is a complete
   * generation — review backup19b M1). Bounded at the ten thousand most recent
   * attempts: an older row's directory is reported as unknown, never removed.
   */
  async ledgerRows() {
    const result = await this.client.query(`SELECT * FROM updater.backup_generations
      ORDER BY created_at DESC, generation_id DESC LIMIT 10000`);
    return result.rows.map(generationFromRowV1);
  }

  /**
   * THE BACKUP LOCK: a row lock on `updater.backup_lock`, held by a dedicated
   * deployer session in an open transaction for the whole attempt.
   *
   * WHY NOT AN ADVISORY LOCK, which the first version used (review backup19b
   * H1a). An advisory key is global to the database and ANY login may take it:
   * measured, `control_room_web` and `control_room_migrator` each ran
   * `pg_try_advisory_lock(<the key>)` and every backup after that returned
   * `busy` — with no failure recorded — for as long as they held it. A row lock
   * needs UPDATE on the row's table, which only the deployer holds: the web has
   * no privilege at all on `updater.backup_lock`, and the migrator has no USAGE
   * on the schema. A candidate release therefore cannot take this lock.
   *
   * The two properties the advisory lock was chosen for are kept:
   *   * it dies with its session, so a `kill -9` releases it (the transaction
   *     aborts when the connection drops);
   *   * item 18 takes the SAME lock for its pre-image dump, so a nightly backup
   *     and a database upgrade can never dump one cluster at once.
   *
   * BOUNDED both ways. `NOWAIT` means a busy lock is an immediate answer, never
   * a wait; and the holding session carries an idle-in-transaction timeout, so
   * a process that hangs (rather than dies) holding the lock loses it after six
   * hours instead of blocking every later backup forever.
   */
  async acquireBackupLock() {
    if (this.#lockClient) return Object.freeze({ status: "busy" });
    if (typeof this.connectLock !== "function") throw updaterRefuseV1("updater_backup_lock_unbound");
    const lockClient = await this.connectLock();
    try {
      const who = await lockClient.query("SELECT current_user AS current_user");
      if (who.rows[0]?.current_user !== "control_room_deployer") throw updaterRefuseV1("updater_backup_store_role_refused");
      await lockClient.query("SET search_path = pg_catalog, updater, pg_temp");
      await lockClient.query("SET idle_in_transaction_session_timeout = '21600s'");
      await lockClient.query("BEGIN");
      let rows;
      try {
        ({ rows } = await lockClient.query(
          "SELECT singleton FROM updater.backup_lock WHERE singleton FOR UPDATE NOWAIT"));
      } catch (error) {
        // 55P03 lock_not_available: somebody holds it. Anything else is a fault.
        if (error?.code === "55P03") {
          await lockClient.query("ROLLBACK").catch(() => {});
          await lockClient.end().catch(() => {});
          return Object.freeze({ status: "busy" });
        }
        throw error;
      }
      if (rows.length !== 1) throw updaterRefuseV1("updater_backup_lock_missing");
      // An error on the idle holding session (its timeout fired, or the server
      // went away) must not become an unhandled 'error' event in a root process.
      lockClient.on?.("error", () => {});
      this.#lockClient = lockClient;
      return Object.freeze({ status: "acquired" });
    } catch (error) {
      await lockClient.end().catch(() => {});
      throw error;
    }
  }

  /** Whether THIS store holds the lock, so the sweep can tell "inside a run"
   * from "called on its own". */
  holdsBackupLock() { return this.#lockClient !== null; }

  async releaseBackupLock() {
    const lockClient = this.#lockClient;
    this.#lockClient = null;
    if (!lockClient) return;
    try { await lockClient.query("ROLLBACK"); } finally { await lockClient.end().catch(() => {}); }
  }
}

/** The backup lock's table. Named once so item 18 takes the same lock. */
export const BACKUP_LOCK_TABLE_V1 = "updater.backup_lock";
