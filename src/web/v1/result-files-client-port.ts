export type ResultFileState = "available" | "pending" | "failed" | "refused";
export type TextCopyStatus = "available" | "pending" | "failed" | "unavailable";

export type ResultFile = Readonly<{
  id: string;
  displayName: string;
  type: string;
  size: number;
  sha256: string;
  producerMachine: string;
  state: ResultFileState;
  textCopy?: Readonly<{ status: TextCopyStatus }>;
}>;

export type ResultFileSet = Readonly<{
  id: string;
  projectId: string;
  task: Readonly<{ id: string; title: string }>;
  files: readonly ResultFile[];
}>;

export type ResultFilesScope = Readonly<{ projectId: string; taskId?: string }>;
export type ResultFileVariant = "original" | "text-copy";

/** The only UI-to-storage seam for the universal result-file catalog. The
 * storage branch can replace the exported production binding below without
 * changing either owner surface. Download URLs must resolve to attachment
 * responses; the UI never fetches or renders result bytes inline. */
export interface ResultFilesClientPort {
  list(scope: ResultFilesScope, signal?: AbortSignal): Promise<readonly ResultFileSet[]>;
  downloadUrl(scope: ResultFilesScope, resultSetId: string, fileId: string, variant: ResultFileVariant): string | undefined;
}

export class ResultFilesUnavailableError extends Error {
  constructor() { super("result_files_unavailable"); this.name = "ResultFilesUnavailableError"; }
}

const unavailableResultFilesClient: ResultFilesClientPort = Object.freeze({
  async list(_scope: ResultFilesScope, signal?: AbortSignal) {
    signal?.throwIfAborted();
    throw new ResultFilesUnavailableError();
  },
  downloadUrl() { return undefined; },
});

/** Production wiring point. It deliberately reports unavailable until the
 * result-file catalog and owner-download adapter provide this port. */
export const resultFilesClientV1: ResultFilesClientPort = unavailableResultFilesClient;

type InMemoryOptions = Readonly<{
  delayMs?: number;
  failFirstReads?: number;
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

/** Read-only double used by component tests and the disposable contributor
 * demo. It keeps the same scope and download rules as the production port. */
export function createInMemoryResultFilesClient(
  source: readonly ResultFileSet[],
  options: InMemoryOptions = {},
): ResultFilesClientPort {
  let failuresRemaining = options.failFirstReads ?? 0;
  const sets = structuredClone(source) as ResultFileSet[];
  const selected = (scope: ResultFilesScope) => sets.filter(set => set.projectId === scope.projectId
    && (scope.taskId === undefined || set.task.id === scope.taskId));
  const client: ResultFilesClientPort = {
    async list(scope: ResultFilesScope, signal?: AbortSignal) {
      await abortableDelay(options.delayMs ?? 0, signal);
      signal?.throwIfAborted();
      if (failuresRemaining > 0) { failuresRemaining -= 1; throw new ResultFilesUnavailableError(); }
      return structuredClone(selected(scope));
    },
    downloadUrl(scope: ResultFilesScope, resultSetId: string, fileId: string, variant: ResultFileVariant) {
      const set = selected(scope).find(candidate => candidate.id === resultSetId);
      if (!set) return undefined;
      const file = set.files.find(candidate => candidate.id === fileId);
      if (!file || file.state !== "available" || variant === "text-copy" && file.textCopy?.status !== "available") return undefined;
      return variant === "text-copy" ? "data:text/plain;charset=utf-8," : "data:application/octet-stream,";
    },
  };
  return Object.freeze(client);
}
