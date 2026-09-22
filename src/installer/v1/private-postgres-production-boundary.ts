import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { dataMethodV1, exactHostDataArrayV1, exactHostDataSnapshotV1,
  isHostProxyV1 } from "../../security/host-value";
import { createPrivatePostgresOwnerAdapterV1, PRIVATE_POSTGRES_OWNER_ADAPTER_V1,
  type PrivatePostgresEvidenceRequestV1, type PrivatePostgresMigrationRequestV1,
  type PrivatePostgresOwnerConfigurationV1, type PrivatePostgresOwnerToolBoundaryV1,
  type PrivatePostgresProvisionRequestV1, type PrivatePostgresReviewedFilesV1 } from "./private-postgres-owner-adapter";
import type { PrivatePostgresOwnerRuntimeV1 } from "./private-postgres-owner-runner";

export const PRIVATE_POSTGRES_PRODUCTION_BOUNDARY_V1 =
  "control-room.private-postgres-production-boundary/v1" as const;
export const PRIVATE_POSTGRES_OWNER_TOOL_HOST_V1 =
  "control-room.private-postgres-owner-tool-host/v1" as const;

const HOST_PATH = "deploy/postgres/private-owner-tool-host.mjs";
const SETUP_PATH = "db/setup/production_migration_ledger.sql";
const DEPENDENCY_MANIFEST_PATH = "deploy/postgres/private-owner-dependency-manifest.json";
const RELEASE_PATHS = Object.freeze([
  "deploy/postgres/provision-database.sql",
  "deploy/postgres/apply-migrations.mjs",
  "deploy/postgres/evidence.mjs",
  "deploy/postgres/migration-ledger.json",
] as const);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const bareDigestPattern = /^[a-f0-9]{64}$/u;
const maximumConfigurationBytes = 64 * 1024;
const maximumExecutableBytes = 512 * 1024 * 1024;
const maximumReleaseFileBytes = 32 * 1024 * 1024;
const maximumChildOutputBytes = 4 * 1024 * 1024;
const forceKillDelayMs = 250;
const reapDelayMs = 2_000;
const PG_DEPENDENCY_VERSIONS = Object.freeze({
  pg: "8.23.0",
  "pg-cloudflare": "1.4.0",
  "pg-connection-string": "2.14.0",
  "pg-int8": "1.0.1",
  "pg-pool": "3.14.0",
  "pg-protocol": "1.16.0",
  "pg-types": "2.2.0",
  pgpass: "1.0.5",
  "postgres-array": "2.0.0",
  "postgres-bytea": "1.0.1",
  "postgres-date": "1.0.7",
  "postgres-interval": "1.2.0",
  split2: "4.2.0",
  xtend: "4.0.2",
} as const);

type BaseRuntime = Pick<PrivatePostgresOwnerRuntimeV1, "signal" | "controlDeadlineMs" | "cleanupDeadlineMs"
  | "verifyExactRelease" | "verifyExactMigrationLedger" | "confirmOwnerAttachedTerminal">;
type Identity = Readonly<{ device: number; inode: number; size: number; mode: number; ownerUid: number;
  modifiedMs: number; changedMs: number }>;

export type PrivatePostgresNativeAclVerificationRequestV1 = Readonly<{
  descriptor: number;
  identity: Identity;
  signal: AbortSignal;
}>;
export type PrivatePostgresNativeAclVerificationResultV1 = Readonly<{
  outcome: "verified";
  device: number;
  inode: number;
  extendedAcl: false;
}>;

export type PrivatePostgresProductionBoundaryConfigurationV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_PRODUCTION_BOUNDARY_V1;
  configurationPath: string;
  configurationSha256: string;
  expectedOwnerUid: number;
  releaseRoot: string;
  psqlPath: string;
  psqlSha256: string;
  postgresMajorVersion: 17;
  nodePath: string;
  nodeSha256: string;
  ownerToolHostSha256: string;
  setupSqlSha256: string;
  reviewedFiles: PrivatePostgresReviewedFilesV1;
  baseRuntime: BaseRuntime;
}>;

type LaunchOptions = Readonly<{
  shell: false;
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdio: readonly ["pipe", "pipe", "pipe"];
  windowsHide: true;
}>;
export type LaunchPrivatePostgresOwnerProcessV1 = (executable: string, args: readonly string[],
  options: LaunchOptions) => ChildProcessWithoutNullStreams;
export type PrivatePostgresProductionBoundaryPortsV1 = Readonly<{
  launch: LaunchPrivatePostgresOwnerProcessV1;
  verifyNoExtendedAcl: (request: PrivatePostgresNativeAclVerificationRequestV1) =>
    Promise<PrivatePostgresNativeAclVerificationResultV1>;
}>;

type Parsed = Readonly<{
  configurationPath: string;
  configurationSha256: string;
  expectedOwnerUid: number;
  releaseRoot: string;
  psqlPath: string;
  psqlSha256: string;
  nodePath: string;
  nodeSha256: string;
  ownerToolHostSha256: string;
  setupSqlSha256: string;
  reviewedFiles: PrivatePostgresReviewedFilesV1;
  baseRuntime: BaseRuntime;
}>;
type CapturedPorts = Readonly<{
  launch: LaunchPrivatePostgresOwnerProcessV1;
  verifyNoExtendedAcl?: PrivatePostgresProductionBoundaryPortsV1["verifyNoExtendedAcl"];
}>;
type Running = { child?: ChildProcessWithoutNullStreams; closed: Promise<boolean>; cancel(): void };

