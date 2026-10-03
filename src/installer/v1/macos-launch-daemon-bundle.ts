import { isAbsolute, join, normalize, relative } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import type { MacosLaunchDaemonLogFileV1 } from "./macos-launch-daemon-elevated-contract";
import type { MacosLaunchDaemonWritableDirectoryV1 } from "./macos-launch-daemon-elevated-contract";
import { createMacosFleetGatewayConfigurationV1, macosFleetGatewayConfigurationFileV1,
  type MacosFleetGatewayInstallInputV1 } from "./macos-fleet-gateway-configuration";
import { createNightlyBackupConfigurationV1, nightlyBackupConfigurationFileV1, NIGHTLY_DUMP_TIMEOUT_MS_V1 } from
  "./nightly-backup-configuration";

export const MACOS_LAUNCH_DAEMON_BUNDLE_V1 = "control-room.macos-launch-daemon-bundle/v1" as const;
export const MACOS_SERVICE_ACCOUNTS_V1 = "control-room.accounts/v1" as const;

const accountName = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u)
  .refine(value => !["root", "staff"].includes(value));
export const macosServiceAccountsSchemaV1 = z.object({
  schema: z.literal(MACOS_SERVICE_ACCOUNTS_V1),
  accounts: z.object({ service: accountName, database: accountName, builder: accountName }).strict(),
}).strict();
export type MacosServiceAccountsV1 = z.infer<typeof macosServiceAccountsSchemaV1>;

const absolutePath = z.string().min(2).max(4095).refine(value => isAbsolute(value)
  && normalize(value) === value && value !== "/" && !value.endsWith("/")
  && !/[\u0000-\u001f\u007f]/u.test(value));
const secretValue = z.string().min(8).max(4096);
const serviceRoles = ["postgresql17", "supervisor", "fleet-gateway", "nightly-backup", "updater", "updater-guard"] as const;
export type MacosLaunchDaemonRoleV1 = typeof serviceRoles[number];

type MacosLaunchDaemonResourceBaseV1 = Readonly<{ path: string; contents: string; sha256: string }>;
export type MacosLaunchDaemonResourceV1 = Readonly<MacosLaunchDaemonResourceBaseV1 & (
  | { kind: "launchd_plist" | "newsyslog_config" }
  | { kind: "protected_config"; accountName: string; groupName: string; fileMode: "0600" }
)>;
export type MacosLaunchDaemonServiceV1 = Readonly<{
  role: MacosLaunchDaemonRoleV1; label: string; plistPath: string; accountName: string; groupName: string;
  standardOutPath: string; standardErrorPath: string;
}>;
export type MacosLaunchDaemonBundleV1 = Readonly<{
  schema: typeof MACOS_LAUNCH_DAEMON_BUNDLE_V1; accounts: MacosServiceAccountsV1; installRoot: string;
  postgresExecutable: string; protectedRoot: string; logDirectory: string; services: readonly MacosLaunchDaemonServiceV1[];
  logFiles: readonly MacosLaunchDaemonLogFileV1[]; resources: readonly MacosLaunchDaemonResourceV1[]; bundleDigest: string;
  writableDirectories: readonly MacosLaunchDaemonWritableDirectoryV1[];
}>;

