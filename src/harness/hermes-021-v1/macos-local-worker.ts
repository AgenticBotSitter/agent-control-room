import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import {
  controllerWorkerDeliverySchemaV1,
  controllerWorkerDeliveryReceiptSchemaV1,
  controllerWorkerRouteSchemaV1,
  type ControllerWorkerDeliveryV1,
  type ControllerWorkerDeliveryReceiptV1,
} from "../v1/controller-worker-delivery";
import { assertSynchronousFence } from "../../security/synchronous-fence";

/** Source revision observed from the locally installed Hermes Agent 0.21.3. */
export const HERMES_021_MACOS_LOCAL_WORKER_CONTRACT_V1 = "control-room.hermes-021-macos-local-worker/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const boundedText = z.string().max(65_536).refine(value => Buffer.byteLength(value, "utf8") <= 65_536);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const hermes021MacosTerminalResultSchemaV1 = z.object({
  type: z.literal("result"),
  session_id: z.string(),
  exit_code: z.number().int(),
  text: z.string(),
  tokens: z.object({ input: count, output: count, total: count, cache_read: count, cache_write: count }).strict(),
  duration_ms: count,
  error: z.string().optional(),
  timestamp: count,
}).strict();
export type Hermes021MacosTerminalResultV1 = z.infer<typeof hermes021MacosTerminalResultSchemaV1>;

export const HERMES_021_MACOS_LOCAL_ADAPTER_V1 = "connector:hermes-021-macos-local-v1" as const;
export const HERMES_021_MACOS_LOCAL_CAPABILITY_V1 = "harness.hermes.021.macos.local.v1" as const;
export const HERMES_021_MACOS_LOCAL_JOB_TYPE_V1 = "harness.hermes.021.macos.task" as const;
export const HERMES_021_MACOS_LOCAL_START_OPERATION_V1 = "harness.hermes.021.macos.start" as const;

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
    /** When supplied, call this on the exact terminal result before returning. */
    terminalStage?: { capture(terminal: unknown, signal?: AbortSignal): Promise<void> };
    signal?: AbortSignal;
  }>): Promise<readonly unknown[]>;
}

/**
 * Installation-owned admission boundary for normal local Hermes work. It is
 * deliberately injected: the Control Room repository never stores the Mac's
 * workspace path, Hermes login, selected model, or a rule that could widen
 * the local worker's authority. A host must synchronously approve the exact
 * immutable delivery before the private runner can be called.
 */
export interface Hermes021MacosTaskPolicyPortV1 {
  assertAdmitted(input: Readonly<{
    delivery: ControllerWorkerDeliveryV1;
    task: Hermes021MacosTaskV1;
    binding: Hermes021MacosLocalBindingV1;
  }>): void;
}

export type Hermes021MacosTaskOutcomeV1 =
  | Readonly<{ kind: "completed"; text: string; contentHash: string; sizeBytes: number;
    inputTokens: number; outputTokens: number; totalTokens: number; durationMs: number; sessionId: string;
    /** Canonical terminal record retained only after the private runner returned it. */
    terminalResult: Hermes021MacosTerminalResultV1; terminalResultDigest: string }>
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
 * The local half of the shared delivery protocol.  It makes a normal,
 * non-executing receipt only after the Mac-owned policy has accepted the
 * exact packet.  It starts neither Hermes nor a background service.  The
 * separate runner rechecks this policy immediately before it invokes Hermes.
 */
export function acceptHermes021MacosLocalDeliveryV1(deliveryValue: unknown, routeValue: unknown,
  bindingValue: unknown, policy: Hermes021MacosTaskPolicyPortV1, receivedAtValue: unknown): ControllerWorkerDeliveryReceiptV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  const receivedAt = z.string().datetime().refine(value => new Date(value).toISOString() === value).parse(receivedAtValue);
  const task = prepareHermes021MacosTaskV1(delivery, route, binding);
  if (!policy || typeof policy.assertAdmitted !== "function"
    || Date.parse(receivedAt) < Date.parse(delivery.issuedAt) || Date.parse(receivedAt) > Date.parse(delivery.expiresAt)) unavailable();
  assertSynchronousFence(() => policy.assertAdmitted(Object.freeze({ delivery, task, binding })), unavailable);
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest, workerId: binding.workerId,
    route, receivedAt, disposition: "accepted" as const, startsWork: false as const,
    grantsExecutionAuthority: false as const };
  return Object.freeze(controllerWorkerDeliveryReceiptSchemaV1.parse({ ...material, receiptDigest: sha256Digest(material) }));
}

