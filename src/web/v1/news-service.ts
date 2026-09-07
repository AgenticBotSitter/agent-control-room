import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { PostgresAbsNewsStoreV1 } from "../../project-adapters/abs-news/v1/postgres-store";
import { WebSessionAuthority } from "./session-authority";
import { WebProjectService } from "./project-service";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { catalogProjectIdSchema } from "./project-wire";
import { newsPageSchema, newsResearchInputSchema, newsResearchPreviewSchema } from "./news-wire";
import { buildAbsNewsWorkOrderProposalV1 } from "../../project-adapters/abs-news/v1/proposal";
import { sha256Digest } from "../../security/digest";
import { absResearchTaskDraft } from "./abs-research-draft";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PostgresNewsSourceSettings, newsSourceSettingSchema } from "../../project-adapters/abs-news/v1/source-settings";
import { appendAuditWith } from "../../audit/audit-store";
import { PostgresNewsStoryArchives } from "../../project-adapters/abs-news/v1/story-archives";

const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx),
  transaction: async work => work(tx), transactionWithPreCommitCheck: async (work, check) => {
    const value = await work(tx); await check(); return value;
  } });

/** Saved-news reads, read-only task preparation and owner source-setting edits.
 * Ingestion and agent execution are not granted here. */
export class WebNewsService {
  private readonly authority: WebSessionAuthority;
  private readonly projects: WebProjectService;
  private readonly key?: Uint8Array;
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    options: { integrityKey?: Uint8Array; ideaIntegrityKey?: Uint8Array } = {}, clock: () => number = Date.now) {
    this.authority = new WebSessionAuthority(db, scope, clock, "news");
    this.projects = new WebProjectService(db, scope, clock, options.ideaIntegrityKey);
    if (options.integrityKey !== undefined) {
      if (!(options.integrityKey instanceof Uint8Array) || options.integrityKey.length !== 32) throw new Error("news_key_invalid");
      this.key = Uint8Array.from(options.integrityKey);
    }
  }
  async sourceSettings(identity: VerifiedWebIdentity, projectId: string, after?: string) {
    if (!catalogProjectIdSchema.safeParse(projectId).success || after !== undefined && !catalogProjectIdSchema.safeParse(after).success)
      throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (!this.key) return { projectId, configured: false, sources: [], nextCursor: null, canEdit: false };
      const page = await new PostgresNewsSourceSettings(joined(tx), { ...this.scope, projectId }, this.key).list(after);
      return { ...page, projectId, configured: true, canEdit: project.lifecycle === "active" && actor.can("news.sources.manage", projectId, true) };
    });
  }
  async saveSourceSetting(identity: VerifiedWebIdentity, projectId: string, value: unknown) {
    const parsed = z.object({ source: newsSourceSettingSchema, expectedRevision: z.number().int().min(0).max(2_147_483_646) }).strict().safeParse(value);
    if (!parsed.success || !catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("news.sources.manage", projectId, true);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (!this.key || project.lifecycle !== "active") throw new WebAccessError("conflict");
      const settings = new PostgresNewsSourceSettings(joined(tx), { ...this.scope, projectId }, this.key);
      const { source, expectedRevision } = parsed.data, previous = await settings.get(source.id);
      const replay = previous?.revision === expectedRevision + 1 && sha256Digest(previous.source) === sha256Digest(source);
      let saved;
      try { saved = await settings.save(source, expectedRevision, replay ? previous!.updatedAt : actor.now); }
      catch (error) {
        if (error instanceof Error && ["news_source_setting_conflict", "news_source_setting_stale"].includes(error.message)) throw new WebAccessError("conflict");
        throw error;
      }
      if (!saved.replayed) await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId,
        actorId: actor.id, actorType: "human", action: "news.source.updated", targetType: "news_source", targetId: source.id,
        occurredAt: actor.now, safeMetadata: { sourceDigest: sha256Digest(source), revision: saved.record.revision } });
      return { ...saved, projectId };
    });
  }
  async list(identity: VerifiedWebIdentity, projectId: string, after?: string, sourceAfter?: string, view = "all", order = "id") {
    if (!catalogProjectIdSchema.safeParse(projectId).success
      || after !== undefined && !catalogProjectIdSchema.safeParse(after).success
      || sourceAfter !== undefined && !catalogProjectIdSchema.safeParse(sourceAfter).success
      || !["all", "history", "archive", "fresh"].includes(view)
      || !["id", "important", "newest", "oldest"].includes(order)) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (!this.key) return { project, availability: "not_configured" as const, stories: [], nextCursor: null,
        observedAt: actor.now, canPrepare: false, canArchive: false, sources: [], sourcesNextCursor: null };
      const store = new PostgresAbsNewsStoreV1(joined(tx), { ...this.scope, projectId }, this.key);
      const page = await store.listStories(after, { view: view as "all" | "history" | "archive" | "fresh",
        order: order as "id" | "important" | "newest" | "oldest", observedAt: actor.now });
      const sourcePage = await store.listSourceStatuses(sourceAfter);
      const sources = sourcePage.statuses.map(({ sourceId, label, mode, state, checkedAt, lastSuccessfulAt, itemCount }) =>
        ({ sourceId, label, mode, state, checkedAt, ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}), ...(itemCount !== undefined ? { itemCount } : {}) }));
      const stories = page.stories.map(({ storyId, storyDigest, title, summary, canonicalUrl, queue, verificationState, publishedAt, discoveredAt, sourceLabel, priorityScore }) =>
        ({ storyId, storyDigest, title, summary, canonicalUrl,
          queue: page.archiveStates[storyId]?.archived === true ? "archive" : page.archiveStates[storyId]?.archived === false && queue === "archive" ? "earlier" : queue,
          archiveRevision: page.archiveStates[storyId]?.revision ?? 0,
          verificationState, discoveredAt, sourceLabel, priorityScore, ...(publishedAt ? { publishedAt } : {}) }));
      return newsPageSchema.parse({ project, availability: "configured", stories, nextCursor: page.nextCursor, observedAt: actor.now,
        sources, sourcesNextCursor: sourcePage.nextCursor,
        canPrepare: project.lifecycle === "active" && actor.can("tasks.propose", projectId),
        canArchive: project.lifecycle === "active" && actor.can("news.archive.manage", projectId, true) });
    });
  }
  async archive(identity: VerifiedWebIdentity, projectId: string, value: unknown) {
    const input = z.object({ storyId: catalogProjectIdSchema, archived: z.boolean(), expectedRevision: z.number().int().min(0).max(2_147_483_646) }).strict().safeParse(value);
    if (!input.success || !catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("news.archive.manage", projectId, true);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (!this.key || project.lifecycle !== "active") throw new WebAccessError("conflict");
      const store = new PostgresAbsNewsStoreV1(joined(tx), { ...this.scope, projectId }, this.key);
      if (!await store.getStory(input.data.storyId)) throw new WebAccessError("not_found");
      let saved;
      try { saved = await new PostgresNewsStoryArchives(joined(tx), { ...this.scope, projectId }, this.key)
        .save(input.data.storyId, input.data.archived, input.data.expectedRevision, actor.now); }
      catch (error) {
        if (error instanceof Error && error.message === "news_archive_conflict") throw new WebAccessError("conflict");
        throw error;
      }
      if (!saved.replayed) await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId,
        actorId: actor.id, actorType: "human", action: "news.archive.updated", targetType: "news_story", targetId: input.data.storyId,
        occurredAt: actor.now, safeMetadata: { archived: saved.record.archived, revision: saved.record.revision } });
      return { ...saved, projectId };
    });
  }
  /** Read-only draft preparation from an exact retained version. Saving uses the ordinary task command. */
  async prepare(identity: VerifiedWebIdentity, projectId: string, value: unknown) {
    const parsed = newsResearchInputSchema.safeParse(value);
    if (!parsed.success || !catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active") throw new WebAccessError("conflict");
      if (!this.key) throw new Error("news_not_configured");
      const input = parsed.data;
      const store = new PostgresAbsNewsStoreV1(joined(tx), { ...this.scope, projectId }, this.key);
      const story = await store.getStory(input.storyId, input.storyDigest);
      if (!story) throw new WebAccessError("not_found");
      if (story.verificationState !== "verified" && input.action !== "research_brief") throw new WebAccessError("conflict");
      const proposal = buildAbsNewsWorkOrderProposalV1({ ...this.scope, projectId, story,
        proposalId: `proposal:${randomUUID()}`, actionId: input.action, requestedTitle: story.title,
        goal: input.goal, requestedPlatform: "any", requestedByActorDigest: sha256Digest({ actorId: actor.id }), requestedAt: actor.now });
      let draft;
      try { draft = absResearchTaskDraft(proposal); } catch { throw new WebAccessError("invalid_request"); }
      return newsResearchPreviewSchema.parse({ projectId, storyId: story.storyId, storyDigest: story.storyDigest,
        draft, saved: false, dispatch: "not_requested" });
    });
  }
}
