import type { LoopProviderDataV1, LoopProviderRouteResolutionV1 } from '../../web/v1/improve-control-room-loop-adapter';
import { randomUUID } from 'node:crypto';
import { providerPriceDigestV1, type ProviderPriceV1 } from '../../web/v1/loop-provider-prices';
import { sha256Digest } from '../../security/digest';

export type PaidRunTrustedContextV1 = Readonly<{
  tenantId: string; ownerIdentityId: string; projectId: string; requestId: string;
  loopRunId: string; commandId: string; settingsSha256: string;
  resolution: LoopProviderRouteResolutionV1; providers: readonly LoopProviderDataV1[];
  providerVersion: number; prices: readonly ProviderPriceV1[]; now: number;
}>;

// Test-only policy constants. Neither value authorizes production spending.
export const PAID_RUN_CAP_CEILING_NANO_USD = '5000000000';
const consentLifetimeMs = 600_000;
export type PaidRunAdmissionRefusalV1 = 'consent_missing' | 'consent_stale' | 'consent_mismatch'
  | 'consent_replayed' | 'invalid_cap' | 'multiple_paid_routes' | 'route_unknown';
type Refusal = Readonly<{ kind: 'refused'; reason: PaidRunAdmissionRefusalV1 }>;
const refuse = (reason: PaidRunAdmissionRefusalV1): Refusal => ({ kind: 'refused', reason });

type ConsentBinding = Readonly<{
  tenantId: string; ownerIdentityId: string; projectId: string; requestId: string; settingsSha256: string;
}>;
type ConsentIssue = ConsentBinding & Readonly<{ pinDigest: string; capNanoUsd: string; now: number }>;
type ConsentClaim = ConsentBinding & Readonly<{ commandId: string; loopRunId: string; now: number }>;
type ConsentRecord = ConsentBinding & Readonly<{
  consentId: string; pinDigest: string; capNanoUsd: string; issuedAt: number; expiresAt: number;
  consumedBy: Readonly<{ commandId: string; loopRunId: string }>;
}>;
declare const consumedConsentBrand: unique symbol;
export type PaidRunConsumedConsentV1 = Readonly<{ readonly [consumedConsentBrand]: true }>;
const consumedConsents = new WeakMap<object, ConsentRecord>();
export interface PaidRunConsentStoreV1 {
  issue(input: ConsentIssue): Promise<{ consentId: string }>;
  consumeOnce(consentId: string, claim: ConsentClaim): Promise<
    { kind: 'consumed'; capability: PaidRunConsumedConsentV1 } | Refusal>;
}
const bindingKeys = ['tenantId', 'ownerIdentityId', 'projectId', 'requestId', 'settingsSha256'] as const;
const bindingMatches = (a: ConsentBinding, b: ConsentBinding) => bindingKeys.every(key => a[key] === b[key]);
function fresh(record: Pick<ConsentRecord, 'issuedAt' | 'expiresAt'>, now: number) {
  return [record.issuedAt, record.expiresAt, now].every(Number.isSafeInteger)
    && record.issuedAt <= now && now < record.expiresAt
    && record.expiresAt - record.issuedAt > 0 && record.expiresAt - record.issuedAt <= consentLifetimeMs;
}

/** Stand-in only. The production transactional store must integrate the private mint separately. */
export function createPaidRunMemoryConsentStoreV1(options: Readonly<{ lifetimeMs?: number }> = {}): PaidRunConsentStoreV1 {
  const lifetimeMs = options.lifetimeMs ?? consentLifetimeMs;
  const records = new Map<string, { input: ConsentIssue; expiresAt: number; consumed: boolean }>();
  return Object.freeze({
    async issue(input: ConsentIssue) {
      const consentId = randomUUID();
      // Explicit scalars only: no aliases to caller-owned objects survive issuance.
      const copy = Object.freeze({ tenantId: input.tenantId, ownerIdentityId: input.ownerIdentityId,
        projectId: input.projectId, requestId: input.requestId, settingsSha256: input.settingsSha256,
        pinDigest: input.pinDigest, capNanoUsd: input.capNanoUsd, now: input.now });
      records.set(consentId, { input: copy, expiresAt: input.now + lifetimeMs, consumed: false });
      return { consentId };
    },
    async consumeOnce(consentId: string, claim: ConsentClaim) {
      const row = records.get(consentId);
      if (!row) return refuse('consent_missing');
      if (row.consumed) return refuse('consent_replayed');
      if (!fresh({ issuedAt: row.input.now, expiresAt: row.expiresAt }, claim.now)) return refuse('consent_stale');
      if (!bindingMatches(row.input, claim) || !claim.commandId || !claim.loopRunId) return refuse('consent_mismatch');
      // No await between single-use check, consumption and private mint.
      row.consumed = true;
      const record: ConsentRecord = Object.freeze({ consentId, tenantId: row.input.tenantId,
        ownerIdentityId: row.input.ownerIdentityId, projectId: row.input.projectId, requestId: row.input.requestId,
        settingsSha256: row.input.settingsSha256, pinDigest: row.input.pinDigest, capNanoUsd: row.input.capNanoUsd,
        issuedAt: row.input.now, expiresAt: row.expiresAt,
        consumedBy: Object.freeze({ commandId: claim.commandId, loopRunId: claim.loopRunId }) });
      const capability = Object.freeze({}) as PaidRunConsumedConsentV1;
      consumedConsents.set(capability, record);
      return { kind: 'consumed' as const, capability };
    },
  });
}

