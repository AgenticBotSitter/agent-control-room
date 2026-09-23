import { InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { installationPlanRestartGuidanceV1 } from "./installation-plan";
import { createInstallationPlanViewV1, type InstallationPlanViewV1 } from "./installation-plan-view";

export const LOCAL_SETUP_JOURNAL_SOURCE_V1 = "control-room.local-setup-journal-source/v1" as const;

type RestartCategory = ReturnType<typeof installationPlanRestartGuidanceV1>["kind"];
type JournalReader = Pick<InstallationPlanFilesystemJournalV1, "inspectSettledHistory">;

export type LocalSetupJournalSourceResultV1 = Readonly<{
  schema: typeof LOCAL_SETUP_JOURNAL_SOURCE_V1;
  status: "available";
  plan: InstallationPlanViewV1;
  restart: RestartCategory;
  performsEffect: false;
  permitsRetry: false;
}> | Readonly<{
  schema: typeof LOCAL_SETUP_JOURNAL_SOURCE_V1;
  status: "unavailable";
  performsEffect: false;
  permitsRetry: false;
}>;

const unavailable = (): LocalSetupJournalSourceResultV1 => Object.freeze({
  schema: LOCAL_SETUP_JOURNAL_SOURCE_V1,
  status: "unavailable" as const,
  performsEffect: false as const,
  permitsRetry: false as const,
});

/**
 * Read-only browser projection over the canonical private setup journal. The
 * canonical journal verifies every revision; this adapter retains no history
 * and intentionally maps any missing or unreadable history to unavailable.
 */
export class LocalSetupJournalSourceV1 {
  private readonly journal: JournalReader;

  constructor(journal: JournalReader) {
    if (!journal || typeof journal.inspectSettledHistory !== "function") throw new Error("local_setup_journal_source_invalid");
    this.journal = Object.freeze({ inspectSettledHistory: journal.inspectSettledHistory.bind(journal) });
  }

  async read(signal?: AbortSignal): Promise<LocalSetupJournalSourceResultV1> {
    signal?.throwIfAborted();
    try {
      const history = await this.journal.inspectSettledHistory(signal);
      signal?.throwIfAborted();
      const latest = history.at(-1);
      if (!latest) return unavailable();
      return Object.freeze({
        schema: LOCAL_SETUP_JOURNAL_SOURCE_V1,
        status: "available" as const,
        plan: createInstallationPlanViewV1(latest),
        restart: installationPlanRestartGuidanceV1(latest).kind,
        performsEffect: false as const,
        permitsRetry: false as const,
      });
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      return unavailable();
    }
  }
}

/** Captures one canonical reader; every read still loads its current history. */
export function createLocalSetupJournalSourceV1(journal: JournalReader): LocalSetupJournalSourceV1 {
  return new LocalSetupJournalSourceV1(journal);
}
