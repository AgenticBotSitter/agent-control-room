import { z } from "zod";
import { assertNoSecretMaterial } from "../../security";
import { harnessRunEventSchemaV1, type HarnessRunEventV1 } from "../v1";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export interface CodexRunResultV1 {
  runId: string;
  terminalState: "succeeded" | "failed" | "cancelled";
  finalTextDigest?: string;
  changedFileCount: number;
  verification: { started: number; completed: number; failed: number };
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number };
}

export function projectCodexRunResultV1(input: { tenantId: string; runId: string; events: HarnessRunEventV1[]; finalTextDigest?: string }): CodexRunResultV1 {
  const events = input.events.map((event) => harnessRunEventSchemaV1.parse(event) as HarnessRunEventV1);
  let expected = events[0]?.sequence ?? 1;
  let terminalState: CodexRunResultV1["terminalState"] | undefined;
  let changedFileCount = 0;
  const verification = { started: 0, completed: 0, failed: 0 };
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  for (const event of events) {
    if (event.tenantId !== input.tenantId || event.runId !== input.runId) throw new Error("Codex result event scope mismatch");
    if (event.sequence !== expected++) throw new Error("Codex result event sequence gap");
    if (terminalState) throw new Error("Codex result contains events after terminal state");
    if (event.payload.category === "lifecycle" && ["succeeded", "failed", "cancelled"].includes(event.payload.state)) terminalState = event.payload.state as CodexRunResultV1["terminalState"];
    if (event.payload.category === "activity" && event.payload.activity === "file" && event.payload.phase === "completed") changedFileCount = add(changedFileCount, event.payload.count ?? 1);
    if (event.payload.category === "activity" && event.payload.activity === "test" && event.payload.phase !== "progress") {
      verification[event.payload.phase] = add(verification[event.payload.phase], 1);
    }
    if (event.payload.category === "usage") {
      usage.inputTokens = add(usage.inputTokens, event.payload.inputTokens);
      usage.outputTokens = add(usage.outputTokens, event.payload.outputTokens);
      usage.cachedInputTokens = add(usage.cachedInputTokens, event.payload.cachedInputTokens);
      usage.reasoningTokens = add(usage.reasoningTokens, event.payload.reasoningTokens);
    }
  }
  if (!terminalState) throw new Error("Codex result missing terminal state");
  const finalTextDigest = input.finalTextDigest ? digest.parse(input.finalTextDigest) : undefined;
  const result: CodexRunResultV1 = { runId: input.runId, terminalState, ...(finalTextDigest ? { finalTextDigest } : {}), changedFileCount, verification, usage };
  assertNoSecretMaterial(result, "Codex run result");
  return result;
}

function add(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Codex result counter overflow");
  return value;
}
