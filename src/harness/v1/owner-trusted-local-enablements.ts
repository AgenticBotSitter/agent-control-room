import { isAbsolute, normalize } from "node:path";
import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";

export const OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 =
  "control-room.owner-trusted-local-enablement/v1" as const;

export type OwnerTrustedLocalWorkerKindV1 = "codex" | "hermes-021" | "claude-code";

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

/** Captures the simple, owner-accepted local trust record. It intentionally
 * grants neither delivery nor execution: a caller must still hold a current
 * canonical queue delivery before it may use a listed executable. */
export function captureOwnerTrustedLocalEnablementV1(value: unknown): OwnerTrustedLocalEnablementV1 {
  const record = exact(value, ["schema", "mode", "nodeId", "workers"]);
  if (record.schema !== OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 || record.mode !== "mac-local" || record.nodeId !== "mac-1"
    || !Array.isArray(record.workers) || record.workers.length < 1 || record.workers.length > 3) refused();
  const workers = record.workers.map(value => {
    const item = exact(value, ["workerId", "kind", "executablePath", "recordedVersion"]);
    if (typeof item.workerId !== "string" || !workerId.test(item.workerId)
      || (item.kind !== "codex" && item.kind !== "hermes-021" && item.kind !== "claude-code")
      || !safePath(item.executablePath) || typeof item.recordedVersion !== "string" || !safeVersion.test(item.recordedVersion)) refused();
    return Object.freeze({ workerId: item.workerId, kind: item.kind, executablePath: item.executablePath,
      recordedVersion: item.recordedVersion }) as const;
  });
  if (new Set(workers.map(worker => worker.workerId)).size !== workers.length
    || new Set(workers.map(worker => worker.kind)).size !== workers.length) refused();
  const material = Object.freeze({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local" as const,
    nodeId: "mac-1" as const, workers: Object.freeze(workers) });
  return Object.freeze({ ...material, enablementDigest: sha256Digest(material) });
}

/** Startup uses a narrowly injected version reader. This check does not start
 * a task and has no fallback: a missing executable or changed version leaves
 * the worker unavailable rather than silently selecting another CLI. */
export async function verifyOwnerTrustedLocalEnablementV1(enablementValue: unknown,
  readVersion: (executablePath: string) => Promise<string>): Promise<Readonly<{ nodeId: "mac-1"; enabledWorkerIds: readonly string[] }>> {
  const enablement = captureOwnerTrustedLocalEnablementV1(enablementValue);
  if (typeof readVersion !== "function") refused();
  for (const worker of enablement.workers) {
    let observed: unknown;
    try { observed = await readVersion(worker.executablePath); } catch { refused(); }
    if (observed !== worker.recordedVersion) refused();
  }
  return Object.freeze({ nodeId: "mac-1" as const, enabledWorkerIds: Object.freeze(enablement.workers.map(worker => worker.workerId)) });
}

export function ownerTrustedLocalEnablementDigestV1(value: unknown): string {
  const record = exact(value, ["schema", "mode", "nodeId", "workers", "enablementDigest"]);
  if (typeof record.enablementDigest !== "string") refused();
  const enablement = captureOwnerTrustedLocalEnablementV1({ schema: record.schema, mode: record.mode,
    nodeId: record.nodeId, workers: record.workers });
  if (record.enablementDigest !== enablement.enablementDigest) refused();
  return enablement.enablementDigest;
}
