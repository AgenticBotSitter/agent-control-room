import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, rm, unlink } from "node:fs/promises";
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
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => {});
    return next;
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
      const relativeTemp = `${KEY_PATH_V1}.new`;
      await assertNoSymlinkBelowV1(this.root, "updater-state");
      const handle = await open(join(this.root, relativeTemp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(`${randomBytes(32).toString("hex")}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await chmod(join(this.root, relativeTemp), 0o600);
      await rename(join(this.root, relativeTemp), join(this.root, KEY_PATH_V1));
      await syncDirectoryV1(this.root, KEY_PATH_V1);
      return this.#key();
    }
  }
  async #read({ missingOk = true, relativePath = JOURNAL_PATH_V1 } = {}) {
    await this.#assertOwned(relativePath, { allowMissing: missingOk });
    let text;
    try { text = await readFileNoFollowV1(this.root, relativePath, { maxBytes: CAP_BYTES_V1 + MAX_LINE_BYTES_V1 }); }
    catch (error) { if (missingOk && error?.code === "ENOENT") return { entries: [], tail: GENESIS_MAC_V1, bytes: 0 }; throw error; }
    if (!text.endsWith("\n")) throw journalErrorV1("updater_journal_short");
    const key = await this.#key(); let previous = GENESIS_MAC_V1; const entries = [], seenOrdinals = new Map();
    for (const line of text.slice(0, -1).split("\n")) {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES_V1) throw journalErrorV1("updater_journal_line_refused");
      let parsed; try { parsed = JSON.parse(line); } catch { throw journalErrorV1("updater_journal_short"); }
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
    return { entries: Object.freeze(entries), tail: previous, bytes: Buffer.byteLength(text) };
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
  async quarantineCorrupt() {
    return this.#serialized(async () => {
      try { await this.#read({ missingOk: false }); return false; }
      catch (error) {
        if (!['updater_journal_short', 'updater_journal_line_refused', 'updater_journal_mac_refused',
          'updater_journal_canonical_refused'].includes(error?.code)) throw error;
      }
      await this.#assertOwned(JOURNAL_PATH_V1, { allowMissing: false });
      const poisoned = `${JOURNAL_PATH_V1}.poisoned-${Date.now()}-${randomBytes(8).toString("hex")}`;
      await rename(join(this.root, JOURNAL_PATH_V1), join(this.root, poisoned));
      await syncDirectoryV1(this.root, JOURNAL_PATH_V1);
      return true;
    });
  }
  health(bytes) { return Object.freeze({ alert: bytes >= ALERT_AT_BYTES_V1, cap: bytes >= CAP_BYTES_V1 }); }
  async #append(kind, record) {
    return this.#serialized(async () => {
      const current = await this.#read(); if (current.bytes >= CAP_BYTES_V1) throw journalErrorV1("updater_journal_cap_refused");
      const key = await this.#key();
      const entry = { schema: "control-room.updater-journal/v1", kind, at: new Date().toISOString(), ...record };
      asDateV1(entry.at);
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
        if (created && !attemptedWrite) await unlink(join(this.root, JOURNAL_PATH_V1)).catch(() => {});
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
 * privileges; Marvin supplies the updater.run_events projection implementation. */
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
