import { readBrowserJson } from "./browser-json";
import { updaterOwnerRequestReceiptSchemaV1, updaterOwnerUiReadSchemaV1, type UpdaterOwnerControlV1,
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
