import type { Server, ServerOptions } from "node:http";
import { createMacLocalNodeService } from "./private-serving";
import type { PrivateClientAssets } from "./private-assets";
import { createMacLocalWebProcessV1, type MacLocalWebProcessOptionsV1 } from "./mac-local-web-process";
import { installPrivateApplication, privateNotConfigured, type PrivateApplication } from "./private-process";

type ListenerOptions = Readonly<{ port: number; createServer?: (options: Readonly<ServerOptions>) => Server;
  listenerTiming?: { bindMs?: number; closeMs?: number } }>;

// The renderer's middleware reads one process-wide installed application. Mac-local
// installs a single forwarder once, and it serves only the Mac-local site currently
// running; with none running every request is "not configured".
let running: PrivateApplication | undefined;
let forwarderInstalled = false;
function useRunningApplication(app: PrivateApplication) {
  if (running && running !== app) throw new Error("mac_local_service_already_running");
  if (!forwarderInstalled) {
    installPrivateApplication({ handle: async (request, render) => running ? running.handle(request, render) : privateNotConfigured(),
      close: async () => { await running?.close(); } });
    forwarderInstalled = true;
  }
  running = app;
}

/**
 * Inert composition for the first real local Control Room website. It contains
 * no credential discovery, environment reads, database opening, or automatic
 * listener start. Startup remains an explicit later owner-approved effect.
 */
export function createMacLocalControlRoomServiceV1(options: MacLocalWebProcessOptionsV1 & ListenerOptions & {
  assets: PrivateClientAssets;
  render(request: Request): Promise<Response> | Response;
}) {
  const app = createMacLocalWebProcessV1(options);
  // Same shape as the VPS host: the renderer's middleware sends every request to
  // the installed application, which authorizes before any page renders.
  const service = createMacLocalNodeService({ origin: options.origin, port: options.port, assets: options.assets,
    handler: request => options.render(request),
    application: { isReady: app.isReady, close: app.close }, ...(options.createServer ? { createServer: options.createServer } : {}),
    ...(options.listenerTiming ? { listenerTiming: options.listenerTiming } : {}) });
  const release = () => { if (running === app) running = undefined; };
  const start = async () => {
    useRunningApplication(app);
    try { return await service.start(); } catch (error) { release(); throw error; }
  };
  const close = async () => { try { return await service.close(); } finally { release(); } };
  return Object.freeze({ isReady: service.isReady, start, close });
}
