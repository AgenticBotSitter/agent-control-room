import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import {
  ProjectWorkspaceContractErrorV1,
  parseExactProjectWorkspaceV1,
  projectWorkspaceDigestSchemaV1,
  projectWorkspaceSafeIdSchemaV1,
  projectWorkspaceSourceStatusSchemaV1,
  projectWorkspaceTimeSchemaV1,
  type ProjectWorkspaceSourceStatusV1,
} from "../../../project-workspace/v1";
import { absNewsQueueHistorySchemaV1 } from "./schemas";
import { buildAbsNewsStoryV1, parseAbsNewsStoryV1 } from "./story";
import { parseAbsNewsWorkOrderProposalV1 } from "./proposal";
import type { AbsNewsQueueHistoryV1, AbsNewsQueueV1, AbsNewsStoryV1, AbsNewsWorkOrderProposalV1 } from "./types";

const STORE_VERSION = 1;
const TABLES = ["abs_news_current_sources", "abs_news_current_stories", "abs_news_metadata", "abs_news_proposals", "abs_news_queue_history", "abs_news_source_versions", "abs_news_story_versions"];
const scopeSchema = z.object({ tenantId: projectWorkspaceSafeIdSchemaV1, workspaceId: projectWorkspaceSafeIdSchemaV1, projectId: projectWorkspaceSafeIdSchemaV1 }).strict();
const queueChangeSchema = z.object({ storyId: projectWorkspaceSafeIdSchemaV1, toQueue: z.enum(["important_now", "earlier", "archive"]), changedByActorDigest: projectWorkspaceDigestSchemaV1, changedAt: projectWorkspaceTimeSchemaV1 }).strict();

type Scope = z.infer<typeof scopeSchema>;
type MetadataRow = { tenant_id: string; workspace_id: string; project_id: string; revision: number; record_count: number; state_digest: string; state_auth_tag: string };
type StoryRow = { story_id: string; story_digest: string; canonical_url: string; cluster_id: string; version: number; payload: string; record_auth_tag: string; recorded_at: string };
type ProposalRow = { proposal_id: string; proposal_digest: string; idempotency_key: string; story_id: string; payload: string; record_auth_tag: string; recorded_at: string };
type QueueRow = { event_id: string; event_digest: string; story_id: string; payload: string; record_auth_tag: string; recorded_at: string };
type SourceRow = { source_id: string; status_digest: string; version: number; payload: string; record_auth_tag: string; recorded_at: string };

function sameTag(left: string, right: string): boolean {
  return left.length === right.length && left === right;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
}

function storyInput(story: AbsNewsStoryV1, queue: AbsNewsQueueV1) {
  const {
    contractVersion: _contractVersion, canonicalHost: _canonicalHost, containsRawNewsletterBody: _raw,
    grantsNetworkAuthority: _network, grantsCommandAuthority: _command, grantsExecutionAuthority: _execution,
    storyDigest: _digest, ...input
  } = story;
  void _contractVersion; void _canonicalHost; void _raw; void _network; void _command; void _execution; void _digest;
  return { ...input, queue };
}

