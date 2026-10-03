import { parseStrictJsonV1 } from "../../installer/shared/strict-json.mjs";
import { WebAccessError } from "./access-verifier";

export const privateResponseHeaders = {
  "cache-control": "no-store", "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
};

export function webFailure(error: unknown): Response {
  const code = error instanceof WebAccessError ? error.code : "service_unavailable";
  const status = { authentication_required: 401, access_denied: 403, invalid_request: 400,
    conflict: 409, queue_depth_exceeded: 409, flagged_items_unresolved: 409, not_found: 404,
    service_unavailable: 503 }[code];
  return Response.json({ error: code }, { status, headers: privateResponseHeaders });
}

/** Bounded byte and time consumption; cancellation is requested, never awaited indefinitely.
 *
 * Duplicate member names are refused before any consumer sees a value, including
 * escaped spellings of the same name (`co\u0064e` next to `code`): native
 * `JSON.parse` keeps the LAST occurrence and a reviver cannot see the earlier one,
 * so a route that read `body.ownerCode` would authenticate one value while the
 * owner reviewed another. `parseStrictJsonV1` walks the text itself and throws a
 * bounded `SyntaxError`, which the same refusal below translates into the one
 * `invalid_request` every caller already handles. The byte and time bounds above
 * it are unchanged, and fatal UTF-8 decoding still happens on the real bytes.
 */
export async function readBoundedJson(body: ReadableStream<Uint8Array>, limit: number, timeoutMs = 5000): Promise<unknown> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new WebAccessError("invalid_request")); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new WebAccessError("invalid_request");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      // The strict walk counts its own bytes against the same limit the reader
      // enforced, so a boundary can never be widened by the decode step.
      return parseStrictJsonV1(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), { maxBytes: limit });
    })()]);
  } catch {
    void reader.cancel().catch(() => {});
    throw new WebAccessError("invalid_request");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
