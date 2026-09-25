import { isAbsolute, normalize } from "node:path";
import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";

export const OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 =
  "control-room.owner-trusted-local-enablement/v1" as const;

/** `hermes` is the update-aware product worker. `hermes-021` remains only so
 * historical source evidence can still be read; it is not the Mac product's
 * selected worker identity. */
export type OwnerTrustedLocalWorkerKindV1 = "codex" | "hermes" | "hermes-021" | "claude-code";

export type OwnerTrustedLocalEnablementV1 = Readonly<{
  schema: typeof OWNER_TRUSTED_LOCAL_ENABLEMENT_V1;
  mode: "mac-local";
  nodeId: "mac-1";
  workers: readonly Readonly<{
    workerId: string;
    kind: OwnerTrustedLocalWorkerKindV1;
    executablePath: string;
    recordedVersion: string;
  }>[];
  enablementDigest: string;
}>;

const workerId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u;
const safeVersion = /^[^\u0000-\u001f\u007f]{1,240}$/u;
const safePath = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && isAbsolute(value) && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);

const refused = (): never => { throw new Error("owner_trusted_local_enablement_invalid"); };

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) refused();
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = plain(value), actual = Object.getOwnPropertyNames(record);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key)) || keys.some(key => !actual.includes(key))) refused();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refused();
  }
  return record;
}

function captureWorker(value: unknown): Readonly<{
  workerId: string; kind: OwnerTrustedLocalWorkerKindV1; executablePath: string; recordedVersion: string;
}> {
  const item = exact(value, ["workerId", "kind", "executablePath", "recordedVersion"]);
  const id = item.workerId, kind = item.kind, executablePath = item.executablePath, recordedVersion = item.recordedVersion;
  if (typeof id !== "string" || !workerId.test(id)
    || (kind !== "codex" && kind !== "hermes" && kind !== "hermes-021" && kind !== "claude-code")
    || !safePath(executablePath) || typeof recordedVersion !== "string" || !safeVersion.test(recordedVersion)) refused();
  return Object.freeze({ workerId: id, kind, executablePath, recordedVersion }) as Readonly<{
    workerId: string; kind: OwnerTrustedLocalWorkerKindV1; executablePath: string; recordedVersion: string;
  }>;
}

/** Captures the simple, owner-accepted local trust record. It intentionally
 * grants neither delivery nor execution: a caller must still hold a current
 * canonical queue delivery before it may use a listed executable. */
export function captureOwnerTrustedLocalEnablementV1(value: unknown): OwnerTrustedLocalEnablementV1 {
  const record = exact(value, ["schema", "mode", "nodeId", "workers"]);
  const rawWorkers = record.workers;
  if (record.schema !== OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 || record.mode !== "mac-local" || record.nodeId !== "mac-1"
    || !Array.isArray(rawWorkers) || rawWorkers.length < 1 || rawWorkers.length > 3) refused();
  // Keep the explicit assignment: TypeScript cannot retain the array proof
  // from the compound validation above when this parser is a release build
  // entry under strict mode.
  const rawWorkerList: unknown[] = Array.isArray(rawWorkers) ? rawWorkers : refused();
  const workers = rawWorkerList.map(captureWorker);
  if (new Set(workers.map(worker => worker.workerId)).size !== workers.length
    || new Set(workers.map(worker => worker.kind)).size !== workers.length) refused();
  const material = Object.freeze({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local" as const,
    nodeId: "mac-1" as const, workers: Object.freeze(workers) });
  return Object.freeze({ ...material, enablementDigest: sha256Digest(material) });
}

/** Startup uses a narrowly injected version reader. This check does not start
 * a task and has no fallback: a missing executable or changed version leaves
 * that worker unavailable rather than silently selecting another CLI. One
 * updated CLI must not take down the other workers, so only a startup where no
 * worker verifies is refused. */
export async function verifyOwnerTrustedLocalEnablementV1(enablementValue: unknown,
  readVersion: (executablePath: string) => Promise<string>): Promise<Readonly<{ nodeId: "mac-1";
    enabledWorkerIds: readonly string[]; unavailableWorkerIds: readonly string[] }>> {
  const enablement = captureOwnerTrustedLocalEnablementV1(enablementValue);
  if (typeof readVersion !== "function") refused();
  const enabled: string[] = [], unavailable: string[] = [];
  for (const worker of enablement.workers) {
    let observed: unknown;
    try { observed = await readVersion(worker.executablePath); } catch { observed = undefined; }
    (observed === worker.recordedVersion ? enabled : unavailable).push(worker.workerId);
  }
  if (enabled.length === 0) refused();
  return Object.freeze({ nodeId: "mac-1" as const, enabledWorkerIds: Object.freeze(enabled),
    unavailableWorkerIds: Object.freeze(unavailable) });
}

export function ownerTrustedLocalEnablementDigestV1(value: unknown): string {
  const record = exact(value, ["schema", "mode", "nodeId", "workers", "enablementDigest"]);
  if (typeof record.enablementDigest !== "string") refused();
  const enablement = captureOwnerTrustedLocalEnablementV1({ schema: record.schema, mode: record.mode,
    nodeId: record.nodeId, workers: record.workers });
  if (record.enablementDigest !== enablement.enablementDigest) refused();
  return enablement.enablementDigest;
}
