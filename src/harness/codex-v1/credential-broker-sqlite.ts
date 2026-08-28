import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Digest } from "../../security";
import { assertCodexCredentialBoundaryPermitV1, type CodexCredentialBoundaryPermitV1 } from "./credential-boundary";
import {
  CodexBrokerPolicyErrorV1,
  type CodexBrokerCallRequestV1,
  type CodexBrokerClaimDispositionV1,
  type CodexBrokerDispatchTicketV1,
  type CodexBrokerGrantLimitsV1,
  type CodexBrokerUsageV1,
} from "./credential-broker";

type GrantRow = {
  permit_json: string; limits_json: string; state: "active" | "closed"; close_reason_code: string | null;
};
type CallRow = {
  request_digest: string; ticket_json: string; maximum_output_tokens: number;
  state: "claimed" | "completed" | "failed" | "ambiguous"; usage_json: string | null; safe_result_code: string | null;
};

function validIdentifier(value: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value); }
function validCode(value: string): boolean { return /^[a-z][a-z0-9_]{2,63}$/.test(value); }
function validUsage(usage: CodexBrokerUsageV1): boolean { return Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0); }
function assertLimits(limits: CodexBrokerGrantLimitsV1): void {
  if (!Number.isSafeInteger(limits.maximumInputBytes) || limits.maximumInputBytes < 1 || limits.maximumInputBytes > 65_536
    || !Number.isSafeInteger(limits.maximumOutputTokens) || limits.maximumOutputTokens < 1 || limits.maximumOutputTokens > 8_192) {
    throw new CodexBrokerPolicyErrorV1("grant_invalid");
  }
}

function createTicket(request: CodexBrokerCallRequestV1, requestDigest: string, callNumber: number): CodexBrokerDispatchTicketV1 {
  const unsigned = { schema: "control-room.codex-broker-dispatch-ticket/v1" as const, requestId: request.requestId,
    permitDigest: request.permitDigest, runId: request.runId, model: request.model, operation: request.operation, requestDigest, callNumber };
  return { ...unsigned, ticketDigest: sha256Digest(unsigned) };
}

function preparePrivateDatabasePath(path: string): void {
  if (!isAbsolute(path)) throw new CodexBrokerPolicyErrorV1("grant_invalid");
  const getuid = process.getuid;
  if (!getuid) throw new CodexBrokerPolicyErrorV1("grant_invalid");
  const currentUid = getuid();
  const parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== currentUid || (parent.mode & 0o077) !== 0) throw new CodexBrokerPolicyErrorV1("grant_invalid");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== currentUid || existing.nlink !== 1 || (existing.mode & 0o077) !== 0) throw new CodexBrokerPolicyErrorV1("grant_invalid");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    closeSync(openSync(path, "wx", 0o600));
  }
}

