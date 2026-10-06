import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { type MacosLaunchDaemonBundleV1, type MacosLaunchDaemonResourceV1,
  verifyMacosLaunchDaemonBundleV1 } from "./macos-launch-daemon-bundle";
import { MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1,
  type MacosLaunchDaemonElevatedBatchRequestV1, type MacosLaunchDaemonElevatedBatchResultV1,
  type MacosLaunchDaemonElevatedPortV1, type MacosLaunchDaemonInstallResourceV1,
  type MacosLaunchDaemonInventoryItemV1 } from
  "./macos-launch-daemon-elevated-contract";

export { MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1 } from "./macos-launch-daemon-elevated-contract";
export type { MacosLaunchDaemonElevatedBatchRequestV1, MacosLaunchDaemonElevatedBatchResultV1,
  MacosLaunchDaemonElevatedPortV1 } from "./macos-launch-daemon-elevated-contract";

export const MACOS_LAUNCH_DAEMON_INSTALL_RECEIPT_V1 = "control-room.macos-launch-daemon-install-receipt/v1" as const;

type Action = "install" | "uninstall" | "rollback";
type InventoryItem = MacosLaunchDaemonInventoryItemV1 & Readonly<{ kind: MacosLaunchDaemonResourceV1["kind"] }>;

export type MacosLaunchDaemonInstallReceiptV1 = Readonly<{
  schema: typeof MACOS_LAUNCH_DAEMON_INSTALL_RECEIPT_V1;
  bundleDigest: string;
  inventory: readonly InventoryItem[];
  receiptDigest: string;
}>;

export type MacosLaunchDaemonInstallerReportV1 = Readonly<{
  action: Action;
  outcome: "completed" | "unchanged" | "rolled_back" | "uncertain" | "refused";
  elevatedCalls: 0 | 1;
  message: string;
  receipt?: MacosLaunchDaemonInstallReceiptV1;
}>;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const inventorySchema = z.object({ kind: z.enum(["launchd_plist", "newsyslog_config", "protected_config"]),
  path: z.string().min(1), sha256: digest }).strict();
const resultSchema = z.object({ schema: z.literal(MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1), requestDigest: digest,
  outcome: z.enum(["completed", "unchanged", "rolled_back", "uncertain"]),
  inventory: z.array(inventorySchema).optional() }).strict();

const inventoryFor = (bundle: MacosLaunchDaemonBundleV1): readonly InventoryItem[] => Object.freeze(bundle.resources
  .map(resource => Object.freeze({ kind: resource.kind, path: resource.path, sha256: resource.sha256 })));

function receiptFor(bundle: MacosLaunchDaemonBundleV1): MacosLaunchDaemonInstallReceiptV1 {
  const unsigned = { schema: MACOS_LAUNCH_DAEMON_INSTALL_RECEIPT_V1, bundleDigest: bundle.bundleDigest,
    inventory: inventoryFor(bundle) };
  return Object.freeze({ ...unsigned, receiptDigest: sha256Digest(unsigned) });
}

function verifyReceipt(bundle: MacosLaunchDaemonBundleV1, value: unknown): MacosLaunchDaemonInstallReceiptV1 {
  const parsed = z.object({ schema: z.literal(MACOS_LAUNCH_DAEMON_INSTALL_RECEIPT_V1), bundleDigest: digest,
    inventory: z.array(inventorySchema), receiptDigest: digest }).strict().parse(value);
  const expected = receiptFor(bundle);
  if (canonicalJson(parsed) !== canonicalJson(expected)) throw new Error("macos_launch_daemon_receipt_refused");
  return expected;
}

