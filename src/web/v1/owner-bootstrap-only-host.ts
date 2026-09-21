import type { Server } from "node:http";
import { privateResponseHeaders } from "./http-common";
import { createPrivateNodeService, type privateServerOptions } from "./private-serving";
import type { OwnerBootstrapCeremonyV1 } from "./owner-bootstrap-ceremony";

type BootstrapOnlyHostInputV1 = Readonly<{
  origin: string;
  port: number;
  ceremony: OwnerBootstrapCeremonyV1;
  createServer?: (options: Readonly<typeof privateServerOptions>) => Server;
}>;

/** Constructs the fresh-install web host, but does not start it. While no
 * owner exists it exposes only the ceremony routes. It deliberately does not
 * construct the normal app, assets, task queue, worker, artifact store, or a
 * fallback route after bootstrap completes. A clean supervisor restart must
 * select the separately preflighted normal application. */
export function createOwnerBootstrapOnlyHostV1(input: BootstrapOnlyHostInputV1) {
  if (!input || typeof input !== "object" || !input.ceremony
    || typeof input.ceremony.isBootstrapOnly !== "function" || typeof input.ceremony.route !== "function"
    || typeof input.ceremony.close !== "function") throw new Error("owner_bootstrap_host_invalid");
  const unavailable = () => Response.json({ error: "owner_bootstrap_restart_required" }, {
    status: 503, headers: privateResponseHeaders,
  });
  const service = createPrivateNodeService({
    origin: input.origin, port: input.port, createServer: input.createServer,
    application: {
      // Once the ceremony completes, serving is deliberately unavailable. This
      // prevents a browser request from hot-swapping to the normal web role.
      isReady: () => input.ceremony.isBootstrapOnly(),
      close: () => input.ceremony.close(),
    },
    ownerBootstrapCeremony: input.ceremony,
    handler: unavailable,
    assets: { respond: () => undefined },
  });
  let attempted = false;
  return Object.freeze({
    isReady: service.isReady,
    close: service.close,
    async start() {
      if (attempted || !input.ceremony.isBootstrapOnly()) throw new Error("owner_bootstrap_host_unavailable");
      attempted = true;
      await service.start();
    },
  });
}
