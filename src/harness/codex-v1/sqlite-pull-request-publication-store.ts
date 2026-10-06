import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import type { DurablePullRequestPublicationStoreV1 } from "../v1/pull-request-publication";

type PublicationJournal = Pick<SqliteBridgeJournal, "loadPullRequestPublication"
  | "reservePullRequestPublication" | "replacePullRequestPublication"
  | "retainedPullRequestPublication">;

/**
 * Production node adapter over the protected SQLite bridge journal. The
 * journal owns atomic reserve/CAS and retains the terminal record across
 * process restarts. This adapter grants no open, retry, or merge operation.
 */
export class SqlitePullRequestPublicationStoreV1 implements DurablePullRequestPublicationStoreV1 {
  constructor(private readonly journal: PublicationJournal) {}

  async load(publicationId: string): Promise<unknown | undefined> {
    return this.journal.loadPullRequestPublication(publicationId);
  }

  async reserve(publicationId: string, pendingRecord: unknown): Promise<"reserved" | "exists"> {
    return this.journal.reservePullRequestPublication(publicationId, pendingRecord);
  }

  async replace(publicationId: string, expectedPendingRecord: unknown, terminalRecord: unknown): Promise<boolean> {
    return this.journal.replacePullRequestPublication(publicationId, expectedPendingRecord, terminalRecord);
  }

  retainedForDelivery(deliveryDigest: string): unknown | undefined {
    return this.journal.retainedPullRequestPublication(deliveryDigest);
  }
}
