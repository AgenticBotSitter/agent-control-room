import type { DatabaseSession } from "./database";
import { ABS_FEED_QUEUE, absFeedJobReferenceSchema, absFeedJobId, assertAbsFeedQueue, type AbsFeedJobReference } from "./pg-boss-abs-feed-worker";
import { preparePgBossBoundedSubmission, type PgBossBoundedSubmissionConstructor } from "./pg-boss-bounded-submission";

/** Called only for a fresh canonical intent inside its checked transaction.
 * Does not create intent/approval, provision queue, dispatch network work or enable retry. */
export function preparePgBossAbsFeedSubmission(PgBoss: PgBossBoundedSubmissionConstructor<AbsFeedJobReference>, database: DatabaseSession,
  options: { backend: "postgres" | "pglite" } = { backend: "postgres" }) {
  return preparePgBossBoundedSubmission(PgBoss, database, { name: ABS_FEED_QUEUE.name, maximumRecoveries: 0,
    unavailableCode: "abs_feed_submission_unavailable", parse: value => absFeedJobReferenceSchema.parse(value),
    identify: absFeedJobId, assertQueue: assertAbsFeedQueue,
  }, { backend: options.backend }); // Never forward caller-supplied recovery fields.
}
