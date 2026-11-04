import { createHash } from 'node:crypto';
import { sha256Digest } from '../../security/digest';
import { providerPriceDigestV1, type ProviderPriceV1 } from '../../web/v1/loop-provider-prices';
import { isPaidRunAdmissionV1, type PaidRunAdmissionV1 } from './paid-run-admission';
import { assertBoundableProfileV1, paidCallBoundV1, paidUsageWithinBoundV1,
  type PaidRunProviderProfileV1, type PaidRunBoundV1 } from './paid-run-bound';
import { isPaidRunLedgerHandleV1, type PaidRunLedgerHandleV1, type PaidRunAccountingSnapshotV1,
  type PaidRunSettlementV1, type SettleOutcome, type CallState } from './paid-run-ledger';
import { costForUsageV1, usageMeasurementSchemaV1 } from './usage-cost';
export type { PaidRunRefusalV1, PaidRunAccountingSnapshotV1 } from './paid-run-ledger';
export type PaidRunReportedUsageV1 = { inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens: number | null; reasoningTokens?: number | null };
export type PaidRunStreamEventV1 = { kind: 'data'; body: Uint8Array }
  | { kind: 'final'; servedModelId: string | null; usage: PaidRunReportedUsageV1 | null };
export type PaidRunTransportResponseV1 =
  | { kind: 'completed'; status: number; servedModelId: string | null; usage: PaidRunReportedUsageV1 | null; body: Uint8Array }
  | { kind: 'stream'; status: number; events: AsyncIterable<PaidRunStreamEventV1> };
export interface PaidRunTransportV1 {
  send(request: Readonly<{ callId: string; body: Uint8Array; servedModelId: string; maxOutputTokens: number;
    stream: boolean }>, signal: AbortSignal): Promise<PaidRunTransportResponseV1>;
}
export type PaidRunCurrentConfigV1 = Readonly<{ providerVersion: number; servedModelId: string;
  billingKind: 'token' | 'subscription'; priceRows: readonly ProviderPriceV1[] }>;
export type PaidRunCallResultV1 = Readonly<{ kind: 'refused'; reason: string }>
  | Readonly<{ kind: 'settled'; settlement: PaidRunSettlementV1 }>
  | Readonly<{ kind: 'replay'; state: CallState }>;
export type PaidRunStopAckV1 = Readonly<{ stopped: true; inFlightAtStop: string[]; settled: string[];
  uncertain: string[]; totals: PaidRunAccountingSnapshotV1 }>;
