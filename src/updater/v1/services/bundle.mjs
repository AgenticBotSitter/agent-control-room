import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { canonicalJsonV1 } from "../canonical-json.mjs";

export const SERVICE_BUNDLE_SCHEMA_V1 = "control-room.services-bundle/v1";
export const SERVICE_ROLES_V1 = Object.freeze([
  "postgresql17", "supervisor", "fleet-gateway", "nightly-backup", "updater", "updater-guard",
]);
export const DATABASE_SERVICE_ROLES_V1 = Object.freeze(["postgresql17"]);
export const CORE_SERVICE_ROLES_V1 = Object.freeze(["supervisor", "fleet-gateway"]);
export const POST_HEALTH_SERVICE_ROLES_V1 = Object.freeze(["nightly-backup", "updater", "updater-guard"]);
export const SERVICE_BATCH_ROLES_V1 = Object.freeze([
  DATABASE_SERVICE_ROLES_V1, CORE_SERVICE_ROLES_V1, POST_HEALTH_SERVICE_ROLES_V1,
]);
/** Fixed shutdown policy. Every bootout path filters this complete list instead of trusting a receipt's labels. */
export const SERVICE_POLICY_LABELS_V1 = Object.freeze([
  Object.freeze({ role: "updater-guard", label: "xyz.agentcontrolroom.updater-guard",
    plistPath: "/Library/LaunchDaemons/xyz.agentcontrolroom.updater-guard.plist" }),
  Object.freeze({ role: "updater", label: "xyz.agentcontrolroom.updater",
    plistPath: "/Library/LaunchDaemons/xyz.agentcontrolroom.updater.plist" }),
  Object.freeze({ role: "nightly-backup", label: "xyz.agentcontrolroom.nightly-backup",
    plistPath: "/Library/LaunchDaemons/xyz.agentcontrolroom.nightly-backup.plist" }),
  Object.freeze({ role: "fleet-gateway", label: "xyz.agentcontrolroom.gateway",
    plistPath: "/Library/LaunchDaemons/xyz.agentcontrolroom.gateway.plist" }),
  Object.freeze({ role: "supervisor", label: "xyz.agentcontrolroom.supervisor",
    plistPath: "/Library/LaunchDaemons/xyz.agentcontrolroom.supervisor.plist" }),
  Object.freeze({ role: "postgresql17", label: "xyz.agentcontrolroom.postgres",
    plistPath: "/Library/LaunchDaemons/xyz.agentcontrolroom.postgres.plist" }),
]);
const serviceLabelPattern = /^xyz\.agentcontrolroom\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

const accountPattern = /^_[a-z][a-z0-9_]{1,30}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const protectedConfigRelativePaths = Object.freeze([
  "Protected/config/host.json",
  "Protected/config/local-owner-session.json",
  "Protected/config/fleet-gateway.json",
  "Protected/config/supervisor.json",
  "Protected/config/backup.json",
  "Protected/config/mac-local.json", "Protected/config/database-roles.json", "Protected/config/release-trust.json",
  "updater-state/updater.json",
]);

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => `sha256:${createHash("sha256").update(canonicalJsonV1(value), "utf8").digest("hex")}`;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const absolutePath = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && normalize(value) === value && value !== "/" && !value.endsWith("/")
  && !/[\u0000-\u001f\u007f]/u.test(value);