/**
 * Selects exactly one terminal Hermes 0.21 stream-json result line. Status
 * and tool-progress lines are intentionally not trusted as completion. A
 * transport failure is uncertainty: the connector must not rerun the task,
 * because Hermes may already have received it.
 */
export function classifyHermes021MacosResultV1(lines: readonly unknown[]): Hermes021MacosTaskOutcomeV1 {
  const results = lines.map(value => hermes021MacosTerminalResultSchemaV1.safeParse(value)).filter(value => value.success).map(value => value.data);
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
    durationMs: result.duration_ms, sessionId: result.session_id, terminalResult: Object.freeze(result),
    terminalResultDigest: sha256Digest(result) });
}

/** Performs one caller-authorized local invocation. It does not start a process itself. */
export async function runHermes021MacosLocalTaskV1(bindingValue: unknown, taskValue: unknown,
  privatePort: Hermes021MacosLocalPrivatePortV1, signal?: AbortSignal,
  terminalStage?: { capture(terminal: unknown, signal?: AbortSignal): Promise<void> }): Promise<Hermes021MacosTaskOutcomeV1> {
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  const task = hermes021MacosTaskSchemaV1.parse(taskValue);
  if (!privatePort || typeof privatePort.run !== "function" || signal?.aborted) unavailable();
  try {
    const lines = await privatePort.run(Object.freeze({ localServiceId: binding.localServiceId, task, terminalStage, signal }));
    if (!Array.isArray(lines)) return Object.freeze({ kind: "uncertain", reason: "hermes_local_result_invalid" });
    const outcome = classifyHermes021MacosResultV1(lines);
    // This fallback closes ordinary in-process paths. The permanent private
    // runner must use terminalStage while it reads the line, before returning.
    if (outcome.kind === "completed" && terminalStage) await terminalStage.capture(outcome.terminalResult, signal);
    return outcome;
  } catch {
    return Object.freeze({ kind: "uncertain", reason: "hermes_local_transport_unavailable" });
  }
}

/**
 * The normal local-worker launch seam. It prepares the task only from the
 * shared controller packet, then requires the Mac-owned policy to approve
 * that exact packet before touching Hermes. The policy is synchronous so an
 * incomplete asynchronous check cannot be mistaken for authority. A policy
 * refusal starts nothing; a lost Hermes reply remains uncertain and is never
 * retried here.
 *
 * This function has no default policy and no default private runner. Wiring a
 * real host remains a separate installation step after owner qualification.
 */
export async function runAdmittedHermes021MacosLocalTaskV1(deliveryValue: unknown, routeValue: unknown,
  bindingValue: unknown, policy: Hermes021MacosTaskPolicyPortV1,
  privatePort: Hermes021MacosLocalPrivatePortV1, signal?: AbortSignal,
  terminalStage?: { capture(terminal: unknown, signal?: AbortSignal): Promise<void> }): Promise<Hermes021MacosTaskOutcomeV1> {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const binding = hermes021MacosLocalBindingSchemaV1.parse(bindingValue);
  const task = prepareHermes021MacosTaskV1(delivery, routeValue, binding);
  if (!policy || typeof policy.assertAdmitted !== "function" || signal?.aborted) unavailable();
  assertSynchronousFence(() => policy.assertAdmitted(Object.freeze({ delivery, task, binding })), unavailable);
  return runHermes021MacosLocalTaskV1(binding, task, privatePort, signal, terminalStage);
}
