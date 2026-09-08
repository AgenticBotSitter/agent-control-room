import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {adaptPglite} from '../../src/persistence/database.ts';
import {sha256Digest} from '../../src/security/index.ts';
import {buildIdeaLabFixtureV1,buildIdeaLabSessionV1,buildRepositoryFakeProviderEvidenceV1,IdeaLabBotCoordinatorV1,IdeaLabBotRunStoreV1,IdeaLabProjectRegistryStoreV1,DeterministicIdeaLabFakeDriverV1} from '../../src/idea-lab/v1/index.ts';
const root=process.argv[2],python=process.argv[3];assert.match(root,/^\/private\/tmp\/control-room-f4planner\.[A-Za-z0-9]+$/);
const now='2026-08-31T16:00:30.000Z',expiresAt='2026-08-31T16:10:30.000Z',key=new Uint8Array(32).fill(81);
const raw=new PGlite();const outcomes=[];
try{
 for(const f of(await readdir('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await raw.exec(await readFile(`db/migrations/${f}`,'utf8'));
 await raw.exec("INSERT INTO tenants(id,display_name) VALUES('tenant:owner','Synthetic'); INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:control-room','tenant:owner','Synthetic')");
 const db=adaptPglite(raw),ledger=new IdeaLabBotRunStoreV1(db,key),registry=new IdeaLabProjectRegistryStoreV1(db,key),base=buildIdeaLabFixtureV1().session;
 for(const count of[3,6])for(const rounds of[1,2,3])for(const adapted of[false,true]){
  const id=`planner:${count}:${rounds}:${adapted}`;
  const perspectives=['customer','market','skeptic','operations','technology','finance'] as const;
  const participants=perspectives.slice(0,count).map((perspective,i)=>({...base.participants[0],participantId:`bot:${perspective}`,identityDigest:sha256Digest(perspective),displayName:`Person ${i}`,perspective}));
  const session=buildIdeaLabSessionV1({sessionId:id,tenantId:base.tenantId,workspaceId:base.workspaceId,title:'Synthetic',ideaSummary:'Synthetic idea',targetCustomer:'Synthetic customer',participants,maxRounds:rounds,maxDurationSeconds:600,maxCostUsd:4,createdByIdentityDigest:base.createdByIdentityDigest,createdAt:base.createdAt});
  await registry.registerSession(session);
  const room={room_id:id,name:'Synthetic',authority_gateway_id:'synthetic-gateway',authority_epoch:1,members:participants.map(p=>({member_id:p.participantId,profile:p.perspective,handle:p.perspective}))};
  const events:unknown[]=[{room_id:id,seq:1,event_id:'user-1',kind:'message.user',actor:{kind:'user',id:'synthetic'},payload:{text:'Evaluate synthetic idea.',thread_id:id}}];
  let calls=0;const mappings:unknown[]=[];const fake=new DeterministicIdeaLabFakeDriverV1();const began=performance.now();
  const coordinator=new IdeaLabBotCoordinatorV1(ledger,registry,{mode:'repository_fake',async invoke(input){
    const result=await fake.invoke(input);
    const peer=spawnSync(python,['-B','research/reuse-comparisons/f4-planner-peer.py',root],{input:JSON.stringify({adapted,count,rounds,room,events,opinion:result.outcome==='completed'?result.safeOpinion:'failed'}),encoding:'utf8',timeout:2000,maxBuffer:262144});
    if(peer.status!==0)throw Error(`harness failure: ${peer.stderr}`);
    const plan=JSON.parse(peer.stdout);calls++;
    mappings.push({currentParticipant:input.participant.participantId,currentRound:input.round,candidateParticipant:plan.participantId,candidateRound:plan.round,status:plan.status,promptLength:plan.promptLength});
    if(plan.status!=='task'||plan.participantId!==input.participant.participantId||plan.round!==input.round)throw Error('candidate scheduling mismatch');
    assert.ok(input.safePrompt.length<=800);events.push(...plan.events);return result;
  }},()=>now);
  const evidence=session.participants.map((p,i)=>buildRepositoryFakeProviderEvidenceV1(session,p,{evidenceId:`evidence:${id}:${i}`,capturedAt:now,expiresAt}));
  const run=await coordinator.execute({runId:id,session,evidence,safePrompt:'Evaluate synthetic idea.'});
  const priorCalls=calls;const replay=await coordinator.execute({runId:id,session,evidence,safePrompt:'Evaluate synthetic idea.'});assert.equal(calls,priorCalls);assert.equal(replay.runDigest,run.runDigest);
  if(adapted||rounds===1){assert.equal(run.state,'completed');assert.equal(run.messagesUsed,count*rounds);}else assert.equal(run.state,'ambiguous');
  const contributions=(await registry.listContributions(session.tenantId,id)).length;
  assert.equal(contributions,adapted||rounds===1?count*rounds:count);
  outcomes.push({count,rounds,adapted,state:run.state,messagesUsed:run.messagesUsed,calls,contributions,replayNoCalls:true,mappings,elapsedMs:performance.now()-began});
 }
 console.log(JSON.stringify({outcomes,providerCalls:0,realCoordinatorAndStores:true,upstreamPurePlanner:true,sqliteUsed:false,db:'disposable PGlite current migrations',maxRSSKiB:process.resourceUsage().maxRSS},null,2));
}finally{await raw.close();}
