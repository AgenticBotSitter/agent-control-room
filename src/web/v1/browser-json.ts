// Shared browser-only response reader, extracted from the task client. No server imports.
export async function readBrowserJson(response: Response, limit = 1_048_576, timeoutMs = 10_000): Promise<unknown> {
  if (!response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new Error("invalid_json_response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("json_response_timeout")), timeoutMs);
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("json_response_too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(timer);
    // Cleanup must not wait for an unresponsive producer's cancellation promise.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
