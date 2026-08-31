import { sha256Digest } from "../../security";
import { CodexBrokerPolicyErrorV1, type CodexBrokerCallRequestV1, type CodexBrokerClaimDispositionV1 } from "./credential-broker";
import { CodexMacIsolatedControllerV1, type CodexIsolatedBrokerLedgerPortV1 } from "./isolated-controller";
import {
  CodexAppServerJsonlSessionV1,
  CodexIsolatedTurnObserverV1,
  type CodexAppServerInboundV1,
  type CodexIsolatedBrokerSettlementPortV1,
  type CodexIsolatedObservedEventV1,
} from "./isolated-jsonrpc";
import type { CodexMacIsolatedLauncherPlanV1 } from "./isolated-launcher";

interface CodexNodeLocalThreadBindingPortV1 {
  bindNodeLocalThread(ticket: import("./credential-broker").CodexBrokerDispatchTicketV1, nativeThreadId: string): void;
}

export type CodexAppServerRuntimeSafeCodeV1 =
  | "app_server_disconnected"
  | "app_server_cancelled"
  | "app_server_deadline_exceeded"
  | "app_server_protocol_invalid"
  | "app_server_request_failed"
  | "app_server_server_request_forbidden"
  | "remote_environment_not_ready"
  | "thread_response_invalid"
  | "broker_permit_expired";

export const CODEX_APP_SERVER_MAX_INBOUND_PER_REQUEST_V1 = 4_096;
export const CODEX_ISOLATED_MAX_OBSERVED_EVENTS_V1 = 1_024;
export const CODEX_ISOLATED_MAX_RUNTIME_MS_V1 = 300_000;

export class CodexAppServerRuntimeErrorV1 extends Error {
  constructor(public readonly safeCode: CodexAppServerRuntimeSafeCodeV1) {
    super(safeCode);
    this.name = "CodexAppServerRuntimeErrorV1";
  }
}

export interface CodexAppServerLineTransportV1 {
  write(line: string): Promise<void>;
  readLine(): Promise<string | null>;
  close(): Promise<void>;
}

type PlannedRequest = { method: string; params: unknown };

/** Sequential request driver. Raw protocol values never escape error paths. */
class CodexAppServerRpcDriverV1 {
  private readonly session = new CodexAppServerJsonlSessionV1();

  constructor(private readonly transport: CodexAppServerLineTransportV1) {}

  async handshake(initialize: PlannedRequest, initialized: PlannedRequest): Promise<void> {
    await this.request(initialize);
    try { await this.transport.write(this.session.notification(initialized.method, initialized.params)); }
    catch { this.session.disconnect(); throw new CodexAppServerRuntimeErrorV1("app_server_disconnected"); }
  }

