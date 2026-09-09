import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { projectWorkspaceSafeIdSchemaV1 as id } from "../../../project-workspace/v1";
import { PostgresNewsSourceSettings } from "./source-settings";
import { AbsControlCenterIngestion } from "./control-center-ingestion";
import type { createControlCenterCollectionReader } from "./control-center-reader";
import { PostgresAbsNewsStoreV1 } from "./postgres-store";
import { PostgresArticleDetails } from "./article-store";
import { readNewsArticleDetail } from "./article-detail";

const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });

/** Existing authorized job composition, not job admission. Settings never authorize
 * a reader. Caller supplies the approved bounded reader/transport and its signal.
 * A changed/disabled source prevents publication of the collected result; this is
 * not a claim that a database edit instantly cancels an already-running network read. */
export async function collectConfiguredControlCenterSource(db: DatabaseClient, scopeValue: unknown,
  sourceIdValue: unknown, expectedRevisionValue: unknown, keyValue: Uint8Array,
  reader: ReturnType<typeof createControlCenterCollectionReader>, clock: () => number = Date.now) {
  const scope = scopeSchema.parse(scopeValue), sourceId = id.parse(sourceIdValue);
  const expectedRevision = z.number().int().min(1).max(2_147_483_647).parse(expectedRevisionValue);
  if (!(keyValue instanceof Uint8Array) || keyValue.length !== 32) throw new Error("news_key_invalid");
  const key = Uint8Array.from(keyValue), signal = reader.signal;
  signal.throwIfAborted();
  const settings = new PostgresNewsSourceSettings(db, scope, key);
  const source = await settings.get(sourceId);
  signal.throwIfAborted();
  if (!source?.source.enabled || source.revision !== expectedRevision) throw new Error("news_configured_source_changed");
  const verify = async (tx: DatabaseSession) => {
    signal.throwIfAborted();
    const current = await new PostgresNewsSourceSettings(joined(tx), scope, key).get(sourceId);
    if (!current?.source.enabled || current.revision !== expectedRevision) throw new Error("news_configured_source_changed");
    signal.throwIfAborted();
  };
  const guarded: DatabaseClient = { query: db.query.bind(db),
    transaction: work => db.transactionWithPreCommitCheck(async tx => {
      await verify(tx); const result = await work(tx); await verify(tx); return result;
    }, () => signal.throwIfAborted()),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(async tx => {
      await verify(tx); const result = await work(tx); await verify(tx); return result;
    }, async () => { await check(); signal.throwIfAborted(); }),
  };
  const { enabled: _enabled, ...upstreamSource } = source.source; void _enabled;
  const result = await new AbsControlCenterIngestion(guarded, { ...scope, source: upstreamSource }, key).collect(reader, signal, clock);
  // Older approved plans omit maxArticles and perform no extra reads. The opt-in
  // is part of the plan digest; extraction shares the discovery transport budget.
  if (!reader.maxArticles) return result;
  const news = new PostgresAbsNewsStoreV1(guarded, scope, key), details = new PostgresArticleDetails(guarded, scope, key);
  const summary = { attempted: 0, saved: 0, unavailable: 0, skipped: Math.max(0, result.receipt.stories.length - reader.maxArticles) };
  for (const reference of result.receipt.stories.slice(0, reader.maxArticles)) {
    signal.throwIfAborted(); await verify(db); summary.attempted++;
    const detail = await readNewsArticleDetail({ ...scope, ...reference }, {
      getStory: storyId => news.getStory(storyId), reader: { read: reader.readArticle },
      authority: { assertCurrent: reader.assertArticleCurrent },
    }, signal);
    // Parser refusal is explicit. Transport, authority and storage uncertainty
    // propagate to the existing held-attempt path, never a retry or success.
    if (detail.status === "extracted") { await details.save(detail); summary.saved++; }
    else summary.unavailable++;
  }
  return { ...result, articleExtraction: summary };
}
