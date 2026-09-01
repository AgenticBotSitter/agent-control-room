import { timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { dataMethodV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { parseExactProjectWorkspaceV1 } from "../../project-workspace/v1";
import {
  buildProjectEventPageV1,
  buildProjectEventV1,
  decodeProjectEventCursorV1,
  encodeProjectEventCursorV1,
  parseProjectEventInputV1,
  parseProjectEventV1,
} from "./contracts";
import { ProjectEventErrorV1 } from "./errors";
import { projectEventReadRequestSchemaV1 } from "./schemas";
import { PROJECT_EVENT_INPUT_V1,type ProjectEventPageV1,type ProjectEventReadRequestV1,type ProjectEventV1 } from "./types";

type Query = DatabaseSession["query"];
type Transaction = DatabaseClient["transaction"];
interface HeadRow { tenant_id:string;workspace_id:string;project_id:string;last_sequence:number|string;
  last_event_digest:string|null;head_auth_tag:string;updated_at:string|Date; }
interface EventRow { tenant_id:string;workspace_id:string;project_id:string;sequence:number|string;event_id:string;
  event_kind:string;source_kind:string;source_id:string;source_version:string;source_event_key_digest:string;
  source_payload_digest:string;previous_event_digest:string|null;event_digest:string;event_auth_tag:string;
  occurred_at:string|Date;recorded_at:string|Date;payload:unknown; }

const eventColumns=`tenant_id,workspace_id,project_id,sequence,event_id,event_kind,source_kind,source_id,source_version,
  source_event_key_digest,source_payload_digest,previous_event_digest,event_digest,event_auth_tag,occurred_at,recorded_at,payload`;
const headColumns="tenant_id,workspace_id,project_id,last_sequence,last_event_digest,head_auth_tag,updated_at";

function iso(value:string|Date):string{return typeof value==="string"?new Date(value).toISOString():value.toISOString();}
function same(left:string,right:string):boolean{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function headMaterial(row:Omit<HeadRow,"head_auth_tag">){return{tenantId:row.tenant_id,workspaceId:row.workspace_id,
  projectId:row.project_id,lastSequence:Number(row.last_sequence),lastEventDigest:row.last_event_digest,updatedAt:iso(row.updated_at)};}
function eventMaterial(row:Omit<EventRow,"event_auth_tag"|"payload">){return{tenantId:row.tenant_id,workspaceId:row.workspace_id,
  projectId:row.project_id,sequence:Number(row.sequence),eventId:row.event_id,eventKind:row.event_kind,sourceKind:row.source_kind,
  sourceId:row.source_id,sourceVersion:row.source_version,sourceEventKeyDigest:row.source_event_key_digest,
  sourcePayloadDigest:row.source_payload_digest,previousEventDigest:row.previous_event_digest,eventDigest:row.event_digest,
  occurredAt:iso(row.occurred_at),recordedAt:iso(row.recorded_at)};}

export class ProjectEventStoreV1 {
  readonly #query:Query;readonly #transaction:Transaction;readonly #key:Uint8Array;readonly #clock:()=>string;
  constructor(db:DatabaseClient,integrityKeyValue:unknown,clock:()=>string=()=>new Date().toISOString()){
    if(!db||typeof db!=="object"||isHostProxyV1(db)||typeof clock!=="function"||isHostProxyV1(clock))throw new ProjectEventErrorV1("invalid_input");
    const query=dataMethodV1(db,"query") as Query|undefined,transaction=dataMethodV1(db,"transaction") as Transaction|undefined;
    const key=exactHostUint8ArrayV1(integrityKeyValue,128);
    if(!query||!transaction||!key||key.byteLength!==32)throw new ProjectEventErrorV1("invalid_input");
    this.#query=((statement,params)=>query.call(db,statement,params))as Query;
    this.#transaction=((callback)=>transaction.call(db,callback))as Transaction;
    this.#key=key.copy();this.#clock=clock;Object.freeze(this);
  }

  #headTag(row:Omit<HeadRow,"head_auth_tag">):string{return hmacSha256Tag(this.#key,{kind:"project_event_head",...headMaterial(row)});}
  #eventTag(row:Omit<EventRow,"event_auth_tag"|"payload">):string{return hmacSha256Tag(this.#key,{kind:"project_event",...eventMaterial(row)});}
  #verifiedHead(row:HeadRow,scope:{tenantId:string;workspaceId:string;projectId:string}):HeadRow{
    if(row.tenant_id!==scope.tenantId||row.workspace_id!==scope.workspaceId||row.project_id!==scope.projectId
      ||!same(row.head_auth_tag,this.#headTag(row)))throw new ProjectEventErrorV1("integrity_failed");return row;
  }
  #verifiedEvent(row:EventRow,scope:{tenantId:string;workspaceId:string;projectId:string}):ProjectEventV1{
    let event:ProjectEventV1;try{event=parseProjectEventV1(row.payload);}catch{throw new ProjectEventErrorV1("integrity_failed");}
    const columnsMatch=row.tenant_id===scope.tenantId&&row.workspace_id===scope.workspaceId&&row.project_id===scope.projectId
      &&event.tenantId===row.tenant_id&&event.workspaceId===row.workspace_id&&event.projectId===row.project_id
      &&event.sequence===Number(row.sequence)&&event.eventId===row.event_id&&event.eventKind===row.event_kind
      &&event.source.kind===row.source_kind&&event.source.sourceId===row.source_id&&event.source.sourceVersion===row.source_version
      &&event.source.sourceEventKeyDigest===row.source_event_key_digest;
    const sourceInput={schemaVersion:PROJECT_EVENT_INPUT_V1,tenantId:event.tenantId,workspaceId:event.workspaceId,
      projectId:event.projectId,eventId:event.eventId,eventKind:event.eventKind,source:event.source,subject:event.subject,
      safeSummary:event.safeSummary,...(event.safeDetail!==undefined?{safeDetail:event.safeDetail}:{}),tone:event.tone,
      ...(event.deepLinkPath!==undefined?{deepLinkPath:event.deepLinkPath}:{}),occurredAt:event.occurredAt,
      presentationOnly:event.presentationOnly,grantsApproval:event.grantsApproval,
      grantsCommandAuthority:event.grantsCommandAuthority,grantsExecutionAuthority:event.grantsExecutionAuthority};
    if(!columnsMatch||sha256Digest(sourceInput)!==row.source_payload_digest||event.previousEventDigest!==row.previous_event_digest
      ||event.eventDigest!==row.event_digest||event.occurredAt!==iso(row.occurred_at)||event.recordedAt!==iso(row.recorded_at)
      ||!same(row.event_auth_tag,this.#eventTag(row)))throw new ProjectEventErrorV1("integrity_failed");return event;
  }

  async append(inputValue:unknown):Promise<{event:ProjectEventV1;replayed:boolean}>{
    const input=parseProjectEventInputV1(inputValue),clockValue=this.#clock(),recorded=Date.parse(clockValue),occurred=Date.parse(input.occurredAt);
    if(!Number.isFinite(recorded)||occurred>recorded+30_000)throw new ProjectEventErrorV1("invalid_input");
    const recordedAt=new Date(recorded).toISOString();
    const sourcePayloadDigest=sha256Digest(input),scope={tenantId:input.tenantId,workspaceId:input.workspaceId,projectId:input.projectId};
    try{return await this.#transaction(async tx=>{
      const project=await tx.query<{workspace_id:string}>(`SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2`,[input.tenantId,input.projectId]);
      if(!project.rows[0]||project.rows[0].workspace_id!==input.workspaceId)throw new ProjectEventErrorV1("project_not_found");
      const origin:Omit<HeadRow,"head_auth_tag">={tenant_id:input.tenantId,workspace_id:input.workspaceId,project_id:input.projectId,
        last_sequence:0,last_event_digest:null,updated_at:recordedAt};
      await tx.query(`INSERT INTO control_project_event_stream_heads(tenant_id,workspace_id,project_id,last_sequence,last_event_digest,
        head_auth_tag,updated_at) VALUES($1,$2,$3,0,NULL,$4,$5) ON CONFLICT (tenant_id,project_id) DO NOTHING`,
      [input.tenantId,input.workspaceId,input.projectId,this.#headTag(origin),recordedAt]);
      const selected=await tx.query<HeadRow>(`SELECT ${headColumns} FROM control_project_event_stream_heads
        WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`,[input.tenantId,input.projectId]);
      const head=selected.rows[0];if(!head)throw new ProjectEventErrorV1("source_unavailable");this.#verifiedHead(head,scope);
      const prior=await tx.query<EventRow>(`SELECT ${eventColumns} FROM control_project_events WHERE tenant_id=$1 AND project_id=$2
        AND (source_event_key_digest=$3 OR event_id=$4)`,[input.tenantId,input.projectId,input.source.sourceEventKeyDigest,input.eventId]);
      if(prior.rows[0]){const event=this.#verifiedEvent(prior.rows[0],scope);if(prior.rows[0].source_payload_digest!==sourcePayloadDigest)
        throw new ProjectEventErrorV1("replay_conflict");return{event,replayed:true};}
      const sequence=Number(head.last_sequence)+1,event=buildProjectEventV1(input,sequence,head.last_event_digest,recordedAt);
      const eventRow:Omit<EventRow,"event_auth_tag"|"payload">={tenant_id:input.tenantId,workspace_id:input.workspaceId,
        project_id:input.projectId,sequence,event_id:event.eventId,event_kind:event.eventKind,source_kind:event.source.kind,
        source_id:event.source.sourceId,source_version:event.source.sourceVersion,source_event_key_digest:event.source.sourceEventKeyDigest,
        source_payload_digest:sourcePayloadDigest,previous_event_digest:event.previousEventDigest,event_digest:event.eventDigest,
        occurred_at:event.occurredAt,recorded_at:event.recordedAt};
      await tx.query(`INSERT INTO control_project_events(${eventColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [input.tenantId,input.workspaceId,input.projectId,sequence,event.eventId,event.eventKind,event.source.kind,event.source.sourceId,
        event.source.sourceVersion,event.source.sourceEventKeyDigest,sourcePayloadDigest,event.previousEventDigest,event.eventDigest,
        this.#eventTag(eventRow),event.occurredAt,event.recordedAt,JSON.stringify(event)]);
      const next:Omit<HeadRow,"head_auth_tag">={...origin,last_sequence:sequence,last_event_digest:event.eventDigest,updated_at:recordedAt};
      await tx.query(`UPDATE control_project_event_stream_heads SET last_sequence=$1,last_event_digest=$2,head_auth_tag=$3,updated_at=$4
        WHERE tenant_id=$5 AND project_id=$6`,[sequence,event.eventDigest,this.#headTag(next),recordedAt,input.tenantId,input.projectId]);
      return{event,replayed:false};
    });}catch(error){if(error instanceof ProjectEventErrorV1)throw error;throw new ProjectEventErrorV1("source_unavailable");}
  }

  async read(requestValue:ProjectEventReadRequestV1):Promise<ProjectEventPageV1>{
    let request:ProjectEventReadRequestV1;try{request=parseExactProjectWorkspaceV1(projectEventReadRequestSchemaV1,requestValue);}
    catch{throw new ProjectEventErrorV1("invalid_input");}
    const scope={tenantId:request.tenantId,workspaceId:request.workspaceId,projectId:request.projectId};
    const project=await this.#query<{workspace_id:string}>(`SELECT workspace_id FROM projects WHERE tenant_id=$1 AND id=$2`,[request.tenantId,request.projectId]);
    if(!project.rows[0]||project.rows[0].workspace_id!==request.workspaceId)throw new ProjectEventErrorV1("project_not_found");
    const selected=await this.#query<HeadRow>(`SELECT ${headColumns} FROM control_project_event_stream_heads WHERE tenant_id=$1 AND project_id=$2`,
      [request.tenantId,request.projectId]);
    if(!selected.rows[0])return buildProjectEventPageV1({...scope,mode:"snapshot",events:[],nextCursor:null,hasMore:false,truncatedBefore:false});
    const head=this.#verifiedHead(selected.rows[0],scope),cursor=request.afterCursor?decodeProjectEventCursorV1(request.afterCursor):undefined;
    let mode:"snapshot"|"replay"|"reset"=request.afterCursor?"replay":"snapshot",after=0,cursorDigest:string|null=null;
    if(request.afterCursor){
      if(!cursor||cursor.projectId!==request.projectId||cursor.sequence>Number(head.last_sequence)){mode="reset";}
      else{const row=await this.#query<EventRow>(`SELECT ${eventColumns} FROM control_project_events WHERE tenant_id=$1 AND project_id=$2 AND sequence=$3`,
        [request.tenantId,request.projectId,cursor.sequence]);
        if(!row.rows[0]||this.#verifiedEvent(row.rows[0],scope).eventDigest!==cursor.eventDigest)mode="reset";
        else{after=cursor.sequence;cursorDigest=cursor.eventDigest;}}
    }
    const descending=mode!=="replay";
    const rows=await this.#query<EventRow>(descending
      ?`SELECT ${eventColumns} FROM control_project_events WHERE tenant_id=$1 AND project_id=$2 ORDER BY sequence DESC LIMIT $3`
      :`SELECT ${eventColumns} FROM control_project_events WHERE tenant_id=$1 AND project_id=$2 AND sequence>$3 ORDER BY sequence ASC LIMIT $4`,
    descending?[request.tenantId,request.projectId,request.limit+1]:[request.tenantId,request.projectId,after,request.limit+1]);
    const more=rows.rows.length>request.limit,selectedRows=rows.rows.slice(0,request.limit),ordered=descending?selectedRows.reverse():selectedRows;
    const events=ordered.map(row=>this.#verifiedEvent(row,scope));
    let previous=mode==="replay"?cursorDigest:events[0]?.previousEventDigest??null;
    for(const event of events){if(event.previousEventDigest!==previous)throw new ProjectEventErrorV1("integrity_failed");previous=event.eventDigest;}
    if(!more){const finalSequence=events.at(-1)?.sequence??(mode==="replay"?after:0),finalDigest=events.at(-1)?.eventDigest??(mode==="replay"?cursorDigest:null);
      if(finalSequence!==Number(head.last_sequence)||finalDigest!==head.last_event_digest)throw new ProjectEventErrorV1("integrity_failed");}
    const nextCursor=events.length?encodeProjectEventCursorV1(events.at(-1)!):(mode==="replay"?request.afterCursor??null:null);
    return buildProjectEventPageV1({...scope,mode,events,nextCursor,hasMore:more,
      truncatedBefore:descending&&(more||(events[0]?.sequence??1)>1)});
  }
}
