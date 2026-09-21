import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { controllerWorkerDeliveryReceiptSchemaV1, controllerWorkerDeliverySchemaV1,
  type ControllerWorkerDeliveryReceiptV1, type ControllerWorkerDeliveryV1 } from "./controller-worker-delivery";

export const CONTROLLER_WORKER_DELIVERY_RECEIPT_RECORD_V1 =
  "control-room.controller-worker-delivery-receipt-record/v1" as const;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const recordSchema = z.object({
  schema: z.literal(CONTROLLER_WORKER_DELIVERY_RECEIPT_RECORD_V1),
  delivery: controllerWorkerDeliverySchemaV1,
  receipt: controllerWorkerDeliveryReceiptSchemaV1,
  recordedAt: instant,
}).strict();

type Record = z.infer<typeof recordSchema>;
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; record: unknown; auth_tag: string };
const fail = (): never => { throw new Error("controller_worker_delivery_receipt_unavailable"); };
const tag = (key: Uint8Array, record: Record) => hmacSha256Tag(key,
  { purpose: "controller-worker-delivery-receipt-record/v1", record });

function sameDelivery(receipt: ControllerWorkerDeliveryReceiptV1, delivery: ControllerWorkerDeliveryV1) {
  return receipt.deliveryId === delivery.deliveryId && receipt.deliveryDigest === delivery.deliveryDigest
    && receipt.workerId === delivery.worker.workerId && receipt.route.workerId === delivery.worker.workerId;
}

function verify(key: Uint8Array, row: Row): Record {
  const record = recordSchema.parse(row.record);
  const expected = Buffer.from(tag(key, record)), actual = Buffer.from(row.auth_tag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
    || !sameDelivery(record.receipt, record.delivery)
    || row.tenant_id !== record.delivery.identity.tenantId
    || row.project_id !== record.delivery.identity.projectId
    || row.job_id !== record.delivery.identity.jobId
    || row.attempt_id !== record.delivery.identity.attemptId
    || Date.parse(record.receipt.receivedAt) < Date.parse(record.delivery.issuedAt)
    || Date.parse(record.receipt.receivedAt) > Date.parse(record.delivery.expiresAt)
    || Date.parse(record.recordedAt) < Date.parse(record.receipt.receivedAt)) fail();
  return record;
}

/**
 * Stores one route-neutral receipt in the installation's existing PostgreSQL
 * authority. An exact replay returns the original evidence; a changed packet,
 * route, receipt, or timing is refused. This does not start a worker, retry a
 * task, alter a lease, or grant any new execution authority.
 */
export async function persistControllerWorkerDeliveryReceiptV1(tx: DatabaseSession, integrityKey: Uint8Array,
  deliveryValue: unknown, receiptValue: unknown, recordedAtValue: unknown) {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) fail();
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const receipt = controllerWorkerDeliveryReceiptSchemaV1.parse(receiptValue);
  const recordedAt = instant.parse(recordedAtValue);
  if (!sameDelivery(receipt, delivery) || Date.parse(receipt.receivedAt) < Date.parse(delivery.issuedAt)
    || Date.parse(receipt.receivedAt) > Date.parse(delivery.expiresAt) || Date.parse(recordedAt) < Date.parse(receipt.receivedAt)) fail();
  const record = recordSchema.parse({ schema: CONTROLLER_WORKER_DELIVERY_RECEIPT_RECORD_V1, delivery, receipt, recordedAt });
  assertNoSecretMaterial(record, "controller worker delivery receipt");
  const scope = delivery.identity;
  const current = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag
    FROM control_worker_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3 FOR UPDATE`,
  [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (current) {
    const prior = verify(integrityKey, current);
    if (sha256Digest(prior) !== sha256Digest(record)) fail();
    return Object.freeze({ receipt: prior.receipt, replayed: true as const, startsWork: false as const,
      grantsExecutionAuthority: false as const });
  }
  const inserted = await tx.query<{ attempt_id: string }>(`INSERT INTO control_worker_delivery_receipts
    (tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5::jsonb,$6)
    ON CONFLICT (tenant_id,job_id,attempt_id) DO NOTHING RETURNING attempt_id`,
  [scope.tenantId, scope.projectId, scope.jobId, scope.attemptId, JSON.stringify(record), tag(integrityKey, record)]);
  if (inserted.rows.length === 1) return Object.freeze({ receipt, replayed: false as const, startsWork: false as const,
    grantsExecutionAuthority: false as const });
  // A competing controller recorded this acknowledgement while this request
  // was in flight. Re-read it under the same row lock: an exact packet is a
  // harmless replay, while a changed packet or route fails closed.
  const raced = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag
    FROM control_worker_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3 FOR UPDATE`,
  [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!raced) fail();
  const prior = verify(integrityKey, raced);
  if (sha256Digest(prior) !== sha256Digest(record)) fail();
  return Object.freeze({ receipt: prior.receipt, replayed: true as const, startsWork: false as const,
    grantsExecutionAuthority: false as const });
}

/** Reads one authenticated historical receipt. It has no transport or worker side effect. */
export async function readControllerWorkerDeliveryReceiptV1(tx: DatabaseSession, integrityKey: Uint8Array,
  scope: { tenantId: string; projectId: string; jobId: string; attemptId: string }) {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) fail();
  const row = (await tx.query<Row>(`SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag
    FROM control_worker_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3`,
  [scope.tenantId, scope.jobId, scope.attemptId])).rows[0];
  if (!row) return null;
  const record = verify(integrityKey, row);
  if (record.delivery.identity.tenantId !== scope.tenantId || record.delivery.identity.projectId !== scope.projectId
    || record.delivery.identity.jobId !== scope.jobId || record.delivery.identity.attemptId !== scope.attemptId) fail();
  return Object.freeze({ delivery: record.delivery, receipt: record.receipt, recordedAt: record.recordedAt,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}
