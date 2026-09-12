import { createEtcdCheckpointAccess } from "./etcd-checkpoint-access";
import { etcdCheckpointBindingSchema } from "./etcd-checkpoint-record";
import { parseRollbackCheckpointV1, type AwaitableRollbackCheckpointStoreV1 } from "../../security/rollback-checkpoint";

/** Adapts the existing exact-key etcd access to the completion store's awaited
 * checkpoint port. The caller supplies authenticated transport and independently
 * provisioned pins. No channel creation, provisioning, retries or SQL self-anchor.
 * Source composition is not evidence of a durable, independently restored service.
 */
export function createEtcdCompletionCheckpointStoreV1(
  input: Parameters<typeof createEtcdCheckpointAccess>[0],
): AwaitableRollbackCheckpointStoreV1 {
  const binding = etcdCheckpointBindingSchema.parse(input.binding);
  if (!binding.scope.startsWith("completion-gate:") || binding.scope.length <= "completion-gate:".length)
    throw new Error("review_checkpoint_scope_invalid");
  const scope = binding.scope;
  const access = createEtcdCheckpointAccess({ ...input, binding });
  const checkScope = (requested: string) => {
    if (requested !== scope) throw new Error("review_checkpoint_scope_invalid");
  };
  // Access applies its own bounded deadline even when a caller has no outer
  // cancellation signal. A supplied transaction signal is passed unchanged.
  const signalFor = (signal?: AbortSignal) => signal ?? new AbortController().signal;
  return Object.freeze({
    async read(requested, signal) {
      checkScope(requested);
      return access.read(signalFor(signal));
    },
    async initialize() {
      throw new Error("review_checkpoint_provisioning_required");
    },
    async advance(expectedDigest, checkpoint, signal) {
      const next = parseRollbackCheckpointV1(checkpoint);
      checkScope(next.scope);
      if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("review_checkpoint_digest_invalid");
      await access.advance(expectedDigest, next, signalFor(signal));
    },
  } satisfies AwaitableRollbackCheckpointStoreV1);
}
