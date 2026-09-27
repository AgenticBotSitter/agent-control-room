import type { IncomingMessage, ServerResponse } from "node:http";
import { parseStrictJsonObjectV1 } from "../../project-coordination/v1/strict-json";
import type { WorkIntakeCredentialVerifierPortV1 } from "./credential";
import { readWorkIntakeBearerV1 } from "./machine-auth";
import type { WorkBatchServiceV1 } from "./service";

export const WORK_INTAKE_MAX_BODY_BYTES_V1 = 256 * 1024;
const projectRoute = /^\/v1\/projects\/([^/]+)\/work-batches$/u;
const statusRoute = /^\/v1\/projects\/([^/]+)\/work-batches\/([^/]+)$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const responseHeaders = Object.freeze({ "cache-control": "no-store", "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer" });

function send(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { ...responseHeaders, connection: "close" }); response.end(JSON.stringify(body));
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]; return typeof value === "string" ? value : undefined;
}
function pathId(raw: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new Error("work_intake_route_refused"); }
  if (!idPattern.test(decoded) || encodeURIComponent(decoded) !== raw) throw new Error("work_intake_route_refused");
  return decoded;
}
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
    if (length > WORK_INTAKE_MAX_BODY_BYTES_V1) return undefined;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}
function exactBody(raw: string): { idempotencyKey: string; rawProposal: string } {
  const parsed = parseStrictJsonObjectV1(raw), keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "idempotencyKey,proposal" || typeof parsed.idempotencyKey !== "string"
    || !parsed.proposal || typeof parsed.proposal !== "object" || Array.isArray(parsed.proposal))
    throw new Error("work_intake_body_refused");
  return { idempotencyKey: parsed.idempotencyKey, rawProposal: JSON.stringify(parsed.proposal) };
}

/** Inert request bridge; the shared private listener owns the loopback socket. */
export function createWorkIntakeNodeBridgeV1(input: Readonly<{ verifier: WorkIntakeCredentialVerifierPortV1;
  service: WorkBatchServiceV1; now(): string; close?(): Promise<void>; isReady?(): boolean }>) {
  let ready = true;
  return Object.freeze({
    isReady: () => ready && (input.isReady?.() ?? true),
    async close() { if (!ready) return; ready = false; await input.close?.(); },
    async handle(request: IncomingMessage, response: ServerResponse) {
      if (!ready) { send(response, 503, { ok: false }); return; }
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
      catch { send(response, 400, { ok: false }); return; }
      if (url.search || url.hash) { send(response, 404, { ok: false }); return; }
      const match = request.method === "GET" ? statusRoute.exec(url.pathname) ?? projectRoute.exec(url.pathname)
        : request.method === "POST" ? projectRoute.exec(url.pathname) : null;
      if (!match) { send(response, 404, { ok: false }); return; }
      let projectId: string, batchId: string | undefined;
      try { projectId = pathId(match[1]!); batchId = match[2] ? pathId(match[2]) : undefined; }
      catch { send(response, 404, { ok: false }); return; }
      let principal; const now = input.now();
      try {
        if (!Number.isFinite(Date.parse(now))) throw new Error();
        principal = await input.verifier.verify(readWorkIntakeBearerV1(header(request, "authorization")), now);
        const authorization = await input.service.authorizeBeforeBody(principal, projectId, now);
        if (!authorization.allowed) throw new Error();
      } catch { send(response, 401, { ok: false }); return; }
      const refuseEnvelope = async (status: number, reasonCode: string) => {
        await input.service.recordEnvelopeRefusal(principal, projectId, reasonCode, now);
        send(response, status, { ok: false });
      };
      if (request.method === "POST") {
        const length = header(request, "content-length");
        if ((length && (!/^\d+$/u.test(length) || Number(length) > WORK_INTAKE_MAX_BODY_BYTES_V1))
          || header(request, "content-type") !== "application/json") {
          await refuseEnvelope(413, length && (!/^\d+$/u.test(length)
            || Number(length) > WORK_INTAKE_MAX_BODY_BYTES_V1) ? "http_body_over_limit" : "http_content_type_refused");
          return;
        }
        let raw: string | undefined;
        try { raw = await readBody(request); }
        catch { await refuseEnvelope(400, "http_body_read_refused"); return; }
        if (raw === undefined) { await refuseEnvelope(413, "http_body_over_limit"); return; }
        let body: ReturnType<typeof exactBody>;
        try { body = exactBody(raw); }
        catch { await refuseEnvelope(400, "http_envelope_invalid"); return; }
        try {
          const result = await input.service.submit({ principal, projectId, ...body, now });
          send(response, "accepted" in result && result.accepted === false ? 422 : 202, { ok: true, result });
        } catch { send(response, 400, { ok: false }); }
        return;
      }
      if ((Number(header(request, "content-length") ?? "0") || header(request, "transfer-encoding"))) {
        send(response, 400, { ok: false }); return;
      }
      try {
        const result = batchId ? await input.service.status({ principal, projectId, batchId, now })
          : await input.service.list({ principal, projectId, now });
        send(response, 200, { ok: true, result });
      } catch { send(response, 404, { ok: false }); }
    },
  });
}
