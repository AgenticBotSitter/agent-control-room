import { WebAccessError } from "./access-verifier";

export const privateResponseHeaders = {
  "cache-control": "no-store", "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
};

export function webFailure(error: unknown): Response {
  const code = error instanceof WebAccessError ? error.code : "service_unavailable";
  const status = { authentication_required: 401, access_denied: 403, invalid_request: 400,
    conflict: 409, not_found: 404, service_unavailable: 503 }[code];
  return Response.json({ error: code }, { status, headers: privateResponseHeaders });
}

/** Bounded byte and time consumption; cancellation is requested, never awaited indefinitely. */
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
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    })()]);
  } catch {
    void reader.cancel().catch(() => {});
    throw new WebAccessError("invalid_request");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
