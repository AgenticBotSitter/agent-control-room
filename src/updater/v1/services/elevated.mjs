import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lchown, lstat, mkdir, open, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalJsonV1 } from "../canonical-json.mjs";
import { CORE_SERVICE_ROLES_V1, newsyslogPathForPolicyV1, serviceBundleDigestV1, servicePolicyForRolesV1,
  validateServicePolicyV1,
  validateServiceRolesV1, verifyServiceBundleV1 } from "./bundle.mjs";

export const SERVICE_RECEIPT_SCHEMA_V1 = "control-room.services-receipt/v1";
const runFile = promisify(execFile);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function receiptFor(bundle) {
  const unsigned = { schema: SERVICE_RECEIPT_SCHEMA_V1, root: bundle.root, bundleDigest: bundle.bundleDigest,
    roles: bundle.roles, services: Object.freeze(bundle.services.map(({ role, label, plistPath }) =>
      Object.freeze({ role, label, plistPath }))), resources: Object.freeze(bundle.resources.map(({ kind, path, sha256 }) =>
      Object.freeze({ kind, path, sha256 }))) };
  return Object.freeze({ ...unsigned, receiptDigest: serviceBundleDigestV1(unsigned) });
}

export function verifyServiceReceiptV1(value, root, servicePolicyValue) {
  if (!exactKeys(value, ["schema", "root", "bundleDigest", "roles", "services", "resources", "receiptDigest"])
    || value.schema !== SERVICE_RECEIPT_SCHEMA_V1 || value.root !== root
    || !digestPattern.test(value.bundleDigest ?? "") || !digestPattern.test(value.receiptDigest ?? "")) {
    refuse("services_batch_uncertain");
  }
  const roles = validateServiceRolesV1(value.roles, { batch: true });
  if (!Array.isArray(value.services) || !Array.isArray(value.resources)
    || value.services.some(service => !exactKeys(service, ["role", "label", "plistPath"]))
    || value.resources.some(resource => !exactKeys(resource, ["kind", "path", "sha256"])
      || !["launchd_plist", "newsyslog_config", "protected_config"].includes(resource.kind)
      || !digestPattern.test(resource.sha256)) || new Set(value.resources.map(resource => resource.path)).size !== value.resources.length) {
    refuse("services_batch_uncertain");
  }
  const servicePolicy = validateServicePolicyV1(servicePolicyValue);
  const policy = servicePolicyForRolesV1(roles, servicePolicy);
  const expectedServices = roles.map(role => {
    const service = policy.find(entry => entry.role === role);
    return { role, label: service.label, plistPath: service.plistPath };
  });
  const expectedPlists = new Map(expectedServices.map(service => [service.plistPath, service.role]));
  const expectedProtectedPaths = ["host.json", "local-owner-session.json", "fleet-gateway.json", "supervisor.json",
    "backup.json", "mac-local.json", "database-roles.json", "release-trust.json"].map(name => join(root, "Protected", "config", name)).concat(join(root, "updater-state", "updater.json"));
  const protectedPaths = value.resources.filter(resource => resource.kind === "protected_config")
    .map(resource => resource.path).sort();
  if (canonicalJsonV1(value.services) !== canonicalJsonV1(expectedServices)
    || value.resources.filter(resource => resource.kind === "launchd_plist").length !== roles.length
    || value.resources.some(resource => resource.kind === "launchd_plist" && !expectedPlists.has(resource.path))
    || roles.join("\0") !== CORE_SERVICE_ROLES_V1.join("\0")
      && value.resources.some(resource => resource.kind !== "launchd_plist")
    || roles.join("\0") === CORE_SERVICE_ROLES_V1.join("\0")
      && (value.resources.filter(resource => resource.kind === "newsyslog_config").length !== 1
      || value.resources.find(resource => resource.kind === "newsyslog_config")?.path
        !== newsyslogPathForPolicyV1(servicePolicy)
      || canonicalJsonV1(protectedPaths) !== canonicalJsonV1(expectedProtectedPaths.sort()))) {
    refuse("services_batch_uncertain");
  }
  const unsigned = { schema: value.schema, root: value.root, bundleDigest: value.bundleDigest, roles: value.roles,
    services: value.services, resources: value.resources };
  if (serviceBundleDigestV1(unsigned) !== value.receiptDigest) refuse("services_batch_uncertain");
  return Object.freeze({ ...unsigned, receiptDigest: value.receiptDigest });
}

