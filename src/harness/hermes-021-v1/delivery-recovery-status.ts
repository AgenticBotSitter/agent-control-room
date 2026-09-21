import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import { sha256Digest } from "../../security/canonical-digest";
import { readControllerWorkerDeliveryReceiptV1 } from "../v1/controller-worker-delivery-receipt-store";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "./macos-local-worker";
import { createHermes021MacosTerminalStageV1 } from "./terminal-result-staging";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const scopeSchema = z.object({ tenantId: id, projectId: id, jobId: id, attemptId: id }).strict();
const unavailable = (): never => { throw new Error("hermes_021_macos_delivery_recovery_status_unavailable"); };

export const HERMES_021_MACOS_DELIVERY_RECOVERY_STATUS_V1 =
  "control-room.hermes-021-macos-delivery-recovery-status/v1" as const;

export type Hermes021MacosDeliveryRecoveryStatusV1 = Readonly<{
  schema: typeof HERMES_021_MACOS_DELIVERY_RECOVERY_STATUS_V1;
  state: "no_authenticated_delivery" | "delivery_receipt_unresolved" | "terminal_result_staged";
  /** A stage proves only a saved terminal record. It never proves review,
   * publication, retry safety, or that Hermes is still running. */
  terminal?: Readonly<{ terminalResultDigest: string; contentDigest: string; sizeBytes: number;
    inputTokens: number; outputTokens: number; totalTokens: number; durationMs: number }>;
  startsWork: false;
  grantsExecutionAuthority: false;
  permitsRetry: false;
  permitsResume: false;
}>;

/**
 * Read-only local recovery inspection. It reads the installation's already
 * authenticated delivery receipt and, when present, its exact protected
 * terminal stage. It does not contact Hermes, create a run, publish a result,
 * create a review, alter a queue, or disclose terminal text or private runner
 * configuration.
 */
export async function inspectHermes021MacosDeliveryRecoveryStatusV1(config: Readonly<{
  db: DatabaseClient;
  integrityKey: Uint8Array;
  storage: ArtifactStoragePortV1 & ArtifactReadPortV1;
}>, scopeValue: unknown, signal?: AbortSignal): Promise<Hermes021MacosDeliveryRecoveryStatusV1> {
  if (!config || !config.db || typeof config.db.transaction !== "function" || !(config.integrityKey instanceof Uint8Array)
    || config.integrityKey.length !== 32 || !config.storage || typeof config.storage.read !== "function" || signal?.aborted) unavailable();
  const scope = scopeSchema.parse(scopeValue);
  const retained = await config.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, config.integrityKey, scope));
  const base = { schema: HERMES_021_MACOS_DELIVERY_RECOVERY_STATUS_V1, startsWork: false as const,
    grantsExecutionAuthority: false as const, permitsRetry: false as const, permitsResume: false as const };
  if (!retained) return Object.freeze({ ...base, state: "no_authenticated_delivery" as const });
  if (retained.delivery.worker.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1 || retained.receipt.route.kind !== "local"
    || retained.receipt.route.workerId !== retained.delivery.worker.workerId) unavailable();
  let terminal;
  try {
    terminal = await createHermes021MacosTerminalStageV1({ storage: config.storage, delivery: retained.delivery,
      receivedAt: retained.receipt.receivedAt }).recover(signal);
  } catch { unavailable(); }
  if (!terminal) return Object.freeze({ ...base, state: "delivery_receipt_unresolved" as const });
  const contentDigest = sha256Digest(terminal.text);
  return Object.freeze({ ...base, state: "terminal_result_staged" as const, terminal: Object.freeze({
    terminalResultDigest: sha256Digest(terminal), contentDigest, sizeBytes: Buffer.byteLength(terminal.text, "utf8"),
    inputTokens: terminal.tokens.input, outputTokens: terminal.tokens.output, totalTokens: terminal.tokens.total,
    durationMs: terminal.duration_ms,
  }) });
}
