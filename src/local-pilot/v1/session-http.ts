import { LocalPilotErrorV1, type LocalPilotOwnerSessionServiceV1 } from "./runtime";
import { readBoundedJson } from "../../web/v1/http-common";

function json(body:unknown,status:number,headers:Record<string,string>={}){return Response.json(body,{status,headers:{"cache-control":"no-store","x-control-room-pilot":"repository-fake",...headers}});}
async function body(request:Request):Promise<{ownerCode:string}>{if(request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase()!=="application/json")throw new Error();
  if(!request.body)throw new Error();const value=await readBoundedJson(request.body,512);
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==1||typeof(value as{ownerCode?:unknown}).ownerCode!=="string")throw new Error();return value as{ownerCode:string};}
type SessionRuntimeV1=Pick<LocalPilotOwnerSessionServiceV1,"issue"|"verify">;
export function createLocalPilotSessionHandlerV1(runtime:SessionRuntimeV1|undefined){return async function POST(request:Request){if(!runtime)return json({error:"local_pilot_disabled"},503);
  let input;try{input=await body(request);}catch{return json({error:"invalid_owner_code"},400);}try{const issued=await runtime.issue(request,input.ownerCode);return json({authenticated:true,expiresAt:issued.expiresAt},201,{"set-cookie":issued.cookie});}
  catch(error){if(error instanceof LocalPilotErrorV1){if(error.safeCode==="local_request_required")return json({error:error.safeCode},403);if(error.safeCode==="invalid_owner_code")return json({error:error.safeCode},401);if(error.safeCode==="owner_code_consumed")return json({error:error.safeCode},409);}return json({error:"local_pilot_unavailable"},503);}};}
export function createLocalPilotSessionStatusHandlerV1(runtime:SessionRuntimeV1|undefined,clock:()=>string=()=>new Date().toISOString()){return async function GET(request:Request){if(!runtime)return json({error:"local_pilot_disabled"},503);
  try{const authentication=await runtime.verify(request,clock());return json({authenticated:true,expiresAt:authentication.expiresAt},200);}
  catch(error){if(error instanceof LocalPilotErrorV1){if(error.safeCode==="local_request_required")return json({error:error.safeCode},403);if(error.safeCode==="authentication_required")return json({authenticated:false},401);}return json({error:"local_pilot_unavailable"},503);}};}
