import { constants } from 'node:fs';
import { open, mkdir, unlink, lstat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Digest } from '../../security/digest';
import { isPaidRunAdmissionV1, PAID_RUN_CAP_CEILING_NANO_USD, type PaidRunAdmissionV1 } from './paid-run-admission';

export type PaidRunRefusalV1 = string;
export type SettleOutcome = 'completed' | 'provider_error' | 'identity_mismatch' | 'usage_unverified'
  | 'bound_violated' | 'uncertain';
export type PaidRunSettlementV1 = Readonly<{ accountedNanoUsd: string; excessNanoUsd: string;
  outcome: SettleOutcome; servedModelId: string | null }>;
export type CallState = Readonly<{ callId: string; requestDigest: string; maxNanoUsd: string;
  priceRowDigest: string; phase: 'reserved' | 'dispatched' | 'settled' | 'released'; settlement?: PaidRunSettlementV1 }>;
export type PaidRunAccountingSnapshotV1 = Readonly<{ settled: string; reserved: string; uncertain: string;
  excess: string; cap: string; blocked: string | null; stopped: boolean; spendingClosed: boolean }>;
type Refusal = { kind: 'refused'; reason: PaidRunRefusalV1 };
export interface PaidRunSettlementHandleV1 {
  readonly runKey: string; readonly pinDigest: string;
  call?: () => Promise<Refusal>;
  recordLate(callId: string, information: Readonly<{ servedModelId: string | null }>): Promise<void>;
  totals(): PaidRunAccountingSnapshotV1;
  close(): Promise<void>;
}
export interface PaidRunLedgerHandleV1 extends PaidRunSettlementHandleV1 {
  reserve(r: { callId: string; requestDigest: string; maxNanoUsd: string; priceRowDigest: string;
    check: () => void }): Promise<{ kind: 'reserved' } | { kind: 'replay'; state: CallState } | Refusal>;
  dispatch(callId: string): Promise<{ kind: 'dispatched' } | Refusal>;
  settle(callId: string, settlement: PaidRunSettlementV1): Promise<void>;
  release(callId: string): Promise<void>;
  block(reason: string): Promise<void>;
  stop(): Promise<void>;
}
export interface PaidRunLedgerV1 {
  open(admission: PaidRunAdmissionV1): Promise<PaidRunLedgerHandleV1>;
  reopenForSettlementV1(expected: Readonly<{ runKey: string; pinDigest: string }>): Promise<PaidRunSettlementHandleV1>;
}
const liveHandles = new WeakMap<object, PaidRunAdmissionV1>();
const openedAdmissions = new WeakSet<object>();
/** Runtime provenance prevents a structural counter from standing in for the durable ledger. */
export function isPaidRunLedgerHandleV1(value: unknown, admission?: PaidRunAdmissionV1): value is PaidRunLedgerHandleV1 {
  return typeof value === 'object' && value !== null && liveHandles.has(value)
    && (admission === undefined || liveHandles.get(value) === admission);
}
const refuse = (reason: string): Refusal => ({ kind: 'refused', reason });
const fail = (reason: string): never => { throw new Error(reason); };
const validRun = (key: string) => typeof key === 'string' && /^sha256:[a-f0-9]{64}$/.test(key);
const validCall = (id: string) => typeof id === 'string' && /^[A-Za-z0-9:_-]{16,100}$/.test(id);
const amount = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const readonlyFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
async function safeFile(file: FileHandle) {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || process.getuid && stat.uid !== process.getuid()) fail('journal_unsafe');
}
async function directory(path: string, create: boolean) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) fail('journal_unsafe');
  const fd = await open(path, readonlyFlags | constants.O_DIRECTORY);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function syncDirectory(path: string) {
  const fd = await open(path, readonlyFlags | constants.O_DIRECTORY);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function exclusive(path: string): Promise<FileHandle> {
  try { return await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('lease_held'); throw error; }
}
/** Caller MUST have observed the previous holder's exit. No PID probing or authority recovery. */
export async function recoverPaidRunLeaseV1(root: string, runKey: string, expectedGeneration: string): Promise<void> {
  if (!validRun(runKey) || typeof expectedGeneration !== 'string' || !expectedGeneration) fail('cross_run');
  await directory(root, false);
  const dir = join(root, runKey); await directory(dir, false);
  const gatePath = join(dir, 'opener.lock'), gate = await exclusive(gatePath);
  try {
    const lease = await open(join(dir, 'lease.json'), readonlyFlags);
    try {
      await safeFile(lease);
      const saved = JSON.parse(await lease.readFile('utf8'));
      if (saved.generation !== expectedGeneration) fail('lease_generation_mismatch');
    } finally { await lease.close(); }
    await unlink(join(dir, 'lease.json')); await syncDirectory(dir);
  } finally { await gate.close(); await unlink(gatePath); await syncDirectory(dir); }
}

type RecordV1 = { seq: number; prev: string | null; type: string; [key: string]: unknown };
type State = { head: RecordV1 | null; calls: Map<string, CallState>; cap: string; blocked: string | null;
  stopped: boolean; spendingClosed: boolean; opening?: RecordV1 };
function totals(state: State): PaidRunAccountingSnapshotV1 {
  let settled = BigInt(0), reserved = BigInt(0), uncertain = BigInt(0), excess = BigInt(0);
  for (const call of state.calls.values()) {
    if (call.phase === 'reserved' || call.phase === 'dispatched') reserved += BigInt(call.maxNanoUsd);
    if (call.settlement) {
      if (call.settlement.outcome === 'uncertain') uncertain += BigInt(call.settlement.accountedNanoUsd);
      else settled += BigInt(call.settlement.accountedNanoUsd);
      excess += BigInt(call.settlement.excessNanoUsd);
    }
  }
  return Object.freeze({ settled: String(settled), reserved: String(reserved), uncertain: String(uncertain),
    excess: String(excess), cap: state.cap, blocked: state.blocked, stopped: state.stopped, spendingClosed: state.spendingClosed });
}
function spendingRefusal(state: State): string | null {
  return state.spendingClosed ? 'run_recovered_closed' : state.stopped ? 'run_stopped' : state.blocked ? 'run_blocked' : null;
}
function apply(state: State, r: RecordV1) {
  if (r.seq !== (state.head?.seq ?? 0) + 1 || r.prev !== (state.head ? sha256Digest(state.head) : null)) fail('journal_corrupt');
  const id = r.callId as string, call = state.calls.get(id);
  switch (r.type) {
    case 'open': {
      const pin = r.pin as PaidRunAdmissionV1['pin'];
      if (state.head || !validRun(r.runKey as string) || !pin || sha256Digest(pin) !== r.pinDigest
        || !amount(r.cap) || r.cap !== pin.capNanoUsd || BigInt(r.cap) < BigInt(1)
        || BigInt(r.cap) > BigInt(PAID_RUN_CAP_CEILING_NANO_USD) || typeof r.consentId !== 'string') fail('journal_corrupt');
      state.opening = r; state.cap = r.cap as string; break;
    }
    case 'reserve': {
      if (!state.opening || spendingRefusal(state) || !validCall(id) || call
        || !validRun(r.requestDigest as string) || !validRun(r.priceRowDigest as string) || !amount(r.maxNanoUsd)
        || r.priceRowDigest !== (state.opening.pin as PaidRunAdmissionV1['pin']).priceRowDigest) fail('journal_corrupt');
      const t = totals(state);
      if (BigInt(t.settled) + BigInt(t.uncertain) + BigInt(t.reserved) + BigInt(r.maxNanoUsd as string) > BigInt(t.cap)) fail('journal_corrupt');
      state.calls.set(id, Object.freeze({ callId: id, requestDigest: r.requestDigest as string,
        maxNanoUsd: r.maxNanoUsd as string, priceRowDigest: r.priceRowDigest as string, phase: 'reserved' })); break;
    }
    case 'dispatch':
      if (spendingRefusal(state) || call?.phase !== 'reserved') fail('journal_corrupt');
      state.calls.set(id, Object.freeze({ ...call!, phase: 'dispatched' })); break;
    case 'release':
      if (call?.phase !== 'reserved') fail('journal_corrupt');
      state.calls.set(id, Object.freeze({ ...call!, phase: 'released' })); break;
    case 'settle': {
      const s = r.settlement as PaidRunSettlementV1;
      if (call?.phase !== 'dispatched' || !s || !amount(s.accountedNanoUsd) || !amount(s.excessNanoUsd)
        || BigInt(s.accountedNanoUsd) > BigInt(call.maxNanoUsd)
        || !['completed', 'provider_error', 'identity_mismatch', 'usage_unverified', 'bound_violated', 'uncertain'].includes(s.outcome)
        || s.servedModelId !== null && typeof s.servedModelId !== 'string'
        || s.outcome !== 'completed' && s.accountedNanoUsd !== call.maxNanoUsd
        || s.outcome !== 'bound_violated' && s.excessNanoUsd !== '0') fail('journal_corrupt');
      state.calls.set(id, Object.freeze({ ...call!, phase: 'settled', settlement: Object.freeze({ ...s }) })); break;
    }
    case 'late': if (!call?.settlement || r.servedModelId !== null && typeof r.servedModelId !== 'string') fail('journal_corrupt'); break;
    case 'block': if (typeof r.reason !== 'string' || !r.reason) fail('journal_corrupt'); state.blocked = r.reason as string; break;
    case 'stop': state.stopped = true; break;
    case 'recovered': state.spendingClosed = true; state.blocked ??= 'recovered'; break;
    default: fail('journal_corrupt');
  }
  state.head = r;
}

export function createPaidRunJournalLedgerV1(options: Readonly<{ root: string; afterReserve?: (callId: string) => Promise<void> }>): PaidRunLedgerV1 {
  const root = options.root;
  async function acquire(expected: { runKey: string; pinDigest: string }, admission?: PaidRunAdmissionV1) {
    if (!validRun(expected.runKey) || !validRun(expected.pinDigest)) fail('cross_run');
    await directory(root, !!admission);
    const dir = join(root, expected.runKey); await directory(dir, !!admission);
    const gatePath = join(dir, 'opener.lock'), gate = await exclusive(gatePath);
    let file: FileHandle | undefined, lease: FileHandle | undefined, ownLease = false;
    const state: State = { head: null, calls: new Map(), cap: '0', blocked: null, stopped: false, spendingClosed: false };
    const leasePath = join(dir, 'lease.json');
    try {
      lease = await exclusive(leasePath); ownLease = true;
      await lease.writeFile(canonicalJson({ generation: randomUUID(), pid: process.pid }) + '\n');
      await lease.sync(); await lease.close(); lease = undefined; await syncDirectory(dir);
      let tornTail = false;
      if (admission) {
        // Initial spending can only create a new journal. Existing journals are recovery-only.
        try { file = await open(join(dir, 'journal.jsonl'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
          | constants.O_APPEND | constants.O_NOFOLLOW, 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await open(join(dir, 'journal.jsonl'), readonlyFlags);
          try {
            await safeFile(existing);
            const rows = (await existing.readFile('utf8')).split('\n');
            if (rows.pop() !== '') fail('journal_corrupt');
            for (const row of rows) {
              let r: RecordV1;
              try { r = JSON.parse(row); } catch { fail('journal_corrupt'); }
              try { if (canonicalJson(r!) !== row) fail('journal_corrupt'); apply(state, r!); }
              catch { fail('journal_corrupt'); }
            }
            if (!state.opening) fail('journal_corrupt');
            if (state.opening!.runKey !== admission.runKey || state.opening!.pinDigest !== admission.pinDigest
              || state.opening!.consentId !== admission.consentId) fail('cross_run');
            fail('run_recovered_closed');
          } finally { await existing.close(); }
         }
      } else {
        file = await open(join(dir, 'journal.jsonl'), constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        await safeFile(file);
        const buffer = await file.readFile();
        // Only a non-committed final record is repairable. Chain/semantic defects never are.
        const lastNewline = buffer.lastIndexOf(10);
        let goodBytes = lastNewline + 1;
        tornTail = goodBytes !== buffer.length;
        const lines = buffer.subarray(0, goodBytes).toString('utf8').split('\n'); lines.pop();
        for (let i = 0; i < lines.length; i++) {
          let record: RecordV1;
          try { record = JSON.parse(lines[i]!); }
          catch { if (i !== lines.length - 1) fail('journal_corrupt');
            goodBytes -= Buffer.byteLength(lines[i]!) + 1; tornTail = true; break; }
          try { if (canonicalJson(record) !== lines[i]) fail('journal_corrupt'); apply(state, record!); }
          catch { fail('journal_corrupt'); }
        }
        if (!state.opening) fail('journal_corrupt');
        if (state.opening!.runKey !== expected.runKey || state.opening!.pinDigest !== expected.pinDigest) fail('cross_run');
        if (tornTail) { await file.truncate(goodBytes); await file.sync(); }
      }
      await safeFile(file!); await syncDirectory(dir);
      let queue: Promise<unknown> = Promise.resolve(), closed = false, poisoned = false;
      const serial = <T>(fn: () => Promise<T>): Promise<T> => {
        const next = queue.then(() => { if (closed) fail('ledger_closed'); if (poisoned) fail('journal_io_failed'); return fn(); });
        queue = next.catch(() => {}); return next;
      };
      async function append(fields: { type: string; [key: string]: unknown }) {
        const r: RecordV1 = { ...fields, seq: (state.head?.seq ?? 0) + 1, prev: state.head ? sha256Digest(state.head) : null };
        // Validate a tentative replay before touching storage; publish state only after fsync.
        const next: State = { ...state, calls: new Map(state.calls) }; apply(next, r);
        const bytes = Buffer.from(canonicalJson(r) + '\n');
        try {
          const written = await file!.write(bytes);
          if (written.bytesWritten !== bytes.length) fail('journal_io_failed');
          await file!.sync();
        } catch (error) { poisoned = true; throw error; }
        Object.assign(state, next);
      }
      if (admission) await append({ type: 'open', runKey: admission.runKey, pin: admission.pin,
        pinDigest: admission.pinDigest, consentId: admission.consentId, cap: admission.pin.capNanoUsd });
      else {
        // Closing first makes interruption of recovery fail closed on the next replay too.
        await append({ type: 'recovered', tornTail });
        for (const call of state.calls.values()) {
          if (call.phase === 'reserved') await append({ type: 'release', callId: call.callId });
          if (call.phase === 'dispatched') await append({ type: 'settle', callId: call.callId,
            settlement: { accountedNanoUsd: call.maxNanoUsd, excessNanoUsd: '0', outcome: 'uncertain', servedModelId: null } });
        }
        if ([...state.calls.values()].some(call => call.settlement?.outcome === 'uncertain'))
          await append({ type: 'block', reason: 'recovered_uncertain' });
      }
      const settlement: PaidRunSettlementHandleV1 = {
        runKey: expected.runKey, pinDigest: expected.pinDigest,
        totals: () => totals(state),
        recordLate: (callId, information) => {
          const servedModelId = information.servedModelId;
          return serial(() => append({ type: 'late', callId, servedModelId }));
        },
        close: () => {
          const next = queue.then(async () => {
            if (closed) return; closed = true;
            await file!.close(); await unlink(leasePath); await syncDirectory(dir);
          }); queue = next.catch(() => {}); return next;
        },
      };
      if (!admission) return Object.freeze({ ...settlement, call: async () => refuse('run_recovered_closed') });
      const handle: PaidRunLedgerHandleV1 = {
        ...settlement,
        reserve: r => {
          const { callId, requestDigest, maxNanoUsd, priceRowDigest, check } = r;
          return serial(async () => {
            const reason = spendingRefusal(state); if (reason) return refuse(reason);
            const previous = state.calls.get(callId);
            if (previous) return previous.requestDigest === requestDigest
              ? { kind: 'replay' as const, state: previous } : refuse('call_conflict');
            try { check(); } catch { await append({ type: 'block', reason: 'config_changed' }); return refuse('config_changed'); }
            if (!validCall(callId) || !validRun(requestDigest) || !amount(maxNanoUsd)
              || priceRowDigest !== admission.pin.priceRowDigest) return refuse('invalid_reservation');
            const t = totals(state);
            if (BigInt(t.settled) + BigInt(t.uncertain) + BigInt(t.reserved) + BigInt(maxNanoUsd) > BigInt(t.cap)) return refuse('cap_exhausted');
            await append({ type: 'reserve', callId, requestDigest, maxNanoUsd, priceRowDigest });
            return { kind: 'reserved' as const };
          }).then(async result => {
            if (result.kind === 'reserved') await options.afterReserve?.(callId);
            return result;
          });
        },
        dispatch: callId => serial(async () => {
          const reason = spendingRefusal(state), call = state.calls.get(callId);
          if (reason) {
            if (call?.phase === 'reserved') await append({ type: 'release', callId });
            return refuse(reason);
          }
          if (call?.phase !== 'reserved') return refuse('call_conflict');
          await append({ type: 'dispatch', callId }); return { kind: 'dispatched' as const };
        }),
        settle: (callId, s) => {
          const copy = { ...s };
          return serial(async () => {
            if (state.calls.get(callId)?.settlement) { await append({ type: 'late', callId, servedModelId: copy.servedModelId }); return; }
            await append({ type: 'settle', callId, settlement: copy });
          });
        },
        release: callId => serial(async () => { if (state.calls.get(callId)?.phase === 'reserved') await append({ type: 'release', callId }); }),
        block: reason => serial(() => append({ type: 'block', reason })),
        stop: () => serial(async () => {
          await append({ type: 'stop' });
          for (const call of state.calls.values()) if (call.phase === 'reserved') await append({ type: 'release', callId: call.callId });
        }),
      };
      liveHandles.set(handle, admission); return Object.freeze(handle);
    } catch (error) {
      await file?.close(); await lease?.close();
      if (ownLease) { await unlink(leasePath); await syncDirectory(dir); }
      throw error;
    } finally { await gate.close(); await unlink(gatePath); await syncDirectory(dir); }
  }
  return Object.freeze({
    async open(admission: PaidRunAdmissionV1) {
      if (!isPaidRunAdmissionV1(admission)) fail('admission_forged');
      if (openedAdmissions.has(admission)) fail('admission_replayed');
      openedAdmissions.add(admission);
      return await acquire(admission, admission) as PaidRunLedgerHandleV1;
    },
    async reopenForSettlementV1(expected: Readonly<{ runKey: string; pinDigest: string }>) {
      return acquire({ runKey: expected.runKey, pinDigest: expected.pinDigest });
    },
  });
}