function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_postgres_production_boundary_${kind}`);
  error.stack = undefined;
  return error;
}
const refuse = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };
function adapterRefusal(): Error {
  const error = new Error("private_postgres_owner_adapter_refused");
  error.stack = undefined;
  return error;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/"
    || value.endsWith("/") || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > 4096
    || Buffer.from(value, "utf8").toString("utf8") !== value) return refuse();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refuse();
  return value;
}
function identity(value: { dev: number; ino: number; size: number; mode: number; uid: number;
  mtimeMs: number; ctimeMs: number }): Identity {
  return Object.freeze({ device: value.dev, inode: value.ino, size: value.size, mode: value.mode, ownerUid: value.uid,
    modifiedMs: value.mtimeMs, changedMs: value.ctimeMs });
}
function same(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size
    && left.mode === right.mode && left.ownerUid === right.ownerUid && left.modifiedMs === right.modifiedMs
    && left.changedMs === right.changedMs;
}
function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function reviewedFiles(value: unknown): PrivatePostgresReviewedFilesV1 {
  const input = exactHostDataSnapshotV1(value, ["schema", "releaseDigest", "files"]);
  const files = exactHostDataSnapshotV1(input?.files, ["provision", "migrations", "evidence", "ledger"]);
  if (!input || !files || input.schema !== "control-room.private-postgres-reviewed-files/v1") return refuse();
  const names = ["provision", "migrations", "evidence", "ledger"] as const;
  const captured = Object.fromEntries(names.map((name, index) => {
    const file = exactHostDataSnapshotV1(files[name], ["path", "sha256"]);
    if (!file || file.path !== RELEASE_PATHS[index] || typeof file.sha256 !== "string"
      || !bareDigestPattern.test(file.sha256)) return refuse();
    return [name, Object.freeze({ path: file.path, sha256: file.sha256 })];
  })) as PrivatePostgresReviewedFilesV1["files"];
  return Object.freeze({ schema: "control-room.private-postgres-reviewed-files/v1",
    releaseDigest: digest(input.releaseDigest), files: Object.freeze(captured) });
}

function captureConfiguration(value: unknown): Parsed {
  const input = exactHostDataSnapshotV1(value, ["schema", "configurationPath", "configurationSha256",
    "expectedOwnerUid", "releaseRoot", "psqlPath", "psqlSha256", "postgresMajorVersion", "nodePath",
    "nodeSha256", "ownerToolHostSha256", "setupSqlSha256", "reviewedFiles", "baseRuntime"]);
  const base = exactHostDataSnapshotV1(input?.baseRuntime, ["signal", "controlDeadlineMs", "cleanupDeadlineMs",
    "verifyExactRelease", "verifyExactMigrationLedger", "confirmOwnerAttachedTerminal"]);
  if (!input || !base || input.schema !== PRIVATE_POSTGRES_PRODUCTION_BOUNDARY_V1
    || input.postgresMajorVersion !== 17 || !Number.isSafeInteger(input.expectedOwnerUid)
    || (input.expectedOwnerUid as number) < 0 || (input.expectedOwnerUid as number) > 0x7fffffff
    || typeof process.geteuid !== "function" || process.geteuid() !== input.expectedOwnerUid
    || !Number.isSafeInteger(base.controlDeadlineMs) || (base.controlDeadlineMs as number) < 1
    || !Number.isSafeInteger(base.cleanupDeadlineMs) || (base.cleanupDeadlineMs as number) < 1
    || typeof base.verifyExactRelease !== "function" || isHostProxyV1(base.verifyExactRelease)
    || typeof base.verifyExactMigrationLedger !== "function" || isHostProxyV1(base.verifyExactMigrationLedger)
    || typeof base.confirmOwnerAttachedTerminal !== "function" || isHostProxyV1(base.confirmOwnerAttachedTerminal)) return refuse();
  return Object.freeze({ configurationPath: absolutePath(input.configurationPath),
    configurationSha256: digest(input.configurationSha256), expectedOwnerUid: input.expectedOwnerUid as number,
    releaseRoot: absolutePath(input.releaseRoot), psqlPath: absolutePath(input.psqlPath),
    psqlSha256: digest(input.psqlSha256), nodePath: absolutePath(input.nodePath), nodeSha256: digest(input.nodeSha256),
    ownerToolHostSha256: digest(input.ownerToolHostSha256), setupSqlSha256: digest(input.setupSqlSha256),
    reviewedFiles: reviewedFiles(input.reviewedFiles), baseRuntime: Object.freeze({ signal: base.signal as AbortSignal,
      controlDeadlineMs: base.controlDeadlineMs as number, cleanupDeadlineMs: base.cleanupDeadlineMs as number,
      verifyExactRelease: base.verifyExactRelease as BaseRuntime["verifyExactRelease"],
      verifyExactMigrationLedger: base.verifyExactMigrationLedger as BaseRuntime["verifyExactMigrationLedger"],
      confirmOwnerAttachedTerminal: base.confirmOwnerAttachedTerminal as BaseRuntime["confirmOwnerAttachedTerminal"] }) });
}

function capturePorts(value: unknown): CapturedPorts {
  if (value === undefined) {
    if (process.platform === "darwin") return refuse();
    return Object.freeze({ launch: (executable: string, args: readonly string[], options: LaunchOptions) =>
      spawn(executable, [...args], options as never) });
  }
  const ports = exactHostDataSnapshotV1(value, ["launch", "verifyNoExtendedAcl"]);
  const launch = dataMethodV1(value, "launch"), verify = dataMethodV1(value, "verifyNoExtendedAcl");
  if (!ports || !launch || !verify) return refuse();
  return Object.freeze({
    launch: (executable: string, args: readonly string[], options: LaunchOptions) =>
      Reflect.apply(launch, value, [executable, args, options]) as ChildProcessWithoutNullStreams,
    verifyNoExtendedAcl: (request: PrivatePostgresNativeAclVerificationRequestV1) =>
      Reflect.apply(verify, value, [request]) as Promise<PrivatePostgresNativeAclVerificationResultV1>,
  });
}

function abortRace<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  void work.catch(() => {});
  if (signal.aborted) return Promise.reject(sanitized("refused"));
  return new Promise((resolve, reject) => {
    let done = false;
    const abort = () => { if (!done) { done = true; reject(sanitized("refused")); } };
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { if (!done) { done = true; signal.removeEventListener("abort", abort); resolve(value); } },
      () => { if (!done) { done = true; signal.removeEventListener("abort", abort); reject(sanitized("refused")); } });
  });
}

async function verifyAcl(handle: FileHandle, observed: Identity, ports: CapturedPorts,
  signal: AbortSignal): Promise<void> {
  if (!ports.verifyNoExtendedAcl) {
    if (process.platform === "darwin") return refuse();
    return;
  }
  let raw: unknown;
  try { raw = await abortRace(Promise.resolve(ports.verifyNoExtendedAcl(Object.freeze({ descriptor: handle.fd,
    identity: observed, signal }))), signal); } catch { return refuse(); }
  const result = exactHostDataSnapshotV1(raw, ["outcome", "device", "inode", "extendedAcl"]);
  if (!result || result.outcome !== "verified" || result.device !== observed.device || result.inode !== observed.inode
    || result.extendedAcl !== false) return refuse();
}

async function readAndHash(handle: FileHandle, size: number): Promise<{ bytes: Buffer; digest: string }> {
  const bytes = Buffer.alloc(size), hash = createHash("sha256"); let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(bytes, position, Math.min(64 * 1024, size - position), position);
    if (bytesRead < 1) return refuse();
    hash.update(bytes.subarray(position, position + bytesRead)); position += bytesRead;
  }
  return { bytes, digest: `sha256:${hash.digest("hex")}` };
}

async function captureFileSnapshot(path: string, expectedDigest: string | undefined,
  options: Readonly<{ maximum: number; ownerUid: number; exactMode?: number; executable?: boolean; root?: string }>,
  ports: CapturedPorts, signal: AbortSignal): Promise<Readonly<{ bytes: Buffer; digest: string }>> {
  let handle: FileHandle | undefined, bytes: Buffer | undefined;
  try {
    if (signal.aborted || options.root && !inside(options.root, path) || await realpath(path) !== path) return refuse();
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const beforeStat = await handle.stat(), before = identity(beforeStat);
    if (!beforeStat.isFile() || before.size < 1 || before.size > options.maximum || beforeStat.nlink !== 1
      || options.exactMode !== undefined && before.ownerUid !== options.ownerUid
      || options.exactMode === undefined && ![0, options.ownerUid].includes(before.ownerUid)
      || options.exactMode !== undefined && (before.mode & 0o777) !== options.exactMode
      || options.exactMode === undefined && (before.mode & 0o022) !== 0
      || options.executable === true && (before.mode & 0o111) === 0) return refuse();
    await verifyAcl(handle, before, ports, signal);
    const captured = await readAndHash(handle, before.size); bytes = captured.bytes;
    const after = identity(await handle.stat()), named = identity(await stat(path));
    if ((expectedDigest !== undefined && captured.digest !== expectedDigest) || !same(before, after) || !same(before, named)
      || await realpath(path) !== path || signal.aborted) return refuse();
    const result = Object.freeze({ bytes, digest: captured.digest }); bytes = undefined; return result;
  } catch { return refuse(); }
  finally { bytes?.fill(0); await handle?.close().catch(() => {}); }
}

async function captureFile(path: string, expectedDigest: string,
  options: Readonly<{ maximum: number; ownerUid: number; exactMode?: number; executable?: boolean; root?: string }>,
  ports: CapturedPorts, signal: AbortSignal): Promise<Buffer> {
  return (await captureFileSnapshot(path, expectedDigest, options, ports, signal)).bytes;
}

function reviewedBindings(reviewed: PrivatePostgresReviewedFilesV1) {
  return [reviewed.files.provision, reviewed.files.migrations, reviewed.files.evidence, reviewed.files.ledger] as const;
}

type StagedFile = Readonly<{ path: string; handle: FileHandle; identity: Identity; directory: boolean }>;
class ParentStage {
  readonly root: string;
  readonly #configuration: Parsed;
  readonly #ports: CapturedPorts;
  readonly #signal: AbortSignal;
  readonly #handles: FileHandle[] = [];
  readonly #files: StagedFile[] = [];
  readonly #heldDirectories = new Set<string>();
  #released = false;
  #releaseResult: boolean | undefined;

  private constructor(root: string, configuration: Parsed, ports: CapturedPorts, signal: AbortSignal) {
    this.root = root; this.#configuration = configuration; this.#ports = ports; this.#signal = signal;
  }

  static async create(configuration: Parsed, ports: CapturedPorts, signal: AbortSignal,
    custodyFailed: () => void): Promise<ParentStage> {
    if (signal.aborted) return refuse();
    const root = await mkdtemp(join(configuration.releaseRoot, ".private-postgres-owner-"));
    await chmod(root, 0o700);
    const stage = new ParentStage(root, configuration, ports, signal);
    try { await stage.#holdProtectedAncestry(); await stage.#holdDirectory(root, true); return stage; }
    catch { if (!await stage.release()) custodyFailed(); return refuse(); }
  }

  async #holdProtectedAncestry(): Promise<void> {
    const chain: string[] = [];
    let current = this.#configuration.releaseRoot;
    while (true) {
      chain.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const path of chain.reverse()) await this.#holdDirectory(path, false);
  }

  async #holdDirectory(path: string, privateDirectory: boolean): Promise<void> {
    if (this.#heldDirectories.has(path)) return;
    const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const value = await handle.stat(), captured = identity(value);
      const permissions = captured.mode & 0o7777;
      if (!value.isDirectory() || ![0, this.#configuration.expectedOwnerUid].includes(captured.ownerUid)
        || privateDirectory && (permissions & 0o777) !== 0o700
        || !privateDirectory && (permissions & 0o022) !== 0 && (permissions & 0o1000) === 0
        || path === this.#configuration.releaseRoot && captured.ownerUid !== this.#configuration.expectedOwnerUid
        || path === this.#configuration.releaseRoot && (permissions & 0o022) !== 0
        || await realpath(path) !== path) return refuse();
      await verifyAcl(handle, captured, this.#ports, this.#signal); this.#handles.push(handle);
      this.#files.push(Object.freeze({ path, handle, identity: captured, directory: true })); this.#heldDirectories.add(path);
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }

  async #parents(path: string): Promise<void> {
    const relativePath = relative(this.root, dirname(path));
    if (relativePath === "") return;
    let current = this.root;
    for (const component of relativePath.split(sep)) {
      if (!component || component === "." || component === "..") return refuse();
      current = join(current, component);
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await chmod(current, 0o700); await this.#holdDirectory(current, true);
    }
  }

  async write(relativePath: string, bytes: Buffer, mode: 0o600 | 0o700): Promise<string> {
    if (this.#released || this.#signal.aborted || isAbsolute(relativePath) || normalize(relativePath) !== relativePath
      || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) return refuse();
    const path = join(this.root, relativePath);
    if (!inside(this.root, path)) return refuse();
    await this.#parents(path);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0), mode);
    try {
      await handle.writeFile(bytes); await handle.sync(); await handle.chmod(mode);
      const value = await handle.stat(), captured = identity(value);
      if (!value.isFile() || value.nlink !== 1 || captured.ownerUid !== this.#configuration.expectedOwnerUid
        || (captured.mode & 0o777) !== mode || captured.size !== bytes.length) return refuse();
      await verifyAcl(handle, captured, this.#ports, this.#signal);
      const named = identity(await stat(path));
      if (!same(captured, named) || await realpath(path) !== path) return refuse();
      this.#handles.push(handle); this.#files.push(Object.freeze({ path, handle, identity: captured, directory: false })); return path;
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }

  async current(): Promise<boolean> {
    if (this.#released) return false;
    try {
      for (const file of this.#files) {
        const opened = identity(await file.handle.stat()), named = identity(await stat(file.path));
        const matches = file.directory
          ? (value: Identity) => value.device === file.identity.device && value.inode === file.identity.inode
            && value.mode === file.identity.mode && value.ownerUid === file.identity.ownerUid
          : (value: Identity) => same(file.identity, value);
        if (!matches(opened) || !matches(named)
          || await realpath(file.path) !== file.path) return false;
        await verifyAcl(file.handle, opened, this.#ports, this.#signal);
      }
      return true;
    } catch { return false; }
  }

  async release(): Promise<boolean> {
    if (this.#released) return this.#releaseResult ?? false;
    const safeToDelete = await this.current();
    this.#released = true;
    let okay = safeToDelete;
    for (const handle of this.#handles.reverse()) await handle.close().catch(() => { okay = false; });
    if (safeToDelete) {
      try {
        const named = identity(await stat(this.root)), root = this.#files.find(file => file.path === this.root)?.identity;
        if (!root || named.device !== root.device || named.inode !== root.inode) okay = false;
        else await rm(this.root, { recursive: true, force: false });
      } catch { okay = false; }
    }
    this.#releaseResult = okay;
    return this.#releaseResult;
  }
}

async function stageCaptured(stage: ParentStage, sourcePath: string, destination: string, expectedDigest: string,
  options: Readonly<{ maximum: number; executable?: boolean }>, configuration: Parsed, ports: CapturedPorts,
  signal: AbortSignal, mode: 0o600 | 0o700): Promise<{ path: string; bytes?: Buffer }> {
  const bytes = await captureFile(sourcePath, expectedDigest, { maximum: options.maximum,
    ownerUid: configuration.expectedOwnerUid, executable: options.executable,
    root: sourcePath.startsWith(`${configuration.releaseRoot}${sep}`) ? configuration.releaseRoot : undefined }, ports, signal);
  try { return { path: await stage.write(destination, bytes, mode), bytes }; }
  catch (error) { bytes.fill(0); throw error; }
}

type LedgerEntry = Readonly<{ file: string; order: number; sha256: string; kind: "migrate" | "grants" | "provision" }>;
function parseLedger(bytes: Buffer): readonly LedgerEntry[] {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const ledger = exactHostDataSnapshotV1(value, ["version", "digest", "entries"]);
    const entries = exactHostDataArrayV1(ledger?.entries, 10_000);
    if (!ledger || ledger.version !== 1 || typeof ledger.digest !== "string" || !bareDigestPattern.test(ledger.digest)
      || !entries || entries.length < 4) return refuse();
    return Object.freeze(entries.map((raw, index) => {
      const entry = exactHostDataSnapshotV1(raw, ["file", "order", "sha256", "kind"]);
      if (!entry || entry.order !== index + 1 || typeof entry.file !== "string" || isAbsolute(entry.file)
        || normalize(entry.file) !== entry.file || entry.file.startsWith("..") || entry.file.includes(`..${sep}`)
        || typeof entry.sha256 !== "string" || !bareDigestPattern.test(entry.sha256)
        || !["migrate", "grants", "provision"].includes(entry.kind as string)) return refuse();
      return Object.freeze(entry) as LedgerEntry;
    }));
  } catch { return refuse(); }
}

type DependencyManifestEntry = Readonly<{ path: string; sha256: string }>;
function dependencyPackageRoot(entryPath: string, packageName: string, releaseRoot: string): string {
  const suffix = `${sep}node_modules${sep}${packageName.split("/").join(sep)}`;
  let current = dirname(entryPath);
  while (inside(releaseRoot, current)) {
    if (current.endsWith(suffix)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return refuse();
}

async function stageNodeDependencyClosure(stage: ParentStage, configuration: Parsed, ports: CapturedPorts,
  signal: AbortSignal): Promise<string> {
  const pending: { name: string; root: string }[] = [{ name: "pg",
    root: await realpath(join(configuration.releaseRoot, "node_modules/pg")) }];
  const scheduledNames = new Set<string>(["pg"]), seenNames = new Set<string>(), seenRoots = new Set<string>();
  const files: DependencyManifestEntry[] = [], packages: { name: string; version: string }[] = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const next = pending.shift()!;
    if (seenNames.has(next.name) || seenRoots.has(next.root) || !inside(configuration.releaseRoot, next.root)) return refuse();
    seenNames.add(next.name); seenRoots.add(next.root);
    const packageJsonPath = join(next.root, "package.json");
    const packageJson = await captureFileSnapshot(packageJsonPath, undefined,
      { maximum: 1024 * 1024, ownerUid: configuration.expectedOwnerUid, root: configuration.releaseRoot }, ports, signal);
    let metadata: unknown;
    try { metadata = JSON.parse(packageJson.bytes.toString("utf8")); }
    catch { packageJson.bytes.fill(0); return refuse(); }
    const record = exactHostDataSnapshotV1(metadata, metadata && typeof metadata === "object"
      ? Object.getOwnPropertyNames(metadata) : []);
    if (!record || typeof record.name !== "string" || typeof record.version !== "string"
      || record.name !== next.name || record.version !==
      PG_DEPENDENCY_VERSIONS[next.name as keyof typeof PG_DEPENDENCY_VERSIONS]) {
      packageJson.bytes.fill(0); return refuse();
    }
    packages.push(Object.freeze({ name: next.name, version: record.version }));
    packageJson.bytes.fill(0);

    const discovered: string[] = [];
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        if (entry.name === "node_modules" || /[\u0000-\u001f\u007f]/u.test(entry.name)) continue;
        const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
        const sourcePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (await realpath(sourcePath) !== sourcePath) return refuse();
          await walk(sourcePath, relativePath);
        } else if (entry.isFile()) {
          const captured = await captureFileSnapshot(sourcePath, undefined,
            { maximum: maximumReleaseFileBytes, ownerUid: configuration.expectedOwnerUid,
              root: configuration.releaseRoot }, ports, signal);
          totalBytes += captured.bytes.length;
          if (files.length >= 10_000 || totalBytes > 128 * 1024 * 1024) { captured.bytes.fill(0); return refuse(); }
          const destination = `node_modules/${next.name}/${relativePath.split(sep).join("/")}`;
          try { await stage.write(destination, captured.bytes, 0o600); }
          finally { captured.bytes.fill(0); }
          files.push(Object.freeze({ path: destination, sha256: captured.digest.slice("sha256:".length) }));
        } else return refuse();
      }
    };
    await walk(next.root, "");
    const dependencyObjects = [record.dependencies, record.optionalDependencies];
    for (const dependencyObject of dependencyObjects) {
      if (dependencyObject === undefined) continue;
      const dependencies = exactHostDataSnapshotV1(dependencyObject, Object.getOwnPropertyNames(dependencyObject));
      if (!dependencies) return refuse();
      for (const name of Object.keys(dependencies).sort()) {
        if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name) || typeof dependencies[name] !== "string"
          || !Object.prototype.hasOwnProperty.call(PG_DEPENDENCY_VERSIONS, name)) return refuse();
        if (!scheduledNames.has(name)) { scheduledNames.add(name); discovered.push(name); }
      }
    }
    const requireFromPackage = createRequire(packageJsonPath);
    for (const name of discovered) {
      let entryPath: string;
      try { entryPath = await realpath(requireFromPackage.resolve(name)); } catch { return refuse(); }
      pending.push({ name, root: dependencyPackageRoot(entryPath, name, configuration.releaseRoot) });
    }
  }
  if (seenNames.size !== Object.keys(PG_DEPENDENCY_VERSIONS).length) return refuse();
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  packages.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const manifest = Buffer.from(`${JSON.stringify({ schema: "control-room.private-postgres-dependency-manifest/v1",
    packages, files })}\n`, "utf8");
  try {
    const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    await stage.write(DEPENDENCY_MANIFEST_PATH, manifest, 0o600);
    return manifestDigest;
  } finally { manifest.fill(0); }
}

async function prepareStage(configuration: Parsed, ports: CapturedPorts, signal: AbortSignal,
  operation: "provision_database" | "apply_migrations" | "collect_evidence",
  custodyFailed: () => void): Promise<Readonly<{
    stage: ParentStage; executable: string; provisionSql?: string; dependencyManifestSha256?: string;
  }>> {
  const stage = await ParentStage.create(configuration, ports, signal, custodyFailed);
  const coreBytes = new Map<string, Buffer>();
  try {
    for (const binding of reviewedBindings(configuration.reviewedFiles)) {
      const captured = await stageCaptured(stage, join(configuration.releaseRoot, binding.path), binding.path,
        `sha256:${binding.sha256}`, { maximum: maximumReleaseFileBytes }, configuration, ports, signal, 0o600);
      coreBytes.set(binding.path, captured.bytes!);
    }
    const host = await stageCaptured(stage, join(configuration.releaseRoot, HOST_PATH), HOST_PATH,
      configuration.ownerToolHostSha256, { maximum: maximumReleaseFileBytes }, configuration, ports, signal, 0o600);
    host.bytes?.fill(0);
    let executable: string, dependencyManifestSha256: string | undefined;
    if (operation === "provision_database") {
      const staged = await stageCaptured(stage, configuration.psqlPath, "bin/psql", configuration.psqlSha256,
        { maximum: maximumExecutableBytes, executable: true }, configuration, ports, signal, 0o700);
      staged.bytes?.fill(0); executable = staged.path;
    } else {
      const staged = await stageCaptured(stage, configuration.nodePath, "bin/node", configuration.nodeSha256,
        { maximum: maximumExecutableBytes, executable: true }, configuration, ports, signal, 0o700);
      staged.bytes?.fill(0); executable = staged.path;
      dependencyManifestSha256 = await stageNodeDependencyClosure(stage, configuration, ports, signal);
      if (operation === "apply_migrations") {
        const ledgerBytes = coreBytes.get(RELEASE_PATHS[3]);
        if (!ledgerBytes) return refuse();
        const entries = parseLedger(ledgerBytes);
        for (const entry of entries) {
          const captured = await stageCaptured(stage, join(configuration.releaseRoot, entry.file), entry.file,
            `sha256:${entry.sha256}`, { maximum: maximumReleaseFileBytes }, configuration, ports, signal, 0o600);
          captured.bytes?.fill(0);
        }
        const setup = await stageCaptured(stage, join(configuration.releaseRoot, SETUP_PATH), SETUP_PATH,
          configuration.setupSqlSha256, { maximum: maximumReleaseFileBytes }, configuration, ports, signal, 0o600);
        setup.bytes?.fill(0);
      }
    }
    if (!await stage.current()) return refuse();
    return Object.freeze({ stage, executable,
      provisionSql: operation === "provision_database" ? join(stage.root, RELEASE_PATHS[0]) : undefined,
      dependencyManifestSha256 });
  } catch (error) { if (!await stage.release()) custodyFailed(); throw error; }
  finally { for (const bytes of coreBytes.values()) bytes.fill(0); }
}

function framed(value: unknown): Buffer {
  let payload: Buffer | undefined;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > 256 * 1024) return refuse();
    const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
    return Buffer.concat([header, payload]);
  } catch { return refuse(); }
  finally { payload?.fill(0); }
}

function requestFilesMatch(files: unknown, reviewed: PrivatePostgresReviewedFilesV1): boolean {
  const list = exactHostDataArrayV1(files, RELEASE_PATHS.length);
  if (!list || list.length !== RELEASE_PATHS.length) return false;
  return list.every((value, index) => {
    const item = exactHostDataSnapshotV1(value, ["path", "sha256"]), expected = reviewedBindings(reviewed)[index];
    return Boolean(item && expected && item.path === expected.path && item.sha256 === expected.sha256);
  });
}
function validateShared(request: { schema: unknown; releaseDigest: unknown; files: unknown }, configuration: Parsed) {
  if (request.schema !== PRIVATE_POSTGRES_OWNER_ADAPTER_V1
    || request.releaseDigest !== configuration.reviewedFiles.releaseDigest
    || !requestFilesMatch(request.files, configuration.reviewedFiles)) return refuse();
}

function pgOptionsTokens(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length > 1024 || /[\u0000\r\n]/u.test(value)) return refuse();
  const tokens: string[] = []; let token = "", escaped = false;
  for (const character of value) {
    if (escaped) { token += character; escaped = false; }
    else if (character === "\\") escaped = true;
    else if (character === " " || character === "\t") { if (token) { tokens.push(token); token = ""; } }
    else token += character;
  }
  if (escaped) return refuse();
  if (token) tokens.push(token);
  if (JSON.stringify(tokens) !== JSON.stringify(["-c", "search_path=pg_catalog, public", "-c", "timezone=UTC"])) return refuse();
  return Object.freeze(tokens);
}

function validateChild(child: ChildProcessWithoutNullStreams): void {
  if (!child || typeof child !== "object" || isHostProxyV1(child)
    || !dataMethodV1(child, "once") || !dataMethodV1(child, "on") || !dataMethodV1(child, "kill")
    || !dataMethodV1(child.stdin, "end") || !dataMethodV1(child.stdin, "destroy") || !dataMethodV1(child.stdin, "on")
    || !dataMethodV1(child.stdout, "on") || !dataMethodV1(child.stdout, "destroy")
    || !dataMethodV1(child.stderr, "on") || !dataMethodV1(child.stderr, "destroy")) return uncertain();
}

function parseFrames(bytes: Buffer): readonly Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []; let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) return uncertain();
    const length = bytes.readUInt32BE(offset); offset += 4;
    if (length < 2 || length > maximumChildOutputBytes || offset + length > bytes.length) return uncertain();
    const payload = bytes.subarray(offset, offset + length), text = payload.toString("utf8"); offset += length;
    if (!Buffer.from(text, "utf8").equals(payload) || text.includes("\0")) return uncertain();
    let value: unknown; try { value = JSON.parse(text); } catch { return uncertain(); }
    const frame = exactHostDataSnapshotV1(value, ["protocol", "type"], ["operation", "result"]);
    if (!frame || frame.protocol !== PRIVATE_POSTGRES_OWNER_TOOL_HOST_V1) return uncertain();
    frames.push(frame);
  }
  return Object.freeze(frames);
}

type ChildResult = Readonly<{ spawned: false }> | Readonly<{ spawned: true; code: number | null;
  stoppedBySignal: NodeJS.Signals | null; stdout: Buffer; stderrBytes: number }>;

async function childCall(ports: CapturedPorts, executable: string, args: readonly string[], options: LaunchOptions,
  input: Buffer | undefined, signal: AbortSignal, deadlineMs: number, running: Set<Running>, stage: ParentStage,
  custodyFailed: () => void): Promise<ChildResult> {
  if (signal.aborted || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !await stage.current()) {
    if (!await stage.release()) custodyFailed();
    return Promise.reject(sanitized("refused"));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = ports.launch(executable, args, options); }
    catch { void stage.release().then(okay => {
      if (!okay) { custodyFailed(); reject(sanitized("uncertain")); }
      else resolve(Object.freeze({ spawned: false as const }));
    }); return; }
    let resolveClosed!: (value: boolean) => void;
    const closed = new Promise<boolean>(resolveValue => { resolveClosed = resolveValue; });
    let runningEntry: Running;
    try { validateChild(child); }
    catch {
      const never = new Promise<boolean>(() => {});
      runningEntry = { child, closed: never, cancel() { try { child.kill("SIGKILL"); } catch { /* retained */ } } };
      running.add(runningEntry); runningEntry.cancel(); reject(sanitized("uncertain")); return;
    }
    let responseFinished = false, closeSeen = false, spawned = false, preSpawnError = false, internalFailure = false;
    let stdoutBytes = 0, stderrBytes = 0, forceTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined, deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const wipeChunks = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const respond = (result?: ChildResult) => {
      if (responseFinished) return;
      responseFinished = true;
      if (!result) reject(sanitized("uncertain")); else resolve(Object.freeze(result));
    };
    const cancel = () => {
      if (closeSeen) return;
      internalFailure = true;
      try { child.stdin.destroy(); } catch { /* close is authoritative */ }
      try { child.kill("SIGTERM"); } catch { /* force timer remains */ }
      if (!forceTimer) forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* retained */ } }, forceKillDelayMs);
      if (!reapTimer) reapTimer = setTimeout(() => respond(), reapDelayMs);
    };
    runningEntry = { child, closed, cancel }; running.add(runningEntry);
    const pipeFailure = () => cancel();
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => { if (!spawned) preSpawnError = true; else cancel(); });
    child.stdin.on("error", pipeFailure); child.stdout.on("error", pipeFailure); child.stderr.on("error", pipeFailure);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumChildOutputBytes) cancel(); else if (!internalFailure) chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) cancel(); });
    child.once("close", (code, stoppedBySignal) => {
      closeSeen = true; clearTimeout(deadlineTimer); clearTimeout(forceTimer); clearTimeout(reapTimer);
      signal.removeEventListener("abort", cancel);
      try { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } catch { internalFailure = true; }
      void (async () => {
        const current = await stage.current(), released = await stage.release();
        if (!current || !released) custodyFailed();
        running.delete(runningEntry); resolveClosed(current && released);
        if (!current || !released || internalFailure) { wipeChunks(); respond(); return; }
        if (preSpawnError && !spawned) { wipeChunks(); respond({ spawned: false }); return; }
        if (!spawned) { wipeChunks(); respond(); return; }
        respond({ spawned: true, code, stoppedBySignal, stdout: Buffer.concat(chunks), stderrBytes });
        wipeChunks();
      })();
    });
    deadlineTimer = setTimeout(cancel, deadlineMs);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else {
      try { child.stdin.end(input); } catch { cancel(); }
    }
  });
}

function buildTools(configuration: Parsed, ports: CapturedPorts): PrivatePostgresOwnerToolBoundaryV1 {
  const lifetime = new AbortController(), running = new Set<Running>(); let closed = false, custodyFailure = false;
  const custodyFailed = () => { custodyFailure = true; };
  const operationSignal = (signal: AbortSignal) => {
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true }); lifetime.signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || lifetime.signal.aborted) controller.abort();
    return { signal: controller.signal, release() { signal.removeEventListener("abort", abort);
      lifetime.signal.removeEventListener("abort", abort); } };
  };
  const childDeadline = Math.min(configuration.baseRuntime.controlDeadlineMs, 120_000);
  const nodeOperation = async (request: PrivatePostgresMigrationRequestV1 | PrivatePostgresEvidenceRequestV1,
    signal: AbortSignal) => {
    validateShared(request, configuration);
    if (closed || request.operation === "apply_migrations" && (request.module !== RELEASE_PATHS[1]
      || request.exportName !== "applyMigrations" || request.environmentMode !== "replace")
      || request.operation === "collect_evidence" && (request.module !== RELEASE_PATHS[2]
        || request.exportName !== "collectDatabaseEvidence" || request.environmentMode !== "replace")) return refuse();
    const linked = operationSignal(signal); let stage: ParentStage | undefined, input: Buffer | undefined;
    try {
      const prepared = await prepareStage(configuration, ports, linked.signal, request.operation, custodyFailed);
      stage = prepared.stage; input = framed({ protocol: PRIVATE_POSTGRES_OWNER_TOOL_HOST_V1, request });
      const childStage = stage; stage = undefined;
      const result = await childCall(ports, prepared.executable, Object.freeze([
        join(childStage.root, HOST_PATH), "--dependency-manifest-sha256", prepared.dependencyManifestSha256!]),
        Object.freeze({ shell: false as const, cwd: childStage.root,
          env: Object.freeze({ NODE_ENV: "production", LANG: "C", LC_ALL: "C" }),
          stdio: Object.freeze(["pipe", "pipe", "pipe"] as const), windowsHide: true as const }),
        input, linked.signal, childDeadline, running, childStage, custodyFailed);
      if (!result.spawned) return Object.freeze({ beforeEntry: true as const });
      let frames: readonly Record<string, unknown>[];
      try { frames = parseFrames(result.stdout); } finally { result.stdout.fill(0); }
      if (frames.length === 1 && frames[0]?.type === "refused_before_entry" && result.code === 2
        && result.stoppedBySignal === null && result.stderrBytes === 0) return Object.freeze({ beforeEntry: true as const });
      if (frames.length !== 2 || frames[0]?.type !== "entered" || frames[0]?.operation !== request.operation
        || frames[1]?.type !== "result" || frames[1]?.operation !== request.operation || result.code !== 0
        || result.stoppedBySignal !== null || result.stderrBytes !== 0 || linked.signal.aborted
        || !Object.prototype.hasOwnProperty.call(frames[1], "result")) return uncertain();
      return Object.freeze({ beforeEntry: false as const, result: frames[1].result });
    } catch (error) {
      if (stage && !await stage.release()) custodyFailed();
      if (error instanceof Error && error.message === "private_postgres_production_boundary_refused") {
        return Object.freeze({ beforeEntry: true as const });
      }
      return uncertain();
    } finally { input?.fill(0); linked.release(); }
  };
  return Object.freeze({
    async provisionDatabase(request: PrivatePostgresProvisionRequestV1, signal: AbortSignal) {
      const linked = operationSignal(signal); let stage: ParentStage | undefined;
      try {
        validateShared(request, configuration);
        if (closed || request.operation !== "provision_database" || request.executable !== "psql"
          || request.environmentMode !== "replace" || request.args[4] !== "-f" || request.args[5] !== RELEASE_PATHS[0]) return refuse();
        pgOptionsTokens(request.env.PGOPTIONS);
        const prepared = await prepareStage(configuration, ports, linked.signal, "provision_database", custodyFailed);
        stage = prepared.stage;
        const args = Object.freeze(["-X", ...request.args.slice(0, 5),
          prepared.provisionSql!, ...request.args.slice(6)]);
        const childStage = stage; stage = undefined;
        const result = await childCall(ports, prepared.executable, args,
          Object.freeze({ shell: false as const, cwd: childStage.root, env: Object.freeze({ ...request.env }),
            stdio: Object.freeze(["pipe", "pipe", "pipe"] as const), windowsHide: true as const }),
          undefined, linked.signal, childDeadline, running, childStage, custodyFailed);
        if (!result.spawned) return Object.freeze({ outcome: "failed_before_effect" as const });
        result.stdout.fill(0);
        if (result.code !== 0 || result.stoppedBySignal !== null || linked.signal.aborted) return uncertain();
        return Object.freeze({ outcome: "succeeded" as const, exitCode: 0 as const });
      } catch (error) {
        if (stage && !await stage.release()) custodyFailed();
        if (error instanceof Error && error.message === "private_postgres_production_boundary_refused") {
          return Object.freeze({ outcome: "failed_before_effect" as const });
        }
        return uncertain();
      } finally { linked.release(); }
    },
    async applyMigrations(request: PrivatePostgresMigrationRequestV1, signal: AbortSignal) {
      const result = await nodeOperation(request, signal);
      return result.beforeEntry ? Object.freeze({ outcome: "failed_before_effect" as const })
        : Object.freeze({ outcome: "succeeded" as const, result: result.result });
    },
    async collectDatabaseEvidence(request: PrivatePostgresEvidenceRequestV1, signal: AbortSignal) {
      const result = await nodeOperation(request, signal);
      if (result.beforeEntry) return refuse();
      return result.result;
    },
    async cleanup(signal: AbortSignal) {
      if (closed && running.size === 0) {
        if (custodyFailure) return uncertain();
        return;
      }
      closed = true; lifetime.abort();
      for (const process of running) process.cancel();
      const pending = [...running].map(process => process.closed);
      if (pending.length === 0) {
        if (custodyFailure) return uncertain();
        return;
      }
      const end = performance.now() + configuration.baseRuntime.cleanupDeadlineMs;
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer);
          signal.removeEventListener("abort", abort); ok ? resolve() : reject(sanitized("uncertain")); };
        const abort = () => finish(false), timer = setTimeout(abort, Math.max(1, end - performance.now()));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else void Promise.all(pending).then(values => finish(values.every(Boolean)), () => finish(false));
      });
      if (running.size !== 0 || custodyFailure) return uncertain();
    },
  });
}

async function loadPrivateConfiguration(configuration: Parsed, ports: CapturedPorts,
  signal: AbortSignal): Promise<PrivatePostgresOwnerConfigurationV1> {
  const bytes = await captureFile(configuration.configurationPath, configuration.configurationSha256,
    { maximum: maximumConfigurationBytes, ownerUid: configuration.expectedOwnerUid, exactMode: 0o600 }, ports, signal);
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) return refuse();
    const value: unknown = JSON.parse(text);
    const captured = exactHostDataSnapshotV1(value, ["schema", "majorVersion", "host", "port", "database",
      "maintenanceDatabase", "operator", "migratorPassword", "applicationPassword", "schedulerPassword",
      "requiredTables"]);
    const operator = exactHostDataSnapshotV1(captured?.operator, ["username", "password"]);
    const tables = exactHostDataArrayV1(captured?.requiredTables, 64);
    if (!captured || !operator || !tables) return refuse();
    return Object.freeze({ ...captured, operator: Object.freeze(operator), requiredTables: Object.freeze(tables) }) as
      PrivatePostgresOwnerConfigurationV1;
  } catch { return refuse(); }
  finally { bytes.fill(0); }
}

/**
 * Source-only production composition for the accepted PostgreSQL owner adapter.
 * Construction is inert. Each operation captures reviewed source bytes through
 * no-follow descriptors, verifies a native no-ACL receipt on macOS, stages one
 * private identity-bound set under the release root, and retains every staged
 * handle until its one child is confirmed closed.
 */
export function createPrivatePostgresProductionBoundaryV1(value: unknown,
  portsValue?: PrivatePostgresProductionBoundaryPortsV1): PrivatePostgresOwnerRuntimeV1 {
  const configuration = captureConfiguration(value), ports = capturePorts(portsValue);
  let closed = false, active = 0;
  const custody = Object.freeze({
    async withConfiguration<T>(signal: AbortSignal, use: (configuration: unknown) => Promise<T>): Promise<T> {
      if (closed || signal.aborted || typeof use !== "function" || isHostProxyV1(use)) return refuse();
      active += 1;
      try {
        let privateConfiguration: PrivatePostgresOwnerConfigurationV1;
        try { privateConfiguration = await loadPrivateConfiguration(configuration, ports, signal); }
        catch { throw adapterRefusal(); }
        if (closed || signal.aborted) return uncertain();
        return await use(privateConfiguration);
      } finally { active -= 1; }
    },
    async close(signal: AbortSignal) {
      closed = true;
      if (signal.aborted || active !== 0) return uncertain();
    },
  });
  return createPrivatePostgresOwnerAdapterV1({ custody, tools: buildTools(configuration, ports),
    reviewedFiles: configuration.reviewedFiles, baseRuntime: configuration.baseRuntime });
}
