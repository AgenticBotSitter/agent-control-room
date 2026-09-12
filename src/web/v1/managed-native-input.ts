import { z } from "zod";
import { signedNodeFrameSchema } from "../../node-protocol/v1";
import { nativeEvidenceRegistrationSchema, type NativeEvidenceReceiver } from "./native-evidence-receiver";
import type { ManagedNativeSessions } from "./managed-native-sessions";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";

export const nativeInputConfigurationSchema = z.union([
  z.object({ mode: z.enum(["initial", "recover"]), task: nativeEvidenceRegistrationSchema }).strict(),
  z.object({ mode: z.literal("initial"), assignment: z.literal("queue") }).strict(),
]);
export type NativeInputConfiguration = z.infer<typeof nativeInputConfigurationSchema>;
type TaskBinding = z.infer<typeof nativeEvidenceRegistrationSchema>;
type Handle = Awaited<ReturnType<ManagedNativeSessions["attach"]>>;
const unavailable = () => new Error("native_input_unavailable");
const commandSchema = z.object({
  actor: z.object({ provider: z.string().min(1).max(2048), subject: z.string().min(1).max(256),
    tokenDigest: digestSchema, issuedAt: z.string().max(64), expiresAt: z.string().max(64),
    verificationExpiresAt: z.string().max(64) }).strict(),
  task: z.object({ projectId: localId, jobId: localId, inputDigest: digestSchema, packetDigest: digestSchema }).strict(),
}).strict();
function captureCommand(actor: Parameters<Handle["stage"]>[0], task: Parameters<Handle["stage"]>[1]) {
  const captured = commandSchema.parse({ actor, task });
  return { ...captured, size: Buffer.byteLength(JSON.stringify(captured)) };
}

/** One bounded FIFO for supplied transport callbacks and explicit owner commands.
 * Parses only routing hints; all authority remains in the existing authenticated handles. */
