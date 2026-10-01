import { readBrowserJson } from "./browser-json";

export type UpdaterHomeStatusV1 = Readonly<{ schema: "control-room.updater-home-status/v1"; state: "off" | "attention";
  backup: "ok" | "failed" | "missing" | null }>;

export async function readUpdaterHomeStatusV1(transport: typeof fetch = fetch, signal?: AbortSignal): Promise<UpdaterHomeStatusV1> {
  try {
    const response = await transport("/api/v1/updater-status", { method: "GET", credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
    if (!response.ok) throw new Error();
    const value = await readBrowserJson(response, 512);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const status = value as Record<string, unknown>;
    if (Object.keys(status).sort().join(",") !== "backup,schema,state" || status.schema !== "control-room.updater-home-status/v1"
      || !["off", "attention"].includes(String(status.state))
      || status.backup !== null && !["ok", "failed", "missing"].includes(String(status.backup))) throw new Error();
    return Object.freeze({ schema: "control-room.updater-home-status/v1", state: status.state as "off" | "attention",
      backup: status.backup as "ok" | "failed" | "missing" | null });
  } catch { return Object.freeze({ schema: "control-room.updater-home-status/v1", state: "attention", backup: null }); }
}
