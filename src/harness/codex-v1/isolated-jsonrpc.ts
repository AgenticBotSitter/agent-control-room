import { sha256Digest } from "../../security";
import type {
  CodexBrokerDispatchTicketV1,
  CodexBrokerUsageV1,
} from "./credential-broker";
import { CODEX_ISOLATED_CLIENT_METHODS_V1 } from "./isolated-topology";

export const CODEX_APP_SERVER_MAX_FRAME_BYTES_V1 = 262_144;
export const CODEX_APP_SERVER_MAX_PENDING_REQUESTS_V1 = 16;

type JsonObject = Record<string, unknown>;

export type CodexAppServerInboundV1 =
  | { kind: "response"; id: number; method: string; ok: true; result: unknown }
  | { kind: "response"; id: number; method: string; ok: false; safeErrorCode: "app_server_error" }
  | { kind: "notification"; method: string; params: JsonObject }
  | { kind: "server_request_forbidden"; idDigest: string; methodDigest: string };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertMethod(method: string): void {
  if (!CODEX_ISOLATED_CLIENT_METHODS_V1.includes(method as never)) {
    throw new Error("Codex app-server method forbidden");
  }
}

/** Strict, bounded JSONL correlation for one parent-owned app-server connection. */
export class CodexAppServerJsonlSessionV1 {
  private state: "new" | "initialize_sent" | "initialize_acknowledged" | "initialized" | "closed" = "new";
  private nextId = 1;
  private readonly pending = new Map<number, string>();

  constructor(private readonly maximumFrameBytes = CODEX_APP_SERVER_MAX_FRAME_BYTES_V1) {
    if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1_024 || maximumFrameBytes > 1_048_576) {
      throw new Error("Codex app-server frame limit invalid");
    }
  }

  request(method: string, params: unknown): { id: number; line: string } {
    assertMethod(method);
    if (method === "initialized") throw new Error("Codex app-server notification method used as request");
    if (this.state === "closed") throw new Error("Codex app-server session closed");
    if (method === "initialize") {
      if (this.state !== "new") throw new Error("Codex app-server initialize order invalid");
      this.state = "initialize_sent";
    } else if (this.state !== "initialized") {
      throw new Error("Codex app-server not initialized");
    }
    if (this.pending.size >= CODEX_APP_SERVER_MAX_PENDING_REQUESTS_V1) {
      throw new Error("Codex app-server pending request limit exceeded");
    }
    const id = this.nextId++;
    const line = this.encode({ method, id, params });
    this.pending.set(id, method);
    return { id, line };
  }

  notification(method: string, params: unknown): string {
    assertMethod(method);
    if (method !== "initialized" || this.state !== "initialize_acknowledged" || this.pending.size !== 0) {
      throw new Error("Codex app-server notification order invalid");
    }
    this.state = "initialized";
    return this.encode({ method, params });
  }

  receive(line: string): CodexAppServerInboundV1 {
    if (this.state === "closed") throw new Error("Codex app-server session closed");
    if (typeof line !== "string" || line.length === 0 || byteLength(line) > this.maximumFrameBytes
      || line.includes("\n") || line.includes("\r")) {
      throw new Error("Codex app-server frame invalid");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error("Codex app-server JSON invalid"); }
    if (!isObject(parsed) || Object.hasOwn(parsed, "jsonrpc")) throw new Error("Codex app-server message invalid");
    const hasId = Object.hasOwn(parsed, "id");
    const hasMethod = Object.hasOwn(parsed, "method");
    if (hasId && hasMethod) {
      const id = parsed.id;
      const method = parsed.method;
      if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") {
        throw new Error("Codex app-server server request invalid");
      }
      return { kind: "server_request_forbidden", idDigest: sha256Digest(String(id)), methodDigest: sha256Digest(method) };
    }
    if (hasId) {
      if (!Number.isSafeInteger(parsed.id) || (parsed.id as number) < 1) throw new Error("Codex app-server response id invalid");
      const id = parsed.id as number;
      const method = this.pending.get(id);
      if (!method) throw new Error("Codex app-server response correlation invalid");
      const hasResult = Object.hasOwn(parsed, "result");
      const hasError = Object.hasOwn(parsed, "error");
      if (hasResult === hasError) throw new Error("Codex app-server response shape invalid");
      this.pending.delete(id);
      if (hasError) {
        if (!isObject(parsed.error) || !Number.isSafeInteger(parsed.error.code) || typeof parsed.error.message !== "string") {
          throw new Error("Codex app-server error shape invalid");
        }
        if (method === "initialize") this.state = "closed";
        return { kind: "response", id, method, ok: false, safeErrorCode: "app_server_error" };
      }
      if (method === "initialize") this.state = "initialize_acknowledged";
      return { kind: "response", id, method, ok: true, result: parsed.result };
    }
    if (!hasMethod || typeof parsed.method !== "string" || (Object.hasOwn(parsed, "params") && !isObject(parsed.params))) {
      throw new Error("Codex app-server notification invalid");
    }
    return { kind: "notification", method: parsed.method, params: (parsed.params as JsonObject | undefined) ?? {} };
  }

  disconnect(): { pendingRequestCount: number; pendingMethodDigests: string[] } {
    if (this.state === "closed") return { pendingRequestCount: 0, pendingMethodDigests: [] };
    const pendingMethodDigests = [...this.pending.values()].map((method) => sha256Digest(method)).sort();
    this.pending.clear();
    this.state = "closed";
    return { pendingRequestCount: pendingMethodDigests.length, pendingMethodDigests };
  }

  private encode(message: JsonObject): string {
    const line = `${JSON.stringify(message)}\n`;
    if (byteLength(line) > this.maximumFrameBytes) throw new Error("Codex app-server outbound frame too large");
    return line;
  }
}

