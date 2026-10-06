// Bot credentials after a database restore (R5B-06).
//
// WHY THIS EXISTS. A restore brings back credential ROWS, and the gateway
// authenticates purely from those rows. So a restore silently reverses two
// decisions the owner made after the backup was taken:
//
//   * a bot the owner REVOKED authenticates again — the owner's removal is undone
//     by a recovery, with no notice;
//   * bots that RENEWED or JOINED after the backup lose access entirely — they
//     are locked out of work they were doing, and the connector's only report is
//     "Control Room revoked this machine's key", which is a lie.
//
// MEASURED on PostgreSQL 17 through the real gateway and the real connector
// over HTTP, as the production `control_room_fleet` and `control_room_fleet_owner`
// logins (round 5, R5B-06): three bots joined, the backup was taken, then one
// renewed, the owner revoked a second, and a third joined. After restoring and
// starting the gateway on the restored database, the revoked bot's heartbeat was
// `ok` and the owner's worker list showed it as `connected`.
//
// THE RULE, decided and documented rather than left to the restore's discretion:
// a restore RETIRES EVERY bot credential the restored database holds. Not the
// revoked ones only — all of them. Retire, never delete:
//
//   * `retired` rather than `revoked`, because `revoked` means "the owner removed
//     this bot" and the owner removed none of these; the state that says "this key
//     stopped working" without claiming a decision is the credential's own.
//   * `retired` rather than deletion, because `fleet_worker_credentials` is
//     append-only by trigger and because the history is the audit trail.
//   * EVERY credential, not just the ones the backup predates, because the
//     restore cannot tell the two apart and the pair that matters for safety is
//     the revoked one. Retiring the whole set is the only rule that cannot be
//     defeated by a timing detail, and it costs the owner exactly one thing: each
//     bot re-keys itself once. `gateway-store`'s re-key path already replaces
//     whatever credential a machine held, so the recovery is the bot's normal
//     renewal.
//
// The alternative the round-5 report offered — keeping revocations in a file
// outside the database and re-applying them — was rejected: a file the database
// does not know about is a second source of truth for access decisions, it has
// no owner in the schema, and it cannot be restored or verified with the backup
// it belongs to.
//
// NOTHING IS GRANTED AND NO CREDENTIAL IS ISSUED. This retires what the restored
// rows hold and writes the owner a notice naming the machines involved. Issuing
// new keys is the gateway's own re-key path, and it happens when a bot asks.
//
// The notice is a real `control_action_inbox` incident row, in the shape
// `actionInboxItemSchemaV1` accepts, so it appears in the owner's existing
// "Needs me" list with the same plain wording as every other attention item — no
// new UI, no new table, and nothing to migrate.
import { connectTarget } from "./evidence.mjs";

/** The one-line action the owner is asked to take, and the reason recorded. */
export const RESTORED_BOT_NOTICE_ACTION_V1 = "Re-key your bots after the restore";
export const RESTORED_BOT_NOTICE_REASON_V1 = "restored_bots_need_rekeying";
export const RESTORED_BOT_NOTICE_ID_V1 = "attention:restored-bots";

/**
 * The table/column facts this module depends on, read from db/migrations so a
 * rename cannot silently turn the retirement into a no-op. Verified here rather
 * than assumed, because every other part of the file is a policy statement and a
 * policy statement that quietly matches nothing is worse than no policy.
 */
export const REQUIRED_RESTORE_BOT_FACTS_V1 = Object.freeze({
  credentialTable: "fleet_worker_credentials",
  credentialStateColumn: "state",
  credentialEndedColumn: "ended_at",
  workerTable: "fleet_workers",
  workerDisplayColumn: "display_name",
  /** The states `fleet_worker_credentials.state` accepts (0140). */
  credentialStates: Object.freeze(["active", "retired", "revoked"]),
  /** The only transition the 0140 write guard permits on an existing row. */
  retiringTransition: "active->retired",
});

/**
 * Does this restored database hold bot credentials at all?
 *
 * A restore of a backup taken before the fleet existed, or a target that is not
 * this product's database at all, has no such table. That is not a failure and
 * is never reported as one — the retirement is about bots, and there are none.
 *
 * @param {{ query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 */
