import { BrowserRequestError } from "./browser-client";
import { queueAttentionSchema } from "./queue-attention-wire";

export async function readQueueAttention(transport: typeof fetch = fetch) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  try {
    return await Promise.race([(async () => {
      const response = await transport("/api/v1/needs-me", { method: "GET", credentials: "same-origin",
        cache: "no-store", redirect: "error", signal: abort.signal,
        headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
      if (abort.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      if (response.status === 401) throw new BrowserRequestError("authentication_required");
      if (response.status === 403) throw new BrowserRequestError("access_denied");
      if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
      reader = response.body.getReader();
      const bytes: number[] = [];
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        if (bytes.length + value.length > 4096) throw new Error(); bytes.push(...value);
      }
      return queueAttentionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))));
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 10_000); })]);
  } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
  finally { clearTimeout(timer); abort.abort(); void reader?.cancel().catch(() => {}); }
}
