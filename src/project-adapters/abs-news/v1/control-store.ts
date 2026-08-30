import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, parseExactProjectWorkspaceV1, projectWorkspaceSafeIdSchemaV1, projectWorkspaceTimeSchemaV1 } from "../../../project-workspace/v1";
import { parseAbsNewsAutomationDeclarationV1, parseAbsNewsAutomationRunV1, recoverAbsNewsAutomationRunV1 } from "./automation";
import { parseAbsNewsMaterializationReceiptV1, parseAbsNewsProposalReviewV1 } from "./materialization";
import { parseAbsNewsWorkOrderProposalV1 } from "./proposal";
import type { AbsNewsAutomationDeclarationV1, AbsNewsAutomationRunV1, AbsNewsMaterializationReceiptV1, AbsNewsProposalReviewV1 } from "./types";

const VERSION = 1;
const TABLES = ["abs_news_control_metadata", "abs_news_control_records"];
const scopeSchema = z.object({ tenantId: projectWorkspaceSafeIdSchemaV1, workspaceId: projectWorkspaceSafeIdSchemaV1, projectId: projectWorkspaceSafeIdSchemaV1 }).strict();
type Scope = z.infer<typeof scopeSchema>;
type Kind = "review" | "materialization" | "automation" | "run";
type MetadataRow = { tenant_id: string; workspace_id: string; project_id: string; revision: number; record_count: number; state_digest: string; state_auth_tag: string };
type RecordRow = { kind: Kind; record_id: string; record_digest: string; semantic_key: string; version: number; payload: string; record_auth_tag: string; recorded_at: string };

function json(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); } }
function same(left: string, right: string): boolean { return left.length === right.length && left === right; }

