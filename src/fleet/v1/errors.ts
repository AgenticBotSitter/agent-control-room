/** Safe, fixed refusal codes. Messages never carry request content. */
export type FleetErrorCodeV1 = "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid"
| "too_large" | "rate_limited" | "expired" | "unavailable" | "paused" | "worker_kind_mismatch"
  | "refused_secret_material";

const statuses: Readonly<Record<FleetErrorCodeV1, number>> = Object.freeze({ unauthenticated: 401, forbidden: 403,
  not_found: 404, conflict: 409, invalid: 400, too_large: 413, rate_limited: 429, expired: 410, unavailable: 503,
  paused: 423, worker_kind_mismatch: 403,
  // 422 rather than 400: the request was well formed and the server understood
  // it, and it is refusing on content. This is the one refusal a connector
  // should NOT retry, and the code says so where the connector reads it.
  refused_secret_material: 422 });

export class FleetErrorV1 extends Error {
  constructor(readonly code: FleetErrorCodeV1) {
    super(`fleet_${code}`);
    this.name = "FleetErrorV1";
  }
  get status() { return statuses[this.code]; }
}

export function fleetFail(code: FleetErrorCodeV1): never {
  throw new FleetErrorV1(code);
}
