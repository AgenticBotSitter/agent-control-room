"use client";

import { useEffect, useRef, useState } from "react";
import type { LoopProviderServiceV1 } from "../../src/web/v1/loop-provider-service";

type Offers = Awaited<ReturnType<LoopProviderServiceV1['offersForModelV1']>>;
type Route = { providerId: string; model: string };
type Layer = { version: number; settingsText: string };
const headers = (key?: string) => ({ accept: 'application/json', 'x-requested-with': 'XMLHttpRequest',
  ...(key ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) });
const options = { credentials: 'same-origin', cache: 'no-store', redirect: 'error' } as const;

export function LoopProviderChoice({ rosterName, selectedProviderId, onChange, disabled = false }: {
  rosterName: string; selectedProviderId?: string; onChange(providerId: string): void; disabled?: boolean;
}) {
  const [view, setView] = useState<Offers>(), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setView(undefined); setError(false);
    void fetch(`/api/v1/loop-providers/offers/${encodeURIComponent(rosterName)}`, { ...options, headers: headers(), signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return await response.json() as Offers; })
      .then(value => { if (!controller.signal.aborted) setView(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [rosterName]);
  if (error) return <p role="alert">Provider offers could not be read.</p>;
  if (!view) return <p role="status">Reading provider offers…</p>;
  const selected = view.offers.find(offer => offer.providerId === selectedProviderId);
  return <fieldset disabled={disabled} style={{ minWidth: 0 }}>
    <legend>Providers for {rosterName}</legend>
    {selectedProviderId && !selected && <p role="alert">Provider removed</p>}
    {selected && !selected.available && <p role="alert">{selected.availabilityReason}</p>}
    {view.cheapestStatus === 'no_single_cheapest' && <p>No single cheapest</p>}
    {view.cheapestStatus === 'unknown' && <p>No fresh comparable USD price</p>}
    {!view.offers.length && <p>No configured provider offers this model.</p>}
    {view.offers.map(offer => <div key={offer.providerId} style={{ overflowWrap: 'anywhere', marginBlock: 12 }}>
      <label style={{minHeight:44, display:"flex", alignItems:"center", gap:8}}><input type="radio" name="loop-provider-choice" aria-label={`Choose ${offer.displayName}${offer.displayName === offer.providerId ? "" : ` (${offer.providerId})`}`}
        checked={offer.providerId === selectedProviderId} disabled={!offer.available}
        onChange={() => onChange(offer.providerId)} />{offer.displayName}{offer.displayName !== offer.providerId ? ` (${offer.providerId})` : ""}</label>
      <p>Served model: {offer.servedModelId} · Billing: {offer.billingKind}</p>
      {offer.cheapest && <p>Cheapest</p>}
      <p>{offer.price?.status === 'known' ? `Input ${offer.price.input}; output ${offer.price.output} nano-USD per token`
        : offer.price?.status === 'not_comparable' ? `Not comparable (${offer.price.currency})` : 'Price unknown'}
        {offer.price?.reason ? ` — ${offer.price.reason.replaceAll('_', ' ')}` : ''}</p>
      <p>Checked at: {offer.price ? <time dateTime={offer.price.checkedAt}>{offer.price.checkedAt}</time> : 'Not checked'}
        {offer.price?.stale ? ' · Stale (over 24 hours)' : ''}</p>
      {offer.price?.window && <p>Window: {offer.price.window.tz}, days {offer.price.window.days.join(', ')}, {offer.price.window.start}–{offer.price.window.end}</p>}
      <p>Latest price fetch: {offer.latestFetch ? `${offer.latestFetch.outcome} ${offer.latestFetch.reason.replaceAll('_', ' ')} · ${offer.latestFetch.fetchedAt}` : 'Not checked'}</p>
      <p>Credit: {offer.credit.amountNanoUsd === null ? 'Unknown' : `${offer.credit.amountNanoUsd} nano-USD`}
        {offer.credit.expiresOn ? ` · expires ${offer.credit.expiresOn}${offer.credit.expired ? ' (expired)' : ''}` : ' · expiry unknown'}
        {offer.credit.note ? ` · ${offer.credit.note}` : ''}</p>
      {!offer.available && <p>{offer.availabilityReason}</p>}
    </div>)}
    <p>Credit does not change the listed price.</p>
  </fieldset>;
}

/** One saved route in the existing selection layer. Changes affect the next prepared
 * request; existing requests continue to use their immutable signed settings. */
export function LoopProviderSelection({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const [epoch, setEpoch] = useState(0), [data, setData] = useState<{selection:Layer; models:string[]}>();
  const [model, setModel] = useState(''), [providerId, setProviderId] = useState<string>();
  const [pending, setPending] = useState(false), [notice, setNotice] = useState('');
  const latch = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/loop-policy`;
  useEffect(() => {
    const controller = new AbortController(); setData(undefined);
    void Promise.all([fetch(path, { ...options, headers:headers(), signal:controller.signal }),
      fetch('/api/v1/loop-providers', { ...options, headers:headers(), signal:controller.signal })])
      .then(async ([policyResponse, providerResponse]) => {
        if (!policyResponse.ok || !providerResponse.ok) throw new Error();
        const policy = await policyResponse.json() as {project:Layer; selection:Layer};
        const providers = await providerResponse.json() as {providers:{models:{roster_name:string}[]}[]};
        const route = (JSON.parse(policy.selection.settingsText).providerRoute ?? JSON.parse(policy.project.settingsText).providerRoute) as Route | undefined;
        if (controller.signal.aborted) return;
        const models = [...new Set(providers.providers.flatMap(p => p.models.map(m => m.roster_name)))].sort();
        if (route && !models.includes(route.model)) models.push(route.model);
        setData({selection:policy.selection, models}); setModel(route?.model ?? ''); setProviderId(route?.providerId);
      }).catch(() => { if (!controller.signal.aborted) setNotice('Provider choices could not be read.'); });
    return () => controller.abort();
  }, [path, epoch]);
  async function save() {
    if (!data || !model || !providerId || !enabled || latch.current || !navigator.onLine) return;
    latch.current = true; setPending(true); setNotice('');
    try {
      const settings = {...JSON.parse(data.selection.settingsText), providerRoute:{providerId, model}};
      const response = await fetch(`${path}/selection`, { ...options, method:'PUT', headers:headers(`provider-choice:${crypto.randomUUID()}`),
        body:JSON.stringify({expectedVersion:data.selection.version, settings:JSON.stringify(settings)}) });
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as {reasons?:{explanation:string}[]};
        throw new Error(response.status === 409 ? 'Selection changed. Reload provider choices before saving.' : value.reasons?.[0]?.explanation ?? 'Provider choice was not saved.');
      }
      if (mounted.current) { setNotice('Provider choice saved'); setEpoch(value => value + 1); }
    } catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : 'Provider choice could not be confirmed. Reload before trying again.'); }
    finally { latch.current = false; if (mounted.current) setPending(false); }
  }
  return <section aria-label="Provider choice" style={{ minWidth:0, overflowWrap:'anywhere' }}>
    <h3>Provider choice</h3>
    <p>Choose one route for the next prepared request. Saved requests keep their confirmed settings.</p>
    {data && <>
      <label htmlFor="loop-provider-route-model">Routed roster model</label>
      <select id="loop-provider-route-model" style={{minHeight:44, maxWidth:"100%"}} value={model} disabled={pending || !enabled} onChange={event => {setModel(event.target.value);setProviderId(undefined);setNotice('');}}>
        <option value="">Choose a model</option>{data.models.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      {model && <LoopProviderChoice key={`${epoch}:${model}`} rosterName={model} selectedProviderId={providerId} onChange={setProviderId} disabled={pending || !enabled} />}
      <button type="button" style={{minHeight:44}} disabled={pending || !enabled || !model || !providerId} onClick={() => void save()}>Save provider choice</button>
    </>}
    <button type="button" style={{minHeight:44}} disabled={pending} onClick={() => {setNotice('');setEpoch(value => value + 1);}}>Reload provider choices</button>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
