import type { JobEventBody } from "../node-protocol/v1";
import type { JobEventRecorderPortV1 } from "../node-executor/synthetic-coordinator";
import type { SqliteBridgeJournal } from "./journal";

export class DurableBridgeJobEventRecorder implements JobEventRecorderPortV1 {
  constructor(
    private readonly journal: SqliteBridgeJournal,
    private readonly now: () => string,
  ) {}

  append(event: JobEventBody): void {
    this.journal.appendJobEvent(event, this.now());
  }
}
