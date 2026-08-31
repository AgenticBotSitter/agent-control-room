import { sha256Digest } from "../../security";
import { assertCodexCredentialBoundaryPermitV1, type CodexCredentialBoundaryPermitV1 } from "./credential-boundary";

export type CodexBrokerTransportV1 =
  | "control_room_credential_broker"
  | "codex_app_server_websocket"
  | "saved_auth_cli";

export function evaluateCodexBrokerTransportV1(transport: CodexBrokerTransportV1): {
  accepted: boolean;
  reasonCode?: "experimental_transport_not_security_boundary" | "credential_inside_worker";
} {
  if (transport === "control_room_credential_broker") return { accepted: true };
  if (transport === "codex_app_server_websocket") return { accepted: false, reasonCode: "experimental_transport_not_security_boundary" };
  return { accepted: false, reasonCode: "credential_inside_worker" };
}

export interface CodexBrokerGrantLimitsV1 {
  maximumInputBytes: number;
  maximumOutputTokens: number;
}

export interface CodexBrokerCallRequestV1 {
  schema: "control-room.codex-broker-call/v1";
  requestId: string;
  permitDigest: string;
  runId: string;
  model: string;
  operation: "start" | "resume";
  input: string;
  maximumOutputTokens: number;
  nativeThreadId?: string;
}

export interface CodexBrokerDispatchTicketV1 {
  schema: "control-room.codex-broker-dispatch-ticket/v1";
  requestId: string;
  permitDigest: string;
  runId: string;
  model: string;
  operation: "start" | "resume";
  requestDigest: string;
  callNumber: number;
  ticketDigest: string;
}

export interface CodexBrokerUsageV1 {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export type CodexBrokerClaimDispositionV1 =
  | "dispatch_once"
  | "in_progress"
  | "replay_completed"
  | "replay_failed"
  | "ambiguous";

export class CodexBrokerPolicyErrorV1 extends Error {
  constructor(public readonly safeCode:
    | "grant_invalid" | "grant_conflict" | "grant_closed" | "grant_expired"
    | "request_invalid" | "request_scope_mismatch" | "request_replay_conflict"
    | "input_too_large" | "output_limit_exceeded" | "call_budget_exhausted"
    | "ticket_mismatch" | "settlement_invalid") {
    super(safeCode);
    this.name = "CodexBrokerPolicyErrorV1";
  }
}

type CallState = "claimed" | "completed" | "failed" | "ambiguous";

interface StoredCall {
  requestDigest: string;
  ticket: CodexBrokerDispatchTicketV1;
  maximumOutputTokens: number;
  state: CallState;
  usage?: CodexBrokerUsageV1;
  safeResultCode?: string;
  nativeThreadId?: string;
}

interface StoredGrant {
  permit: CodexCredentialBoundaryPermitV1;
  limits: CodexBrokerGrantLimitsV1;
  state: "active" | "closed";
  closeReasonCode?: string;
  calls: Map<string, StoredCall>;
}

function validIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value);
}

function validNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validUsage(value: unknown): value is CodexBrokerUsageV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  const keys = Object.keys(usage).sort();
  const expected = ["cachedInputTokens", "inputTokens", "outputTokens", "reasoningTokens"];
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && expected.every((key) => validNonNegativeInteger(usage[key] as number));
}

function assertLimits(limits: CodexBrokerGrantLimitsV1): void {
  if (!Number.isSafeInteger(limits.maximumInputBytes) || limits.maximumInputBytes < 1 || limits.maximumInputBytes > 65_536) {
    throw new CodexBrokerPolicyErrorV1("grant_invalid");
  }
  if (!Number.isSafeInteger(limits.maximumOutputTokens) || limits.maximumOutputTokens < 1 || limits.maximumOutputTokens > 8_192) {
    throw new CodexBrokerPolicyErrorV1("grant_invalid");
  }
}

