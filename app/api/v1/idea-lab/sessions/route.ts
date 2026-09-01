import { getIdeaLabProtectedRuntimeV1,type IdeaLabProtectedRuntimeV1 } from "@/app/idea-lab-protected-runtime";
import { boundedJsonV1,ideaFailureV1,ideaJsonV1 } from "@/app/api/v1/idea-lab/http";

export function createIdeaLabSessionHandlerV1(runtime?:IdeaLabProtectedRuntimeV1){return async function handler(request:Request){if(!runtime)return ideaJsonV1({error:"protected_operator_boundary_unavailable"},503);const now=new Date().toISOString();let authentication;try{authentication=await runtime.ownerSession.verify(request,now);}catch{return ideaJsonV1({error:"authentication_required"},401);}
  let input;try{input=await boundedJsonV1(request);}catch{return ideaJsonV1({error:"invalid_operator_request"},400);}try{const session=await runtime.operatorService.create(input,authentication);return ideaJsonV1({session},201);}catch(error){return ideaFailureV1(error);}};}
export function createIdeaLabSessionCatalogHandlerV1(runtime?:IdeaLabProtectedRuntimeV1){return async function handler(request:Request){if(!runtime)return ideaJsonV1({error:"protected_operator_boundary_unavailable"},503);const now=new Date().toISOString();let authentication;try{authentication=await runtime.ownerSession.verify(request,now);}catch{return ideaJsonV1({error:"authentication_required"},401);}try{return ideaJsonV1({sessions:await runtime.operatorService.list(authentication)},200);}catch(error){return ideaFailureV1(error);}};}
export const POST=createIdeaLabSessionHandlerV1(getIdeaLabProtectedRuntimeV1());
export const GET=createIdeaLabSessionCatalogHandlerV1(getIdeaLabProtectedRuntimeV1());