function requestFor(bundle: MacosLaunchDaemonBundleV1, action: Action): MacosLaunchDaemonElevatedBatchRequestV1 {
  const resources: readonly MacosLaunchDaemonInstallResourceV1[] = bundle.resources.map(resource =>
    resource.kind === "protected_config"
      ? Object.freeze({ kind: resource.kind, path: resource.path, sha256: resource.sha256,
        accountName: resource.accountName, groupName: resource.groupName, fileMode: resource.fileMode,
        ...(action === "install" ? { contents: resource.contents } : {}) })
      : Object.freeze({ kind: resource.kind, path: resource.path, sha256: resource.sha256,
        ...(action === "install" ? { contents: resource.contents } : {}) }));
  const labels = Object.fromEntries(bundle.services.map(service => [service.role, service.label]));
  const installBootstrap = ["postgresql17", "updater", "supervisor", "fleet-gateway", "nightly-backup", "updater-guard"]
    .map(role => labels[role]!);
  const installRollbackBootout = ["updater-guard", "updater", "nightly-backup", "fleet-gateway", "supervisor", "postgresql17"]
    .map(role => labels[role]!);
  const uninstallBootout = ["nightly-backup", "fleet-gateway", "supervisor", "postgresql17", "updater-guard", "updater"]
    .map(role => labels[role]!);
  const postgres = bundle.services.find(service => service.role === "postgresql17")!;
  const unsigned = { schema: MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1, action,
    lockName: "xyz.agentcontrolroom.install" as const, bundleDigest: bundle.bundleDigest,
    services: Object.freeze(bundle.services.map(service => Object.freeze({ role: service.role, label: service.label,
      plistPath: service.plistPath }))), resources: Object.freeze(resources), logFiles: bundle.logFiles,
    writableDirectories: bundle.writableDirectories,
    ordering: Object.freeze({ installBootstrap: Object.freeze(installBootstrap),
      installRollbackBootout: Object.freeze(installRollbackBootout), uninstallBootout: Object.freeze(uninstallBootout) }),
    postgresShutdown: Object.freeze({ label: postgres.label, plistPath: postgres.plistPath,
      strategy: "launchctl_bootout_first" as const, dataDirectory: `${bundle.installRoot}/pg/current`,
      socketPath: `${bundle.installRoot}/pg/socket/.s.PGSQL.5432`,
      pgControlData: `${bundle.installRoot}/runtime/pg-current/bin/pg_controldata`,
      requirePostmasterPidAbsent: true as const, requireSocketClosed: true as const,
      requireControlDataShutDown: true as const }),
    postgresConfiguration: Object.freeze({ path: `${bundle.installRoot}/pg/current/postgresql.conf`,
      listenAddresses: "" as const, ssl: "off" as const }) };
  return Object.freeze({ ...unsigned, requestDigest: sha256Digest(unsigned) });
}

function report(action: Action, outcome: MacosLaunchDaemonInstallerReportV1["outcome"], elevatedCalls: 0 | 1,
  receipt?: MacosLaunchDaemonInstallReceiptV1): MacosLaunchDaemonInstallerReportV1 {
  const messages = {
    completed: action === "install" ? "Control Room start-at-boot services are installed."
      : "Control Room start-at-boot services were removed.",
    unchanged: action === "install" ? "Control Room start-at-boot services were already installed."
      : "Control Room start-at-boot services were already absent.",
    rolled_back: "The service change failed and the elevated helper put every file back as it was.",
    uncertain: "The service change could not be confirmed. Inspect the installed service files before retrying.",
    refused: "Another service change is already running, so this request was not started.",
  } as const;
  return Object.freeze({ action, outcome, elevatedCalls, message: messages[outcome],
    ...(receipt === undefined ? {} : { receipt }) });
}

/** Creates an inert adapter for the future control-room install command. */
export function createMacosLaunchDaemonInstallerV1(bundle: MacosLaunchDaemonBundleV1,
  elevatedPort: MacosLaunchDaemonElevatedPortV1) {
  if (typeof elevatedPort?.invokeBatch !== "function") throw new Error("macos_launch_daemon_installer_refused");
  const verifiedBundle = verifyMacosLaunchDaemonBundleV1(bundle);
  const invokeBatch = elevatedPort.invokeBatch.bind(elevatedPort);
  const installedReceipt = receiptFor(verifiedBundle);
  let busy = false;

  const run = async (action: Action, value: unknown, signal: AbortSignal): Promise<MacosLaunchDaemonInstallerReportV1> => {
    if (busy) return report(action, "refused", 0);
    if (!(signal instanceof AbortSignal) || signal.aborted) return report(action, "refused", 0);
    if (action !== "install") verifyReceipt(verifiedBundle, value);
    busy = true;
    const request = requestFor(verifiedBundle, action);
    try {
      const result = resultSchema.parse(await invokeBatch(request, signal));
      if (signal.aborted || result.requestDigest !== request.requestDigest) return report(action, "uncertain", 1);
      const expectedInventory = action === "install" && (result.outcome === "completed" || result.outcome === "unchanged")
        ? installedReceipt.inventory : [];
      if (canonicalJson(result.inventory ?? []) !== canonicalJson(expectedInventory)) return report(action, "uncertain", 1);
      return report(action, result.outcome, 1, expectedInventory.length > 0 ? installedReceipt : undefined);
    } catch {
      return report(action, "uncertain", 1);
    } finally {
      busy = false;
    }
  };

  return Object.freeze({
    install: (signal: AbortSignal) => run("install", undefined, signal),
    uninstall: (receipt: unknown, signal: AbortSignal) => run("uninstall", receipt, signal),
    rollback: (receipt: unknown, signal: AbortSignal) => run("rollback", receipt, signal),
  });
}
