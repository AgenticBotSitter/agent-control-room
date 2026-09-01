import type { ProjectLifecycleEventV1,ProjectRegistryProjectionV1 } from "../../idea-lab/v1";
import { sha256Digest } from "../../security";
import { PROJECT_EVENT_INPUT_V1 } from "./types";
import type { ProjectEventStoreV1 } from "./store";

export interface IdeaLabProjectEventSourceV1{
  getProject(tenantId:string,projectId:string):Promise<ProjectRegistryProjectionV1|undefined>;
  listProjects(tenantId:string,options:{includeArchived?:boolean}):Promise<ProjectRegistryProjectionV1[]>;
  listProjectLifecycleEvents(tenantId:string,projectId:string):Promise<ProjectLifecycleEventV1[]>;
}

export class IdeaLabProjectEventReconcilerV1{
  constructor(private readonly source:IdeaLabProjectEventSourceV1,private readonly events:Pick<ProjectEventStoreV1,"append">){Object.freeze(this);}
  async reconcileProject(tenantId:string,projectId:string):Promise<number>{
    const project=await this.source.getProject(tenantId,projectId);if(!project)throw new Error("project_event_source_missing");
    const sourceEvents=await this.source.listProjectLifecycleEvents(tenantId,projectId),latest=sourceEvents.at(-1);
    if(!latest||latest.eventDigest!==project.latestEventDigest||latest.version!==project.version)throw new Error("project_event_source_drift");
    for(const event of sourceEvents){const suffix=event.eventDigest.slice(7,31),promoted=event.version===1;
      await this.events.append({schemaVersion:PROJECT_EVENT_INPUT_V1,tenantId:event.tenantId,workspaceId:event.workspaceId,
        projectId:event.projectId,eventId:`event:project-lifecycle:${suffix}`,eventKind:"project",source:{kind:"idea_lab",
          sourceId:event.eventId,sourceVersion:`lifecycle-v${event.version}`,
          sourceEventKeyDigest:sha256Digest({kind:"project_lifecycle",eventDigest:event.eventDigest})},
        subject:{kind:"project",subjectId:event.projectId},safeSummary:promoted?"Idea promoted to a monitored project":
          `Project lifecycle changed to ${event.toState}`,...(promoted?{safeDetail:
          "The owner-approved Idea Lab result is now available in its own Control Room workspace."}:{}),
        tone:promoted||event.toState==="completed"?"good":event.toState==="paused"||event.toState==="archived"?"warn":"neutral",
        deepLinkPath:`/projects/${event.projectId}/activity`,occurredAt:new Date(event.occurredAt).toISOString(),
        presentationOnly:true,grantsApproval:false,grantsCommandAuthority:false,grantsExecutionAuthority:false});}
    return sourceEvents.length;
  }
  async reconcileAll(tenantId:string):Promise<number>{let count=0;
    for(const project of await this.source.listProjects(tenantId,{includeArchived:true}))count+=await this.reconcileProject(tenantId,project.projectId);
    return count;
  }
}