function defaultRuntime() {
  return Object.freeze({
    geteuid: () => process.geteuid?.() ?? -1,
    pathFor: path => path,
    lstat, mkdir, open, readFile, unlink, rmdir, lchown,
    execute: (file, args) => runFile(file, args, { env: { PATH: "/usr/bin:/bin", HOME: "/var/root" },
      timeout: 30_000, maxBuffer: 1024 * 1024 }),
    enforceMetadata: true,
    isServiceLoaded: async label => runFile("/bin/launchctl", ["print", `system/${label}`], {
      env: { PATH: "/usr/bin:/bin", HOME: "/var/root" }, timeout: 30_000, maxBuffer: 1024 * 1024,
    }).then(() => true, error => error?.code === 3 || error?.code === "ESRCH" ? false : Promise.reject(error)),
    verifyPostgresShutdown: verifyPostgresShutdownV1,
  });
}

/**
 * The cluster behind `pg/current` is shut down. With NO cluster there — the link
 * absent or dangling, as after a rollback that retired the data folder or a stop
 * before `initdb` made one — there is nothing that can be running from it, and
 * the answer is yes, not a raw ENOENT from `pg_controldata` that refused every
 * retry's recovery (atk-fa F3). A live socket or `postmaster.pid` is still no.
 */
export async function verifyPostgresShutdownV1({ root, execute, pathFor = path => path }) {
  const exists = path => lstat(pathFor(path)).then(() => true,
    error => error?.code === "ENOENT" ? false : Promise.reject(error));
  const pid = await exists(join(root, "pg", "current", "postmaster.pid"));
  const socket = await exists(join(root, "pg", "socket", ".s.PGSQL.5432"));
  if (pid || socket) return false;
  const cluster = await stat(pathFor(join(root, "pg", "current"))).then(entry => entry.isDirectory() ? true
    : Promise.reject(Object.assign(new Error("postgres_not_shut_down"), { code: "postgres_not_shut_down" })),
  error => error?.code === "ENOENT" ? false : Promise.reject(error));
  if (!cluster) return true;
  const tool = join(root, "runtime", "pg-current", "bin", "pg_controldata");
  if (!await exists(tool)) return false;
  const result = await execute(tool,
    [join(root, "pg", "current")]);
  return /^Database cluster state:\s+shut down\s*$/mu.test(result.stdout ?? "");
}

async function ensureDirectory(runtime, path, mode, uid, gid, createdDirectories) {
  const target = runtime.pathFor(path);
  if (!isAbsolute(target) || resolve(target) !== target) refuse("services_batch_uncertain");
  const parts = target.split(sep).filter(Boolean);
  let current = sep;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat = await runtime.lstat(current).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat) {
      await runtime.mkdir(current, { recursive: false, mode: index === parts.length - 1 ? Number.parseInt(mode, 8) : 0o755 });
      createdDirectories.push(current); stat = await runtime.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("services_batch_uncertain");
  }
  const directoryStat = await runtime.lstat(target);
  if ((directoryStat.mode & 0o002) !== 0) refuse("services_batch_uncertain");
  const handle = await runtime.open(target, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isDirectory()) refuse("services_batch_uncertain");
    await handle.chown(uid, gid);
    await handle.chmod(Number.parseInt(mode, 8));
    const after = await handle.stat(), named = await runtime.lstat(target);
    if (after.dev !== named.dev || after.ino !== named.ino || !named.isDirectory() || named.isSymbolicLink()
      || (after.mode & 0o7777) !== Number.parseInt(mode, 8)
      || runtime.enforceMetadata && (after.uid !== uid || after.gid !== gid)) refuse("services_batch_uncertain");
  } finally { await handle.close(); }
}

/**
 * A protected-config file's parent is the installer LAYOUT's directory
 * (`Protected/config` root:service 0750, `updater-state` root 0700). It must
 * already exist, be a real directory and carry no group or other write — the
 * same refusal `ensureDirectory` gives — but it is NOT re-owned here.
 * MEASURED (cl-bringup N-I): `ensureDirectory(…, 0, 0)` turned `Protected/config`
 * into root:wheel, and the service account could no longer enter the directory
 * holding every file the web host and the gateway read.
 */
