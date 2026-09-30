import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** This is deliberately a display-only view.  It is not an updater control,
 * approval, health, or release-selection input. */
export const UPDATER_HOME_STATUS_SCHEMA_V1 = "control-room.updater-home-status/v1" as const;
export const UPDATER_PUBLIC_ROOT_V1 = "/Library/Application Support/Control Room";
const STATUS_FILE_V1 = "status/status.json";
const MAX_STATUS_BYTES_V1 = 8_192;
const STALE_AFTER_MS_V1 = 90_000;
const SAFE_ID_V1 = /^[A-Za-z0-9._-]{1,80}$/u;
const UPDATER_STATES_V1 = new Set(["idle", "watching", "building", "awaiting_approval", "running", "rolled_back",
  "uncertain", "attended_upgrade_required", "paused", "stopped", "needs_attention"]);
const ATTENTION_STATES_V1 = new Set(["uncertain", "attended_upgrade_required", "needs_attention"]);

export type UpdaterHomeStatusV1 = Readonly<{ schema: typeof UPDATER_HOME_STATUS_SCHEMA_V1; state: "off" | "attention" }>;
export type UpdaterHomeStatusReaderV1 = Readonly<{ read(): Promise<UpdaterHomeStatusV1> }>;
type PublicUpdaterStatusV1 = Readonly<{ schema: "control-room.updater-status/v1"; state: string; releaseId: string | null;
  lastHealthAt: string | null; needsYou: boolean; updaterRestartsLastHour: number; selfUpdate: "Off" }>;

const off = (): UpdaterHomeStatusV1 => Object.freeze({ schema: UPDATER_HOME_STATUS_SCHEMA_V1, state: "off" });
const attention = (): UpdaterHomeStatusV1 => Object.freeze({ schema: UPDATER_HOME_STATUS_SCHEMA_V1, state: "attention" });

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validTimestamp(value: unknown): boolean {
  return value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Validate the updater's item-8 public allowlist. Extra fields are rejected
 * rather than becoming a second accidental public API. */
function isPublicStatus(value: unknown): value is PublicUpdaterStatusV1 {
  if (!plainObject(value)) return false;
  const allowed = new Set(["schema", "state", "releaseId", "lastHealthAt", "needsYou", "updaterRestartsLastHour", "selfUpdate"]);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.schema !== "control-room.updater-status/v1"
    || typeof value.state !== "string" || !UPDATER_STATES_V1.has(value.state)
    || value.releaseId !== null && (typeof value.releaseId !== "string" || !SAFE_ID_V1.test(value.releaseId))
    || !validTimestamp(value.lastHealthAt) || typeof value.needsYou !== "boolean"
    || !Number.isInteger(value.updaterRestartsLastHour) || Number(value.updaterRestartsLastHour) < 0 || Number(value.updaterRestartsLastHour) > 3
    // Install-night Home is intentionally an Off-only surface. An unexpected
    // On value cannot turn into reassuring copy.
    || value.selfUpdate !== "Off") return false;
  return true;
}

async function readNoFollowStatusV1(root: string): Promise<{ text: string; modifiedAtMs: number }> {
  if (!isAbsolute(root)) throw new Error("updater_home_status_root_refused");
  for (const path of [root, join(root, "status")]) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("updater_home_status_path_refused");
  }
  const path = join(root, STATUS_FILE_V1);
  // O_NONBLOCK: a FIFO planted at the status path must be refused by the isFile() check below,
  // not block this open forever waiting for a writer.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.size < 2 || entry.size > MAX_STATUS_BYTES_V1)
      throw new Error("updater_home_status_file_refused");
    return { text: await handle.readFile("utf8"), modifiedAtMs: entry.mtimeMs };
  } finally { await handle.close(); }
}

/** Fail closed to an attention display for an absent, malformed, symlinked,
 * stale or unexpected file. The caller gets no release id or raw updater data. */
export function createUpdaterHomeStatusReaderV1(input: Readonly<{ root?: string; now?: () => number;
  staleAfterMs?: number }> = {}): UpdaterHomeStatusReaderV1 {
  const root = input.root ?? UPDATER_PUBLIC_ROOT_V1, now = input.now ?? Date.now,
    staleAfterMs = input.staleAfterMs ?? STALE_AFTER_MS_V1;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1 || staleAfterMs > 300_000) throw new Error("updater_home_status_config_refused");
  return Object.freeze({ async read() {
    try {
      const file = await readNoFollowStatusV1(root), current = now();
      if (!Number.isFinite(current) || current - file.modifiedAtMs > staleAfterMs || file.modifiedAtMs - current > 10_000)
        return attention();
      const value = JSON.parse(file.text) as unknown;
      if (!isPublicStatus(value) || value.needsYou || ATTENTION_STATES_V1.has(value.state)) return attention();
      return off();
    } catch { return attention(); }
  } });
}
