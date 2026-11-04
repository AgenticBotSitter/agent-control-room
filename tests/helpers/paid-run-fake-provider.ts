import type { PaidRunProviderProfileV1 } from '../../src/usage/v1/paid-run-bound';
import type { PaidRunTrustedContextV1 } from '../../src/usage/v1/paid-run-admission';
import type { ProviderPriceV1 } from '../../src/web/v1/loop-provider-prices';

// CAP-A supplies synthetic bound/admission fixtures. The scripted transport is CAP-B.
export const paidRunNow = Date.parse('2026-03-08T06:00:00Z');
export const paidRunFakeProfile: PaidRunProviderProfileV1 = Object.freeze({
  profileId: 'scripted-fake/v1', maxTokensPerInputByte: 1, inputOverheadTokens: 0,
  enforcesMaxOutputTokens: true, maxOutputTokensCeiling: 1_000_000,
  cacheReporting: 'additive', reasoningReporting: 'within_output', extraBillableCategories: [] as const,
  maxBodyBytes: 8 * 1024 * 1024, maxCallMs: 120_000, clockSkewMs: 0, maxConcurrent: 32,
  streamUsageInFinalEvent: true, reportsServedModelId: true,
});
export const paidRunPrice = (changes: Partial<ProviderPriceV1> = {}): ProviderPriceV1 => ({
  providerId: 'provider-one', model: 'served/one', windowKey: 'all', window: null,
  input: '3000', output: '15000', currency: 'USD', status: 'known', reason: '',
  checkedAt: new Date(paidRunNow).toISOString(), ...changes,
});
export const paidRunContext = (changes: Partial<PaidRunTrustedContextV1> = {}): PaidRunTrustedContextV1 => ({
  tenantId: 'tenant:one', ownerIdentityId: 'identity:owner', projectId: 'project:one', requestId: 'request:one',
  loopRunId: 'run:one', commandId: 'command:one', settingsSha256: 'sha256:' + 'a'.repeat(64),
  resolution: { providerId: 'provider-one', model: 'roster-one', additionalRoutes: [] },
  providers: [{ provider_id: 'provider-one', display_name: 'Synthetic provider', base_url: 'https://example.invalid',
    billing_kind: 'token', secret_ref: { kind: 'launcher', launcher: 'synthetic' },
    models: [{ roster_name: 'roster-one', served_model_id: 'served/one', launcher: 'synthetic' }],
    credit_amount_nano_usd: null, credit_expires_on: null, credit_note: '', price_source_url: null, price_source_format: null }],
  providerVersion: 1, prices: [paidRunPrice()], now: paidRunNow, ...changes,
});

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { admitPaidRunV1, createPaidRunMemoryConsentStoreV1, derivePaidRunPinV1 } from '../../src/usage/v1/paid-run-admission';
import { createPaidRunJournalLedgerV1, paidRunLedgerRootIdentityV1 } from '../../src/usage/v1/paid-run-ledger';
import { createPaidRunExecutorV1, type PaidRunTransportV1, type PaidRunTransportResponseV1,
  type PaidRunReportedUsageV1, type PaidRunCurrentConfigV1 } from '../../src/usage/v1/paid-run-executor';