export class SqliteAbsNewsStoreV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  readonly #scope: Scope;
  #closed = false;

  constructor(path: string, scopeValue: unknown, options: { integrityKey: Uint8Array; mode: "create" | "open" }) {
    this.#scope = parseExactProjectWorkspaceV1(scopeSchema, scopeValue);
    try { hmacSha256Tag(options.integrityKey, { purpose: "abs-news-store" }); } catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
    this.#key = new Uint8Array(options.integrityKey);
    this.#db = new DatabaseSync(path);
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (options.mode === "create") {
      if (version !== 0) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      this.createSchema();
    } else if (version !== STORE_VERSION) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    this.assertSchema();
    if (options.mode === "create") this.initializeMetadata();
    this.verifyIntegrity();
  }

  close(): void {
    if (this.#closed) return;
    this.#key.fill(0);
    this.#db.close();
    this.#closed = true;
  }

  ingestStories(values: unknown[], recordedAtValue: unknown): { inserted: number; replayed: number; stories: AbsNewsStoryV1[] } {
    this.assertOpen();
    const recordedAt = this.time(recordedAtValue);
    if (!Array.isArray(values)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const stories = values.map(parseAbsNewsStoryV1);
    if (new Set(stories.map((story) => story.storyId)).size !== stories.length) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    stories.forEach((story) => this.assertScope(story));
    this.verifyIntegrity();
    return this.transaction(() => {
      let inserted = 0, replayed = 0;
      for (const story of stories) {
        if (this.insertStory(story, recordedAt)) inserted += 1;
        else replayed += 1;
      }
      if (inserted > 0) this.advanceState();
      return { inserted, replayed, stories: stories.map((story) => this.loadStory(story.storyId)) };
    });
  }

  saveProposal(value: unknown, recordedAtValue?: unknown): { proposal: AbsNewsWorkOrderProposalV1; replayed: boolean } {
    this.assertOpen();
    const proposal = parseAbsNewsWorkOrderProposalV1(value); this.assertScope(proposal);
    const recordedAt = this.time(recordedAtValue ?? proposal.requestedAt);
    this.verifyIntegrity();
    return this.transaction(() => {
      const existing = this.#db.prepare("SELECT * FROM abs_news_proposals WHERE proposal_id=? OR idempotency_key=?").get(proposal.proposalId, proposal.proposalIdempotencyKey) as ProposalRow | undefined;
      if (existing) {
        const known = this.verifiedProposal(existing);
        if (known.proposalIdempotencyKey === proposal.proposalIdempotencyKey) return { proposal: known, replayed: true };
        throw new ProjectWorkspaceContractErrorV1("replay_drift");
      }
      const story = this.loadStory(proposal.storyId);
      if (story.storyDigest !== proposal.storyDigest) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      const payload = JSON.stringify(proposal), tag = hmacSha256Tag(this.#key, this.proposalMaterial(proposal, recordedAt));
      this.#db.prepare("INSERT INTO abs_news_proposals VALUES(?,?,?,?,?,?,?)").run(proposal.proposalId, proposal.proposalDigest, proposal.proposalIdempotencyKey, proposal.storyId, payload, tag, recordedAt);
      this.advanceState();
      return { proposal, replayed: false };
    });
  }

  changeQueue(inputValue: unknown): { story: AbsNewsStoryV1; event?: AbsNewsQueueHistoryV1; replayed: boolean } {
    this.assertOpen();
    const input = parseExactProjectWorkspaceV1(queueChangeSchema, inputValue);
    this.verifyIntegrity();
    return this.transaction(() => {
      const prior = this.loadStory(input.storyId);
      if (prior.queue === input.toQueue) return { story: prior, replayed: true };
      const next = buildAbsNewsStoryV1(storyInput(prior, input.toQueue));
      const eventMaterial = {
        eventId: `queue.abs.${sha256Digest({ storyId: prior.storyId, prior: prior.storyDigest, next: next.storyDigest, changedAt: input.changedAt }).slice(7, 31)}`,
        tenantId: prior.tenantId, workspaceId: prior.workspaceId, projectId: prior.projectId, storyId: prior.storyId,
        priorStoryDigest: prior.storyDigest, nextStoryDigest: next.storyDigest, fromQueue: prior.queue, toQueue: next.queue,
        changedByActorDigest: input.changedByActorDigest, changedAt: input.changedAt,
        grantsCommandAuthority: false as const, grantsExecutionAuthority: false as const,
      };
      const event = parseExactProjectWorkspaceV1(absNewsQueueHistorySchemaV1, { ...eventMaterial, eventDigest: sha256Digest(eventMaterial) }) as AbsNewsQueueHistoryV1;
      this.insertStory(next, input.changedAt);
      const payload = JSON.stringify(event), tag = hmacSha256Tag(this.#key, this.queueMaterial(event));
      this.#db.prepare("INSERT INTO abs_news_queue_history VALUES(?,?,?,?,?,?)").run(event.eventId, event.eventDigest, event.storyId, payload, tag, event.changedAt);
      this.advanceState();
      return { story: next, event, replayed: false };
    });
  }

  saveSourceStatus(value: unknown, recordedAtValue: unknown): { status: ProjectWorkspaceSourceStatusV1; replayed: boolean } {
    this.assertOpen();
    const status = parseExactProjectWorkspaceV1(projectWorkspaceSourceStatusSchemaV1, value);
    const recordedAt = this.time(recordedAtValue), statusDigest = sha256Digest(status);
    this.verifyIntegrity();
    return this.transaction(() => {
      const current = this.#db.prepare("SELECT v.* FROM abs_news_current_sources c JOIN abs_news_source_versions v ON v.source_id=c.source_id AND v.status_digest=c.status_digest WHERE c.source_id=?").get(status.sourceId) as SourceRow | undefined;
      if (current && current.status_digest === statusDigest) return { status: this.verifiedSource(current), replayed: true };
      const version = current ? current.version + 1 : 1, payload = JSON.stringify(status);
      const tag = hmacSha256Tag(this.#key, this.sourceMaterial(status.sourceId, statusDigest, version, payload, recordedAt));
      this.#db.prepare("INSERT INTO abs_news_source_versions VALUES(?,?,?,?,?,?)").run(status.sourceId, statusDigest, version, payload, tag, recordedAt);
      this.#db.prepare("INSERT INTO abs_news_current_sources(source_id,status_digest,version) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET status_digest=excluded.status_digest,version=excluded.version").run(status.sourceId, statusDigest, version);
      this.advanceState();
      return { status, replayed: false };
    });
  }

  getStory(storyId: string): AbsNewsStoryV1 { this.verifyIntegrity(); return this.loadStory(storyId); }

  listStories(filter: { queue?: AbsNewsQueueV1; verificationState?: "verified" | "review_only" } = {}): AbsNewsStoryV1[] {
    this.verifyIntegrity();
    const rows = this.#db.prepare("SELECT v.* FROM abs_news_current_stories c JOIN abs_news_story_versions v ON v.story_id=c.story_id AND v.story_digest=c.story_digest ORDER BY v.story_id").all() as unknown as StoryRow[];
    return rows.map((row) => this.verifiedStory(row)).filter((story) => (!filter.queue || story.queue === filter.queue) && (!filter.verificationState || story.verificationState === filter.verificationState))
      .sort((left, right) => right.priorityScore - left.priorityScore || right.discoveredAt.localeCompare(left.discoveredAt) || left.storyId.localeCompare(right.storyId));
  }

  listProposals(): AbsNewsWorkOrderProposalV1[] {
    this.verifyIntegrity();
    return (this.#db.prepare("SELECT * FROM abs_news_proposals ORDER BY recorded_at,proposal_id").all() as unknown as ProposalRow[]).map((row) => this.verifiedProposal(row));
  }

  listQueueHistory(storyId?: string): AbsNewsQueueHistoryV1[] {
    this.verifyIntegrity();
    const rows = (storyId ? this.#db.prepare("SELECT * FROM abs_news_queue_history WHERE story_id=? ORDER BY recorded_at,event_id").all(storyId) : this.#db.prepare("SELECT * FROM abs_news_queue_history ORDER BY recorded_at,event_id").all()) as unknown as QueueRow[];
    return rows.map((row) => this.verifiedQueue(row));
  }

  listSourceStatuses(): ProjectWorkspaceSourceStatusV1[] {
    this.verifyIntegrity();
    const rows = this.#db.prepare("SELECT v.* FROM abs_news_current_sources c JOIN abs_news_source_versions v ON v.source_id=c.source_id AND v.status_digest=c.status_digest ORDER BY v.source_id").all() as unknown as SourceRow[];
    return rows.map((row) => this.verifiedSource(row));
  }

  verifyIntegrity(): { revision: number; recordCount: number; stateDigest: string } {
    this.assertOpen(); this.assertSchema();
    const metadata = this.metadata(), state = this.computeState();
    const tag = hmacSha256Tag(this.#key, this.metadataMaterial(metadata.revision, metadata.record_count, metadata.state_digest));
    if (metadata.tenant_id !== this.#scope.tenantId || metadata.workspace_id !== this.#scope.workspaceId || metadata.project_id !== this.#scope.projectId
      || metadata.record_count !== state.recordCount || metadata.state_digest !== state.stateDigest || !sameTag(metadata.state_auth_tag, tag)) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    return { revision: metadata.revision, recordCount: state.recordCount, stateDigest: state.stateDigest };
  }

  private createSchema(): void {
    this.#db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE abs_news_metadata(tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,record_count INTEGER NOT NULL,state_digest TEXT NOT NULL,state_auth_tag TEXT NOT NULL);
      CREATE TABLE abs_news_story_versions(story_id TEXT NOT NULL,story_digest TEXT NOT NULL UNIQUE,canonical_url TEXT NOT NULL,cluster_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(story_id,version));
      CREATE TABLE abs_news_current_stories(story_id TEXT PRIMARY KEY,story_digest TEXT NOT NULL UNIQUE,version INTEGER NOT NULL);
      CREATE TABLE abs_news_proposals(proposal_id TEXT PRIMARY KEY,proposal_digest TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,story_id TEXT NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE abs_news_queue_history(event_id TEXT PRIMARY KEY,event_digest TEXT NOT NULL UNIQUE,story_id TEXT NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE abs_news_source_versions(source_id TEXT NOT NULL,status_digest TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(source_id,version));
      CREATE TABLE abs_news_current_sources(source_id TEXT PRIMARY KEY,status_digest TEXT NOT NULL UNIQUE,version INTEGER NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }

  private initializeMetadata(): void {
    const state = this.computeState(), revision = 1;
    const tag = hmacSha256Tag(this.#key, this.metadataMaterial(revision, state.recordCount, state.stateDigest));
    this.#db.prepare("INSERT INTO abs_news_metadata VALUES(?,?,?,?,?,?,?)").run(this.#scope.tenantId, this.#scope.workspaceId, this.#scope.projectId, revision, state.recordCount, state.stateDigest, tag);
  }

  private insertStory(story: AbsNewsStoryV1, recordedAt: string): boolean {
    const current = this.#db.prepare("SELECT v.* FROM abs_news_current_stories c JOIN abs_news_story_versions v ON v.story_id=c.story_id AND v.story_digest=c.story_digest WHERE c.story_id=?").get(story.storyId) as StoryRow | undefined;
    if (current) {
      const prior = this.verifiedStory(current);
      if (prior.storyDigest === story.storyDigest) return false;
      if (prior.canonicalUrl !== story.canonicalUrl || prior.clusterId !== story.clusterId || story.lastVerifiedAt < prior.lastVerifiedAt) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    }
    const urlOwner = this.#db.prepare("SELECT v.story_id FROM abs_news_current_stories c JOIN abs_news_story_versions v ON v.story_id=c.story_id AND v.story_digest=c.story_digest WHERE v.canonical_url=? AND v.story_id<>?").get(story.canonicalUrl, story.storyId) as { story_id: string } | undefined;
    if (urlOwner) throw new ProjectWorkspaceContractErrorV1("replay_drift");
    const version = current ? current.version + 1 : 1, payload = JSON.stringify(story);
    const tag = hmacSha256Tag(this.#key, this.storyMaterial(story, version, recordedAt));
    this.#db.prepare("INSERT INTO abs_news_story_versions VALUES(?,?,?,?,?,?,?,?)").run(story.storyId, story.storyDigest, story.canonicalUrl, story.clusterId, version, payload, tag, recordedAt);
    this.#db.prepare("INSERT INTO abs_news_current_stories(story_id,story_digest,version) VALUES(?,?,?) ON CONFLICT(story_id) DO UPDATE SET story_digest=excluded.story_digest,version=excluded.version").run(story.storyId, story.storyDigest, version);
    return true;
  }

  private loadStory(storyId: string): AbsNewsStoryV1 {
    const row = this.#db.prepare("SELECT v.* FROM abs_news_current_stories c JOIN abs_news_story_versions v ON v.story_id=c.story_id AND v.story_digest=c.story_digest WHERE c.story_id=?").get(storyId) as StoryRow | undefined;
    if (!row) throw new ProjectWorkspaceContractErrorV1("not_found");
    return this.verifiedStory(row);
  }

  private verifiedStory(row: StoryRow): AbsNewsStoryV1 {
    const story = parseAbsNewsStoryV1(parseJson(row.payload)); this.assertScope(story);
    const expected = hmacSha256Tag(this.#key, this.storyMaterial(story, Number(row.version), row.recorded_at));
    if (row.story_id !== story.storyId || row.story_digest !== story.storyDigest || row.canonical_url !== story.canonicalUrl || row.cluster_id !== story.clusterId || !sameTag(row.record_auth_tag, expected)) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return story;
  }

  private verifiedProposal(row: ProposalRow): AbsNewsWorkOrderProposalV1 {
    const proposal = parseAbsNewsWorkOrderProposalV1(parseJson(row.payload)); this.assertScope(proposal);
    const expected = hmacSha256Tag(this.#key, this.proposalMaterial(proposal, row.recorded_at));
    if (row.proposal_id !== proposal.proposalId || row.proposal_digest !== proposal.proposalDigest || row.idempotency_key !== proposal.proposalIdempotencyKey || row.story_id !== proposal.storyId || !sameTag(row.record_auth_tag, expected)) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return proposal;
  }

  private verifiedQueue(row: QueueRow): AbsNewsQueueHistoryV1 {
    const event = parseExactProjectWorkspaceV1(absNewsQueueHistorySchemaV1, parseJson(row.payload)) as AbsNewsQueueHistoryV1;
    const { eventDigest: _digest, ...unsigned } = event; void _digest;
    if (sha256Digest(unsigned) !== event.eventDigest || row.event_id !== event.eventId || row.event_digest !== event.eventDigest || row.story_id !== event.storyId || !sameTag(row.record_auth_tag, hmacSha256Tag(this.#key, this.queueMaterial(event)))) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    this.assertScope(event); return event;
  }

  private verifiedSource(row: SourceRow): ProjectWorkspaceSourceStatusV1 {
    const status = parseExactProjectWorkspaceV1(projectWorkspaceSourceStatusSchemaV1, parseJson(row.payload));
    const digest = sha256Digest(status), expected = hmacSha256Tag(this.#key, this.sourceMaterial(row.source_id, row.status_digest, Number(row.version), row.payload, row.recorded_at));
    if (row.source_id !== status.sourceId || row.status_digest !== digest || !sameTag(row.record_auth_tag, expected)) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return status;
  }

  private computeState(): { recordCount: number; stateDigest: string } {
    const stories = (this.#db.prepare("SELECT * FROM abs_news_story_versions ORDER BY story_id,version").all() as unknown as StoryRow[]).map((row) => { this.verifiedStory(row); return { id: row.story_id, digest: row.story_digest, version: Number(row.version), tag: row.record_auth_tag }; });
    const proposals = (this.#db.prepare("SELECT * FROM abs_news_proposals ORDER BY proposal_id").all() as unknown as ProposalRow[]).map((row) => { this.verifiedProposal(row); return { id: row.proposal_id, digest: row.proposal_digest, tag: row.record_auth_tag }; });
    const queue = (this.#db.prepare("SELECT * FROM abs_news_queue_history ORDER BY event_id").all() as unknown as QueueRow[]).map((row) => { this.verifiedQueue(row); return { id: row.event_id, digest: row.event_digest, tag: row.record_auth_tag }; });
    const sources = (this.#db.prepare("SELECT * FROM abs_news_source_versions ORDER BY source_id,version").all() as unknown as SourceRow[]).map((row) => { this.verifiedSource(row); return { id: row.source_id, digest: row.status_digest, version: Number(row.version), tag: row.record_auth_tag }; });
    const currentStories = this.#db.prepare("SELECT * FROM abs_news_current_stories ORDER BY story_id").all();
    const currentSources = this.#db.prepare("SELECT * FROM abs_news_current_sources ORDER BY source_id").all();
    const recordCount = stories.length + proposals.length + queue.length + sources.length;
    return { recordCount, stateDigest: sha256Digest({ scope: this.#scope, stories, proposals, queue, sources, currentStories, currentSources }) };
  }

  private advanceState(): void {
    const metadata = this.metadata(), state = this.computeState(), revision = Number(metadata.revision) + 1;
    const tag = hmacSha256Tag(this.#key, this.metadataMaterial(revision, state.recordCount, state.stateDigest));
    const result = this.#db.prepare("UPDATE abs_news_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE revision=?").run(revision, state.recordCount, state.stateDigest, tag, metadata.revision);
    if (Number(result.changes) !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }

  private metadata(): MetadataRow {
    const rows = this.#db.prepare("SELECT * FROM abs_news_metadata").all() as unknown as MetadataRow[];
    if (rows.length !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return { ...rows[0]!, revision: Number(rows[0]!.revision), record_count: Number(rows[0]!.record_count) };
  }

  private storyMaterial(story: AbsNewsStoryV1, version: number, recordedAt: string) { return { kind: "story", scope: this.#scope, story, version, recordedAt }; }
  private proposalMaterial(proposal: AbsNewsWorkOrderProposalV1, recordedAt: string) { return { kind: "proposal", scope: this.#scope, proposal, recordedAt }; }
  private queueMaterial(event: AbsNewsQueueHistoryV1) { return { kind: "queue", scope: this.#scope, event }; }
  private sourceMaterial(sourceId: string, statusDigest: string, version: number, payload: string, recordedAt: string) { return { kind: "source", scope: this.#scope, sourceId, statusDigest, version, payload, recordedAt }; }
  private metadataMaterial(revision: number, recordCount: number, stateDigest: string) { return { kind: "metadata", scope: this.#scope, revision, recordCount, stateDigest }; }

  private assertScope(value: { tenantId: string; workspaceId: string; projectId: string }): void {
    if (value.tenantId !== this.#scope.tenantId || value.workspaceId !== this.#scope.workspaceId || value.projectId !== this.#scope.projectId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  private time(value: unknown): string { try { return projectWorkspaceTimeSchemaV1.parse(value); } catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); } }
  private assertOpen(): void { if (this.#closed) throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
  private assertSchema(): void {
    const tables = (this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as { name: string }[]).map((row) => row.name);
    if (tables.join("|") !== TABLES.join("|")) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }
  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.#db.exec("COMMIT"); return value; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { /* preserve original */ } throw error; }
  }
}
