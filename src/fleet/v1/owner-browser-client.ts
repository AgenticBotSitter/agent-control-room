import { z } from "zod";
import { readBrowserJson } from "../../web/v1/browser-json";

const text = z.string();
const worker = z.object({ workerId: text, displayName: text, workerKind: text,
  status: z.enum(["working", "connected", "offline", "revoked", "needs_new_key"]), lastSeenAt: text.nullable() });
const latestNote = z.object({ kind: z.enum(["progress", "blocker"]), message: text, occurredAt: text, taskTitle: text });
const release = z.object({ version: text, file: text, sha256: text, size: z.number().int().nonnegative(), builtFrom: text });
export const fleetBoardSchemaV1 = z.object({
  workers: z.array(worker.extend({ projectIds: z.array(text), capabilities: z.array(text),
    maxConcurrent: z.number().int().positive(), activeClaims: z.number().int().nonnegative(),
    platform: text.nullable(), credentialExpiresAt: text.nullable(), latestNote: latestNote.nullable().optional() })),
  pendingCodes: z.array(z.object({ codeId: text, displayName: text, purpose: text, expiresAt: text })),
  results: z.array(z.object({ resultId: text, projectId: text, workerName: text, title: text, summary: text,
    fileCount: z.number().int().nonnegative(), submittedAt: text, decision: text.nullable(), note: text.nullable() })),
  gatewayConfigured: z.boolean(),
});
export const connectBoardSchemaV1 = z.object({ workers: z.array(worker),
  pendingCodes: z.array(z.object({ codeId: text, displayName: text, purpose: text, expiresAt: text })),
  connectBot: z.object({ available: z.boolean(), release: release.optional() }) });
export const fleetResultFilesSchemaV1 = z.array(z.object({ ordinal: z.number().int().min(1).max(8),
  fileName: text, sizeBytes: z.number().int().nonnegative() })).max(8);
export const fleetIssuedSchemaV1 = z.object({ code: text, expiresAt: text, purpose: text,
  commands: z.object({ unix: text, windows: text }).optional() });
export const connectResultSchemaV1 = z.object({ codeId: text, workerId: text, expiresAt: text,
  operatingSystem: z.enum(["macos", "windows", "linux"]), botKind: z.enum(["claude-code", "codex", "hermes", "cursor", "claude-desktop", "mcp-agent"]),
  profileName: text, unattended: z.boolean(), ownerNextStep: text, release, installLine: text });

export class FleetBrowserRequestErrorV1 extends Error {
  constructor(readonly refused: boolean, readonly status?: number) { super("Fleet information could not be confirmed."); }
}
export async function fleetBrowserRequestV1(path: string, body?: unknown, signal?: AbortSignal) {
  try {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
      cache: "no-store", redirect: "error", signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new FleetBrowserRequestErrorV1([400, 401, 403, 404, 409, 422].includes(response.status), response.status);
    return await readBrowserJson(response);
  } catch (error) {
    throw error instanceof FleetBrowserRequestErrorV1 ? error : new FleetBrowserRequestErrorV1(false);
  }
}
