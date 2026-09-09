import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { SecurityStore, sha256Digest, type VerifiedAuthentication } from "../../security";
import { isHostProxyV1 } from "../../security/host-value";
import { buildIdeaLabSessionV1, parseIdeaLabSessionV1 } from "./contracts";
import { buildIdeaLabBotRunV1, buildRepositoryFakeProviderEvidenceV1, IdeaLabBotCoordinatorV1, type IdeaLabBotPanelDriverV1,
  type IdeaLabBotRunV1 } from "./coordinator";
import { IdeaLabBotRunStoreV1 } from "./coordinator-store";
import { IdeaLabErrorV1 } from "./errors";
import { buildIdeaLabOwnerPromptV1 } from "./discussion-prompt";
import { parseExactIdeaLabV1 } from "./exact";
import { capturedIdeaTimeFromMillisecondsV1, capturedIdeaTimeMillisecondsV1, capturedIdeaTimeNowV1,
  IDEA_LAB_SESSION_PROJECTION_V1,
  ideaIdSchemaV1, ideaLabSessionProjectionSchemaV1,
  ideaLabelSchemaV1, ideaParticipantSchemaV1, ideaTextSchemaV1, ideaTimeSchemaV1 } from "./schemas";
import { IdeaLabProjectRegistryStoreV1 } from "./store";
import type { IdeaLabParticipantV1, IdeaLabSessionProjectionV1, IdeaLabSynthesisV1 } from "./types";
import { DeterministicIdeaLabSynthesisEngineV1 } from "./synthesis-engine";
export { DeterministicIdeaLabSynthesisEngineV1 } from "./synthesis-engine";

const createInputSchema=z.object({commandId:ideaIdSchemaV1,title:ideaLabelSchemaV1,ideaSummary:ideaTextSchemaV1,
  targetCustomer:z.string().min(1).max(300),maxRounds:z.number().int().min(1).max(3),
  maxDurationSeconds:z.number().int().min(60).max(900),maxCostUsd:z.number().min(0).max(25),requestedAt:ideaTimeSchemaV1}).strict();
const commandInputSchema=z.object({commandId:ideaIdSchemaV1,sessionId:ideaIdSchemaV1,requestedAt:ideaTimeSchemaV1}).strict();

export class IdeaLabOperatorServiceErrorV1 extends Error {
  constructor(readonly safeCode:"invalid_operator_request"|"owner_forbidden"|"idea_not_found"|"state_conflict"|
    "operator_boundary_unavailable"){super(safeCode);this.name="IdeaLabOperatorServiceErrorV1";}
}

