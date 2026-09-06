import { z } from "zod";
import { parseRollbackCheckpointV1 } from "../../security/rollback-checkpoint";

const uint64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) <= BigInt("18446744073709551615"));
const positiveRevision = uint64.refine(value => BigInt(value) > BigInt(0) && BigInt(value) <= BigInt("9223372036854775807"));
const bytes = z.custom<Buffer>(value => Buffer.isBuffer(value));
const bindingSchema = z.object({
  clusterId: uint64.refine(value => value !== "0"),
  createRevision: positiveRevision,
  key: bytes.refine(value => value.length > 0 && value.length <= 512),
  scope: z.string().min(3).max(240),
});
const responseSchema = z.object({
  header: z.object({ cluster_id: uint64, revision: positiveRevision }),
  count: z.literal("1"), more: z.literal(false),
  kvs: z.array(z.object({
    key: bytes, value: bytes.refine(value => value.length > 0 && value.length <= 4096),
    create_revision: positiveRevision, mod_revision: positiveRevision,
    version: positiveRevision, lease: z.literal("0"),
  })).length(1),
});

/** Validates an already provisioned exact-key read. Missing keys are failures, not
 * permission to initialize. Binding must come from independent trusted setup;
 * reading it from this response would defeat replacement detection.
 * Does not certify durability, monotonic history, or authenticate a transport.
 */
export function parseEtcdCheckpointRecord(response: unknown, trustedBinding: {
  clusterId: string; createRevision: string; key: Buffer; scope: string;
}) {
  try {
    const binding = bindingSchema.parse(trustedBinding);
    const parsed = responseSchema.parse(response);
    const record = parsed.kvs[0];
    if (parsed.header.cluster_id !== binding.clusterId || record.create_revision !== binding.createRevision
      || !record.key.equals(binding.key) || BigInt(record.mod_revision) < BigInt(record.create_revision)
      || BigInt(record.mod_revision) > BigInt(parsed.header.revision)) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(record.value);
    const checkpoint = parseRollbackCheckpointV1(JSON.parse(text));
    if (checkpoint.scope !== binding.scope) throw new Error();
    return {
      checkpoint,
      // Preserve exact wire bytes for value CAS; never reconstruct prior bytes.
      value: Buffer.from(record.value),
      modRevision: record.mod_revision,
      createRevision: record.create_revision,
    };
  } catch { throw new Error("checkpoint_record_unavailable"); }
}
