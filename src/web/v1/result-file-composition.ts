import type { DatabaseClient } from "../../persistence/database";
import type { WebTaskService } from "./task-service";
import { createResultFileServiceV1, type ResultFileServiceV1 } from "./result-file-service";
import type { ResultFileStoreV1 } from "../../artifacts/v1/result-file-store";

/**
 * The one place the result-file service is composed.
 *
 * Both web processes (the hosted one and the Mac-local one) build it here, so
 * the authority it uses is the authority the task results already use rather
 * than a second, easier-to-get-wrong copy: `readScopedResult` and the project
 * view, on the same client, with the same `tasks.read` / `tasks.results.read`
 * grants. A result file is reachable exactly when its result is.
 *
 * The byte store is supplied by the caller and is optional. With no store the
 * service still answers, and answers `not_configured` — never an empty catalog,
 * which would read as "this project produced no files".
 */
export function composeResultFileService(input: Readonly<{
  database: DatabaseClient;
  tasks: WebTaskService;
  tenantId: string;
  downloadKey: Uint8Array;
  store?: ResultFileStoreV1;
  clock?: () => number;
}>): ResultFileServiceV1 {
  return createResultFileServiceV1(input.database, {
    readScopedResult: (identity, projectId, jobId, read) =>
      input.tasks.readScopedResult(identity, projectId, jobId, read),
    // The mint needs a writable transaction on the SAME connection as its own
    // authorisation, and that is the whole reason this second boundary exists.
    // See the note on `ResultFileAuthorityV1.writeScopedResult`; in one line: a
    // second pool connection inside a held transaction exhausted the eight-wide
    // production pool and closed the database client for good.
    writeScopedResult: (identity, projectId, jobId, write) =>
      input.tasks.writeScopedResult(identity, projectId, jobId, write),
    authorizeProject: (identity, projectId) => input.tasks.authorize(identity, projectId),
    // `tasks.authorize` refuses a project the identity may not view, so reaching
    // here already means the project is visible. The catalog is therefore
    // readable with plain task access, exactly as Project Files is; the
    // narrower `tasks.results.read` grant is checked by the download itself,
    // which always goes through `readScopedResult`.
    canRead: () => true,
  }, { tenantId: input.tenantId, keys: { downloadKey: input.downloadKey },
    ...(input.store ? { store: input.store } : {}), ...(input.clock ? { clock: input.clock } : {}) });
}
