import { closeSync, lstatSync, openSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Digest } from '../../security/canonical-digest';
import { assertSynchronousFence } from '../../security/synchronous-fence';
import { localId } from '../v1/native-run-identifiers';
import { codexReadIdentityFromStartV1, codexTurnStartReceiptSchemaV1,
  verifyCodexThreadStartReceiptV1, type CodexThreadStartReceiptV1,
  type CodexTurnStartReceiptV1 } from './admission-contract';
import { assertPrivateSqliteSchemaV1 } from './private-sqlite-schema';

const threadTable = `CREATE TABLE codex_thread_start_receipts (
  run_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  admission_id TEXT NOT NULL UNIQUE,
  connection_attempt_id TEXT NOT NULL,
  enrollment_digest TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  receipt_digest TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL
)`;
const turnTable = `CREATE TABLE codex_turn_start_receipts (
  run_id TEXT PRIMARY KEY NOT NULL,
  thread_receipt_digest TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL UNIQUE,
  turn_id TEXT NOT NULL UNIQUE,
  receipt_digest TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES codex_thread_start_receipts(run_id) ON DELETE RESTRICT
)`;
const expectedColumns = {
  codex_thread_start_receipts: [
    { name: 'run_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'job_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'attempt_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'admission_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'connection_attempt_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'enrollment_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'thread_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'receipt_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'receipt_json', type: 'TEXT', notnull: 1, pk: 0 },
  ],
  codex_turn_start_receipts: [
    { name: 'run_id', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'thread_receipt_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'thread_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'turn_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'receipt_digest', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'receipt_json', type: 'TEXT', notnull: 1, pk: 0 },
  ],
} as const;

function privatePath(path: string): void {
  if (!isAbsolute(path) || !process.getuid) throw new Error('codex_start_journal_path_invalid');
  const uid = process.getuid(), parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
    throw new Error('codex_start_journal_path_invalid');
  }
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.uid !== uid || (current.mode & 0o077) !== 0) throw new Error('codex_start_journal_path_invalid');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    closeSync(openSync(path, 'wx', 0o600));
  }
}

function requireCurrent(assertCurrent: () => void): void {
  if (typeof assertCurrent !== 'function') throw new Error('codex_start_journal_authority_required');
  assertSynchronousFence(assertCurrent, () => { throw new Error('codex_start_journal_authority_must_be_synchronous'); });
}

type ThreadRow = { run_id: string; job_id: string; attempt_id: string; admission_id: string;
  connection_attempt_id: string; enrollment_digest: string; thread_id: string;
  receipt_digest: string; receipt_json: string };
type TurnRow = { run_id: string; thread_receipt_digest: string; thread_id: string; turn_id: string;
  receipt_digest: string; receipt_json: string };

/**
 * Node-private observation journal for exact Codex start receipts. It is not a
 * queue, retry ledger, resume token or read permit. Imports are inert.
 */
export class SqliteCodexStartJournalV1 {
  private readonly db: DatabaseSync;
  private usable = true;
  private closed = false;
  private readonly maximumEntries: number;

  constructor(path: string, options: { testOnlyAllowEphemeral?: boolean; maximumEntries?: number } = {}) {
    this.maximumEntries = options.maximumEntries ?? 1024;
    if (!Number.isSafeInteger(this.maximumEntries) || this.maximumEntries < 1 || this.maximumEntries > 4096) {
      throw new Error('codex_start_journal_capacity_invalid');
    }
    if (path !== ':memory:' || !options.testOnlyAllowEphemeral) privatePath(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const objects = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (version === 0 && objects.length === 0) {
        this.db.exec(`${threadTable}; ${turnTable}; PRAGMA user_version=1;`);
      } else if (version !== 1) throw new Error('codex_start_journal_schema_invalid');
      assertPrivateSqliteSchemaV1(this.db,
        ['table:codex_thread_start_receipts', 'table:codex_turn_start_receipts'], expectedColumns,
        { codex_thread_start_receipts: threadTable, codex_turn_start_receipts: turnTable });
    } catch {
      this.usable = false; this.db.close(); throw new Error('codex_start_journal_unavailable');
    }
  }

  private assertUsable() { if (!this.usable) throw new Error('codex_start_journal_unavailable'); }

  private transaction<T>(work: () => T): T {
    this.assertUsable(); this.db.exec('BEGIN IMMEDIATE');
    let committing = false;
    try { const result = work(); committing = true; this.db.exec('COMMIT'); return result; }
    catch {
      if (committing) { this.usable = false; try { this.close(); } catch { /* quarantined */ } }
      else { try { this.db.exec('ROLLBACK'); } catch { this.usable = false; } }
      throw new Error(committing ? 'codex_start_journal_commit_uncertain' : 'codex_start_journal_write_rejected');
    }
  }

  private threadRow(runId: string): ThreadRow | undefined {
    return this.db.prepare('SELECT * FROM codex_thread_start_receipts WHERE run_id=?').get(runId) as ThreadRow | undefined;
  }

