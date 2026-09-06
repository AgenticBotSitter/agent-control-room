import { parseRollbackCheckpointV1, rollbackCheckpointDigestV1, type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";
import { parseEtcdCheckpointRecord } from "./etcd-checkpoint-record";

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