export class ManagedNativeInput {
  readonly nodeId: string;
  readonly grantsExecutionAuthority = false;
  private readonly config: NativeInputConfiguration;
  private task?: TaskBinding;
  private readonly handle: Handle;
  private readonly register: NativeEvidenceReceiver["register"];
  private readonly available: () => void;
  private state: "new" | "reconciling" | "ready" | "prepared" | "sent" | "reporting" | "codex_receipted" = "new";
  private queueKind?: "hermes" | "codex";
  private closed = false;
  private count = 0;
  private bytes = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly pending = new Set<AbortController>();
  constructor(handle: Handle, config: NativeInputConfiguration, register: NativeEvidenceReceiver["register"], available: () => void) {
    this.nodeId = handle.nodeId; this.config = nativeInputConfigurationSchema.parse(config);
    this.task = "task" in this.config ? Object.freeze(this.config.task) : undefined;
    this.handle = Object.freeze({ ...handle }); this.register = register; this.available = available;
  }
  private current() { if (this.closed) throw unavailable(); this.available(); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    this.closing = this.handle.close(); return this.closing;
  }
  private async reject(): Promise<never> {
    try { await this.close(); } catch { /* The underlying owner retains uncertain cleanup. */ }
    throw new Error("native_input_uncertain");
  }
  private enqueue<T>(size: number, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      this.current();
      if (!(signal instanceof AbortSignal) || signal.aborted || this.count >= 16 || this.bytes + size > 1_048_576) throw unavailable();
    } catch { return this.reject(); }
    this.count++; this.bytes += size;
    const controller = new AbortController(); this.pending.add(controller);
    let rejectStopped!: (reason: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const stop = () => { controller.abort(); rejectStopped(unavailable()); };
    const cancelled = () => { stop(); void this.close().catch(() => {}); };
    signal.addEventListener("abort", cancelled, { once: true });
    controller.signal.addEventListener("abort", () => rejectStopped(unavailable()), { once: true });
    // Wall time includes time waiting behind another message; dequeuing grants no fresh budget.
    const timer = setTimeout(cancelled, 10_000);
    const queued = this.tail.then(async () => {
      this.current(); if (controller.signal.aborted) throw unavailable();
      const result = await work(controller.signal); this.current(); return result;
    }).catch(async () => { await this.close(); throw unavailable(); });
    this.tail = queued.catch(() => {});
    return Promise.race([queued, stopped]).catch(() => this.reject()).finally(() => {
      clearTimeout(timer); signal.removeEventListener("abort", cancelled);
      this.pending.delete(controller); this.count--; this.bytes -= size;
    });
  }
  receive(raw: string | Uint8Array, bytes: Uint8Array | undefined, signal: AbortSignal) {
    let copy: string | Uint8Array, content: Uint8Array | undefined, frame: z.infer<typeof signedNodeFrameSchema>;
    try {
      this.current();
      if (typeof raw !== "string" && !(raw instanceof Uint8Array)) throw unavailable();
      const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
      if (size > 131_072 || bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.byteLength > 65_536)) throw unavailable();
      copy = typeof raw === "string" ? raw : Uint8Array.from(raw);
      content = bytes === undefined ? undefined : Uint8Array.from(bytes);
      frame = signedNodeFrameSchema.parse(JSON.parse(typeof copy === "string" ? copy : Buffer.from(copy).toString("utf8")));
      if (frame.type === "harness.native.snapshot" && size > 16_384
        || content !== undefined && frame.type !== "harness.native.snapshot") throw unavailable();
    } catch { return this.reject(); }
    return this.enqueue((typeof copy === "string" ? Buffer.byteLength(copy) : copy.byteLength) + (content?.byteLength ?? 0), signal, async current => {
      if (frame.type === "connection.hello" && this.state === "new") {
        await this.handle.hello(copy, current); this.state = "reconciling";
        return { kind: "hello" as const };
      }
      if (frame.type === "protocol.ack" || frame.type === "node.reconciliation.report") {
        await this.handle.reconcile(copy, current);
        if (frame.type === "node.reconciliation.report") {
          if (this.state !== "reconciling") throw unavailable();
          if (this.config.mode === "recover") {
            if (!this.task) throw unavailable();
            await this.handle.recover(this.task, current); this.state = "reporting";
          } else this.state = "ready";
        }
        return { kind: "reconciliation" as const };
      }
      if (frame.type === "harness.native.dispatch.receipt" && this.config.mode === "initial" && this.state === "sent"
        && this.queueKind !== "codex") {
        const receipt = await this.handle.receipt(copy, current), task = this.task;
        if (!task || receipt.nodeReportedDisposition !== "recorded" || receipt.projectId !== task.projectId
          || receipt.jobId !== task.jobId || receipt.attemptId !== task.attemptId) throw unavailable();
        const registration = await this.register(task, current); this.current(); this.state = "reporting";
        this.handle.completeQueuedDelivery("hermes", task);
        return { kind: "receipt" as const, receipt, registration };
      }
      if (frame.type === "harness.codex.dispatch.receipt" && this.config.mode === "initial" && this.state === "sent"
        && this.queueKind === "codex") {
        const receipt = await this.handle.codexReceipt(copy, current), task = this.task;
        if (!task || receipt.nodeReportedDisposition !== "recorded" || receipt.projectId !== task.projectId
          || receipt.jobId !== task.jobId || receipt.attemptId !== task.attemptId) throw unavailable();
        this.state = "codex_receipted";
        this.handle.completeQueuedDelivery("codex", task);
        return { kind: "codex_receipt" as const, receipt };
      }
      if (frame.type === "harness.native.snapshot" && this.state === "reporting") {
        return { kind: "progress" as const, result: await this.handle.progress(copy, content, current) };
      }
      throw unavailable();
    });
  }
  /** Internal canonical-queue composition. Uses the same FIFO and task binding as
   * owner commands so a queued dispatch cannot bypass receipt lifecycle ownership.
   * The supplied work still performs canonical stage/transmit revalidation. */
  deliverQueued<T>(input: TaskBinding, kind: "hermes" | "codex", signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>) {
    let task: TaskBinding;
    try { task = nativeEvidenceRegistrationSchema.parse(input); if (!["hermes", "codex"].includes(kind)) throw unavailable(); }
    catch { return this.reject(); }
    return this.enqueue(Buffer.byteLength(JSON.stringify(task)), signal, async current => {
      if (this.config.mode !== "initial" || this.state !== "ready") throw unavailable();
      const expected = this.task;
      if (expected && (task.projectId !== expected.projectId || task.jobId !== expected.jobId
        || task.attemptId !== expected.attemptId || task.inputDigest !== expected.inputDigest)) throw unavailable();
      // Only the manager's canonically revalidated queue path may bind an unbound
      // generation. Binding is immutable for its whole lifetime, including failure.
      if (!expected) {
        if (!("assignment" in this.config) || this.config.assignment !== "queue") throw unavailable();
        this.task = Object.freeze(task);
      }
      if (this.queueKind && this.queueKind !== kind) throw unavailable();
      this.queueKind = kind;
      const result = await work(current); this.current();
      if (current.aborted) throw unavailable();
      this.state = "sent"; return result;
    });
  }
  stage(identity: Parameters<Handle["stage"]>[0], input: Parameters<Handle["stage"]>[1], signal: AbortSignal) {
    let captured: ReturnType<typeof captureCommand>;
    try { captured = captureCommand(identity, input); } catch { return this.reject(); }
    const { actor, task, size } = captured;
    return this.enqueue(size, signal, async current => {
      if ("assignment" in this.config || this.config.mode !== "initial" || this.state !== "ready" || !this.task
        || task.projectId !== this.task.projectId || task.jobId !== this.task.jobId || task.inputDigest !== this.task.inputDigest) throw unavailable();
      const result = await this.handle.stage(actor, task, current);
      if (!("attemptId" in result) || result.attemptId !== this.task.attemptId) throw unavailable();
      this.state = "prepared"; return result;
    });
  }
  transmit(identity: Parameters<Handle["transmit"]>[0], input: Parameters<Handle["transmit"]>[1], signal: AbortSignal) {
    let captured: ReturnType<typeof captureCommand>;
    try { captured = captureCommand(identity, input); } catch { return this.reject(); }
    const { actor, task, size } = captured;
    return this.enqueue(size, signal, async current => {
      if ("assignment" in this.config || this.config.mode !== "initial" || this.state !== "prepared" || !this.task
        || task.projectId !== this.task.projectId || task.jobId !== this.task.jobId || task.inputDigest !== this.task.inputDigest) throw unavailable();
      const result = await this.handle.transmit(actor, task, current); this.state = "sent"; return result;
    });
  }
}
