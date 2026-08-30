import type {
  CodexBrokerCallRequestV1,
  CodexBrokerClaimDispositionV1,
  CodexBrokerDispatchTicketV1,
  CodexBrokerUsageV1,
} from "./credential-broker";
import { sha256Digest } from "../../security";
import type { CodexMacIsolatedLauncherPlanV1 } from "./isolated-launcher";
import { CODEX_ISOLATED_CLIENT_METHODS_V1 } from "./isolated-topology";

export type CodexIsolatedEnvironmentStatusV1 = "ready" | "pending" | "disconnected" | "unknown";

export interface CodexIsolatedBrokerLedgerPortV1 {
  claim(request: CodexBrokerCallRequestV1, now: string): {
    disposition: CodexBrokerClaimDispositionV1;
    ticket?: CodexBrokerDispatchTicketV1;
    usage?: CodexBrokerUsageV1;
    safeResultCode?: string;
  };
  authorizeClaimedDispatch(ticket: CodexBrokerDispatchTicketV1): { remainingPermitMs: number };
}

export interface CodexAppServerRequestV1<TMethod extends string, TParams> {
  method: TMethod;
  params: TParams;
}

export interface CodexIsolatedTurnDispatchV1 {
  disposition: CodexBrokerClaimDispositionV1;
  ticket?: CodexBrokerDispatchTicketV1;
  usage?: CodexBrokerUsageV1;
  safeResultCode?: string;
  request?: CodexAppServerRequestV1<"turn/start", {
    threadId: string;
    input: Array<{ type: "text"; text: string; text_elements: [] }>;
    environments: [CodexMacIsolatedLauncherPlanV1["threadEnvironment"]];
    cwd: string;
    runtimeWorkspaceRoots: [string];
    approvalPolicy: "never";
    sandboxPolicy: { type: "readOnly"; networkAccess: false };
    model: string;
  }>;
}

function validIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value);
}

/**
 * Effect-free request projector for the experimental app-server/exec-server
 * qualification seam. Process ownership and JSON-RPC transport stay outside
 * this class so tests can prove ordering without starting either native service.
 */
export class CodexMacIsolatedControllerV1 {
  constructor(
    private readonly launcher: CodexMacIsolatedLauncherPlanV1,
    private readonly ledger: CodexIsolatedBrokerLedgerPortV1,
  ) {}

  assertClientMethod(method: string): void {
    if (!CODEX_ISOLATED_CLIENT_METHODS_V1.includes(method as never)) {
      throw new Error("Codex isolated client method forbidden");
    }
  }

