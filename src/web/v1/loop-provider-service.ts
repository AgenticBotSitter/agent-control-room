import { LoopPolicyRefusedV1 } from "./loop-policy-service";
import { parseLoopSettingsV1 } from "./loop-policy-compose";
import { z } from 'zod';
import type { DatabaseClient, DatabaseSession } from '../../persistence/database';
import { withDatabaseOperationSignal } from '../../persistence/operation-signal';
import { sha256Digest } from '../../security/digest';
import { assertNoSecretMaterial } from '../../security/redaction';
import { NodeSafeCommandRunner, type SafeCommandRunnerV1 } from '../../node-policy/v1/native-key-stores';
import { WebAccessError, type VerifiedWebIdentity } from './access-verifier';
import { WebSessionAuthority } from './session-authority';
import { refreshProviderPricesV1, providerPriceDigestV1, priceAtV1, type ProviderPriceV1, type ProviderFetchV1,
  type ProviderPriceDependenciesV1, type ProviderPriceViewV1 } from './loop-provider-prices';
import { loopProviderDataSchemaV1, loopProviderRouteSchemaV1, classifyLoopProviderIssuesV1,
  serializeLoopProviderSnapshotV1, parseLoopProviderSnapshotV1, type LoopProviderDataV1,
  type LoopProviderSnapshotV1 } from './improve-control-room-loop-adapter';

export class LoopProviderRefusedV1 extends Error {
  constructor(readonly reason: 'base_url' | 'price_source_url' | 'roster_mismatch' | 'secret_missing') {
    super(reason === 'secret_missing' ? 'Secret unavailable' : 'Provider unavailable');
  }
}
/** Availability only: this interface has no credential load, unlock, write or delete operation. */
export interface ProviderSecretPresenceV1 { availability(providerId: string): Promise<'available' | 'unavailable'> }
export function createProviderSecretPresenceV1(runner: SafeCommandRunnerV1 = new NodeSafeCommandRunner()): ProviderSecretPresenceV1 {
  return Object.freeze({ async availability(providerId: string) {
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(providerId)) return 'unavailable' as const;
    let result: Awaited<ReturnType<SafeCommandRunnerV1['run']>> | undefined;
    try {
      result = await runner.run({ executable: '/usr/bin/security', args: ['find-generic-password', '-s', 'control-room.provider', '-a', providerId],
        timeoutMilliseconds: 15000, maxOutputBytes: 32768 });
      return result.exitCode === 0 ? 'available' as const : 'unavailable' as const;
    } catch { return 'unavailable' as const; }
    finally { result?.stdout.fill(0); result?.stderr.fill(0); }
  } });
}
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const upsertBody = z.object({ expectedVersion: version, provider: loopProviderDataSchemaV1 }).strict();
const removeBody = z.object({ expectedVersion: version }).strict();
type State = { version: string | number; last_idempotency_key: string | null; last_request_digest: string | null };
type ProviderRow = Omit<LoopProviderDataV1, 'models' | 'credit_expires_on'> & { credit_expires_on: string | Date | null };
type ModelRow = LoopProviderDataV1['models'][number] & { provider_id: string };
const columns = ['display_name','base_url','billing_kind','secret_ref','price_source_url','price_source_format',
  'credit_amount_nano_usd','credit_expires_on','credit_note'] as const;