export interface PaidRunExecutorV1 {
  call(input: Readonly<{ callId: string; body: Uint8Array; maxOutputTokens: number; stream?: boolean }>): Promise<PaidRunCallResultV1>;
  stop(reason: 'owner_stop' | 'run_ended'): Promise<PaidRunStopAckV1>;
  snapshot(): PaidRunAccountingSnapshotV1;
}
const boundLedgers = new WeakSet<object>();
const refused = (reason: string): PaidRunCallResultV1 => ({ kind: 'refused', reason });
export function createPaidRunExecutorV1(deps: Readonly<{
  admission: PaidRunAdmissionV1; ledger: PaidRunLedgerHandleV1; transport: PaidRunTransportV1;
  currentConfig: () => Promise<PaidRunCurrentConfigV1>; profile: PaidRunProviderProfileV1; clock: () => number;
}>): PaidRunExecutorV1 {
  const { admission, ledger, transport, currentConfig, clock } = deps;
  if (ledger?.totals().spendingClosed) throw new Error('run_recovered_closed');
  if (!isPaidRunAdmissionV1(admission)) throw new Error('admission_forged');
  if (!isPaidRunLedgerHandleV1(ledger)) throw new Error('ledger_forged');
  if (!isPaidRunLedgerHandleV1(ledger, admission)) throw new Error('cross_run');
  if (boundLedgers.has(ledger)) throw new Error('executor_already_bound');
  boundLedgers.add(ledger);
  if (ledger.runKey !== admission.runKey || ledger.pinDigest !== admission.pinDigest) throw new Error('cross_run');
  const profile = Object.freeze({ ...deps.profile, extraBillableCategories: Object.freeze(Array.isArray(deps.profile?.extraBillableCategories) ? [...deps.profile.extraBillableCategories] : ['unbounded']) }) as PaidRunProviderProfileV1;
  const stopController = new AbortController();
  const inFlight = new Map<string, Promise<PaidRunSettlementV1>>();
  const terminal = new Map<string, PaidRunSettlementV1>();
  let active = 0, stopPromise: Promise<PaidRunStopAckV1> | undefined;
  function entryRefusal() {
    const t = ledger.totals();
    return t.spendingClosed ? 'run_recovered_closed' : t.stopped ? 'run_stopped' : t.blocked ? 'run_blocked' : null;
  }
  function validate(config: PaidRunCurrentConfigV1, now: number): string | null {
    if (!config || !Array.isArray(config.priceRows) || config.providerVersion !== admission.pin.providerVersion
      || config.servedModelId !== admission.pin.servedModelId || config.billingKind !== 'token') return 'config_changed';
    const rows = config.priceRows.filter(row => row.providerId === admission.pin.providerId && row.model === admission.pin.servedModelId);
    if (sha256Digest(rows.map(providerPriceDigestV1).sort()) !== admission.pin.priceRowDigest) return 'config_changed';
    if (!Number.isSafeInteger(now) || rows.some(row => {
      const at = Date.parse(row.checkedAt); return !Number.isFinite(at) || at > now || now - at > 86_400_000;
    })) return 'price_stale';
    return null;
  }
  function evaluate(status: number, servedModelId: string | null, usage: PaidRunReportedUsageV1 | null,
    bound: PaidRunBoundV1, t0: number, missingFinal = false): PaidRunSettlementV1 {
    const max = (outcome: SettleOutcome): PaidRunSettlementV1 => ({ accountedNanoUsd: bound.maxNanoUsd,
      excessNanoUsd: '0', outcome, servedModelId });
    if (missingFinal) return max('usage_unverified');
    if (servedModelId !== admission.pin.servedModelId) return max('identity_mismatch');
    if (!Number.isInteger(status) || status < 100 || status > 599) return max('usage_unverified');
    if (status < 200 || status >= 300) return max('provider_error');
    if (!usage || usage.inputTokens === null || usage.outputTokens === null || usage.cachedInputTokens == null
      || usage.reasoningTokens !== undefined && usage.reasoningTokens !== null && usage.reasoningTokens !== 0) return max('usage_unverified');
    const mapped = usageMeasurementSchemaV1.safeParse({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens, totalTokens: null, wallTimeMs: null });
    if (!mapped.success) return max('usage_unverified');
    const harness = profile.cacheReporting === 'subset' ? 'codex' as const : 'other' as const;
    const actual = costForUsageV1({ harness, model: servedModelId, usage: mapped.data,
      priceTable: { schema: 'control-room.usage-price-table/v1', tableId: 'paid-run-bound', recordedAt: new Date(t0).toISOString(),
        entries: [{ entryId: 'paid-run-entry', harness, model: servedModelId, billing: { kind: 'token',
          inputNanoUsdPerToken: bound.inRateMax, outputNanoUsdPerToken: bound.outRateMax, cachedInputNanoUsdPerToken: bound.inRateMax } }] } });
    // Subset-invalid cache counts make the pricing helper unknown; ceilings still take precedence.
    if (!paidUsageWithinBoundV1(profile, bound, { inputTokens: usage.inputTokens!, cachedInputTokens: usage.cachedInputTokens!, outputTokens: usage.outputTokens! })) {
      const excess = actual.kind === 'known' && BigInt(actual.nanoUsd) > BigInt(bound.maxNanoUsd)
        ? String(BigInt(actual.nanoUsd) - BigInt(bound.maxNanoUsd)) : '0';
      return { ...max('bound_violated'), excessNanoUsd: excess };
    }
    if (actual.kind !== 'known') return max('usage_unverified');
    return { accountedNanoUsd: actual.nanoUsd, excessNanoUsd: '0', outcome: 'completed', servedModelId };
  }
  async function execute(request: { callId: string; body: Uint8Array; maxOutputTokens: number; stream: boolean }, bound: PaidRunBoundV1, t0: number) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    stopController.signal.addEventListener('abort', abort, { once: true });
    if (stopController.signal.aborted || clock() >= t0 + profile.maxCallMs) abort();
    const timer = setTimeout(abort, Math.max(0, t0 + profile.maxCallMs - clock()));
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error('call_aborted'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    let response: Promise<{ status: number; servedModelId: string | null; usage: PaidRunReportedUsageV1 | null; missingFinal?: boolean }> | undefined;
    let result: PaidRunSettlementV1;
    try {
      response = (async () => {
        if (controller.signal.aborted) throw new Error('call_aborted');
        const r = await transport.send({ ...request, servedModelId: admission.pin.servedModelId }, controller.signal);
        if (r.kind === 'completed') return r;
        let final: { servedModelId: string | null; usage: PaidRunReportedUsageV1 | null } = { servedModelId: null, usage: null };
        let finalSeen = false;
        for await (const event of r.events) {
          if (event.kind === 'final' && !finalSeen) { finalSeen = true; final = event; }
          else if (finalSeen) return { status: r.status, servedModelId: final.servedModelId, usage: null };
        }
        // Missing final identity/usage cannot prove a bill, even if data chunks arrived.
        return { status: r.status, ...final, missingFinal: !finalSeen };
      })();
      const r = await Promise.race([response, aborted]);
      result = evaluate(r.status, r.servedModelId, r.usage, bound, t0, r.missingFinal);
    } catch {
      result = { accountedNanoUsd: bound.maxNanoUsd, excessNanoUsd: '0', outcome: 'uncertain', servedModelId: null };
    } finally {
      clearTimeout(timer); stopController.signal.removeEventListener('abort', abort);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
    // Block before freeing balance: queued reservations must never pass a known violation.
    if (['identity_mismatch', 'usage_unverified', 'bound_violated'].includes(result.outcome)) await ledger.block(result.outcome);
    await ledger.settle(request.callId, result);
    terminal.set(request.callId, result);
    if (result.outcome === 'uncertain') void response?.then(r => ledger.recordLate(request.callId, { servedModelId: r.servedModelId })).catch(() => {});
    return result;
  }
  return Object.freeze({
    snapshot: () => ledger.totals(),
    call(input: Parameters<PaidRunExecutorV1['call']>[0]): Promise<PaidRunCallResultV1> {
      // No await before scalar and byte snapshot; no later reads from caller input.
      const reason = entryRefusal(); if (reason) return Promise.resolve(refused(reason));
      const shape = assertBoundableProfileV1(profile); if (shape.kind === 'refused') return Promise.resolve(shape);
      const callId = input?.callId, maxOutputTokens = input?.maxOutputTokens, stream = input?.stream ?? false, body = input?.body;
      if (typeof callId !== 'string' || !/^[A-Za-z0-9:_-]{16,100}$/.test(callId)) return Promise.resolve(refused('invalid_call_id'));
      if (typeof stream !== 'boolean') return Promise.resolve(refused('stream_unbounded'));
      if (!(body instanceof Uint8Array) || body.buffer instanceof SharedArrayBuffer || body.byteLength > profile.maxBodyBytes)
        return Promise.resolve(refused('input_unbounded'));
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > profile.maxOutputTokensCeiling)
        return Promise.resolve(refused('output_unbounded'));
      if (stream && !profile.streamUsageInFinalEvent) return Promise.resolve(refused('stream_unbounded'));
      const privateBody = Uint8Array.from(body);
      const requestDigest = sha256Digest({ schemaVersion: 1,
        bodyDigest: `sha256:${createHash('sha256').update(privateBody).digest('hex')}`, maxOutputTokens, stream });
      return (async () => {
        let config: PaidRunCurrentConfigV1;
        try { config = structuredClone(await currentConfig()); }
        catch { await ledger.block('config_changed'); return refused('config_changed'); }
        const t0 = clock();
        let invalid: string | null;
        try { invalid = validate(config, t0); } catch { invalid = 'config_changed'; }
        if (invalid) { await ledger.block(invalid); return refused(invalid); }
        const bound = paidCallBoundV1({ profile, body: privateBody, maxOutputTokens, stream,
          providerId: admission.pin.providerId, servedModelId: admission.pin.servedModelId, prices: config.priceRows, now: t0 });
        if (bound.kind === 'refused') return bound;
        const reserved = await ledger.reserve({ callId, requestDigest, maxNanoUsd: bound.maxNanoUsd,
          priceRowDigest: admission.pin.priceRowDigest,
          check: () => { if (validate(config, clock())) throw new Error('config_changed'); } });
        if (reserved.kind !== 'reserved') return reserved;
        if (active >= profile.maxConcurrent) { await ledger.release(callId); return refused('concurrency_limit'); }
        active++;
        try {
          if (clock() >= t0 + profile.maxCallMs) { await ledger.release(callId); return refused('call_deadline'); }
          const dispatched = await ledger.dispatch(callId); if (dispatched.kind === 'refused') return dispatched;
          const pending = execute({ callId, body: privateBody, maxOutputTokens, stream }, bound, t0);
          inFlight.set(callId, pending);
          try { return { kind: 'settled' as const, settlement: await pending }; }
          finally { inFlight.delete(callId); }
        } finally { active--; }
      })();
    },
    stop(_reason: 'owner_stop' | 'run_ended') {
      stopPromise ??= (async () => {
        await ledger.stop();
        const ids = [...inFlight.keys()]; stopController.abort();
        await Promise.all([...inFlight.values()]);
        return { stopped: true as const, inFlightAtStop: ids,
          settled: ids.filter(id => terminal.get(id)?.outcome !== 'uncertain'),
          uncertain: ids.filter(id => terminal.get(id)?.outcome === 'uncertain'), totals: ledger.totals() };
      })();
      return stopPromise;
    },
  });
}
