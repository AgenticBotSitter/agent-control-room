import { z } from "zod";
import type { DatabaseClient } from "../../../persistence/database";
import type { PinnedFetchDependencies } from "../../../vendor/control-center/pinned-fetch";
import { projectWorkspaceSafeIdSchemaV1 as id } from "../../../project-workspace/v1";
import { captureAbsCurrentSourceAuthority, type AbsCurrentSourceAuthority } from "./current-source-authority";
import { controlCenterCollectionLimitsSchema, createControlCenterCollectionReader } from "./control-center-reader";
import { collectConfiguredControlCenterSource } from "./configured-collection";

export const controlCenterCollectionConfigurationSchema = z.object({
  tenantId: id, workspaceId: id, projectId: id, sourceId: id,
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  limits: controlCenterCollectionLimitsSchema,
}).strict();

/** Single-use job-facing lifecycle around the upstream reader. Construction is inert;
 * the caller supplies authorized transport and current destination checks. This does
 * not reinterpret the legacy single-feed job grant as discovery permission.
 * close() cancels and waits for logical collection settlement; physical transport
 * cleanup remains the supplied transport's responsibility and requires qualification. */
export function createControlCenterCollection(db: DatabaseClient, value: unknown, keyValue: Uint8Array,
  source: AbsCurrentSourceAuthority, dependencies: Required<Pick<PinnedFetchDependencies, "lookup" | "fetch">>,
  clock: () => number = Date.now) {
  const { sourceId, expectedRevision, limits, ...scope } = controlCenterCollectionConfigurationSchema.parse(value);
  if (!(keyValue instanceof Uint8Array) || keyValue.length !== 32) throw new Error("news_key_invalid");
  const key = Uint8Array.from(keyValue), assertCurrent = captureAbsCurrentSourceAuthority(source);
  const ports = { lookup: dependencies.lookup.bind(dependencies), fetch: dependencies.fetch.bind(dependencies) };
  const controller = new AbortController();
  let used = false, closed = false;
  let active: ReturnType<typeof collectConfiguredControlCenterSource> | undefined, closing: Promise<void> | undefined;
  return Object.freeze({
    collect(signal: AbortSignal) {
      if (used || closed || !(signal instanceof AbortSignal) || signal.aborted)
        return Promise.reject(new Error("news_collection_unavailable"));
      used = true;
      const reader = createControlCenterCollectionReader(limits, { assertCurrent(url) { assertCurrent(url); } },
        AbortSignal.any([signal, controller.signal]), ports, clock);
      active = collectConfiguredControlCenterSource(db, scope, sourceId, expectedRevision, key, reader, clock);
      return active;
    },
    close() {
      if (closing) return closing;
      closed = true; controller.abort();
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            active ? active.then(() => undefined, () => undefined) : Promise.resolve(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("news_collection_close_uncertain")), 5000); }),
          ]);
        } finally { clearTimeout(timer); }
      })();
      return closing;
    },
  });
}