/** Durable broker-private call ledger. It never stores prompt, response, auth, or raw native session content. */
export class SqliteCodexCredentialBrokerLedgerV1 {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly endpointIdentityDigest: string, options: { testOnlyAllowEphemeral?: boolean } = {}) {
    if (!/^sha256:[a-f0-9]{64}$/.test(endpointIdentityDigest)) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    if (path === ":memory:") {
      if (!options.testOnlyAllowEphemeral) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    } else preparePrivateDatabasePath(path);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codex_broker_grants (
        permit_digest TEXT PRIMARY KEY, permit_json TEXT NOT NULL, limits_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','closed')), close_reason_code TEXT
      );
      CREATE TABLE IF NOT EXISTS codex_broker_calls (
        request_id TEXT PRIMARY KEY, permit_digest TEXT NOT NULL REFERENCES codex_broker_grants(permit_digest),
        request_digest TEXT NOT NULL, ticket_json TEXT NOT NULL, maximum_output_tokens INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','completed','failed','ambiguous')),
        usage_json TEXT, safe_result_code TEXT
      );
      CREATE INDEX IF NOT EXISTS codex_broker_calls_permit ON codex_broker_calls(permit_digest);
      PRAGMA user_version=1;
    `);
  }

  closeDatabase(): void { this.db.close(); }

  provision(input: { permit: CodexCredentialBoundaryPermitV1; limits: CodexBrokerGrantLimitsV1; now: string }): { replayed: boolean } {
    try { assertCodexCredentialBoundaryPermitV1(input.permit, input.permit.runId, input.now); } catch { throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
    assertLimits(input.limits);
    if (input.permit.endpointIdentityDigest !== this.endpointIdentityDigest) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT permit_json,limits_json FROM codex_broker_grants WHERE permit_digest=?").get(input.permit.permitDigest) as { permit_json: string; limits_json: string } | undefined;
      if (prior) {
        if (sha256Digest(JSON.parse(prior.permit_json)) !== sha256Digest(input.permit) || sha256Digest(JSON.parse(prior.limits_json)) !== sha256Digest(input.limits)) throw new CodexBrokerPolicyErrorV1("grant_conflict");
        return { replayed: true };
      }
      this.db.prepare("INSERT INTO codex_broker_grants(permit_digest,permit_json,limits_json,state) VALUES (?,?,?,'active')")
        .run(input.permit.permitDigest, JSON.stringify(input.permit), JSON.stringify(input.limits));
      return { replayed: false };
    });
  }

  claim(request: CodexBrokerCallRequestV1, now: string): { disposition: CodexBrokerClaimDispositionV1; ticket?: CodexBrokerDispatchTicketV1; usage?: CodexBrokerUsageV1; safeResultCode?: string } {
    return this.transaction(() => {
      const grant = this.db.prepare("SELECT permit_json,limits_json,state,close_reason_code FROM codex_broker_grants WHERE permit_digest=?").get(request.permitDigest) as GrantRow | undefined;
      if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
      if (grant.state !== "active") throw new CodexBrokerPolicyErrorV1("grant_closed");
      const permit = JSON.parse(grant.permit_json) as CodexCredentialBoundaryPermitV1;
      const limits = JSON.parse(grant.limits_json) as CodexBrokerGrantLimitsV1;
      const observedAt = Date.parse(now);
      if (!Number.isFinite(observedAt) || Date.parse(permit.expiresAt) <= observedAt) throw new CodexBrokerPolicyErrorV1("grant_expired");
      if (request.schema !== "control-room.codex-broker-call/v1" || !validIdentifier(request.requestId) || typeof request.input !== "string"
        || (request.operation !== "start" && request.operation !== "resume")
        || ((request.operation === "resume") !== Boolean(request.nativeThreadId)) || (request.nativeThreadId && !validIdentifier(request.nativeThreadId))) throw new CodexBrokerPolicyErrorV1("request_invalid");
      if (request.runId !== permit.runId || request.model !== permit.model) throw new CodexBrokerPolicyErrorV1("request_scope_mismatch");
      if (Buffer.byteLength(request.input, "utf8") > limits.maximumInputBytes) throw new CodexBrokerPolicyErrorV1("input_too_large");
      if (!Number.isSafeInteger(request.maximumOutputTokens) || request.maximumOutputTokens < 1 || request.maximumOutputTokens > limits.maximumOutputTokens) throw new CodexBrokerPolicyErrorV1("output_limit_exceeded");
      const digest = sha256Digest(request);
      const prior = this.db.prepare("SELECT request_digest,ticket_json,maximum_output_tokens,state,usage_json,safe_result_code FROM codex_broker_calls WHERE request_id=?").get(request.requestId) as CallRow | undefined;
      if (prior) {
        if (prior.request_digest !== digest) throw new CodexBrokerPolicyErrorV1("request_replay_conflict");
        if (prior.state === "claimed") return { disposition: "in_progress" };
        if (prior.state === "ambiguous") return { disposition: "ambiguous", ...(prior.safe_result_code ? { safeResultCode: prior.safe_result_code } : {}) };
        return { disposition: prior.state === "completed" ? "replay_completed" : "replay_failed",
          ...(prior.usage_json ? { usage: JSON.parse(prior.usage_json) as CodexBrokerUsageV1 } : {}), ...(prior.safe_result_code ? { safeResultCode: prior.safe_result_code } : {}) };
      }
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM codex_broker_calls WHERE permit_digest=?").get(request.permitDigest) as { count: number }).count;
      if (count >= permit.maximumProviderCalls) throw new CodexBrokerPolicyErrorV1("call_budget_exhausted");
      const ticket = createTicket(request, digest, count + 1);
      this.db.prepare("INSERT INTO codex_broker_calls(request_id,permit_digest,request_digest,ticket_json,maximum_output_tokens,state) VALUES (?,?,?,?,?,'claimed')")
        .run(request.requestId, request.permitDigest, digest, JSON.stringify(ticket), request.maximumOutputTokens);
      return { disposition: "dispatch_once", ticket };
    });
  }

  settle(input: { ticket: CodexBrokerDispatchTicketV1; outcome: "completed" | "failed" | "ambiguous"; usage?: CodexBrokerUsageV1; safeResultCode?: string }): void {
    this.transaction(() => {
      const call = this.db.prepare("SELECT request_digest,ticket_json,maximum_output_tokens,state,usage_json,safe_result_code FROM codex_broker_calls WHERE request_id=? AND permit_digest=?")
        .get(input.ticket.requestId, input.ticket.permitDigest) as CallRow | undefined;
      if (!call || sha256Digest(JSON.parse(call.ticket_json)) !== sha256Digest(input.ticket)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
      if (call.state !== "claimed" || (input.usage && (!validUsage(input.usage) || input.usage.outputTokens > call.maximum_output_tokens))
        || (input.outcome === "completed" && (!input.usage || input.safeResultCode))
        || ((input.outcome === "failed" || input.outcome === "ambiguous") && (!input.safeResultCode || !validCode(input.safeResultCode)))) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
      this.db.prepare("UPDATE codex_broker_calls SET state=?,usage_json=?,safe_result_code=? WHERE request_id=?")
        .run(input.outcome, input.usage ? JSON.stringify(input.usage) : null, input.safeResultCode ?? null, input.ticket.requestId);
    });
  }

  recoverAfterRestart(safeReasonCode = "broker_restarted"): number {
    if (!validCode(safeReasonCode)) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    return this.transaction(() => Number(this.db.prepare("UPDATE codex_broker_calls SET state='ambiguous',safe_result_code=? WHERE state='claimed'").run(safeReasonCode).changes));
  }

  close(permitDigest: string, safeReasonCode: string): { replayed: boolean; ambiguousCalls: number } {
    if (!validCode(safeReasonCode)) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    return this.transaction(() => {
      const grant = this.db.prepare("SELECT permit_json,limits_json,state,close_reason_code FROM codex_broker_grants WHERE permit_digest=?").get(permitDigest) as GrantRow | undefined;
      if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
      if (grant.state === "closed" && grant.close_reason_code !== safeReasonCode) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
      const replayed = grant.state === "closed";
      if (!replayed) {
        this.db.prepare("UPDATE codex_broker_grants SET state='closed',close_reason_code=? WHERE permit_digest=?").run(safeReasonCode, permitDigest);
        this.db.prepare("UPDATE codex_broker_calls SET state='ambiguous',safe_result_code=? WHERE permit_digest=? AND state='claimed'").run(safeReasonCode, permitDigest);
      }
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM codex_broker_calls WHERE permit_digest=? AND state='ambiguous'").get(permitDigest) as { count: number }).count;
      return { replayed, ambiguousCalls: count };
    });
  }

  evidence(permitDigest: string): { state: "active" | "closed"; maximumProviderCalls: number; consumedProviderCalls: number; calls: Array<{ requestIdDigest: string; operation: "start" | "resume"; callNumber: number; state: CallRow["state"]; usage?: CodexBrokerUsageV1; safeResultCode?: string }> } {
    const grant = this.db.prepare("SELECT permit_json,limits_json,state,close_reason_code FROM codex_broker_grants WHERE permit_digest=?").get(permitDigest) as GrantRow | undefined;
    if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    const permit = JSON.parse(grant.permit_json) as CodexCredentialBoundaryPermitV1;
    const rows = this.db.prepare("SELECT request_id,ticket_json,state,usage_json,safe_result_code FROM codex_broker_calls WHERE permit_digest=? ORDER BY rowid").all(permitDigest) as Array<{ request_id: string; ticket_json: string; state: CallRow["state"]; usage_json: string | null; safe_result_code: string | null }>;
    return { state: grant.state, maximumProviderCalls: permit.maximumProviderCalls, consumedProviderCalls: rows.length,
      calls: rows.map((row) => { const ticket = JSON.parse(row.ticket_json) as CodexBrokerDispatchTicketV1; return {
        requestIdDigest: sha256Digest(row.request_id), operation: ticket.operation, callNumber: ticket.callNumber, state: row.state,
        ...(row.usage_json ? { usage: JSON.parse(row.usage_json) as CodexBrokerUsageV1 } : {}), ...(row.safe_result_code ? { safeResultCode: row.safe_result_code } : {}),
      }; }) };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
