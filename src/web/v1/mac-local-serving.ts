import type { Server, ServerOptions } from "node:http";
import { createMacLocalNodeService } from "./private-serving";
import type { PrivateClientAssets } from "./private-assets";
import { createMacLocalWebProcessV1, type MacLocalWebProcessOptionsV1 } from "./mac-local-web-process";

type ListenerOptions = Readonly<{ port: number; createServer?: (options: Readonly<ServerOptions>) => Server;
  listenerTiming?: { bindMs?: number; closeMs?: number } }>;

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
  const service = createMacLocalNodeService({ origin: options.origin, port: options.port, assets: options.assets,
    handler: request => app.handle(request, () => options.render(request)),
    application: { isReady: app.isReady, close: app.close }, ...(options.createServer ? { createServer: options.createServer } : {}),
    ...(options.listenerTiming ? { listenerTiming: options.listenerTiming } : {}) });
  return Object.freeze({ isReady: service.isReady, start: service.start, close: service.close });
}