async function assertLayoutDirectory(runtime, path) {
  const stat = await runtime.lstat(runtime.pathFor(path)).catch(() => refuse("services_batch_uncertain"));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) refuse("services_batch_uncertain");
}

async function inspectFile(runtime, resource) {
  const path = runtime.pathFor(resource.path);
  const handle = await runtime.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) refuse("services_batch_uncertain");
    const contents = (await handle.readFile()).toString("utf8");
    return { contents, sha256: serviceBundleDigestV1(contents), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
  } finally { await handle.close(); }
}

async function createFile(runtime, resource, createdFiles) {
  const current = await inspectFile(runtime, resource);
  if (current) {
    if (current.sha256 !== resource.sha256 || runtime.enforceMetadata
      && (current.mode !== Number.parseInt(resource.mode, 8) || current.uid !== resource.uid || current.gid !== resource.gid)) {
      refuse("services_batch_uncertain");
    }
    return false;
  }
  const target = runtime.pathFor(resource.path);
  const handle = await runtime.open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
    | fsConstants.O_NOFOLLOW, Number.parseInt(resource.mode, 8));
  try {
    const owned = { path: target, dev: null, ino: null };
    createdFiles.push(owned);
    const stat = await handle.stat();
    owned.dev = stat.dev; owned.ino = stat.ino;
    await handle.writeFile(resource.contents);
    await handle.chown(resource.uid, resource.gid);
    await handle.chmod(Number.parseInt(resource.mode, 8)); await handle.sync();
  } finally { await handle.close(); }
  return true;
}

async function createLogFile(runtime, log, createdFiles, createdDirectories) {
  await ensureDirectory(runtime, log.directory, log.directoryMode, 0, 0, createdDirectories);
  const target = runtime.pathFor(log.path);
  const current = await runtime.lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || runtime.enforceMetadata
      && ((current.mode & 0o7777) !== Number.parseInt(log.fileMode, 8) || current.uid !== log.uid || current.gid !== log.gid)) {
      refuse("services_batch_uncertain");
    }
    return;
  }
  const handle = await runtime.open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
    | fsConstants.O_NOFOLLOW, Number.parseInt(log.fileMode, 8));
  try {
    const owned = { path: target, dev: null, ino: null };
    createdFiles.push(owned);
    const stat = await handle.stat();
    owned.dev = stat.dev; owned.ino = stat.ino;
    await handle.chown(log.uid, log.gid);
    await handle.chmod(Number.parseInt(log.fileMode, 8)); await handle.sync();
  } finally { await handle.close(); }
}

async function verifyLivePaths(runtime, bundle) {
  const search = async (path, uid, gid) => {
    for (let current = dirname(path); current.startsWith(bundle.root); current = dirname(current)) {
      const handle = await runtime.open(runtime.pathFor(current),
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try {
        const entry = await handle.stat();
        const shift = entry.uid === uid ? 6 : entry.gid === gid ? 3 : 0;
        if (!entry.isDirectory() || runtime.enforceMetadata && uid !== 0 && ((entry.mode >> shift) & 1) !== 1) {
          refuse("services_batch_uncertain");
        }
      } finally { await handle.close(); }
      if (current === bundle.root) break;
    }
  };
  for (const directory of bundle.writableDirectories) {
    const service = directory.gid === bundle.accounts.service.gid ? bundle.accounts.service : { uid: 0, gid: 0 };
    await search(directory.path, service.uid, service.gid);
    const handle = await runtime.open(runtime.pathFor(directory.path),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const entry = await handle.stat();
      if (!entry.isDirectory() || (entry.mode & 0o7777) !== Number.parseInt(directory.mode, 8)
        || runtime.enforceMetadata && (entry.uid !== directory.uid || entry.gid !== directory.gid)) {
        refuse("services_batch_uncertain");
      }
    } finally { await handle.close(); }
  }
  for (const log of bundle.logFiles) {
    await search(log.path, log.uid, log.gid);
    const parent = await runtime.open(runtime.pathFor(log.directory),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const entry = await parent.stat();
      if (!entry.isDirectory() || (entry.mode & 0o7777) !== Number.parseInt(log.directoryMode, 8)
        || runtime.enforceMetadata && (entry.uid !== 0 || entry.gid !== 0)) refuse("services_batch_uncertain");
    } finally { await parent.close(); }
    const handle = await runtime.open(runtime.pathFor(log.path),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const entry = await handle.stat();
      const named = await runtime.lstat(runtime.pathFor(log.path));
      if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o7777) !== Number.parseInt(log.fileMode, 8)
        || !named.isFile() || named.isSymbolicLink() || named.dev !== entry.dev || named.ino !== entry.ino
        || runtime.enforceMetadata && (entry.uid !== log.uid || entry.gid !== log.gid)) {
        refuse("services_batch_uncertain");
      }
    } finally { await handle.close(); }
  }
}

