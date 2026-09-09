import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { SecurityStore,sha256Digest,type VerifiedAuthentication } from "../../security";
import { parseExactIdeaLabV1 } from "./exact";
import { IdeaLabErrorV1 } from "./errors";
import { capturedIdeaTimeMillisecondsV1,capturedIdeaTimeNowV1,ideaIdSchemaV1,ideaTimeSchemaV1 } from "./schemas";
import { IdeaLabProjectRegistryStoreV1 } from "./store";
import type { ProjectRegistryProjectionV1 } from "./types";

export const ideaLabProjectLifecycleActionsV1=Object.freeze(["pause","resume","complete","archive","reopen"] as const);
const inputSchema=z.object({commandId:ideaIdSchemaV1,projectId:ideaIdSchemaV1,
  expectedVersion:z.number().int().min(1),action:z.enum(ideaLabProjectLifecycleActionsV1),requestedAt:ideaTimeSchemaV1}).strict();
const target={pause:"paused",resume:"active",complete:"completed",archive:"archived",reopen:"active"} as const;

export class IdeaLabProjectLifecycleServiceErrorV1 extends Error{
  constructor(readonly safeCode:"invalid_lifecycle_request"|"owner_forbidden"|"project_not_found"|"state_conflict"|"lifecycle_boundary_unavailable"){super(safeCode);this.name="IdeaLabProjectLifecycleServiceErrorV1";}
}

export class IdeaLabProjectLifecycleServiceV1{
  readonly #security:SecurityStore;readonly #registry:IdeaLabProjectRegistryStoreV1;readonly #clock:()=>string;
  constructor(db:DatabaseClient,integrityKey:Uint8Array,clock:()=>string=capturedIdeaTimeNowV1){
    this.#security=new SecurityStore(db);this.#registry=new IdeaLabProjectRegistryStoreV1(db,integrityKey);this.#clock=clock;
  }
  async get(projectIdValue:unknown,authentication:VerifiedAuthentication):Promise<ProjectRegistryProjectionV1>{
    let projectId:string;try{projectId=ideaIdSchemaV1.parse(projectIdValue);}catch{throw new IdeaLabProjectLifecycleServiceErrorV1("invalid_lifecycle_request");}
    const now=this.#clock();try{await this.#security.authorizeRead({authentication,requiredRoleKey:"owner",request:{tenantId:authentication.tenantId,
      action:"idea_lab.project_read",resourceType:"project",resourceId:projectId,projectId,risk:"low",externalEffect:false,occurredAt:now}});
    }catch{throw new IdeaLabProjectLifecycleServiceErrorV1("owner_forbidden");}
    let project;try{project=await this.#registry.getProject(authentication.tenantId,projectId);}catch{throw new IdeaLabProjectLifecycleServiceErrorV1("lifecycle_boundary_unavailable");}
    if(!project)throw new IdeaLabProjectLifecycleServiceErrorV1("project_not_found");return project;
  }
  async transition(value:unknown,authentication:VerifiedAuthentication):Promise<ProjectRegistryProjectionV1>{
    let input:z.infer<typeof inputSchema>;try{input=parseExactIdeaLabV1(inputSchema,value);}catch{throw new IdeaLabProjectLifecycleServiceErrorV1("invalid_lifecycle_request");}
    const now=this.#clock(),nowTime=capturedIdeaTimeMillisecondsV1(now),requested=capturedIdeaTimeMillisecondsV1(input.requestedAt);
    if(nowTime===undefined||requested===undefined||nowTime-requested< -30_000||nowTime-requested>300_000)throw new IdeaLabProjectLifecycleServiceErrorV1("invalid_lifecycle_request");
    const suffix=sha256Digest({tenantId:authentication.tenantId,commandId:input.commandId,projectId:input.projectId,action:input.action,expectedVersion:input.expectedVersion}).slice(7,31);
    let decision;try{decision=await this.#security.authorize({decisionId:`policy.idea.lifecycle:${suffix}`,authentication,
      requiredRoleKey:"owner",requiredActorType:"human",request:{tenantId:authentication.tenantId,
        action:`idea_lab.project_${input.action}`,resourceType:"project",resourceId:input.projectId,projectId:input.projectId,
        risk:"low",externalEffect:false,occurredAt:input.requestedAt}});}catch{throw new IdeaLabProjectLifecycleServiceErrorV1("lifecycle_boundary_unavailable");}
    if(!decision.allowed)throw new IdeaLabProjectLifecycleServiceErrorV1("owner_forbidden");
    const actorIdentityDigest=sha256Digest({tenantId:authentication.tenantId,identityId:decision.identityId,purpose:"idea_lab_project_lifecycle_owner_v1"}),
      safeReasonCode=`owner_${input.action}_${suffix}`,toState=target[input.action];
    let current;try{current=await this.#registry.getProject(authentication.tenantId,input.projectId);}catch{throw new IdeaLabProjectLifecycleServiceErrorV1("lifecycle_boundary_unavailable");}
    if(!current)throw new IdeaLabProjectLifecycleServiceErrorV1("project_not_found");
    if(current.version===input.expectedVersion+1&&current.lifecycleState===toState){let event;try{event=await this.#registry.getLatestProjectLifecycleEvent(authentication.tenantId,input.projectId);}catch{throw new IdeaLabProjectLifecycleServiceErrorV1("lifecycle_boundary_unavailable");}
      if(event?.actorIdentityDigest===actorIdentityDigest&&event.safeReasonCode===safeReasonCode&&event.occurredAt===input.requestedAt)return current;}
    if(current.version!==input.expectedVersion)throw new IdeaLabProjectLifecycleServiceErrorV1("state_conflict");
    // Both actions target active, but their grants are not interchangeable.
    if(input.action==="resume"&&current.lifecycleState!=="paused"||input.action==="reopen"&&current.lifecycleState!=="archived")
      throw new IdeaLabProjectLifecycleServiceErrorV1("state_conflict");
    try{return await this.#registry.transitionProject({tenantId:authentication.tenantId,projectId:input.projectId,
      expectedVersion:input.expectedVersion,toState,actorIdentityDigest,safeReasonCode,occurredAt:input.requestedAt});}
    catch(error){if(error instanceof IdeaLabErrorV1&&(error.safeCode==="state_conflict"||error.safeCode==="not_found"))throw new IdeaLabProjectLifecycleServiceErrorV1(error.safeCode==="not_found"?"project_not_found":"state_conflict");throw new IdeaLabProjectLifecycleServiceErrorV1("lifecycle_boundary_unavailable");}
  }
}
