import { timingSafeEqual } from "node:crypto";
import { captureNewsDiscoveryConfiguration } from "./news-discovery-integration";
import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import type { AbsCurrentSourceAuthority } from "../../project-adapters/abs-news/v1/current-source-authority";
import type { PinnedFetchDependencies } from "../../vendor/control-center/pinned-fetch";

export interface NewsStartupConfiguration {
  configuration: unknown;
  coordinatorDatabase: PrivatePostgresConfiguration;
  ingestionDatabase: PrivatePostgresConfiguration;
  workerDatabase: PrivatePostgresConfiguration;
  integrityKey: Uint8Array;
  authority: AbsCurrentSourceAuthority;
  transport: Required<Pick<PinnedFetchDependencies, "lookup" | "fetch">>;
  concurrency?: number;
}

/** Capture only; startup must independently verify every database role. */
export function captureNewsStartupConfiguration(input: NewsStartupConfiguration,
  web: { tenantId: string; workspaceId: string; news?: { integrityKey: Uint8Array } },
  existing: readonly PrivatePostgresConfiguration[]) {
  const configuration = captureNewsDiscoveryConfiguration(input.configuration);
  const databases = [input.coordinatorDatabase, input.ingestionDatabase, input.workerDatabase].map(validatePrivatePostgresConfiguration);
  const all = [...existing, ...databases], primary = existing[0];
  if (!primary || configuration.tenantId !== web.tenantId || configuration.workspaceId !== web.workspaceId
    || all.some(db => db.host !== primary.host || db.port !== primary.port || db.database !== primary.database)
    || new Set(all.map(db => db.username)).size !== all.length
    || !(input.integrityKey instanceof Uint8Array) || input.integrityKey.length !== 32
    || !web.news || !timingSafeEqual(input.integrityKey, web.news.integrityKey)
    || typeof input.authority?.assertCurrent !== "function" || typeof input.transport?.lookup !== "function"
    || typeof input.transport?.fetch !== "function") throw new Error("news_startup_config_invalid");
  const concurrency = input.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("news_startup_config_invalid");
  return { configuration, coordinatorDatabase: databases[0], ingestionDatabase: databases[1], workerDatabase: databases[2],
    integrityKey: Uint8Array.from(input.integrityKey), concurrency,
    authority: Object.freeze({ assertCurrent: input.authority.assertCurrent.bind(input.authority) }),
    transport: Object.freeze({ lookup: input.transport.lookup.bind(input.transport), fetch: input.transport.fetch.bind(input.transport) }) };
}
