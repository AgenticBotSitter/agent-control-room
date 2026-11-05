import { randomBytes } from "node:crypto";
import { constants, openSync, closeSync, lstatSync, fstatSync, readSync, writeFileSync, fsyncSync,
  mkdirSync, renameSync, unlinkSync, rmdirSync, realpathSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { canonicalJson } from "../../security";
import { parseStrictJsonV1 } from "../../installer/shared/strict-json.mjs";
import type { LoopSelectionSnapshotGuardV1, SelectionSnapshotV1 } from "./loop-selection-service";
import { decodeSelectionSourceBundleV1, encodeSelectionSourceBundleV1, normalizeSelectionAvailabilityV1,
  selectionSnapshotFromBundleV1, selectionSnapshotSchemaV1, selectionSourceHashV1, selectionSourceMaxBytesV1,
  selectionSourceUnavailableV1 as unavailable, type SelectionSourceBundleV1 } from "./loop-selection-snapshot-wire";

const nonce = () => randomBytes(16).toString("hex");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const uncertain = (e: unknown) => ["database_outcome_uncertain", "database_close_uncertain"].includes((e as { code?: string })?.code ?? "");
const sameFile = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) => a.ino === b.ino && a.dev === b.dev;
const unsafe = /(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.aws|\.codex|\.hermes|auth\.json|credentials|tokens?)(?:[/\\]|$)/i;
function ancestors(path: string) {
  if (!isAbsolute(path) || path !== resolve(path) || unsafe.test(path)) throw unavailable();
  for (let p = path;; p = dirname(p)) { if (lstatSync(p).isSymbolicLink()) throw unavailable(); if (p === dirname(p)) break; }
  if (realpathSync(path) !== path) throw unavailable();
}
function checked(path: string, directory = false) {
  ancestors(path); const s = lstatSync(path);
  if (s.uid !== process.getuid?.() || (s.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1 || s.size > selectionSourceMaxBytesV1)) throw unavailable();
  return s;
}
function readOwned(path: string) {
  const before = checked(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, fstatSync(fd))) throw unavailable();
    const bytes = Buffer.alloc(selectionSourceMaxBytesV1 + 1); let size = 0, n: number;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
    const after = checked(path), held = fstatSync(fd);
    if (size > selectionSourceMaxBytesV1 || !sameFile(before, after) || before.size !== held.size || before.mtimeMs !== held.mtimeMs)
      throw unavailable();
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
export interface LoopSelectionSourceLeaseV1 { release(): void }
export interface LoopSelectionSourceFilesV1 {
  readonly root: string;
  initialize(): void;
  acquire(): LoopSelectionSourceLeaseV1;
  invalidate(lease: LoopSelectionSourceLeaseV1): void;
  current(lease: LoopSelectionSourceLeaseV1, now: number): SelectionSourceBundleV1;
  previous(lease: LoopSelectionSourceLeaseV1, now: number): SelectionSourceBundleV1 | undefined;
  publish(lease: LoopSelectionSourceLeaseV1, bundle: SelectionSourceBundleV1): void;
  rosterText(): string;
  availability(now: number): SelectionSourceBundleV1["availability"];
  poison(): void;
}
/** I/O capability only. Construction never touches the filesystem. The shared
 * source directory is the one writable addition beneath the configured config root. */