function ticketFor(input: {
  request: Omit<CodexBrokerCallRequestV1, "input">;
  requestDigest: string;
  callNumber: number;
}): CodexBrokerDispatchTicketV1 {
  const unsigned = {
    schema: "control-room.codex-broker-dispatch-ticket/v1" as const,
    requestId: input.request.requestId,
    permitDigest: input.request.permitDigest,
    runId: input.request.runId,
    model: input.request.model,
    operation: input.request.operation,
    requestDigest: input.requestDigest,
    callNumber: input.callNumber,
  };
  return { ...unsigned, ticketDigest: sha256Digest(unsigned) };
}

/**
 * Effect-free reference ledger for a credential-isolated broker.
 *
 * Permits are provisioned through a trusted broker-side channel. They are
 * evidence digests, never bearer credentials. claim() atomically spends one
 * call before dispatch so a crash or retry cannot cause a second provider call.
 */
export class InMemoryCodexCredentialBrokerLedgerV1 {
  private readonly grants = new Map<string, StoredGrant>();
  private readonly requestOwners = new Map<string, string>();
  private readonly threadOwners = new Map<string, { permitDigest: string; quarantined: boolean }>();
  private lastObservedTime = 0;

  constructor(private readonly endpointIdentityDigest: string, private readonly options: { clock?: () => string } = {}) {
    if (!/^sha256:[a-f0-9]{64}$/.test(endpointIdentityDigest)) throw new CodexBrokerPolicyErrorV1("grant_invalid");
  }

  provision(input: { permit: CodexCredentialBoundaryPermitV1; limits: CodexBrokerGrantLimitsV1; now?: string }): { replayed: boolean } {
    const observedNow = this.trustedNow();
    try { assertCodexCredentialBoundaryPermitV1(input.permit, input.permit.runId, observedNow); }
    catch { throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
    assertLimits(input.limits);
    if (input.permit.endpointIdentityDigest !== this.endpointIdentityDigest) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    const existing = this.grants.get(input.permit.permitDigest);
    if (existing) {
      if (sha256Digest(existing.permit) !== sha256Digest(input.permit) || sha256Digest(existing.limits) !== sha256Digest(input.limits)) {
        throw new CodexBrokerPolicyErrorV1("grant_conflict");
      }
      return { replayed: true };
    }
    this.grants.set(input.permit.permitDigest, { permit: structuredClone(input.permit), limits: { ...input.limits }, state: "active", calls: new Map() });
    return { replayed: false };
  }

  claim(request: CodexBrokerCallRequestV1, _untrustedNow?: string): {
    disposition: CodexBrokerClaimDispositionV1;
    ticket?: CodexBrokerDispatchTicketV1;
    usage?: CodexBrokerUsageV1;
    safeResultCode?: string;
  } {
    void _untrustedNow;
    const grant = this.grants.get(request.permitDigest);
    if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    if (grant.state !== "active") throw new CodexBrokerPolicyErrorV1("grant_closed");
    const observedAt = Date.parse(this.trustedNow());
    if (!Number.isFinite(observedAt) || Date.parse(grant.permit.expiresAt) <= observedAt) throw new CodexBrokerPolicyErrorV1("grant_expired");
    if (request.schema !== "control-room.codex-broker-call/v1" || !validIdentifier(request.requestId) || typeof request.input !== "string"
      || (request.operation !== "start" && request.operation !== "resume")) {
      throw new CodexBrokerPolicyErrorV1("request_invalid");
    }
    if (request.runId !== grant.permit.runId || request.model !== grant.permit.model) throw new CodexBrokerPolicyErrorV1("request_scope_mismatch");
    if ((request.operation === "resume") !== Boolean(request.nativeThreadId) || (request.nativeThreadId && !validIdentifier(request.nativeThreadId))) {
      throw new CodexBrokerPolicyErrorV1("request_invalid");
    }
    const requestDigest = sha256Digest(request);
    const owner = this.requestOwners.get(request.requestId);
    if (owner && owner !== request.permitDigest) throw new CodexBrokerPolicyErrorV1("request_replay_conflict");
    const prior = grant.calls.get(request.requestId);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new CodexBrokerPolicyErrorV1("request_replay_conflict");
      if (prior.state === "claimed") return { disposition: "in_progress" };
      if (prior.state === "ambiguous") return { disposition: "ambiguous", safeResultCode: prior.safeResultCode };
      return {
        disposition: prior.state === "completed" ? "replay_completed" : "replay_failed",
        ...(prior.usage ? { usage: { ...prior.usage } } : {}),
        ...(prior.safeResultCode ? { safeResultCode: prior.safeResultCode } : {}),
      };
    }
    if (request.operation === "resume" && ![...grant.calls.values()].some((call) =>
      call.state === "completed" && call.nativeThreadId === request.nativeThreadId)) {
      throw new CodexBrokerPolicyErrorV1("request_scope_mismatch");
    }
    if (Buffer.byteLength(request.input, "utf8") > grant.limits.maximumInputBytes) throw new CodexBrokerPolicyErrorV1("input_too_large");
    if (!Number.isSafeInteger(request.maximumOutputTokens) || request.maximumOutputTokens < 1 || request.maximumOutputTokens > grant.limits.maximumOutputTokens) {
      throw new CodexBrokerPolicyErrorV1("output_limit_exceeded");
    }
    if (grant.calls.size >= grant.permit.maximumProviderCalls) throw new CodexBrokerPolicyErrorV1("call_budget_exhausted");
    const { input: _discardedInput, ...safeRequest } = request;
    void _discardedInput;
    const ticket = ticketFor({ request: safeRequest, requestDigest, callNumber: grant.calls.size + 1 });
    grant.calls.set(request.requestId, { requestDigest, ticket, maximumOutputTokens: request.maximumOutputTokens, state: "claimed" });
    this.requestOwners.set(request.requestId, request.permitDigest);
    return { disposition: "dispatch_once", ticket: { ...ticket } };
  }

