/**
 * Production PostgreSQL adapter for the harness-neutral reservation port.
 *
 * It targets `control_durable_result_write_reservations` from migration 0077
 * exclusively. The native-only table from 0071 is a sibling, not a fallback:
 * its CHECK pins the native schema literal, and neither that constraint nor
 * its role boundary is widened here to make a neutral record fit.
 *
 * The port stays opaque, exactly as `neutral-reservation-port.ts` specifies.
 * HMAC tags, state-machine transitions and mirror verification remain in the
 * publisher; this adapter holds no key and interprets no reservation body. It
 * writes only the five columns the evidence role is granted UPDATE on
 * (`state`, `contract_digest`, `reservation`, `auth_tag`, `updated_at`), so a
 * stored `created_at` and every identity column stay immutable — which the
 * database's own `guard_durable_result_write_reservation_update()` trigger
 * enforces independently.
 *
 * Concurrency, per the port contract:
 * - `findForUpdate` takes a row lock (`FOR UPDATE`) so a caller transaction
 *   serializes against a concurrent writer.
 * - `insertFresh` reports `conflict` for a collision on either unique key —
 *   the primary key `(tenant_id, run_id)` or `UNIQUE (tenant_id, artifact_id)`.
 *   `ON CONFLICT DO NOTHING` is deliberate: a raised unique violation would
 *   abort the caller's transaction, turning an expected replay into an
 *   unrecoverable failure.
 * - `compareAndSwap` applies only while the stored `state` and
 *   `contract_digest` still equal `prior`, and reports `false` without
 *   changing anything otherwise.
 *
 * `QueryResult` exposes only `rows`, so both mutations use `RETURNING` to
 * observe whether exactly one row was affected rather than reading a row
 * count.
 */

import type { DatabaseSession } from "../../persistence/database";
import type {
  NeutralReservationPort,
  NeutralReservationPriorV1,
  NeutralReservationRowV1,
} from "./neutral-reservation-port";

/** The neutral sibling table. Never the native-only table from migration 0071. */
export const DURABLE_RESULT_RESERVATION_TABLE_V1 = "control_durable_result_write_reservations" as const;

const COLUMNS = `tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,
  identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at`;

type StoredRow = Omit<NeutralReservationRowV1, "created_at" | "updated_at"> & {
  created_at: string | Date;
  updated_at: string | Date;
};

function failed(reason: string): never {
  throw new Error(reason);
}

/** PostgreSQL returns `timestamptz` as a Date; the port interface declares strings. */
function instant(value: string | Date): string {
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) failed("durable_reservation_row_invalid");
    return value.toISOString();
  }
  if (typeof value !== "string" || value.length === 0) failed("durable_reservation_row_invalid");
  return value;
}

/**
 * Normalizes a stored row to the port's declared shape. The reservation body
 * stays opaque — `jsonb` already arrives as a parsed value and is passed
 * through untouched for the publisher to parse and verify.
 */
function storedRow(row: StoredRow | undefined): NeutralReservationRowV1 | null {
  if (row === undefined) return null;
  if (!row || typeof row !== "object") failed("durable_reservation_row_invalid");
  for (const column of ["tenant_id", "project_id", "job_id", "attempt_id", "run_id", "artifact_id",
    "identity_digest", "state", "contract_digest", "auth_tag"] as const) {
    if (typeof row[column] !== "string" || row[column].length === 0) failed("durable_reservation_row_invalid");
  }
  // The table's mirror CHECK already requires a jsonb object, so this guard is
  // defense in depth for any other session implementation: an array or scalar
  // body never reaches the publisher as a reservation.
  if (typeof row.reservation !== "object" || row.reservation === null
    || Array.isArray(row.reservation)) failed("durable_reservation_row_invalid");
  return {
    tenant_id: row.tenant_id, project_id: row.project_id, job_id: row.job_id,
    attempt_id: row.attempt_id, run_id: row.run_id, artifact_id: row.artifact_id,
    identity_digest: row.identity_digest, state: row.state, contract_digest: row.contract_digest,
    reservation: row.reservation, auth_tag: row.auth_tag,
    created_at: instant(row.created_at), updated_at: instant(row.updated_at),
  };
}

function requireSession(session: DatabaseSession): DatabaseSession {
  if (!session || typeof session.query !== "function") failed("durable_reservation_session_invalid");
  return session;
}

/**
 * Reservation persistence against the neutral table. Construct one per
 * process; it holds no connection of its own and runs every statement on the
 * caller's session, so a caller transaction keeps its own boundary.
 */
export class DurableReservationPostgresPort implements NeutralReservationPort {
  async findForUpdate(session: DatabaseSession, tenantId: string,
    runId: string): Promise<NeutralReservationRowV1 | null> {
    const rows = (await requireSession(session).query<StoredRow>(
      `SELECT ${COLUMNS} FROM ${DURABLE_RESULT_RESERVATION_TABLE_V1}
       WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`, [tenantId, runId])).rows;
    if (rows.length > 1) failed("durable_reservation_row_ambiguous");
    return storedRow(rows[0]);
  }

  async insertFresh(session: DatabaseSession,
    row: NeutralReservationRowV1): Promise<"inserted" | "conflict"> {
    // No conflict target: a collision on the primary key or on the artifact
    // uniqueness is equally a conflict, and neither may abort the caller's
    // transaction.
    const rows = (await requireSession(session).query<{ run_id: string }>(
      `INSERT INTO ${DURABLE_RESULT_RESERVATION_TABLE_V1} (${COLUMNS})
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       ON CONFLICT DO NOTHING RETURNING run_id`,
      [row.tenant_id, row.project_id, row.job_id, row.attempt_id, row.run_id, row.artifact_id,
        row.identity_digest, row.state, row.contract_digest, JSON.stringify(row.reservation),
        row.auth_tag, row.created_at, row.updated_at])).rows;
    if (rows.length > 1) failed("durable_reservation_insert_ambiguous");
    return rows.length === 1 ? "inserted" : "conflict";
  }

  async compareAndSwap(session: DatabaseSession, prior: NeutralReservationPriorV1,
    next: NeutralReservationRowV1): Promise<boolean> {
    // `created_at` and every identity column are deliberately absent from SET:
    // the stored creation instant is preserved and the row's identity is
    // immutable, matching both the port contract and the table's trigger.
    const rows = (await requireSession(session).query<{ run_id: string }>(
      `UPDATE ${DURABLE_RESULT_RESERVATION_TABLE_V1}
       SET state=$1,contract_digest=$2,reservation=$3::jsonb,auth_tag=$4,updated_at=$5
       WHERE tenant_id=$6 AND run_id=$7 AND state=$8 AND contract_digest=$9 RETURNING run_id`,
      [next.state, next.contract_digest, JSON.stringify(next.reservation), next.auth_tag, next.updated_at,
        prior.tenantId, prior.runId, prior.state, prior.contractDigest])).rows;
    if (rows.length > 1) failed("durable_reservation_update_ambiguous");
    return rows.length === 1;
  }
}

export function createDurableReservationPostgresPortV1(): DurableReservationPostgresPort {
  return new DurableReservationPostgresPort();
}
