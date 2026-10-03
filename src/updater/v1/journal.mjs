import { sameIdentityV1 } from "../../installer/shared/file-custody.mjs";
import { readJsonlPrefixV1 } from "../../installer/shared/jsonl-prefix.mjs";
import { kernelFileLockPlatformV1 } from "../../installer/shared/private-process-lock.mjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, rm, unlink } from "node:fs/promises";
import { uptime } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { assertNoSymlinkBelowV1, atomicWriteNoFollowV1, openNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";
import { updaterRefuseV1 } from "./contracts.mjs";

const JOURNAL_PATH_V1 = "updater-state/journal.jsonl";
const KEY_PATH_V1 = "updater-state/journal.key";
const COMPACTION_PATH_V1 = "updater-state/journal.compaction.json";
const GENESIS_MAC_V1 = "0".repeat(64);
const MAX_LINE_BYTES_V1 = 16_384;
const COMPACT_AT_BYTES_V1 = 1024 * 1024;
const ALERT_AT_BYTES_V1 = 4 * 1024 * 1024;
const CAP_BYTES_V1 = 8 * 1024 * 1024;
const TERMINAL_V1 = new Set(["succeeded", "rolled_back", "needs_attention", "refused"]);
const TRANSACTION_LOCK_PATH_V1 = "updater-state/journal.lock";
// macOS O_EXLOCK from <sys/fcntl.h>; Node does not export it. The kernel takes
// the lock as part of the open and drops it whenever the holder exits, SIGKILL
// included, so a killed or PID-recycled writer never strands the journal.
const KERNEL_LOCK_V1 = 0x20;
const TRANSACTION_LOCK_WAIT_MS_V1 = 10_000;
// Slack for a wall clock that moved after boot; only older stamps are pre-boot.
const STAMP_BOOT_MARGIN_MS_V1 = 60_000;

function canonicalV1(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalV1).join(",")}]`;
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw updaterRefuseV1("updater_journal_canonical_refused");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalV1(value[key])}`).join(",")}}`;
}

function macV1(key, previous, entry) {
  return createHmac("sha256", key).update(`${previous}\0${canonicalV1(entry)}`, "utf8").digest("hex");
}

function equalMacV1(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !/^[a-f0-9]{64}$/u.test(left)
      || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function journalErrorV1(code) { return updaterRefuseV1(code); }

function entryWithoutMacV1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw journalErrorV1("updater_journal_line_refused");
  const { mac, prevMac, ...entry } = value;
  if (Object.keys(entry).some(key => key === "mac" || key === "prevMac") || typeof prevMac !== "string" || typeof mac !== "string")
    throw journalErrorV1("updater_journal_line_refused");
  return { entry, prevMac, mac };
}

function asDateV1(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw journalErrorV1("updater_journal_line_refused");
  return time;
}

async function syncDirectoryV1(root, relativePath) {
  const directory = await open(join(root, dirname(relativePath)), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

/**
 * Root-owned, MAC-chained file authority. It deliberately has no database
 * dependency: a database is a display mirror and can never repair this file.
 */
export class FileStepJournalV1 {
  #tail = Promise.resolve();
  constructor(root, { ownerUid = process.getuid?.() === 0 ? 0 : undefined, checkpoint = async () => {} } = {}) {
    this.root = root; this.ownerUid = ownerUid; this.checkpoint = checkpoint;
  }
  async #serialized(work) {
    const locked = async () => {
      const lock = await this.#acquireTransactionLock();
      try { return await work(); } finally { await this.#releaseTransactionLock(lock); }
    };
    const next = this.#tail.then(locked, locked);
    this.#tail = next.catch(() => {});
    return next;
  }
  // One transaction lock for every writer, in this process or another (A1-06,
  // F3-19). Contenders wait a bounded time, then refuse as busy. Our own lock
  // file is always empty; content can only come from a PID-stamp writer, which
  // is reclaimed when written before this boot, or when well formed and its PID
  // is gone (A1-06), and left untouched otherwise. The file is removed on
  // release, while still locked. The platform lock is chosen in one place,
  // kernelFileLockPlatformV1: macOS O_EXLOCK, Linux flock(2).
  async #acquireTransactionLock() {
    let platform;
    try { platform = kernelFileLockPlatformV1(process.platform, { macExclusive: KERNEL_LOCK_V1 }); }
    catch { throw journalErrorV1("updater_journal_lock_unsupported"); }
    const path = await assertNoSymlinkBelowV1(this.root, TRANSACTION_LOCK_PATH_V1, { allowMissingLeaf: true });
    const uid = this.ownerUid ?? process.getuid();
    const deadline = performance.now() + TRANSACTION_LOCK_WAIT_MS_V1;
    for (;;) {
      let handle;
      try {
        handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | platform.openFlags, 0o600);
      } catch (error) {
        if (error?.code !== "EAGAIN") throw journalErrorV1("updater_journal_owner_refused");
      }
      if (handle) {
        try {
          // macOS took the lock in the open itself; Linux takes it now, on this
          // open file description. A conflict is retried like EAGAIN above.
          let locked;
          try { locked = platform.tryLock(handle.fd); }
          catch { throw journalErrorV1("updater_journal_lock_unsupported"); }
          const owned = locked ? await handle.stat() : undefined;
          // Create-then-lock is two kernel steps, and a releasing holder unlinks
          // before it unlocks, so this open can lock an inode that has just lost
          // its name. Only the inode still under the name is the lock; retry.
          const named = locked ? await lstat(path).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error)) : undefined;
          if (named && sameIdentityV1(owned, named)) {
            if (!owned.isFile() || owned.nlink !== 1 || (owned.mode & 0o077) !== 0 || owned.uid !== uid)
              throw journalErrorV1("updater_journal_owner_refused");
            const bytes = Buffer.alloc(257), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            // A stamp written before this boot cannot belong to a running writer,
            // whatever process now has its PID (R2F-02); it is reclaimed as dead.
            if (bytesRead && owned.mtimeMs < Date.now() - uptime() * 1000 - STAMP_BOOT_MARGIN_MS_V1) {
              await handle.truncate(0); await handle.sync();
            } else if (bytesRead) {
              let owner;
              try { owner = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); } catch {}
              if (bytesRead > 256 || !Number.isSafeInteger(owner?.pid) || owner.pid < 1 || owner.pid > 0x7fffffff)
                throw journalErrorV1("updater_journal_busy");
              try { process.kill(owner.pid, 0); throw journalErrorV1("updater_journal_busy"); }
              catch (dead) { if (dead?.code !== "ESRCH") throw journalErrorV1("updater_journal_busy"); }
              await handle.truncate(0); await handle.sync();
            }
            return { handle, owned, path };
          }
        } catch (error) { await handle.close(); throw error; }
        await handle.close();
      }
      if (performance.now() >= deadline) throw journalErrorV1("updater_journal_busy");
      await new Promise(resolve => { setTimeout(resolve, 5 + Math.floor(Math.random() * 20)); });
    }
  }
  async #releaseTransactionLock({ handle, owned, path }) {
    try {
      const current = await lstat(path).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
      // A replaced lock is someone else's: refuse and leave it in place.
      if (!current || !sameIdentityV1(owned, current)) throw journalErrorV1("updater_journal_owner_refused");
      await unlink(path);
    } finally { await handle.close(); }
  }
  async #assertOwned(relativePath, { allowMissing = false } = {}) {
    try {
      const entry = await lstat(join(this.root, relativePath));
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || (entry.mode & 0o022) !== 0
          || (this.ownerUid !== undefined && entry.uid !== this.ownerUid)) throw journalErrorV1("updater_journal_owner_refused");
      return entry;
    } catch (error) { if (allowMissing && error?.code === "ENOENT") return undefined; throw error; }
  }
  async #key() {
    await this.#assertOwned(KEY_PATH_V1, { allowMissing: true });
    try {
      const key = await readFileNoFollowV1(this.root, KEY_PATH_V1, { maxBytes: 128 });
      const value = Buffer.from(key.trim(), "hex");
      if (value.length !== 32 || value.toString("hex") !== key.trim()) throw journalErrorV1("updater_journal_key_refused");
      return value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const relativeTemp = `${KEY_PATH_V1}.new-${randomBytes(16).toString("hex")}`;
      await assertNoSymlinkBelowV1(this.root, "updater-state");
      const handle = await open(join(this.root, relativeTemp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(`${randomBytes(32).toString("hex")}\n`); await handle.sync(); await this.checkpoint("key_before_rename"); }
      finally { await handle.close(); }
      await chmod(join(this.root, relativeTemp), 0o600);
      await rename(join(this.root, relativeTemp), join(this.root, KEY_PATH_V1));
      await syncDirectoryV1(this.root, KEY_PATH_V1);
      return this.#key();
    }
  }
  async #read({ missingOk = true, relativePath = JOURNAL_PATH_V1 } = {}) {
    const owned = await this.#assertOwned(relativePath, { allowMissing: missingOk });
    let text;
    try { text = await readFileNoFollowV1(this.root, relativePath, { maxBytes: CAP_BYTES_V1 + MAX_LINE_BYTES_V1 }); }
    catch (error) { if (missingOk && error?.code === "ENOENT") return { entries: [], tail: GENESIS_MAC_V1, bytes: 0 }; throw error; }
    const prefix = readJsonlPrefixV1(text, { recoverTail: relativePath === JOURNAL_PATH_V1,
      maxLineBytes: MAX_LINE_BYTES_V1, refuse: reason => {
        const code = reason.endsWith(" is too large") ? "updater_journal_line_refused" : "updater_journal_short";
        const error = journalErrorV1(code); error.message += `: ${reason}`; throw error;
      } });
    const key = await this.#key(); let previous = GENESIS_MAC_V1; const entries = [], seenOrdinals = new Map();
    for (const parsed of prefix.values) {
      const { entry, prevMac, mac } = entryWithoutMacV1(parsed);
      if (!equalMacV1(prevMac, previous) || !equalMacV1(mac, macV1(key, previous, entry)))
        throw journalErrorV1("updater_journal_mac_refused");
      if (entry.kind === "intent" || entry.kind === "done") {
        if (typeof entry.runId !== "string" || !Number.isSafeInteger(entry.ordinal) || entry.ordinal < 1)
          throw journalErrorV1("updater_journal_ordinal_refused");
        const ordinalKey = `${entry.runId}\0${entry.ordinal}\0${entry.kind}`;
        const { at: _at, ...ordinalEntry } = entry, fingerprint = canonicalV1(ordinalEntry);
        if (seenOrdinals.has(ordinalKey) && seenOrdinals.get(ordinalKey) !== fingerprint)
          throw journalErrorV1("updater_journal_ordinal_refused");
        seenOrdinals.set(ordinalKey, fingerprint);
      }
      entries.push(Object.freeze({ ...entry, prevMac, mac })); previous = mac;
    }
    // Every complete entry has proved its MAC and ordinal before the tail is
    // removed. The transaction lock also excludes appenders during recovery.
    if (prefix.repaired) {
      await this.checkpoint("journal_tail_before_repair");
      const handle = await openNoFollowV1(this.root, relativePath, constants.O_RDWR);
      try {
        if (!sameIdentityV1(owned, await handle.stat())) throw journalErrorV1("updater_journal_owner_refused");
        await handle.truncate(prefix.bytes); await handle.sync();
      } finally { await handle.close(); }
      await this.checkpoint("journal_tail_repaired");
    }
    return { entries: Object.freeze(entries), tail: previous, bytes: prefix.bytes };
  }
  async recoverCompaction() {
    return this.#serialized(async () => {
      let marker;
      try { marker = JSON.parse(await readFileNoFollowV1(this.root, COMPACTION_PATH_V1, { maxBytes: 1024 })); }
      catch (error) { if (error?.code === "ENOENT") return false; throw journalErrorV1("updater_journal_compaction_refused"); }
      if (!marker || marker.schema !== "control-room.journal-compaction/v1" || typeof marker.file !== "string"
          || basename(marker.file) !== marker.file || !/^journal\.compact\.[0-9a-f]{32}$/u.test(marker.file))
        throw journalErrorV1("updater_journal_compaction_refused");
      const temporary = `updater-state/${marker.file}`;
      let temporaryExists = true;
      try { await this.#assertOwned(temporary); } catch (error) {
        if (error?.code === "ENOENT") temporaryExists = false; else throw error;
      }
      if (temporaryExists) {
        try { await this.#read({ missingOk: false, relativePath: temporary }); }
        catch (error) {
          // The old authority remains intact until this point. A replacement
          // that cannot prove its own chain is discarded, never adopted.
          await rm(join(this.root, temporary), { force: true });
          await unlink(join(this.root, COMPACTION_PATH_V1));
          await syncDirectoryV1(this.root, COMPACTION_PATH_V1);
          return false;
        }
        await rename(join(this.root, temporary), join(this.root, JOURNAL_PATH_V1)); await syncDirectoryV1(this.root, JOURNAL_PATH_V1);
      } else await this.#read({ missingOk: false }); // rename committed before the crash
      await unlink(join(this.root, COMPACTION_PATH_V1)); await syncDirectoryV1(this.root, COMPACTION_PATH_V1);
      return true;
    });
  }
  validate() { return this.#serialized(() => this.#read()); }
  nextOrdinal(runId) {
    return this.#serialized(async () => {
      const current = await this.#read(); let highest = 0;
      for (const entry of current.entries)
        if (entry.runId === runId && Number.isSafeInteger(entry.ordinal)) highest = Math.max(highest, entry.ordinal);
      return highest + 1;
    });
  }
  async quarantineCorrupt() {
    return this.#serialized(async () => {
      await this.#assertNoPendingCompaction();
      try { await this.#read({ missingOk: false }); return false; }
      catch (error) {
        if (!['updater_journal_short', 'updater_journal_line_refused', 'updater_journal_mac_refused',
          'updater_journal_canonical_refused', 'updater_journal_ordinal_refused'].includes(error?.code)) throw error;
      }
      await this.#assertOwned(JOURNAL_PATH_V1, { allowMissing: false });
      const poisoned = `${JOURNAL_PATH_V1}.poisoned-${Date.now()}-${randomBytes(8).toString("hex")}`;
      await rename(join(this.root, JOURNAL_PATH_V1), join(this.root, poisoned));
      await syncDirectoryV1(this.root, JOURNAL_PATH_V1);
      return true;
    });
  }
  health(bytes) { return Object.freeze({ alert: bytes >= ALERT_AT_BYTES_V1, cap: bytes >= CAP_BYTES_V1 }); }
  async #assertNoPendingCompaction() {
    try { await lstat(join(this.root, COMPACTION_PATH_V1)); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    throw journalErrorV1("updater_journal_compaction_pending");
  }
  async #append(kind, record) {
    return this.#serialized(async () => {
      await this.#assertNoPendingCompaction();
      const current = await this.#read(); if (current.bytes >= CAP_BYTES_V1) throw journalErrorV1("updater_journal_cap_refused");
      const key = await this.#key();
      const entry = { schema: "control-room.updater-journal/v1", kind, at: new Date().toISOString(), ...record };
      asDateV1(entry.at);
      if (kind === "intent" || kind === "done") {
        if (typeof entry.runId !== "string" || !Number.isSafeInteger(entry.ordinal) || entry.ordinal < 1)
          throw journalErrorV1("updater_journal_ordinal_refused");
        const { at: _at, ...candidate } = entry;
        for (const { at: _oldAt, prevMac: _prev, mac: _mac, ...existing } of current.entries)
          if (existing.runId === entry.runId && existing.ordinal === entry.ordinal && existing.kind === kind
              && canonicalV1(existing) !== canonicalV1(candidate)) throw journalErrorV1("updater_journal_ordinal_refused");
      }
      const mac = macV1(key, current.tail, entry), line = `${canonicalV1({ ...entry, prevMac: current.tail, mac })}\n`;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES_V1 || current.bytes + Buffer.byteLength(line) > CAP_BYTES_V1)
        throw journalErrorV1("updater_journal_line_refused");
      await this.checkpoint("append_before_open");
      let handle, created = false, attemptedWrite = false;
      try { handle = await openNoFollowV1(this.root, JOURNAL_PATH_V1, constants.O_WRONLY | constants.O_APPEND); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await assertNoSymlinkBelowV1(this.root, "updater-state");
        handle = await open(join(this.root, JOURNAL_PATH_V1), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
          | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        created = true;
      }
      try {
        await this.checkpoint("append_before_write"); attemptedWrite = true; await handle.writeFile(line);
        await this.checkpoint("append_before_sync"); await handle.sync();
      } catch (error) {
        // A short write (including ENOSPC) must not poison the valid history.
        // The transaction lock still excludes every other writer during rollback.
        try { if (attemptedWrite) { await handle.truncate(current.bytes); await handle.sync(); } }
        finally { if (created) await unlink(join(this.root, JOURNAL_PATH_V1)); }
        throw error;
      } finally { await handle.close(); }
      await syncDirectoryV1(this.root, JOURNAL_PATH_V1); await this.checkpoint("append_done");
      return Object.freeze({ ...entry, prevMac: current.tail, mac });
    });
  }
  intent(record) { return this.#append("intent", record); }
  done(record) { return this.#append("done", record); }
  refusal({ planId, reason, count, hour = new Date().toISOString().slice(0, 13) }) {
    if (typeof planId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/u.test(planId) || typeof reason !== "string"
        || !/^[a-z][a-z0-9_]{1,63}$/u.test(reason) || !Number.isSafeInteger(count) || count < 1)
      throw journalErrorV1("updater_journal_refusal_refused");
    return this.#append("refusal_summary", { planId, reason, count, hour });
  }
  async compact({ now = Date.now(), checkpoint = this.checkpoint } = {}) {
    return this.#serialized(async () => {
      await this.#assertNoPendingCompaction();
      const current = await this.#read(); if (current.bytes < COMPACT_AT_BYTES_V1) return { compacted: false, ...this.health(current.bytes) };
      const oldEnough = now - 30 * 24 * 60 * 60 * 1000, byRun = new Map();
      for (const item of current.entries) if (typeof item.runId === "string") {
        const row = byRun.get(item.runId) ?? { entries: [], terminal: undefined, newest: 0 };
        row.entries.push(item); row.newest = Math.max(row.newest, asDateV1(item.at));
        const state = item.state ?? item.to; if (TERMINAL_V1.has(state)) row.terminal = state; byRun.set(item.runId, row);
      }
      const removable = new Set([...byRun].filter(([, row]) => row.terminal && row.newest < oldEnough).map(([id]) => id));
      if (!removable.size) return { compacted: false, ...this.health(current.bytes) };
      const summaries = [...byRun].filter(([id]) => removable.has(id)).map(([runId, row]) => ({ runId, state: row.terminal,
        entries: row.entries.length, firstAt: row.entries[0].at, lastAt: row.entries.at(-1).at }));
      const retained = current.entries.filter(item => !removable.has(item.runId)).map(({ prevMac, mac, ...entry }) => entry);
      const blocks = [];
      for (let index = 0; index < summaries.length; index += 25) blocks.push({ schema: "control-room.updater-journal/v1", kind: "compaction_summary",
        at: new Date(now).toISOString(), runs: summaries.slice(index, index + 25) });
      const key = await this.#key(); let previous = GENESIS_MAC_V1;
      const lines = [...blocks, ...retained].map(entry => { const mac = macV1(key, previous, entry); const line = canonicalV1({ ...entry, prevMac: previous, mac }); previous = mac; return line; });
      const content = `${lines.join("\n")}\n`; if (Buffer.byteLength(content) >= current.bytes || Buffer.byteLength(content) > CAP_BYTES_V1)
        throw journalErrorV1("updater_journal_compaction_refused");
      const file = `journal.compact.${randomBytes(16).toString("hex")}`, temporary = `updater-state/${file}`;
      await checkpoint("compact_before_temp");
      await assertNoSymlinkBelowV1(this.root, "updater-state");
      const handle = await open(join(this.root, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(content); await checkpoint("compact_before_temp_sync"); await handle.sync(); } finally { await handle.close(); }
      await syncDirectoryV1(this.root, temporary); await checkpoint("compact_after_temp_sync");
      await atomicWriteNoFollowV1(this.root, COMPACTION_PATH_V1, `${canonicalV1({ schema: "control-room.journal-compaction/v1", file })}\n`);
      await checkpoint("compact_after_marker"); await rename(join(this.root, temporary), join(this.root, JOURNAL_PATH_V1)); await syncDirectoryV1(this.root, JOURNAL_PATH_V1);
      await checkpoint("compact_after_rename"); await unlink(join(this.root, COMPACTION_PATH_V1)); await syncDirectoryV1(this.root, COMPACTION_PATH_V1);
      return { compacted: true, ...this.health(Buffer.byteLength(content)) };
    });
  }
}

/** A deliberately typed DB display port. Item 15 does not issue SQL or grant
 * privileges; the database worker supplies the updater.run_events projection implementation. */
export async function reconcileJournalDisplayV1({ journal, display, rescued = false }) {
  if (rescued) return { state: "uncertain", reason: "rescue_marker" };
  let authority;
  try { authority = await journal.validate(); }
  catch (error) { return { state: "uncertain", reason: error?.code ?? "updater_journal_invalid" }; }
  const rows = await display.readJournalDisplay();
  if (!Array.isArray(rows)) throw journalErrorV1("updater_journal_display_refused");
  const file = authority.entries.map(({ prevMac, mac, ...entry }) => canonicalV1(entry));
  const mirror = rows.map(canonicalV1), common = Math.min(file.length, mirror.length);
  for (let index = 0; index < common; index += 1) if (file[index] !== mirror[index]) return { state: "uncertain", reason: "display_content_mismatch" };
  if (mirror.length > file.length) return { state: "uncertain", reason: "display_ahead" };
  if (mirror.length < file.length) { await display.refreshJournalDisplay(authority.entries.map(({ prevMac, mac, ...entry }) => entry)); return { state: "ready", refreshed: true }; }
  return { state: "ready", refreshed: false };
}

/** Bounded per-plan/hour batching. A caller flushes at its normal loop boundary;
 * no attacker supplied row is emitted directly into the authority file. */
export class RefusalAggregatorV1 {
  #buckets = new Map();
  constructor(journal, { clock = () => new Date() } = {}) { this.journal = journal; this.clock = clock; }
  add(planId, reason) {
    const hour = this.clock().toISOString().slice(0, 13), key = `${planId}\0${reason}\0${hour}`;
    this.#buckets.set(key, { planId, reason, hour, count: (this.#buckets.get(key)?.count ?? 0) + 1 });
  }
  async flush() {
    const rows = [...this.#buckets.values()]; this.#buckets.clear();
    for (const row of rows) await this.journal.refusal(row);
    return rows.length;
  }
}
