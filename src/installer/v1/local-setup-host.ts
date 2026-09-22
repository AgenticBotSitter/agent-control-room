import type { PrivateClientAssets } from "../../web/v1/private-assets";
import { createLocalSetupNodeHandler } from "../../web/v1/private-node-handler";
import { createLocalSetupLoopbackService } from "../../web/v1/private-serving";
import type { InstallationSetupViewV1 } from "../../harness/v1/installation-setup-wire";
import type { LocalSetupJournalSourceV1 } from "./local-setup-journal-source";

type SetupService = Readonly<{
  isReady(): boolean;
  start(): Promise<void>;
  close(): Promise<void>;
}>;
type SetupServiceFactory = (bridge: ReturnType<typeof createLocalSetupNodeHandler>, options: { port: number }) => SetupService;

export type LocalSetupReadinessSourceV1 = Readonly<{
  read(signal?: AbortSignal): Promise<InstallationSetupViewV1 | undefined>;
}>;

/**
 * Inert composition for the first-run loopback page. Construction never binds
 * a listener. It has only two redacted readers and a prebuilt page renderer;
 * it receives no database, queue, worker, credential, or installation action.
 */
export function createLocalSetupHostV1(input: Readonly<{
  origin: string;
  port: number;
  assets: PrivateClientAssets;
  render(request: Request): Promise<Response> | Response;
  planSource: Pick<LocalSetupJournalSourceV1, "read">;
  readinessSource?: LocalSetupReadinessSourceV1;
  isApplicationReady(): boolean;
  closeApplication(): Promise<void>;
  createService?: SetupServiceFactory;
}>): SetupService {
  const expectedOrigin = `http://127.0.0.1:${input.port}`;
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535 || input.origin !== expectedOrigin
    || typeof input.render !== "function" || typeof input.planSource?.read !== "function"
    || typeof input.isApplicationReady !== "function" || typeof input.closeApplication !== "function")
    throw new Error("local_setup_host_config_invalid");

  const handler = createLocalSetupNodeHandler({ origin: input.origin, assets: input.assets,
    renderSetupPage: input.render, planSource: input.planSource, readinessSource: input.readinessSource,
    isReady: input.isApplicationReady, close: input.closeApplication });
  return (input.createService ?? createLocalSetupLoopbackService)(handler, { port: input.port });
}
