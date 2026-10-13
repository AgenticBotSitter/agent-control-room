import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { assertNoSymlinkBelowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { UPDATER_RUN_REASON_V1 } from "./contracts.mjs";

/**
 * FIX-475: the ONE durable record of the history hold.
 *
 * A source recheck that cannot trust the update copy's history HOLDS every
 * update until a later recheck succeeds. Earlier rounds kept that fact in two
 * files and let a read promote one into the other; every interleaving of the
 * two became a new defect (R5-01, R6-01, R7-01). Here there is one file and one
 * serialized writer per process, and every record carries a generation:
 *
 * - a refusal ALWAYS writes generation + 1, held;
 * - a clearance applies only when the generation is still the one observed when
 *   its recheck started, so a late or concurrent clearance can never overwrite a
 *   newer refusal, and nothing older can be promoted over a newer clearance;
 * - anything that cannot be read as a valid record is HELD, and is replaced by
 *   the next successful write.
 *
 * The record lives in `status/` beside the status card. Both directories are
 * root-only for writing (installer createLayoutV1), and sharing the card's
 * directory means a hold that cannot be recorded is also a card that cannot be
 * refreshed, which Home already shows as attention once it is stale.
 */
export const HISTORY_HOLD_RECORD_V1 = "status/history-hold.json";
export const HISTORY_HOLD_SCHEMA_V1 = "control-room.watcher-hold/v2";
export const HISTORY_HOLD_CODES_V1 = Object.freeze(["watcher_history_unproven"]);
const HELD = "watcher_history_unproven";

// Files written by earlier versions. They are read once, while no record
// exists, and never written again.
const LEGACY_HOLD_V1 = "updater-state/watcher-hold.json";
const LEGACY_RETRY_V1 = "status/watcher-hold-retry.json";
const LEGACY_STATUS_V1 = "status/status.json";

const unreadable = Symbol("unreadable");

function parseRecordV1(text) {
  let value;
  try { value = JSON.parse(text); } catch { return unreadable; }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "code,generation,schema"
      || value.schema !== HISTORY_HOLD_SCHEMA_V1
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !(value.code === null || HISTORY_HOLD_CODES_V1.includes(value.code))) return unreadable;
  return { generation: value.generation, code: value.code };
}

/** The record, `null` when absent, or `unreadable` (fail closed) for anything else. */
async function readRecordV1(root) {
  let text;
  try { text = await readFileNoFollowV1(root, HISTORY_HOLD_RECORD_V1, { maxBytes: 256 }); }
  catch (error) { return error?.code === "ENOENT" ? null : unreadable; }
  return parseRecordV1(text);
}

/** Temp file, fsync, rename over the leaf, fsync the directory. `rename`
 * replaces a planted symlink or extra hard link as a directory entry without
 * following it, so such a record is repaired rather than pinned. */
