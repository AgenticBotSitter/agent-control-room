import { z } from "zod";
import { readBrowserJson } from "./browser-json";
import { parseConnectionCenterBrowserProjectionV1 } from "../../connection-center/v1/http-client";

export class ConnectionBrowserError extends Error {
  constructor(readonly code: "authentication_required" | "access_denied" | "unavailable") { super(code); }
}
const envelope = z.object({ projection: z.unknown(), telemetry: z.enum(["configured", "not_configured"]) }).strict();

export async function readPrivateConnections(transport: typeof fetch = fetch) {
  try {
    const response = await transport("/api/v1/connections", { method: "GET", credentials: "same-origin",
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
    if (response.status === 401) throw new ConnectionBrowserError("authentication_required");
    if (response.status === 403) throw new ConnectionBrowserError("access_denied");
    if (!response.ok) throw new ConnectionBrowserError("unavailable");
    const result = envelope.parse(await readBrowserJson(response));
    const projection = await parseConnectionCenterBrowserProjectionV1(result.projection);
    if (result.telemetry === "not_configured" && projection.connections.some(item => item.signalFreshness !== "missing"))
      throw new Error("invalid_telemetry_state");
    return { projection, telemetry: result.telemetry };
  } catch (error) { throw error instanceof ConnectionBrowserError ? error : new ConnectionBrowserError("unavailable"); }
}

export type PrivateConnectionSnapshot = Awaited<ReturnType<typeof readPrivateConnections>>;
