import { parseRollbackCheckpointV1, rollbackCheckpointDigestV1, type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";
import { etcdPositiveRevision, etcdUint64, parseEtcdCheckpointRecord } from "./etcd-checkpoint-record";
import { z } from "zod";

const receiptSchema = z.object({
  header: z.object({ cluster_id: etcdUint64, revision: etcdPositiveRevision }),
  succeeded: z.literal(true),
  responses: z.array(z.object({
    response: z.literal("response_put"),
    response_put: z.object({
      // Nested headers can be omitted by the server; outer header is authoritative.
      header: z.unknown().optional(), prev_kv: z.null().optional(),
    }),
    response_range: z.null().optional(), response_delete_range: z.null().optional(),
    response_txn: z.null().optional(),
  })).length(1),
});

/** Ack validation for the exact single-Put transaction prepared below. Does not
 * authenticate the sender or establish the outcome of a missing/invalid response. */
export function parseEtcdCheckpointAdvanceReceipt(response: unknown, expectedClusterId: string, priorModRevision: string): string {
  try {
    const clusterId = etcdUint64.parse(expectedClusterId);
    const previous = etcdPositiveRevision.parse(priorModRevision);
    const receipt = receiptSchema.parse(response);
    if (clusterId === "0" || receipt.header.cluster_id !== clusterId
      || BigInt(receipt.header.revision) <= BigInt(previous)) throw new Error();
    return receipt.header.revision;
  } catch { throw new Error("checkpoint_advance_uncertain"); }
}

/** Prepares a conditional write, not a dispatch. Numeric enum values are the
 * upstream protobuf field values (the retained schema uses CamelCase names).
 * The failure branch has no writes. Endpoint authentication remains mandatory.
 */
export function prepareEtcdCheckpointAdvance(input: {
  response: unknown;
  binding: Parameters<typeof parseEtcdCheckpointRecord>[1];
  expectedDigest: string;
  next: RollbackCheckpointV1;
}) {
  try {
    const current = parseEtcdCheckpointRecord(input.response, input.binding);
    const next = parseRollbackCheckpointV1(input.next);
    if (rollbackCheckpointDigestV1(current.checkpoint) !== input.expectedDigest
      || next.scope !== current.checkpoint.scope
      || next.revision !== current.checkpoint.revision + 1) throw new Error();
    const value = Buffer.from(JSON.stringify(next));
    if (value.length > 4096) throw new Error();
    const comparison = (target: number) => ({ key: Buffer.from(input.binding.key), result: 0, target });
    return {
      compare: [
        { ...comparison(1), create_revision: current.createRevision },
        { ...comparison(2), mod_revision: current.modRevision },
        { ...comparison(3), value: current.value },
        { ...comparison(4), lease: "0" },
      ] as const,
      success: [{ request_put: { key: Buffer.from(input.binding.key), value, lease: "0" } }],
      failure: [],
    };
  } catch { throw new Error("checkpoint_advance_unavailable"); }
}