  async request(request: PlannedRequest, onNotification?: (input: Extract<CodexAppServerInboundV1, { kind: "notification" }>) => void): Promise<unknown> {
    let outbound: { id: number; line: string };
    try { outbound = this.session.request(request.method, request.params); }
    catch { throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid"); }
    try { await this.transport.write(outbound.line); }
    catch { this.session.disconnect(); throw new CodexAppServerRuntimeErrorV1("app_server_disconnected"); }
    for (let inboundCount = 0; inboundCount < CODEX_APP_SERVER_MAX_INBOUND_PER_REQUEST_V1; inboundCount += 1) {
      const inbound = await this.read();
      if (inbound.kind === "server_request_forbidden") throw new CodexAppServerRuntimeErrorV1("app_server_server_request_forbidden");
      if (inbound.kind === "notification") { onNotification?.(inbound); continue; }
      if (inbound.id !== outbound.id) throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
      if (!inbound.ok) throw new CodexAppServerRuntimeErrorV1("app_server_request_failed");
      return inbound.result;
    }
    throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
  }

  async notification(onNotification: (input: Extract<CodexAppServerInboundV1, { kind: "notification" }>) => void): Promise<void> {
    const inbound = await this.read();
    if (inbound.kind === "server_request_forbidden") throw new CodexAppServerRuntimeErrorV1("app_server_server_request_forbidden");
    if (inbound.kind !== "notification") throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
    onNotification(inbound);
  }

  async close(): Promise<void> {
    this.session.disconnect();
    try { await this.transport.close(); } catch { /* safe best effort */ }
  }

  private async read(): Promise<CodexAppServerInboundV1> {
    let line: string | null;
    try { line = await this.transport.readLine(); }
    catch { this.session.disconnect(); throw new CodexAppServerRuntimeErrorV1("app_server_disconnected"); }
    if (line === null) { this.session.disconnect(); throw new CodexAppServerRuntimeErrorV1("app_server_disconnected"); }
    try { return this.session.receive(line); }
    catch { this.session.disconnect(); throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid"); }
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value);
}

function threadIdFrom(result: unknown): string | undefined {
  const thread = asObject(asObject(result)?.thread);
  return validIdentifier(thread?.id) ? thread.id : undefined;
}

function turnIdFrom(result: unknown, threadId: string): string | undefined {
  const object = asObject(result);
  const turn = asObject(object?.turn);
  if (object?.threadId !== undefined && object.threadId !== threadId) return undefined;
  return validIdentifier(turn?.id) && turn.status === "inProgress" ? turn.id : undefined;
}

function environmentStatusFrom(result: unknown): "ready" | "pending" | "disconnected" | "unknown" | undefined {
  const status = asObject(result)?.status;
  return ["ready", "pending", "disconnected", "unknown"].includes(String(status))
    ? status as "ready" | "pending" | "disconnected" | "unknown" : undefined;
}

export interface CodexIsolatedQualificationResultV1 {
  disposition: "completed" | "failed" | "interrupted" | Exclude<CodexBrokerClaimDispositionV1, "dispatch_once">;
  nativeThreadIdDigest?: string;
  events: CodexIsolatedObservedEventV1[];
}

/**
 * Effect-free orchestration over an injected line transport. The production
 * process adapter is deliberately separate so tests cannot start app-server.
 */
export class CodexIsolatedQualificationRuntimeV1 {
  private readonly controller: CodexMacIsolatedControllerV1;
  private readonly driver: CodexAppServerRpcDriverV1;

  constructor(
    private readonly launcher: CodexMacIsolatedLauncherPlanV1,
    private readonly ledger: CodexIsolatedBrokerLedgerPortV1 & CodexIsolatedBrokerSettlementPortV1 & CodexNodeLocalThreadBindingPortV1,
    transport: CodexAppServerLineTransportV1,
  ) {
    this.controller = new CodexMacIsolatedControllerV1(launcher, ledger);
    this.driver = new CodexAppServerRpcDriverV1(transport);
  }

  async execute(request: CodexBrokerCallRequestV1, _untrustedNow: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CodexIsolatedQualificationResultV1> {
    void _untrustedNow;
    const timeoutMs = options.timeoutMs ?? CODEX_ISOLATED_MAX_RUNTIME_MS_V1;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CODEX_ISOLATED_MAX_RUNTIME_MS_V1) {
      throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
    }
    let observer: CodexIsolatedTurnObserverV1 | undefined;
    let claimedTicket: import("./credential-broker").CodexBrokerDispatchTicketV1 | undefined;
    const events: CodexIsolatedObservedEventV1[] = [];
    let abortCode: "app_server_cancelled" | "app_server_deadline_exceeded" | "broker_permit_expired" | undefined;
    let permitTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (code: typeof abortCode): void => {
      if (abortCode) return;
      abortCode = code;
      void this.driver.close();
    };
    const onAbort = (): void => abort("app_server_cancelled");
    if (options.signal?.aborted) abort("app_server_cancelled");
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => abort("app_server_deadline_exceeded"), timeoutMs);
    try {
      if (abortCode) throw new CodexAppServerRuntimeErrorV1(abortCode);
      await this.driver.handshake(this.controller.planInitialize(), this.controller.planInitialized());
      await this.driver.request(this.controller.planEnvironmentRegistration());
      const status = environmentStatusFrom(await this.driver.request(this.controller.planEnvironmentStatus()));
      if (status !== "ready") throw new CodexAppServerRuntimeErrorV1("remote_environment_not_ready");
      const claim = this.controller.claim(request);
      if (claim.disposition !== "dispatch_once") return { disposition: claim.disposition, events };
      if (!claim.ticket) throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
      claimedTicket = claim.ticket;
      const threadId = threadIdFrom(await this.driver.request(this.controller.planThreadBoundary(request)));
      if (!threadId || (request.operation === "resume" && threadId !== request.nativeThreadId)) {
        throw new CodexAppServerRuntimeErrorV1("thread_response_invalid");
      }
      this.ledger.bindNodeLocalThread(claim.ticket, threadId);
      const turnRequest = this.controller.planClaimedTurn({ request, ticket: claim.ticket, nativeThreadId: threadId, environmentStatus: status });
      const dispatchAuthority = this.ledger.authorizeClaimedDispatch(claim.ticket);
      permitTimer = setTimeout(() => abort("broker_permit_expired"), dispatchAuthority.remainingPermitMs);
      observer = new CodexIsolatedTurnObserverV1(threadId, claim.ticket, this.ledger);
      const observe = (notification: Extract<CodexAppServerInboundV1, { kind: "notification" }>): void => {
        if (events.length >= CODEX_ISOLATED_MAX_OBSERVED_EVENTS_V1) throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
        try { this.ledger.authorizeClaimedDispatch(claim.ticket!); }
        catch (error) {
          if (error instanceof CodexBrokerPolicyErrorV1 && error.safeCode === "grant_expired") {
            abort("broker_permit_expired");
            throw new CodexAppServerRuntimeErrorV1("broker_permit_expired");
          }
          throw error;
        }
        const event = observer?.observe(notification);
        if (event) events.push(event);
      };
      const observeBeforeResponse = (_notification: Extract<CodexAppServerInboundV1, { kind: "notification" }>): void => {
        void _notification;
        throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
      };
      const turnId = turnIdFrom(await this.driver.request(turnRequest, observeBeforeResponse), threadId);
      if (!turnId) throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
      observer.bindTurn(turnId);
      while (!observer.isTerminal) await this.driver.notification(observe);
      const terminal = observer.terminalState;
      if (!terminal || terminal === "ambiguous") throw new CodexAppServerRuntimeErrorV1("app_server_protocol_invalid");
      return { disposition: terminal, nativeThreadIdDigest: sha256Digest(threadId), events };
    } catch (error) {
      const safeCode = abortCode ?? (error instanceof CodexAppServerRuntimeErrorV1 ? error.safeCode : "app_server_protocol_invalid");
      const ambiguityCode = ["app_server_disconnected", "app_server_cancelled", "app_server_deadline_exceeded", "broker_permit_expired"].includes(safeCode)
        ? safeCode : "app_server_protocol_invalid";
      if (observer) observer.disconnect(ambiguityCode);
      else if (claimedTicket) { try { this.ledger.settle({ ticket: claimedTicket, outcome: "ambiguous", safeResultCode: ambiguityCode }); } catch { /* reconcile after restart */ } }
      throw new CodexAppServerRuntimeErrorV1(safeCode);
    } finally {
      clearTimeout(timer);
      if (permitTimer) clearTimeout(permitTimer);
      options.signal?.removeEventListener("abort", onAbort);
      await this.driver.close();
    }
  }
}