export const paidRunCallId = (n: number) => `scripted_call_${String(n).padStart(6, '0')}`;
export const paidRunInput = (n: number) => ({ callId: paidRunCallId(n), body: new Uint8Array(1000), maxOutputTokens: 200 });
export function paidRunBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, release: resolve };
}
export type PaidRunScriptV1 = {
  servedModelId?: string | null; usage?: PaidRunReportedUsageV1 | null; status?: number;
  failure?: 'http_500' | 'reset_after_send' | 'hang' | 'stream';
  hold?: Promise<void>; ignoreAbort?: boolean; events?: PaidRunTransportResponseV1 & { kind: 'stream' };
};
export function createPaidRunFakeProviderV1(scripts: PaidRunScriptV1[] = [], onRequest?: (id: string) => void) {
  const requests: { callId: string; body: Uint8Array; bodyDigest: string; maxOutputTokens: number; stream: boolean; servedModelId: string }[] = [];
  let active = 0, highWater = 0;
  const transport: PaidRunTransportV1 = {
    async send(request, signal) {
      const script = scripts[requests.length] ?? {};
      requests.push({ ...request, body: Uint8Array.from(request.body),
        bodyDigest: `sha256:${createHash('sha256').update(request.body).digest('hex')}` });
      active++; highWater = Math.max(highWater, active); onRequest?.(request.callId);
      let aborted: (() => void) | undefined;
      try {
        if (script.hold || script.failure === 'hang') {
          const hold = script.hold ?? new Promise<void>(() => {});
          if (script.ignoreAbort) await hold;
          else await Promise.race([hold, new Promise<never>((_, reject) => {
            aborted = () => reject(new Error('fake_aborted'));
            signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
          })]);
        }
        if (script.failure === 'reset_after_send') throw new Error('fake_reset');
        if (script.events) return script.events;
        const servedModelId = script.servedModelId === undefined ? 'served/one' : script.servedModelId;
        const usage = script.usage === undefined ? { inputTokens: 400, cachedInputTokens: 0, outputTokens: 100 } : script.usage;
        if (script.failure === 'stream') return { kind: 'stream', status: 200,
          events: (async function* () { yield { kind: 'data' as const, body: new Uint8Array([1]) };
            yield { kind: 'final' as const, servedModelId, usage }; })() };
        return { kind: 'completed', status: script.failure === 'http_500' ? 500 : script.status ?? 200,
          servedModelId, usage, body: new Uint8Array() };
      } finally { active--; if (aborted) signal.removeEventListener('abort', aborted); }
    },
  };
  return { transport, requests, highWater: () => highWater, active: () => active };
}
export async function paidRunAdmission(context = paidRunContext({ loopRunId: `run:${randomUUID()}` }), cap = '18000000') {
  const pin = derivePaidRunPinV1(context, cap); assert.equal(pin.kind, 'paid');
  if (pin.kind !== 'paid') throw new Error('fixture_pin');
  const store = createPaidRunMemoryConsentStoreV1();
  const issued = await store.issue({ ...context, capNanoUsd: cap, pinDigest: pin.pinDigest });
  const consumed = await store.consumeOnce(issued.consentId, context); assert.equal(consumed.kind, 'consumed');
  if (consumed.kind !== 'consumed') throw new Error('fixture_consent');
  const admitted = admitPaidRunV1(context, consumed.capability); assert.equal(admitted.kind, 'paid');
  if (admitted.kind !== 'paid') throw new Error('fixture_admission');
  return admitted.admission;
}
export async function paidRunFixture(options: { cap?: string; scripts?: PaidRunScriptV1[];
  profile?: PaidRunProviderProfileV1; context?: PaidRunTrustedContextV1; config?: () => Promise<PaidRunCurrentConfigV1>;
  afterReserve?: (callId: string) => Promise<void>; clock?: () => number; onRequest?: (id: string) => void } = {}) {
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-tmp/paid-run-fixture-'));
  const context = { ...(options.context ?? paidRunContext({ loopRunId: `run:${randomUUID()}` })),
    ledgerRootIdentity: await paidRunLedgerRootIdentityV1(root) };
  const admission = await paidRunAdmission(context, options.cap);
  const store = createPaidRunJournalLedgerV1({ root, afterReserve: options.afterReserve }), ledger = await store.open(admission);
  const fake = createPaidRunFakeProviderV1(options.scripts, options.onRequest);
  const config = options.config ?? (async () => ({ providerVersion: context.providerVersion,
    servedModelId: 'served/one', billingKind: 'token' as const, priceRows: context.prices }));
  const profile = options.profile ?? paidRunFakeProfile, clock = options.clock ?? (() => paidRunNow);
  const executor = createPaidRunExecutorV1({ admission, ledger, transport: fake.transport, currentConfig: config, profile, clock });
  return { root, context, journal: join(root, admission.runKey, 'journal.jsonl'), admission, ledger, executor, fake, store,
    async close() { await executor.stop('run_ended'); await ledger.close(); await rm(root, { recursive: true, force: true }); } };
}