export interface CodexIsolatedBrokerSettlementPortV1 {
  settle(input: {
    ticket: CodexBrokerDispatchTicketV1;
    outcome: "completed" | "failed" | "ambiguous";
    usage?: CodexBrokerUsageV1;
    safeResultCode?: string;
  }): void;
}

export type CodexIsolatedObservedEventV1 =
  | { category: "lifecycle"; state: "started" | "completed" | "failed" | "interrupted" | "ambiguous" }
  | { category: "usage"; usage: CodexBrokerUsageV1 }
  | { category: "ignored"; methodDigest: string };

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readUsage(params: JsonObject): CodexBrokerUsageV1 | undefined {
  const tokenUsage = params.tokenUsage;
  if (!isObject(tokenUsage) || !isObject(tokenUsage.last)) return undefined;
  const last = tokenUsage.last;
  if (!nonNegativeInteger(last.inputTokens) || !nonNegativeInteger(last.outputTokens)
    || !nonNegativeInteger(last.cachedInputTokens) || !nonNegativeInteger(last.reasoningOutputTokens)) return undefined;
  return {
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    cachedInputTokens: last.cachedInputTokens,
    reasoningTokens: last.reasoningOutputTokens,
  };
}

/** Settles one claimed provider call from content-free terminal and usage facts. */
export class CodexIsolatedTurnObserverV1 {
  private turnId?: string;
  private usage?: CodexBrokerUsageV1;
  private terminal?: "completed" | "failed" | "interrupted" | "ambiguous";

  constructor(
    private readonly threadId: string,
    private readonly ticket: CodexBrokerDispatchTicketV1,
    private readonly ledger: CodexIsolatedBrokerSettlementPortV1,
  ) {
    if (!validIdentifier(threadId)) throw new Error("Codex isolated observer thread invalid");
  }

  get isTerminal(): boolean { return this.terminal !== undefined; }

  observe(notification: { method: string; params: JsonObject }): CodexIsolatedObservedEventV1 {
    if (this.terminal) throw new Error("Codex isolated observer already terminal");
    if (notification.method === "turn/started") return this.observeStarted(notification.params);
    if (notification.method === "thread/tokenUsage/updated") return this.observeUsage(notification.params);
    if (notification.method === "turn/completed") return this.observeCompleted(notification.params);
    return { category: "ignored", methodDigest: sha256Digest(notification.method) };
  }

  disconnect(safeResultCode = "app_server_disconnected"): CodexIsolatedObservedEventV1 | undefined {
    if (this.terminal) return undefined;
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(safeResultCode)) throw new Error("Codex isolated disconnect code invalid");
    this.ledger.settle({ ticket: this.ticket, outcome: "ambiguous", safeResultCode });
    this.terminal = "ambiguous";
    return { category: "lifecycle", state: "ambiguous" };
  }

  private observeStarted(params: JsonObject): CodexIsolatedObservedEventV1 {
    if (params.threadId !== this.threadId || !isObject(params.turn) || !validIdentifier(params.turn.id)
      || params.turn.status !== "inProgress" || this.turnId) throw new Error("Codex isolated turn start invalid");
    this.turnId = params.turn.id;
    return { category: "lifecycle", state: "started" };
  }

  private observeUsage(params: JsonObject): CodexIsolatedObservedEventV1 {
    if (!this.turnId || params.threadId !== this.threadId || params.turnId !== this.turnId) {
      throw new Error("Codex isolated usage scope invalid");
    }
    const usage = readUsage(params);
    if (!usage) throw new Error("Codex isolated usage invalid");
    if (this.usage && (usage.inputTokens < this.usage.inputTokens || usage.outputTokens < this.usage.outputTokens
      || usage.cachedInputTokens < this.usage.cachedInputTokens || usage.reasoningTokens < this.usage.reasoningTokens)) {
      throw new Error("Codex isolated usage regressed");
    }
    this.usage = usage;
    return { category: "usage", usage: { ...usage } };
  }

  private observeCompleted(params: JsonObject): CodexIsolatedObservedEventV1 {
    if (!this.turnId || params.threadId !== this.threadId || !isObject(params.turn)
      || params.turn.id !== this.turnId || !["completed", "failed", "interrupted"].includes(String(params.turn.status))) {
      throw new Error("Codex isolated turn completion invalid");
    }
    const status = params.turn.status as "completed" | "failed" | "interrupted";
    if (status === "completed") {
      if (!this.usage) throw new Error("Codex isolated completed turn missing usage");
      this.ledger.settle({ ticket: this.ticket, outcome: "completed", usage: this.usage });
    } else {
      this.ledger.settle({ ticket: this.ticket, outcome: "failed", safeResultCode: status === "failed" ? "codex_turn_failed" : "codex_turn_interrupted" });
    }
    this.terminal = status;
    return { category: "lifecycle", state: status };
  }
}