async function removeCreatedFile(runtime, entry) {
  const named = await runtime.lstat(entry.path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!named) return;
  if (!named.isFile() || named.isSymbolicLink() || named.dev !== entry.dev || named.ino !== entry.ino) {
    refuse("services_batch_uncertain");
  }
  await runtime.unlink(entry.path);
}

async function bootout(runtime, label) {
  await runtime.execute("/bin/launchctl", ["bootout", `system/${label}`]).catch(error => {
    if (error?.code !== "ESRCH" && error?.code !== 3) refuse("launchctl_refused");
  });
}

async function verifyPostgres(runtime, root) {
  if (!await runtime.verifyPostgresShutdown({ root, execute: runtime.execute, pathFor: runtime.pathFor })) {
    refuse("postgres_not_shut_down");
  }
}

async function bootoutRoles(runtime, root, roles, servicePolicy, onError) {
  if (roles.length === 0) return;
  for (const service of servicePolicyForRolesV1(roles, servicePolicy)) {
    try {
      await bootout(runtime, service.label);
      if (service.role === "postgresql17") await verifyPostgres(runtime, root);
    } catch (error) {
      if (!onError) throw error;
      onError(error);
    }
  }
}

async function removeReceiptResources(runtime, receipt, signal) {
  for (const resource of [...receipt.resources].reverse()) {
    if (signal.aborted) refuse("services_batch_uncertain");
    const current = await inspectFile(runtime, resource);
    if (!current) continue;
    if (current.sha256 !== resource.sha256) refuse("services_batch_uncertain");
    await runtime.unlink(runtime.pathFor(resource.path));
  }
}