export function createLoopSelectionSourceFilesV1(input: { availabilityFile: string; rosterFile: string;
  readAvailability(): unknown; faults?: { at(point: string): void } }): LoopSelectionSourceFilesV1 {
  input = Object.freeze({ ...input, readAvailability: input.readAvailability.bind(input),
    faults: input.faults && Object.freeze({ at: input.faults.at.bind(input.faults) }) });
  const root = join(dirname(input.availabilityFile), "selection-sources"), fence = join(root, "fence");
  const active = new WeakMap<LoopSelectionSourceLeaseV1, { ino: number; dev: number }>(); let poisoned = false;
  const checkRoot = () => { if (poisoned) throw unavailable(); return checked(root, true); };
  const syncDirectory = (path: string) => { const s = checked(path, true), fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!sameFile(s, fstatSync(fd))) throw unavailable(); fsyncSync(fd); } finally { closeSync(fd); } };
  const syncRoot = () => { checkRoot(); syncDirectory(root); };
  const requireLease = (lease: LoopSelectionSourceLeaseV1) => { const current = checkRoot(), owned = active.get(lease);
    if (!owned || !sameFile(owned, current)) throw unavailable(); };
  function atomic(name: "current.json" | "dirty.json", text: string) {
    const before = checkRoot();
    try { checked(join(root, name)); } catch (e) { if (!missing(e)) throw e; }
    if (Buffer.byteLength(text) > selectionSourceMaxBytesV1) throw unavailable();
    const temp = join(root, name + "." + nonce() + ".tmp");
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, text); input.faults?.at(name + ":write"); fsyncSync(fd); input.faults?.at(name + ":fsync"); }
    finally { closeSync(fd); }
    try {
      if (!sameFile(before, checkRoot())) throw unavailable();
      renameSync(temp, join(root, name)); input.faults?.at(name + ":rename"); syncRoot(); input.faults?.at(name + ":directory-fsync");
    } finally { try { unlinkSync(temp); } catch (e) { if (!missing(e)) throw e; } }
  }
  const dirty = () => { try {
    const marker = parseStrictJsonV1(new TextDecoder("utf-8", { fatal: true }).decode(readOwned(join(root, "dirty.json"))), { maxBytes: 256 }) as { schemaVersion: number; nonce: string };
    if (!marker || Object.keys(marker).sort().join(",") !== "nonce,schemaVersion" || marker.schemaVersion !== 1 || typeof marker.nonce !== "string" || !/^[a-f0-9]{32}$/.test(marker.nonce)) throw unavailable();
    return true;
  } catch (e) { if (missing(e)) return false; throw e; } };
  const current = (lease: LoopSelectionSourceLeaseV1, now: number) => {
    requireLease(lease); if (dirty()) throw unavailable();
    return decodeSelectionSourceBundleV1(readOwned(join(root, "current.json")), now);
  };
  return Object.freeze<LoopSelectionSourceFilesV1>({ root,
    initialize() { ancestors(dirname(root)); checked(dirname(root), true);
      try { mkdirSync(root, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      checkRoot(); },
    acquire() {
      const rootInode = checkRoot();
      try { mkdirSync(fence, { mode: 0o700 }); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("selection_source_busy"); throw e;
      }
      const owner = { schemaVersion: 1, nonce: nonce() }, inode = checked(fence, true);
      // Failure during acquisition conservatively leaves an abandoned fence.
      const fd = openSync(join(fence, "owner.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, canonicalJson(owner) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(fence); syncRoot();
      const lease: LoopSelectionSourceLeaseV1 = Object.freeze({ release() {
        requireLease(lease);
        if (!sameFile(inode, checked(fence, true)) || canonicalJson(parseStrictJsonV1(readOwned(join(fence, "owner.json")).toString("utf8"), { maxBytes: 256 })) !== canonicalJson(owner))
          throw unavailable();
        unlinkSync(join(fence, "owner.json")); syncDirectory(fence); rmdirSync(fence); syncRoot(); active.delete(lease);
      } });
      active.set(lease, rootInode); return lease;
    },
    invalidate(lease) { requireLease(lease); atomic("dirty.json", canonicalJson({ schemaVersion: 1, nonce: nonce() }) + "\n");
      try { unlinkSync(join(root, "current.json")); } catch (e) { if (!missing(e)) throw e; }
      input.faults?.at("current:remove"); syncRoot(); },
    current,
    previous(lease, now) { requireLease(lease); if (dirty()) return undefined;
      try { return current(lease, now); } catch (e) { if (missing(e)) return undefined; throw e; } },
    publish(lease, bundle) { requireLease(lease); atomic("current.json", encodeSelectionSourceBundleV1(bundle));
      try { unlinkSync(join(root, "dirty.json")); } catch (e) { if (!missing(e)) throw e; }
      input.faults?.at("dirty:remove"); syncRoot(); },
    rosterText() { return new TextDecoder("utf-8", { fatal: true }).decode(readOwned(input.rosterFile)); },
    availability(now) {
      const bytes = readOwned(input.availabilityFile);
      const raw = parseStrictJsonV1(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { maxBytes: 65536 });
      const health = normalizeSelectionAvailabilityV1(raw, now);
      // The monitor validates schedule/hash/bootstrap custody as well as health.
      if (canonicalJson(health) !== canonicalJson(normalizeSelectionAvailabilityV1(input.readAvailability(), now))) throw unavailable();
      return health;
    },
    poison() { poisoned = true; },
  });
}

type Deadline = Readonly<{ frozenMono: number; deadlineMono: number; frozenWall: number }>;
type Scope = { files: LoopSelectionSourceFilesV1; live: boolean; lease?: LoopSelectionSourceLeaseV1;
  checks: Set<() => Promise<void>>; deadline?: Deadline };
const scopes = new WeakMap<DatabaseSession, Scope>();
function scopeOf(tx: DatabaseSession, files?: LoopSelectionSourceFilesV1) {
  const scope = scopes.get(tx); if (!scope?.live || files && scope.files !== files) throw unavailable(); return scope;
}
export function registerLoopSelectionSourceTransactionAliasV1(alias: DatabaseSession, tx: DatabaseSession): void {
  const scope = scopeOf(tx); if (scopes.has(alias)) throw unavailable(); scopes.set(alias, scope);
}
export function bindLoopSelectionSourceDeadlineV1(tx: DatabaseSession, value: Deadline): void {
  const scope = scopeOf(tx);
  if (scope.deadline || !Number.isSafeInteger(value.frozenWall) || value.frozenWall < 0
    || !Number.isFinite(value.frozenMono) || value.frozenMono < 0 || !Number.isFinite(value.deadlineMono)
    || value.deadlineMono <= value.frozenMono || value.deadlineMono - value.frozenMono > 5000) throw unavailable();
  scope.deadline = Object.freeze({ ...value });
}
export function withLoopSelectionSourceTransactionsV1(db: DatabaseClient, files: LoopSelectionSourceFilesV1): DatabaseClient {
  const transaction = db.transactionWithPreCommitCheck.bind(db);
  async function run<T>(callback: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) {
    let scope: Scope | undefined;
    try {
      return await transaction(async tx => {
        if (scopes.has(tx)) throw unavailable();
        scope = { files, live: true, checks: new Set() }; scopes.set(tx, scope);
        return callback(tx);
      }, async () => { await check(); for (const validate of scope?.checks ?? []) await validate(); });
    } catch (error) { if (uncertain(error) && scope?.lease) { files.poison(); scope.lease = undefined; } throw error; }
    finally { if (scope) { try { scope.lease?.release(); } finally { scope.live = false; } } }
  }
  return Object.freeze({ query: db.query.bind(db), transaction: <T>(callback: (tx: DatabaseSession) => Promise<T>) => run(callback, () => {}),
    transactionWithPreCommitCheck: run });
}
export interface LoopSelectionSourceParticipantV1 {
  lockSources(tx: DatabaseSession): Promise<void>;
  invalidate(tx: DatabaseSession): Promise<void>;
}
export type LoopRosterSnapshotSourceV1 = Readonly<{ version: string; exportedVersion: string; exportedSha256: string; text: string }>;
export class LoopSelectionSnapshotCoordinatorV1 implements LoopSelectionSnapshotGuardV1, LoopSelectionSourceParticipantV1 {
  #started = false;
  constructor(private readonly input: { db: DatabaseClient; tenantId: string; workspaceId: string;
    sourceFiles: LoopSelectionSourceFilesV1;
    readRoster(tx: DatabaseSession, tenantId: string): Promise<LoopRosterSnapshotSourceV1>;
    clock?: { wallNow(): number; monotonicNow(): number } }) {
    this.input = Object.freeze({ ...input, clock: input.clock && Object.freeze({
      wallNow: input.clock.wallNow.bind(input.clock), monotonicNow: input.clock.monotonicNow.bind(input.clock) }) });
  }
  async start(): Promise<void> {
    if (this.#started) throw unavailable();
    this.input.sourceFiles.initialize();
    await this.input.db.transaction(async tx => { await this.lockSources(tx); await this.invalidate(tx); });
    this.#started = true;
  }
  async lockSources(tx: DatabaseSession): Promise<void> {
    const scope = scopeOf(tx, this.input.sourceFiles);
    if (!scope.lease) {
      scope.lease = this.input.sourceFiles.acquire();
      const isolation = (await tx.query<{ transaction_isolation: string }>("SHOW transaction_isolation")).rows[0];
      if (isolation?.transaction_isolation !== "read committed") throw unavailable();
    }
  }
  async invalidate(tx: DatabaseSession): Promise<void> {
    const scope = scopeOf(tx, this.input.sourceFiles); if (!scope.lease) throw unavailable(); this.input.sourceFiles.invalidate(scope.lease);
  }
  #now() {
    const c = this.input.clock, wall = c ? c.wallNow() : Date.now(), mono = c ? c.monotonicNow() : performance.now();
    if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(mono) || mono < 0) throw unavailable();
    return { wall, mono };
  }
  async #sources(tx: DatabaseSession) {
    const roster = await this.input.readRoster(tx, this.input.tenantId);
    const { version, exportedVersion, exportedSha256, text } = roster;
    if (!/^[1-9][0-9]{0,15}$/.test(version) || !Number.isSafeInteger(Number(version)) || version !== exportedVersion || !text
      || selectionSourceHashV1(text) !== exportedSha256 || this.input.sourceFiles.rosterText() !== text) throw unavailable();
    const availability = this.input.sourceFiles.availability(this.#now().wall);
    return { roster: { version, exportedVersion, text }, availability };
  }
  async capture(): Promise<SelectionSnapshotV1> {
    if (!this.#started) throw unavailable();
    return this.input.db.transaction(async tx => {
      await this.lockSources(tx); const scope = scopeOf(tx, this.input.sourceFiles), sources = await this.#sources(tx);
      const previous = this.input.sourceFiles.previous(scope.lease!, this.#now().wall);
      const unchanged = previous && canonicalJson({ roster: previous.roster, availability: previous.availability }) === canonicalJson(sources);
      const bundle: SelectionSourceBundleV1 = { schemaVersion: 1, revision: unchanged ? previous.revision : "selection-source-v1:" + nonce(), ...sources };
      if (!unchanged) { await this.invalidate(tx); this.input.sourceFiles.publish(scope.lease!, bundle); }
      return selectionSnapshotFromBundleV1(bundle);
    });
  }
  async assertCurrent(tx: DatabaseSession, checkedSnapshot: SelectionSnapshotV1): Promise<void> {
    if (!this.#started) throw unavailable();
    const snapshot = selectionSnapshotSchemaV1.parse(checkedSnapshot);
    await this.lockSources(tx); const scope = scopeOf(tx, this.input.sourceFiles);
    if (!scope.deadline) throw unavailable();
    const validate = async () => {
      const current = this.input.sourceFiles.current(scope.lease!, this.#now().wall), sources = await this.#sources(tx);
      const at = this.#now(), d = scope.deadline!;
      const elapsed = at.mono - d.frozenMono, wallElapsed = at.wall - d.frozenWall;
      if (elapsed < 0 || at.mono >= d.deadlineMono || wallElapsed < 0 || Math.abs(elapsed - wallElapsed) > 2
        || Date.parse(sources.availability.checked_at) + 3600000 < at.wall + (d.deadlineMono - at.mono)
        || canonicalJson(sources) !== canonicalJson({ roster: current.roster, availability: current.availability })
        || canonicalJson(snapshot) !== canonicalJson(selectionSnapshotFromBundleV1(current))) throw unavailable();
    };
    await validate(); scope.checks.add(validate);
  }
}
