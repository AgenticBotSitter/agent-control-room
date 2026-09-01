"use client";

import { useEffect,useRef,useState } from "react";

interface VisibleProjectEventV1{eventId:string;projectId:string;sequence:number;eventKind:string;safeSummary:string;
  safeDetail?:string;tone:"neutral"|"good"|"warn"|"bad";occurredAt:string;deepLinkPath?:string;}
type ConnectionState="connecting"|"live"|"caught_up"|"reconnecting"|"unavailable";

function visible(value:unknown,projectId:string):VisibleProjectEventV1|undefined{
  if(!value||typeof value!=="object"||Array.isArray(value))return undefined;const item=value as Record<string,unknown>;
  if(item.schemaVersion!=="control-room-project-event/v1"||item.projectId!==projectId||typeof item.eventId!=="string"
    ||typeof item.sequence!=="number"||!Number.isSafeInteger(item.sequence)||item.sequence<1||typeof item.eventKind!=="string"
    ||typeof item.safeSummary!=="string"||item.safeSummary.length<1||item.safeSummary.length>180
    ||(item.safeDetail!==undefined&&(typeof item.safeDetail!=="string"||item.safeDetail.length>800))
    ||!["neutral","good","warn","bad"].includes(String(item.tone))||typeof item.occurredAt!=="string")return undefined;
  if(item.deepLinkPath!==undefined&&(typeof item.deepLinkPath!=="string"||!item.deepLinkPath.startsWith("/")||item.deepLinkPath.startsWith("//")))return undefined;
  return item as unknown as VisibleProjectEventV1;
}
function label(value:string):string{return value.replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());}

export function ProjectLiveActivity({projectId}:{projectId:string}){
  const[events,setEvents]=useState<VisibleProjectEventV1[]>([]),[state,setState]=useState<ConnectionState>("connecting"),[generation,retry]=useState(0);
  const failedCycles=useRef(0),receivedHead=useRef(false);
  useEffect(()=>{let active=true;failedCycles.current=0;receivedHead.current=false;
    const source=new EventSource(`/api/v1/projects/${encodeURIComponent(projectId)}/events?limit=100`);
    source.onopen=()=>{if(active)setState("live");};
    source.addEventListener("project.event",event=>{if(!active)return;let parsed:unknown;try{parsed=JSON.parse((event as MessageEvent).data);}catch{return;}
      const item=visible(parsed,projectId);if(!item)return;setEvents(current=>[...current.filter(candidate=>candidate.eventId!==item.eventId),item]
        .sort((left,right)=>left.sequence-right.sequence).slice(-100));});
    source.addEventListener("stream.reset",()=>{if(active){setEvents([]);setState("reconnecting");}});
    source.addEventListener("stream.head",()=>{receivedHead.current=true;failedCycles.current=0;if(active)setState("caught_up");});
    source.onerror=()=>{if(!active)return;if(receivedHead.current){receivedHead.current=false;setState("reconnecting");return;}
      failedCycles.current+=1;if(failedCycles.current>=3){source.close();setState("unavailable");}else setState("reconnecting");};
    return()=>{active=false;source.close();};
  },[projectId,generation]);
  return <section className="detail-card project-live-activity" aria-labelledby="project-live-activity-title">
    <header><div><p className="eyebrow">Protected live source</p><h2 id="project-live-activity-title">Live project activity</h2></div>
      <span className={`live-stream-state state-${state}`}>{label(state)}</span></header>
    <p className="project-live-boundary">Read-only, resumable event projection. Reconnect never approves, dispatches, retries work, or changes project truth.</p>
    {events.length?<ol className="project-live-event-list">{[...events].reverse().map(event=><li key={event.eventId} className={`tone-${event.tone}`}>
      <time>{new Date(event.occurredAt).toLocaleString("en-US")}</time><div><span>{label(event.eventKind)}</span><strong>{event.safeSummary}</strong>
      {event.safeDetail?<p>{event.safeDetail}</p>:null}{event.deepLinkPath?<a href={event.deepLinkPath}>Open related project view →</a>:null}</div></li>)}</ol>
      :<p className="empty-state">{state==="unavailable"?"The protected live-event source is not configured or this session is not authenticated.":"Waiting for authenticated project events."}</p>}
    {state==="unavailable"?<button type="button" onClick={()=>{setState("connecting");retry(value=>value+1);}}>Try connection again</button>:null}
  </section>;
}
