import { constants } from "node:fs";
import { type FileHandle, link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

const noFollow = constants.O_NOFOLLOW ?? 0;

export type InstallationPlanJournalStorageOperationV1 =
  "read_history" | "inspect_settled_history" | "append";

export type InstallationPlanJournalEntryIdentityV1 = Readonly<{ device: bigint; inode: bigint }>;

export type InstallationPlanJournalEntryV1 = Readonly<{
  identity: InstallationPlanJournalEntryIdentityV1;
  kind: "file" | "directory" | "other";
  ownerUid: number;
  mode: number;
  linkCount: number;
  size: number;
  canonical: boolean;
}>;

export type InstallationPlanJournalReadEntryV1 = Readonly<{
  entry: InstallationPlanJournalEntryV1;
  bytes: Uint8Array;
}>;

export type InstallationPlanJournalStorageSessionV1 = Readonly<{
  operation: InstallationPlanJournalStorageOperationV1;
  listEntryNames(): Promise<readonly string[]>;
  statEntry(name: string): Promise<InstallationPlanJournalEntryV1 | undefined>;
  readEntry(name: string, maximumBytes: number): Promise<InstallationPlanJournalReadEntryV1>;
  createExclusiveEntry(name: string): Promise<InstallationPlanJournalEntryIdentityV1>;
  writeExactBounded(name: string, identity: InstallationPlanJournalEntryIdentityV1,
    bytes: Uint8Array, maximumBytes: number): Promise<void>;
  syncFile(name: string, identity: InstallationPlanJournalEntryIdentityV1): Promise<void>;
  linkNoReplace(sourceName: string, sourceIdentity: InstallationPlanJournalEntryIdentityV1,
    targetName: string): Promise<void>;
  unlinkExact(name: string, identity: InstallationPlanJournalEntryIdentityV1, allowMissing?: boolean): Promise<void>;
  syncDirectory(): Promise<void>;
  verifyRoot(): Promise<void>;
  close(): Promise<void>;
}>;

export type InstallationPlanJournalStorageSessionOpenV1 = Readonly<{
  operation: InstallationPlanJournalStorageOperationV1;
  rootDirectory: string;
  installationId: string;
  ownerUid: number;
  signal?: AbortSignal;
}>;

export type InstallationPlanJournalStorageSessionFactoryV1 =
  (request: InstallationPlanJournalStorageSessionOpenV1) => Promise<InstallationPlanJournalStorageSessionV1>;

const unavailable = (): never => { throw new Error("installation_plan_journal_unavailable"); };
const identity = (device: bigint, inode: bigint): InstallationPlanJournalEntryIdentityV1 =>
  Object.freeze({ device, inode });
const sameIdentity = (left: InstallationPlanJournalEntryIdentityV1,
  right: InstallationPlanJournalEntryIdentityV1) => left.device === right.device && left.inode === right.inode;

function safeName(name: string): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 255 || name === "." || name === ".."
    || name.includes("/") || name.includes("\0") || Buffer.byteLength(name, "utf8") > 255) return unavailable();
  return name;
}

/**
 * Compatibility storage session for the existing source journal. It retains
 * the opened root and newly-created file descriptors for one complete public
 * operation. A native adapter can replace this factory with descriptor-relative
 * mechanics without changing any journal transition or recovery rule.
 */
