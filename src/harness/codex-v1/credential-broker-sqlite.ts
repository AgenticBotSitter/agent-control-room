import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { assertCodexCredentialBoundaryPermitV1, type CodexCredentialBoundaryPermitV1 } from "./credential-boundary";
import {
  CodexBrokerPolicyErrorV1,
  type CodexBrokerCallRequestV1,
  type CodexBrokerClaimDispositionV1,
  type CodexBrokerDispatchTicketV1,
  type CodexBrokerGrantLimitsV1,
  type CodexBrokerUsageV1,
} from "./credential-broker";
import { assertPrivateSqliteSchemaV1 } from "./private-sqlite-schema";

type GrantRow = {
  permit_json: string; limits_json: string; state: "active" | "closed"; close_reason_code: string | null;
};
type CallRow = {
  request_digest: string; ticket_json: string; maximum_output_tokens: number;
  state: "claimed" | "completed" | "failed" | "ambiguous"; usage_json: string | null; safe_result_code: string | null;
  native_thread_id?: string | null;
};

function validIdentifier(value: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value); }
function validCode(value: string): boolean { return /^[a-z][a-z0-9_]{2,63}$/.test(value); }
function validUsage(value: unknown): value is CodexBrokerUsageV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  const keys = Object.keys(usage).sort();
  const expected = ["cachedInputTokens", "inputTokens", "outputTokens", "reasoningTokens"];
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && expected.every((key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0);
}
function assertLimits(limits: CodexBrokerGrantLimitsV1): void {
  if (!limits || typeof limits!=="object" || Array.isArray(limits)
    || Object.keys(limits).sort().join("|")!=="maximumInputBytes|maximumOutputTokens"
    || !Number.isSafeInteger(limits.maximumInputBytes) || limits.maximumInputBytes < 1 || limits.maximumInputBytes > 65_536
    || !Number.isSafeInteger(limits.maximumOutputTokens) || limits.maximumOutputTokens < 1 || limits.maximumOutputTokens > 8_192) {
    throw new CodexBrokerPolicyErrorV1("grant_invalid");
  }
}

