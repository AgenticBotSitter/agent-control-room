import { BrowserRequestError, type BrowserFailureCode } from "./browser-client";
import { readBrowserJson } from "./browser-json";
import { operationsModeReceiptSchemaV1, operationsModeSetInputSchemaV1, operationsModeViewSchemaV1,
  type OperationsModeReceiptV1, type OperationsModeViewV1 } from "./operations-mode-wire";

/**
 * Read and set the installation operations mode over the authenticated
 * endpoint. No automatic retry, and no local copy: the server owns the mode, so
 * a second browser, the phone and the workers all see the same state.
 */
export function createOperationsModeBrowserClient(transport: typeof fetch = fetch) {
  let busy = false;
  const failure = (status: number): BrowserFailureCode =>
    ({ 400: "invalid_request", 401: "authentication_required", 403: "access_denied", 404: "not_found",
      409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "uncertain";
  const call = async (method: "GET" | "POST", body?: string, signal?: AbortSignal) => {
    try {
      return await transport("/api/v1/operations-mode", { method, credentials: "same-origin", cache: "no-store",
        redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body }) });
    } catch (error) {
      throw error instanceof BrowserRequestError ? error
        : new BrowserRequestError(method === "GET" ? "unavailable" : "uncertain");
    }
  };
  return {
    async read(signal?: AbortSignal): Promise<OperationsModeViewV1> {
      try {
        const response = await call("GET", undefined, signal);
        if (!response.ok) throw new BrowserRequestError(response.status === 401 || response.status === 403
          ? failure(response.status) : "unavailable");
        const view = operationsModeViewSchemaV1.parse(await readBrowserJson(response));
        // Revision 0 with a non-running mode is not a state the server can hold:
        // it would mean "paused by nobody".
        if (view.revision === 0 && (view.mode !== "running" || view.setAt !== "")) throw new Error();
        return view;
      } catch (error) {
        throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable");
      }
    },
    async set(value: unknown, signal?: AbortSignal): Promise<OperationsModeReceiptV1> {
      const input = operationsModeSetInputSchemaV1.safeParse(value);
      if (!input.success) throw new BrowserRequestError("invalid_request");
      if (busy) throw new BrowserRequestError("uncertain");
      busy = true;
      try {
        const response = await call("POST", JSON.stringify(input.data), signal);
        if (!response.ok) throw new BrowserRequestError(failure(response.status));
        const receipt = operationsModeReceiptSchemaV1.parse(await readBrowserJson(response));
        if (receipt.mode !== input.data.mode || receipt.revision < 1) throw new Error();
        return receipt;
      } catch (error) {
        throw error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
      } finally { busy = false; }
    },
  };
}
