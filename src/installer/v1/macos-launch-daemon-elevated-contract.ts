export const MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1 = "control-room.macos-launch-daemon-elevated-batch/v1" as const;

export type MacosLaunchDaemonInventoryItemV1 = Readonly<{
  kind: "launchd_plist" | "newsyslog_config" | "protected_config";
  path: string;
  sha256: string;
}>;

export type MacosLaunchDaemonInstallResourceV1 = Readonly<
  | (MacosLaunchDaemonInventoryItemV1 & { kind: "launchd_plist" | "newsyslog_config"; contents?: string })
  | (MacosLaunchDaemonInventoryItemV1 & { kind: "protected_config"; contents?: string;
    accountName: string; groupName: string; fileMode: "0600" })>;

export type MacosLaunchDaemonLogFileV1 = Readonly<{
  directory: string;
  path: string;
  accountName: string;
  groupName: string;
  directoryOwner: "root";
  directoryGroup: "wheel";
  directoryMode: "0755";
  fileMode: "0600";
}>;

export type MacosLaunchDaemonWritableDirectoryV1 = Readonly<{
  purpose: "nightly_backup_parent" | "nightly_backup_output" | "nightly_backup_lock";
  path: string;
  accountName: string;
  groupName: string;
  directoryOwner: "root";
  directoryGroup: string;
  directoryMode: "0710" | "0770";
  createWith: "mkdir_lchown_nofollow";
}>;

export type MacosLaunchDaemonElevatedBatchRequestV1 = Readonly<{
  schema: typeof MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1;
  action: "install" | "uninstall" | "rollback";
  lockName: "xyz.agentcontrolroom.install";
  bundleDigest: string;
  requestDigest: string;
  services: readonly Readonly<{ role: string; label: string; plistPath: string }>[];
  resources: readonly MacosLaunchDaemonInstallResourceV1[];
  logFiles: readonly MacosLaunchDaemonLogFileV1[];
  writableDirectories: readonly MacosLaunchDaemonWritableDirectoryV1[];
  ordering: Readonly<{
    installBootstrap: readonly string[];
    installRollbackBootout: readonly string[];
    uninstallBootout: readonly string[];
  }>;
  postgresShutdown: Readonly<{
    label: string;
    plistPath: string;
    strategy: "launchctl_bootout_first";
    dataDirectory: string;
    socketPath: string;
    pgControlData: string;
    requirePostmasterPidAbsent: true;
    requireSocketClosed: true;
    requireControlDataShutDown: true;
  }>;
  postgresConfiguration: Readonly<{ path: string; listenAddresses: ""; ssl: "off" }>;
}>;

export type MacosLaunchDaemonElevatedBatchResultV1 = Readonly<{
  schema: typeof MACOS_LAUNCH_DAEMON_ELEVATED_BATCH_V1;
  requestDigest: string;
  outcome: "completed" | "unchanged" | "rolled_back" | "uncertain";
  inventory?: readonly MacosLaunchDaemonInventoryItemV1[];
}>;

/**
 * Shared item-4/item-5 boundary. The item-4 installer implements this port in
 * process after its single sudo has made it root; callers must not add another
 * sudo hop. The helper owns the named lock, temp-root-safe file preparation,
 * launchctl ordering, and rollback of its own partial writes.
 */
export type MacosLaunchDaemonElevatedPortV1 = Readonly<{
  invokeBatch(request: MacosLaunchDaemonElevatedBatchRequestV1,
    signal: AbortSignal): Promise<MacosLaunchDaemonElevatedBatchResultV1>;
}>;
