import { z } from "zod";
import type { DatabaseClient } from "../../../persistence/database";
import { projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { absFeedInputSchema, AbsFeedDecodeError, decodeAbsFeed } from "./feed-decoder";
import { saveAbsNewsDiscovery } from "./discovery-ingestion";

const configuration = absFeedInputSchema.omit({ xml: true, observedAt: true });
const failedRead = z.object({ checkedAt: time, reason: z.enum(["read_failed", "read_timed_out", "source_refused"]) }).strict();
/** Trusted ingestion composition, not an HTTP or network authority boundary.
 * Accepts text from a separately authorized reader. No fetching, timers, jobs or retries.
 * Decoding finishes before SQL; source health and story versions then commit together. */
export class AbsFeedIngestionService {
  private readonly config: z.infer<typeof configuration>;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, value: unknown, key: Uint8Array) {
    this.config = configuration.parse(value);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("news_key_invalid");
    this.key = Uint8Array.from(key);
  }
  async ingest(xml: unknown, observedAt: unknown) {
    const checkedAt = time.parse(observedAt);
    let decoded: Awaited<ReturnType<typeof decodeAbsFeed>>;
    try { decoded = await decodeAbsFeed({ ...this.config, xml, observedAt: checkedAt }); }
    catch (error) {
      if (!(error instanceof AbsFeedDecodeError)) throw error;
      return this.save(checkedAt, undefined, error.code);
    }
    return this.save(checkedAt, decoded);
  }
  async recordReadFailure(value: unknown) {
    const failure = failedRead.parse(value);
    return this.save(failure.checkedAt, undefined, failure.reason);
  }
  private async save(checkedAt: string, decoded?: Awaited<ReturnType<typeof decodeAbsFeed>>, reason?: string) {
    return saveAbsNewsDiscovery(this.db, this.config, this.key, checkedAt, decoded, reason);
  }
}
