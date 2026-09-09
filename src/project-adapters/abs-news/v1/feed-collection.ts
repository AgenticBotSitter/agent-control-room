import { z } from "zod";
import { captureAbsCurrentSourceAuthority, type AbsCurrentSourceAuthority } from "./current-source-authority";
import type { DatabaseClient } from "../../../persistence/database";
import { absFeedInputSchema } from "./feed-decoder";
import { AbsFeedIngestionService } from "./feed-ingestion";
import { createAbsPublicReader, type AbsPublicReaderPorts } from "./public-reader";

export const absFeedCollectionConfigurationSchema = absFeedInputSchema.omit({ xml: true, observedAt: true }).extend({ timeoutMs: z.number().int().min(1).max(30_000) });
type Receipt = Awaited<ReturnType<AbsFeedIngestionService["ingest"]>>;

/** One owned collection inside an already-authorized job; not a durable dispatch claim.
 * Construction is inert. Startup/queue wiring and live admission are deliberately external.
 * One source configuration controls both reader destination and stored attribution. */
export function createAbsFeedCollection(db: DatabaseClient, value: unknown, key: Uint8Array,
  source: AbsCurrentSourceAuthority, ports?: AbsPublicReaderPorts) {
  const { timeoutMs, ...config } = absFeedCollectionConfigurationSchema.parse(value), endpoint = config.source.endpointUrl;
  const assertCurrent = captureAbsCurrentSourceAuthority(source);
  let closed = false, used = false, active: Promise<Receipt> | undefined, closing: Promise<void> | undefined;
  let operationSignal: AbortSignal | undefined;
  const current = (): undefined => { if (closed || operationSignal?.aborted) throw new Error("abs_collection_unavailable");
    try { assertCurrent(endpoint); } catch { throw new Error("abs_collection_unavailable"); }
    if (closed || operationSignal?.aborted) throw new Error("abs_collection_unavailable"); };
  const guarded: DatabaseClient = { query: db.query.bind(db),
    transaction: work => { current(); return db.transactionWithPreCommitCheck(work, current); },
    transactionWithPreCommitCheck: (work, check) => { current(); return db.transactionWithPreCommitCheck(work, async () => { await check(); current(); }); } };
  const ingestion = new AbsFeedIngestionService(guarded, config, key);
  const reader = createAbsPublicReader({ urls: [endpoint], maxBytes: config.maxBytes, timeoutMs,
    contentTypes: ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml"] }, { assertCurrent: current }, ports);
  async function run(signal: AbortSignal) {
    let response: Awaited<ReturnType<typeof reader.read>> | undefined;
    try { response = await reader.read(endpoint, signal); }
    catch { /* The closed reader plus current authority determine whether a failure can be retained. */ }
    // Cleanup failure propagates: never turn an unclosed read into a saved success/failure.
    await reader.close(); current();
    if (!response) return ingestion.recordReadFailure({ checkedAt: new Date().toISOString(), reason: "read_failed" });
    return ingestion.ingest(response.text, response.observedAt);
  }
  return Object.freeze({ collect(signal: AbortSignal) {
    if (used || closed || !(signal instanceof AbortSignal) || signal.aborted) return Promise.reject(new Error("abs_collection_unavailable"));
    used = true; operationSignal = signal;
    active = run(signal); return active;
  }, close() {
    if (closing) return closing; closed = true;
    closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([reader.close(), active ? active.then(() => undefined, () => undefined) : Promise.resolve()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("abs_collection_close_uncertain")), 5000); })]); }
      finally { clearTimeout(timer); }
    })(); return closing;
  } });
}