export const openInstallationPlanFilesystemStorageSessionV1:
InstallationPlanJournalStorageSessionFactoryV1 = async request => {
  request.signal?.throwIfAborted();
  let closed = false;
  const created = new Map<string, Readonly<{ identity: InstallationPlanJournalEntryIdentityV1; handle: FileHandle }>>();
  const rootPath = request.rootDirectory;
  let rootEntry;
  try {
    const canonical = await realpath(rootPath);
    rootEntry = await lstat(rootPath, { bigint: true });
    if (canonical !== rootPath || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()
      || rootEntry.uid !== BigInt(request.ownerUid) || (rootEntry.mode & BigInt(0o077)) !== BigInt(0)) unavailable();
  } catch { return unavailable(); }
  const rootIdentity = identity(rootEntry.dev, rootEntry.ino);
  const rootHandle = await open(rootPath, constants.O_RDONLY | noFollow).catch(unavailable);
  const assertActive = () => { if (closed) return unavailable(); request.signal?.throwIfAborted(); };
  const verifyRoot = async () => {
    assertActive();
    try {
      const [current, canonical, opened] = await Promise.all([
        lstat(rootPath, { bigint: true }), realpath(rootPath), rootHandle.stat({ bigint: true }),
      ]);
      if (canonical !== rootPath || !current.isDirectory() || current.isSymbolicLink()
        || current.uid !== BigInt(request.ownerUid) || (current.mode & BigInt(0o077)) !== BigInt(0)
        || current.dev !== rootIdentity.device || current.ino !== rootIdentity.inode
        || opened.dev !== rootIdentity.device || opened.ino !== rootIdentity.inode) unavailable();
    } catch { return unavailable(); }
  };
  const statEntry = async (nameValue: string): Promise<InstallationPlanJournalEntryV1 | undefined> => {
    assertActive(); const name = safeName(nameValue); await verifyRoot(); const path = join(rootPath, name);
    let entry;
    try { entry = await lstat(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return unavailable(); }
    const canonical = await realpath(path).then(value => value === path).catch(() => false);
    return Object.freeze({ identity: identity(entry.dev, entry.ino),
      kind: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : "other" as const,
      ownerUid: Number(entry.uid), mode: Number(entry.mode & BigInt(0o7777)), linkCount: Number(entry.nlink),
      size: Number(entry.size), canonical });
  };
  const session: InstallationPlanJournalStorageSessionV1 = Object.freeze({
    operation: request.operation,
    async listEntryNames() { assertActive(); await verifyRoot(); return Object.freeze(await readdir(rootPath)); },
    statEntry,
    async readEntry(nameValue, maximumBytes) {
      assertActive(); const name = safeName(nameValue), before = await statEntry(name);
      if (!before || before.kind !== "file" || !before.canonical || before.size < 1 || before.size > maximumBytes) return unavailable();
      const handle = await open(join(rootPath, name), constants.O_RDONLY | noFollow).catch(unavailable);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== before.identity.device || opened.ino !== before.identity.inode
          || Number(opened.size) !== before.size) unavailable();
        const bytes = await handle.readFile();
        if (bytes.byteLength !== before.size || bytes.byteLength > maximumBytes) unavailable();
        return Object.freeze({ entry: before, bytes: Uint8Array.from(bytes) });
      } finally { await handle.close().catch(unavailable); }
    },
    async createExclusiveEntry(nameValue) {
      assertActive(); const name = safeName(nameValue);
      if (request.operation !== "append" || created.has(name)) return unavailable();
      await verifyRoot();
      const handle = await open(join(rootPath, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.uid !== BigInt(request.ownerUid) || opened.nlink !== BigInt(1)
          || (opened.mode & BigInt(0o077)) !== BigInt(0) || opened.size !== BigInt(0)) unavailable();
        const createdIdentity = identity(opened.dev, opened.ino);
        created.set(name, Object.freeze({ identity: createdIdentity, handle }));
        return createdIdentity;
      } catch (error) { await handle.close().catch(() => {}); throw error; }
    },
    async writeExactBounded(nameValue, expectedIdentity, bytes, maximumBytes) {
      assertActive(); const name = safeName(nameValue), held = created.get(name);
      if (!held || !sameIdentity(held.identity, expectedIdentity) || !(bytes instanceof Uint8Array)
        || bytes.byteLength < 1 || bytes.byteLength > maximumBytes) return unavailable();
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await held.handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesWritten < 1 || result.bytesWritten > bytes.byteLength - offset) return unavailable();
        offset += result.bytesWritten;
      }
      const final = await held.handle.stat({ bigint: true });
      if (final.dev !== expectedIdentity.device || final.ino !== expectedIdentity.inode
        || final.size !== BigInt(bytes.byteLength)) unavailable();
    },
    async syncFile(nameValue, expectedIdentity) {
      assertActive(); const held = created.get(safeName(nameValue));
      if (!held || !sameIdentity(held.identity, expectedIdentity)) return unavailable();
      await held.handle.sync();
    },
    async linkNoReplace(sourceValue, expectedIdentity, targetValue) {
      assertActive(); if (request.operation !== "append") return unavailable();
      const sourceName = safeName(sourceValue), targetName = safeName(targetValue), source = await statEntry(sourceName);
      if (!source || !sameIdentity(source.identity, expectedIdentity) || source.kind !== "file" || !source.canonical
        || source.linkCount !== 1) return unavailable();
      await verifyRoot(); await link(join(rootPath, sourceName), join(rootPath, targetName));
    },
    async unlinkExact(nameValue, expectedIdentity, allowMissing = false) {
      assertActive();
      if (request.operation === "inspect_settled_history") return unavailable();
      const name = safeName(nameValue), current = await statEntry(name);
      if (!current) { if (allowMissing) return; return unavailable(); }
      if (!sameIdentity(current.identity, expectedIdentity) || current.kind !== "file" || !current.canonical) {
        if (allowMissing && !await statEntry(name)) return;
        return unavailable();
      }
      await verifyRoot();
      try { await unlink(join(rootPath, name)); }
      catch (error) {
        if (!(allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")) return unavailable();
      }
    },
    async syncDirectory() {
      assertActive(); if (request.operation === "inspect_settled_history") return unavailable();
      await verifyRoot(); await rootHandle.sync(); await verifyRoot();
    },
    verifyRoot,
    async close() {
      if (closed) return unavailable(); closed = true;
      const results = await Promise.allSettled([...created.values()].map(value => value.handle.close()));
      const rootResult = await rootHandle.close().then(() => true, () => false);
      if (!rootResult || results.some(result => result.status === "rejected")) return unavailable();
    },
  });
  return session;
};