const schemaError = (issues: Parameters<typeof classifyLoopProviderIssuesV1>[0]): never => {
  const reason = classifyLoopProviderIssuesV1(issues);
  if (reason === 'invalid_request') throw new WebAccessError('invalid_request');
  throw new LoopProviderRefusedV1(reason);
};
export class LoopProviderServiceV1 {
  readonly #authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: {tenantId:string;workspaceId:string},
    private readonly presence: ProviderSecretPresenceV1 = createProviderSecretPresenceV1(), private readonly clock:()=>number = Date.now,
    private readonly priceDependencies:ProviderPriceDependenciesV1 = {}) {
    this.#authority = new WebSessionAuthority(db, scope, clock, 'loop_provider');
  }
  async #read(tx: Pick<DatabaseSession,'query'>, lock=false) {
    const state=(await tx.query<State>(`SELECT version,last_idempotency_key,last_request_digest FROM control_loop_provider_state WHERE tenant_id=$1${lock?' FOR UPDATE':''}`,[this.scope.tenantId])).rows[0];
    const providers=(await tx.query<ProviderRow>(`SELECT provider_id,${columns.join(',')} FROM control_loop_providers WHERE tenant_id=$1 ORDER BY provider_id`,[this.scope.tenantId])).rows;
    const models=(await tx.query<ModelRow>('SELECT provider_id,roster_name,launcher,served_model_id FROM control_loop_provider_models WHERE tenant_id=$1 ORDER BY provider_id,roster_name',[this.scope.tenantId])).rows;
    const snapshot:LoopProviderSnapshotV1={schema:'control-room.loop-provider-snapshot/v1',tenantId:this.scope.tenantId,version:Number(state?.version??0),providers:providers.map(p=>({ ...p,
      credit_expires_on:p.credit_expires_on===null?null:typeof p.credit_expires_on==='string'?p.credit_expires_on:new Date(p.credit_expires_on).toISOString().slice(0,10),
      models:models.filter(m=>m.provider_id===p.provider_id).map(({provider_id:_,...m})=>m) }))};
    return {state,snapshot:parseLoopProviderSnapshotV1(serializeLoopProviderSnapshotV1(snapshot,this.scope.tenantId),this.scope.tenantId)};
  }
  async view(identity:VerifiedWebIdentity) {
    return this.#authority.authenticated(identity,async(tx,actor)=>{
      actor.require('providers.read',undefined,true);
      return {...(await this.#read(tx)).snapshot,...await this.#priceView(tx)};
    },{repeatableReadSnapshot:true,readOnly:true});
  }
  async #priceView(tx:DatabaseSession):Promise<ProviderPriceViewV1> {
    const rows=(await tx.query<{provider_id:string;model:string;window_key:string;window:ProviderPriceV1['window'];
      input_nano_usd_per_token:string|null;output_nano_usd_per_token:string|null;currency:string;status:ProviderPriceV1['status'];reason:string;checked_at:string|Date}>(
      'SELECT * FROM control_loop_provider_prices WHERE tenant_id=$1 ORDER BY provider_id,model,window_key',[this.scope.tenantId])).rows;
    const fetches=(await tx.query<{provider_id:string;outcome:ProviderFetchV1['outcome'];reason:string;fetched_at:string|Date}>(
      'SELECT * FROM control_loop_provider_fetches WHERE tenant_id=$1 ORDER BY provider_id',[this.scope.tenantId])).rows;
    return {prices:rows.map(row=>{
      const price:ProviderPriceV1={providerId:row.provider_id,model:row.model,windowKey:row.window_key,window:row.window,
        input:row.input_nano_usd_per_token,output:row.output_nano_usd_per_token,currency:row.currency,status:row.status,reason:row.reason,
        checkedAt:new Date(row.checked_at).toISOString()};
      return {...price,stale:this.clock()-Date.parse(price.checkedAt)>24*3600_000,digest:providerPriceDigestV1(price)};
    }),fetches:fetches.map(row=>({providerId:row.provider_id,outcome:row.outcome,reason:row.reason,fetchedAt:new Date(row.fetched_at).toISOString()}))};
  }
  /** Caller owns policy/intake authority and its transaction; lock the provider edit mutex
   * so the final save/copy cannot commit a withdrawn mapping. Never probe credentials here. */
  async revalidateSettings(tx: DatabaseSession, text: string): Promise<void> {
    const route = parseLoopSettingsV1(text).providerRoute;
    if (route === undefined) return;
    const parsed = loopProviderRouteSchemaV1.safeParse(route);
    if (!parsed.success) throw new WebAccessError('invalid_request');
    await tx.query('SELECT version FROM control_loop_provider_state WHERE tenant_id=$1 FOR SHARE', [this.scope.tenantId]);
    const { snapshot } = await this.#read(tx);
    const provider = snapshot.providers.find(p => p.provider_id === parsed.data.providerId);
    const refuse = (code: string, explanation: string): never => { throw new LoopPolicyRefusedV1([{code, explanation}]); };
    if (!provider) return refuse('PROVIDER_REMOVED', 'Provider removed');
    if (!provider.models.some(m => m.roster_name === parsed.data.model)) return refuse('PROVIDER_MAPPING_REMOVED', 'Provider model mapping removed');
    try { await this.#roster(tx, provider); }
    catch (error) { if (error instanceof LoopProviderRefusedV1) return refuse('PROVIDER_ROSTER_MISMATCH', 'Provider roster mapping changed'); throw error; }
    const roster = (await tx.query<{on_off:string}>('SELECT on_off FROM control_loop_roster_models WHERE tenant_id=$1 AND name=$2 FOR SHARE', [this.scope.tenantId, parsed.data.model])).rows[0];
    if (roster?.on_off !== 'on') return refuse('PROVIDER_MODEL_UNAVAILABLE', 'Roster model unavailable');
    if (provider.secret_ref.kind === 'bitwarden') return refuse('PROVIDER_SECRET_UNAVAILABLE', 'Secret unavailable');
  }
  async offersForModelV1(identity: VerifiedWebIdentity, rosterName: string, at: number | Date = this.clock()) {
    const instant = Number(at);
    if (!rosterName || rosterName.length > 180 || /[\u0000-\u001f\u007f]/.test(rosterName) || !Number.isFinite(instant)) throw new WebAccessError('invalid_request');
    try { assertNoSecretMaterial({model:rosterName}); } catch { throw new WebAccessError('invalid_request'); }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require('providers.read', undefined, true);
      const {snapshot} = await this.#read(tx), view = await this.#priceView(tx);
      const roster = (await tx.query<{name:string;launcher:string;on_off:string}>('SELECT name,launcher,on_off FROM control_loop_roster_models WHERE tenant_id=$1', [this.scope.tenantId])).rows;
      const offers = snapshot.providers.flatMap(provider => {
        const model = provider.models.find(m => m.roster_name === rosterName);
        if (!model) return [];
        const mismatch = provider.models.some(m => !roster.some(r => r.name === m.roster_name && r.launcher === m.launcher));
        const reason = mismatch ? 'Provider roster mapping changed' : !roster.some(r => r.name === rosterName && r.on_off === 'on') ? 'Roster model unavailable'
          : provider.secret_ref.kind === 'bitwarden' ? 'Secret unavailable' : null;
        const row = priceAtV1(view.prices.filter(p => p.providerId === provider.provider_id && p.model === model.served_model_id), instant);
        const price = row ? {...row, stale: instant - Date.parse(row.checkedAt) > 24 * 3600_000} : null;
        return [{ providerId: provider.provider_id, displayName: provider.display_name, model: rosterName, servedModelId: model.served_model_id,
          billingKind: provider.billing_kind, price, latestFetch: view.fetches.find(f => f.providerId === provider.provider_id) ?? null,
          credit: {amountNanoUsd:provider.credit_amount_nano_usd, expiresOn:provider.credit_expires_on, note:provider.credit_note,
            expired:provider.credit_expires_on !== null && provider.credit_expires_on < new Date(instant).toISOString().slice(0,10)},
          available:reason === null, availabilityReason:reason, cheapest:false }];
      });
      const comparable = offers.filter(o => o.price?.status === 'known' && o.price.currency === 'USD'
        && !o.price.stale && Date.parse(o.price.checkedAt) <= instant && o.price.input !== null && o.price.output !== null);
      for (const offer of comparable) offer.cheapest = comparable.every(other => BigInt(offer.price!.input!) <= BigInt(other.price!.input!)
        && BigInt(offer.price!.output!) <= BigInt(other.price!.output!));
      return {model:rosterName, at:new Date(instant).toISOString(), version:snapshot.version, offers,
        cheapestStatus:offers.some(o => o.cheapest) ? 'minimum' as const : comparable.length ? 'no_single_cheapest' as const : 'unknown' as const};
    }, {repeatableReadSnapshot:true,readOnly:true});
  }
  async refreshPrices(identity:VerifiedWebIdentity,body:unknown,key:string,incoming?:AbortSignal) {
    const parsed=removeBody.safeParse(body);
    if(!parsed.success||!/^[A-Za-z0-9:_-]{16,100}$/.test(key))throw new WebAccessError('invalid_request');
    const expectedVersion=parsed.data.expectedVersion,digest=sha256Digest({operation:'refresh-prices',body:parsed.data});
    const controller=new AbortController(),signal=incoming?AbortSignal.any([incoming,controller.signal]):controller.signal;
    const budget=this.priceDependencies.handlerTimeoutMs??20000,deadline=performance.now()+budget;
    const timer=setTimeout(()=>controller.abort(),budget);
    const current=()=>{signal.throwIfAborted();if(performance.now()>=deadline)throw new WebAccessError('conflict');};
    // Bound every lock/statement by the shared remaining budget. The production adapter also
    // consumes the operation signal during pool checkout and immediately before COMMIT.
    const transaction=<T>(work:(tx:DatabaseSession)=>Promise<T>,check:()=>void|Promise<void>)=>this.db.transactionWithPreCommitCheck(async tx=>{
      current();
      const bounded:DatabaseSession={query:async <U>(sql:string,params?:unknown[])=>{
        current();const remaining=String(Math.max(1,Math.floor(deadline-performance.now())));
        await tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[remaining]);
        current();const result=await tx.query<U>(sql,params);current();return result;
      }};
      return work(bounded);
    },async()=>{current();await check();current();});
    const db:DatabaseClient={query:(sql,params)=>this.db.query(sql,params),transaction:work=>transaction(work,()=>{}),transactionWithPreCommitCheck:transaction};
    const authority=new WebSessionAuthority(db,this.scope,this.clock,'loop_provider');
    const replay=(state:State|undefined)=>{
      if(state?.last_idempotency_key!==key)return undefined;
      if(state.last_request_digest!==digest)throw new WebAccessError('conflict');
      return {replayed:true,version:Number(state.version)};
    };
    try{return await withDatabaseOperationSignal(signal,async()=>{
      const before=await authority.authenticated(identity,async(tx,actor)=>{
        actor.require('providers.manage',undefined,true);
        const read=await this.#read(tx,true),again=replay(read.state);
        if(!again&&(read.snapshot.version!==expectedVersion||expectedVersion===Number.MAX_SAFE_INTEGER))throw new WebAccessError('conflict');
        return {...read,replayed:again};
      });
      if(before.replayed)return before.replayed;
      const results=await refreshProviderPricesV1(before.snapshot.providers,signal,this.clock,this.priceDependencies);
      current();
      return authority.authenticated(identity,async(tx,actor)=>{
        actor.require('providers.manage',undefined,true);
        const inserted=await tx.query(`INSERT INTO control_loop_provider_state(tenant_id,version,last_idempotency_key,last_request_digest,updated_at)
          VALUES($1,1,$2,$3,$4) ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,[this.scope.tenantId,key,digest,actor.now]);
        const read=await this.#read(tx,true);
        const snapshot=inserted.rows.length?{...read.snapshot,version:0}:read.snapshot;
        if(snapshot.version!==expectedVersion||sha256Digest(snapshot)!==sha256Digest(before.snapshot))throw new WebAccessError('conflict');
        for(const result of results){
          const id=result.fetch.providerId;
          if(result.prices){
            await tx.query('DELETE FROM control_loop_provider_prices WHERE tenant_id=$1 AND provider_id=$2',[this.scope.tenantId,id]);
            for(const price of result.prices)await tx.query(`INSERT INTO control_loop_provider_prices(tenant_id,provider_id,model,window_key,"window",input_nano_usd_per_token,output_nano_usd_per_token,currency,status,reason,checked_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[this.scope.tenantId,id,price.model,price.windowKey,price.window?JSON.stringify(price.window):null,price.input,price.output,price.currency,price.status,price.reason,price.checkedAt]);
          }
          await tx.query(`INSERT INTO control_loop_provider_fetches(tenant_id,provider_id,outcome,reason,fetched_at) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT (tenant_id,provider_id) DO UPDATE SET outcome=EXCLUDED.outcome,reason=EXCLUDED.reason,fetched_at=EXCLUDED.fetched_at`,
            [this.scope.tenantId,id,result.fetch.outcome,result.fetch.reason,result.fetch.fetchedAt]);
        }
        await tx.query('UPDATE control_loop_provider_state SET version=$2,last_idempotency_key=$3,last_request_digest=$4,updated_at=$5 WHERE tenant_id=$1',
          [this.scope.tenantId,expectedVersion+1,key,digest,actor.now]);
        return {replayed:false,version:expectedVersion+1};
      });
    });}finally{clearTimeout(timer);controller.abort();}
  }
  async #roster(tx: DatabaseSession,p:LoopProviderDataV1) {
    const roster=(await tx.query<{name:string;launcher:string}>('SELECT name,launcher FROM control_loop_roster_models WHERE tenant_id=$1 FOR SHARE',[this.scope.tenantId])).rows;
    if (p.models.some(m=>!roster.some(r=>r.name===m.roster_name&&r.launcher===m.launcher))) throw new LoopProviderRefusedV1('roster_mismatch');
    // Keychain references designate direct token API routes; subscription launcher credentials remain launcher-owned.
    if(p.secret_ref.kind==='macos_keychain'&&p.billing_kind!=='token') throw new LoopProviderRefusedV1('roster_mismatch');
  }
  async revalidate(identity:VerifiedWebIdentity,route:unknown) {
    const parsed=loopProviderRouteSchemaV1.safeParse(route);if(!parsed.success)throw new WebAccessError('invalid_request');
    return this.#authority.authenticated(identity,async(tx,actor)=>{
      actor.require('providers.read',undefined,true);
      const {snapshot}=await this.#read(tx);
      const p=snapshot.providers.find(p=>p.provider_id===parsed.data.providerId),m=p?.models.find(m=>m.roster_name===parsed.data.model);
      if(!p||!m)throw new LoopProviderRefusedV1('roster_mismatch');
      await this.#roster(tx,p);
      if(p.secret_ref.kind==='bitwarden')throw new LoopProviderRefusedV1('secret_missing');
      return {...m,provider:p,version:snapshot.version};
    },{repeatableReadSnapshot:true,readOnly:true});
  }
  async upsert(identity:VerifiedWebIdentity,providerId:string,body:unknown,key:string) {
    try { assertNoSecretMaterial(body); }catch{throw new WebAccessError('invalid_request');}
    const parsed=upsertBody.safeParse(body);if(!parsed.success)schemaError(parsed.error.issues);
    const {expectedVersion,provider}=parsed.data!;
    if(provider.provider_id!==providerId)throw new WebAccessError('invalid_request');
    return this.#edit(identity,providerId,expectedVersion,key,{operation:'upsert',providerId,body:parsed.data},provider);
  }
  async remove(identity:VerifiedWebIdentity,providerId:string,body:unknown,key:string) {
    const parsed=removeBody.safeParse(body);if(!parsed.success)throw new WebAccessError('invalid_request');
    return this.#edit(identity,providerId,parsed.data.expectedVersion,key,{operation:'remove',providerId,body:parsed.data});
  }
  async #edit(identity:VerifiedWebIdentity,id:string,expectedVersion:number,key:string,request:unknown,p?:LoopProviderDataV1) {
    if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(id)||!/^[A-Za-z0-9:_-]{16,100}$/.test(key))throw new WebAccessError('invalid_request');
    const digest=sha256Digest(request);
    const replay=(state:State|undefined)=>{
      if(state?.last_idempotency_key!==key)return undefined;
      if(state.last_request_digest!==digest)throw new WebAccessError('conflict');
      return {replayed:true,version:Number(state.version)};
    };
    const before=await this.#authority.authenticated(identity,async(tx,actor)=>{
      actor.require('providers.manage',undefined,true);
      const read=await this.#read(tx);const again=replay(read.state);if(again)return {...read,replayed:again};
      if(read.snapshot.version!==expectedVersion||expectedVersion===Number.MAX_SAFE_INTEGER)throw new WebAccessError('conflict');
      if(p)await this.#roster(tx,p);
      else if(!read.snapshot.providers.some(p=>p.provider_id===id))throw new WebAccessError('not_found');
      // Both provider count and serialized byte bound are checked BEFORE any presence command or write.
      this.#candidate(read.snapshot,id,p,expectedVersion+1);
      return {...read,replayed:undefined};
    },{repeatableReadSnapshot:true});
    if(before.replayed)return before.replayed;
    if(p?.secret_ref.kind==='macos_keychain'&&await this.presence.availability(id)!=='available')throw new LoopProviderRefusedV1('secret_missing');
    return this.#authority.authenticated(identity,async(tx,actor)=>{
      actor.require('providers.manage',undefined,true);
      const inserted = await tx.query(`INSERT INTO control_loop_provider_state(tenant_id,version,last_idempotency_key,last_request_digest,updated_at)
        VALUES($1,1,$2,$3,$4) ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,[this.scope.tenantId,key,digest,actor.now]);
      const current=await this.#read(tx,true);
      // A newly inserted state is a reservation, not a replay. Existing state must match the probed snapshot exactly.
      const existed=before.state!==undefined;
      if(inserted.rows.length===0){const again=replay(current.state);if(again)return again;}
      if((existed&&current.snapshot.version!==expectedVersion)||(!existed&&
        (current.state?.last_idempotency_key!==key||current.state.last_request_digest!==digest||current.snapshot.providers.length!==0)))throw new WebAccessError('conflict');
      if(p)await this.#roster(tx,p);
      const base=existed?current.snapshot:{...current.snapshot,version:0};
      if(sha256Digest(base)!==sha256Digest(before.snapshot))throw new WebAccessError('conflict');
      this.#candidate(base,id,p,expectedVersion+1);
      await tx.query('DELETE FROM control_loop_provider_prices WHERE tenant_id=$1 AND provider_id=$2',[this.scope.tenantId,id]);
      await tx.query('DELETE FROM control_loop_provider_fetches WHERE tenant_id=$1 AND provider_id=$2',[this.scope.tenantId,id]);
      await tx.query('DELETE FROM control_loop_provider_models WHERE tenant_id=$1 AND provider_id=$2',[this.scope.tenantId,id]);
      if(p){
        const values=columns.map(c=>c==='secret_ref'?JSON.stringify(p[c]):p[c]);
        await tx.query(`INSERT INTO control_loop_providers(tenant_id,provider_id,${columns.join(',')},updated_by,updated_at)
          VALUES($1,$2,${columns.map((_,i)=>'$'+(i+3)).join(',')},$12,$13)
          ON CONFLICT (tenant_id,provider_id) DO UPDATE SET ${columns.map(c=>`${c}=EXCLUDED.${c}`).join(',')},updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
          [this.scope.tenantId,id,...values,actor.id,actor.now]);
        for(const m of p.models)await tx.query(`INSERT INTO control_loop_provider_models(tenant_id,provider_id,roster_name,launcher,served_model_id) VALUES($1,$2,$3,$4,$5)`,[this.scope.tenantId,id,m.roster_name,m.launcher,m.served_model_id]);
      }else await tx.query('DELETE FROM control_loop_providers WHERE tenant_id=$1 AND provider_id=$2',[this.scope.tenantId,id]);
      await tx.query(`UPDATE control_loop_provider_state SET version=$2,last_idempotency_key=$3,last_request_digest=$4,updated_at=$5 WHERE tenant_id=$1`,[this.scope.tenantId,expectedVersion+1,key,digest,actor.now]);
      return {replayed:false,version:expectedVersion+1};
    });
  }
  #candidate(snapshot:LoopProviderSnapshotV1,id:string,p:LoopProviderDataV1|undefined,next:number) {
    const providers=[...snapshot.providers.filter(x=>x.provider_id!==id),...(p?[p]:[])].sort((a,b)=>a.provider_id.localeCompare(b.provider_id));
    try { serializeLoopProviderSnapshotV1({...snapshot,version:next,providers},this.scope.tenantId); }
    catch {throw new WebAccessError('invalid_request');}
  }
}
