import { isAbsolute, resolve } from "node:path";
import type { PrivateClientAssets } from "../../web/v1/private-assets";
import { createLocalSetupNodeHandler } from "../../web/v1/private-node-handler";
import { createLocalSetupLoopbackService } from "../../web/v1/private-serving";
import type { InstallationSetupViewV1 } from "../../harness/v1/installation-setup-wire";
import { InstallationPlanFilesystemJournalV1 } from "./installation-plan-journal";
import { createLocalSetupJournalSourceV1, type LocalSetupJournalSourceV1 } from "./local-setup-journal-source";

type SetupService = Readonly<{ isReady(): boolean; start(): Promise<void>; close(): Promise<void> }>;
type SetupServiceFactory = (bridge: ReturnType<typeof createLocalSetupNodeHandler>, options: { port: number }) => SetupService;
type JournalConfiguration = ConstructorParameters<typeof InstallationPlanFilesystemJournalV1>[0];

export type LocalSetupReadinessSourceV1 = Readonly<{
  read(signal?: AbortSignal): Promise<InstallationSetupViewV1 | undefined>;
}>;

export type InstalledLocalSetupHostRuntimeV1 = Readonly<{
  createJournal(configuration: JournalConfiguration): Pick<InstallationPlanFilesystemJournalV1, "inspectSettledHistory">;
  createJournalSource(journal: Pick<InstallationPlanFilesystemJournalV1, "inspectSettledHistory">): LocalSetupJournalSourceV1;
  createService: SetupServiceFactory;
}>;

const installedRuntime: InstalledLocalSetupHostRuntimeV1 = Object.freeze({
  createJournal: configuration => new InstallationPlanFilesystemJournalV1(configuration),
  createJournalSource: journal => createLocalSetupJournalSourceV1(journal),
  createService: createLocalSetupLoopbackService,
});
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;

function captureInstalled(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("local_setup_host_config_invalid");
  const value = input as Record<string, unknown>, keys = Object.keys(value).sort().join(",");
  if (keys !== "assets,closeApplication,installationId,isApplicationReady,journalRoot,ownerUid,port,readinessSource,render"
    && keys !== "assets,closeApplication,installationId,isApplicationReady,journalRoot,ownerUid,port,render")
    throw new Error("local_setup_host_config_invalid");
  if (typeof value.journalRoot !== "string" || !isAbsolute(value.journalRoot) || resolve(value.journalRoot) !== value.journalRoot
    || typeof value.installationId !== "string" || !installationIdPattern.test(value.installationId)
    || !Number.isSafeInteger(value.ownerUid) || value.ownerUid < 0 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.render !== "function" || typeof value.isApplicationReady !== "function" || typeof value.closeApplication !== "function")
    throw new Error("local_setup_host_config_invalid");
  if (value.readinessSource !== undefined && (!value.readinessSource || typeof (value.readinessSource as { read?: unknown }).read !== "function"))
    throw new Error("local_setup_host_config_invalid");
  return Object.freeze({ journalRoot: value.journalRoot, installationId: value.installationId, ownerUid: value.ownerUid, port: value.port,
    assets: value.assets as PrivateClientAssets, render: value.render as (request: Request) => Promise<Response> | Response,
    isApplicationReady: value.isApplicationReady as () => boolean, closeApplication: value.closeApplication as () => Promise<void>,
    ...(value.readinessSource === undefined ? {} : { readinessSource: value.readinessSource as LocalSetupReadinessSourceV1 }) });
}

/** Inert generic composition for the first-run loopback page. Construction
 * never binds a listener; installed use must select the canonical source below. */
export function createLocalSetupHostV1(input: Readonly<{
  origin: string; port: number; assets: PrivateClientAssets;
  render(request: Request): Promise<Response> | Response;
  planSource: Pick<LocalSetupJournalSourceV1, "read">;
  readinessSource?: LocalSetupReadinessSourceV1;
  isApplicationReady(): boolean; closeApplication(): Promise<void>; createService?: SetupServiceFactory;
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

/** Fixed installed composition: canonical filesystem journal and its one
 * read-only source, delegated through the generic inert loopback host. */
export function createInstalledLocalSetupHostV1(input: Readonly<{
  journalRoot: string; installationId: string; ownerUid: number; port: number; assets: PrivateClientAssets;
  render(request: Request): Promise<Response> | Response; readinessSource?: LocalSetupReadinessSourceV1;
  isApplicationReady(): boolean; closeApplication(): Promise<void>;
}>, runtime: InstalledLocalSetupHostRuntimeV1 = installedRuntime): SetupService {
  const captured = captureInstalled(input);
  if (!runtime || typeof runtime.createJournal !== "function" || typeof runtime.createJournalSource !== "function"
    || typeof runtime.createService !== "function") throw new Error("local_setup_host_config_invalid");
  const journal = runtime.createJournal({ rootDirectory: captured.journalRoot, installationId: captured.installationId, ownerUid: captured.ownerUid });
  const planSource = runtime.createJournalSource(journal);
  if (!planSource || typeof planSource.read !== "function") throw new Error("local_setup_host_config_invalid");
  return createLocalSetupHostV1({ origin: `http://127.0.0.1:${captured.port}`, port: captured.port, assets: captured.assets,
    render: captured.render, planSource, readinessSource: captured.readinessSource,
    isApplicationReady: captured.isApplicationReady, closeApplication: captured.closeApplication, createService: runtime.createService });
}
