import { getProjectEventStreamRuntimeV1,type ProjectEventStreamRuntimeV1 } from "@/app/project-event-stream-runtime";
import { ProjectEventErrorV1,projectEventSseResponseV1 } from "@/src/project-events/v1";
import { ProjectWorkspaceContractErrorV1 } from "@/src/project-workspace/v1";

const safeId=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
function json(error:string,status:number):Response{return Response.json({error},{status,headers:{"cache-control":"no-store",
  "x-content-type-options":"nosniff","x-control-room-data-class":"protected-project-events"}});}
function failure(error:unknown):Response{
  if(error instanceof ProjectWorkspaceContractErrorV1){if(error.safeCode==="authentication_required")return json("authentication_required",401);
    if(error.safeCode==="policy_denied")return json("project_read_forbidden",403);
    if(error.safeCode==="not_found"||error.safeCode==="catalog_revoked")return json("project_not_found",404);}
  if(error instanceof ProjectEventErrorV1){if(error.safeCode==="invalid_input")return json("invalid_stream_request",400);
    if(error.safeCode==="project_not_found")return json("project_not_found",404);
    if(error.safeCode==="integrity_failed")return json("project_event_integrity_failed",503);}
  return json("project_event_source_unavailable",503);
}

export function createProjectEventStreamHandlerV1(runtime?:ProjectEventStreamRuntimeV1){
  return async function projectEventStream(request:Request,context:{params:Promise<{projectId:string}>}):Promise<Response>{
    if(!runtime)return json("protected_event_boundary_unavailable",503);
    const{projectId}=await context.params;if(!safeId.test(projectId))return json("project_not_found",404);
    const url=new URL(request.url),queryCursor=url.searchParams.get("after"),headerCursor=request.headers.get("last-event-id");
    if(queryCursor&&headerCursor&&queryCursor!==headerCursor)return json("conflicting_stream_cursor",400);
    const limitValue=url.searchParams.get("limit")??"100";
    if(!/^[1-9][0-9]{0,2}$/.test(limitValue)||Number(limitValue)>100)return json("invalid_stream_request",400);
    try{const scope=await runtime.scopeAuthority.authorize({credential:request,projectId,now:new Date().toISOString()});
      const page=await runtime.eventSource.read({tenantId:scope.tenantId,workspaceId:scope.workspaceId,projectId:scope.projectId,
        ...(queryCursor??headerCursor?{afterCursor:(queryCursor??headerCursor)!}:{}),limit:Number(limitValue)});
      return projectEventSseResponseV1(page);
    }catch(error){return failure(error);}
  };
}

export const GET=createProjectEventStreamHandlerV1(getProjectEventStreamRuntimeV1());
