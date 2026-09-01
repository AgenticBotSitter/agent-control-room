import { getIdeaLabProtectedRuntimeV1,type IdeaLabProtectedRuntimeV1 } from "@/app/idea-lab-protected-runtime";
import { ideaJsonV1,ideaLifecycleFailureV1 } from "@/app/api/v1/idea-lab/http";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "@/src/idea-lab/v1";
import { buildProjectWorkspaceSnapshotV1 } from "@/src/project-workspace/v1";
const safeId=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
export function createIdeaLabProjectReadHandlerV1(runtime?:IdeaLabProtectedRuntimeV1){return async function handler(request:Request,context:{params:Promise<{projectId:string}>}){
  if(!runtime)return ideaJsonV1({error:"protected_lifecycle_boundary_unavailable"},503);const{projectId}=await context.params;if(!safeId.test(projectId))return ideaJsonV1({error:"project_not_found"},404);
  const now=new Date().toISOString();let authentication;try{authentication=await runtime.ownerSession.verify(request,now);}catch{return ideaJsonV1({error:"authentication_required"},401);}
  try{const project=await runtime.lifecycleService.get(projectId,authentication),workspace=buildProjectWorkspaceSnapshotV1({snapshotId:`snapshot:${project.latestEventDigest.slice(7,31)}`,
    tenantId:project.tenantId,workspaceId:project.workspaceId,projectId:project.projectId,adapterId:CONTROL_ROOM_IDEA_ADAPTER_V1,projectType:project.projectKind,
    title:project.title,summary:project.summary,authorityMode:"control_room_native",generatedAt:project.updatedAt,extensionSections:[{sectionId:"idea-origin",extensionKind:"idea_origin",label:"Idea origin"}],
    sourceStatuses:[{sourceId:"source:idea-project-registry",sourceKind:"local_repository_fake",label:"Local Idea Lab registry",mode:"configured",state:"available",
      safeStatusCode:"local_pilot_available",checkedAt:project.updatedAt,lastSuccessfulAt:project.updatedAt,itemCount:1,grantsNetworkAuthority:false}],activeItemCount:0,waitingReviewCount:0,failedItemCount:0});
    return ideaJsonV1({project,workspace},200);}catch(error){return ideaLifecycleFailureV1(error);}};}
export const GET=createIdeaLabProjectReadHandlerV1(getIdeaLabProtectedRuntimeV1());