async function writeRecordV1(root, record) {
  await mkdir(join(root, "status"), { recursive: false }).catch(error => { if (error?.code !== "EEXIST") throw error; });
  const parent = await assertNoSymlinkBelowV1(root, "status");
  const target = join(parent, "history-hold.json");
  const temporary = join(parent, `.history-hold.json.${process.pid}.${randomBytes(8).toString("hex")}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0), 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify({ schema: HISTORY_HOLD_SCHEMA_V1, generation: record.generation,
      code: record.code })}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
    renamed = true;
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close().catch(() => {});
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

/** Old evidence, folded once: a hold anywhere (or an unreadable hold file) is held. */
async function foldLegacyV1(root) {
  for (const path of [LEGACY_HOLD_V1, LEGACY_RETRY_V1]) {
    let value;
    try { value = JSON.parse(await readFileNoFollowV1(root, path, { maxBytes: 256 })); }
    catch (error) { if (error?.code === "ENOENT") continue; return HELD; }
    if (value?.schema !== "control-room.watcher-hold/v1" || value.code !== null) return HELD;
  }
  // The status card is a display cache, never authority (R7U-01): only a card
  // that really carries the history sentence is evidence; a damaged one is not.
  let status;
  try { status = JSON.parse(await readFileNoFollowV1(root, LEGACY_STATUS_V1, { maxBytes: 8192 })); }
  catch { return null; }
  return status?.schema === "control-room.updater-status/v1"
    && status.reason === UPDATER_RUN_REASON_V1.watcher_history_unproven ? HELD : null;
}

export class HistoryHoldV1 {
  #root; #serial = Promise.resolve();
  // generation 0 with code null means "no record exists, and none is needed".
  #memory = null;
  constructor(root) { this.#root = root; }

  #run(operation) {
    const result = this.#serial.then(async () => {
      let error;
      try {
        if (this.#memory === null) error = await this.#load();
        error = (await operation()) ?? error;
      } catch (failure) {
        // An unexpected failure is never read as clear.
        this.#memory = { generation: (this.#memory?.generation ?? 0) + 1, code: HELD, durable: false };
        error = failure;
      }
      return Object.freeze({ generation: this.#memory.generation, code: this.#memory.code,
        durable: this.#memory.durable, ...(error ? { error } : {}) });
    });
    this.#serial = result.catch(() => {});
    return result;
  }

  async #persist() {
    try { await writeRecordV1(this.#root, this.#memory); this.#memory.durable = true; return undefined; }
    catch (error) { return error; }
  }

  async #load() {
    const disk = await readRecordV1(this.#root);
    if (disk === unreadable) {
      this.#memory = { generation: 1, code: HELD, durable: false };
      return this.#persist();
    }
    if (disk !== null) { this.#memory = { ...disk, durable: true }; return undefined; }
    const folded = await foldLegacyV1(this.#root);
    if (folded === null) { this.#memory = { generation: 0, code: null, durable: true }; return undefined; }
    this.#memory = { generation: 1, code: folded, durable: false };
    return this.#persist();
  }

  /** Fail closed: hold at a generation above everything seen. */
  #failClosed(disk) {
    this.#memory = { generation: Math.max(this.#memory.generation, disk?.generation ?? 0) + 1, code: HELD, durable: false };
  }

  /** Start of every tick: verify the durable record, or retry a pending hold. */
  observe() {
    return this.#run(async () => {
      const disk = await readRecordV1(this.#root), memory = this.#memory;
      if (!memory.durable) {
        if (disk !== null && disk !== unreadable && disk.generation >= memory.generation) {
          if (disk.generation === memory.generation && disk.code === memory.code) { memory.durable = true; return undefined; }
          memory.generation = disk.generation + 1;
        }
        return this.#persist();
      }
      if (disk === null ? memory.generation === 0
        : disk !== unreadable && disk.generation === memory.generation && disk.code === memory.code) return undefined;
      if (disk !== null && disk !== unreadable && disk.generation > memory.generation) {
        this.#memory = { ...disk, durable: true }; return undefined;
      }
      this.#failClosed(disk === unreadable ? null : disk);
      return this.#persist();
    });
  }

  /** A source recheck refused history: always a new, newer hold. */
  refuse(code) {
    return this.#run(async () => {
      if (!HISTORY_HOLD_CODES_V1.includes(code)) throw new Error("history_hold_code_refused");
      const disk = await readRecordV1(this.#root);
      this.#memory = { generation: Math.max(this.#memory.generation,
        disk !== null && disk !== unreadable ? disk.generation : 0) + 1, code, durable: false };
      return this.#persist();
    });
  }

  /** A source recheck succeeded. It clears only the hold it started against. */
  clear(startGeneration) {
    return this.#run(async () => {
      const disk = await readRecordV1(this.#root), memory = this.#memory;
      if (disk !== null && disk !== unreadable && disk.generation > memory.generation) {
        // Someone else wrote after this recheck started: never clear over it,
        // and a pending hold of our own still outranks it.
        if (memory.durable) { this.#memory = { ...disk, durable: true }; return undefined; }
        memory.generation = disk.generation + 1;
        return this.#persist();
      }
      if (memory.generation !== startGeneration) return undefined;
      if (memory.durable && (disk === unreadable || (disk === null && memory.generation !== 0)
          || (disk !== null && (disk.generation !== memory.generation || disk.code !== memory.code)))) {
        this.#failClosed(disk === unreadable ? null : disk);
        return this.#persist();
      }
      if (memory.code === null && memory.durable) return undefined;
      const cleared = { generation: memory.generation + 1, code: null, durable: false };
      try { await writeRecordV1(this.#root, cleared); }
      catch (error) { return error; }
      this.#memory = { ...cleared, durable: true };
      return undefined;
    });
  }
}
