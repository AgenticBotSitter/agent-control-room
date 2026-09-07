import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { loadContributorClientAssets } from "../web/v1/private-assets";
import { createContributorDemoNodeHandler } from "../web/v1/private-node-handler";
import { createContributorDemoRuntime } from "./runtime";
import { createContributorDemoHttp } from "./http";

/** Assembles built frontend + disposable backend. No physical listener or process
 * signals. The returned close function drains requests before destroying demo data.
 */
export async function createContributorDemoApplication(repositoryRoot: string) {
  const assets = await loadContributorClientAssets(await realpath(join(repositoryRoot, "dist-contributor/client")));
  const demo = await createContributorDemoRuntime(repositoryRoot);
  try {
    const api = createContributorDemoHttp(demo.runtime, demo.simulate, demo.simulationHistory);
    const bridge = createContributorDemoNodeHandler({ origin: demo.origin, assets,
      application: { isReady: () => true, close: () => demo.close() },
      handler: request => {
        const url = new URL(request.url);
        if (["/", "/local-preview"].includes(url.pathname) && ["GET", "HEAD"].includes(request.method)) {
          return assets.respond("/index.html", request.method)!;
        }
        return api(request);
      },
    });
    return Object.freeze({ ...bridge, origin: demo.origin, ownerCode: demo.ownerCode, dataDir: demo.dataDir });
  } catch (error) { await demo.close(); throw error; }
}
