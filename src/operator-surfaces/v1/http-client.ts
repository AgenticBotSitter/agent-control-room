import { parseOperatorSurfaceSnapshotV1 } from "./validators";
import type { OperatorSurfaceSnapshotV1 } from "./types";

export type OperatorSurfaceDataStateV1 =
  | { state: "loading" }
  | { state: "available"; snapshot: OperatorSurfaceSnapshotV1 }
  | { state: "unavailable"; code: "authentication_required" | "operator_surface_unavailable" | "invalid_response" | "request_failed" };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