  authorizeClaimedDispatch(ticket: CodexBrokerDispatchTicketV1): { remainingPermitMs: number } {
    const grant = this.grants.get(ticket.permitDigest); const call = grant?.calls.get(ticket.requestId);
    if (!grant || grant.state !== "active" || !call || call.state !== "claimed"
      || sha256Digest(ticket) !== sha256Digest(call.ticket)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
    const remainingPermitMs = Date.parse(grant.permit.expiresAt) - Date.parse(this.trustedNow());
    if (!Number.isSafeInteger(remainingPermitMs) || remainingPermitMs <= 0) throw new CodexBrokerPolicyErrorV1("grant_expired");
    return { remainingPermitMs };
  }

  private trustedNow(): string {
    const now = this.options.clock?.() ?? new Date().toISOString();
    const parsed = Date.parse(now);
    if (!Number.isFinite(parsed) || parsed < this.lastObservedTime) throw new CodexBrokerPolicyErrorV1("grant_expired");
    this.lastObservedTime = parsed;
    return now;
  }

  settle(input: {
    ticket: CodexBrokerDispatchTicketV1;
    outcome: "completed" | "failed" | "ambiguous";
    usage?: CodexBrokerUsageV1;
    safeResultCode?: string;
  }): void {
    const grant = this.grants.get(input.ticket.permitDigest);
    const call = grant?.calls.get(input.ticket.requestId);
    if (!grant || !call || sha256Digest(input.ticket) !== sha256Digest(call.ticket)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
    if (call.state !== "claimed") throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    if (!(["completed", "failed", "ambiguous"] as unknown[]).includes(input.outcome)
      || (input.usage !== undefined && !validUsage(input.usage))) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    if (input.outcome === "completed" && !input.usage) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    if (input.usage && input.usage.outputTokens > call.maximumOutputTokens) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    if (input.safeResultCode !== undefined && !/^[a-z][a-z0-9_]{2,63}$/.test(input.safeResultCode)) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    if ((input.outcome === "failed" || input.outcome === "ambiguous") && !input.safeResultCode) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    if (input.outcome === "completed" && input.safeResultCode) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    const quarantinedThreadId = input.outcome === "completed" ? undefined : call.nativeThreadId;
    call.state = input.outcome;
    if (quarantinedThreadId) {
      const threadDigest = sha256Digest(quarantinedThreadId);
      const threadOwner = this.threadOwners.get(threadDigest);
      if (threadOwner) threadOwner.quarantined = true;
      for (const candidateGrant of this.grants.values()) {
        for (const candidate of candidateGrant.calls.values()) {
          if (candidate.nativeThreadId === quarantinedThreadId) candidate.nativeThreadId = undefined;
        }
      }
    }
    if (input.usage) call.usage = { ...input.usage };
    if (input.safeResultCode) call.safeResultCode = input.safeResultCode;
  }

  bindNodeLocalThread(ticket: CodexBrokerDispatchTicketV1, nativeThreadId: string): void {
    const grant = this.grants.get(ticket.permitDigest);
    const call = grant?.calls.get(ticket.requestId);
    if (!call || call.state !== "claimed" || sha256Digest(ticket) !== sha256Digest(call.ticket)
      || !validIdentifier(nativeThreadId) || (call.nativeThreadId && call.nativeThreadId !== nativeThreadId)) {
      throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
    }
    const threadDigest = sha256Digest(nativeThreadId);
    const owner = this.threadOwners.get(threadDigest);
    if (owner && (owner.permitDigest !== ticket.permitDigest || owner.quarantined)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
    if (!owner) this.threadOwners.set(threadDigest, { permitDigest: ticket.permitDigest, quarantined: false });
    call.nativeThreadId = nativeThreadId;
  }

  resolveNodeLocalThreadForBroker(input: { permitDigest: string; runId: string; sourceRequestId: string; nativeThreadIdDigest: string }): string | undefined {
    if (!/^sha256:[a-f0-9]{64}$/.test(input.nativeThreadIdDigest)) throw new CodexBrokerPolicyErrorV1("request_invalid");
    const grant = this.grants.get(input.permitDigest);
    if (!grant || grant.state !== "active" || grant.permit.runId !== input.runId
      || Date.parse(grant.permit.expiresAt) <= Date.parse(this.trustedNow())) return undefined;
    const call = grant.calls.get(input.sourceRequestId);
    return call?.state === "completed" && call.nativeThreadId && sha256Digest(call.nativeThreadId) === input.nativeThreadIdDigest
      ? call.nativeThreadId : undefined;
  }

  close(permitDigest: string, safeReasonCode: string): { replayed: boolean; ambiguousCalls: number } {
    const grant = this.grants.get(permitDigest);
    if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(safeReasonCode)) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    if (grant.state === "closed") {
      if (grant.closeReasonCode !== safeReasonCode) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
      return { replayed: true, ambiguousCalls: [...grant.calls.values()].filter((call) => call.state === "ambiguous").length };
    }
    grant.state = "closed";
    grant.closeReasonCode = safeReasonCode;
    for (const call of grant.calls.values()) {
      if (call.state === "claimed") { call.state = "ambiguous"; call.safeResultCode = safeReasonCode; }
      if (call.nativeThreadId) {
        const owner = this.threadOwners.get(sha256Digest(call.nativeThreadId));
        if (owner) owner.quarantined = true;
      }
      call.nativeThreadId = undefined;
    }
    return { replayed: false, ambiguousCalls: [...grant.calls.values()].filter((call) => call.state === "ambiguous").length };
  }

  evidence(permitDigest: string): {
    runId: string;
    model: string;
    state: "active" | "closed";
    maximumProviderCalls: number;
    consumedProviderCalls: number;
    calls: Array<{ requestIdDigest: string; operation: "start" | "resume"; callNumber: number; state: CallState; usage?: CodexBrokerUsageV1; safeResultCode?: string }>;
  } {
    const grant = this.grants.get(permitDigest);
    if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    return {
      runId: grant.permit.runId,
      model: grant.permit.model,
      state: grant.state,
      maximumProviderCalls: grant.permit.maximumProviderCalls,
      consumedProviderCalls: grant.calls.size,
      calls: [...grant.calls.values()].map((call) => ({
        requestIdDigest: sha256Digest(call.ticket.requestId), operation: call.ticket.operation, callNumber: call.ticket.callNumber,
        state: call.state, ...(call.usage ? { usage: { ...call.usage } } : {}), ...(call.safeResultCode ? { safeResultCode: call.safeResultCode } : {}),
      })),
    };
  }
}
