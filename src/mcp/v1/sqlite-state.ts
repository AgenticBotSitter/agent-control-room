import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSafeProjection } from "../../contracts/v1/validators";
import { assertNoSecretMaterial, canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import { digestControlRoomMcpProposalRecordV1 } from "./proposal-store";
import { controlRoomMcpProposalRecordSchemaV1 } from "./schemas";
import type {
  ControlRoomMcpProposalReceiptV1,
  ControlRoomMcpProposalRecordV1,
  ControlRoomMcpProposalStoreV1,
  ControlRoomMcpReplayBindingV1,
  ControlRoomMcpReplayLedgerV1,
  ControlRoomMcpToolResultV1,
} from "./types";

function preparePrivatePath(path: string, allowEphemeral: boolean): void {
  if (path === ":memory:") {
    if (!allowEphemeral) throw new Error("MCP durable state path invalid");
    return;
  }
  if (!isAbsolute(path) || !process.getuid) throw new Error("MCP durable state path invalid");
  const uid = process.getuid(); const parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) throw new Error("MCP durable state path invalid");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || existing.nlink !== 1 || (existing.mode & 0o077) !== 0) {
      throw new Error("MCP durable state path invalid");
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    closeSync(openSync(path, "wx", 0o600));
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s*([(),=])\s*/g, "$1").trim();
}

const expectedSql = new Map([
  ["mcp_proposals", `CREATE TABLE mcp_proposals (
    proposal_key TEXT PRIMARY KEY CHECK(length(proposal_key)=71), tenant_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK(length(request_digest)=71), record_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected')), decision_code TEXT, decided_at TEXT,
    UNIQUE(tenant_id,proposal_id), CHECK((state='pending' AND decision_code IS NULL AND decided_at IS NULL)
      OR (state IN ('accepted','rejected') AND decision_code IS NOT NULL AND decided_at IS NOT NULL))
  )`],
  ["mcp_proposals_pending", "CREATE INDEX mcp_proposals_pending ON mcp_proposals(tenant_id,state,proposal_id)"],
  ["mcp_replay", `CREATE TABLE mcp_replay (
    replay_key TEXT PRIMARY KEY CHECK(length(replay_key)=71), request_digest TEXT NOT NULL CHECK(length(request_digest)=71),
    tool_name TEXT NOT NULL, tenant_id TEXT NOT NULL, project_scope_digest TEXT NOT NULL CHECK(length(project_scope_digest)=71),
    grant_body_digest TEXT NOT NULL CHECK(length(grant_body_digest)=71),
    state TEXT NOT NULL CHECK(state IN ('in_progress','complete')), result_json TEXT, result_digest TEXT,
    CHECK((state='in_progress' AND result_json IS NULL AND result_digest IS NULL)
      OR (state='complete' AND result_json IS NOT NULL AND result_digest IS NOT NULL AND length(result_digest)=71))
  )`],
  ["mcp_metadata", "CREATE TABLE mcp_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), state_auth_tag TEXT NOT NULL)"],
]);

function assertSchema(db: DatabaseSync): void {
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const actual = rows.map((row) => `${row.type}:${row.name}`);
  const expected = ["index:mcp_proposals_pending", "table:mcp_metadata", "table:mcp_proposals", "table:mcp_replay"];
  if (JSON.stringify(actual) !== JSON.stringify(expected) || rows.some((row) => typeof row.sql !== "string"
    || !expectedSql.has(row.name) || normalizeSql(row.sql) !== normalizeSql(expectedSql.get(row.name)!))) {
    throw new Error("MCP durable state schema invalid");
  }
  const columns = Object.fromEntries(["mcp_metadata","mcp_proposals", "mcp_replay"].map((table) => [table,
    db.prepare(`PRAGMA table_info(${table})`).all()]));
  const shape = JSON.stringify(columns, (_key, value) => typeof value === "bigint" ? Number(value) : value);
  const expectedNames = {
    mcp_metadata:["singleton","state_auth_tag"],
    mcp_proposals: ["proposal_key", "tenant_id", "proposal_id", "request_digest", "record_json", "receipt_json", "state", "decision_code", "decided_at"],
    mcp_replay: ["replay_key", "request_digest", "tool_name", "tenant_id", "project_scope_digest", "grant_body_digest", "state", "result_json", "result_digest"],
  };
  for (const [table, names] of Object.entries(expectedNames)) {
    const info = columns[table] as Array<{ name: string }>;
    if (info.map((column) => column.name).join("|") !== names.join("|")) throw new Error("MCP durable state columns invalid");
  }
  void shape;
}

type ProposalRow = { proposal_key:string;tenant_id:string;proposal_id:string;request_digest: string; receipt_json: string; record_json: string;
  state: "pending" | "accepted" | "rejected";decision_code:string|null;decided_at:string|null };