  recordThread(value: unknown, assertCurrent: () => void): 'recorded' | 'duplicate' {
    const receipt = verifyCodexThreadStartReceiptV1(value), { scope } = receipt.admission;
    return this.transaction(() => {
      requireCurrent(assertCurrent);
      const existing = this.threadRow(scope.runId);
      if (existing) {
        if (existing.receipt_digest !== receipt.receiptDigest
          || existing.receipt_json !== JSON.stringify(receipt)) throw new Error('codex_start_journal_binding_conflict');
        requireCurrent(assertCurrent); return 'duplicate';
      }
      const count = (this.db.prepare('SELECT COUNT(*) AS count FROM codex_thread_start_receipts').get() as { count: number }).count;
      if (count >= this.maximumEntries) throw new Error('codex_start_journal_capacity_exhausted');
      this.db.prepare(`INSERT INTO codex_thread_start_receipts
        (run_id,job_id,attempt_id,admission_id,connection_attempt_id,enrollment_digest,thread_id,receipt_digest,receipt_json)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(scope.runId, scope.jobId, scope.attemptId, receipt.admission.admissionId,
        receipt.admission.connectionAttemptId, receipt.admission.enrollmentDigest, receipt.threadId,
        receipt.receiptDigest, JSON.stringify(receipt));
      requireCurrent(assertCurrent); return 'recorded';
    });
  }

  recordTurn(threadValue: unknown, turnValue: unknown, assertCurrent: () => void): 'recorded' | 'duplicate' {
    const thread = verifyCodexThreadStartReceiptV1(threadValue);
    const turn = codexTurnStartReceiptSchemaV1.parse(turnValue);
    const identity = codexReadIdentityFromStartV1(thread, turn);
    return this.transaction(() => {
      requireCurrent(assertCurrent);
      const parent = this.threadRow(identity.runId);
      if (!parent || parent.receipt_digest !== thread.receiptDigest
        || parent.receipt_json !== JSON.stringify(thread)) throw new Error('codex_start_journal_thread_missing');
      const existing = this.db.prepare('SELECT * FROM codex_turn_start_receipts WHERE run_id=?')
        .get(identity.runId) as TurnRow | undefined;
      if (existing) {
        if (existing.receipt_digest !== turn.receiptDigest
          || existing.receipt_json !== JSON.stringify(turn)) throw new Error('codex_start_journal_binding_conflict');
        requireCurrent(assertCurrent); return 'duplicate';
      }
      this.db.prepare(`INSERT INTO codex_turn_start_receipts
        (run_id,thread_receipt_digest,thread_id,turn_id,receipt_digest,receipt_json) VALUES(?,?,?,?,?,?)`)
        .run(identity.runId, thread.receiptDigest, identity.threadId, identity.turnId,
          turn.receiptDigest, JSON.stringify(turn));
      requireCurrent(assertCurrent); return 'recorded';
    });
  }

  load(runIdValue: string) {
    this.assertUsable(); const runId = localId.parse(runIdValue), row = this.threadRow(runId);
    if (!row) return Object.freeze({ status: 'not_recorded' as const, runId,
      readIdentity: null, grantsExecutionAuthority: false as const, permitsResume: false as const,
      permitsRetry: false as const, permitsThreadRead: false as const });
    let thread: CodexThreadStartReceiptV1;
    try { thread = verifyCodexThreadStartReceiptV1(JSON.parse(row.receipt_json)); }
    catch { return this.integrityFailure(); }
    const scope = thread.admission.scope;
    if (row.run_id !== scope.runId || row.job_id !== scope.jobId || row.attempt_id !== scope.attemptId
      || row.admission_id !== thread.admission.admissionId
      || row.connection_attempt_id !== thread.admission.connectionAttemptId
      || row.enrollment_digest !== thread.admission.enrollmentDigest || row.thread_id !== thread.threadId
      || row.receipt_digest !== thread.receiptDigest) return this.integrityFailure();
    const turnRow = this.db.prepare('SELECT * FROM codex_turn_start_receipts WHERE run_id=?').get(runId) as TurnRow | undefined;
    if (!turnRow) return Object.freeze({ status: 'turn_not_recorded' as const, ...scope,
      threadId: thread.threadId, threadReceiptDigest: thread.receiptDigest, turnId: null,
      readIdentity: null, grantsExecutionAuthority: false as const, permitsResume: false as const,
      permitsRetry: false as const, permitsThreadRead: false as const });
    let turn: CodexTurnStartReceiptV1, identity: ReturnType<typeof codexReadIdentityFromStartV1>;
    try {
      turn = codexTurnStartReceiptSchemaV1.parse(JSON.parse(turnRow.receipt_json));
      identity = codexReadIdentityFromStartV1(thread, turn);
    } catch { return this.integrityFailure(); }
    if (turnRow.run_id !== identity.runId || turnRow.thread_receipt_digest !== thread.receiptDigest
      || turnRow.thread_id !== identity.threadId || turnRow.turn_id !== identity.turnId
      || turnRow.receipt_digest !== turn.receiptDigest) return this.integrityFailure();
    return Object.freeze({ status: 'recorded' as const, ...identity, threadReceiptDigest: thread.receiptDigest,
      turnReceiptDigest: turn.receiptDigest, readIdentity: identity });
  }

  private integrityFailure(): never {
    this.usable = false; throw new Error('codex_start_journal_integrity_invalid');
  }

  close() { if (!this.closed) { this.usable = false; this.closed = true; this.db.close(); } }
}