  planInitialize(): CodexAppServerRequestV1<"initialize", {
    clientInfo: { name: "control-room"; title: null; version: "1.0.0" };
    capabilities: { experimentalApi: true; requestAttestation: false };
  }> {
    return { method: "initialize", params: {
      clientInfo: { name: "control-room", title: null, version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } };
  }

  planInitialized(): { method: "initialized"; params: Record<string, never> } {
    return { method: "initialized", params: {} };
  }

  planEnvironmentRegistration(): CodexMacIsolatedLauncherPlanV1["environmentAdd"] {
    return structuredClone(this.launcher.environmentAdd);
  }

  planEnvironmentStatus(): CodexMacIsolatedLauncherPlanV1["environmentStatus"] {
    return structuredClone(this.launcher.environmentStatus);
  }

  planThreadBoundary(request: CodexBrokerCallRequestV1):
    | CodexAppServerRequestV1<"thread/start", {
      model: string; cwd: string; runtimeWorkspaceRoots: [string]; approvalPolicy: "never"; sandbox: "read-only";
      ephemeral: true; environments: [CodexMacIsolatedLauncherPlanV1["threadEnvironment"]]; dynamicTools: [];
      selectedCapabilityRoots: []; experimentalRawEvents: false;
    }>
    | CodexAppServerRequestV1<"thread/resume", {
      threadId: string; model: string; cwd: string; runtimeWorkspaceRoots: [string]; approvalPolicy: "never";
      sandbox: "read-only"; excludeTurns: true;
    }> {
    if (request.operation === "start") {
      if (request.nativeThreadId) throw new Error("Codex isolated start thread invalid");
      return { method: "thread/start", params: {
        model: request.model,
        cwd: this.launcher.threadEnvironment.cwd,
        runtimeWorkspaceRoots: [this.launcher.threadEnvironment.cwd],
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        environments: [structuredClone(this.launcher.threadEnvironment)],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        experimentalRawEvents: false,
      } };
    }
    if (!request.nativeThreadId || !validIdentifier(request.nativeThreadId)) throw new Error("Codex isolated resume thread invalid");
    return { method: "thread/resume", params: {
      threadId: request.nativeThreadId,
      model: request.model,
      cwd: this.launcher.threadEnvironment.cwd,
      runtimeWorkspaceRoots: [this.launcher.threadEnvironment.cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: true,
    } };
  }

  claimAndPlanTurn(input: {
    request: CodexBrokerCallRequestV1;
    nativeThreadId: string;
    environmentStatus: CodexIsolatedEnvironmentStatusV1;
    now: string;
  }): CodexIsolatedTurnDispatchV1 {
    if (input.environmentStatus !== "ready") throw new Error("Codex isolated remote environment not ready");
    if (!validIdentifier(input.nativeThreadId)) throw new Error("Codex isolated native thread invalid");
    if (input.request.operation === "resume" && input.request.nativeThreadId !== input.nativeThreadId) {
      throw new Error("Codex isolated resume thread mismatch");
    }
    const claimed = this.ledger.claim(input.request, input.now);
    if (claimed.disposition !== "dispatch_once") return { ...claimed };
    if (!claimed.ticket) throw new Error("Codex isolated dispatch ticket missing");
    this.ledger.authorizeClaimedDispatch(claimed.ticket);
    return {
      disposition: claimed.disposition,
      ticket: claimed.ticket,
      request: { method: "turn/start", params: {
        threadId: input.nativeThreadId,
        input: [{ type: "text", text: input.request.input, text_elements: [] }],
        environments: [structuredClone(this.launcher.threadEnvironment)],
        cwd: this.launcher.threadEnvironment.cwd,
        runtimeWorkspaceRoots: [this.launcher.threadEnvironment.cwd],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: input.request.model,
      } },
    };
  }

  claim(request: CodexBrokerCallRequestV1, now?: string): ReturnType<CodexIsolatedBrokerLedgerPortV1["claim"]> {
    return this.ledger.claim(request, now ?? "");
  }

  planClaimedTurn(input: {
    request: CodexBrokerCallRequestV1;
    ticket: CodexBrokerDispatchTicketV1;
    nativeThreadId: string;
    environmentStatus: CodexIsolatedEnvironmentStatusV1;
  }): NonNullable<CodexIsolatedTurnDispatchV1["request"]> {
    if (input.environmentStatus !== "ready") throw new Error("Codex isolated remote environment not ready");
    if (!validIdentifier(input.nativeThreadId)) throw new Error("Codex isolated native thread invalid");
    if (input.request.operation === "resume" && input.request.nativeThreadId !== input.nativeThreadId) throw new Error("Codex isolated resume thread mismatch");
    if (input.ticket.requestDigest !== sha256Digest(input.request) || input.ticket.requestId !== input.request.requestId
      || input.ticket.permitDigest !== input.request.permitDigest || input.ticket.runId !== input.request.runId
      || input.ticket.model !== input.request.model || input.ticket.operation !== input.request.operation) {
      throw new Error("Codex isolated dispatch ticket mismatch");
    }
    return { method: "turn/start", params: {
      threadId: input.nativeThreadId,
      input: [{ type: "text", text: input.request.input, text_elements: [] }],
      environments: [structuredClone(this.launcher.threadEnvironment)], cwd: this.launcher.threadEnvironment.cwd,
      runtimeWorkspaceRoots: [this.launcher.threadEnvironment.cwd], approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false }, model: input.request.model,
    } };
  }

  planInterrupt(nativeThreadId: string, turnId: string): CodexAppServerRequestV1<"turn/interrupt", { threadId: string; turnId: string }> {
    if (!validIdentifier(nativeThreadId) || !validIdentifier(turnId)) throw new Error("Codex isolated interrupt identity invalid");
    return { method: "turn/interrupt", params: { threadId: nativeThreadId, turnId } };
  }
}
