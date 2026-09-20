import { z } from "zod";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import { resultBytesHash } from "../../artifacts/v1/native-results";
import { sha256Digest } from "../../security/canonical-digest";
import type { ControllerWorkerDeliveryV1 } from "../v1/controller-worker-delivery";
import { hermes021MacosTerminalResultSchemaV1, type Hermes021MacosTerminalResultV1 } from "./macos-local-worker";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const unavailable = (): never => { throw new Error("hermes_021_macos_terminal_stage_unavailable"); };

const stagedSchema = z.object({
  schema: z.literal("control-room.hermes-021-macos-terminal-stage/v1"),
  deliveryDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  identity: z.object({ tenantId: z.string(), projectId: z.string(), jobId: z.string(), attemptId: z.string(), runId: z.string(), nodeId: z.string() }).strict(),
  receivedAt: instant,
  terminalResult: hermes021MacosTerminalResultSchemaV1,
}).strict();

export type Hermes021MacosTerminalStagePortV1 = Readonly<{
  /** The private runner calls this as soon as it reads the one terminal line, before returning. */
  capture(terminal: unknown, signal?: AbortSignal): Promise<void>;
  /** A restart may read one exact saved terminal line. It never starts Hermes. */
  recover(signal?: AbortSignal): Promise<Hermes021MacosTerminalResultV1 | undefined>;
}>;

/**
 * Stores one exact completed Hermes terminal line under an identifier derived
 * only from the already-accepted delivery. This is result-byte custody, not a
 * queue, approval, retry permission, or second task database.
 */
export function createHermes021MacosTerminalStageV1(input: Readonly<{
  storage: ArtifactStoragePortV1 & ArtifactReadPortV1;
  delivery: ControllerWorkerDeliveryV1;
  receivedAt: string;
}>): Hermes021MacosTerminalStagePortV1 {
  if (!input?.storage || typeof input.storage.put !== "function" || typeof input.storage.read !== "function") unavailable();
  const receivedAt = instant.parse(input.receivedAt), delivery = input.delivery;
  const artifactId = `artifact:result:${sha256Digest({ purpose: "hermes-021-macos-terminal-stage/v1", deliveryDigest: delivery.deliveryDigest }).slice(7)}`;
  const expected = { deliveryDigest: delivery.deliveryDigest, identity: delivery.identity, receivedAt };
  const decode = (bytes: Uint8Array): Hermes021MacosTerminalResultV1 => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return unavailable(); }
    const staged = stagedSchema.parse(value);
    if (staged.deliveryDigest !== expected.deliveryDigest || staged.receivedAt !== expected.receivedAt
      || sha256Digest(staged.identity) !== sha256Digest(expected.identity)) unavailable();
    return Object.freeze(staged.terminalResult);
  };
  return Object.freeze({
    async capture(value: unknown, signal?: AbortSignal) {
      const terminal = hermes021MacosTerminalResultSchemaV1.parse(value);
      const bytes = new TextEncoder().encode(JSON.stringify({ schema: "control-room.hermes-021-macos-terminal-stage/v1",
        ...expected, terminalResult: terminal }));
      if (bytes.byteLength > 65_536) unavailable();
      const stored = await input.storage.put({ artifactId, bytes, signal });
      if (stored.artifactId !== artifactId || stored.contentHash !== resultBytesHash(bytes) || stored.sizeBytes !== bytes.byteLength) unavailable();
      const readback = await input.storage.read(artifactId, signal);
      if (!(readback instanceof Uint8Array) || resultBytesHash(readback) !== resultBytesHash(bytes)) unavailable();
      decode(readback as Uint8Array);
    },
    async recover(signal?: AbortSignal) {
      const bytes = await input.storage.read(artifactId, signal);
      return bytes ? decode(bytes) : undefined;
    },
  });
}