function parseStoredGrant(row: Pick<GrantRow,"permit_json"|"limits_json">, expectedPermitDigest: string,
  endpointIdentityDigest: string): { permit: CodexCredentialBoundaryPermitV1; limits: CodexBrokerGrantLimitsV1 } {
  try {
    const permit=JSON.parse(row.permit_json) as CodexCredentialBoundaryPermitV1;
    const limits=JSON.parse(row.limits_json) as CodexBrokerGrantLimitsV1;
    const expiresAt=Date.parse(permit.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error("expiry invalid");
    assertCodexCredentialBoundaryPermitV1(permit,permit.runId,new Date(expiresAt-1).toISOString());
    assertLimits(limits);
    if (permit.permitDigest!==expectedPermitDigest || permit.endpointIdentityDigest!==endpointIdentityDigest) throw new Error("binding invalid");
    return {permit,limits};
  } catch { throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
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

/** Durable broker-private call ledger. It stores no prompt, response, or auth; node-local thread handles are scoped and cleared on retirement. */
export class SqliteCodexCredentialBrokerLedgerV1 {
  private readonly db: DatabaseSync;
  private readonly integrityKey: Uint8Array;

  constructor(path: string, private readonly endpointIdentityDigest: string,
    private readonly options: { testOnlyAllowEphemeral?: boolean; clock?: () => string; integrityKey?: Uint8Array } = {}) {
    if (!/^sha256:[a-f0-9]{64}$/.test(endpointIdentityDigest)) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    try { hmacSha256Tag(options.integrityKey ?? new Uint8Array(),{purpose:"codex-broker-ledger-key-check"}); }
    catch { throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
    this.integrityKey=options.integrityKey!;
    if (path === ":memory:") {
      if (!options.testOnlyAllowEphemeral) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    } else preparePrivateDatabasePath(path);
    if (options.clock && !options.testOnlyAllowEphemeral) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    this.db = new DatabaseSync(path);
    const schemaVersion = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (schemaVersion !== 0 && schemaVersion !== 5) {
      this.db.close(); throw new CodexBrokerPolicyErrorV1("grant_invalid");
    }
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
        usage_json TEXT, safe_result_code TEXT, native_thread_id TEXT
      );
      CREATE INDEX IF NOT EXISTS codex_broker_calls_permit ON codex_broker_calls(permit_digest);
      CREATE TABLE IF NOT EXISTS codex_broker_threads (
        thread_digest TEXT PRIMARY KEY, permit_digest TEXT NOT NULL REFERENCES codex_broker_grants(permit_digest),
        state TEXT NOT NULL CHECK(state IN ('active','quarantined'))
      );
      CREATE TABLE IF NOT EXISTS codex_broker_clock (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_observed_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_broker_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), endpoint_identity_digest TEXT NOT NULL, state_auth_tag TEXT NOT NULL
      );
      INSERT OR IGNORE INTO codex_broker_clock(singleton,last_observed_ms) VALUES(1,0);
    `);
    const callColumns = this.db.prepare("PRAGMA table_info(codex_broker_calls)").all() as Array<{ name: string }>;
    if (!callColumns.some((column) => column.name === "native_thread_id")) { this.db.close(); throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
    try { assertPrivateSqliteSchemaV1(this.db, [
      "index:codex_broker_calls_permit", "table:codex_broker_calls", "table:codex_broker_clock",
      "table:codex_broker_grants", "table:codex_broker_metadata", "table:codex_broker_threads",
    ], {
      codex_broker_grants: [
        { name: "permit_digest", type: "TEXT", notnull: 0, pk: 1 }, { name: "permit_json", type: "TEXT", notnull: 1, pk: 0 },
        { name: "limits_json", type: "TEXT", notnull: 1, pk: 0 }, { name: "state", type: "TEXT", notnull: 1, pk: 0 },
        { name: "close_reason_code", type: "TEXT", notnull: 0, pk: 0 },
      ],
      codex_broker_calls: [
        { name: "request_id", type: "TEXT", notnull: 0, pk: 1 }, { name: "permit_digest", type: "TEXT", notnull: 1, pk: 0 },
        { name: "request_digest", type: "TEXT", notnull: 1, pk: 0 }, { name: "ticket_json", type: "TEXT", notnull: 1, pk: 0 },
        { name: "maximum_output_tokens", type: "INTEGER", notnull: 1, pk: 0 }, { name: "state", type: "TEXT", notnull: 1, pk: 0 },
        { name: "usage_json", type: "TEXT", notnull: 0, pk: 0 }, { name: "safe_result_code", type: "TEXT", notnull: 0, pk: 0 },
        { name: "native_thread_id", type: "TEXT", notnull: 0, pk: 0 },
      ],
      codex_broker_threads: [
        { name: "thread_digest", type: "TEXT", notnull: 0, pk: 1 }, { name: "permit_digest", type: "TEXT", notnull: 1, pk: 0 },
        { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      ],
      codex_broker_clock: [
        { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 }, { name: "last_observed_ms", type: "INTEGER", notnull: 1, pk: 0 },
      ],
      codex_broker_metadata: [
        { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 }, { name: "endpoint_identity_digest", type: "TEXT", notnull: 1, pk: 0 },
        { name: "state_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
      ],
    }, {
      codex_broker_grants: "CREATE TABLE codex_broker_grants (permit_digest TEXT PRIMARY KEY, permit_json TEXT NOT NULL, limits_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','closed')), close_reason_code TEXT)",
      codex_broker_calls: "CREATE TABLE codex_broker_calls (request_id TEXT PRIMARY KEY, permit_digest TEXT NOT NULL REFERENCES codex_broker_grants(permit_digest), request_digest TEXT NOT NULL, ticket_json TEXT NOT NULL, maximum_output_tokens INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('claimed','completed','failed','ambiguous')), usage_json TEXT, safe_result_code TEXT, native_thread_id TEXT)",
      codex_broker_calls_permit: "CREATE INDEX codex_broker_calls_permit ON codex_broker_calls(permit_digest)",
      codex_broker_threads: "CREATE TABLE codex_broker_threads (thread_digest TEXT PRIMARY KEY, permit_digest TEXT NOT NULL REFERENCES codex_broker_grants(permit_digest), state TEXT NOT NULL CHECK(state IN ('active','quarantined')))",
      codex_broker_clock: "CREATE TABLE codex_broker_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_observed_ms INTEGER NOT NULL)",
      codex_broker_metadata: "CREATE TABLE codex_broker_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), endpoint_identity_digest TEXT NOT NULL, state_auth_tag TEXT NOT NULL)",
    }); } catch { this.db.close(); throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
    const metadata = this.db.prepare("SELECT endpoint_identity_digest,state_auth_tag FROM codex_broker_metadata WHERE singleton=1")
      .get() as { endpoint_identity_digest: string; state_auth_tag: string } | undefined;
    if (!metadata) {
      const existingRows=["codex_broker_grants","codex_broker_calls","codex_broker_threads"].reduce((sum,table)=>sum+
        Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count),0);
      if (schemaVersion!==0 || existingRows!==0) { this.db.close(); throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
      this.db.prepare("INSERT INTO codex_broker_metadata(singleton,endpoint_identity_digest,state_auth_tag) VALUES(1,?,?)")
        .run(endpointIdentityDigest,this.computeStateAuthTag());
      this.db.exec("PRAGMA user_version=5");
    } else {
      if (schemaVersion!==5 || metadata.endpoint_identity_digest!==endpointIdentityDigest) { this.db.close(); throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
      try { this.assertStateAuthTag(); } catch { this.db.close(); throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
    }
    try { this.transaction(() => {
      const grants=this.db.prepare("SELECT permit_digest,permit_json,limits_json FROM codex_broker_grants ORDER BY permit_digest")
        .all() as Array<{permit_digest:string;permit_json:string;limits_json:string}>;
      for (const grant of grants) parseStoredGrant(grant,grant.permit_digest,endpointIdentityDigest);
      const bindings = this.db.prepare("SELECT DISTINCT native_thread_id,permit_digest FROM codex_broker_calls WHERE native_thread_id IS NOT NULL")
        .all() as Array<{ native_thread_id: string; permit_digest: string }>;
      const owners = new Map<string, { nativeThreadId: string; permitDigests: Set<string> }>();
      for (const binding of bindings) {
        const threadDigest = sha256Digest(binding.native_thread_id);
        const owner = owners.get(threadDigest) ?? { nativeThreadId: binding.native_thread_id, permitDigests: new Set<string>() };
        owner.permitDigests.add(binding.permit_digest);
        owners.set(threadDigest, owner);
      }
      for (const [threadDigest, binding] of owners) {
        const stored = this.db.prepare("SELECT permit_digest,state FROM codex_broker_threads WHERE thread_digest=?").get(threadDigest) as { permit_digest: string; state: "active" | "quarantined" } | undefined;
        const solePermit = binding.permitDigests.size === 1 ? [...binding.permitDigests][0] : undefined;
        if (!stored && solePermit) {
          this.db.prepare("INSERT INTO codex_broker_threads(thread_digest,permit_digest,state) VALUES (?,?,'active')").run(threadDigest, solePermit);
        } else if (!solePermit || !stored || stored.permit_digest !== solePermit || stored.state === "quarantined") {
          if (!stored) this.db.prepare("INSERT INTO codex_broker_threads(thread_digest,permit_digest,state) VALUES (?,?,'quarantined')").run(threadDigest, [...binding.permitDigests][0]);
          else this.db.prepare("UPDATE codex_broker_threads SET state='quarantined' WHERE thread_digest=?").run(threadDigest);
          this.db.prepare("UPDATE codex_broker_calls SET native_thread_id=NULL WHERE native_thread_id=?").run(binding.nativeThreadId);
        }
      }
      const claimedThreads = this.db.prepare("SELECT DISTINCT native_thread_id FROM codex_broker_calls WHERE state='claimed' AND native_thread_id IS NOT NULL")
        .all() as Array<{ native_thread_id: string }>;
      for (const claimed of claimedThreads) {
        this.db.prepare("UPDATE codex_broker_threads SET state='quarantined' WHERE thread_digest=?").run(sha256Digest(claimed.native_thread_id));
        this.db.prepare("UPDATE codex_broker_calls SET native_thread_id=NULL WHERE native_thread_id=?").run(claimed.native_thread_id);
      }
      this.db.prepare("UPDATE codex_broker_calls SET state='ambiguous',safe_result_code='broker_restarted',native_thread_id=NULL WHERE state='claimed'").run();
      const unrecovered = (this.db.prepare("SELECT COUNT(*) AS count FROM codex_broker_calls WHERE state='claimed'").get() as { count: number }).count;
      if (unrecovered !== 0) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    }); } catch (error) { this.db.close(); throw error; }
  }

  closeDatabase(): void { this.db.close(); }

  provision(input: { permit: CodexCredentialBoundaryPermitV1; limits: CodexBrokerGrantLimitsV1; now?: string }): { replayed: boolean } {
    assertLimits(input.limits);
    if (input.permit.endpointIdentityDigest !== this.endpointIdentityDigest) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    return this.transactionWithTrustedClock<{ replayed: boolean }>((trustedNow) => {
      try { assertCodexCredentialBoundaryPermitV1(input.permit, input.permit.runId, trustedNow); }
      catch { throw new CodexBrokerPolicyErrorV1("grant_invalid"); }
      const prior = this.db.prepare("SELECT permit_json,limits_json FROM codex_broker_grants WHERE permit_digest=?").get(input.permit.permitDigest) as { permit_json: string; limits_json: string } | undefined;
      if (prior) {
        parseStoredGrant(prior,input.permit.permitDigest,this.endpointIdentityDigest);
        if (sha256Digest(JSON.parse(prior.permit_json)) !== sha256Digest(input.permit) || sha256Digest(JSON.parse(prior.limits_json)) !== sha256Digest(input.limits)) throw new CodexBrokerPolicyErrorV1("grant_conflict");
        return () => ({ replayed: true });
      }
      return () => {
        this.db.prepare("INSERT INTO codex_broker_grants(permit_digest,permit_json,limits_json,state) VALUES (?,?,?,'active')")
          .run(input.permit.permitDigest, JSON.stringify(input.permit), JSON.stringify(input.limits));
        const stored = this.db.prepare("SELECT permit_json,limits_json,state FROM codex_broker_grants WHERE permit_digest=?")
          .get(input.permit.permitDigest) as { permit_json: string; limits_json: string; state: string } | undefined;
        if (!stored || stored.state !== "active" || sha256Digest(JSON.parse(stored.permit_json)) !== sha256Digest(input.permit)
          || sha256Digest(JSON.parse(stored.limits_json)) !== sha256Digest(input.limits)) throw new CodexBrokerPolicyErrorV1("grant_invalid");
        return { replayed: false };
      };
    });
  }

  claim(request: CodexBrokerCallRequestV1, _untrustedNow?: string): { disposition: CodexBrokerClaimDispositionV1; ticket?: CodexBrokerDispatchTicketV1; usage?: CodexBrokerUsageV1; safeResultCode?: string } {
    void _untrustedNow;
    return this.transactionWithTrustedClock<{
      disposition: CodexBrokerClaimDispositionV1;
      ticket?: CodexBrokerDispatchTicketV1;
      usage?: CodexBrokerUsageV1;
      safeResultCode?: string;
    }>((trustedNow) => {
      const grant = this.db.prepare("SELECT permit_json,limits_json,state,close_reason_code FROM codex_broker_grants WHERE permit_digest=?").get(request.permitDigest) as GrantRow | undefined;
      if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
      if (grant.state !== "active") throw new CodexBrokerPolicyErrorV1("grant_closed");
      const {permit,limits}=parseStoredGrant(grant,request.permitDigest,this.endpointIdentityDigest);
      const observedAt = Date.parse(trustedNow);
      if (!Number.isFinite(observedAt) || Date.parse(permit.expiresAt) <= observedAt) throw new CodexBrokerPolicyErrorV1("grant_expired");
      if (request.schema !== "control-room.codex-broker-call/v1" || !validIdentifier(request.requestId) || typeof request.input !== "string"
        || (request.operation !== "start" && request.operation !== "resume")
        || ((request.operation === "resume") !== Boolean(request.nativeThreadId)) || (request.nativeThreadId && !validIdentifier(request.nativeThreadId))) throw new CodexBrokerPolicyErrorV1("request_invalid");
      if (request.runId !== permit.runId || request.model !== permit.model) throw new CodexBrokerPolicyErrorV1("request_scope_mismatch");
      const digest = sha256Digest(request);
      const prior = this.db.prepare("SELECT request_digest,ticket_json,maximum_output_tokens,state,usage_json,safe_result_code FROM codex_broker_calls WHERE request_id=?").get(request.requestId) as CallRow | undefined;
      if (prior) {
        if (prior.request_digest !== digest) throw new CodexBrokerPolicyErrorV1("request_replay_conflict");
        if (prior.state === "claimed") return () => ({ disposition: "in_progress" as const });
        if (prior.state === "ambiguous") return () => ({ disposition: "ambiguous" as const, ...(prior.safe_result_code ? { safeResultCode: prior.safe_result_code } : {}) });
        return () => ({ disposition: prior.state === "completed" ? "replay_completed" as const : "replay_failed" as const,
          ...(prior.usage_json ? { usage: JSON.parse(prior.usage_json) as CodexBrokerUsageV1 } : {}), ...(prior.safe_result_code ? { safeResultCode: prior.safe_result_code } : {}) });
      }
      if (request.operation === "resume") {
        const nativeThreadId = request.nativeThreadId;
        if (!nativeThreadId) throw new CodexBrokerPolicyErrorV1("request_invalid");
        const source = this.db.prepare("SELECT 1 FROM codex_broker_calls WHERE permit_digest=? AND state='completed' AND native_thread_id=? LIMIT 1")
          .get(request.permitDigest, nativeThreadId);
        if (!source) throw new CodexBrokerPolicyErrorV1("request_scope_mismatch");
      }
      if (Buffer.byteLength(request.input, "utf8") > limits.maximumInputBytes) throw new CodexBrokerPolicyErrorV1("input_too_large");
      if (!Number.isSafeInteger(request.maximumOutputTokens) || request.maximumOutputTokens < 1 || request.maximumOutputTokens > limits.maximumOutputTokens) throw new CodexBrokerPolicyErrorV1("output_limit_exceeded");
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM codex_broker_calls WHERE permit_digest=?").get(request.permitDigest) as { count: number }).count;
      if (count >= permit.maximumProviderCalls) throw new CodexBrokerPolicyErrorV1("call_budget_exhausted");
      const ticket = createTicket(request, digest, count + 1);
      return () => {
        this.db.prepare("INSERT INTO codex_broker_calls(request_id,permit_digest,request_digest,ticket_json,maximum_output_tokens,state) VALUES (?,?,?,?,?,'claimed')")
          .run(request.requestId, request.permitDigest, digest, JSON.stringify(ticket), request.maximumOutputTokens);
        const stored = this.db.prepare("SELECT permit_digest,request_digest,ticket_json,maximum_output_tokens,state FROM codex_broker_calls WHERE request_id=?")
          .get(request.requestId) as { permit_digest: string; request_digest: string; ticket_json: string; maximum_output_tokens: number; state: string } | undefined;
        if (!stored || stored.permit_digest !== request.permitDigest || stored.request_digest !== digest
          || sha256Digest(JSON.parse(stored.ticket_json)) !== sha256Digest(ticket)
          || stored.maximum_output_tokens !== request.maximumOutputTokens || stored.state !== "claimed") {
          throw new CodexBrokerPolicyErrorV1("settlement_invalid");
        }
        return { disposition: "dispatch_once" as const, ticket };
      };
    });
  }

  authorizeClaimedDispatch(ticket: CodexBrokerDispatchTicketV1): { remainingPermitMs: number } {
    return this.transactionWithTrustedClock((trustedNow) => {
      const observedAt = Date.parse(trustedNow);
      const row = this.db.prepare(`SELECT c.ticket_json,c.state,g.permit_json,g.limits_json,g.state AS grant_state
        FROM codex_broker_calls c JOIN codex_broker_grants g ON g.permit_digest=c.permit_digest
        WHERE c.request_id=? AND c.permit_digest=?`).get(ticket.requestId, ticket.permitDigest) as
        { ticket_json: string; state: CallRow["state"]; permit_json: string; limits_json:string; grant_state: GrantRow["state"] } | undefined;
      if (!row || row.state !== "claimed" || row.grant_state !== "active"
        || sha256Digest(JSON.parse(row.ticket_json)) !== sha256Digest(ticket)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
      const {permit}=parseStoredGrant(row,ticket.permitDigest,this.endpointIdentityDigest);
      const remainingPermitMs = Date.parse(permit.expiresAt) - observedAt;
      if (!Number.isSafeInteger(remainingPermitMs) || remainingPermitMs <= 0) throw new CodexBrokerPolicyErrorV1("grant_expired");
      return () => ({ remainingPermitMs });
    });
  }

  settle(input: { ticket: CodexBrokerDispatchTicketV1; outcome: "completed" | "failed" | "ambiguous"; usage?: CodexBrokerUsageV1; safeResultCode?: string }): void {
    this.transaction(() => {
      const call = this.db.prepare("SELECT request_digest,ticket_json,maximum_output_tokens,state,usage_json,safe_result_code,native_thread_id FROM codex_broker_calls WHERE request_id=? AND permit_digest=?")
        .get(input.ticket.requestId, input.ticket.permitDigest) as CallRow | undefined;
      if (!call || sha256Digest(JSON.parse(call.ticket_json)) !== sha256Digest(input.ticket)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
      if (call.state !== "claimed" || !(["completed", "failed", "ambiguous"] as unknown[]).includes(input.outcome)
        || (input.usage !== undefined && (!validUsage(input.usage) || input.usage.outputTokens > call.maximum_output_tokens))
        || (input.outcome === "completed" && (!input.usage || input.safeResultCode))
        || ((input.outcome === "failed" || input.outcome === "ambiguous") && (!input.safeResultCode || !validCode(input.safeResultCode)))) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
      this.db.prepare("UPDATE codex_broker_calls SET state=?,usage_json=?,safe_result_code=?,native_thread_id=CASE WHEN ?='completed' THEN native_thread_id ELSE NULL END WHERE request_id=?")
        .run(input.outcome, input.usage ? JSON.stringify(input.usage) : null, input.safeResultCode ?? null, input.outcome, input.ticket.requestId);
      if (input.outcome !== "completed" && call.native_thread_id) {
        this.db.prepare("UPDATE codex_broker_threads SET state='quarantined' WHERE thread_digest=?").run(sha256Digest(call.native_thread_id));
        this.db.prepare("UPDATE codex_broker_calls SET native_thread_id=NULL WHERE native_thread_id=?").run(call.native_thread_id);
      }
    });
  }

  bindNodeLocalThread(ticket: CodexBrokerDispatchTicketV1, nativeThreadId: string): void {
    if (!validIdentifier(nativeThreadId)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
    this.transaction(() => {
      const row = this.db.prepare("SELECT ticket_json,state,native_thread_id FROM codex_broker_calls WHERE request_id=? AND permit_digest=?")
        .get(ticket.requestId, ticket.permitDigest) as { ticket_json: string; state: CallRow["state"]; native_thread_id: string | null } | undefined;
      if (!row || row.state !== "claimed" || sha256Digest(JSON.parse(row.ticket_json)) !== sha256Digest(ticket)
        || (row.native_thread_id && row.native_thread_id !== nativeThreadId)) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
      const threadDigest = sha256Digest(nativeThreadId);
      const owner = this.db.prepare("SELECT permit_digest,state FROM codex_broker_threads WHERE thread_digest=?").get(threadDigest) as { permit_digest: string; state: "active" | "quarantined" } | undefined;
      if (owner && (owner.permit_digest !== ticket.permitDigest || owner.state !== "active")) throw new CodexBrokerPolicyErrorV1("ticket_mismatch");
      if (!owner) this.db.prepare("INSERT INTO codex_broker_threads(thread_digest,permit_digest,state) VALUES (?,?,'active')").run(threadDigest, ticket.permitDigest);
      this.db.prepare("UPDATE codex_broker_calls SET native_thread_id=? WHERE request_id=?").run(nativeThreadId, ticket.requestId);
    });
  }

  resolveNodeLocalThreadForBroker(input: { permitDigest: string; runId: string; sourceRequestId: string; nativeThreadIdDigest: string }): string | undefined {
    if (!/^sha256:[a-f0-9]{64}$/.test(input.nativeThreadIdDigest)) throw new CodexBrokerPolicyErrorV1("request_invalid");
    return this.transactionWithTrustedClock((trustedNow) => {
      const now = Date.parse(trustedNow);
      const row = this.db.prepare(`SELECT c.native_thread_id,g.permit_json,g.limits_json,g.state AS grant_state
        FROM codex_broker_calls c JOIN codex_broker_grants g ON g.permit_digest=c.permit_digest
        WHERE c.permit_digest=? AND c.request_id=? AND c.state='completed' AND c.native_thread_id IS NOT NULL`)
        .get(input.permitDigest, input.sourceRequestId) as { native_thread_id: string; permit_json: string; limits_json:string; grant_state: GrantRow["state"] } | undefined;
      if (!row || row.grant_state !== "active") return () => undefined;
      const {permit}=parseStoredGrant(row,input.permitDigest,this.endpointIdentityDigest);
      const resolved = permit.runId === input.runId && Date.parse(permit.expiresAt) > now && sha256Digest(row.native_thread_id) === input.nativeThreadIdDigest
        ? row.native_thread_id : undefined;
      return () => resolved;
    });
  }

  recoverAfterRestart(safeReasonCode = "broker_restarted"): number {
    if (!validCode(safeReasonCode)) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    return this.transaction(() => {
      const affectedThreads = this.db.prepare("SELECT DISTINCT native_thread_id FROM codex_broker_calls WHERE state='claimed' AND native_thread_id IS NOT NULL")
        .all() as Array<{ native_thread_id: string }>;
      const changed = Number(this.db.prepare("UPDATE codex_broker_calls SET state='ambiguous',safe_result_code=?,native_thread_id=NULL WHERE state='claimed'").run(safeReasonCode).changes);
      for (const affected of affectedThreads) {
        this.db.prepare("UPDATE codex_broker_threads SET state='quarantined' WHERE thread_digest=?").run(sha256Digest(affected.native_thread_id));
        this.db.prepare("UPDATE codex_broker_calls SET native_thread_id=NULL WHERE native_thread_id=?").run(affected.native_thread_id);
      }
      return changed;
    });
  }

  close(permitDigest: string, safeReasonCode: string): { replayed: boolean; ambiguousCalls: number } {
    if (!validCode(safeReasonCode)) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
    return this.transaction(() => {
      const grant = this.db.prepare("SELECT permit_json,limits_json,state,close_reason_code FROM codex_broker_grants WHERE permit_digest=?").get(permitDigest) as GrantRow | undefined;
      if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
      parseStoredGrant(grant,permitDigest,this.endpointIdentityDigest);
      if (grant.state === "closed" && grant.close_reason_code !== safeReasonCode) throw new CodexBrokerPolicyErrorV1("settlement_invalid");
      const replayed = grant.state === "closed";
      if (!replayed) {
        const activeThreads = this.db.prepare("SELECT DISTINCT native_thread_id FROM codex_broker_calls WHERE permit_digest=? AND native_thread_id IS NOT NULL")
          .all(permitDigest) as Array<{ native_thread_id: string }>;
        this.db.prepare("UPDATE codex_broker_grants SET state='closed',close_reason_code=? WHERE permit_digest=?").run(safeReasonCode, permitDigest);
        this.db.prepare("UPDATE codex_broker_calls SET state='ambiguous',safe_result_code=?,native_thread_id=NULL WHERE permit_digest=? AND state='claimed'").run(safeReasonCode, permitDigest);
        this.db.prepare("UPDATE codex_broker_calls SET native_thread_id=NULL WHERE permit_digest=?").run(permitDigest);
        for (const activeThread of activeThreads) {
          this.db.prepare("UPDATE codex_broker_threads SET state='quarantined' WHERE thread_digest=?").run(sha256Digest(activeThread.native_thread_id));
        }
      }
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM codex_broker_calls WHERE permit_digest=? AND state='ambiguous'").get(permitDigest) as { count: number }).count;
      return { replayed, ambiguousCalls: count };
    });
  }

  evidence(permitDigest: string): { state: "active" | "closed"; maximumProviderCalls: number; consumedProviderCalls: number; calls: Array<{ requestIdDigest: string; operation: "start" | "resume"; callNumber: number; state: CallRow["state"]; usage?: CodexBrokerUsageV1; safeResultCode?: string }> } {
    const grant = this.db.prepare("SELECT permit_json,limits_json,state,close_reason_code FROM codex_broker_grants WHERE permit_digest=?").get(permitDigest) as GrantRow | undefined;
    if (!grant) throw new CodexBrokerPolicyErrorV1("grant_invalid");
    this.assertStateAuthTag();
    const {permit}=parseStoredGrant(grant,permitDigest,this.endpointIdentityDigest);
    const rows = this.db.prepare("SELECT request_id,ticket_json,state,usage_json,safe_result_code FROM codex_broker_calls WHERE permit_digest=? ORDER BY rowid").all(permitDigest) as Array<{ request_id: string; ticket_json: string; state: CallRow["state"]; usage_json: string | null; safe_result_code: string | null }>;
    return { state: grant.state, maximumProviderCalls: permit.maximumProviderCalls, consumedProviderCalls: rows.length,
      calls: rows.map((row) => { const ticket = JSON.parse(row.ticket_json) as CodexBrokerDispatchTicketV1; return {
        requestIdDigest: sha256Digest(row.request_id), operation: ticket.operation, callNumber: ticket.callNumber, state: row.state,
        ...(row.usage_json ? { usage: JSON.parse(row.usage_json) as CodexBrokerUsageV1 } : {}), ...(row.safe_result_code ? { safeResultCode: row.safe_result_code } : {}),
      }; }) };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.assertStateAuthTag(); const result = operation(); this.refreshStateAuthTag(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Serializes trusted time with validation, commits the high-water before returning a validation error, then applies writes. */
  private transactionWithTrustedClock<T>(prepare: (trustedNow: string) => () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let operation: () => T;
    try { this.assertStateAuthTag(); operation = prepare(this.trustedNowInTransaction()); }
    catch (error) { this.refreshStateAuthTag(); this.db.exec("COMMIT"); throw error; }
    try { const result = operation(); this.refreshStateAuthTag(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private trustedNowInTransaction(): string {
    const now = this.options.clock?.() ?? new Date().toISOString();
    const parsed = Date.parse(now);
    const row = this.db.prepare("SELECT last_observed_ms FROM codex_broker_clock WHERE singleton=1").get() as { last_observed_ms: number };
    if (!Number.isFinite(parsed) || parsed < row.last_observed_ms) throw new CodexBrokerPolicyErrorV1("grant_expired");
    this.db.prepare("UPDATE codex_broker_clock SET last_observed_ms=? WHERE singleton=1").run(parsed);
    const stored = (this.db.prepare("SELECT last_observed_ms FROM codex_broker_clock WHERE singleton=1").get() as { last_observed_ms: number }).last_observed_ms;
    if (stored !== parsed) throw new CodexBrokerPolicyErrorV1("grant_expired");
    return now;
  }

  private computeStateAuthTag(): string {
    const grants=this.db.prepare("SELECT * FROM codex_broker_grants ORDER BY permit_digest").all();
    const calls=this.db.prepare("SELECT * FROM codex_broker_calls ORDER BY request_id").all();
    const threads=this.db.prepare("SELECT * FROM codex_broker_threads ORDER BY thread_digest").all();
    const clock=this.db.prepare("SELECT singleton,last_observed_ms FROM codex_broker_clock ORDER BY singleton").all();
    return hmacSha256Tag(this.integrityKey,{endpointIdentityDigest:this.endpointIdentityDigest,grants,calls,threads,clock});
  }

  private assertStateAuthTag(): void {
    const row=this.db.prepare("SELECT endpoint_identity_digest,state_auth_tag FROM codex_broker_metadata WHERE singleton=1")
      .get() as {endpoint_identity_digest:string;state_auth_tag:string}|undefined;
    if (!row || row.endpoint_identity_digest!==this.endpointIdentityDigest || row.state_auth_tag!==this.computeStateAuthTag()) {
      throw new CodexBrokerPolicyErrorV1("grant_invalid");
    }
  }

  private refreshStateAuthTag(): void {
    const changed=this.db.prepare("UPDATE codex_broker_metadata SET state_auth_tag=? WHERE singleton=1 AND endpoint_identity_digest=?")
      .run(this.computeStateAuthTag(),this.endpointIdentityDigest).changes;
    if (Number(changed)!==1) throw new CodexBrokerPolicyErrorV1("grant_invalid");
  }
}
