import { readBrowserJson } from "./browser-json";
import nextActionsV1 from "../../updater/v1/policy/next-actions.json";
import { UPDATER_RUN_REASON_V1, UPDATER_RUN_STATE_REASON_V1 } from "../../updater/v1/contracts.mjs";
import type { UpdaterHomeStatusV1 } from "./updater-home-status";
export type { UpdaterHomeStatusV1 } from "./updater-home-status";

/** R7U-01: the owner's reason sentence, bounded as one printable line. The SAME
 * bound as the server reader's and the contract's, for the same reason — this is
 * the third end of one contract and a bound present on only two of them is a
 * bound that can be passed. */
const REASON_V1 = /^[^\u0000-\u001f\u007f-\u009f/\\]{1,200}$/u;
/** The same allowlist the server reader and the contract use, for the same reason:
 * the printable-line bound alone would accept a KEY here, so without this the
 * browser would render `review_recovery` as a sentence while the two ends of the
 * contract refused it. MEASURED on the server reader; this is the third end. */
const OWNER_SENTENCES_V1: ReadonlySet<string> = new Set([...Object.values(UPDATER_RUN_REASON_V1),
  ...Object.values(UPDATER_RUN_STATE_REASON_V1)]);

export async function readUpdaterHomeStatusV1(transport: typeof fetch = fetch, signal?: AbortSignal): Promise<UpdaterHomeStatusV1> {
  try {
    const response = await transport("/api/v1/updater-status", { method: "GET", credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
    if (!response.ok) throw new Error();
    // R7U-01: a reason sentence plus a key plus a state does not fit 512 bytes
    // often enough to be safe, so the bound is raised to what the three fields
    // can actually be — and no further. The card is display-only, and an
    // oversized body is refused by the same catch as anything else malformed.
    const value = await readBrowserJson(response, 1_024);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const status = value as Record<string, unknown>;
    if (Object.keys(status).some(key => !["schema", "state", "nextAction", "reason"].includes(key))
      || status.schema !== "control-room.updater-home-status/v1"
      || !["off", "attention", "healthy", "in_progress", "failed_before_switch", "rolled_back", "needs_owner"].includes(String(status.state))
      || status.nextAction !== undefined && (typeof status.nextAction !== "string" || !Object.hasOwn(nextActionsV1, status.nextAction))
      || status.reason !== undefined && (typeof status.reason !== "string" || !REASON_V1.test(status.reason)
        || !OWNER_SENTENCES_V1.has(status.reason))) throw new Error();
    return Object.freeze({ schema: "control-room.updater-home-status/v1", state: status.state as UpdaterHomeStatusV1["state"],
      ...(status.nextAction === undefined ? {} : { nextAction: status.nextAction as UpdaterHomeStatusV1["nextAction"] }),
      ...(status.reason === undefined ? {} : { reason: status.reason as string }) });
  } catch { return Object.freeze({ schema: "control-room.updater-home-status/v1", state: "attention" }); }
}
