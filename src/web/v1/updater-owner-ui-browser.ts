import { readBrowserJson } from "./browser-json";
import { updaterOwnerAttentionReceiptSchemaV1, updaterOwnerRequestReceiptSchemaV1, updaterOwnerUiReadSchemaV1,
  type UpdaterOwnerAttentionReceiptV1, type UpdaterOwnerControlV1,
  type UpdaterOwnerRequestReceiptV1, type UpdaterOwnerUiReadV1 } from "./updater-owner-ui-wire";

export type UpdaterOwnerUiBrowserReadV1 = { state: "ready"; value: UpdaterOwnerUiReadV1 }
  | { state: "not_configured" } | { state: "unavailable" };

export async function readUpdaterOwnerUiV1(transport: typeof fetch = fetch, signal?: AbortSignal): Promise<UpdaterOwnerUiBrowserReadV1> {
  try {
    const response = await transport("/api/v1/updater-owner-ui", { method: "GET", credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
    if (response.status === 404) return { state: "not_configured" };
    if (!response.ok) return { state: "unavailable" };
    return { state: "ready", value: updaterOwnerUiReadSchemaV1.parse(await readBrowserJson(response, 16_384)) };
  } catch { return { state: "unavailable" }; }
}

export async function sendUpdaterOwnerRequestV1(action: UpdaterOwnerControlV1, planId: string | null, idempotencyKey: string,
  transport: typeof fetch = fetch, signal?: AbortSignal): Promise<UpdaterOwnerRequestReceiptV1> {
  const response = await transport("/api/v1/updater-owner-requests", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest",
      "idempotency-key": idempotencyKey },
    body: JSON.stringify({ action, planId }),
  });
  if (!response.ok) throw new TypeError("updater_owner_request_uncertain");
  const receipt = updaterOwnerRequestReceiptSchemaV1.parse(await readBrowserJson(response, 2048));
  if (receipt.action !== action || receipt.idempotencyKey !== idempotencyKey) throw new Error("updater_owner_receipt_mismatch");
  return receipt;
}

export async function beginUpdaterPasskeyV1(action: "approve" | "rollback", planId: string | null, idempotencyKey: string,
  transport: typeof fetch = fetch, signal?: AbortSignal): Promise<UpdaterOwnerRequestReceiptV1> {
  const response = await transport("/api/v1/updater-owner-passkey", { method: "POST", credentials: "same-origin", cache: "no-store",
    redirect: "error", signal, headers: { accept: "application/json", "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest", "idempotency-key": idempotencyKey }, body: JSON.stringify({ action, planId }) });
  if (!response.ok) throw new TypeError("updater_owner_passkey_uncertain");
  const receipt = updaterOwnerRequestReceiptSchemaV1.parse(await readBrowserJson(response, 2048));
  if (receipt.action !== action || receipt.idempotencyKey !== idempotencyKey) throw new Error("updater_owner_passkey_receipt_mismatch");
  return receipt;
}

/** R7U-01 (lead decision 3): the owner's answer, from the Home card.
 *
 * The body is an EMPTY object and that is the whole design: the page cannot name a
 * run to acknowledge, because the web login is not granted the `run_id` column on
 * `updater.owner_run_attention` and the updater binds the answer to whatever is
 * currently outstanding. There is no idempotency key either, deliberately: this is
 * not an effect on the installation and there is nothing to make idempotent — a
 * second press finds nothing outstanding and is reported as such, which is more
 * honest to the owner than a replayed receipt that says "acknowledged" again.
 *
 * A failed press throws rather than resolving to a state the card would render as
 * cleared. Anything else would show the owner a dismissed card for a failure that
 * never happened.
 */
export async function acknowledgeUpdaterAttentionV1(transport: typeof fetch = fetch, signal?: AbortSignal):
  Promise<UpdaterOwnerAttentionReceiptV1> {
  const response = await transport("/api/v1/updater-owner-attention", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({}) });
  if (!response.ok) throw new TypeError("updater_owner_attention_uncertain");
  return updaterOwnerAttentionReceiptSchemaV1.parse(await readBrowserJson(response, 512));
}
