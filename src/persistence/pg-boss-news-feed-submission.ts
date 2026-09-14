import type { DatabaseSession } from "./database";
import { NEWS_FEED_QUEUE, newsFeedJobReferenceSchema, newsFeedJobId, assertNewsFeedQueue, type NewsFeedJobReference } from "./pg-boss-news-feed-worker";
import { preparePgBossBoundedSubmission, type PgBossBoundedSubmissionConstructor } from "./pg-boss-bounded-submission";

/** Called only for a fresh canonical intent inside its checked transaction.
 * Does not create intent/approval, provision queue, dispatch network work or enable retry. */
export function preparePgBossNewsFeedSubmission(PgBoss: PgBossBoundedSubmissionConstructor<NewsFeedJobReference>, database: DatabaseSession,
  options: { backend: "postgres" | "pglite" } = { backend: "postgres" }) {
  return preparePgBossBoundedSubmission(PgBoss, database, { name: NEWS_FEED_QUEUE.name, maximumRecoveries: 0,
    unavailableCode: "news_feed_submission_unavailable", parse: value => newsFeedJobReferenceSchema.parse(value),
    identify: newsFeedJobId, assertQueue: assertNewsFeedQueue,
  }, { backend: options.backend }); // Never forward caller-supplied recovery fields.
}
