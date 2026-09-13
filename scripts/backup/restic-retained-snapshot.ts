import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { artifactBackupInventorySchemaV1,
  verifyRestoredArtifactBackupInventoryV1 } from "../../src/artifacts/v1/artifact-backup-inventory";
import { parseRollbackCheckpointV1, rollbackCheckpointDigestV1, type RollbackCheckpointV1 } from "../../src/security/rollback-checkpoint";
import { hmacSha256Tag, sha256Digest } from "../../src/security";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const MAX_DUMP_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RESTIC_VERSION = "0.19.1";

/** #63 supplies this result. This package deliberately does not define how PostgreSQL is
 * dumped, restored, owned, migrated, or verified. */
export const verifiedDatabaseDumpBindingSchemaV1 = z.object({
  tenantId: id, releaseId: id, identityDigest: digest, dumpDigest: digest,
  dumpSizeBytes: z.number().int().positive().max(MAX_DUMP_BYTES),
  databaseSchemaVersion: id, databaseSchemaDigest: digest,
  artifactInventoryDigest: digest, checkpointDigest: digest,
}).strict();
export type VerifiedDatabaseDumpBindingV1 = z.infer<typeof verifiedDatabaseDumpBindingSchemaV1>;

export interface VerifiedDatabaseDumpPortV1 {
  verifyBackupInput(input: { identity: unknown; dumpPath: string; signal: AbortSignal }): Promise<VerifiedDatabaseDumpBindingV1>;
  verifyRestoredDump(input: { identity: unknown; dumpPath: string; expected: VerifiedDatabaseDumpBindingV1;
    signal: AbortSignal }): Promise<{ identityDigest: string; dumpDigest: string }>;
}

const configSchema = z.object({ resticExecutable: z.string().min(1).max(4096), repositoryFile: z.string().min(1).max(4096),
  passwordFile: z.string().min(1).max(4096), bindingKeyFile: z.string().min(1).max(4096),
  stateRoot: z.string().min(1).max(4096), timeoutMs: z.number().int().min(50).max(300_000).default(30_000),
  outputLimitBytes: z.number().int().min(1024).max(MAX_OUTPUT_BYTES).default(64 * 1024) }).strict();
export type ResticRetainedSnapshotConfigurationV1 = z.input<typeof configSchema>;

const snapshotSchema = z.object({ id: z.string().regex(/^[a-f0-9]{8,64}$/), tags: z.array(z.string()).default([]) }).passthrough();
const journalSchema = z.object({ schema: z.literal("control-room.retained-backup-journal/v1"), bindingDigest: digest,
  state: z.enum(["pending", "uncertain", "committed"]), snapshotId: z.string().regex(/^[a-f0-9]{8,64}$/).optional(),
  updatedAt: instant }).strict();
const manifestMaterial = z.object({ schema: z.literal("control-room.retained-backup-manifest/v1"),
  tenantId: id, releaseId: id, databaseIdentityDigest: digest, databaseDumpDigest: digest,
  databaseDumpSizeBytes: z.number().int().positive().max(MAX_DUMP_BYTES), databaseSchemaVersion: id,
  databaseSchemaDigest: digest, artifactInventoryDigest: digest, checkpointDigest: digest,
  artifactFiles: z.array(z.object({ artifactId: id, fileName: z.string().regex(/^[A-Za-z0-9_-]+\.bin$/),
    contentHash: digest, sizeBytes: z.number().int().nonnegative().max(65_536) }).strict()).max(10_000),
  createdAt: instant }).strict();
const manifestSchema = manifestMaterial.extend({ manifestDigest: digest }).strict();
type Manifest = z.infer<typeof manifestSchema>;
const bindingMaterial = z.object({ schema: z.literal("control-room.retained-snapshot-binding/v1"),
  bindingDigest: digest, snapshotId: z.string().regex(/^[a-f0-9]{8,64}$/), repositorySelectionDigest: digest,
  manifestDigest: digest, databaseIdentityDigest: digest, databaseDumpDigest: digest,
  databaseDumpSizeBytes: z.number().int().positive().max(MAX_DUMP_BYTES), databaseSchemaVersion: id,
  databaseSchemaDigest: digest, artifactInventoryDigest: digest, artifactInventory: artifactBackupInventorySchemaV1,
  checkpointDigest: digest, recordedAt: instant }).strict();
