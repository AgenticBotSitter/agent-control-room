"use client";
import { useCallback, useEffect, useState } from 'react';
import type { LoopProviderDataV1, LoopProviderSnapshotV1 } from '../../src/web/v1/improve-control-room-loop-adapter';
import type { ProviderPriceViewV1 } from '../../src/web/v1/loop-provider-prices';
const empty = (): LoopProviderDataV1 => ({provider_id:'',display_name:'',base_url:'',billing_kind:'subscription',secret_ref:{kind:'launcher',launcher:''},
 models:[{roster_name:'',launcher:'',served_model_id:''}],credit_amount_nano_usd:null,credit_expires_on:null,credit_note:'',price_source_url:null,price_source_format:null});
const headers=(key?:string)=>({accept:'application/json',...(key?{'content-type':'application/json','idempotency-key':key}:{})});
/** Routes and opaque references only. Credentials are provisioned through owner-controlled tools. */
export function LoopProviderSection(){
 const [view,setView]=useState<LoopProviderSnapshotV1 & ProviderPriceViewV1>(),[absent,setAbsent]=useState(false),[draft,setDraft]=useState(empty),[editing,setEditing]=useState(false);
 const [pending,setPending]=useState(false),[message,setMessage]=useState('');
 const load=useCallback(async()=>{try{const r=await fetch('/api/v1/loop-providers',{credentials:'same-origin',cache:'no-store',redirect:'error',headers:headers()});
  if(r.status===404){setAbsent(true);return;}if(!r.ok)throw new Error();setView(await r.json() as LoopProviderSnapshotV1 & ProviderPriceViewV1);
 }catch{setMessage('Provider settings could not be read.');}},[]);
 useEffect(()=>{void load();},[load]);
 if(absent)return null;
 const change=<K extends keyof LoopProviderDataV1>(field:K,value:LoopProviderDataV1[K])=>setDraft(d=>({...d,[field]:value}));
 const send=async(remove=false,id=draft.provider_id)=>{
  if(!view)return;setPending(true);setMessage('');
  try{const r=await fetch(`/api/v1/loop-providers/${encodeURIComponent(id)}${remove?'/remove':''}`,{method:remove?'POST':'PUT',credentials:'same-origin',cache:'no-store',redirect:'error',headers:headers(`provider:${crypto.randomUUID()}`),
   body:JSON.stringify(remove?{expectedVersion:view.version}:{expectedVersion:view.version,provider:draft})});
   if(!r.ok){const error=await r.json() as {reason?:string};setMessage(r.status===409?'Provider settings changed. Review the current settings before saving.':error.reason==='secret_missing'?'Secret unavailable':error.reason==='roster_mismatch'?'Choose model names and launchers from the current roster.':r.status===422?'Check the provider base address and price source host.':'Provider settings could not be saved.');}
   else{setMessage(remove?'Provider route removed. Owner credentials remain owner-controlled.':'Provider settings saved.');setDraft(empty());setEditing(false);}
   await load();
  }catch{setMessage('Save could not be confirmed. Refresh provider settings before trying again.');await load();}
  finally{setPending(false);}
 };
 const refresh=async()=>{
  if(!view)return;setPending(true);setMessage('');
  try{const r=await fetch('/api/v1/loop-providers/refresh-prices',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:headers(`provider:${crypto.randomUUID()}`),body:JSON.stringify({expectedVersion:view.version})});
   setMessage(r.ok?'Price refresh finished. Review each provider’s latest fetch outcome.':r.status===409?'Provider settings changed. Refresh prices again with the current settings.':'Price refresh could not be confirmed.');
   await load();
  }catch{setMessage('Price refresh could not be confirmed.');await load();}finally{setPending(false);}
 };
 return <section className="private-panel" style={{overflowWrap:"anywhere"}}><h2>Providers</h2>
  <p>Manage provider routes and references. Provision credentials outside this page with owner-controlled tools. Removing a route leaves those credentials under your control.</p>
  {message&&<p role="status">{message}</p>}
  {!view?<p>Loading provider settings…</p>:<>
   <p>Settings version {view.version}</p>
   <button type="button" disabled={pending} onClick={()=>void refresh()}>Refresh prices</button>
   <ul>{view.providers.map(p=><li key={p.provider_id}><strong>{p.display_name}</strong> — {p.billing_kind==='token'?'Token (paid)':'Subscription'}<p>{p.base_url}</p>
    <p>Credit: {p.credit_amount_nano_usd??'Unknown'} nano-USD; expires {p.credit_expires_on??'Unknown'}. {p.credit_note}</p>
    <p>Latest price fetch: {view.fetches.find(f=>f.providerId===p.provider_id)?.outcome??'Not checked'}{view.fetches.find(f=>f.providerId===p.provider_id)?.outcome==='failed'?' — fetch failure':''}</p>
    <ul>{p.models.map(m=><li key={m.roster_name}>{m.roster_name} → {m.served_model_id} ({m.launcher})
     {!view.prices.some(price=>price.providerId===p.provider_id&&price.model===m.served_model_id)?<p>Price: Unknown; checked at: Not checked</p>:
      view.prices.filter(price=>price.providerId===p.provider_id&&price.model===m.served_model_id).map(price=><p key={price.windowKey}>
       {price.status==='known'?`Input ${price.input}; output ${price.output} nano-USD per token`:
        price.status==='not_comparable'?`Not comparable (${price.currency})`:`Unknown (${price.reason})`}. Checked at: <time dateTime={price.checkedAt}>{price.checkedAt}</time>. {price.stale?'Stale (over 24 hours)':'Fresh'}.
       {' '}{price.window?`Window: ${price.window.tz}, days ${price.window.days.join(', ')}, ${price.window.start}–${price.window.end}`:'All times'}
      </p>)}
    </li>)}</ul>
    <button type="button" disabled={pending} onClick={()=>{setDraft(structuredClone(p));setEditing(true);}}>Edit {p.display_name}</button>
    <button type="button" disabled={pending} onClick={()=>void send(true,p.provider_id)}>Remove {p.display_name}</button></li>)}</ul>
   <form className="private-graph-editor" aria-label="Provider settings" onSubmit={e=>{e.preventDefault();void send();}}>
    <h3>{editing?'Replace provider settings':'Add provider'}</h3>
    <fieldset disabled={pending} style={{minWidth:0,display:"grid",gap:"0.75rem"}}><legend>Route</legend>
     <label>Provider ID<input required value={draft.provider_id} readOnly={editing} pattern="[a-z0-9][a-z0-9._-]{2,63}" maxLength={64} onChange={e=>{const id=e.target.value;setDraft(d=>({...d,provider_id:id,secret_ref:d.secret_ref.kind==='macos_keychain'?{...d.secret_ref,account:id}:d.secret_ref}));}}/></label>
     <label>Provider name<input required maxLength={180} value={draft.display_name} onChange={e=>change('display_name',e.target.value)}/></label>
     <label>Base address<input type="url" required maxLength={300} value={draft.base_url} onChange={e=>change('base_url',e.target.value)}/></label>
     <label>Billing<select value={draft.billing_kind} onChange={e=>change('billing_kind',e.target.value as 'subscription'|'token')}><option value="subscription">Subscription</option><option value="token">Token (paid)</option></select></label>
     <label>Credential reference<select value={draft.secret_ref.kind} onChange={e=>change('secret_ref',e.target.value==='launcher'?{kind:'launcher',launcher:draft.models[0]?.launcher??''}:e.target.value==='macos_keychain'?{kind:'macos_keychain',service:'control-room.provider',account:draft.provider_id}:{kind:'bitwarden',item:''})}>
      <option value="launcher">Launcher</option><option value="macos_keychain">macOS Keychain (direct API)</option><option value="bitwarden">Bitwarden (unavailable until resolved)</option></select></label>
     {draft.secret_ref.kind==='launcher'&&<label>Reference launcher<input required maxLength={180} value={draft.secret_ref.launcher} onChange={e=>change('secret_ref',{kind:'launcher',launcher:e.target.value})}/></label>}
     {draft.secret_ref.kind==='macos_keychain'&&<p>Provision service control-room.provider, account {draft.provider_id||'your provider ID'} outside this page. The app checks availability only.</p>}
     {draft.secret_ref.kind==='bitwarden'&&<label>Opaque item reference<input required maxLength={180} value={draft.secret_ref.item} onChange={e=>change('secret_ref',{kind:'bitwarden',item:e.target.value})}/></label>}
     {draft.models.map((model,index)=><fieldset key={index} style={{minWidth:0,display:"grid",gap:"0.75rem"}}><legend>Model mapping {index+1}</legend>{(['roster_name','launcher','served_model_id'] as const).map((field)=><label key={field}>{field==='roster_name'?'Roster model':field==='launcher'?'Model launcher':'Served model ID'}<input required maxLength={180} value={model[field]} onChange={e=>change('models',draft.models.map((m,i)=>i===index?{...m,[field]:e.target.value}:m))}/></label>)}
      {draft.models.length>1&&<button type="button" onClick={()=>change('models',draft.models.filter((_,i)=>i!==index))}>Remove mapping {index+1}</button>}</fieldset>)}
     <button type="button" disabled={draft.models.length>=256} onClick={()=>change('models',[...draft.models,{roster_name:'',launcher:draft.models[0]?.launcher??'',served_model_id:''}])}>Add mapping</button>
     <label>Credit amount (nano-USD, blank means unknown)<input inputMode="numeric" pattern="0|[1-9][0-9]{0,29}" maxLength={30} value={draft.credit_amount_nano_usd??''} onChange={e=>change('credit_amount_nano_usd',e.target.value||null)}/></label>
     <label>Credit expiry<input type="date" value={draft.credit_expires_on??''} onChange={e=>change('credit_expires_on',e.target.value||null)}/></label>
     <label>Credit note<textarea maxLength={1000} value={draft.credit_note} onChange={e=>change('credit_note',e.target.value)}/></label>
     <label>Price source address (optional)<input type="url" maxLength={300} value={draft.price_source_url??''} onChange={e=>setDraft(d=>({...d,price_source_url:e.target.value||null,price_source_format:e.target.value?'control-room.provider-prices/v1':null}))}/></label>
     <button type="submit">Save provider</button><button type="button" onClick={()=>{setDraft(empty());setEditing(false);}}>Clear form</button>
    </fieldset>
   </form>
  </>}
 </section>;
}