/** Root-only implementation; it deliberately owns no second install lock or sudo hop. */
export function createInProcessServiceElevatedPortV1(overrides = {}) {
  const runtime = Object.freeze({ ...defaultRuntime(), ...overrides });
  if (runtime.geteuid() !== 0) refuse("services_batch_uncertain");
  let active = false;
  const exclusive = async effect => {
    if (active) refuse("services_batch_uncertain");
    active = true;
    try { return await effect(); } finally { active = false; }
  };

  return Object.freeze({
    install: (bundleValue, signal) => exclusive(async () => {
      const bundle = verifyServiceBundleV1(bundleValue), receipt = receiptFor(bundle);
      const servicePolicy = validateServicePolicyV1(bundle.servicePolicy);
      if (!(signal instanceof AbortSignal) || signal.aborted) refuse("services_batch_uncertain");
      const existing = await Promise.all(bundle.resources.map(resource => inspectFile(runtime, resource)));
      const exactResource = (entry, resource) => entry?.sha256 === resource.sha256 && (!runtime.enforceMetadata
        || entry.mode === Number.parseInt(resource.mode, 8) && entry.uid === resource.uid && entry.gid === resource.gid);
      if (existing.some((entry, index) => entry && !exactResource(entry, bundle.resources[index]))) {
        refuse("services_batch_uncertain");
      }
      const loaded = await Promise.all(bundle.services.map(service => runtime.isServiceLoaded(service.label)));
      if (existing.every((entry, index) => exactResource(entry, bundle.resources[index])) && loaded.every(Boolean)) {
        await verifyLivePaths(runtime, bundle);
        return Object.freeze({ outcome: "unchanged", receipt });
      }
      if (loaded.some(Boolean)) refuse("services_batch_uncertain");
      const createdFiles = [], createdDirectories = [], started = [];
      try {
        for (const directory of bundle.writableDirectories) {
          if (signal.aborted) refuse("services_batch_uncertain");
          await ensureDirectory(runtime, directory.path, directory.mode, directory.uid, directory.gid, createdDirectories);
        }
        for (const log of bundle.logFiles) {
          if (signal.aborted) refuse("services_batch_uncertain");
          await createLogFile(runtime, log, createdFiles, createdDirectories);
        }
        for (const resource of bundle.resources) {
          if (signal.aborted) refuse("services_batch_uncertain");
          if (resource.kind === "protected_config") await assertLayoutDirectory(runtime, dirname(resource.path));
          else await ensureDirectory(runtime, dirname(resource.path), "0755", 0, 0, createdDirectories);
          await createFile(runtime, resource, createdFiles);
        }
        await verifyLivePaths(runtime, bundle);
        for (const service of bundle.services) {
          if (signal.aborted) refuse("services_batch_uncertain");
          try { await runtime.execute("/bin/launchctl", ["bootstrap", "system", service.plistPath]); } catch {
            if (await runtime.isServiceLoaded(service.label).catch(() => refuse("services_batch_uncertain"))) {
              started.push(service);
            }
            refuse("launchctl_refused");
          }
          started.push(service);
        }
        if (signal.aborted) refuse("services_batch_uncertain");
        return Object.freeze({ outcome: "completed", receipt });
      } catch (cause) {
        const failures = [];
        const startedRoles = new Set(started.map(service => service.role));
        await bootoutRoles(runtime, bundle.root, bundle.roles.filter(role => startedRoles.has(role)), servicePolicy,
          error => failures.push(error));
        if (failures.length) throw Object.assign(new Error("services_batch_uncertain", { cause }),
          { code: "services_batch_uncertain", failures: failures.length });
        for (const entry of [...createdFiles].reverse()) await removeCreatedFile(runtime, entry).catch(error => {
          if (error?.code !== "ENOENT") failures.push(error);
        });
        for (const path of [...createdDirectories].reverse()) await runtime.rmdir(path).catch(error => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) failures.push(error);
        });
        if (failures.length) throw Object.assign(new Error("services_batch_uncertain", { cause }),
          { code: "services_batch_uncertain", failures: failures.length });
        throw Object.assign(new Error("services_batch_rolled_back", { cause }), { code: "services_batch_rolled_back" });
      }
    }),

    uninstall: (input, signal) => exclusive(async () => {
      const servicePolicy = validateServicePolicyV1(input?.servicePolicy);
      const receipt = verifyServiceReceiptV1(input?.receipt ?? input?.fromJournal, input?.root, servicePolicy);
      if (!(signal instanceof AbortSignal) || signal.aborted) refuse("services_batch_uncertain");
      await bootoutRoles(runtime, receipt.root, receipt.roles, servicePolicy);
      await removeReceiptResources(runtime, receipt, signal);
      return Object.freeze({ outcome: "removed" });
    }),

    recover: (input, signal) => exclusive(async () => {
      if (!input || typeof input.root !== "string" || !(signal instanceof AbortSignal) || signal.aborted) {
        refuse("services_batch_uncertain");
      }
      const roles = validateServiceRolesV1(input.roles, { batch: true });
      const receiptValue = input.receipt ?? input.fromJournal;
      const servicePolicy = validateServicePolicyV1(input.servicePolicy);
      const receipt = receiptValue === undefined ? undefined : verifyServiceReceiptV1(receiptValue, input.root, servicePolicy);
      if (receipt && receipt.roles.join("\0") !== roles.join("\0")) refuse("services_batch_uncertain");
      await bootoutRoles(runtime, input.root, roles, servicePolicy);
      if (receipt) await removeReceiptResources(runtime, receipt, signal);
      return Object.freeze({ outcome: "recovered", roles, usedReceipt: receipt !== undefined });
    }),

    restart: (root, roles, signal, servicePolicyValue) => exclusive(async () => {
      const requested = validateServiceRolesV1(roles);
      const servicePolicy = validateServicePolicyV1(servicePolicyValue);
      if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
        || !(signal instanceof AbortSignal) || signal.aborted) refuse("services_batch_uncertain");
      for (const role of requested) {
        if (signal.aborted) refuse("services_batch_uncertain");
        const service = servicePolicyForRolesV1([role], servicePolicy)[0];
        await runtime.execute("/bin/launchctl", ["kickstart", "-k", `system/${service.label}`])
          .catch(() => refuse("launchctl_refused"));
      }
      return Object.freeze({ restarted: requested });
    }),
  });
}
