import { boundedCheckpointCall, CheckpointCallError } from "./bounded-checkpoint-call";
import { etcdCheckpointBindingSchema, parseEtcdCheckpointRecord } from "./etcd-checkpoint-record";
import { parseEtcdCheckpointAdvanceReceipt, prepareEtcdCheckpointAdvance } from "./etcd-checkpoint-advance";
import { parseRollbackCheckpointV1, type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";

type Dispatch<Request> = (request: Request, deadline: number, callback: (error: unknown, response?: unknown) => void) => { cancel(): void };

/** Access to one ALREADY provisioned checkpoint through supplied authenticated
 * transport. No initialization, endpoint discovery, channel creation or retry.
 * Not a certified durable store and deliberately not a full storage-port adapter.
 */
export function createEtcdCheckpointAccess(input: {
  binding: Parameters<typeof parseEtcdCheckpointRecord>[1];
  timeoutMs: number;
  range: Dispatch<{ key: Buffer; limit: string; serializable: false }>;
  txn: Dispatch<ReturnType<typeof prepareEtcdCheckpointAdvance>>;
}) {
  const parsed = etcdCheckpointBindingSchema.parse(input.binding);
  const binding = { ...parsed, key: Buffer.from(parsed.key) };
  const { range, txn, timeoutMs } = input;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("checkpoint_access_invalid");
  function budget(signal: AbortSignal, deadline: number) {
    const remaining = deadline - Date.now();
    if (!signal || signal.aborted || remaining < 1) throw new CheckpointCallError("not_dispatched");
    return remaining;
  }
  async function load(signal: AbortSignal, deadline: number) {
    const response = await boundedCheckpointCall({ signal, timeoutMs: budget(signal, deadline),
      dispatch: (_until, callback) => range({ key: Buffer.from(binding.key), limit: "1", serializable: false }, deadline, callback),
    });
    // Validation before any write; missing/replaced keys never invoke initialization.
    const record = parseEtcdCheckpointRecord(response, binding);
    if (signal.aborted || Date.now() >= deadline) throw new CheckpointCallError("uncertain");
    return { response, record };
  }
  return Object.freeze({
    async read(signal: AbortSignal) {
      return (await load(signal, Date.now() + timeoutMs)).record.checkpoint;
    },
    async advance(expectedDigest: string, next: RollbackCheckpointV1, signal: AbortSignal) {
      const deadline = Date.now() + timeoutMs;
      // Snapshot caller data before awaiting transport.
      const snapshot = parseRollbackCheckpointV1(next);
      const { response, record } = await load(signal, deadline);
      const request = prepareEtcdCheckpointAdvance({ response, binding, expectedDigest, next: snapshot });
      const receipt = await boundedCheckpointCall({ signal, timeoutMs: budget(signal, deadline),
        dispatch: (_until, callback) => txn(request, deadline, callback),
      });
      parseEtcdCheckpointAdvanceReceipt(receipt, binding.clusterId, record.modRevision);
      if (signal.aborted || Date.now() >= deadline) throw new CheckpointCallError("uncertain");
    },
  });
}
