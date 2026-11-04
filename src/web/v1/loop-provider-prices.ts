import { z } from 'zod';
import { sha256Digest } from '../../security/digest';
import { resolvePublicUrl, fetchPinnedAddress, type PinnedFetchDependencies } from '../../vendor/control-center/pinned-fetch';
import { loopProviderDataSchemaV1, type LoopProviderDataV1 } from './improve-control-room-loop-adapter';

const currencies = new Set(Intl.supportedValuesOf('currency'));
const zones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,9})?$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const windowSchema = z.object({
  tz: z.string().refine(value => zones.has(value)),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine(days => days.every((day, i) => i === 0 || day > days[i - 1]!)),
  start: time, end: time,
}).strict().refine(window => window.start < window.end);
export type ProviderPriceWindowV1 = z.infer<typeof windowSchema>;
const windowKey = (window: ProviderPriceWindowV1 | null) => window ? `${window.tz}|${window.days.join(',')}|${window.start}-${window.end}` : 'all';
export const providerPriceDocumentSchemaV1 = z.object({
  schema: z.literal('control-room.provider-prices/v1'),
  prices: z.array(z.object({
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/),
    currency: z.string().regex(/^[A-Z]{3}$/).refine(value => currencies.has(value)),
    inputUsdPerMillionTokens: decimal, outputUsdPerMillionTokens: decimal,
    window: windowSchema.optional(),
  }).strict()).max(256),
}).strict().superRefine((document, ctx) => {
  for (let i = 0; i < document.prices.length; i++) {
    const a = document.prices[i]!;
    for (const b of document.prices.slice(0, i)) {
      if (a.model !== b.model) continue;
      const duplicate = windowKey(a.window ?? null) === windowKey(b.window ?? null);
      const overlap = a.window && b.window && (a.window.tz !== b.window.tz ||
        a.window.days.some(day => b.window!.days.includes(day)) && a.window.start < b.window.end && b.window.start < a.window.end);
      if (duplicate || overlap) ctx.addIssue({code:'custom',path:['prices',i],message:'Invalid price windows'});
    }
  }
});
export type ProviderPriceV1 = {
  providerId: string; model: string; windowKey: string; window: ProviderPriceWindowV1 | null;
  input: string | null; output: string | null; currency: string;
  status: 'known' | 'unknown' | 'not_comparable'; reason: string; checkedAt: string;
};
export type ProviderFetchV1 = {providerId:string;outcome:'ok'|'failed'|'not_machine_readable'|'no_source';reason:string;fetchedAt:string};
export type ProviderPriceViewV1 = {prices:(ProviderPriceV1 & {stale:boolean;digest:string})[];fetches:ProviderFetchV1[]};
export type ProviderPriceDependenciesV1 = Pick<PinnedFetchDependencies,'lookup'|'fetch'> & {
  providerTimeoutMs?: number; handlerTimeoutMs?: number;
};
export const providerPriceDigestV1 = (price: ProviderPriceV1) => sha256Digest({
  providerId:price.providerId, model:price.model, windowKey:price.windowKey, window:price.window,
  input:price.input, output:price.output, currency:price.currency, status:price.status, reason:price.reason, checkedAt:price.checkedAt,
});
export function priceAtV1(prices: readonly ProviderPriceV1[], at: number | Date) {
  const instant = new Date(at);
  const active = prices.find(price => {
    if (!price.window) return false;
    const parts = new Intl.DateTimeFormat('en-US', {timeZone:price.window.tz,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
    const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part('weekday'));
    const local = `${part('hour')}:${part('minute')}`;
    return price.window.days.includes(day) && local >= price.window.start && local < price.window.end;
  }) ?? prices.find(price => price.window === null);
  return active ?? null; // No matching row means unknown; never a zero price.
}
function nano(value: string) {
  const [whole, fraction = ''] = value.split('.');
  if (/[1-9]/.test(fraction.slice(3))) return null;
  return (BigInt(whole!) * BigInt(1000) + BigInt(fraction.slice(0,3).padEnd(3,'0'))).toString();
}
class SourceRefusal extends Error {
  constructor(readonly outcome: 'failed'|'not_machine_readable', readonly reason: string) { super(reason); }
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal, late?: (value:T)=>void): Promise<T> {
  if (signal.aborted) { void work.then(value => late?.(value), () => {}); signal.throwIfAborted(); }
  return new Promise<T>((resolve,reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    work.then(value => {signal.removeEventListener('abort',abort);if(signal.aborted){late?.(value);reject(signal.reason);}else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
/** One vetted address, one GET, fixture-injectable transport. No provider credential is accepted. */
export async function refreshProviderPricesV1(providers: readonly LoopProviderDataV1[], signal: AbortSignal,
  clock:()=>number = Date.now, dependencies:ProviderPriceDependenciesV1 = {}) {
  return Promise.all(providers.map(async provider => {
    const checkedAt = () => new Date(clock()).toISOString();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal,controller.signal]);
    const timer = setTimeout(()=>controller.abort(),dependencies.providerTimeoutMs ?? 10000);
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      combined.throwIfAborted();
      if (!provider.price_source_url) return {fetch:{providerId:provider.provider_id,outcome:'no_source' as const,reason:'no_source',fetchedAt:checkedAt()}};
      // Reapply the stricter settings URL/host policy before using the general pinned helper.
      if (!loopProviderDataSchemaV1.safeParse(provider).success) throw new SourceRefusal('failed','source_url');
      const target = await resolvePublicUrl(provider.price_source_url,dependencies.lookup,combined);
      response = await abortable((dependencies.fetch ?? fetchPinnedAddress)(target.url,target.addresses[0]!,{
        method:'GET',headers:{accept:'application/json','accept-encoding':'identity'},signal:combined,
      }),combined,late => {void late.body?.cancel().catch(()=>{});});
      if (!response.ok) throw new SourceRefusal('failed','http_status');
      if (response.headers.has('content-encoding') && response.headers.get('content-encoding')!.toLowerCase() !== 'identity') throw new SourceRefusal('failed','encoding');
      const chunks: Uint8Array[] = []; let bytes=0;
      reader=response.body?.getReader();
      if (reader) for (;;) {
        const chunk=await abortable(reader.read(),combined);
        if (chunk.done) break;
        bytes+=chunk.value.byteLength;
        if(bytes>256*1024)throw new SourceRefusal('failed','overflow');
        chunks.push(chunk.value);
      }
      combined.throwIfAborted();
      let document: z.infer<typeof providerPriceDocumentSchemaV1>;
      try {
        const raw = new Uint8Array(bytes); let offset=0;
        for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}
        document=providerPriceDocumentSchemaV1.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
      } catch {throw new SourceRefusal('not_machine_readable','invalid_document');}
      const mapped=new Set(provider.models.map(model=>model.served_model_id));
      if(document.prices.some(price=>!mapped.has(price.model)))throw new SourceRefusal('not_machine_readable','unmapped_model');
      const at=checkedAt();
      const prices:ProviderPriceV1[]=document.prices.map(price=>{
        const input=price.currency==='USD'?nano(price.inputUsdPerMillionTokens):null;
        const output=price.currency==='USD'?nano(price.outputUsdPerMillionTokens):null;
        const status=price.currency!=='USD'?'not_comparable':input===null||output===null?'unknown':'known';
        return {providerId:provider.provider_id,model:price.model,windowKey:windowKey(price.window??null),window:price.window??null,
          input:status==='known'?input:null,output:status==='known'?output:null,currency:price.currency,status,
          reason:status==='known'?'':status==='unknown'?'precision':'currency',checkedAt:at};
      });
      return {fetch:{providerId:provider.provider_id,outcome:'ok' as const,reason:'',fetchedAt:at},prices};
    } catch(error) {
      return {fetch:{providerId:provider.provider_id,outcome:error instanceof SourceRefusal?error.outcome:'failed' as const,
        reason:combined.aborted?'timeout':error instanceof SourceRefusal?error.reason:'source_unavailable',fetchedAt:checkedAt()}};
    } finally {
      clearTimeout(timer);controller.abort();
      if(reader){try{await reader.cancel();}catch{}reader.releaseLock();}
      else {try{await response?.body?.cancel();}catch{}}
    }
  }));
}
