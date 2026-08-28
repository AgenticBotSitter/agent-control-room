import type { HarnessRunEventV1 } from "../v1";
import { harnessRunEventSchemaV1 } from "../v1";
import { sha256Digest } from "../../security";
import { decodeCodexJsonLineV1 } from "./decoder";
import type { CodexExecPlanV1 } from "./command";

export interface CodexProcessTransportV1 {
  run(plan: CodexExecPlanV1, handlers: { stdoutLine(line: string): void }, signal: AbortSignal): Promise<{ exitCode: number }>;
}

export interface CodexProcessResultV1 {
  nativeThreadId?: string;
  finalTextDigest?: string;
  events: HarnessRunEventV1[];
  exitCode: number;
}

export class CodexExecProcessV1 {
  private active?: AbortController;

  constructor(private readonly transport: CodexProcessTransportV1) {}

  cancel(): boolean {
    if (!this.active || this.active.signal.aborted) return false;
    this.active.abort("operator_cancelled");
    return true;
  }

  async run(plan: CodexExecPlanV1, context: { tenantId: string; nodeId: string; runId: string; sequence: number; now(): string }): Promise<CodexProcessResultV1> {
    if (this.active) throw new Error("Codex process wrapper already has an active run");
    const controller = new AbortController();
    this.active = controller;
    const timer = setTimeout(() => controller.abort("deadline_exceeded"), plan.timeoutMs);
    const events: HarnessRunEventV1[] = [];
    let nativeThreadId: string | undefined;
    let finalTextDigest: string | undefined;
    try {
      let result: { exitCode: number };
      try { result = await this.transport.run(plan, { stdoutLine: (line) => {
        const decoded = decodeCodexJsonLineV1(line, { tenantId: context.tenantId, nodeId: context.nodeId, runId: context.runId, sequence: context.sequence + events.length, occurredAt: context.now(), verificationCommands: plan.verificationCommands });
        if (decoded.nativeThreadId) {
          if (nativeThreadId && nativeThreadId !== decoded.nativeThreadId) throw new Error("Codex native thread changed during run");
          nativeThreadId = decoded.nativeThreadId;
        }
        if (decoded.finalTextDigest) finalTextDigest = decoded.finalTextDigest;
        events.push(...decoded.events);
      } }, controller.signal); } catch (error) {
        if (!controller.signal.aborted) throw error;
        result = { exitCode: 130 };
      }
      if (controller.signal.aborted) {
        if (terminalEvents(events).length) throw new Error("Codex process crossed its deadline or cancellation boundary after terminal output");
        events.push(terminalAbortEvent(context, events.length, controller.signal.reason === "deadline_exceeded"));
      }
      const terminals = terminalEvents(events);
      if (terminals.length !== 1 || events.at(-1) !== terminals[0]) throw new Error("Codex process requires exactly one final structured terminal event");
      const terminalState = terminals[0].payload.category === "lifecycle" ? terminals[0].payload.state : undefined;
      if ((result.exitCode === 0) !== (terminalState === "succeeded")) throw new Error("Codex process exit status contradicts structured terminal state");
      return { ...(nativeThreadId ? { nativeThreadId } : {}), ...(finalTextDigest ? { finalTextDigest } : {}), events, exitCode: result.exitCode };
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
  }
}

function terminalEvents(events: HarnessRunEventV1[]): HarnessRunEventV1[] {
  return events.filter((event) => event.payload.category === "lifecycle" && ["succeeded", "failed", "cancelled"].includes(event.payload.state));
}

function terminalAbortEvent(context: { tenantId: string; nodeId: string; runId: string; sequence: number; now(): string }, offset: number, timedOut: boolean): HarnessRunEventV1 {
  const state = timedOut ? "failed" : "cancelled";
  const reasonCode = timedOut ? "codex_deadline_exceeded" : "codex_cancelled";
  return harnessRunEventSchemaV1.parse({
    schemaVersion: "control-room-harness-event/v1", tenantId: context.tenantId, runId: context.runId,
    sequence: context.sequence + offset, occurredAt: context.now(), source: "adapter",
    sourceEventKeyDigest: sha256Digest({ nodeId: context.nodeId, runId: context.runId, state, reasonCode, sequence: context.sequence + offset }),
    payload: { category: "lifecycle", state, reasonCode },
  }) as HarnessRunEventV1;
}
