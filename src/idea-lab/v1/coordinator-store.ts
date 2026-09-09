import { timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag } from "../../security";
import { dataMethodV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { buildIdeaLabBotRunV1, parseIdeaLabBotRunV1, type IdeaLabBotAttemptV1, type IdeaLabBotRunV1 } from "./coordinator";
import { capturedIdeaTimeMillisecondsV1 } from "./schemas";

interface Row { version: number|string; payload: unknown; run_digest: string; run_auth_tag: string }
function same(a: string,b: string): boolean { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y); }
function time(value:string):number{const milliseconds=capturedIdeaTimeMillisecondsV1(value);if(milliseconds===undefined)throw new IdeaLabErrorV1("integrity_failed");return milliseconds;}

export class IdeaLabBotRunStoreV1 {
  readonly #db: DatabaseClient; readonly #key: Uint8Array;
  constructor(db:DatabaseClient,key:Uint8Array){
    if(!db||typeof db!=="object"||isHostProxyV1(db)||!dataMethodV1(db,"query")||!dataMethodV1(db,"transaction"))throw new IdeaLabErrorV1("invalid_input");
    const exact=exactHostUint8ArrayV1(key,32);if(!exact)throw new IdeaLabErrorV1("invalid_input");this.#db=db;this.#key=exact.copy();Object.freeze(this);
  }
  #tag(run:IdeaLabBotRunV1,version:number){return hmacSha256Tag(this.#key,{kind:"idea_bot_run",tenantId:run.tenantId,runId:run.runId,version,runDigest:run.runDigest});}
  #verify(row:Row):IdeaLabBotRunV1{const run=parseIdeaLabBotRunV1(row.payload),version=Number(row.version);if(run.runDigest!==row.run_digest||!same(this.#tag(run,version),row.run_auth_tag))throw new IdeaLabErrorV1("integrity_failed");return run;}
  async #lockWorkspace(tx:DatabaseSession,run:{tenantId:string;workspaceId:string}){
    // Stable row, unlike the append-only latest event. Read the current version in
    // a separate statement after this lock; never retain it across provider work.
    const locked=await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[run.tenantId,run.workspaceId]);
    if(locked.rows.length!==1)throw new IdeaLabErrorV1("not_found");
  }
  async get(runId:string):Promise<IdeaLabBotRunV1|undefined>{
    const rows=await this.#db.query<Row>(`SELECT version,payload,run_digest,run_auth_tag FROM control_idea_bot_run_events WHERE run_id=$1 ORDER BY version`,[runId]);
    let prior:IdeaLabBotRunV1|undefined;for(let index=0;index<rows.rows.length;index+=1){const run=this.#verify(rows.rows[index]!);
      if(run.runId!==runId||Number(rows.rows[index]!.version)!==index+1||prior&&(run.tenantId!==prior.tenantId||run.workspaceId!==prior.workspaceId||run.sessionId!==prior.sessionId||run.sessionDigest!==prior.sessionDigest||run.attempts.length<prior.attempts.length||time(run.updatedAt)<time(prior.updatedAt)||prior.cancellationRequestedAt&&run.cancellationRequestedAt!==prior.cancellationRequestedAt))throw new IdeaLabErrorV1("integrity_failed");prior=run;}
    return prior;
  }
  /** One logical panel per saved Idea. Never choose a convenient run from conflicting history. */
  async getForSession(scope:{tenantId:string;workspaceId:string;sessionId:string;sessionDigest:string}):Promise<IdeaLabBotRunV1|undefined>{
    const rows=await this.#db.query<{run_id:string}>(`SELECT DISTINCT run_id FROM control_idea_bot_run_events
      WHERE tenant_id=$1 AND workspace_id=$2 AND session_id=$3 ORDER BY run_id LIMIT 2`,[scope.tenantId,scope.workspaceId,scope.sessionId]);
    if(rows.rows.length>1)throw new IdeaLabErrorV1("state_conflict");
    if(!rows.rows.length)return undefined;
    const run=await this.get(rows.rows[0]!.run_id);
    if(!run||run.tenantId!==scope.tenantId||run.workspaceId!==scope.workspaceId||run.sessionId!==scope.sessionId||run.sessionDigest!==scope.sessionDigest)
      throw new IdeaLabErrorV1("integrity_failed");
    return run;
  }
  async prepare(run:IdeaLabBotRunV1):Promise<IdeaLabBotRunV1>{
    const parsed=parseIdeaLabBotRunV1(run);return this.#db.transaction(async tx=>{await this.#lockWorkspace(tx,parsed);const existing=await tx.query<Row>(`SELECT version,payload,run_digest,run_auth_tag FROM control_idea_bot_run_events WHERE run_id=$1 ORDER BY version DESC LIMIT 1`,[parsed.runId]);
      if(existing.rows[0]){const stored=this.#verify(existing.rows[0]);if(stored.sessionDigest!==parsed.sessionDigest||stored.evidenceDigests.join()!==parsed.evidenceDigests.join())throw new IdeaLabErrorV1("duplicate_record");return stored;}
      await tx.query(`INSERT INTO control_idea_bot_run_events(run_id,version,tenant_id,workspace_id,session_id,state,run_digest,run_auth_tag,payload,occurred_at) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,[parsed.runId,parsed.tenantId,parsed.workspaceId,parsed.sessionId,parsed.state,parsed.runDigest,this.#tag(parsed,1),JSON.stringify(parsed),parsed.updatedAt]);return parsed;});
  }
  async #append(runId:string,change:(current:IdeaLabBotRunV1)=>IdeaLabBotRunV1):Promise<IdeaLabBotRunV1>{return this.#db.transaction(async tx=>{
    const initial=await tx.query<Row>(`SELECT version,payload,run_digest,run_auth_tag FROM control_idea_bot_run_events WHERE run_id=$1 ORDER BY version DESC LIMIT 1`,[runId]);
    if(!initial.rows[0])throw new IdeaLabErrorV1("not_found");const binding=this.#verify(initial.rows[0]);
    if(binding.runId!==runId)throw new IdeaLabErrorV1("integrity_failed");await this.#lockWorkspace(tx,binding);
    // The stable workspace lock serializes appends. Immutable events need SELECT,
    // not a row lock that would unnecessarily require UPDATE permission.
    const rows=await tx.query<Row>(`SELECT version,payload,run_digest,run_auth_tag FROM control_idea_bot_run_events WHERE run_id=$1 ORDER BY version DESC LIMIT 1`,[runId]);if(!rows.rows[0])throw new IdeaLabErrorV1("not_found");const current=this.#verify(rows.rows[0]);
    if(current.runId!==runId||current.tenantId!==binding.tenantId||current.workspaceId!==binding.workspaceId||current.sessionDigest!==binding.sessionDigest)throw new IdeaLabErrorV1("integrity_failed");
    let next=change(current);const version=Number(rows.rows[0].version)+1;
    if(next===current)return current;
    // A caller can capture its observation time before a later cancellation wins
    // the lock. Preserve attempt/request times, but keep the recorded head monotonic.
    if(current.cancellationRequestedAt||time(next.updatedAt)<time(current.updatedAt)){const {runDigest:ignored,...material}=next;void ignored;
      next=buildIdeaLabBotRunV1({...material,updatedAt:time(next.updatedAt)<time(current.updatedAt)?current.updatedAt:next.updatedAt,
        ...(current.cancellationRequestedAt?{cancellationRequestedAt:current.cancellationRequestedAt}:{})});}
    parseIdeaLabBotRunV1(next);
    if(current.runId!==runId||next.runId!==runId||time(next.updatedAt)<time(current.updatedAt))throw new IdeaLabErrorV1("integrity_failed");
    await tx.query(`INSERT INTO control_idea_bot_run_events(run_id,version,tenant_id,workspace_id,session_id,state,run_digest,run_auth_tag,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,[next.runId,version,next.tenantId,next.workspaceId,next.sessionId,next.state,next.runDigest,this.#tag(next,version),JSON.stringify(next),next.updatedAt]);return next;});}
  async requestCancel(runId:string,at:string){return this.#append(runId,current=>{
    if(current.cancellationRequestedAt||!["prepared","running"].includes(current.state))return current;
    const {runDigest:ignored,...material}=current;void ignored;
    return buildIdeaLabBotRunV1({...material,cancellationRequestedAt:at,updatedAt:at});});}
  async markProvider(runId:string,attempt:IdeaLabBotAttemptV1){return this.#append(runId,current=>{if(current.cancellationRequestedAt||!["prepared","running"].includes(current.state)||current.attempts.some(a=>a.attemptId===attempt.attemptId))throw new IdeaLabErrorV1("state_conflict");return buildIdeaLabBotRunV1({runId:current.runId,tenantId:current.tenantId,workspaceId:current.workspaceId,sessionId:current.sessionId,sessionDigest:current.sessionDigest,evidenceDigests:current.evidenceDigests,state:"running",attempts:[...current.attempts,attempt],messagesUsed:current.messagesUsed,costUsd:current.costUsd,safeCode:"provider_marked",providerContacted:current.providerContacted,startedAt:current.startedAt,updatedAt:attempt.startedAt});});}
  #settle(current:IdeaLabBotRunV1,attemptId:string,attempt:IdeaLabBotAttemptV1,state:IdeaLabBotRunV1["state"],safeCode:string,updatedAt:string,providerContacted=current.providerContacted){const prior=current.attempts.at(-1);if(current.state!=="running"||!prior||prior.attemptId!==attemptId||prior.state!=="provider_marked")throw new IdeaLabErrorV1("state_conflict");const attempts=[...current.attempts.slice(0,-1),attempt];return buildIdeaLabBotRunV1({runId:current.runId,tenantId:current.tenantId,workspaceId:current.workspaceId,sessionId:current.sessionId,sessionDigest:current.sessionDigest,evidenceDigests:current.evidenceDigests,state,attempts,messagesUsed:attempts.filter(a=>a.state==="completed").length,costUsd:attempts.reduce((sum,a)=>sum+(a.state==="completed"?a.costUsd:0),0),safeCode,providerContacted,startedAt:current.startedAt,updatedAt});}
  async settleCompleted(runId:string,attemptId:string,receiptDigest:string,contributionDigest:string,costUsd:number,providerContacted:boolean,at:string){return this.#append(runId,current=>{const prior=current.attempts.at(-1)!;return this.#settle(current,attemptId,{...prior,state:"completed",receiptDigest,contributionDigest,costUsd,messagesUsed:1,settledAt:at},"running","turn_completed",at,current.providerContacted||providerContacted);});}
  async settleDefiniteFailure(runId:string,attemptId:string,safeCode:string,receiptDigest:string,at:string){return this.#append(runId,current=>{const prior=current.attempts.at(-1)!;return this.#settle(current,attemptId,{...prior,state:"failed_definite",receiptDigest,safeCode,settledAt:at},"failed_definite",safeCode,at);});}
  async markAmbiguous(runId:string,attemptId:string,safeCode:string,at:string){return this.#append(runId,current=>{const prior=current.attempts.at(-1)!;return this.#settle(current,attemptId,{...prior,state:"ambiguous",safeCode,settledAt:at},"ambiguous",safeCode,at);});}
  async cancel(runId:string,at:string){return this.#append(runId,current=>{if(current.state==="cancelled")return current;if(!["prepared","running"].includes(current.state)||current.attempts.at(-1)?.state==="provider_marked")throw new IdeaLabErrorV1("state_conflict");return buildIdeaLabBotRunV1({runId:current.runId,tenantId:current.tenantId,workspaceId:current.workspaceId,sessionId:current.sessionId,sessionDigest:current.sessionDigest,evidenceDigests:current.evidenceDigests,state:"cancelled",attempts:current.attempts,messagesUsed:current.messagesUsed,costUsd:current.costUsd,safeCode:"cancelled_before_provider",providerContacted:current.providerContacted,startedAt:current.startedAt,updatedAt:at});});}
  async failDefinite(runId:string,safeCode:string,at:string){return this.#append(runId,current=>{if(!["prepared","running"].includes(current.state)||current.attempts.at(-1)?.state==="provider_marked")throw new IdeaLabErrorV1("state_conflict");return buildIdeaLabBotRunV1({runId:current.runId,tenantId:current.tenantId,workspaceId:current.workspaceId,sessionId:current.sessionId,sessionDigest:current.sessionDigest,evidenceDigests:current.evidenceDigests,state:"failed_definite",attempts:current.attempts,messagesUsed:current.messagesUsed,costUsd:current.costUsd,safeCode,providerContacted:current.providerContacted,startedAt:current.startedAt,updatedAt:at});});}
  async complete(runId:string,at:string){return this.#append(runId,current=>{if(current.state==="cancelled")return current;if(current.state!=="running"||current.attempts.at(-1)?.state!=="completed")throw new IdeaLabErrorV1("state_conflict");return buildIdeaLabBotRunV1({runId:current.runId,tenantId:current.tenantId,workspaceId:current.workspaceId,sessionId:current.sessionId,sessionDigest:current.sessionDigest,evidenceDigests:current.evidenceDigests,state:current.cancellationRequestedAt?"cancelled":"completed",attempts:current.attempts,messagesUsed:current.messagesUsed,costUsd:current.costUsd,safeCode:current.cancellationRequestedAt?"cancelled_before_provider":"panel_completed",providerContacted:current.providerContacted,startedAt:current.startedAt,updatedAt:at});});}
  async recover(runId:string,at:string){const current=await this.get(runId);if(!current)throw new IdeaLabErrorV1("not_found");if(current.state!=="running")return current;const prior=current.attempts.at(-1);if(current.cancellationRequestedAt&&prior?.state==="completed")return this.cancel(runId,at);if(!prior||prior.state!=="provider_marked")throw new IdeaLabErrorV1("integrity_failed");return this.markAmbiguous(runId,prior.attemptId,"restart_after_provider_marker",at);}
}
