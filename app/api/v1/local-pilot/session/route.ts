import { getControlRoomLocalPilotPortsV1 } from "@/app/control-room-local-pilot-runtime";
import { LocalPilotErrorV1 } from "@/src/local-pilot/v1";

function json(body:unknown,status:number,headers:Record<string,string>={}){return Response.json(body,{status,headers:{"cache-control":"no-store","x-control-room-pilot":"repository-fake",...headers}});}
async function body(request:Request):Promise<{ownerCode:string}>{if(request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase()!=="application/json")throw new Error();
  const text=await request.text();if(Buffer.byteLength(text,"utf8")>512)throw new Error();const value=JSON.parse(text)as unknown;
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==1||typeof(value as{ownerCode?:unknown}).ownerCode!=="string")throw new Error();return value as{ownerCode:string};}
type SessionRuntimeV1=NonNullable<ReturnType<typeof getControlRoomLocalPilotPortsV1>>["sessionIssuer"];
export function createLocalPilotSessionHandlerV1(runtime:SessionRuntimeV1|undefined=getControlRoomLocalPilotPortsV1()?.sessionIssuer){return async function POST(request:Request){if(!runtime)return json({error:"local_pilot_disabled"},503);
  let input;try{input=await body(request);}catch{return json({error:"invalid_owner_code"},400);}try{const issued=await runtime.issue(request,input.ownerCode);return json({authenticated:true,expiresAt:issued.expiresAt},201,{"set-cookie":issued.cookie});}
  catch(error){if(error instanceof LocalPilotErrorV1){if(error.safeCode==="local_request_required")return json({error:error.safeCode},403);if(error.safeCode==="invalid_owner_code")return json({error:error.safeCode},401);if(error.safeCode==="owner_code_consumed")return json({error:error.safeCode},409);}return json({error:"local_pilot_unavailable"},503);}};}
export function createLocalPilotSessionStatusHandlerV1(runtime:SessionRuntimeV1|undefined=getControlRoomLocalPilotPortsV1()?.sessionIssuer,clock:()=>string=()=>new Date().toISOString()){return async function GET(request:Request){if(!runtime)return json({error:"local_pilot_disabled"},503);
  try{const authentication=await runtime.verify(request,clock());return json({authenticated:true,expiresAt:authentication.expiresAt},200);}
  catch(error){if(error instanceof LocalPilotErrorV1){if(error.safeCode==="local_request_required")return json({error:error.safeCode},403);if(error.safeCode==="authentication_required")return json({authenticated:false},401);}return json({error:"local_pilot_unavailable"},503);}};}
export const POST=createLocalPilotSessionHandlerV1();
export const GET=createLocalPilotSessionStatusHandlerV1();
