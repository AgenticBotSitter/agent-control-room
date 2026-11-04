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