const within = (root, value) => {
  const path = relative(root, value);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

function account(value) {
  if (!exactKeys(value, ["name", "uid", "gid", "created"]) || !accountPattern.test(value.name)
    || !Number.isSafeInteger(value.uid) || value.uid < 1 || value.uid > 0x7fffffff
    || !Number.isSafeInteger(value.gid) || value.gid < 1 || value.gid > 0x7fffffff
    || typeof value.created !== "boolean") refuse("services_batch_uncertain");
  return Object.freeze({ name: value.name, uid: value.uid, gid: value.gid, created: value.created });
}

function accounts(value) {
  if (!exactKeys(value, ["builder", "database", "service"])) refuse("services_batch_uncertain");
  const parsed = Object.freeze({ builder: account(value.builder), database: account(value.database), service: account(value.service) });
  if (["name", "uid", "gid"].some(field => new Set(Object.values(parsed).map(entry => entry[field])).size !== 3)) refuse("services_batch_uncertain");
  return parsed;
}

export function validateServiceRolesV1(value, { batch = false } = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > SERVICE_ROLES_V1.length
    || value.some(role => !SERVICE_ROLES_V1.includes(role)) || new Set(value).size !== value.length) {
    refuse("services_batch_uncertain");
  }
  const roles = SERVICE_ROLES_V1.filter(role => value.includes(role));
  if (batch && !SERVICE_BATCH_ROLES_V1.some(expected => canonicalJsonV1(roles) === canonicalJsonV1(expected))) {
    refuse("services_batch_uncertain");
  }
  return Object.freeze(roles);
}

export function validateServicePolicyV1(value = SERVICE_POLICY_LABELS_V1) {
  if (!Array.isArray(value) || value.length !== SERVICE_ROLES_V1.length) refuse("services_batch_uncertain");
  const byRole = new Map();
  for (const service of value) {
    if (!exactKeys(service, ["role", "label", "plistPath"]) || !SERVICE_ROLES_V1.includes(service.role)
      || byRole.has(service.role) || !serviceLabelPattern.test(service.label) || service.label.length > 128
      || service.plistPath !== `/Library/LaunchDaemons/${service.label}.plist`) refuse("services_batch_uncertain");
    byRole.set(service.role, Object.freeze({ role: service.role, label: service.label, plistPath: service.plistPath }));
  }
  if (new Set(value.map(service => service.label)).size !== SERVICE_ROLES_V1.length) refuse("services_batch_uncertain");
  return Object.freeze(SERVICE_POLICY_LABELS_V1.map(service => byRole.get(service.role)));
}

export function servicePolicyForRolesV1(value, servicePolicy = SERVICE_POLICY_LABELS_V1) {
  const roles = validateServiceRolesV1(value);
  return Object.freeze(validateServicePolicyV1(servicePolicy).filter(service => roles.includes(service.role)));
}

export function newsyslogPathForPolicyV1(servicePolicy = SERVICE_POLICY_LABELS_V1) {
  const policy = validateServicePolicyV1(servicePolicy);
  if (canonicalJsonV1(policy) === canonicalJsonV1(SERVICE_POLICY_LABELS_V1)) return "/etc/newsyslog.d/xyz.agentcontrolroom.conf";
  return `/etc/newsyslog.d/${policy.find(service => service.role === "supervisor").label}.conf`;
}

function protectedConfiguration(value, root, parsedAccounts) {
  if (!Array.isArray(value) || value.length > 64) refuse("services_batch_uncertain");
  const names = new Map([...Object.values(parsedAccounts).map(entry => [entry.name, entry]),
    ["root", { uid: 0, gid: 0 }], ["wheel", { uid: 0, gid: 0 }]]);
  const paths = new Set();
  return Object.freeze(value.map(resource => {
    if (!exactKeys(resource, ["path", "contents", "accountName", "groupName", "fileMode"])
      || !absolutePath(resource.path) || !within(root, resource.path)
      || typeof resource.contents !== "string" || resource.contents.length < 1
      || Buffer.byteLength(resource.contents) > 512 * 1024 || !["0600", "0640"].includes(resource.fileMode)
      || resource.fileMode === "0640" && (resource.accountName !== "root"
        || resource.groupName !== parsedAccounts.service.name
        || !resource.path.startsWith(join(root, "Protected", "config") + sep))
      || !names.has(resource.accountName) || !names.has(resource.groupName) || paths.has(resource.path)) {
      refuse("services_batch_uncertain");
    }
    paths.add(resource.path);
    return Object.freeze({ kind: "protected_config", path: resource.path, contents: resource.contents,
      accountName: resource.accountName, groupName: resource.groupName, fileMode: resource.fileMode,
      sha256: sha256(resource.contents) });
  }));
}