export class SqliteAbsNewsControlStoreV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  readonly #scope: Scope;
  #closed = false;

  constructor(path: string, scopeValue: unknown, options: { integrityKey: Uint8Array; mode: "create" | "open" }) {
    this.#scope = parseExactProjectWorkspaceV1(scopeSchema, scopeValue);
    try { hmacSha256Tag(options.integrityKey, { purpose: "abs-news-control-store" }); } catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
    this.#key = new Uint8Array(options.integrityKey);
    this.#db = new DatabaseSync(path);
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (options.mode === "create") {
      if (version !== 0) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      this.createSchema(); this.initialize();
    } else if (version !== VERSION) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    this.verifyIntegrity();
  }

  close(): void { if (!this.#closed) { this.#key.fill(0); this.#db.close(); this.#closed = true; } }

  saveReview(reviewValue: unknown, proposalValue: unknown): { review: AbsNewsProposalReviewV1; replayed: boolean } {
    const review = parseAbsNewsProposalReviewV1(reviewValue), proposal = parseAbsNewsWorkOrderProposalV1(proposalValue);
    this.scope(review);
    if (review.proposalId !== proposal.proposalId || review.proposalDigest !== proposal.proposalDigest || review.storyDigest !== proposal.storyDigest || review.actionCatalogDigest !== proposal.actionCatalogDigest) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    const stored = this.immutable("review", review.reviewId, review.reviewDigest, proposal.proposalId, review.reviewedAt, review);
    return { review: stored.value as AbsNewsProposalReviewV1, replayed: stored.replayed };
  }

  saveMaterialization(receiptValue: unknown): { receipt: AbsNewsMaterializationReceiptV1; replayed: boolean } {
    const receipt = parseAbsNewsMaterializationReceiptV1(receiptValue); this.scope(receipt); this.verifyIntegrity();
    const review = this.findCurrent("review", receipt.proposalId);
    if (!review) throw new ProjectWorkspaceContractErrorV1("not_found");
    const accepted = this.verified(review) as AbsNewsProposalReviewV1;
    if (accepted.decision !== "accepted" || accepted.reviewId !== receipt.acceptedReviewId || accepted.reviewDigest !== receipt.acceptedReviewDigest || accepted.proposalDigest !== receipt.proposalDigest) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    const stored = this.immutable("materialization", receipt.receiptId, receipt.receiptDigest, receipt.proposalId, receipt.materializedAt, receipt);
    return { receipt: stored.value as AbsNewsMaterializationReceiptV1, replayed: stored.replayed };
  }

  saveAutomation(value: unknown): { declaration: AbsNewsAutomationDeclarationV1; replayed: boolean } {
    const declaration = parseAbsNewsAutomationDeclarationV1(value); this.scope(declaration);
    const stored = this.immutable("automation", declaration.automationId, declaration.declarationDigest, declaration.automationId, declaration.schedule.createdAt, declaration);
    return { declaration: stored.value as AbsNewsAutomationDeclarationV1, replayed: stored.replayed };
  }

  saveRun(value: unknown): { run: AbsNewsAutomationRunV1; replayed: boolean } {
    const run = parseAbsNewsAutomationRunV1(value); this.scope(run); this.verifyIntegrity();
    const declarationRow = this.findCurrent("automation", run.automationId);
    if (!declarationRow) throw new ProjectWorkspaceContractErrorV1("not_found");
    const declaration = this.verified(declarationRow) as AbsNewsAutomationDeclarationV1;
    if (run.declarationDigest !== declaration.declarationDigest || run.attemptNumber > declaration.maxAttempts) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    const semanticKey = `${run.automationId}:${run.occurrenceKey}:${run.attemptNumber}`;
    const owner = this.findCurrent("run", semanticKey);
    if (owner && owner.record_id !== run.runId) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    const current = this.currentById("run", run.runId);
    if (current) {
      const known = this.verified(current) as AbsNewsAutomationRunV1;
      if (known.runDigest === run.runDigest) return { run: known, replayed: true };
      const legal = known.state === "pending" && run.state === "running" || known.state === "running" && ["succeeded", "failed", "ambiguous"].includes(run.state);
      if (!legal || known.tenantId !== run.tenantId || known.workspaceId !== run.workspaceId || known.projectId !== run.projectId
        || known.automationId !== run.automationId || known.declarationDigest !== run.declarationDigest
        || known.occurrenceKey !== run.occurrenceKey || known.scheduledFor !== run.scheduledFor
        || known.attemptNumber !== run.attemptNumber || known.createdAt !== run.createdAt
        || Date.parse(run.updatedAt) < Date.parse(known.updatedAt)) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    }
    return this.transaction(() => {
      const version = current ? Number(current.version) + 1 : 1;
      this.insert("run", run.runId, run.runDigest, semanticKey, version, run.updatedAt, run);
      this.advance();
      return { run, replayed: false };
    });
  }

  recoverUnsettled(recoveredAtValue: unknown): AbsNewsAutomationRunV1[] {
    const recoveredAt = projectWorkspaceTimeSchemaV1.parse(recoveredAtValue); this.verifyIntegrity();
    const rows = this.#db.prepare("SELECT r.* FROM abs_news_control_records r JOIN (SELECT record_id,max(version) version FROM abs_news_control_records WHERE kind='run' GROUP BY record_id) c ON c.record_id=r.record_id AND c.version=r.version WHERE r.kind='run' ORDER BY r.record_id").all() as unknown as RecordRow[];
    const recovered: AbsNewsAutomationRunV1[] = [];
    for (const row of rows) {
      const run = this.verified(row) as AbsNewsAutomationRunV1;
      if (run.state !== "running") continue;
      const declarationRow = this.findCurrent("automation", run.automationId);
      if (!declarationRow) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      const next = recoverAbsNewsAutomationRunV1({ declaration: this.verified(declarationRow), run, recoveredAt });
      recovered.push(this.saveRun(next).run);
    }
    return recovered;
  }

  listReviews(): AbsNewsProposalReviewV1[] { return this.list("review") as AbsNewsProposalReviewV1[]; }
  listMaterializations(): AbsNewsMaterializationReceiptV1[] { return this.list("materialization") as AbsNewsMaterializationReceiptV1[]; }
  listAutomations(): AbsNewsAutomationDeclarationV1[] { return this.list("automation") as AbsNewsAutomationDeclarationV1[]; }
  listCurrentRuns(): AbsNewsAutomationRunV1[] { return this.list("run") as AbsNewsAutomationRunV1[]; }

  verifyIntegrity(): { revision: number; recordCount: number; stateDigest: string } {
    this.open(); this.schema();
    const metadata = this.metadata(), state = this.state();
    const tag = hmacSha256Tag(this.#key, this.metadataMaterial(metadata.revision, metadata.record_count, metadata.state_digest));
    if (metadata.tenant_id !== this.#scope.tenantId || metadata.workspace_id !== this.#scope.workspaceId || metadata.project_id !== this.#scope.projectId || metadata.record_count !== state.recordCount || metadata.state_digest !== state.stateDigest || !same(metadata.state_auth_tag, tag)) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return { revision: Number(metadata.revision), recordCount: state.recordCount, stateDigest: state.stateDigest };
  }

  private immutable(kind: Exclude<Kind, "run">, id: string, digest: string, semanticKey: string, recordedAt: string, value: unknown): { value: unknown; replayed: boolean } {
    this.verifyIntegrity(); const existing = this.findCurrent(kind, semanticKey) ?? this.currentById(kind, id);
    if (existing) {
      const known = this.verified(existing);
      if (existing.record_id === id && existing.record_digest === digest) return { value: known, replayed: true };
      throw new ProjectWorkspaceContractErrorV1("replay_drift");
    }
    return this.transaction(() => { this.insert(kind, id, digest, semanticKey, 1, recordedAt, value); this.advance(); return { value, replayed: false }; });
  }

  private insert(kind: Kind, id: string, digest: string, semanticKey: string, version: number, recordedAt: string, value: unknown): void {
    const payload = JSON.stringify(value), tag = hmacSha256Tag(this.#key, { kind, scope: this.#scope, id, digest, semanticKey, version, payloadDigest: sha256Digest(value), recordedAt });
    this.#db.prepare("INSERT INTO abs_news_control_records VALUES(?,?,?,?,?,?,?,?)").run(kind, id, digest, semanticKey, version, payload, tag, recordedAt);
  }

  private verified(row: RecordRow): unknown {
    let value: unknown;
    if (row.kind === "review") value = parseAbsNewsProposalReviewV1(json(row.payload));
    else if (row.kind === "materialization") value = parseAbsNewsMaterializationReceiptV1(json(row.payload));
    else if (row.kind === "automation") value = parseAbsNewsAutomationDeclarationV1(json(row.payload));
    else value = parseAbsNewsAutomationRunV1(json(row.payload));
    this.scope(value as Scope);
    const digest = row.kind === "review" ? (value as AbsNewsProposalReviewV1).reviewDigest : row.kind === "materialization" ? (value as AbsNewsMaterializationReceiptV1).receiptDigest : row.kind === "automation" ? (value as AbsNewsAutomationDeclarationV1).declarationDigest : (value as AbsNewsAutomationRunV1).runDigest;
    const expected = hmacSha256Tag(this.#key, { kind: row.kind, scope: this.#scope, id: row.record_id, digest: row.record_digest, semanticKey: row.semantic_key, version: Number(row.version), payloadDigest: sha256Digest(value), recordedAt: row.recorded_at });
    if (row.record_digest !== digest || !same(row.record_auth_tag, expected)) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return value;
  }

  private list(kind: Kind): unknown[] {
    this.verifyIntegrity();
    const rows = this.#db.prepare("SELECT r.* FROM abs_news_control_records r JOIN (SELECT record_id,max(version) version FROM abs_news_control_records WHERE kind=? GROUP BY record_id) c ON c.record_id=r.record_id AND c.version=r.version WHERE r.kind=? ORDER BY r.recorded_at,r.record_id").all(kind, kind) as unknown as RecordRow[];
    return rows.map((row) => this.verified(row));
  }
  private findCurrent(kind: Kind, semanticKey: string): RecordRow | undefined { return this.#db.prepare("SELECT * FROM abs_news_control_records WHERE kind=? AND semantic_key=? ORDER BY version DESC LIMIT 1").get(kind, semanticKey) as RecordRow | undefined; }
  private currentById(kind: Kind, id: string): RecordRow | undefined { return this.#db.prepare("SELECT * FROM abs_news_control_records WHERE kind=? AND record_id=? ORDER BY version DESC LIMIT 1").get(kind, id) as RecordRow | undefined; }

  private createSchema(): void { this.#db.exec(`BEGIN IMMEDIATE; CREATE TABLE abs_news_control_metadata(tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,record_count INTEGER NOT NULL,state_digest TEXT NOT NULL,state_auth_tag TEXT NOT NULL); CREATE TABLE abs_news_control_records(kind TEXT NOT NULL,record_id TEXT NOT NULL,record_digest TEXT NOT NULL,semantic_key TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(kind,record_id,version),UNIQUE(kind,record_digest)); CREATE INDEX abs_news_control_semantic ON abs_news_control_records(kind,semantic_key,version); PRAGMA user_version=1; COMMIT;`); }
  private initialize(): void { const state = this.state(), revision = 1; this.#db.prepare("INSERT INTO abs_news_control_metadata VALUES(?,?,?,?,?,?,?)").run(this.#scope.tenantId, this.#scope.workspaceId, this.#scope.projectId, revision, state.recordCount, state.stateDigest, hmacSha256Tag(this.#key, this.metadataMaterial(revision, state.recordCount, state.stateDigest))); }
  private state(): { recordCount: number; stateDigest: string } { const rows = this.#db.prepare("SELECT * FROM abs_news_control_records ORDER BY kind,record_id,version").all() as unknown as RecordRow[]; const records = rows.map((row) => { this.verified(row); return { kind: row.kind, id: row.record_id, digest: row.record_digest, semanticKey: row.semantic_key, version: Number(row.version), tag: row.record_auth_tag }; }); return { recordCount: rows.length, stateDigest: sha256Digest({ scope: this.#scope, records }) }; }
  private advance(): void { const meta = this.metadata(), state = this.state(), revision = Number(meta.revision) + 1; const result = this.#db.prepare("UPDATE abs_news_control_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE revision=?").run(revision, state.recordCount, state.stateDigest, hmacSha256Tag(this.#key, this.metadataMaterial(revision, state.recordCount, state.stateDigest)), meta.revision); if (Number(result.changes) !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
  private metadata(): MetadataRow { const rows = this.#db.prepare("SELECT * FROM abs_news_control_metadata").all() as unknown as MetadataRow[]; if (rows.length !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed"); return { ...rows[0]!, revision: Number(rows[0]!.revision), record_count: Number(rows[0]!.record_count) }; }
  private metadataMaterial(revision: number, recordCount: number, stateDigest: string) { return { kind: "metadata", scope: this.#scope, revision, recordCount, stateDigest }; }
  private scope(value: Scope): void { if (value.tenantId !== this.#scope.tenantId || value.workspaceId !== this.#scope.workspaceId || value.projectId !== this.#scope.projectId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch"); }
  private schema(): void { const tables = (this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as { name: string }[]).map((row) => row.name); if (tables.join("|") !== TABLES.join("|")) throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
  private open(): void { if (this.#closed) throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
  private transaction<T>(operation: () => T): T { this.#db.exec("BEGIN IMMEDIATE"); try { const result = operation(); this.#db.exec("COMMIT"); return result; } catch (error) { try { this.#db.exec("ROLLBACK"); } catch { /* preserve original */ } throw error; } }
}
