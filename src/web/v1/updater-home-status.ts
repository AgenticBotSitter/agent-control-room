import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import nextActionsV1 from "../../updater/v1/policy/next-actions.json";
import { UPDATER_RUN_REASON_V1, UPDATER_RUN_STATE_REASON_V1 } from "../../updater/v1/contracts.mjs";
export type UpdaterNextActionV1 = keyof typeof nextActionsV1;

/** This is deliberately a display-only view.  It is not an updater control,
 * approval, health, or release-selection input. */
export const UPDATER_HOME_STATUS_SCHEMA_V1 = "control-room.updater-home-status/v1" as const;
export const UPDATER_PUBLIC_ROOT_V1 = "/Library/Application Support/Control Room";
const STATUS_FILE_V1 = "status/status.json";
const MAX_STATUS_BYTES_V1 = 8_192;
const STALE_AFTER_MS_V1 = 90_000;
const SAFE_ID_V1 = /^[A-Za-z0-9._-]{1,80}$/u;
const UPDATER_STATES_V1 = new Set(["idle", "watching", "building", "awaiting_approval", "running", "rolled_back",
  "uncertain", "attended_upgrade_required", "paused", "stopped", "needs_attention", "refused"]);
const ATTENTION_STATES_V1 = new Set(["uncertain", "attended_upgrade_required", "needs_attention"]);

export type UpdaterHomeStatusV1 = Readonly<{ schema: typeof UPDATER_HOME_STATUS_SCHEMA_V1;
  state: "off" | "attention" | "healthy" | "in_progress" | "failed_before_switch" | "rolled_back" | "needs_owner";
  nextAction?: UpdaterNextActionV1; reason?: string }>;
export type UpdaterHomeStatusReaderV1 = Readonly<{ read(): Promise<UpdaterHomeStatusV1> }>;
type PublicUpdaterStatusV1 = Readonly<{ schema: "control-room.updater-status/v1"; state: string; releaseId: string | null;
  lastHealthAt: string | null; needsYou: boolean; updaterRestartsLastHour: number; selfUpdate: "Off" | "On";
  /** R7U-02: the machine-actionable key, an allowlist member of
   * `policy/next-actions.json`. */
  nextAction?: UpdaterNextActionV1;
  /** R7U-01: the sentence that explains THIS outcome, one of the updater's fixed
   * owner sentences. A DIFFERENT FIELD from `nextAction` and a different kind of
   * value — that separation is the whole point of the merge, because one field
   * cannot hold an allowlisted key and free text without one of the two becoming
   * the channel. */
  reason?: string }>;
/** R7U-01: the owner's reason, bounded as one printable line. It is validated
 * here rather than trusted from the file, because this reader's whole job is to
 * be a display-only view of bytes somebody else wrote — the same discipline as
 * every other field in `isPublicStatus`. A sentence that is empty, over-long, or
 * carries a control byte, a path separator or a backslash is REFUSED, which lands
 * this file on the `attention` display rather than letting a malformed
 * instruction reach the card.
 *
 * THE SAME BOUND, WORD FOR WORD, AS `publicStatusV1`'s. That is deliberate: the
 * writer and this reader are two ends of one contract, and a bound that exists on
 * only one of them is a bound that can be passed. */
const REASON_V1 = /^[^\u0000-\u001f\u007f-\u009f/\\]{1,200}$/u;
/** R7U-01: the ALLOWLIST of fixed owner sentences, built from the updater's own
 * two tables rather than restated here — so a word added to a table is accepted by
 * construction and one removed is refused by construction, with no third list to
 * forget.
 *
 * IT IS NOT OPTIONAL. The printable-line bound above accepts any 200 characters, so
 * on its own it would have let a KEY through the `reason` field — which is what the
 * first version of this reader did, and the test caught: the merged contract
 * refuses `reason: "review_recovery"` while the reader rendered it. MEASURED.
 * The two ends of one contract must agree on which words are owner sentences.
 *
 * The import crosses from the updater's own module, which the packaging rule allows
 * (this reader already imports that module's policy file for the key allowlist). */
const OWNER_SENTENCES_V1: ReadonlySet<string> = new Set([...Object.values(UPDATER_RUN_REASON_V1),
  ...Object.values(UPDATER_RUN_STATE_REASON_V1)]);

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
  const allowed = new Set(["schema", "state", "releaseId", "lastHealthAt", "needsYou", "updaterRestartsLastHour",
    "selfUpdate", "nextAction", "reason"]);
  if (Object.keys(value).some(key => !allowed.has(key)) || value.schema !== "control-room.updater-status/v1"
    || typeof value.state !== "string" || !UPDATER_STATES_V1.has(value.state)
    || value.releaseId !== null && (typeof value.releaseId !== "string" || !SAFE_ID_V1.test(value.releaseId))
    || !validTimestamp(value.lastHealthAt) || typeof value.needsYou !== "boolean"
    || !Number.isInteger(value.updaterRestartsLastHour) || Number(value.updaterRestartsLastHour) < 0 || Number(value.updaterRestartsLastHour) > 3
    // R7U-02: the key, against the same allowlist the writer checked. An ABSENT
    // key is the ordinary healthy case and reads as "no action" rather than as a
    // refusal: requiring it was measured and it made a status file written by the
    // previous build read as `attention` forever, which turns a rollout into a
    // permanently alarming Home card on exactly the machines with the old file.
    || value.nextAction !== undefined && (typeof value.nextAction !== "string" || !Object.hasOwn(nextActionsV1, value.nextAction))
    // R7U-01: the sentence, bounded as one printable line. Absent is ordinary and
    // cannot make a failure invisible, because `needsYou` and the STATE are
    // validated independently above and the state is what names the failure. A
    // PRESENT reason must still be printable, one line, with no path — that is
    // what keeps this field from becoming a channel.
    || value.reason !== undefined && (typeof value.reason !== "string" || !REASON_V1.test(value.reason)
      || !OWNER_SENTENCES_V1.has(value.reason))
    // `selfUpdate` is the LAST clause, and that position is load-bearing rather than
    // incidental: `mutation-checks/cook-hard12.json` anchors this exact line as the
    // last check before `return false`, and moving it into the middle broke two
    // anchors in another branch's manifest with `find matched 0 times`. The
    // verifier refuses to run on an unmatched anchor, which is the right refusal —
    // a manifest that no longer describes the code is a manifest nobody trusts —
    // but the cheaper fix is to leave the line where the manifests expect it.
    || !["Off", "On"].includes(String(value.selfUpdate))) return false;
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
      if (!isPublicStatus(value)) return attention();
      // Both halves travel to the card, and neither is derived here: this reader
      // projects bytes, it does not decide what they mean.
      const detail = { ...(value.nextAction === undefined ? {} : { nextAction: value.nextAction }),
        ...(value.reason === undefined ? {} : { reason: value.reason }) };
      if (value.selfUpdate === "Off") return Object.freeze({ ...(value.needsYou || ATTENTION_STATES_V1.has(value.state) ? attention() : off()), ...detail });
      const state = value.needsYou || ATTENTION_STATES_V1.has(value.state) ? "needs_owner"
        : value.state === "refused" ? "failed_before_switch"
        : value.state === "rolled_back" ? "rolled_back"
        : value.state === "idle" ? "healthy"
        : ["paused", "stopped"].includes(value.state) ? "needs_owner" : "in_progress";
      return Object.freeze({ schema: UPDATER_HOME_STATUS_SCHEMA_V1, state, ...detail });
    } catch { return attention(); }
  } });
}
