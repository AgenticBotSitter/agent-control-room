import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Digest } from "../../security/canonical-digest";
import { bindingSchema, localId, snapshotSchema, terminalNativeState, NativeJournalVersionConflict,
  type NativeBinding, type NativeRunJournal, type NativeSnapshot } from "./contracts";
import { nativeReportedTransitions as transitions } from "../v1/native-observation";

const schema = `CREATE TABLE hermes_native_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  claim_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK(version > 0),
  snapshot TEXT NOT NULL
)`;
const normalizeSql = (value: string) => value.replace(/\s+/g, " ").trim();
function privatePath(path: string): void {
  if (!isAbsolute(path) || !process.getuid) throw new Error("native_journal_path_invalid");
  const uid = process.getuid(), parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) throw new Error("native_journal_path_invalid");
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== uid || (current.mode & 0o077) !== 0) {
      throw new Error("native_journal_path_invalid");
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    closeSync(openSync(path, "wx", 0o600));
  }
}
function validateUpdate(before: NativeSnapshot, after: NativeSnapshot): void {
  if (after.state !== before.state && !transitions[before.state].includes(after.state)) throw new Error("native_state_transition_invalid");
  if (after.observedAt < before.observedAt || (before.upstreamUpdatedAt !== null &&
    (after.upstreamUpdatedAt === null || after.upstreamUpdatedAt < before.upstreamUpdatedAt))
    || (before.nativeRunId !== null && after.nativeRunId !== before.nativeRunId)
    || (before.streamAttempted && !after.streamAttempted) || (before.stopAttempted && !after.stopAttempted)) {
    throw new Error("native_journal_regression");
  }
  if ((after.resultText !== null && after.state !== "completed") ||
    (after.nativeRunId === null && (after.streamAttempted || after.stopAttempted ||
      !["prepared", "dispatching", "ambiguous", "failed"].includes(after.state)))) throw new Error("native_journal_inconsistent");
  if (terminalNativeState(before.state) && (after.resultText !== before.resultText || sha256Digest(after.usage) !== sha256Digest(before.usage))) {
    throw new Error("native_terminal_result_changed");
  }
}

/** This is a node-private execution/recovery journal, never a global job queue. No prompt, bearer token
 * or raw provider error is saved. Bounded final output is private project data, not public evidence.
 * Construction opens only an explicitly supplied private file; imports are inert. No pruning/replay API.
 */
export class SqliteNativeRunJournal implements NativeRunJournal {
  private readonly db: DatabaseSync;
  private usable = true;
  private closed = false;
  private readonly maximumEntries: number;
  constructor(path: string, options: { testOnlyAllowEphemeral?: boolean; maximumEntries?: number } = {}) {
    this.maximumEntries = options.maximumEntries ?? 1024;
    if (!Number.isSafeInteger(this.maximumEntries) || this.maximumEntries < 1 || this.maximumEntries > 4096) throw new Error("native_journal_capacity_invalid");
    if (path !== ":memory:" || !options.testOnlyAllowEphemeral) privatePath(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1) throw new Error("native_journal_schema_invalid");
      const objects = this.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL").all() as { type: string; name: string; sql: string }[];
      if (version === 0 && objects.length === 0) this.db.exec(`${schema}; PRAGMA user_version=1;`);
      else if (version !== 1 || objects.length !== 1 || objects[0].type !== "table" || objects[0].name !== "hermes_native_runs"
        || normalizeSql(objects[0].sql) !== normalizeSql(schema)) throw new Error("native_journal_schema_invalid");
    } catch { this.usable = false; this.db.close(); throw new Error("native_journal_unavailable"); }
  }
  private assertUsable() { if (!this.usable) throw new Error("native_journal_unavailable"); }
  load(runId: string): NativeSnapshot | undefined {
    this.assertUsable(); localId.parse(runId);
    const row = this.db.prepare("SELECT run_id,attempt_id,claim_key,version,snapshot FROM hermes_native_runs WHERE run_id=?").get(runId) as
      { run_id: string; attempt_id: string; claim_key: string; version: number; snapshot: string } | undefined;
    if (!row) return undefined;
    const parsed = snapshotSchema.parse(JSON.parse(row.snapshot));
    if (parsed.binding.runId !== row.run_id || parsed.binding.attemptId !== row.attempt_id || parsed.binding.effectClaimKey !== row.claim_key || parsed.version !== row.version) {
      this.usable = false; throw new Error("native_journal_integrity_invalid");
    }
    return parsed;
  }
  /** Bounded node-private restart inventory. No result text or execution authority.
   * Enumerate every row before interpreting scope; indexes must not hide work. */
  inventory() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT run_id FROM hermes_native_runs ORDER BY run_id LIMIT ?")
        .all(this.maximumEntries + 1) as { run_id: string }[];
      if (rows.length > this.maximumEntries) throw new Error("native_journal_capacity_exhausted");
      return rows.map(row => {
        const snapshot = this.load(row.run_id); if (!snapshot) throw new Error("native_journal_integrity_invalid");
        return { binding: snapshot.binding, state: snapshot.state, snapshotDigest: sha256Digest(snapshot) };
      });
    });
  }
  private transaction<T>(work: () => T): T {
    this.assertUsable(); this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try { const result = work(); committing = true; this.db.exec("COMMIT"); return result; }
    catch (error) {
      if (committing) { this.usable = false; try { this.close(); } catch { /* Quarantined regardless of close outcome. */ } }
      else { try { this.db.exec("ROLLBACK"); } catch { this.usable = false; } }
      if (!committing && this.usable && error instanceof NativeJournalVersionConflict) throw error;
      throw new Error(committing ? "native_journal_commit_uncertain" : "native_journal_write_rejected");
    }
  }
  reserve(value: NativeBinding, now: number) {
    const binding = bindingSchema.parse(value);
    return this.transaction(() => {
      const existing = this.load(binding.runId);
      if (existing) {
        if (sha256Digest(existing.binding) !== sha256Digest(binding)) throw new Error("native_binding_conflict");
        return { created: false, snapshot: existing };
      }
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM hermes_native_runs").get() as { count: number }).count;
      if (count >= this.maximumEntries) throw new Error("native_journal_capacity_exhausted");
      const snapshot = snapshotSchema.parse({ binding, version: 1, state: "prepared", nativeRunId: null, observedAt: now,
        upstreamUpdatedAt: null, availability: "unknown", streamAttempted: false, stopAttempted: false, resultText: null,
        usage: null, lastActivity: "none", safeReason: "none" });
      this.db.prepare("INSERT INTO hermes_native_runs(run_id,attempt_id,claim_key,version,snapshot) VALUES(?,?,?,?,?)")
        .run(binding.runId, binding.attemptId, binding.effectClaimKey, 1, JSON.stringify(snapshot));
      return { created: true, snapshot };
    });
  }
  update(runId: string, version: number, patch: Partial<Omit<NativeSnapshot, "binding" | "version">>) {
    return this.transaction(() => {
      const before = this.load(runId);
      if (!before || "binding" in patch || "version" in patch) throw new Error("native_journal_write_rejected");
      if (before.version !== version) throw new NativeJournalVersionConflict();
      const after = snapshotSchema.parse({ ...before, ...patch, version: version + 1 });
      validateUpdate(before, after);
      const result = this.db.prepare("UPDATE hermes_native_runs SET version=?,snapshot=? WHERE run_id=? AND version=?")
        .run(after.version, JSON.stringify(after), runId, version);
      if (result.changes !== 1) throw new NativeJournalVersionConflict();
      return after;
    });
  }
  close() { if (!this.closed) { this.usable = false; this.closed = true; this.db.close(); } }
}
