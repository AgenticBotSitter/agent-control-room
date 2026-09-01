import { IdeaLabOwnerDecisionServiceErrorV1 } from "@/src/idea-lab/v1";
import { getIdeaLabProtectedRuntimeV1, type IdeaLabProtectedRuntimeV1 } from "@/app/idea-lab-protected-runtime";
import { boundedJsonV1 } from "@/app/api/v1/idea-lab/http";

const safeId=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
function json(body:unknown,status:number){return Response.json(body,{status,headers:{"cache-control":"no-store","x-control-room-data-class":"protected-owner-decision"}});}
function failure(error:unknown){if(!(error instanceof IdeaLabOwnerDecisionServiceErrorV1))return json({error:"owner_boundary_unavailable"},503);
  if(error.safeCode==="authentication_required")return json({error:error.safeCode},401);
  if(error.safeCode==="owner_forbidden")return json({error:error.safeCode},403);
  if(error.safeCode==="idea_not_found")return json({error:error.safeCode},404);
  if(error.safeCode==="decision_conflict")return json({error:error.safeCode},409);
  if(error.safeCode==="invalid_owner_decision")return json({error:error.safeCode},400);
  return json({error:"owner_boundary_unavailable"},503);}

export function createIdeaLabOwnerDecisionHandlerV1(runtime?:IdeaLabProtectedRuntimeV1){return async function handler(request:Request,context:{params:Promise<{sessionId:string}>}){
  if(!runtime)return json({error:"protected_owner_boundary_unavailable"},503);const {sessionId}=await context.params;if(!safeId.test(sessionId))return json({error:"idea_not_found"},404);
  const now=new Date().toISOString();let authentication;try{authentication=await runtime.ownerSession.verify(request,now);}catch{return json({error:"authentication_required"},401);}
  let intent:unknown;try{intent=await boundedJsonV1(request,4096);}catch{return json({error:"invalid_owner_decision"},400);}
  try{const result=await runtime.ownerDecisionService.apply({sessionId,intent,authentication,now});return Response.json({decision:result.decision,project:result.project,authorization:{policyDecisionId:result.authorization.policyDecisionId,permitDigest:result.authorization.permitDigest},replayed:result.replayed},{status:result.replayed?200:201,headers:{"cache-control":"no-store","x-control-room-contract":result.decision.contractVersion,"x-control-room-data-class":"protected-owner-decision"}});}catch(error){return failure(error);}
};}
export const POST=createIdeaLabOwnerDecisionHandlerV1(getIdeaLabProtectedRuntimeV1());
