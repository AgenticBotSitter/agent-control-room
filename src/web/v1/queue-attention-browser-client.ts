import { BrowserRequestError } from "./browser-client";
import { queueAttentionSchema } from "./queue-attention-wire";
import { taskAttentionPageSchema } from "./task-attention-wire";
import { catalogProjectIdSchema } from "./project-wire";

export async function readQueueAttention(transport: typeof fetch = fetch) {
  try { return queueAttentionSchema.parse(await readAttentionJson("/api/v1/needs-me", 4096, transport)); }
  catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
}

export async function readTaskAttention(after?: string, transport: typeof fetch = fetch) {
  if (after !== undefined && !catalogProjectIdSchema.safeParse(after).success) throw new BrowserRequestError("invalid_request");
  try {
    const page = taskAttentionPageSchema.parse(await readAttentionJson(`/api/v1/needs-me/tasks${after ? `?after=${encodeURIComponent(after)}` : ""}`, 65_536, transport));
    if (page.items.some((item, index) => after !== undefined && item.task.jobId <= after
      || index > 0 && item.task.jobId <= page.items[index - 1].task.jobId)
      || page.nextCursor !== null && (page.examined !== 25 || after !== undefined && page.nextCursor <= after
        || page.items.some(item => item.task.jobId > page.nextCursor!))) throw new Error();
    return page;
  } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
}

async function readAttentionJson(path: string, limit: number, transport: typeof fetch) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  try {
    return await Promise.race([(async () => {
      const response = await transport(path, { method: "GET", credentials: "same-origin",
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
        if (bytes.length + value.length > limit) throw new Error();
        for (const byte of value) bytes.push(byte);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 10_000); })]);
  } catch (error) { throw error instanceof BrowserRequestError ? error : new BrowserRequestError("unavailable"); }
  finally { clearTimeout(timer); abort.abort(); void reader?.cancel().catch(() => {}); }
}
