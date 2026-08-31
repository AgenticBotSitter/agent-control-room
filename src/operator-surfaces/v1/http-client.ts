import { parseOperatorSurfaceSnapshotV1 } from "./validators";
import type { OperatorSurfaceSnapshotV1 } from "./types";

export type OperatorSurfaceDataStateV1 =
  | { state: "loading" }
  | { state: "available"; snapshot: OperatorSurfaceSnapshotV1 }
  | { state: "unavailable"; code: "authentication_required" | "operator_surface_unavailable" | "invalid_response" | "request_failed" };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type OwnerFocusSaveRequestV1 =
  | { operation: "set_owner_focus"; projectId: string; level: "p0" | "today"; reason: string }
  | { operation: "clear_owner_focus"; projectId: string };
export type OwnerFocusSaveResultV1 =
  | { state: "recorded" | "replayed" }
  | { state: "unavailable"; code: "authentication_required" | "owner_focus_forbidden" | "owner_focus_unavailable" | "invalid_request" | "request_failed" };

function unavailableForStatus(status: number): Extract<OperatorSurfaceDataStateV1, { state: "unavailable" }> {
  if (status === 401) return { state: "unavailable", code: "authentication_required" };
  return { state: "unavailable", code: "operator_surface_unavailable" };
}

/**
 * Browser reader for the server-bound operator projection. It never sends a
 * tenant identifier or treats an HTTP error body as trusted display data.
 */
export async function fetchOperatorSurfaceSnapshotV1(fetcher: FetchLike = fetch): Promise<OperatorSurfaceDataStateV1> {
  try {
    const response = await fetcher("/api/v1/operator-surface", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return unavailableForStatus(response.status);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("snapshot" in body)) return { state: "unavailable", code: "invalid_response" };
    try {
      return { state: "available", snapshot: parseOperatorSurfaceSnapshotV1(body.snapshot) };
    } catch {
      return { state: "unavailable", code: "invalid_response" };
    }
  } catch {
    return { state: "unavailable", code: "request_failed" };
  }
}

/** Sends only owner-priority intent to its protected endpoint; it never sends tenant or scheduling fields. */
export async function saveOwnerFocusV1(request: OwnerFocusSaveRequestV1, input: { fetcher?: FetchLike; idFactory?: () => string } = {}): Promise<OwnerFocusSaveResultV1> {
  const fetcher = input.fetcher ?? fetch;
  const idFactory = input.idFactory ?? (() => crypto.randomUUID());
  const commandId = idFactory();
  const idempotencyKey = idFactory();
  try {
    const response = await fetcher("/api/v1/operator-surface/owner-focus", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ commandId, ...request }),
    });
    if (response.status === 201 || response.status === 200) {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "state" in body && ((body.state === "recorded") || (body.state === "replayed"))) return { state: body.state };
      return { state: "unavailable", code: "invalid_request" };
    }
    if (response.status === 401) return { state: "unavailable", code: "authentication_required" };
    if (response.status === 403) return { state: "unavailable", code: "owner_focus_forbidden" };
    if (response.status === 400) return { state: "unavailable", code: "invalid_request" };
    return { state: "unavailable", code: "owner_focus_unavailable" };
  } catch {
    return { state: "unavailable", code: "request_failed" };
  }
}
