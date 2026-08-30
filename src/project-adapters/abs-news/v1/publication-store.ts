import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  consequentialApprovalDecisionSchemaV1,
  consequentialApprovalRequestSchemaV1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../../../completion-gate/v1";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceSafeIdSchemaV1,
  projectWorkspaceTimeSchemaV1,
} from "../../../project-workspace/v1";
import {
  buildAbsNewsPublicationClaimV1,
  buildAbsNewsPublicationCleanupReceiptV1,
  buildAbsNewsPublicationMarkerV1,
  buildAbsNewsPublicationOutcomeV1,
  parseAbsNewsPublicationAuthorizationV1,
  parseAbsNewsPublicationClaimV1,
  parseAbsNewsPublicationCleanupReceiptV1,
  parseAbsNewsPublicationDestinationV1,
  parseAbsNewsPublicationMarkerV1,
  parseAbsNewsPublicationOutcomeV1,
  parseAbsNewsPublicationPackageV1,
  parseAbsNewsPublicationRequestV1,
  transitionAbsNewsPublicationClaimV1,
  type AbsNewsPublicationAuthorizationV1,
  type AbsNewsPublicationClaimV1,
  type AbsNewsPublicationCleanupReceiptV1,
  type AbsNewsPublicationDestinationV1,
  type AbsNewsPublicationMarkerV1,
  type AbsNewsPublicationOutcomeV1,
  type AbsNewsPublicationPackageV1,
  type AbsNewsPublicationRequestV1,
} from "./publication";

const scopeSchema = z.object({ tenantId: projectWorkspaceSafeIdSchemaV1, workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1 }).strict();
const registerSchema = z.object({ publicationPackage: z.unknown(), destination: z.unknown(), request: z.unknown(),
  authorization: z.unknown(), approvalRequest: z.unknown(), approvalDecision: z.unknown() }).strict();
type Scope = z.infer<typeof scopeSchema>;
type Kind = "package" | "destination" | "request" | "authorization" | "approval_request" | "approval_decision"
  | "claim" | "marker" | "cleanup" | "outcome";
type Row = { kind: Kind; record_id: string; record_digest: string; semantic_key: string; version: number; payload: string;
  record_auth_tag: string; recorded_at: string };
type Meta = { tenant_id: string; workspace_id: string; project_id: string; revision: number; record_count: number;
  state_digest: string; state_auth_tag: string };
const TABLES = ["abs_news_publication_metadata", "abs_news_publication_records"];
const SCHEMA_OBJECTS = ["index:abs_news_publication_semantic", "table:abs_news_publication_metadata",
  "table:abs_news_publication_records"];

function snapshot<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}
function json(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
}

export interface AbsNewsPublicationBundleV1 {
  publicationPackage: AbsNewsPublicationPackageV1;
  destination: AbsNewsPublicationDestinationV1;
  request: AbsNewsPublicationRequestV1;
  authorization: AbsNewsPublicationAuthorizationV1;
  approvalRequest: ConsequentialApprovalRequestV1;
  approvalDecision: ConsequentialApprovalDecisionV1;
}
export type AbsNewsPublicationClaimResultV1 = { disposition: "run_permitted"; claim: AbsNewsPublicationClaimV1; created: boolean }
  | { disposition: "in_progress"; claim: AbsNewsPublicationClaimV1 }
  | { disposition: "replay"; claim: AbsNewsPublicationClaimV1; outcome: AbsNewsPublicationOutcomeV1;
    cleanup: AbsNewsPublicationCleanupReceiptV1 };