const bindingSchema = bindingMaterial.extend({ authTag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/) }).strict();
export type RetainedSnapshotBindingV1 = z.infer<typeof bindingSchema>;

type ArtifactFile = { artifactId: string; path: string };
export type RetainedBackupInputV1 = { databaseIdentity: unknown; databaseDumpPath: string; artifactInventoryPath: string;
  artifactFiles: readonly ArtifactFile[]; checkpointPath: string; signal: AbortSignal; now?: () => number };
export type RetainedRestoreInputV1 = { bindingDigest: string; databaseIdentity: unknown; targetPath: string;
  signal: AbortSignal; now?: () => number };

function unavailable(cause?: unknown): never { throw new Error("retained_backup_unavailable", { cause }); }
function uncertain(cause?: unknown): never { throw new Error("retained_backup_snapshot_uncertain", { cause }); }
function assertSignal(signal: AbortSignal) { if (!(signal instanceof AbortSignal) || signal.aborted) unavailable(); }
const hex = (value: string) => value.replace("sha256:", "");
const bytesDigest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function privateRegularFile(path: string, executable = false) {
  if (!isAbsolute(path)) unavailable();
  const entry = await lstat(path).catch(unavailable);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || (executable ? (entry.mode & 0o022) !== 0 : (entry.mode & 0o077) !== 0)) unavailable();
  if (executable && (entry.mode & 0o100) === 0) unavailable();
  const canonical = await realpath(path).catch(unavailable);
  if (canonical !== path) unavailable();
  if (executable) await access(path, constants.X_OK).catch(unavailable);
  return entry;
}

async function privateDirectory(path: string) {
  if (!isAbsolute(path)) unavailable();
  const entry = await lstat(path).catch(unavailable);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0
    || await realpath(path).catch(unavailable) !== path) unavailable();
}

async function readBounded(path: string, maximum: number) {
  const entry = await privateRegularFile(path);
  if (entry.size > maximum) unavailable();
  return new Uint8Array(await readFile(path));
}

async function hashFile(path: string, maximum: number, signal: AbortSignal) {
  assertSignal(signal);
  const entry = await privateRegularFile(path);
  if (entry.size > maximum) unavailable();
  const hash = createHash("sha256");
  const stream = createReadStream(path, { signal });
  try { for await (const chunk of stream) hash.update(chunk); }
  catch (error) { return unavailable(error); }
  assertSignal(signal);
  return { digest: `sha256:${hash.digest("hex")}`, size: entry.size };
}

function childEnvironment() {
  return Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: "/nonexistent",
    NODE_ENV: "production" }) satisfies NodeJS.ProcessEnv;
}

async function run(executable: string, args: readonly string[], signal: AbortSignal, timeoutMs: number,
  outputLimit: number, cwd?: string) {
  assertSignal(signal);
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] as const,
      env: childEnvironment(), cwd });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), settled = false, overflow = false;
    const collect = (which: "stdout" | "stderr") => (chunk: Buffer) => {
      const next = Buffer.concat([which === "stdout" ? stdout : stderr, chunk]);
      if (next.byteLength > outputLimit) { overflow = true; child.kill("SIGKILL"); }
      else if (which === "stdout") stdout = next; else stderr = next;
    };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    const cancel = () => child.kill("SIGKILL"); signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", error => finish(error));
    child.once("close", (code, childSignal) => finish(code === 0 && !overflow && !signal.aborted
      ? undefined : new Error(`restic_process_failed:${code ?? childSignal ?? "unknown"}`)));
    function finish(error?: Error) {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolvePromise({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    }
  });
}

