import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitHubWorkerBroker } from "./worker-broker";
import type { PostgresGitHubWorkerWakeStore } from "./postgres-wake-store";
import type { GitHubWorkerOperationInput, GitHubWorkerOperations } from "./worker-operations";

const MAX_BODY_BYTES = 1_048_576;
const MAX_OPERATION_BODY_BYTES = 8_192;
const RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
});

type WorkerAuthorizer = (request: IncomingMessage) => boolean | Promise<boolean>;

function send(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { ...RESPONSE_HEADERS, connection: "close" });
  response.end(JSON.stringify(body));
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

async function bodyOf(request: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) return undefined;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

/** Projects a caller's JSON onto the finite operation input surface. Unknown fields never travel. */
function operationInput(raw: unknown): GitHubWorkerOperationInput | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.operation !== "string" || !value.operation) return undefined;
  const input: Record<string, unknown> = { operation: value.operation };
  for (const key of ["workerId", "head"] as const) {
    if (typeof value[key] === "string") input[key] = value[key];
  }
  for (const key of ["issue", "pr", "previous"] as const) {
    if (Number.isSafeInteger(value[key])) input[key] = value[key];
  }
  return Object.freeze(input) as GitHubWorkerOperationInput;
}

const REFUSAL_STATUS: Readonly<Record<string, number>> = Object.freeze({
  worker_operation_forbidden: 403,
  worker_identity_invalid: 400,
  worker_command_invalid: 400,
  worker_command_too_large: 413,
  worker_claim_conflict: 409,
  worker_claim_mismatch: 409,
});

function statusFor(result: Readonly<{ ok: boolean; code?: unknown }>): number {
  if (result.ok) return 200;
  return typeof result.code === "string" ? (REFUSAL_STATUS[result.code] ?? 502) : 502;
}

/** Inert Node request bridge. The loopback service owns the physical listener. */
export function createGitHubWorkerBrokerNodeBridge({ broker, wakeStore, authorizeWorker, operations,
  close = async () => {}, isReady = () => true }: {
  broker: GitHubWorkerBroker;
  wakeStore: PostgresGitHubWorkerWakeStore;
  authorizeWorker: WorkerAuthorizer;
  /** Worker-facing operations. Absent means the routes answer 503 rather than 404. */
  operations?: GitHubWorkerOperations;
  close?: () => Promise<void>;
  isReady?: () => boolean;
}) {
  let ready = true;
  return Object.freeze({
    isReady: () => ready && isReady(),
    async close(): Promise<void> { if (!ready) return; ready = false; await close(); },
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (!ready) { send(response, 503, { ok: false }); return; }
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
      catch { send(response, 400, { ok: false }); return; }
      if (request.method === "GET" && url.pathname === "/healthz") {
        try { await wakeStore.probe(); send(response, 200, { ok: true }); }
        catch { send(response, 503, { ok: false }); }
        return;
      }
      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        const contentLength = header(request, "content-length");
        if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
          send(response, 413, { ok: false }); return;
        }
        const body = await bodyOf(request);
        if (!body) { send(response, 413, { ok: false }); return; }
        let result;
        try {
          result = await broker.receive({ body, headers: {
            "x-hub-signature-256": header(request, "x-hub-signature-256"),
            "x-github-delivery": header(request, "x-github-delivery"),
            "x-github-event": header(request, "x-github-event"),
          } });
        } catch { send(response, 503, { ok: false }); return; }
        if (!result.accepted) { send(response, result.status, { ok: false }); return; }
        send(response, 202, { ok: true, wake: result.wake }); return;
      }
      if (request.method === "GET" && url.pathname === "/v1/worker-wake-hints") {
        let authorized = false;
        try { authorized = await authorizeWorker(request); } catch { authorized = false; }
        if (!authorized) { send(response, 401, { ok: false }); return; }
        const cursor = url.searchParams.get("after") ?? "0";
        try {
          const hints = await wakeStore.readAfter(cursor);
          send(response, 200, { ok: true, hints });
        } catch (error) {
          send(response, error instanceof Error && error.message === "github_worker_wake_cursor_invalid" ? 400 : 503,
            { ok: false });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/worker-operations") {
        let authorized = false;
        try { authorized = await authorizeWorker(request); } catch { authorized = false; }
        if (!authorized) { send(response, 401, { ok: false }); return; }
        if (!operations) { send(response, 503, { ok: false, code: "worker_operations_unavailable" }); return; }
        const contentLength = header(request, "content-length");
        if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_OPERATION_BODY_BYTES)) {
          send(response, 413, { ok: false }); return;
        }
        const body = await bodyOf(request, MAX_OPERATION_BODY_BYTES);
        if (!body) { send(response, 413, { ok: false }); return; }
        let input: GitHubWorkerOperationInput | undefined;
        try { input = operationInput(JSON.parse(body.toString("utf8"))); } catch { input = undefined; }
        if (!input) { send(response, 400, { ok: false, code: "worker_operation_request_invalid" }); return; }
        let result;
        try { result = await operations.run(input); }
        catch { send(response, 502, { ok: false, code: "worker_operations_failed" }); return; }
        send(response, statusFor(result), result); return;
      }
      send(response, 404, { ok: false });
    },
  });
}