export class SqliteAbsNewsPublicationStoreV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  readonly #scope: Scope;
  #closed = false;

  constructor(path: string, scopeValue: unknown, options: { integrityKey: Uint8Array; mode: "create" | "open" }) {
    this.#scope = snapshot(scopeSchema, scopeValue);
    try { hmacSha256Tag(options.integrityKey, { purpose: "abs-news-publication-ledger" }); }
    catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
    this.#key = new Uint8Array(options.integrityKey);
    this.#db = new DatabaseSync(path);
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (options.mode === "create") {
      if (version !== 0) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      this.createSchema();
      this.initialize();
    } else if (version !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    else this.verifyIntegrity();
  }

  close(): void {
    if (!this.#closed) { this.#key.fill(0); this.#db.close(); this.#closed = true; }
  }

  register(inputValue: unknown): { bundle: AbsNewsPublicationBundleV1; replayed: boolean } {
    const input = snapshot(registerSchema, inputValue), publicationPackage = parseAbsNewsPublicationPackageV1(input.publicationPackage),
      destination = parseAbsNewsPublicationDestinationV1(input.destination), request = parseAbsNewsPublicationRequestV1(input.request),
      authorization = parseAbsNewsPublicationAuthorizationV1(input.authorization);
    let approvalRequest: ConsequentialApprovalRequestV1, approvalDecision: ConsequentialApprovalDecisionV1;
    try {
      approvalRequest = consequentialApprovalRequestSchemaV1.parse(input.approvalRequest) as ConsequentialApprovalRequestV1;
      approvalDecision = consequentialApprovalDecisionSchemaV1.parse(input.approvalDecision) as ConsequentialApprovalDecisionV1;
    } catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
    for (const value of [publicationPackage, destination, request, authorization]) this.scope(value);
    if (request.packageDigest !== publicationPackage.packageDigest || request.destinationIdentityDigest !== destination.destinationIdentityDigest
      || authorization.requestDigest !== request.requestDigest || authorization.packageDigest !== publicationPackage.packageDigest
      || authorization.destinationIdentityDigest !== destination.destinationIdentityDigest
      || authorization.approvalRequestDigest !== sha256Digest(approvalRequest)
      || authorization.approvalDecisionDigest !== sha256Digest(approvalDecision)
      || approvalDecision.requestDigest !== sha256Digest(approvalRequest)) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    this.verifyIntegrity();
    return this.transaction(() => {
      const replayed = [
        this.immutable("package", publicationPackage.packageId, publicationPackage.packageDigest, publicationPackage.packageId,
          publicationPackage.preparedAt, publicationPackage),
        this.immutable("destination", destination.destinationId, destination.destinationDigest, destination.destinationId,
          request.requestedAt, destination),
        this.immutable("request", request.requestId, request.requestDigest, request.destinationIdempotencyKey, request.requestedAt, request),
        this.immutable("approval_request", approvalRequest.id, sha256Digest(approvalRequest), request.requestDigest,
          approvalRequest.requestedAt, approvalRequest),
        this.immutable("approval_decision", approvalDecision.id, sha256Digest(approvalDecision), request.requestDigest,
          approvalDecision.decidedAt, approvalDecision),
        this.immutable("authorization", authorization.authorizationId, authorization.authorizationDigest, request.requestDigest,
          authorization.authorizedAt, authorization),
      ].every(Boolean);
      if (!replayed) this.advance();
      return { bundle: { publicationPackage, destination, request, authorization, approvalRequest, approvalDecision }, replayed };
    });
  }

  loadBundle(requestId: string): AbsNewsPublicationBundleV1 {
    this.verifyIntegrity();
    const requestRow = this.current("request", requestId);
    if (!requestRow) throw new ProjectWorkspaceContractErrorV1("not_found");
    const request = this.verified(requestRow) as AbsNewsPublicationRequestV1;
    const packageRow = this.current("package", request.packageId), destinationRow = this.current("destination", request.destinationId),
      authorizationRow = this.bySemantic("authorization", request.requestDigest),
      approvalRequestRow = this.bySemantic("approval_request", request.requestDigest),
      approvalDecisionRow = this.bySemantic("approval_decision", request.requestDigest);
    if (!packageRow || !destinationRow || !authorizationRow || !approvalRequestRow || !approvalDecisionRow) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    return { publicationPackage: this.verified(packageRow) as AbsNewsPublicationPackageV1,
      destination: this.verified(destinationRow) as AbsNewsPublicationDestinationV1, request,
      authorization: this.verified(authorizationRow) as AbsNewsPublicationAuthorizationV1,
      approvalRequest: this.verified(approvalRequestRow) as ConsequentialApprovalRequestV1,
      approvalDecision: this.verified(approvalDecisionRow) as ConsequentialApprovalDecisionV1 };
  }

  claim(input: { request: unknown; authorization: unknown; claimedAt: string }): AbsNewsPublicationClaimResultV1 {
    const request = parseAbsNewsPublicationRequestV1(input.request), authorization = parseAbsNewsPublicationAuthorizationV1(input.authorization);
    this.scope(request); this.scope(authorization); this.verifyIntegrity();
    const claimedAt = projectWorkspaceTimeSchemaV1.parse(input.claimedAt);
    return this.transaction(() => {
      const current = this.bySemantic("claim", request.destinationIdempotencyKey);
      if (current) {
        const claim = this.verified(current) as AbsNewsPublicationClaimV1;
        const expectedClaimKey = sha256Digest({ operationDigest: request.operationDigest,
          destinationIdempotencyKey: request.destinationIdempotencyKey });
        if (claim.claimKey !== expectedClaimKey || claim.requestDigest !== request.requestDigest
          || claim.authorizationDigest !== authorization.authorizationDigest) throw new ProjectWorkspaceContractErrorV1("replay_drift");
        if (["succeeded", "definite_failure", "ambiguous"].includes(claim.state)) {
          const outcome = this.bySemantic("outcome", claim.claimKey), cleanup = this.bySemantic("cleanup", claim.claimKey);
          if (!outcome || !cleanup) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
          return { disposition: "replay", claim, outcome: this.verified(outcome) as AbsNewsPublicationOutcomeV1,
            cleanup: this.verified(cleanup) as AbsNewsPublicationCleanupReceiptV1 };
        }
        if (claim.state === "claimed") return { disposition: "run_permitted", claim, created: false };
        return { disposition: "in_progress", claim };
      }
      const proposed = buildAbsNewsPublicationClaimV1({ request, authorization, claimedAt });
      this.insert("claim", proposed.claimId, proposed.claimDigest, proposed.destinationIdempotencyKey, proposed.version,
        proposed.updatedAt, proposed);
      this.advance();
      return { disposition: "run_permitted", claim: proposed, created: true };
    });
  }

  mark(claimValue: unknown, markedAtValue: unknown): { claim: AbsNewsPublicationClaimV1; marker: AbsNewsPublicationMarkerV1; replayed: boolean } {
    const claim = parseAbsNewsPublicationClaimV1(claimValue), markedAt = projectWorkspaceTimeSchemaV1.parse(markedAtValue);
    this.scope(claim); this.verifyIntegrity();
    return this.transaction(() => {
      const row = this.bySemantic("claim", claim.destinationIdempotencyKey);
      if (!row) throw new ProjectWorkspaceContractErrorV1("not_found");
      const current = this.verified(row) as AbsNewsPublicationClaimV1;
      if (current.claimKey !== claim.claimKey) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      if (current.state === "executing") {
        const markerRow = this.bySemantic("marker", current.claimKey);
        if (!markerRow) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
        return { claim: current, marker: this.verified(markerRow) as AbsNewsPublicationMarkerV1, replayed: true };
      }
      if (current.state !== "claimed" || current.claimDigest !== claim.claimDigest) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
      const marker = buildAbsNewsPublicationMarkerV1({ claim: current, markedAt }), next = transitionAbsNewsPublicationClaimV1({
        claim: current, toState: "executing", updatedAt: markedAt, markerDigest: marker.markerDigest });
      this.insert("marker", marker.markerId, marker.markerDigest, current.claimKey, 1, markedAt, marker);
      this.insert("claim", next.claimId, next.claimDigest, next.destinationIdempotencyKey, next.version, next.updatedAt, next);
      this.advance();
      return { claim: next, marker, replayed: false };
    });
  }

  settle(input: { claim: unknown; authorization: unknown; disposition: AbsNewsPublicationOutcomeV1["disposition"];
    destinationResultDigest?: string; destinationReceiptDigest?: string; safeReasonCode: AbsNewsPublicationOutcomeV1["safeReasonCode"];
    startedAt: string; settledAt: string }): { claim: AbsNewsPublicationClaimV1; outcome: AbsNewsPublicationOutcomeV1;
      cleanup: AbsNewsPublicationCleanupReceiptV1; replayed: boolean } {
    const supplied = parseAbsNewsPublicationClaimV1(input.claim), authorization = parseAbsNewsPublicationAuthorizationV1(input.authorization);
    this.scope(supplied); this.verifyIntegrity();
    return this.transaction(() => {
      const row = this.bySemantic("claim", supplied.destinationIdempotencyKey);
      if (!row) throw new ProjectWorkspaceContractErrorV1("not_found");
      const current = this.verified(row) as AbsNewsPublicationClaimV1;
      if (["succeeded", "definite_failure", "ambiguous"].includes(current.state)) {
        const outcomeRow = this.bySemantic("outcome", current.claimKey), cleanupRow = this.bySemantic("cleanup", current.claimKey);
        if (!outcomeRow || !cleanupRow) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
        return { claim: current, outcome: this.verified(outcomeRow) as AbsNewsPublicationOutcomeV1,
          cleanup: this.verified(cleanupRow) as AbsNewsPublicationCleanupReceiptV1, replayed: true };
      }
      if (current.state !== "executing" || current.claimKey !== supplied.claimKey
        || current.authorizationDigest !== authorization.authorizationDigest) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
      const cleanup = buildAbsNewsPublicationCleanupReceiptV1({ claimKey: current.claimKey, requestDigest: current.requestDigest,
        cleanedAt: input.settledAt }), outcome = buildAbsNewsPublicationOutcomeV1({ ...input, claim: current, authorization, cleanup }),
        next = transitionAbsNewsPublicationClaimV1({ claim: current, toState: input.disposition, updatedAt: input.settledAt,
          outcomeDigest: outcome.outcomeDigest });
      this.insert("cleanup", cleanup.cleanupId, cleanup.cleanupDigest, current.claimKey, 1, cleanup.cleanedAt, cleanup);
      this.insert("outcome", outcome.outcomeId, outcome.outcomeDigest, current.claimKey, 1, outcome.settledAt, outcome);
      this.insert("claim", next.claimId, next.claimDigest, next.destinationIdempotencyKey, next.version, next.updatedAt, next);
      this.advance();
      return { claim: next, outcome, cleanup, replayed: false };
    });
  }

  recoverUnsettled(recoveredAtValue: unknown): AbsNewsPublicationOutcomeV1[] {
    const recoveredAt = projectWorkspaceTimeSchemaV1.parse(recoveredAtValue);
    this.verifyIntegrity();
    const outcomes: AbsNewsPublicationOutcomeV1[] = [];
    for (const row of this.currentRows("claim")) {
      const claim = this.verified(row) as AbsNewsPublicationClaimV1;
      if (claim.state !== "executing") continue;
      const authorizationRow = this.bySemantic("authorization", claim.requestDigest);
      if (!authorizationRow) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      outcomes.push(this.settle({ claim, authorization: this.verified(authorizationRow), disposition: "ambiguous",
        safeReasonCode: "restart_after_marker", startedAt: claim.updatedAt, settledAt: recoveredAt }).outcome);
    }
    return outcomes;
  }

  verifyIntegrity(): { revision: number; recordCount: number; stateDigest: string } {
    this.open(); this.schema();
    const meta = this.meta(), state = this.state(), tag = hmacSha256Tag(this.#key,
      this.metaMaterial(Number(meta.revision), Number(meta.record_count), meta.state_digest));
    if (meta.tenant_id !== this.#scope.tenantId || meta.workspace_id !== this.#scope.workspaceId
      || meta.project_id !== this.#scope.projectId || Number(meta.record_count) !== state.recordCount
      || meta.state_digest !== state.stateDigest || meta.state_auth_tag !== tag) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return { revision: Number(meta.revision), recordCount: state.recordCount, stateDigest: state.stateDigest };
  }

  private immutable(kind: Kind, idValue: string, digestValue: string, semantic: string, recordedAt: string, value: unknown): boolean {
    const current = this.bySemantic(kind, semantic) ?? this.current(kind, idValue);
    if (current) {
      if (current.record_id === idValue && current.record_digest === digestValue) { this.verified(current); return true; }
      throw new ProjectWorkspaceContractErrorV1("replay_drift");
    }
    this.insert(kind, idValue, digestValue, semantic, 1, recordedAt, value);
    return false;
  }
  private insert(kind: Kind, idValue: string, digestValue: string, semantic: string, version: number, recordedAt: string, value: unknown): void {
    const payload = JSON.stringify(value), tag = hmacSha256Tag(this.#key, { kind, scope: this.#scope, id: idValue,
      digest: digestValue, semantic, version, payloadDigest: sha256Digest(value), recordedAt });
    this.#db.prepare("INSERT INTO abs_news_publication_records VALUES(?,?,?,?,?,?,?,?)")
      .run(kind, idValue, digestValue, semantic, version, payload, tag, recordedAt);
  }
  private verified(row: Row): unknown {
    let value: unknown, digestValue: string;
    if (row.kind === "package") { value = parseAbsNewsPublicationPackageV1(json(row.payload)); digestValue = (value as AbsNewsPublicationPackageV1).packageDigest; }
    else if (row.kind === "destination") { value = parseAbsNewsPublicationDestinationV1(json(row.payload)); digestValue = (value as AbsNewsPublicationDestinationV1).destinationDigest; }
    else if (row.kind === "request") { value = parseAbsNewsPublicationRequestV1(json(row.payload)); digestValue = (value as AbsNewsPublicationRequestV1).requestDigest; }
    else if (row.kind === "authorization") { value = parseAbsNewsPublicationAuthorizationV1(json(row.payload)); digestValue = (value as AbsNewsPublicationAuthorizationV1).authorizationDigest; }
    else if (row.kind === "approval_request") { value = consequentialApprovalRequestSchemaV1.parse(json(row.payload)); digestValue = sha256Digest(value); }
    else if (row.kind === "approval_decision") { value = consequentialApprovalDecisionSchemaV1.parse(json(row.payload)); digestValue = sha256Digest(value); }
    else if (row.kind === "claim") { value = parseAbsNewsPublicationClaimV1(json(row.payload)); digestValue = (value as AbsNewsPublicationClaimV1).claimDigest; }
    else if (row.kind === "marker") { value = parseAbsNewsPublicationMarkerV1(json(row.payload)); digestValue = (value as AbsNewsPublicationMarkerV1).markerDigest; }
    else if (row.kind === "cleanup") { value = parseAbsNewsPublicationCleanupReceiptV1(json(row.payload)); digestValue = (value as AbsNewsPublicationCleanupReceiptV1).cleanupDigest; }
    else { value = parseAbsNewsPublicationOutcomeV1(json(row.payload)); digestValue = (value as AbsNewsPublicationOutcomeV1).outcomeDigest; }
    const expected = hmacSha256Tag(this.#key, { kind: row.kind, scope: this.#scope, id: row.record_id, digest: row.record_digest,
      semantic: row.semantic_key, version: Number(row.version), payloadDigest: sha256Digest(value), recordedAt: row.recorded_at });
    if (row.record_digest !== digestValue || row.record_auth_tag !== expected) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return value;
  }
  private current(kind: Kind, idValue: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM abs_news_publication_records WHERE kind=? AND record_id=? ORDER BY version DESC LIMIT 1")
      .get(kind, idValue) as Row | undefined;
  }
  private bySemantic(kind: Kind, key: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM abs_news_publication_records WHERE kind=? AND semantic_key=? ORDER BY version DESC LIMIT 1")
      .get(kind, key) as Row | undefined;
  }
  private currentRows(kind: Kind): Row[] {
    return this.#db.prepare("SELECT r.* FROM abs_news_publication_records r JOIN (SELECT record_id,max(version) version FROM abs_news_publication_records WHERE kind=? GROUP BY record_id) c ON c.record_id=r.record_id AND c.version=r.version WHERE r.kind=? ORDER BY r.record_id")
      .all(kind, kind) as unknown as Row[];
  }
  private createSchema(): void {
    this.#db.exec("BEGIN IMMEDIATE; CREATE TABLE abs_news_publication_metadata(tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,record_count INTEGER NOT NULL,state_digest TEXT NOT NULL,state_auth_tag TEXT NOT NULL); CREATE TABLE abs_news_publication_records(kind TEXT NOT NULL,record_id TEXT NOT NULL,record_digest TEXT NOT NULL,semantic_key TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(kind,record_id,version),UNIQUE(kind,record_digest)); CREATE INDEX abs_news_publication_semantic ON abs_news_publication_records(kind,semantic_key,version); PRAGMA user_version=1; COMMIT;");
  }
  private initialize(): void {
    const state = this.state(), revision = 1;
    this.#db.prepare("INSERT INTO abs_news_publication_metadata VALUES(?,?,?,?,?,?,?)").run(this.#scope.tenantId,
      this.#scope.workspaceId, this.#scope.projectId, revision, state.recordCount, state.stateDigest,
      hmacSha256Tag(this.#key, this.metaMaterial(revision, state.recordCount, state.stateDigest)));
  }
  private state(): { recordCount: number; stateDigest: string } {
    const rows = this.#db.prepare("SELECT * FROM abs_news_publication_records ORDER BY kind,record_id,version").all() as unknown as Row[];
    const records = rows.map((row) => { this.verified(row); return { kind: row.kind, id: row.record_id, digest: row.record_digest,
      semantic: row.semantic_key, version: Number(row.version), tag: row.record_auth_tag }; });
    return { recordCount: rows.length, stateDigest: sha256Digest({ scope: this.#scope, records }) };
  }
  private advance(): void {
    const meta = this.meta(), state = this.state(), revision = Number(meta.revision) + 1;
    const result = this.#db.prepare("UPDATE abs_news_publication_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE revision=?")
      .run(revision, state.recordCount, state.stateDigest, hmacSha256Tag(this.#key,
        this.metaMaterial(revision, state.recordCount, state.stateDigest)), meta.revision);
    if (Number(result.changes) !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }
  private meta(): Meta {
    const rows = this.#db.prepare("SELECT * FROM abs_news_publication_metadata").all() as unknown as Meta[];
    if (rows.length !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return rows[0]!;
  }
  private metaMaterial(revision: number, recordCount: number, stateDigest: string) {
    return { kind: "metadata", scope: this.#scope, revision, recordCount, stateDigest };
  }
  private schema(): void {
    const tables = (this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as { name: string }[])
      .map((row) => row.name);
    if (tables.join("|") !== TABLES.join("|")) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    const schemaRows = this.#db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as unknown as Array<{ type: string; name: string }>;
    const objects = schemaRows.map((row) => `${row.type}:${row.name}`);
    if (objects.join("|") !== SCHEMA_OBJECTS.join("|")) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }
  private scope(value: { tenantId: string; workspaceId: string; projectId: string }): void {
    if (value.tenantId !== this.#scope.tenantId || value.workspaceId !== this.#scope.workspaceId
      || value.projectId !== this.#scope.projectId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  private open(): void { if (this.#closed) throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#db.exec("COMMIT"); return result; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { void 0; } throw error; }
  }
}