async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.new`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const handle = await open(temp, "r"); try { await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  const parent = await open(dirname(path), "r"); try { await parent.sync(); } finally { await parent.close(); }
}

async function replaceJson(path: string, value: unknown) {
  const temp = `${path}.replace`;
  await rm(temp, { force: true });
  await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const handle = await open(temp, "r"); try { await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
  const parent = await open(dirname(path), "r"); try { await parent.sync(); } finally { await parent.close(); }
}

export class ResticRetainedSnapshotRunnerV1 {
  private readonly config: z.output<typeof configSchema>;
  constructor(configuration: ResticRetainedSnapshotConfigurationV1, private readonly database: VerifiedDatabaseDumpPortV1) {
    this.config = configSchema.parse(configuration);
    if (typeof database?.verifyBackupInput !== "function" || typeof database?.verifyRestoredDump !== "function") unavailable();
  }
  private args(command: string, ...args: string[]) {
    return ["--repository-file", this.config.repositoryFile, "--password-file", this.config.passwordFile, command, ...args];
  }
  private async ready(signal: AbortSignal) {
    await privateRegularFile(this.config.resticExecutable, true);
    await privateRegularFile(this.config.repositoryFile); await privateRegularFile(this.config.passwordFile);
    await privateRegularFile(this.config.bindingKeyFile); await privateDirectory(this.config.stateRoot);
    const key = await readBounded(this.config.bindingKeyFile, 32);
    if (key.byteLength !== 32) unavailable();
    const version = await run(this.config.resticExecutable, ["version"], signal, this.config.timeoutMs,
      this.config.outputLimitBytes).catch(unavailable);
    if (!new RegExp(`^restic ${RESTIC_VERSION}(?:\\s|$)`).test(version.stdout.trim())) unavailable();
    const repositorySelectionDigest = bytesDigest(await readBounded(this.config.repositoryFile, 4096));
    return { key, repositorySelectionDigest };
  }
  private async snapshots(tag: string, signal: AbortSignal) {
    try {
      const result = await run(this.config.resticExecutable, this.args("snapshots", "--json", "--tag", tag),
        signal, this.config.timeoutMs, this.config.outputLimitBytes);
      const values = z.array(snapshotSchema).max(2).parse(JSON.parse(result.stdout || "[]"));
      if (values.some(value => !value.tags.includes(tag))) uncertain();
      return values;
    } catch (error) { return uncertain(error); }
  }
  private async readJournal(path: string) {
    try { await lstat(path); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined; return uncertain(error); }
    try { return journalSchema.parse(JSON.parse(Buffer.from(await readBounded(path, 4096)).toString("utf8"))); }
    catch (error: unknown) { return uncertain(error); }
  }
  private bindingPath(bindingDigest: string) { return join(this.config.stateRoot, "bindings", `${hex(bindingDigest)}.json`); }
  private async readBinding(bindingDigest: string, key: Uint8Array) {
    const value = bindingSchema.parse(JSON.parse(Buffer.from(await readBounded(
      this.bindingPath(bindingDigest), 20 * 1024 * 1024)).toString("utf8")));
    const { authTag, ...material } = value;
    if (material.bindingDigest !== bindingDigest || hmacSha256Tag(key, { purpose: "retained-snapshot-binding/v1", material }) !== authTag) unavailable();
    return value;
  }
  async backup(input: RetainedBackupInputV1) {
    assertSignal(input.signal); const now = input.now ?? Date.now; const prepared = await this.ready(input.signal);
    const db = verifiedDatabaseDumpBindingSchemaV1.parse(await this.database.verifyBackupInput({
      identity: input.databaseIdentity, dumpPath: input.databaseDumpPath, signal: input.signal }));
    const dump = await hashFile(input.databaseDumpPath, MAX_DUMP_BYTES, input.signal);
    if (dump.size !== db.dumpSizeBytes || dump.digest !== db.dumpDigest) unavailable();
    const inventory = artifactBackupInventorySchemaV1.parse(JSON.parse(Buffer.from(await readBounded(input.artifactInventoryPath, 16 * 1024 * 1024)).toString("utf8")));
    const checkpoint = parseRollbackCheckpointV1(JSON.parse(Buffer.from(await readBounded(input.checkpointPath, 16 * 1024)).toString("utf8")));
    if (inventory.tenantId !== db.tenantId || inventory.releaseId !== db.releaseId
      || inventory.databaseSchemaVersion !== db.databaseSchemaVersion || inventory.databaseSchemaDigest !== db.databaseSchemaDigest
      || inventory.inventoryDigest !== db.artifactInventoryDigest || rollbackCheckpointDigestV1(checkpoint) !== db.checkpointDigest) unavailable();
    const supplied = new Map(input.artifactFiles.map(value => [id.parse(value.artifactId), value.path]));
    if (supplied.size !== inventory.entryCount || input.artifactFiles.length !== inventory.entryCount) unavailable();
    const artifacts: Manifest["artifactFiles"] = [];
    for (const entry of inventory.entries) {
      const path = supplied.get(entry.artifactId); if (!path) unavailable();
      const file = await privateRegularFile(path); const content = await readBounded(path, 65_536);
      if (file.size !== entry.sizeBytes || bytesDigest(content) !== entry.contentHash) unavailable();
      artifacts.push({ artifactId: entry.artifactId, fileName: `${Buffer.from(entry.artifactId).toString("base64url")}.bin`,
        contentHash: entry.contentHash, sizeBytes: entry.sizeBytes });
    }
    const createdAt = new Date(now()).toISOString();
    const material = manifestMaterial.parse({ schema: "control-room.retained-backup-manifest/v1", tenantId: db.tenantId,
      releaseId: db.releaseId, databaseIdentityDigest: db.identityDigest, databaseDumpDigest: db.dumpDigest,
      databaseDumpSizeBytes: db.dumpSizeBytes, databaseSchemaVersion: db.databaseSchemaVersion,
      databaseSchemaDigest: db.databaseSchemaDigest, artifactInventoryDigest: inventory.inventoryDigest,
      checkpointDigest: db.checkpointDigest, artifactFiles: artifacts, createdAt });
    const manifest = manifestSchema.parse({ ...material, manifestDigest: sha256Digest(material) });
    // This is deliberately independent of snapshot timestamps, so the exact same verified
    // inputs reconcile after a lost acknowledgement instead of creating a second snapshot.
    const bindingDigest = sha256Digest({ repositorySelectionDigest: prepared.repositorySelectionDigest,
      databaseIdentityDigest: db.identityDigest, databaseDumpDigest: db.dumpDigest, databaseDumpSizeBytes: db.dumpSizeBytes,
      databaseSchemaVersion: db.databaseSchemaVersion, databaseSchemaDigest: db.databaseSchemaDigest,
      artifactInventoryDigest: inventory.inventoryDigest,
      checkpointDigest: db.checkpointDigest });
    const tag = `control-room-${hex(bindingDigest)}`, operations = join(this.config.stateRoot, "operations"),
      operation = join(operations, `${hex(bindingDigest)}.json`), bindings = join(this.config.stateRoot, "bindings");
    await mkdir(operations, { recursive: true, mode: 0o700 }); await mkdir(bindings, { recursive: true, mode: 0o700 });
    await privateDirectory(operations); await privateDirectory(bindings);
    const prior = await this.readJournal(operation);
    const existing = await this.snapshots(tag, input.signal);
    if (existing.length === 1) {
      const binding = await this.readBinding(bindingDigest, prepared.key).catch(() => undefined);
      if (!binding || binding.snapshotId !== existing[0]!.id
        || binding.repositorySelectionDigest !== prepared.repositorySelectionDigest
        || binding.databaseIdentityDigest !== db.identityDigest
        || binding.databaseDumpDigest !== db.dumpDigest || binding.databaseDumpSizeBytes !== db.dumpSizeBytes
        || binding.databaseSchemaVersion !== db.databaseSchemaVersion
        || binding.databaseSchemaDigest !== db.databaseSchemaDigest
        || binding.artifactInventoryDigest !== inventory.inventoryDigest
        || binding.artifactInventory.inventoryDigest !== inventory.inventoryDigest
        || binding.checkpointDigest !== db.checkpointDigest) uncertain();
      if (!prior || prior.state !== "committed" || prior.snapshotId !== binding.snapshotId)
        await replaceJson(operation, { schema: "control-room.retained-backup-journal/v1", bindingDigest,
          state: "committed", snapshotId: binding.snapshotId, updatedAt: createdAt });
      return { binding, replayed: true as const };
    }
    if (existing.length || prior) uncertain();
    await atomicJson(operation, { schema: "control-room.retained-backup-journal/v1", bindingDigest,
      state: "pending", updatedAt: createdAt });
    const stagingRoot = join(this.config.stateRoot, "staging"), staging = join(stagingRoot, hex(bindingDigest));
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 }); await privateDirectory(stagingRoot);
    try { await mkdir(staging, { mode: 0o700 }); await mkdir(join(staging, "artifacts"), { mode: 0o700 }); }
    catch (error) { return uncertain(error); }
    try {
      await copyFile(input.databaseDumpPath, join(staging, "database.dump"));
      await copyFile(input.artifactInventoryPath, join(staging, "artifact-inventory.json"));
      await copyFile(input.checkpointPath, join(staging, "checkpoint.json"));
      await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
      for (const artifact of artifacts) {
        const target = join(staging, "artifacts", artifact.fileName);
        await copyFile(supplied.get(artifact.artifactId)!, target);
        const copied = await hashFile(target, 65_536, input.signal);
        if (copied.size !== artifact.sizeBytes || copied.digest !== artifact.contentHash) unavailable();
      }
      const copiedDump = await hashFile(join(staging, "database.dump"), MAX_DUMP_BYTES, input.signal);
      if (copiedDump.size !== db.dumpSizeBytes || copiedDump.digest !== db.dumpDigest) unavailable();
      const copiedInventory = artifactBackupInventorySchemaV1.parse(JSON.parse(Buffer.from(await readBounded(
        join(staging, "artifact-inventory.json"), 16 * 1024 * 1024)).toString("utf8")));
      if (copiedInventory.inventoryDigest !== inventory.inventoryDigest) unavailable();
      const copiedCheckpoint = parseRollbackCheckpointV1(JSON.parse(Buffer.from(await readBounded(
        join(staging, "checkpoint.json"), 16 * 1024)).toString("utf8")));
      if (rollbackCheckpointDigestV1(copiedCheckpoint) !== db.checkpointDigest) unavailable();
      let backupResult: { stdout: string; stderr: string };
      try { backupResult = await run(this.config.resticExecutable, this.args("backup", "--json", "--tag", tag, "."),
        input.signal, this.config.timeoutMs, this.config.outputLimitBytes, staging); }
      catch (error) {
        await replaceJson(operation, { schema: "control-room.retained-backup-journal/v1", bindingDigest,
          state: "uncertain", updatedAt: new Date(now()).toISOString() }); return uncertain(error);
      }
      let claimed: string;
      try {
        const summaries = backupResult.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
          .filter(value => value && typeof value === "object" && "snapshot_id" in value);
        if (summaries.length !== 1) uncertain();
        claimed = snapshotSchema.shape.id.parse(summaries[0].snapshot_id);
      }
      catch (error) {
        await replaceJson(operation, { schema: "control-room.retained-backup-journal/v1", bindingDigest,
          state: "uncertain", updatedAt: new Date(now()).toISOString() });
        return uncertain(error);
      }
      let observed: z.infer<typeof snapshotSchema>[];
      try { observed = await this.snapshots(tag, input.signal); }
      catch (error) {
        await replaceJson(operation, { schema: "control-room.retained-backup-journal/v1", bindingDigest,
          state: "uncertain", updatedAt: new Date(now()).toISOString() });
        return uncertain(error);
      }
      if (observed.length !== 1 || observed[0]!.id !== claimed) {
        await replaceJson(operation, { schema: "control-room.retained-backup-journal/v1", bindingDigest,
          state: "uncertain", updatedAt: new Date(now()).toISOString() });
        uncertain();
      }
      const bindingMaterialValue = bindingMaterial.parse({ schema: "control-room.retained-snapshot-binding/v1", bindingDigest,
        snapshotId: claimed, repositorySelectionDigest: prepared.repositorySelectionDigest, manifestDigest: manifest.manifestDigest,
        databaseIdentityDigest: db.identityDigest, databaseDumpDigest: db.dumpDigest, databaseDumpSizeBytes: db.dumpSizeBytes,
        databaseSchemaVersion: db.databaseSchemaVersion, databaseSchemaDigest: db.databaseSchemaDigest,
        artifactInventoryDigest: inventory.inventoryDigest, artifactInventory: inventory,
        checkpointDigest: db.checkpointDigest, recordedAt: new Date(now()).toISOString() });
      const binding = bindingSchema.parse({ ...bindingMaterialValue,
        authTag: hmacSha256Tag(prepared.key, { purpose: "retained-snapshot-binding/v1", material: bindingMaterialValue }) });
      await atomicJson(this.bindingPath(bindingDigest), binding);
      await replaceJson(operation, { schema: "control-room.retained-backup-journal/v1", bindingDigest,
        state: "committed", snapshotId: claimed, updatedAt: binding.recordedAt });
      return { binding, replayed: false as const };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async restore(input: RetainedRestoreInputV1) {
    assertSignal(input.signal); digest.parse(input.bindingDigest); const prepared = await this.ready(input.signal);
    const binding = await this.readBinding(input.bindingDigest, prepared.key);
    if (binding.repositorySelectionDigest !== prepared.repositorySelectionDigest) unavailable();
    if (!isAbsolute(input.targetPath)) unavailable();
    const parent = resolve(dirname(input.targetPath)); await privateDirectory(parent);
    if (relative(parent, resolve(input.targetPath)).startsWith(`..${sep}`) || basename(input.targetPath) !== basename(resolve(input.targetPath))) unavailable();
    try { await lstat(input.targetPath); return unavailable(); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return unavailable(error);
    }
    await run(this.config.resticExecutable, this.args("check", "--read-data"), input.signal,
      this.config.timeoutMs, this.config.outputLimitBytes).catch(unavailable);
    await mkdir(input.targetPath, { mode: 0o700 });
    try {
      await run(this.config.resticExecutable, this.args("restore", binding.snapshotId, "--target", input.targetPath),
        input.signal, this.config.timeoutMs, this.config.outputLimitBytes);
      const manifest = manifestSchema.parse(JSON.parse(Buffer.from(await readBounded(join(input.targetPath, "manifest.json"), 1024 * 1024)).toString("utf8")));
      const { manifestDigest, ...manifestWithoutDigest } = manifest;
      if (manifestDigest !== sha256Digest(manifestWithoutDigest) || manifestDigest !== binding.manifestDigest
        || manifest.databaseIdentityDigest !== binding.databaseIdentityDigest
        || manifest.databaseDumpDigest !== binding.databaseDumpDigest
        || manifest.databaseDumpSizeBytes !== binding.databaseDumpSizeBytes
        || manifest.databaseSchemaVersion !== binding.databaseSchemaVersion
        || manifest.databaseSchemaDigest !== binding.databaseSchemaDigest
        || manifest.artifactInventoryDigest !== binding.artifactInventoryDigest || manifest.checkpointDigest !== binding.checkpointDigest) unavailable();
      const inventory = artifactBackupInventorySchemaV1.parse(JSON.parse(Buffer.from(await readBounded(join(input.targetPath,
        "artifact-inventory.json"), 16 * 1024 * 1024)).toString("utf8")));
      verifyRestoredArtifactBackupInventoryV1({ expected: binding.artifactInventory, restored: inventory });
      if (inventory.inventoryDigest !== binding.artifactInventoryDigest || inventory.entryCount !== manifest.artifactFiles.length) unavailable();
      for (const artifact of manifest.artifactFiles) {
        const data = await readBounded(join(input.targetPath, "artifacts", artifact.fileName), 65_536);
        if (data.byteLength !== artifact.sizeBytes || bytesDigest(data) !== artifact.contentHash) unavailable();
      }
      const checkpoint = parseRollbackCheckpointV1(JSON.parse(Buffer.from(await readBounded(join(input.targetPath,
        "checkpoint.json"), 16 * 1024)).toString("utf8")));
      if (rollbackCheckpointDigestV1(checkpoint) !== binding.checkpointDigest) unavailable();
      const database = verifiedDatabaseDumpBindingSchemaV1.parse({ tenantId: manifest.tenantId, releaseId: manifest.releaseId,
        identityDigest: manifest.databaseIdentityDigest, dumpDigest: manifest.databaseDumpDigest,
        dumpSizeBytes: manifest.databaseDumpSizeBytes, databaseSchemaVersion: manifest.databaseSchemaVersion,
        databaseSchemaDigest: manifest.databaseSchemaDigest, artifactInventoryDigest: manifest.artifactInventoryDigest,
        checkpointDigest: manifest.checkpointDigest });
      const verified = await this.database.verifyRestoredDump({ identity: input.databaseIdentity,
        dumpPath: join(input.targetPath, "database.dump"), expected: database, signal: input.signal });
      if (verified.identityDigest !== database.identityDigest || verified.dumpDigest !== database.dumpDigest) unavailable();
      return Object.freeze({ schema: "control-room.retained-restore-verification/v1" as const,
        bindingDigest: binding.bindingDigest, snapshotId: binding.snapshotId, manifestDigest,
        databaseIdentityDigest: verified.identityDigest, artifactInventoryDigest: inventory.inventoryDigest,
        checkpointDigest: rollbackCheckpointDigestV1(checkpoint), targetPath: input.targetPath,
        verifiedAt: new Date((input.now ?? Date.now)()).toISOString(), exactMatch: true as const,
        advancesCheckpoint: false as const, resetsCheckpoint: false as const, deletesData: false as const });
    } catch (error) {
      // A created restore target is retained for diagnosis. It is never reused or silently removed.
      return unavailable(error);
    }
  }
}