export type PaidRunPinV1 = Readonly<{
  providerId: string; model: string; servedModelId: string; providerVersion: number;
  priceRowDigest: string; capNanoUsd: string;
}>;
declare const admissionBrand: unique symbol;
export type PaidRunAdmissionV1 = Readonly<{
  readonly [admissionBrand]: true;
  runKey: string; pin: PaidRunPinV1; pinDigest: string; consentId: string;
}>;
const admissions = new WeakSet<object>();
export function isPaidRunAdmissionV1(value: unknown): value is PaidRunAdmissionV1 {
  return typeof value === 'object' && value !== null && admissions.has(value);
}

function paidRoute(context: PaidRunTrustedContextV1):
  { kind: 'paid'; providerId: string; model: string; servedModelId: string } | { kind: 'unpaid' } | Refusal {
  const paid = new Map<string, { providerId: string; model: string; servedModelId: string }>();
  for (const route of [context.resolution, ...context.resolution.additionalRoutes]) {
    const providers = context.providers.filter(provider => provider.provider_id === route.providerId);
    if (providers.length !== 1) return refuse('route_unknown');
    const provider = providers[0]!;
    const models = provider.models.filter(model => model.roster_name === route.model);
    if (models.length !== 1 || !['subscription', 'token'].includes(provider.billing_kind)) return refuse('route_unknown');
    if (provider.billing_kind === 'token') paid.set(JSON.stringify([route.providerId, route.model]),
      { providerId: route.providerId, model: route.model, servedModelId: models[0]!.served_model_id });
  }
  if (paid.size > 1) return refuse('multiple_paid_routes');
  const route = paid.values().next().value;
  return route ? { kind: 'paid', ...route } : { kind: 'unpaid' };
}

const validCap = (cap: string) => typeof cap === 'string' && /^[1-9][0-9]{0,15}$/.test(cap)
  && BigInt(cap) <= BigInt(PAID_RUN_CAP_CEILING_NANO_USD);

/** Server-side preview for consent issuance; never derives authority from settings or request pins. */
export function derivePaidRunPinV1(context: PaidRunTrustedContextV1, capNanoUsd: string):
  { kind: 'paid'; pin: PaidRunPinV1; pinDigest: string } | { kind: 'unpaid' } | Refusal {
  const route = paidRoute(context);
  if (route.kind !== 'paid') return route;
  if (!validCap(capNanoUsd)) return refuse('invalid_cap');
  const digests = context.prices.filter(row => row.providerId === route.providerId && row.model === route.servedModelId)
    .map(providerPriceDigestV1).sort();
  const pin = Object.freeze({ providerId: route.providerId, model: route.model, servedModelId: route.servedModelId,
    providerVersion: context.providerVersion, priceRowDigest: sha256Digest(digests), capNanoUsd });
  // checkedAt participates in every row digest: a refresh requires renewed consent, even at unchanged rates.
  return { kind: 'paid', pin, pinDigest: sha256Digest(pin) };
}

export function admitPaidRunV1(context: PaidRunTrustedContextV1, consent: PaidRunConsumedConsentV1 | undefined):
  { kind: 'paid'; admission: PaidRunAdmissionV1 } | { kind: 'unpaid' } | Refusal {
  const route = paidRoute(context);
  if (route.kind !== 'paid') return route;
  const record = consent && typeof consent === 'object' ? consumedConsents.get(consent) : undefined;
  if (!record) return refuse('consent_missing');
  if (!fresh(record, context.now)) return refuse('consent_stale');
  if (!bindingMatches(record, context) || record.consumedBy.commandId !== context.commandId
    || record.consumedBy.loopRunId !== context.loopRunId) return refuse('consent_mismatch');
  const derived = derivePaidRunPinV1(context, record.capNanoUsd);
  if (derived.kind !== 'paid') return derived;
  if (derived.pinDigest !== record.pinDigest) return refuse('consent_mismatch');
  const admission = Object.freeze({ runKey: sha256Digest([context.tenantId, context.loopRunId]),
    pin: derived.pin, pinDigest: derived.pinDigest, consentId: record.consentId }) as PaidRunAdmissionV1;
  admissions.add(admission);
  return { kind: 'paid', admission };
}