export async function readRestoredBotFactsV1(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.fleet_worker_credentials') IS NOT NULL AS credentials,
            to_regclass('public.fleet_workers') IS NOT NULL AS workers,
            to_regclass('public.tenants') IS NOT NULL AS tenants,
            to_regclass('public.control_action_inbox') IS NOT NULL AS inbox`);
  return { credentials: rows[0]?.credentials === true, workers: rows[0]?.workers === true,
    tenants: rows[0]?.tenants === true, inbox: rows[0]?.inbox === true };
}

/**
 * Retire every active bot credential in the restored database, and report what
 * changed.
 *
 * ONE statement, so this cannot half-apply: `retired` is written with
 * `ended_at = statement_timestamp()` for exactly the rows that were `active`, and
 * the returned rows are the ones this call changed. A second call finds nothing
 * to retire and returns an empty list, which is what makes it safe to run twice —
 * an operator re-running the restore, or the owner's own retry after an
 * interrupted attempt.
 *
 * `ended_at` is set to `greatest(issued_at, statement_timestamp())` because
 * 0140 CHECKs `ended_at >= issued_at`: a restored credential that expired
 * before the restore ran must not be refused for ending "before" it was issued.
 *
 * The `state = 'revoked'` rows the restore brought back are left EXACTLY as the
 * backup recorded them, and are counted separately in the report so the owner is
 * told about them. Those are the bots whose revocation the restore undid, and
 * the answer is that they hold no usable key: they were revoked before the
 * backup and stay revoked in the record, and their key does not work because
 * every key is retired.
 *
 * @param {string | Record<string, unknown>} target
 * @returns {Promise<{ retired: { tenantId: string, workerId: string, displayName: string }[],
 *   revokedByBackup: { tenantId: string, workerId: string, displayName: string }[],
 *   tenants: string[] }>}
 */
export async function retireRestoredBotCredentialsV1(target) {
  const client = connectTarget(target);
  await client.connect();
  try {
    const facts = await readRestoredBotFactsV1(client);
    if (!facts.credentials || !facts.workers) return { retired: [], revokedByBackup: [], tenants: [] };
    const revoked = (await client.query(
      `SELECT c.tenant_id, c.worker_id, w.display_name FROM fleet_worker_credentials c
        JOIN fleet_workers w ON w.tenant_id = c.tenant_id AND w.worker_id = c.worker_id
       WHERE c.state = 'revoked' ORDER BY c.tenant_id, c.worker_id`)).rows
      .map(row => ({ tenantId: row.tenant_id, workerId: row.worker_id, displayName: row.display_name }));
    // `UPDATE ... RETURNING` is the atomic claim: two callers racing here get
    // disjoint sets, because only one of them can move a given row out of
    // 'active'. No second caller can retire a row the first already retired.
    const retired = (await client.query(
      `UPDATE fleet_worker_credentials SET state = 'retired',
              ended_at = greatest(issued_at, statement_timestamp())
        WHERE state = 'active'
        RETURNING tenant_id, worker_id,
          (SELECT display_name FROM fleet_workers w
            WHERE w.tenant_id = fleet_worker_credentials.tenant_id
              AND w.worker_id = fleet_worker_credentials.worker_id) AS display_name`)).rows
      .map(row => ({ tenantId: row.tenant_id, workerId: row.worker_id,
        displayName: typeof row.display_name === "string" ? row.display_name : "unnamed machine" }));
    return { retired, revokedByBackup: revoked, tenants: [...new Set([...retired, ...revoked]
      .map(row => row.tenantId))].sort() };
  } finally {
    await client.end();
  }
}

/**
 * Build the owner's notice. Pure, so the exact wording and shape can be asserted
 * without a database, and so the same words cannot drift between the shape that
 * is written and the shape that is checked.
 *
 * One item per tenant, because `control_action_inbox` is keyed
 * `(tenant_id, id)` and a single install can hold several. The id is fixed so a
 * re-run updates one row rather than filling the owner's list with copies, and
 * `created_at` is preserved on conflict by the upsert's `WHERE NOT (payload
 * unchanged)` logic in the store — here the notice is written by the restore tool
 * itself, so the row is updated in place and its creation time kept.
 *
 * @param {ReadonlyArray<{ tenantId: string, workerId: string, displayName: string }>} retired
 * @param {ReadonlyArray<{ tenantId: string, workerId: string, displayName: string }>} revokedByBackup
 * @param {string} identityDigest
 */
export function restoredBotNoticeItemsV1(retired, revokedByBackup, identityDigest) {
  if (!Array.isArray(retired) || !Array.isArray(revokedByBackup)
    || typeof identityDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(identityDigest))
    throw new Error("restore_bot_notice_input_refused");
  const groups = new Map();
  const group = (row, bucket) => {
    if (typeof row?.tenantId !== "string" || typeof row?.workerId !== "string") throw new Error("restore_bot_notice_input_refused");
    const entry = groups.get(row.tenantId) ?? { retired: [], revoked: [] };
    entry[bucket].push(row.displayName);
    groups.set(row.tenantId, entry);
  };
  for (const row of retired) group(row, "retired");
  for (const row of revokedByBackup) group(row, "revoked");
  if (groups.size === 0) return [];
  const createdAt = new Date().toISOString();
  return [...groups.entries()].map(([tenantId, bucket]) => {
    const machines = [...bucket.retired, ...bucket.revoked].sort();
    const revoked = bucket.revoked.length;
    const summary = `${machines.length} ${machines.length === 1 ? "machine" : "machines"} can no longer sign in after the restore.`
      + (revoked > 0 ? ` ${revoked} of them you had already removed, and stay removed.` : "")
      + " Re-key them from Control Room to carry on.";
    return Object.freeze({
      id: RESTORED_BOT_NOTICE_ID_V1, tenantId, kind: "incident", state: "open",
      deliveryState: "not_requested", createdAt,
      requestedAction: RESTORED_BOT_NOTICE_ACTION_V1, reasonCode: RESTORED_BOT_NOTICE_REASON_V1,
      blockedWorkItemIds: [],
      // `legalResponses` is the contract's "what the owner can do here", and it
      // requires at least one. "Acknowledge" is the honest one: the re-key
      // itself is done on the bot, not by the owner, and the item exists so the
      // owner knows the machine is not broken.
      legalResponses: Object.freeze([Object.freeze({ id: "acknowledge:r5b06", kind: "record_decision",
        label: "I understand, re-keying now", requiresConfirmation: false, available: true })]),
      evidence: Object.freeze([Object.freeze({ id: "restore_identity", kind: "verification",
        digest: identityDigest, observedAt: createdAt })]),
      summary, machines: Object.freeze(machines),
    });
  });
}

/**
 * Write the owner's notice rows. Best-effort by design and REFUSED LOUDLY on
 * failure: a restore that retired keys and could not tell the owner is worse
 * than one that did neither, so this throws rather than swallowing, and the
 * restore's own error text says the keys were retired without a notice.
 *
 * @param {string | Record<string, unknown>} target
 * @param {ReturnType<typeof restoredBotNoticeItemsV1>} items
 */
export async function writeRestoredBotNoticeV1(target, items) {
  if (items.length === 0) return 0;
  const client = connectTarget(target);
  await client.connect();
  try {
    let written = 0;
    for (const item of items) {
      const { summary, machines, ...payload } = item;
      await client.query(
        `INSERT INTO control_action_inbox (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,
            created_at,expires_at,payload)
         VALUES ($1,$2,NULL,NULL,$3,$4,$5,$6,NULL,$7::jsonb)
         ON CONFLICT (tenant_id,id) DO UPDATE SET payload = EXCLUDED.payload, kind = EXCLUDED.kind,
            state = EXCLUDED.state, delivery_state = EXCLUDED.delivery_state
          WHERE control_action_inbox.payload IS DISTINCT FROM EXCLUDED.payload`,
        [item.id, item.tenantId, item.kind, item.state, item.deliveryState, item.createdAt,
          JSON.stringify({ ...payload, summary, machines })]);
      written += 1;
    }
    return written;
  } finally {
    await client.end();
  }
}

/**
 * The restore's report of what it did to bot credentials, and what the owner has
 * to do. Pure, so the caller cannot accidentally return an empty report for a
 * restore that changed something.
 *
 * @param {Awaited<ReturnType<typeof retireRestoredBotCredentialsV1>>} outcome
 */
export function restoredBotCredentialReportV1(outcome) {
  if (!outcome || !Array.isArray(outcome.retired) || !Array.isArray(outcome.revokedByBackup))
    throw new Error("restore_bot_notice_input_refused");
  return Object.freeze({
    retiredCredentials: outcome.retired.length,
    revokedByBackup: outcome.revokedByBackup.length,
    tenants: Object.freeze([...outcome.tenants]),
    machineIds: Object.freeze(outcome.retired.map(row => row.workerId)),
  });
}