function parseProposalRow(row: ProposalRow): { record: ControlRoomMcpProposalRecordV1; receipt: ControlRoomMcpProposalReceiptV1 } {
  let record: ControlRoomMcpProposalRecordV1; let receipt: ControlRoomMcpProposalReceiptV1;
  try { record = controlRoomMcpProposalRecordSchemaV1.parse(JSON.parse(row.record_json)) as ControlRoomMcpProposalRecordV1; receipt = JSON.parse(row.receipt_json) as ControlRoomMcpProposalReceiptV1; }
  catch { throw new Error("MCP proposal state invalid"); }
  const expectedReceipt: ControlRoomMcpProposalReceiptV1 = { receiptId: `receipt:${row.request_digest.slice(7,39)}`,
    requestKind: record.kind, requestDigest: row.request_digest, state: "recorded", grantsAuthority: false, dispatchCreated: false, replayed: false };
  if (digestControlRoomMcpProposalRecordV1(record) !== row.request_digest || canonicalJson(receipt) !== canonicalJson(expectedReceipt)
    || row.proposal_key!==sha256Digest({tenantId:record.tenantId,idempotencyKey:record.idempotencyKey}) || row.tenant_id!==record.tenantId
    || row.proposal_id!==record.proposalId || (row.state==="pending"?(row.decision_code!==null || row.decided_at!==null)
      : (!row.decision_code || !row.decided_at || Date.parse(row.decided_at)<Date.parse(record.requestedAt)))) {
    throw new Error("MCP proposal state invalid");
  }
  assertNoSecretMaterial({record,receipt},"MCP proposal state");
  return { record, receipt };
}

function assertStoredToolResult(result: ControlRoomMcpToolResultV1): void {
  try {
    const keys=Object.keys(result).sort(); const expected=(result as {isError?:unknown}).isError===undefined ? ["content","structuredContent"] : ["content","isError","structuredContent"];
    if (JSON.stringify(keys)!==JSON.stringify(expected) || !Array.isArray(result.content) || result.content.length!==1
      || !result.structuredContent || typeof result.structuredContent!=="object" || Array.isArray(result.structuredContent)
      || Object.keys(result.content[0] ?? {}).sort().join("|")!=="text|type" || result.content[0]?.type!=="text"
      || result.content[0]?.text!==canonicalJson(result.structuredContent) || (result.isError!==undefined && result.isError!==true)) throw new Error("invalid");
    assertSafeProjection(result.structuredContent); assertNoSecretMaterial(result,"MCP replay state");
  } catch { throw new Error("MCP replay state invalid"); }
}

/** Durable, private MCP replay and proposal state. It cannot create canonical jobs, approvals, leases, dispatches, or effects. */
export class SqliteControlRoomMcpStateV1 implements ControlRoomMcpReplayLedgerV1, ControlRoomMcpProposalStoreV1 {
  private readonly db: DatabaseSync;
  private readonly integrityKey:Uint8Array;

