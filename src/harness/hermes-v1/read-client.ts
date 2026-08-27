import { projectHermesServeSnapshotV1, type HermesServeProjectionV1 } from "./serve-projection";

export const HERMES_SERVE_READ_ROUTES_V1 = ["/api/status", "/api/sessions", "/api/cron/jobs", "/api/analytics/usage"] as const;
export type HermesServeReadRouteV1 = (typeof HERMES_SERVE_READ_ROUTES_V1)[number];

export interface HermesServeReadTransportV1 { get(path: HermesServeReadRouteV1): Promise<unknown>; }

export async function readHermesServeProjectionV1(transport: HermesServeReadTransportV1, scope: { tenantId: string; nodeId: string }): Promise<HermesServeProjectionV1> {
  const [status,sessionsResponse,cronResponse,usage] = await Promise.all(HERMES_SERVE_READ_ROUTES_V1.map((route) => transport.get(route)));
  return projectHermesServeSnapshotV1({ status, sessions: unwrapArray(sessionsResponse,"sessions"), cronJobs: unwrapArray(cronResponse,"jobs"), usage },scope);
}

function unwrapArray(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Record<string,unknown>)[key])) return (value as Record<string,unknown>)[key];
  throw new Error(`Hermes read response missing ${key} array`);
}
