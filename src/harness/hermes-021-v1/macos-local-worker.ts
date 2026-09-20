import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import {
  controllerWorkerDeliverySchemaV1,
  controllerWorkerRouteSchemaV1,
} from "../v1/controller-worker-delivery";

/** Source revision observed from the locally installed Hermes Agent 0.21.3. */
export const HERMES_021_MACOS_LOCAL_WORKER_CONTRACT_V1 = "control-room.hermes-021-macos-local-worker/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const boundedText = z.string().max(65_536).refine(value => Buffer.byteLength(value, "utf8") <= 65_536);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const resultLineSchema = z.object({
  type: z.literal("result"),
  session_id: z.string(),
  exit_code: z.number().int(),
  text: z.string(),
  tokens: z.object({ input: count, output: count, total: count, cache_read: count, cache_write: count }).strict(),
  duration_ms: count,
  error: z.string().optional(),
  timestamp: count,
}).strict();

export const HERMES_021_MACOS_LOCAL_ADAPTER_V1 = "connector:hermes-021-macos-local-v1" as const;

export const hermes021MacosLocalBindingSchemaV1 = z.object({
  localServiceId: id,
  workerId: id,
  expectedVersion: z.literal("0.21.3"),
  sourceRevision: z.string().regex(/^[a-f0-9]{8,64}$/),
}).strict();
export type Hermes021MacosLocalBindingV1 = z.infer<typeof hermes021MacosLocalBindingSchemaV1>;

export const hermes021MacosTaskSchemaV1 = z.object({
  tenantId: id, projectId: id, jobId: id, attemptId: id, runId: id, nodeId: id,
  prompt: z.string().min(1).max(32_768).refine(value => Buffer.byteLength(value, "utf8") <= 32_768),
  instructions: z.string().max(8192).refine(value => Buffer.byteLength(value, "utf8") <= 8192),
  deadline: count,
}).strict();
export type Hermes021MacosTaskV1 = z.infer<typeof hermes021MacosTaskSchemaV1>;

/**
 * Mac-owned implementation seam. It owns the Hermes executable, login,
 * model/provider selection, work directory, subprocess lifetime, and the
 * `--format stream-json` invocation. It returns only parsed JSON lines; none
 * of those private inputs enter a Control Room task record.
 */
export interface Hermes021MacosLocalPrivatePortV1 {
  run(input: Readonly<{
    localServiceId: string;
    task: Hermes021MacosTaskV1;
    signal?: AbortSignal;
  }>): Promise<readonly unknown[]>;
}

export type Hermes021MacosTaskOutcomeV1 =
  | Readonly<{ kind: "completed"; text: string; contentHash: string; sizeBytes: number;
    inputTokens: number; outputTokens: number; totalTokens: number; durationMs: number; sessionId: string }>
  | Readonly<{ kind: "failed"; reason: "hermes_local_exit_nonzero" | "hermes_local_result_missing" }>
  | Readonly<{ kind: "uncertain"; reason: "hermes_local_transport_unavailable" | "hermes_local_result_invalid" }>;

function unavailable(): never { throw new Error("hermes_local_worker_unavailable"); }

/**
 * Converts the shared controller packet into the exact local Hermes task
 * shape. The route is intentionally checked here, not trusted from a browser
 * or task payload. A remote route must use the same packet through an
 * enrolled remote bridge; it cannot accidentally invoke a Mac-local Hermes.
 */
export function prepareHermes021MacosTaskV1(deliveryValue: unknown, routeValue: unknown,
  bindingValue: unknown): Hermes021MacosTaskV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  if (route.kind !== "local" || route.workerId !== binding.workerId || delivery.worker.workerId !== binding.workerId
    || delivery.worker.adapterId !== HERMES_021_MACOS_LOCAL_ADAPTER_V1
    || delivery.worker.adapterRevision !== binding.sourceRevision) unavailable();
  return Object.freeze(hermes021MacosTaskSchemaV1.parse({ ...delivery.identity,
    prompt: delivery.input.prompt, instructions: delivery.input.instructions,
    deadline: Date.parse(delivery.expiresAt) }));
}

/**
 * Selects exactly one terminal Hermes 0.21 stream-json result line. Status
 * and tool-progress lines are intentionally not trusted as completion. A
 * transport failure is uncertainty: the connector must not rerun the task,
 * because Hermes may already have received it.
 */
export function classifyHermes021MacosResultV1(lines: readonly unknown[]): Hermes021MacosTaskOutcomeV1 {
  const results = lines.map(value => resultLineSchema.safeParse(value)).filter(value => value.success).map(value => value.data);
  if (results.length === 0) return Object.freeze({ kind: "failed", reason: "hermes_local_result_missing" });
  if (results.length !== 1) return Object.freeze({ kind: "uncertain", reason: "hermes_local_result_invalid" });
  const result = results[0];
  if (result.exit_code !== 0) return Object.freeze({ kind: "failed", reason: "hermes_local_exit_nonzero" });
  const parsed = boundedText.safeParse(result.text);
  if (!parsed.success || result.tokens.total < result.tokens.input + result.tokens.output) {
    return Object.freeze({ kind: "uncertain", reason: "hermes_local_result_invalid" });
  }
  const text = parsed.data, bytes = Buffer.byteLength(text, "utf8");
  return Object.freeze({ kind: "completed", text, contentHash: sha256Digest(text), sizeBytes: bytes,
    inputTokens: result.tokens.input, outputTokens: result.tokens.output, totalTokens: result.tokens.total,
    durationMs: result.duration_ms, sessionId: result.session_id });
}

/** Performs one caller-authorized local invocation. It does not start a process itself. */
export async function runHermes021MacosLocalTaskV1(bindingValue: unknown, taskValue: unknown,
  privatePort: Hermes021MacosLocalPrivatePortV1, signal?: AbortSignal): Promise<Hermes021MacosTaskOutcomeV1> {
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  const task = hermes021MacosTaskSchemaV1.parse(taskValue);
  if (!privatePort || typeof privatePort.run !== "function" || signal?.aborted) unavailable();
  try {
    const lines = await privatePort.run(Object.freeze({ localServiceId: binding.localServiceId, task, signal }));
    if (!Array.isArray(lines)) return Object.freeze({ kind: "uncertain", reason: "hermes_local_result_invalid" });
    return classifyHermes021MacosResultV1(lines);
  } catch {
    return Object.freeze({ kind: "uncertain", reason: "hermes_local_transport_unavailable" });
  }
}
