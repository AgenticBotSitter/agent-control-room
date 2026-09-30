import type { BrowserFailureCode } from "./browser-client";

/** Structural mirror of cook/files' result-file-wire.ts. */
export type ResultFileMediaType = "text/plain" | "text/markdown" | "text/csv" | "text/html"
  | "application/json" | "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  | "application/pdf" | "application/zip" | "application/octet-stream";

export type ResultFileItem = Readonly<{
  fileId: string;
  ordinal: number;
  displayName: string;
  declaredMediaType: ResultFileMediaType;
  detectedMediaType: ResultFileMediaType;
  sizeBytes: number;
  contentDigest: string;
  state: "declared" | "stored" | "quarantined" | "missing";
  receivedAt: string;
  downloadHref?: string;
}>;

export type ResultFileSet = Readonly<{
  setId: string;
  projectId: string;
  jobId: string;
  state: "declared" | "stored" | "incomplete" | "quarantined";
  sourceKind: "native-text" | "file-store";
  producerKind: "native" | "fleet";
  producerId: string;
  manifestDigest: string;
  retentionState: "provisional" | "retained" | "trash" | "purged";
  files: readonly ResultFileItem[];
  additionalFilesOmitted: boolean;
}>;

export type ResultFileCatalog = Readonly<{
  projectId: string;
  jobId?: string;
  sets: readonly ResultFileSet[];
  additionalSetsOmitted: boolean;
  catalogSource: "configured" | "not_configured";
  observedAt: string;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

export type ResultFilesScope = Readonly<{ projectId: string; taskId?: string }>;
export type ResultFileDownloadLink = Readonly<{ href: string; expiresAt: string }>;

/** The only UI-to-storage seam for the result-file catalog. Production mints
 * a fresh, short-lived link on demand; it never supplies one during render.
 * `kind` exists solely to keep the disposable demo's fixed data URL out of
 * every production adapter. */
export interface ResultFilesClientPort {
  readonly kind: "production" | "demo";
  list(scope: ResultFilesScope, signal?: AbortSignal): Promise<ResultFileCatalog>;
  requestDownload(projectId: string, resultSetId: string, fileId: string,
    signal?: AbortSignal): Promise<ResultFileDownloadLink>;
}

export class ResultFilesUnavailableError extends Error {
  constructor(readonly code: BrowserFailureCode = "unavailable") {
    super(code); this.name = "ResultFilesUnavailableError";
  }
}

const unavailableResultFilesClient = Object.freeze({
  kind: "production" as const,
  async list(_scope: ResultFilesScope, signal?: AbortSignal) {
    signal?.throwIfAborted();
    throw new ResultFilesUnavailableError();
  },
  async requestDownload(_projectId: string, _resultSetId: string, _fileId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    throw new ResultFilesUnavailableError();
  },
}) satisfies ResultFilesClientPort;

/** Production wiring point. It deliberately reports unavailable until the
 * catalog branch is merged and its browser client is bound here. */
export const resultFilesClientV1: ResultFilesClientPort = unavailableResultFilesClient;

type InMemoryOptions = Readonly<{
  delayMs?: number;
  failFirstReads?: number;
  failFirstDownloads?: number;
}>;

function abortableDelay(delayMs: number, signal?: AbortSignal) {
  if (!delayMs) { signal?.throwIfAborted(); return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(finish, delayMs);
    const stop = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Read-only double used only by component tests and the disposable demo. */
export function createInMemoryResultFilesClient(
  source: readonly ResultFileSet[],
  options: InMemoryOptions = {},
): ResultFilesClientPort {
  let readFailuresRemaining = options.failFirstReads ?? 0;
  let downloadFailuresRemaining = options.failFirstDownloads ?? 0;
  const sets = structuredClone(source) as ResultFileSet[];
  const selected = (scope: ResultFilesScope) => sets.filter(set => set.projectId === scope.projectId
    && (scope.taskId === undefined || set.jobId === scope.taskId));
  const client = {
    kind: "demo" as const,
    async list(scope: ResultFilesScope, signal?: AbortSignal) {
      await abortableDelay(options.delayMs ?? 0, signal);
      signal?.throwIfAborted();
      if (readFailuresRemaining > 0) { readFailuresRemaining -= 1; throw new ResultFilesUnavailableError(); }
      return Object.freeze({ projectId: scope.projectId, ...(scope.taskId ? { jobId: scope.taskId } : {}),
        sets: structuredClone(selected(scope)), additionalSetsOmitted: false, catalogSource: "configured" as const,
        observedAt: "2026-01-01T00:00:00.000Z", startsWork: false as const,
        grantsExecutionAuthority: false as const });
    },
    async requestDownload(projectId: string, resultSetId: string, fileId: string, signal?: AbortSignal) {
      await abortableDelay(options.delayMs ?? 0, signal);
      signal?.throwIfAborted();
      if (downloadFailuresRemaining > 0) { downloadFailuresRemaining -= 1; throw new ResultFilesUnavailableError(); }
      const set = sets.find(candidate => candidate.projectId === projectId && candidate.setId === resultSetId);
      const file = set?.files.find(candidate => candidate.fileId === fileId);
      if (!set || set.state === "quarantined" || !file || file.state !== "stored")
        throw new ResultFilesUnavailableError("not_found");
      return { href: "data:application/octet-stream,", expiresAt: "2026-01-01T00:05:00.000Z" };
    },
  } satisfies ResultFilesClientPort;
  return Object.freeze(client);
}
