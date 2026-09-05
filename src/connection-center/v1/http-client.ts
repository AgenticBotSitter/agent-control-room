import { connectionCenterProjectionSchemaV1 } from "./schemas";
import type { ConnectionCenterDataStateV1, ConnectionCenterProjectionV1 } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("non-json connection projection");
}

async function digestMatches(projection: ConnectionCenterProjectionV1): Promise<boolean> {
  const { projectionDigest, ...material } = projection;
  const bytes = new TextEncoder().encode(canonicalJson(material));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const actual = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return actual === projectionDigest;
}

/** Browser-safe validation shared by preview and private app; never imports server-only registry code. */
export async function parseConnectionCenterBrowserProjectionV1(value: unknown): Promise<ConnectionCenterProjectionV1> {
  const projection = connectionCenterProjectionSchemaV1.parse(value) as ConnectionCenterProjectionV1;
  if (!(await digestMatches(projection))) throw new Error("invalid_connection_projection");
  return projection;
}

export async function fetchConnectionCenterV1(fetcher: FetchLike = fetch): Promise<ConnectionCenterDataStateV1> {
  try {
    const response = await fetcher("/api/v1/connections", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) return { state: "unavailable", code: "authentication_required" };
    if (!response.ok) return { state: "unavailable", code: "connection_center_unavailable" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
      || !Object.prototype.hasOwnProperty.call(body, "projection")) return { state: "unavailable", code: "invalid_response" };
    try {
      const projection = await parseConnectionCenterBrowserProjectionV1((body as { projection: unknown }).projection);
      return { state: "available", projection };
    } catch {
      return { state: "unavailable", code: "invalid_response" };
    }
  } catch {
    return { state: "unavailable", code: "request_failed" };
  }
}
