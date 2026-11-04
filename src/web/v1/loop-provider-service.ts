import { z } from 'zod';
import type { DatabaseClient, DatabaseSession } from '../../persistence/database';
import { sha256Digest } from '../../security/digest';
import { assertNoSecretMaterial } from '../../security/redaction';
import { NodeSafeCommandRunner, type SafeCommandRunnerV1 } from '../../node-policy/v1/native-key-stores';
import { WebAccessError, type VerifiedWebIdentity } from './access-verifier';
import { WebSessionAuthority } from './session-authority';
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
    private readonly presence: ProviderSecretPresenceV1 = createProviderSecretPresenceV1(), private readonly clock:()=>number = Date.now) {
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
      return (await this.#read(tx)).snapshot;
    },{repeatableReadSnapshot:true,readOnly:true});
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
