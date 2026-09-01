"use client";
import { useState } from "react";

function command(){return{commandId:`command.idea:${crypto.randomUUID()}`,requestedAt:new Date().toISOString()};}
function projectId(title:string){const slug=title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,90)||"new-idea";return`project:${slug}`;}
export function IdeaLabOperatorControls({enabled=false}:{enabled?:boolean}){
  const[title,setTitle]=useState(""),[summary,setSummary]=useState(""),[customer,setCustomer]=useState(""),[sessionId,setSessionId]=useState<string>(),[status,setStatus]=useState(enabled?"Ready for protected idea intake.":"Protected runtime not configured. Controls are safely disabled."),[busy,setBusy]=useState(false);
  async function send(path:string,body:unknown){setBusy(true);try{const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),payload=await response.json() as{error?:string;session?:{sessionId:string;state:string;projectId?:string}};if(!response.ok)throw new Error(payload.error??"request_failed");if(payload.session?.sessionId)setSessionId(payload.session.sessionId);setStatus(payload.session?.projectId?`Project ${payload.session.projectId} created.`:`Session ${payload.session?.state??"updated"}.`);}catch(error){setStatus(error instanceof Error?error.message:"request_failed");}finally{setBusy(false);}}
  const unavailable=!enabled||busy;
  return <section className="idea-lab-operator" aria-labelledby="idea-lab-operator-title"><div><p className="eyebrow">Protected owner workflow</p><h2 id="idea-lab-operator-title">Start a new business-idea panel</h2><p>Control Room selects the distinct panel identities. Creating the session, running the panel, synthesizing advice, and making the owner decision are separate recorded steps.</p></div>
    <form onSubmit={event=>{event.preventDefault();void send("/api/v1/idea-lab/sessions",{...command(),title,ideaSummary:summary,targetCustomer:customer,maxRounds:1,maxDurationSeconds:300,maxCostUsd:2});}}>
      <label>Idea title<input value={title} onChange={event=>setTitle(event.target.value)} disabled={!enabled} required maxLength={120}/></label>
      <label>What is the idea?<textarea value={summary} onChange={event=>setSummary(event.target.value)} disabled={!enabled} required maxLength={800}/></label>
      <label>Who is it for?<input value={customer} onChange={event=>setCustomer(event.target.value)} disabled={!enabled} required maxLength={300}/></label>
      <div className="idea-lab-command-row"><button type="submit" disabled={unavailable}>Create session</button><button type="button" disabled={unavailable||!sessionId} onClick={()=>void send(`/api/v1/idea-lab/sessions/${encodeURIComponent(sessionId!)}/start`,command())}>Run bounded panel</button><button type="button" disabled={unavailable||!sessionId} onClick={()=>void send(`/api/v1/idea-lab/sessions/${encodeURIComponent(sessionId!)}/synthesis`,command())}>Synthesize</button><button type="button" disabled={unavailable||!sessionId} onClick={()=>void send(`/api/v1/idea-lab/sessions/${encodeURIComponent(sessionId!)}/cancel`,command())}>Cancel</button></div>
      <div className="idea-lab-command-row"><button type="button" disabled={unavailable||!sessionId} onClick={()=>void send(`/api/v1/idea-lab/sessions/${encodeURIComponent(sessionId!)}/decision`,{decision:"save",safeReasonCode:"owner_saved_for_later"})}>Save idea</button><button type="button" disabled={unavailable||!sessionId} onClick={()=>void send(`/api/v1/idea-lab/sessions/${encodeURIComponent(sessionId!)}/decision`,{decision:"create_project",safeReasonCode:"owner_promoted_for_validation",project:{projectId:projectId(title),workspaceName:title,title:`Validate ${title}`,summary,projectKind:"business_validation",priority:60}})}>Create monitored project</button></div>
      <p role="status">{status}</p>
    </form>
  </section>;
}
