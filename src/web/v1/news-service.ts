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

const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx),
  transaction: async work => work(tx), transactionWithPreCommitCheck: async (work, check) => {
    const value = await work(tx); await check(); return value;
  } });

/** Read-only web composition. Ingestion and proposal writes are not granted here. */
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
  async list(identity: VerifiedWebIdentity, projectId: string, after?: string, sourceAfter?: string) {
    if (!catalogProjectIdSchema.safeParse(projectId).success
      || after !== undefined && !catalogProjectIdSchema.safeParse(after).success
      || sourceAfter !== undefined && !catalogProjectIdSchema.safeParse(sourceAfter).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (!this.key) return { project, availability: "not_configured" as const, stories: [], nextCursor: null,
        observedAt: actor.now, canPrepare: false, sources: [], sourcesNextCursor: null };
      const store = new PostgresAbsNewsStoreV1(joined(tx), { ...this.scope, projectId }, this.key);
      const page = await store.listStories(after);
      const sourcePage = await store.listSourceStatuses(sourceAfter);
      const sources = sourcePage.statuses.map(({ sourceId, label, mode, state, checkedAt, lastSuccessfulAt, itemCount }) =>
        ({ sourceId, label, mode, state, checkedAt, ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}), ...(itemCount !== undefined ? { itemCount } : {}) }));
      const stories = page.stories.map(({ storyId, storyDigest, title, summary, canonicalUrl, queue, verificationState, publishedAt, discoveredAt, sourceLabel, priorityScore }) =>
        ({ storyId, storyDigest, title, summary, canonicalUrl, queue, verificationState, discoveredAt, sourceLabel, priorityScore, ...(publishedAt ? { publishedAt } : {}) }));
      return newsPageSchema.parse({ project, availability: "configured", stories, nextCursor: page.nextCursor, observedAt: actor.now,
        sources, sourcesNextCursor: sourcePage.nextCursor,
        canPrepare: project.lifecycle === "active" && actor.can("tasks.propose", projectId) });
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
      if (story.verificationState !== "verified") throw new WebAccessError("conflict");
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