const xmlEscape = (value: string) => value.replace(/[&<>"']/gu,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

function renderPlist(input: Readonly<{
  role: MacosLaunchDaemonRoleV1; label: string; account?: Readonly<{ user: string; group: string }>;
  workingDirectory: string;
  programArguments: readonly string[]; environment?: Readonly<Record<string, string>>;
  standardOutPath: string; standardErrorPath: string; keepAlive: boolean | "failed"; exitTimeOut: number;
  startInterval?: number; nightly?: boolean;
}>): string {
  const environment = Object.entries(input.environment ?? {}).sort(([left], [right]) => left.localeCompare(right, "en"));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <!-- ${input.role === "postgresql17" ? "postgresql.conf must set listen_addresses='' and ssl = off. Database updates stop this job with launchctl bootout first, then verify postmaster.pid, socket closure, and pg_controldata shut down before changing pg/current." : "Generated Control Room service; privileged lifecycle changes use the verified elevated batch."} -->`,
    '  <key>Label</key>', `  <string>${xmlEscape(input.label)}</string>`,
    '  <key>ProgramArguments</key>', '  <array>',
    ...input.programArguments.map(value => `    <string>${xmlEscape(value)}</string>`), '  </array>',
    '  <key>WorkingDirectory</key>', `  <string>${xmlEscape(input.workingDirectory)}</string>`,
    ...(input.account ? ['  <key>UserName</key>', `  <string>${xmlEscape(input.account.user)}</string>`,
      '  <key>GroupName</key>', `  <string>${xmlEscape(input.account.group)}</string>`] : []),
    '  <key>RunAtLoad</key>', input.nightly ? '  <false/>' : '  <true/>',
    ...(input.keepAlive === true ? ['  <key>KeepAlive</key>', '  <true/>']
      : input.keepAlive === "failed" ? ['  <key>KeepAlive</key>', '  <dict>',
        '    <key>SuccessfulExit</key>', '    <false/>', '  </dict>'] : []),
    ...(input.startInterval ? ['  <key>StartInterval</key>', `  <integer>${input.startInterval}</integer>`] : []),
    '  <key>ThrottleInterval</key>', '  <integer>30</integer>',
    '  <key>ExitTimeOut</key>', `  <integer>${input.exitTimeOut}</integer>`,
    '  <key>ProcessType</key>', '  <string>Background</string>',
    '  <key>Umask</key>', '  <integer>63</integer>',
    ...(input.nightly ? ['  <key>StartCalendarInterval</key>', '  <dict>',
      '    <key>Hour</key>', '    <integer>2</integer>', '    <key>Minute</key>', '    <integer>30</integer>', '  </dict>'] : []),
    ...(environment.length ? ['  <key>EnvironmentVariables</key>', '  <dict>',
      ...environment.flatMap(([name, value]) => [`    <key>${xmlEscape(name)}</key>`, `    <string>${xmlEscape(value)}</string>`]),
      '  </dict>'] : []),
    '  <key>StandardOutPath</key>', `  <string>${xmlEscape(input.standardOutPath)}</string>`,
    '  <key>StandardErrorPath</key>', `  <string>${xmlEscape(input.standardErrorPath)}</string>`,
    '</dict>', '</plist>', '',
  ].join("\n");
}

const within = (root: string, value: string) => {
  const path = relative(root, value);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

function assertProgramPaths(installRoot: string, definitions: readonly Readonly<{ executable: string; args: readonly string[] }>[]) {
  const executableRoots = ["runtime", "updater", "current", "guard"].map(name => join(installRoot, name));
  for (const definition of definitions) {
    if (definition.executable !== "/bin/sh" && definition.executable !== "/usr/bin/sandbox-exec"
      && !executableRoots.some(root => within(root, definition.executable))) {
      throw new Error("macos_launch_daemon_executable_refused");
    }
    for (const value of definition.args.filter(argument => argument.startsWith("/"))) {
      if (value !== "/dev/null" && !within(installRoot, value)) throw new Error("macos_launch_daemon_path_refused");
    }
  }
}

/** Creates the complete privileged payload without touching disk or invoking privileged commands. */
export function createMacosLaunchDaemonBundleV1(input: unknown): MacosLaunchDaemonBundleV1 {
  const parsed = z.object({ installRoot: absolutePath, accounts: macosServiceAccountsSchemaV1,
    postgresExecutable: absolutePath,
    fleetGateway: z.custom<MacosFleetGatewayInstallInputV1>(value => value !== undefined),
    secretValues: z.array(secretValue).max(64).optional() }).strict().parse(input);
  const protectedRoot = join(parsed.installRoot, "Protected"), logDirectory = join(parsed.installRoot, "logs");
  const serviceAccounts = Object.freeze({
    controlRoom: Object.freeze({ user: parsed.accounts.accounts.service, group: parsed.accounts.accounts.service }),
    database: Object.freeze({ user: parsed.accounts.accounts.database, group: parsed.accounts.accounts.database }),
    builder: Object.freeze({ user: parsed.accounts.accounts.builder, group: parsed.accounts.accounts.builder }),
  });
  const current = join(parsed.installRoot, "current");
  const runtimeNode = join(parsed.installRoot, "runtime", "node-current", "bin", "node");
  if (!within(join(parsed.installRoot, "runtime"), parsed.postgresExecutable)
    || !parsed.postgresExecutable.endsWith("/bin/postgres")) {
    throw new Error("macos_launch_daemon_executable_refused");
  }
  const runtimePostgres = parsed.postgresExecutable;
  const sandbox = "/usr/bin/sandbox-exec";
  const profile = (role: "postgres" | "supervisor" | "gateway") =>
    join(parsed.installRoot, "updater", "current", "policy", `service-${role}.sb`);
  const logPath = (role: MacosLaunchDaemonRoleV1, stream: "out" | "err") => join(logDirectory, role, `${stream}.log`);
  const sandboxArgs = (role: "postgres" | "supervisor" | "gateway", workingDirectory: string,
    values: Readonly<Record<string, string>>,
    executable: string, args: readonly string[]) => ["-f", profile(role),
      ...Object.entries({ ...values, RUNTIME_ROOT: join(parsed.installRoot, "runtime"),
        RELEASE_ROOT: join(parsed.installRoot, "releases"), UPDATER_ROOT: join(parsed.installRoot, "updater"),
        WORKING_DIRECTORY: workingDirectory })
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .flatMap(([name, value]) => ["-D", `${name}=${value}`]), "--", executable, ...args];
  const accountFor = (role: MacosLaunchDaemonRoleV1) => role === "postgresql17" ? serviceAccounts.database
    : role === "updater" || role === "updater-guard" ? undefined : serviceAccounts.controlRoom;
  const definitions = [
    { role: "postgresql17", executable: sandbox, workingDirectory: join(parsed.installRoot, "pg", "current"),
      args: sandboxArgs("postgres", join(parsed.installRoot, "pg", "current"), { DATA_ROOT: join(parsed.installRoot, "pg"), SOCKET_ROOT: join(parsed.installRoot, "pg", "socket"),
        OUT_LOG: logPath("postgresql17", "out"), ERR_LOG: logPath("postgresql17", "err") }, runtimePostgres,
      ["-D", join(parsed.installRoot, "pg", "current"), "-k", join(parsed.installRoot, "pg", "socket")]),
      keepAlive: true, exitTimeOut: 120 },
    { role: "supervisor", executable: sandbox, workingDirectory: current,
      args: sandboxArgs("supervisor", current, { RUNTIME_STATE: join(protectedRoot, "runtime-state"),
        OUT_LOG: logPath("supervisor", "out"), ERR_LOG: logPath("supervisor", "err") }, runtimeNode,
      [join(current, "scripts", "mac-local", "task-host-supervisor.mjs"), "--protected-root", protectedRoot]),
      keepAlive: true, exitTimeOut: 45 },
    { role: "fleet-gateway", executable: sandbox, workingDirectory: current,
      args: sandboxArgs("gateway", current, { RUNTIME_STATE: join(protectedRoot, "runtime-state"),
        OUT_LOG: logPath("fleet-gateway", "out"), ERR_LOG: logPath("fleet-gateway", "err") }, runtimeNode,
      [join(current, "dist-vps", "server", "fleetGateway.js"), "--configuration", join(protectedRoot, "config", "fleet-gateway.json")]),
      keepAlive: "failed" as const, exitTimeOut: 45 },
    // R5c keeps this legacy job until item 19a supplies updater-owned backup. It remains unsandboxed because the
    // trusted runtime has no backup profile; removing it here would leave install night without a nightly backup.
    // R4S-11: `exitTimeOut` is how long launchd waits AFTER it has SIGTERMed the
    // job before it SIGKILLs it, and it was 120 s — the same figure the old
    // pg_dump limit used, so raising the dump limit alone would have moved the
    // kill one layer up: a legitimately long dump would be SIGKILLed by launchd
    // with nothing at all in the log. It is now derived from the dump limit so
    // the two cannot drift apart, and tests/nightly-backup-postgres.test.ts
    // asserts the relationship in both directions.
    { role: "nightly-backup", executable: runtimeNode, workingDirectory: current,
      args: [join(current, "dist-vps", "server", "nightlyBackup.js"), "--configuration", join(protectedRoot, "config", "backup.json")],
      keepAlive: false, exitTimeOut: Math.ceil(NIGHTLY_DUMP_TIMEOUT_MS_V1 / 1000) + 60, nightly: true },
    { role: "updater", executable: runtimeNode, workingDirectory: join(parsed.installRoot, "updater", "current"),
      args: [join(parsed.installRoot, "updater", "current", "updater.mjs"), "--configuration",
        join(parsed.installRoot, "updater-state", "updater.json")], keepAlive: true, exitTimeOut: 60 },
    { role: "updater-guard", executable: "/bin/sh", workingDirectory: join(parsed.installRoot, "guard"),
      args: ["-p", join(parsed.installRoot, "guard", "guard.sh"), "watch"], keepAlive: false,
      exitTimeOut: 60, startInterval: 60 },
  ] as const;
  assertProgramPaths(parsed.installRoot, definitions);
  const services = definitions.map(definition => {
    const labelRole = definition.role === "postgresql17" ? "postgres" : definition.role === "fleet-gateway" ? "gateway" : definition.role;
    const label = `xyz.agentcontrolroom.${labelRole}`, account = accountFor(definition.role);
    return Object.freeze({ role: definition.role, label, plistPath: `/Library/LaunchDaemons/${label}.plist`,
      accountName: account?.user ?? "root", groupName: account?.group ?? "wheel",
      standardOutPath: logPath(definition.role, "out"), standardErrorPath: logPath(definition.role, "err") });
  });
  const logFiles = Object.freeze(services.flatMap(service => [service.standardOutPath, service.standardErrorPath]
    .map(path => Object.freeze({ directory: join(logDirectory, service.role), path, accountName: service.accountName,
      groupName: service.groupName, directoryOwner: "root" as const, directoryGroup: "wheel" as const,
      directoryMode: "0755" as const, fileMode: "0600" as const }))));
  const nightlyService = services.find(service => service.role === "nightly-backup")!;
  const nightlyConfiguration = createNightlyBackupConfigurationV1(parsed.installRoot);
  const writableDirectories = Object.freeze([
    Object.freeze({ purpose: "nightly_backup_parent" as const, path: join(parsed.installRoot, "backups"),
      accountName: nightlyService.accountName, groupName: nightlyService.groupName, directoryOwner: "root" as const,
      directoryGroup: nightlyService.groupName, directoryMode: "0710" as const,
      createWith: "mkdir_lchown_nofollow" as const }),
    Object.freeze({ purpose: "nightly_backup_output" as const, path: nightlyConfiguration.outputRoot,
      accountName: nightlyService.accountName, groupName: nightlyService.groupName, directoryOwner: "root" as const,
      directoryGroup: nightlyService.groupName, directoryMode: "0770" as const,
      createWith: "mkdir_lchown_nofollow" as const }),
    Object.freeze({ purpose: "nightly_backup_lock" as const, path: join(protectedRoot, "runtime-state", "nightly-backup"),
      accountName: nightlyService.accountName, groupName: nightlyService.groupName, directoryOwner: "root" as const,
      directoryGroup: nightlyService.groupName, directoryMode: "0770" as const,
      createWith: "mkdir_lchown_nofollow" as const }),
  ]);
  const plistResources = definitions.map((definition, index): MacosLaunchDaemonResourceV1 => {
    const service = services[index]!, account = accountFor(definition.role);
    const environment: Readonly<Record<string, string>> | undefined = definition.role === "postgresql17" ? {
      OPENSSL_CONF: join(parsed.installRoot, "runtime", "pg-current", "etc", "openssl.cnf"),
      OPENSSL_MODULES: join(parsed.installRoot, "runtime", "pg-current", "lib", "ossl-modules"),
      KRB5_CONFIG: "/dev/null", KRB5_KDC_PROFILE: "/dev/null",
    // The sandbox's one writable tree, as the PROCESS sees it: `-D RUNTIME_STATE` only
    // parameterises the Seatbelt profile and never reaches the environment, and the
    // supervisor, its task host and the gateway read it from there
    // (`macLocalRuntimeDirectoryV1`). MEASURED (cl-svc3): without it the supervisor
    // wrote under `Protected/runtime`, which the profile denies, and exited at start.
    } : definition.role === "supervisor" || definition.role === "fleet-gateway"
      ? { RUNTIME_STATE: join(protectedRoot, "runtime-state") } : undefined;
    const contents = renderPlist({ role: definition.role, label: service.label, account,
      workingDirectory: definition.workingDirectory,
      programArguments: [runtimeNode, join(parsed.installRoot, "updater", "current", "service-output.mjs"),
        "--out", service.standardOutPath, "--err", service.standardErrorPath, "--shutdown-ms", String((definition.exitTimeOut - 5) * 1000),
        "--", definition.executable, ...definition.args], environment,
      standardOutPath: "/dev/null", standardErrorPath: "/dev/null",
      keepAlive: definition.keepAlive, exitTimeOut: definition.exitTimeOut,
      ...(definition.role === "updater-guard" ? { startInterval: definition.startInterval } : {}),
      ...(definition.role === "nightly-backup" ? { nightly: true } : {}) });
    return Object.freeze({ kind: "launchd_plist", path: service.plistPath, contents, sha256: sha256Digest(contents) });
  });
  const rotationPath = "/etc/newsyslog.d/xyz.agentcontrolroom.conf";
  const rotationContents = "# Control Room service logs are capped at 10 MiB per stream by service-output.mjs.\n"
    + "# No newsyslog rules: the collector truncates its own inode and never keeps writing an archive.\n";
  const backupConfiguration = `${JSON.stringify(nightlyConfiguration, null, 2)}\n`;
  const fleetGatewayConfiguration = createMacosFleetGatewayConfigurationV1(parsed.installRoot, parsed.fleetGateway);
  const fleetGatewayConfigurationContents = `${JSON.stringify(fleetGatewayConfiguration, null, 2)}\n`;
  const resources = Object.freeze([...plistResources, Object.freeze({ kind: "newsyslog_config" as const,
    path: rotationPath, contents: rotationContents, sha256: sha256Digest(rotationContents) }),
  Object.freeze({ kind: "protected_config" as const, path: nightlyBackupConfigurationFileV1(parsed.installRoot),
    contents: backupConfiguration, sha256: sha256Digest(backupConfiguration), accountName: serviceAccounts.controlRoom.user,
    groupName: serviceAccounts.controlRoom.group, fileMode: "0600" as const }),
  Object.freeze({ kind: "protected_config" as const, path: macosFleetGatewayConfigurationFileV1(parsed.installRoot),
    contents: fleetGatewayConfigurationContents, sha256: sha256Digest(fleetGatewayConfigurationContents),
    accountName: serviceAccounts.controlRoom.user, groupName: serviceAccounts.controlRoom.group, fileMode: "0600" as const })]);
  const knownProtectedSecrets = [fleetGatewayConfiguration.database.password,
    fleetGatewayConfiguration.workIntake!.database.password, fleetGatewayConfiguration.workIntake!.integrityKey,
    fleetGatewayConfiguration.harnessIntegrityKey!, ...(parsed.secretValues ?? [])];
  if (knownProtectedSecrets.some(secret => resources.some(resource => resource.kind !== "protected_config"
    && resource.contents.includes(secret)))) {
    throw new Error("macos_launch_daemon_bundle_secret_refused");
  }
  const unsigned = { schema: MACOS_LAUNCH_DAEMON_BUNDLE_V1, accounts: parsed.accounts,
    installRoot: parsed.installRoot, postgresExecutable: parsed.postgresExecutable,
    protectedRoot, logDirectory, services: Object.freeze(services), logFiles, writableDirectories, resources };
  return Object.freeze({ ...unsigned, bundleDigest: sha256Digest(unsigned) });
}

const resourceFields = { path: absolutePath, contents: z.string().min(1).max(512 * 1024),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u) } as const;
const resourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("launchd_plist"), ...resourceFields }).strict(),
  z.object({ kind: z.literal("newsyslog_config"), ...resourceFields }).strict(),
  z.object({ kind: z.literal("protected_config"), ...resourceFields, accountName: z.string().min(1),
    groupName: z.string().min(1), fileMode: z.literal("0600") }).strict(),
]);
const serviceSchema = z.object({ role: z.enum(serviceRoles), label: z.string().regex(/^xyz\.agentcontrolroom\.[a-z0-9-]+$/u),
  plistPath: absolutePath, accountName: z.string().min(1), groupName: z.string().min(1),
  standardOutPath: absolutePath, standardErrorPath: absolutePath }).strict();
const logFileSchema = z.object({ directory: absolutePath, path: absolutePath, accountName: z.string().min(1),
  groupName: z.string().min(1), directoryOwner: z.literal("root"), directoryGroup: z.literal("wheel"),
  directoryMode: z.literal("0755"), fileMode: z.literal("0600") }).strict();
const writableDirectorySchema = z.object({ purpose: z.enum(["nightly_backup_parent", "nightly_backup_output", "nightly_backup_lock"]),
  path: absolutePath, accountName: z.string().min(1), groupName: z.string().min(1), directoryOwner: z.literal("root"),
  directoryGroup: z.string().min(1), directoryMode: z.enum(["0710", "0770"]),
  createWith: z.literal("mkdir_lchown_nofollow") }).strict();
const bundleSchema = z.object({ schema: z.literal(MACOS_LAUNCH_DAEMON_BUNDLE_V1), accounts: macosServiceAccountsSchemaV1,
  installRoot: absolutePath, postgresExecutable: absolutePath, protectedRoot: absolutePath, logDirectory: absolutePath,
  services: z.array(serviceSchema), logFiles: z.array(logFileSchema), writableDirectories: z.array(writableDirectorySchema),
  resources: z.array(resourceSchema),
  bundleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict();

/** Rebuilds untrusted serialized input so paths, accounts and contents cannot be retargeted. */
export function verifyMacosLaunchDaemonBundleV1(value: unknown): MacosLaunchDaemonBundleV1 {
  const parsed = bundleSchema.parse(value);
  const fleetResource = parsed.resources.find(resource => resource.kind === "protected_config"
    && resource.path === macosFleetGatewayConfigurationFileV1(parsed.installRoot));
  if (!fleetResource) throw new Error("macos_launch_daemon_bundle_refused");
  let fleetGateway: MacosFleetGatewayInstallInputV1;
  try {
    const config = JSON.parse(fleetResource.contents) as ReturnType<typeof createMacosFleetGatewayConfigurationV1>;
    fleetGateway = { tenantId: config.tenantId, database: config.database,
      workIntakeDatabase: config.workIntake!.database,
      workIntakeIntegrityKey: config.workIntake!.integrityKey, harnessIntegrityKey: config.harnessIntegrityKey!,
      // The RELEASE's signing trust, carried into the gateway's protected config.
      // MEASURED: `composeProtectedConfigV1` lists `releaseTrust` among its exact keys, so
      // a bundle without it fails `fleet_gateway_configuration_refused` the moment the
      // gateway reads its config. It is the release's key, forwarded unchanged.
      releaseTrust: config.releaseTrust };
  } catch { throw new Error("macos_launch_daemon_bundle_refused"); }
  const expected = createMacosLaunchDaemonBundleV1({ installRoot: parsed.installRoot, accounts: parsed.accounts,
    postgresExecutable: parsed.postgresExecutable, fleetGateway });
  if (canonicalJson(parsed) !== canonicalJson(expected)) throw new Error("macos_launch_daemon_bundle_refused");
  return expected;
}