const xmlEscape = value => value.replace(/[&<>"']/gu,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

function renderPlist(input) {
  const environment = Object.entries(input.environment ?? {}).sort(([left], [right]) => left.localeCompare(right, "en"));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <!-- ${input.role === "postgresql17" ? "postgresql.conf must set listen_addresses='' and ssl = off. Database updates stop this job with launchctl bootout first, then verify postmaster.pid, socket closure, and pg_controldata shut down before changing pg/current." : "Generated Control Room service; privileged lifecycle changes use the verified elevated batch."} -->`,
    '  <key>Label</key>', `  <string>${xmlEscape(input.label)}</string>`,
    '  <key>ProgramArguments</key>', '  <array>',
    ...input.programArguments.map(value => `    <string>${xmlEscape(value)}</string>`), '  </array>',
    // The real per-role working directory, not `/`.
    //
    // MEASURED: this hardcoded `/` and made
    // `the dependency-free generator emits byte-identical plists to the TypeScript
    // authority for three inputs` fail on four roles at once - every sandboxed daemon
    // would have started in `/` regardless of the `-D WORKING_DIRECTORY` the sandbox
    // definition carries. The authority threads `workingDirectory` per role; this reads
    // the same field, so the two cannot drift on it.
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


/** Pure, dependency-free service composition for the two install batches. */
export function composeServiceBundleV1(input) {
  const inputKeys = ["root", "accounts", "roles", "protectedConfig", "pgRuntime", "updaterVersion"];
  if (!exactKeys(input, input.servicePolicy === undefined ? inputKeys : [...inputKeys, "servicePolicy"])
    || !absolutePath(input.root) || !absolutePath(input.pgRuntime)
    || !within(join(input.root, "runtime"), input.pgRuntime) || !input.pgRuntime.endsWith("/bin/postgres") || !versionPattern.test(input.updaterVersion ?? "")) {
    refuse("services_batch_uncertain");
  }
  const parsedAccounts = accounts(input.accounts), roles = validateServiceRolesV1(input.roles, { batch: true });
  const servicePolicy = validateServicePolicyV1(input.servicePolicy);
  const root = input.root, protectedRoot = join(root, "Protected"), logDirectory = join(root, "logs");
  const protectedConfig = protectedConfiguration(input.protectedConfig, root, parsedAccounts);
  const coreBatch = canonicalJsonV1(roles) === canonicalJsonV1(CORE_SERVICE_ROLES_V1);
  if (!coreBatch && protectedConfig.length !== 0) refuse("services_batch_uncertain");
  const expectedProtectedPaths = protectedConfigRelativePaths.map(path => join(root, path));
  if (coreBatch && canonicalJsonV1(protectedConfig.map(resource => resource.path).sort())
    !== canonicalJsonV1(expectedProtectedPaths.sort())) refuse("services_batch_uncertain");
  const serviceAccounts = {
    controlRoom: { user: parsedAccounts.service.name, group: parsedAccounts.service.name },
    database: { user: parsedAccounts.database.name, group: parsedAccounts.database.name },
  };
  const current = join(root, "current"), runtimeNode = join(root, "runtime", "node-current", "bin", "node");
  const sandbox = "/usr/bin/sandbox-exec";
  const profile = role => join(root, "updater", "current", "policy", `service-${role}.sb`);
  const logPath = (role, stream) => join(logDirectory, role, `${stream}.log`);
  // `WORKING_DIRECTORY` is a sandbox definition, so it is passed like one, and it is
  // the same value the TS authority threads in `macos-launch-daemon-bundle.ts`. This
  // module is the DEPENDENCY-FREE mirror of that authority and the two are compared
  // byte for byte, so a divergence here is a divergence in what actually gets installed.
  //
  // MEASURED: it was absent, and
  // `the dependency-free generator emits byte-identical plists to the TypeScript
  // authority for three inputs` failed on exactly the missing
  // `-D WORKING_DIRECTORY=<root>/current` pair for fleet-gateway. Without it the
  // sandboxed service inherits the launchd default working directory, which is `/`.
  const sandboxArgs = (role, workingDirectory, values, executable, args) => ["-f", profile(role),
    ...Object.entries({ ...values, RUNTIME_ROOT: join(root, "runtime"), RELEASE_ROOT: join(root, "releases"),
      UPDATER_ROOT: join(root, "updater"), WORKING_DIRECTORY: workingDirectory })
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .flatMap(([name, value]) => ["-D", `${name}=${value}`]), "--", executable, ...args];
  const definitions = [
    { role: "postgresql17", executable: sandbox, workingDirectory: join(root, "pg", "current"),
      args: sandboxArgs("postgres", join(root, "pg", "current"), { DATA_ROOT: join(root, "pg"), SOCKET_ROOT: join(root, "pg", "socket"),
        OUT_LOG: logPath("postgresql17", "out"), ERR_LOG: logPath("postgresql17", "err") }, input.pgRuntime,
      ["-D", join(root, "pg", "current"), "-k", join(root, "pg", "socket")]), keepAlive: true, exitTimeOut: 120 },
    { role: "supervisor", executable: sandbox, workingDirectory: current,
      args: sandboxArgs("supervisor", current, { RUNTIME_STATE: join(protectedRoot, "runtime-state"),
        OUT_LOG: logPath("supervisor", "out"), ERR_LOG: logPath("supervisor", "err") }, runtimeNode,
      [join(current, "scripts", "mac-local", "task-host-supervisor.mjs"), "--protected-root", protectedRoot]),
      keepAlive: true, exitTimeOut: 45 },
    { role: "fleet-gateway", executable: sandbox, workingDirectory: current,
      args: sandboxArgs("gateway", current, { RUNTIME_STATE: join(protectedRoot, "runtime-state"),
        OUT_LOG: logPath("fleet-gateway", "out"), ERR_LOG: logPath("fleet-gateway", "err") }, runtimeNode,
      [join(current, "dist-vps", "server", "fleetGateway.js"), "--configuration", join(protectedRoot, "config", "fleet-gateway.json")]),
      keepAlive: "failed", exitTimeOut: 45 },
    { role: "nightly-backup", executable: runtimeNode, workingDirectory: current,
      args: [join(current, "dist-vps", "server", "nightlyBackup.js"), "--configuration", join(protectedRoot, "config", "backup.json")],
      // R4S-11, kept in step with the TypeScript authority by the byte-identical
      // equivalence test rather than by a shared import: this module is the
      // dependency-free generator and must not grow one. `NIGHTLY_DUMP_TIMEOUT_MS_V1`
      // in `src/installer/v1/nightly-backup-configuration.ts` is the source of
      // truth, and this expression is the same arithmetic over the same number.
      // If the authority's value moves and this does not, that test fails.
      keepAlive: false, exitTimeOut: Math.ceil((45 * 60 * 1000) / 1000) + 60, nightly: true },
    { role: "updater", executable: runtimeNode, workingDirectory: join(root, "updater", "current"),
      args: [join(root, "updater", "current", "updater.mjs"), "--configuration", join(root, "updater-state", "updater.json")],
      keepAlive: true, exitTimeOut: 60 },
    { role: "updater-guard", executable: "/bin/sh", workingDirectory: join(root, "guard"),
      args: ["-p", join(root, "guard", "guard.sh"), "watch"],
      keepAlive: false, exitTimeOut: 60, startInterval: 60 },
  ];
  for (const definition of definitions) {
    const allowedRoots = ["runtime", "updater", "current", "guard"].map(name => join(root, name));
    if (definition.executable !== "/bin/sh" && definition.executable !== sandbox
      && !allowedRoots.some(allowed => within(allowed, definition.executable))) refuse("macos_launch_daemon_executable_refused");
    if (definition.args.filter(argument => argument.startsWith("/"))
      .some(value => value !== "/dev/null" && !within(root, value))) refuse("macos_launch_daemon_path_refused");
  }
  const allServices = definitions.map(definition => {
    const policy = servicePolicy.find(service => service.role === definition.role);
    const accountFor = definition.role === "postgresql17" ? serviceAccounts.database
      : definition.role === "updater" || definition.role === "updater-guard" ? undefined : serviceAccounts.controlRoom;
    const identity = definition.role === "postgresql17" ? parsedAccounts.database
      : definition.role === "updater" || definition.role === "updater-guard" ? { name: "root", uid: 0, gid: 0 }
        : parsedAccounts.service;
    return Object.freeze({ role: definition.role, label: policy.label, workingDirectory: definition.workingDirectory,
      plistPath: policy.plistPath, accountName: accountFor?.user ?? "root",
      groupName: accountFor?.group ?? "wheel", uid: identity.uid, gid: identity.gid,
      standardOutPath: logPath(definition.role, "out"), standardErrorPath: logPath(definition.role, "err") });
  });
  const services = Object.freeze(allServices.filter(service => roles.includes(service.role)));
  const allPlists = definitions.map((definition, index) => {
    const service = allServices[index], accountFor = definition.role === "postgresql17" ? serviceAccounts.database
      : definition.role === "updater" || definition.role === "updater-guard" ? undefined : serviceAccounts.controlRoom;
    const environment = definition.role === "postgresql17" ? {
      OPENSSL_CONF: join(root, "runtime", "pg-current", "etc", "openssl.cnf"),
      OPENSSL_MODULES: join(root, "runtime", "pg-current", "lib", "ossl-modules"),
      KRB5_CONFIG: "/dev/null", KRB5_KDC_PROFILE: "/dev/null",
    // The sandbox's one writable tree, as the PROCESS sees it: `-D RUNTIME_STATE` only
    // parameterises the Seatbelt profile and never reaches the environment, and the
    // supervisor, its task host and the gateway read it from there
    // (`macLocalRuntimeDirectoryV1`). MEASURED (cl-svc3): without it the supervisor
    // wrote under `Protected/runtime`, which the profile denies, and exited at start.
    } : definition.role === "supervisor" || definition.role === "fleet-gateway"
      ? { RUNTIME_STATE: join(protectedRoot, "runtime-state") } : undefined;
    const contents = renderPlist({ role: definition.role, label: service.label, account: accountFor,
      workingDirectory: definition.workingDirectory,
      programArguments: [runtimeNode, join(root, "updater", "current", "service-output.mjs"),
        "--out", service.standardOutPath, "--err", service.standardErrorPath, "--shutdown-ms", String((definition.exitTimeOut - 5) * 1000),
        "--", definition.executable, ...definition.args], environment,
      standardOutPath: "/dev/null", standardErrorPath: "/dev/null",
      keepAlive: definition.keepAlive, exitTimeOut: definition.exitTimeOut,
      ...(definition.role === "updater-guard" ? { startInterval: definition.startInterval } : {}),
      ...(definition.role === "nightly-backup" ? { nightly: true } : {}) });
    return Object.freeze({ kind: "launchd_plist", role: definition.role, path: service.plistPath, contents,
      mode: "0644", uid: 0, gid: 0, sha256: sha256(contents) });
  });
  const logFiles = Object.freeze(services.flatMap(service => [service.standardOutPath, service.standardErrorPath].map(path =>
    Object.freeze({ directory: join(logDirectory, service.role), path, uid: service.uid, gid: service.gid,
      directoryMode: "0755", fileMode: "0600" }))));
  const resources = [...allPlists.filter(resource => roles.includes(resource.role))];
  if (coreBatch) {
    const rotationPath = newsyslogPathForPolicyV1(servicePolicy);
    const rotationContents = "# Control Room service logs are capped at 10 MiB per stream by service-output.mjs.\n"
      + "# No newsyslog rules: the collector truncates its own inode and never keeps writing an archive.\n";
    resources.push(Object.freeze({ kind: "newsyslog_config", path: rotationPath, contents: rotationContents,
      mode: "0644", uid: 0, gid: 0, sha256: sha256(rotationContents) }), ...protectedConfig.map(resource => {
      const identities = new Map([...Object.values(parsedAccounts).map(entry => [entry.name, entry]),
        ["root", { uid: 0, gid: 0 }], ["wheel", { uid: 0, gid: 0 }]]);
      const owner = identities.get(resource.accountName), group = identities.get(resource.groupName);
      return Object.freeze({ ...resource, mode: resource.fileMode, uid: owner.uid, gid: group.gid });
    }));
  }
  const writableDirectories = Object.freeze([
    Object.freeze({ path: logDirectory, uid: 0, gid: 0, mode: "0755" }),
    ...(roles.includes("supervisor") || roles.includes("fleet-gateway") || roles.includes("nightly-backup") ? [
      Object.freeze({ path: join(protectedRoot, "runtime-state"), uid: parsedAccounts.service.uid,
        gid: parsedAccounts.service.gid, mode: "0700" }),
    ] : []),
    ...(roles.includes("updater") || roles.includes("updater-guard") ? [
      Object.freeze({ path: join(root, "updater-state"), uid: 0, gid: 0, mode: "0700" }),
      Object.freeze({ path: join(root, "updater-state", "plans"), uid: 0, gid: 0, mode: "0700" }),
      Object.freeze({ path: join(root, "updater-state", "tmp"), uid: 0, gid: 0, mode: "0700" }),
    ] : []),
    ...(roles.includes("nightly-backup") ? [
      Object.freeze({ path: join(root, "backups"), uid: 0, gid: parsedAccounts.service.gid, mode: "0710" }),
      Object.freeze({ path: join(root, "backups", "nightly"), uid: 0, gid: parsedAccounts.service.gid, mode: "0770" }),
      Object.freeze({ path: join(protectedRoot, "runtime-state", "nightly-backup"), uid: 0,
        gid: parsedAccounts.service.gid, mode: "0770" }),
    ] : []),
  ]);
  const unsigned = { schema: SERVICE_BUNDLE_SCHEMA_V1, root, accounts: parsedAccounts, roles,
    protectedConfig, pgRuntime: input.pgRuntime, updaterVersion: input.updaterVersion,
    ...(input.servicePolicy === undefined ? {} : { servicePolicy }),
    services, logFiles, writableDirectories, resources: Object.freeze(resources) };
  return Object.freeze({ ...unsigned, bundleDigest: sha256(unsigned) });
}

/** Re-composes serialized input so a journal cannot retarget privileged paths. */
export function verifyServiceBundleV1(value) {
  const keys = ["schema", "root", "accounts", "roles", "protectedConfig", "pgRuntime", "updaterVersion",
    "services", "logFiles", "writableDirectories", "resources", "bundleDigest"];
  if (!exactKeys(value, value.servicePolicy === undefined ? keys : [...keys, "servicePolicy"])
    || value.schema !== SERVICE_BUNDLE_SCHEMA_V1 || !digestPattern.test(value.bundleDigest ?? "")) {
    refuse("services_batch_uncertain");
  }
  const protectedConfig = value.protectedConfig.map(resource => ({ path: resource.path, contents: resource.contents,
    accountName: resource.accountName, groupName: resource.groupName, fileMode: resource.fileMode }));
  const expected = composeServiceBundleV1({ root: value.root, accounts: value.accounts, roles: value.roles,
    protectedConfig, pgRuntime: value.pgRuntime, updaterVersion: value.updaterVersion,
    ...(value.servicePolicy === undefined ? {} : { servicePolicy: value.servicePolicy }) });
  if (canonicalJsonV1(value) !== canonicalJsonV1(expected)) refuse("services_batch_uncertain");
  return expected;
}

export const serviceBundleDigestV1 = sha256;