export class IdeaLabProtectedOperatorServiceV1 {
  readonly #security:SecurityStore;readonly #registry:IdeaLabProjectRegistryStoreV1;readonly #ledger:IdeaLabBotRunStoreV1;
  readonly #coordinator:IdeaLabBotCoordinatorV1;readonly #participants:IdeaLabParticipantV1[];readonly #synthesis=new DeterministicIdeaLabSynthesisEngineV1();
  readonly #workspaceId:string;readonly #clock:()=>string;
  constructor(db:DatabaseClient,integrityKey:Uint8Array,config:{workspaceId:string;participants:unknown[];
    driver:IdeaLabBotPanelDriverV1;clock?:()=>string}){
    if(!config||typeof config!=="object"||isHostProxyV1(config)||!Array.isArray(config.participants)
      ||!config.driver||typeof config.driver!=="object"||isHostProxyV1(config.driver)||config.driver.mode!=="repository_fake")throw new IdeaLabErrorV1("authorization_denied");
    this.#workspaceId=ideaIdSchemaV1.parse(config.workspaceId);this.#clock=config.clock??capturedIdeaTimeNowV1;
    this.#participants=config.participants.map(value=>parseExactIdeaLabV1(ideaParticipantSchemaV1,value));
    if(this.#participants.length<3||this.#participants.length>6||!this.#participants.some(item=>item.perspective==="skeptic"))throw new IdeaLabErrorV1("invalid_input");
    this.#security=new SecurityStore(db);this.#registry=new IdeaLabProjectRegistryStoreV1(db,integrityKey);
    this.#ledger=new IdeaLabBotRunStoreV1(db,integrityKey);this.#coordinator=new IdeaLabBotCoordinatorV1(this.#ledger,this.#registry,config.driver,config.clock);
  }
  #now(){return this.#clock();}
  #validateTime(requestedAt:string,now:string){const current=capturedIdeaTimeMillisecondsV1(now),requested=capturedIdeaTimeMillisecondsV1(requestedAt);if(current===undefined||requested===undefined||current-requested< -30_000||current-requested>300_000)throw new IdeaLabOperatorServiceErrorV1("invalid_operator_request");}
  async #authorize(authentication:VerifiedAuthentication,input:{decisionId:string;action:string;resourceId:string;occurredAt:string}){
    try{const decision=await this.#security.authorize({decisionId:input.decisionId,authentication,requiredRoleKey:"owner",requiredActorType:"human",request:{tenantId:authentication.tenantId,action:input.action,resourceType:"idea_lab_session",resourceId:input.resourceId,risk:"low",externalEffect:false,occurredAt:input.occurredAt}});if(!decision.allowed)throw new IdeaLabOperatorServiceErrorV1("owner_forbidden");return decision;}
    catch(error){if(error instanceof IdeaLabOperatorServiceErrorV1)throw error;throw new IdeaLabOperatorServiceErrorV1("operator_boundary_unavailable");}
  }
  async create(value:unknown,authentication:VerifiedAuthentication):Promise<IdeaLabSessionProjectionV1>{
    let input:z.infer<typeof createInputSchema>;try{input=parseExactIdeaLabV1(createInputSchema,value);}catch{throw new IdeaLabOperatorServiceErrorV1("invalid_operator_request");}
    const now=this.#now();this.#validateTime(input.requestedAt,now);const suffix=sha256Digest({tenantId:authentication.tenantId,commandId:input.commandId}).slice(7,31),sessionId=`idea-session:${suffix}`;
    const policy=await this.#authorize(authentication,{decisionId:`policy.idea.create:${suffix}`,action:"idea_lab.session_create",resourceId:sessionId,occurredAt:input.requestedAt});
    const session=buildIdeaLabSessionV1({sessionId,tenantId:authentication.tenantId,workspaceId:this.#workspaceId,title:input.title,
      ideaSummary:input.ideaSummary,targetCustomer:input.targetCustomer,participants:this.#participants,maxRounds:input.maxRounds,
      maxDurationSeconds:input.maxDurationSeconds,maxCostUsd:input.maxCostUsd,
      createdByIdentityDigest:sha256Digest({tenantId:authentication.tenantId,identityId:policy.identityId,purpose:"idea_lab_creator_v1"}),createdAt:input.requestedAt});
    try { buildIdeaLabOwnerPromptV1(session); } catch { throw new IdeaLabOperatorServiceErrorV1("invalid_operator_request"); }
    try{await this.#registry.registerSession(session);return this.project(session,undefined,undefined,undefined,session.createdAt);}
    catch(error){if(error instanceof IdeaLabErrorV1&&error.safeCode==="duplicate_record")throw new IdeaLabOperatorServiceErrorV1("state_conflict");throw new IdeaLabOperatorServiceErrorV1("operator_boundary_unavailable");}
  }
  async start(value:unknown,authentication:VerifiedAuthentication):Promise<IdeaLabSessionProjectionV1>{
    const {input,session,now}=await this.#command(value,authentication,"idea_lab.panel_start");
    const existingRun=await this.#ledger.get(this.runId(session));if(existingRun&&["completed","cancelled","failed_definite","ambiguous"].includes(existingRun.state))return this.current(session,existingRun,now);
    let safePrompt: string;
    try { safePrompt = buildIdeaLabOwnerPromptV1(session); } catch { throw new IdeaLabOperatorServiceErrorV1("invalid_operator_request"); }
    const expiry = capturedIdeaTimeFromMillisecondsV1(capturedIdeaTimeMillisecondsV1(input.requestedAt)! + 300_000);
    if (!expiry) throw new IdeaLabOperatorServiceErrorV1("invalid_operator_request");
    const evidence=session.participants.map((participant,index)=>buildRepositoryFakeProviderEvidenceV1(session,participant,{evidenceId:`evidence.idea:${sha256Digest({commandId:input.commandId,index}).slice(7,31)}`,capturedAt:input.requestedAt,expiresAt:expiry}));
    try{const run=await this.#coordinator.execute({runId:this.runId(session),session,evidence,safePrompt});return this.current(session,run,now);}
    catch(error){if(error instanceof IdeaLabErrorV1&&["duplicate_record","state_conflict"].includes(error.safeCode))throw new IdeaLabOperatorServiceErrorV1("state_conflict");throw new IdeaLabOperatorServiceErrorV1("operator_boundary_unavailable");}
  }
  async cancel(value:unknown,authentication:VerifiedAuthentication):Promise<IdeaLabSessionProjectionV1>{
    const {session,now}=await this.#command(value,authentication,"idea_lab.panel_cancel");let run=await this.#ledger.get(this.runId(session));
    if(!run)run=await this.#ledger.prepare(buildIdeaLabBotRunV1({runId:this.runId(session),tenantId:session.tenantId,workspaceId:session.workspaceId,
      sessionId:session.sessionId,sessionDigest:session.sessionDigest,evidenceDigests:session.participants.map(participant=>sha256Digest({sessionDigest:session.sessionDigest,participantId:participant.participantId,purpose:"cancelled_before_evidence"})).sort(),
      state:"prepared",attempts:[],messagesUsed:0,costUsd:0,safeCode:"prepared",providerContacted:false,startedAt:now,updatedAt:now}));let cancelled:IdeaLabBotRunV1;
    try{const requested=await this.#ledger.requestCancel(run.runId,now);
      cancelled=requested.attempts.at(-1)?.state==="provider_marked"||!["prepared","running"].includes(requested.state)
        ?requested:await this.#ledger.cancel(run.runId,now);
    }catch{throw new IdeaLabOperatorServiceErrorV1("state_conflict");}
    return this.current(session,cancelled,now);
  }
  async synthesize(value:unknown,authentication:VerifiedAuthentication):Promise<IdeaLabSessionProjectionV1>{
    const {session,now}=await this.#command(value,authentication,"idea_lab.synthesize"),run=await this.#ledger.get(this.runId(session));
    if(!run||run.state!=="completed")throw new IdeaLabOperatorServiceErrorV1("state_conflict");const contributions=await this.#registry.listContributions(session.tenantId,session.sessionId);
    const existing=await this.#registry.getSynthesis(session.tenantId,session.sessionId);if(existing)return this.project(session,run,existing,await this.#registry.getDecision(session.tenantId,session.sessionId),now);
    try{await this.#registry.recordSynthesis(this.#synthesis.build(session,contributions,now));return this.current(session,run,now);}
    catch{throw new IdeaLabOperatorServiceErrorV1("operator_boundary_unavailable");}
  }
  async list(authentication:VerifiedAuthentication):Promise<IdeaLabSessionProjectionV1[]>{
    const now=this.#now();try{await this.#security.authorizeRead({authentication,requiredRoleKey:"owner",request:{tenantId:authentication.tenantId,
      action:"idea_lab.session_list",resourceType:"idea_lab_session_catalog",resourceId:this.#workspaceId,risk:"low",externalEffect:false,occurredAt:now}});
    }catch{throw new IdeaLabOperatorServiceErrorV1("owner_forbidden");}
    try{const sessions=await this.#registry.listSessions(authentication.tenantId,this.#workspaceId);return await Promise.all(sessions.map(session=>this.current(session)));
    }catch{throw new IdeaLabOperatorServiceErrorV1("operator_boundary_unavailable");}
  }
  async get(sessionIdValue:unknown,authentication:VerifiedAuthentication):Promise<IdeaLabSessionProjectionV1>{
    let sessionId:string;try{sessionId=ideaIdSchemaV1.parse(sessionIdValue);}catch{throw new IdeaLabOperatorServiceErrorV1("invalid_operator_request");}
    const now=this.#now();try{await this.#security.authorizeRead({authentication,requiredRoleKey:"owner",request:{tenantId:authentication.tenantId,
      action:"idea_lab.session_read",resourceType:"idea_lab_session",resourceId:sessionId,risk:"low",externalEffect:false,occurredAt:now}});
    }catch{throw new IdeaLabOperatorServiceErrorV1("owner_forbidden");}
    let session;try{session=await this.#registry.getSession(authentication.tenantId,sessionId);}catch{throw new IdeaLabOperatorServiceErrorV1("operator_boundary_unavailable");}
    if(!session)throw new IdeaLabOperatorServiceErrorV1("idea_not_found");return this.current(session);
  }
  async #command(value:unknown,authentication:VerifiedAuthentication,action:string){let input:z.infer<typeof commandInputSchema>;
    try{input=parseExactIdeaLabV1(commandInputSchema,value);}catch{throw new IdeaLabOperatorServiceErrorV1("invalid_operator_request");}
    const now=this.#now();this.#validateTime(input.requestedAt,now);const session=await this.#registry.getSession(authentication.tenantId,input.sessionId);if(!session)throw new IdeaLabOperatorServiceErrorV1("idea_not_found");
    const suffix=sha256Digest({tenantId:authentication.tenantId,commandId:input.commandId,action,sessionDigest:session.sessionDigest}).slice(7,31);
    await this.#authorize(authentication,{decisionId:`policy.idea.command:${suffix}`,action,resourceId:session.sessionId,occurredAt:input.requestedAt});return{input,session,now};}
  runId(session:{sessionDigest:string}){return`idea-run:${session.sessionDigest.slice(7,31)}`;}
  async current(sessionValue:unknown,run?:IdeaLabBotRunV1,updatedAt?:string){const session=parseIdeaLabSessionV1(sessionValue),actualRun=run??await this.#ledger.get(this.runId(session)),synthesis=await this.#registry.getSynthesis(session.tenantId,session.sessionId),decision=await this.#registry.getDecision(session.tenantId,session.sessionId);return this.project(session,actualRun,synthesis,decision,updatedAt??decision?.decidedAt??synthesis?.synthesizedAt??actualRun?.updatedAt??session.createdAt);}
  project(session:ReturnType<typeof parseIdeaLabSessionV1>,run:IdeaLabBotRunV1|undefined,synthesis:IdeaLabSynthesisV1|undefined,decision:Awaited<ReturnType<IdeaLabProjectRegistryStoreV1["getDecision"]>>,updatedAt:string):IdeaLabSessionProjectionV1{
    const state=decision?"decided":synthesis?"synthesized":run?.state==="completed"?"panel_complete":run?.state==="prepared"?"ready":run?.state??"ready";
    const material={contractVersion:IDEA_LAB_SESSION_PROJECTION_V1,tenantId:session.tenantId,workspaceId:session.workspaceId,sessionId:session.sessionId,sessionDigest:session.sessionDigest,title:session.title,ideaSummary:session.ideaSummary,targetCustomer:session.targetCustomer,state,
      participantCount:session.participants.length,contributionCount:run?.messagesUsed??0,messagesUsed:run?.messagesUsed??0,costUsd:run?.costUsd??0,
      ...(run?{runId:run.runId,runDigest:run.runDigest}:{}),...(synthesis?{synthesisDigest:synthesis.synthesisDigest}:{}),...(decision?{decisionDigest:decision.decisionDigest,...(decision.project?{projectId:decision.project.projectId}:{})}:{}),
      safeStatusCode:decision?"owner_decided":synthesis?"synthesis_ready":run?.safeCode??"ready_for_panel",retryPermitted:false as const,
      liveProviderConfigured:false as const,providerContacted:false as const,grantsApproval:false as const,grantsCommandAuthority:false as const,
      grantsLeaseAuthority:false as const,grantsExecutionAuthority:false as const,automaticProjectCreationAllowed:false as const,updatedAt};
    return ideaLabSessionProjectionSchemaV1.parse({...material,projectionDigest:sha256Digest(material)});
  }
}
