import type { ProviderPriceV1 } from '../../web/v1/loop-provider-prices';

export type PaidRunProviderProfileV1 = Readonly<{
  profileId: string;
  maxTokensPerInputByte: 1;
  inputOverheadTokens: number;
  enforcesMaxOutputTokens: true;
  maxOutputTokensCeiling: number;
  cacheReporting: 'none' | 'subset' | 'additive';
  reasoningReporting: 'within_output';
  extraBillableCategories: readonly [];
  maxBodyBytes: number;
  maxCallMs: number;
  clockSkewMs: number;
  maxConcurrent: number;
  streamUsageInFinalEvent: boolean;
  reportsServedModelId: true;
}>;

export type PaidRunBoundV1 = Readonly<{
  kind: 'bounded'; profileId: string; cacheReporting: PaidRunProviderProfileV1['cacheReporting'];
  inCeil: string; outCeil: number;
  inRateMax: string; outRateMax: string; maxNanoUsd: string;
}>;

export type PaidRunBoundRefusalV1 = 'unbounded_provider' | 'input_unbounded' | 'output_unbounded'
  | 'stream_unbounded' | 'price_unknown' | 'price_stale';
type Refusal = Readonly<{ kind: 'refused'; reason: PaidRunBoundRefusalV1 }>;
const refuse = (reason: PaidRunBoundRefusalV1): Refusal => ({ kind: 'refused', reason });
const integerIn = (n: number, low: number, high: number) => Number.isSafeInteger(n) && n >= low && n <= high;

/** Only reviewed provider contracts can give a finite pre-dispatch maximum. */
export function assertBoundableProfileV1(profile: PaidRunProviderProfileV1): Refusal | { kind: 'boundable' } {
  if (!profile || typeof profile.profileId !== 'string' || !profile.profileId
    || profile.maxTokensPerInputByte !== 1 || profile.enforcesMaxOutputTokens !== true
    || !['none', 'subset', 'additive'].includes(profile.cacheReporting)
    || profile.reasoningReporting !== 'within_output' || profile.reportsServedModelId !== true
    || !Array.isArray(profile.extraBillableCategories) || profile.extraBillableCategories.length !== 0
    || typeof profile.streamUsageInFinalEvent !== 'boolean'
    || !integerIn(profile.inputOverheadTokens, 0, 65_536)
    || !integerIn(profile.maxOutputTokensCeiling, 1, 1_000_000)
    || !integerIn(profile.maxBodyBytes, 1, 8 * 1024 * 1024)
    || !integerIn(profile.maxCallMs, 1, 900_000) || !integerIn(profile.clockSkewMs, 0, 300_000)
    || !integerIn(profile.maxConcurrent, 1, 32)) return refuse('unbounded_provider');
  return { kind: 'boundable' };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function priceAtCached(prices: readonly ProviderPriceV1[], instant: number): ProviderPriceV1 | null {
  return prices.find(price => {
    const window = price.window;
    if (!window) return false;
    let formatter = formatters.get(window.tz);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: window.tz, weekday: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      formatters.set(window.tz, formatter);
    }
    const parts = formatter.formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
    const local = `${part('hour')}:${part('minute')}`;
    return window.days.includes(day) && local >= window.start && local < window.end;
  }) ?? prices.find(price => price.window === null) ?? null;
}

/** Caller supplies one model's rows. Ends plus minute boundaries: at most 27 instants. */
export function rowsForIntervalV1(prices: readonly ProviderPriceV1[], start: number, end: number,
  now: number): { kind: 'priced'; rows: readonly ProviderPriceV1[] } | Refusal {
  if (![start, end, now].every(Number.isSafeInteger) || start > end || end - start > 1_500_000
    || ![start, end, now].every(value => Number.isFinite(new Date(value).getTime()))) return refuse('price_unknown');
  const instants = [start, end];
  for (let at = (Math.floor(start / 60_000) + 1) * 60_000; at < end; at += 60_000) instants.push(at);
  const rows = new Set<ProviderPriceV1>();
  try {
    for (const at of instants) {
      const row = priceAtCached(prices, at);
      if (!row || row.status !== 'known' || row.currency !== 'USD'
        || typeof row.input !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.input)
        || typeof row.output !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.output)) return refuse('price_unknown');
      const checkedAt = Date.parse(row.checkedAt);
      if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 86_400_000) return refuse('price_stale');
      rows.add(row);
    }
  } catch { return refuse('price_unknown'); }
  return { kind: 'priced', rows: [...rows] };
}

export function paidCallBoundV1(input: Readonly<{
  profile: PaidRunProviderProfileV1; body: Uint8Array; maxOutputTokens: number;
  providerId: string; servedModelId: string; prices: readonly ProviderPriceV1[]; now: number; stream?: boolean;
}>): PaidRunBoundV1 | Refusal {
  const profile = assertBoundableProfileV1(input.profile);
  if (profile.kind === 'refused') return profile;
  if (!integerIn(input.maxOutputTokens, 1, input.profile.maxOutputTokensCeiling)) return refuse('output_unbounded');
  if (!(input.body instanceof Uint8Array) || input.body.buffer instanceof SharedArrayBuffer
    || input.body.byteLength > input.profile.maxBodyBytes) return refuse('input_unbounded');
  if (input.stream && !input.profile.streamUsageInFinalEvent) return refuse('stream_unbounded');
  const prices = input.prices.filter(row => row.providerId === input.providerId && row.model === input.servedModelId);
  const priced = rowsForIntervalV1(prices, input.now - input.profile.clockSkewMs,
    input.now + input.profile.maxCallMs + input.profile.clockSkewMs, input.now);
  if (priced.kind === 'refused') return priced;
  let inRateMax = BigInt(0), outRateMax = BigInt(0);
  for (const row of priced.rows) {
    const inRate = BigInt(row.input!), outRate = BigInt(row.output!);
    if (inRate > inRateMax) inRateMax = inRate;
    if (outRate > outRateMax) outRateMax = outRate;
  }
  const inCeil = BigInt(input.body.byteLength) * BigInt(input.profile.maxTokensPerInputByte)
    + BigInt(input.profile.inputOverheadTokens);
  return Object.freeze({ kind: 'bounded', profileId: input.profile.profileId, cacheReporting: input.profile.cacheReporting,
    inCeil: String(inCeil), outCeil: input.maxOutputTokens,
    inRateMax: String(inRateMax), outRateMax: String(outRateMax),
    maxNanoUsd: String(inCeil * inRateMax + BigInt(input.maxOutputTokens) * outRateMax) });
}

/** Usage presence/schema and reasoning checks belong to settlement; this checks ceilings. */
export function paidUsageWithinBoundV1(profile: PaidRunProviderProfileV1, bound: PaidRunBoundV1,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): boolean {
  if (profile.profileId !== bound.profileId || profile.cacheReporting !== bound.cacheReporting) return false;
  const { inputTokens, cachedInputTokens, outputTokens } = usage;
  if (![inputTokens, cachedInputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)
    || outputTokens > bound.outCeil) return false;
  const input = BigInt(inputTokens), cached = BigInt(cachedInputTokens), ceiling = BigInt(bound.inCeil);
  switch (bound.cacheReporting) {
    case 'none': return input <= ceiling && cached === BigInt(0);
    case 'subset': return input <= ceiling && cached <= input;
    case 'additive': return input + cached <= ceiling;
    default: return false;
  }
}