  constructor(path: string, private readonly maximumEntries = 100_000, options: { testOnlyAllowEphemeral?: boolean;integrityKey?:Uint8Array } = {}) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 1_000_000) {
      throw new Error("MCP durable state configuration invalid");
    }
    try { hmacSha256Tag(options.integrityKey??new Uint8Array(),{purpose:"mcp-state-key-check"}); }
    catch { throw new Error("MCP durable state configuration invalid"); }
    this.integrityKey=options.integrityKey!;
    preparePrivatePath(path, options.testOnlyAllowEphemeral === true);
    this.db = new DatabaseSync(path);
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number | bigint }).user_version);
    if (version !== 0 && version !== 2) { this.db.close(); throw new Error("MCP durable state schema unsupported"); }
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    if (version === 0) {
      this.db.exec(`BEGIN IMMEDIATE; ${expectedSql.get("mcp_metadata")}; ${expectedSql.get("mcp_replay")}; ${expectedSql.get("mcp_proposals")};
        ${expectedSql.get("mcp_proposals_pending")}; PRAGMA user_version=2; COMMIT;`);
    }
    try {
      assertSchema(this.db);
      const metadata=this.db.prepare("SELECT state_auth_tag FROM mcp_metadata WHERE singleton=1").get() as {state_auth_tag:string}|undefined;
      if (!metadata) {
        if (version!==0 || this.count("mcp_replay")!==0 || this.count("mcp_proposals")!==0) throw new Error("MCP durable state integrity invalid");
        this.db.prepare("INSERT INTO mcp_metadata(singleton,state_auth_tag) VALUES(1,?)").run(this.computeStateAuthTag());
      } else this.assertStateAuthTag();
      this.transaction(() => { this.db.prepare("DELETE FROM mcp_replay WHERE state='in_progress'").run(); });
    } catch (error) { this.db.close(); throw error; }
  }

  claim(input: { replayKey: string; requestDigest: string;binding:ControlRoomMcpReplayBindingV1 }) {
    this.assertDigest(input.replayKey); this.assertDigest(input.requestDigest);
    this.assertBinding(input.binding);
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT request_digest,tool_name,tenant_id,project_scope_digest,grant_body_digest,state,result_json,result_digest FROM mcp_replay WHERE replay_key=?").get(input.replayKey) as
        { request_digest: string;tool_name:string;tenant_id:string;project_scope_digest:string;grant_body_digest:string; state: "in_progress" | "complete"; result_json: string | null; result_digest: string | null } | undefined;
      if (prior) {
        if (prior.request_digest !== input.requestDigest || prior.tool_name!==input.binding.toolName || prior.tenant_id!==input.binding.tenantId
          || prior.project_scope_digest!==input.binding.projectScopeDigest || prior.grant_body_digest!==input.binding.grantBodyDigest) throw new Error("MCP replay conflict");
        if (prior.state === "in_progress") return { disposition: "in_progress" as const };
        if (!prior.result_json || !prior.result_digest) throw new Error("MCP replay state invalid");
        let result: ControlRoomMcpToolResultV1;
        try { result = JSON.parse(prior.result_json) as ControlRoomMcpToolResultV1; } catch { throw new Error("MCP replay state invalid"); }
        if (sha256Digest(result) !== prior.result_digest) throw new Error("MCP replay state invalid");
        assertStoredToolResult(result);
        return { disposition: "replay" as const, result };
      }
      if (this.count("mcp_replay") >= this.maximumEntries) throw new Error("MCP replay capacity exhausted");
      this.db.prepare("INSERT INTO mcp_replay(replay_key,request_digest,tool_name,tenant_id,project_scope_digest,grant_body_digest,state) VALUES (?,?,?,?,?,?,'in_progress')")
        .run(input.replayKey,input.requestDigest,input.binding.toolName,input.binding.tenantId,input.binding.projectScopeDigest,input.binding.grantBodyDigest);
      return { disposition: "execute" as const };
    });
  }

  complete(input: { replayKey: string; requestDigest: string; result: ControlRoomMcpToolResultV1 }): void {
    this.assertDigest(input.replayKey); this.assertDigest(input.requestDigest); assertStoredToolResult(input.result); assertNoSecretMaterial(input.result, "MCP replay result");
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE mcp_replay SET state='complete',result_json=?,result_digest=? WHERE replay_key=? AND request_digest=? AND state='in_progress'")
        .run(canonicalJson(input.result),sha256Digest(input.result),input.replayKey,input.requestDigest).changes;
      if (Number(changed) !== 1) throw new Error("MCP replay settlement invalid");
    });
  }

  fail(input: { replayKey: string; requestDigest: string }): void {
    this.assertDigest(input.replayKey); this.assertDigest(input.requestDigest);
    this.transaction(() => {
      const changed = this.db.prepare("DELETE FROM mcp_replay WHERE replay_key=? AND request_digest=? AND state='in_progress'")
        .run(input.replayKey,input.requestDigest).changes;
      if (Number(changed) !== 1) throw new Error("MCP replay settlement invalid");
    });
  }

  record(input: ControlRoomMcpProposalRecordV1): ControlRoomMcpProposalReceiptV1 {
    const parsed=controlRoomMcpProposalRecordSchemaV1.parse(input) as ControlRoomMcpProposalRecordV1;
    assertNoSecretMaterial(parsed, "MCP proposal"); input=parsed;
    const proposalKey = sha256Digest({ tenantId: input.tenantId, idempotencyKey: input.idempotencyKey });
    const requestDigest = digestControlRoomMcpProposalRecordV1(input);
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT proposal_key,tenant_id,proposal_id,request_digest,receipt_json,record_json,state,decision_code,decided_at FROM mcp_proposals WHERE proposal_key=? OR (tenant_id=? AND proposal_id=?)")
        .get(proposalKey,input.tenantId,input.proposalId) as ProposalRow | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new Error("MCP proposal replay conflict");
        const { receipt } = parseProposalRow(prior);
        return { ...receipt, replayed: true };
      }
      if (this.count("mcp_proposals") >= this.maximumEntries) throw new Error("MCP proposal capacity exhausted");
      const receipt: ControlRoomMcpProposalReceiptV1 = { receiptId: `receipt:${requestDigest.slice(7,39)}`, requestKind: input.kind,
        requestDigest, state: "recorded", grantsAuthority: false, dispatchCreated: false, replayed: false };
      this.db.prepare(`INSERT INTO mcp_proposals(proposal_key,tenant_id,proposal_id,request_digest,record_json,receipt_json,state)
        VALUES (?,?,?,?,?,?,'pending')`).run(proposalKey,input.tenantId,input.proposalId,requestDigest,canonicalJson(input),canonicalJson(receipt));
      return receipt;
    });
  }

  listPending(input: { tenantId: string; limit: number }): ControlRoomMcpProposalRecordV1[] {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(input.tenantId) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("MCP proposal query invalid");
    }
    this.assertStateAuthTag();
    return (this.db.prepare("SELECT proposal_key,tenant_id,proposal_id,request_digest,receipt_json,record_json,state,decision_code,decided_at FROM mcp_proposals WHERE tenant_id=? AND state='pending' ORDER BY proposal_id LIMIT ?")
      .all(input.tenantId,input.limit) as ProposalRow[]).map((row) => parseProposalRow(row).record);
  }

  decide(input: { tenantId: string; proposalId: string; requestDigest: string; decision: "accepted" | "rejected"; decisionCode: string; decidedAt: string }): { replayed: boolean } {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(input.tenantId) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(input.proposalId)
      || !/^[a-z][a-z0-9_]{2,63}$/.test(input.decisionCode) || new Date(Date.parse(input.decidedAt)).toISOString() !== input.decidedAt) {
      throw new Error("MCP proposal decision invalid");
    }
    this.assertDigest(input.requestDigest);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT proposal_key,tenant_id,proposal_id,request_digest,receipt_json,record_json,state,decision_code,decided_at FROM mcp_proposals WHERE tenant_id=? AND proposal_id=?")
        .get(input.tenantId,input.proposalId) as ProposalRow | undefined;
      if (!row || row.request_digest !== input.requestDigest) throw new Error("MCP proposal decision mismatch");
      const stored=parseProposalRow(row);
      if (Date.parse(input.decidedAt)<Date.parse(stored.record.requestedAt)) throw new Error("MCP proposal decision invalid");
      if (row.state !== "pending") {
        if (row.state !== input.decision || row.decision_code !== input.decisionCode || row.decided_at !== input.decidedAt) throw new Error("MCP proposal decision conflict");
        return { replayed: true };
      }
      this.db.prepare("UPDATE mcp_proposals SET state=?,decision_code=?,decided_at=? WHERE tenant_id=? AND proposal_id=? AND state='pending'")
        .run(input.decision,input.decisionCode,input.decidedAt,input.tenantId,input.proposalId);
      return { replayed: false };
    });
  }

  evidence(): { replayEntries: number; pendingProposals: number; acceptedProposals: number; rejectedProposals: number; authorityGrants: 0; dispatches: 0 } {
    this.assertStateAuthTag();
    const stateCount = (state: string) => Number((this.db.prepare("SELECT COUNT(*) AS count FROM mcp_proposals WHERE state=?").get(state) as { count: number | bigint }).count);
    return { replayEntries: this.count("mcp_replay"), pendingProposals: stateCount("pending"), acceptedProposals: stateCount("accepted"),
      rejectedProposals: stateCount("rejected"), authorityGrants: 0, dispatches: 0 };
  }

  close(): void { this.assertStateAuthTag(); this.db.close(); }

  private count(table: "mcp_replay" | "mcp_proposals"): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint }).count);
  }

  private assertDigest(value: string): void {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("MCP durable state digest invalid");
  }

  private assertBinding(binding:ControlRoomMcpReplayBindingV1):void {
    if (!binding || typeof binding!=="object" || Object.keys(binding).sort().join("|")!=="grantBodyDigest|projectScopeDigest|tenantId|toolName"
      || !/^control_room\.(?:portfolio|fleet|work|attention|request|job|artifact)\.read$|^control_room\.(?:job|delegation)\.propose$|^control_room\.approval\.request$/.test(binding.toolName)
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(binding.tenantId)) throw new Error("MCP replay binding invalid");
    this.assertDigest(binding.projectScopeDigest); this.assertDigest(binding.grantBodyDigest);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.assertStateAuthTag(); const result = operation(); this.refreshStateAuthTag(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private computeStateAuthTag():string {
    const replay=this.db.prepare("SELECT * FROM mcp_replay ORDER BY replay_key").all();
    const proposals=this.db.prepare("SELECT * FROM mcp_proposals ORDER BY proposal_key").all();
    return hmacSha256Tag(this.integrityKey,{replay,proposals});
  }

  private assertStateAuthTag():void {
    const row=this.db.prepare("SELECT state_auth_tag FROM mcp_metadata WHERE singleton=1").get() as {state_auth_tag:string}|undefined;
    if (!row || row.state_auth_tag!==this.computeStateAuthTag()) throw new Error("MCP durable state integrity invalid");
  }

  private refreshStateAuthTag():void {
    const changed=this.db.prepare("UPDATE mcp_metadata SET state_auth_tag=? WHERE singleton=1").run(this.computeStateAuthTag()).changes;
    if (Number(changed)!==1) throw new Error("MCP durable state integrity invalid");
  }
}
