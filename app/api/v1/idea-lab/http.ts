import { IdeaLabOperatorServiceErrorV1 } from "@/src/idea-lab/v1";

export function ideaJsonV1(body:unknown,status:number){return Response.json(body,{status,headers:{"cache-control":"no-store","x-control-room-data-class":"protected-idea-lab"}});}
export function ideaFailureV1(error:unknown){if(!(error instanceof IdeaLabOperatorServiceErrorV1))return ideaJsonV1({error:"operator_boundary_unavailable"},503);
  if(error.safeCode==="owner_forbidden")return ideaJsonV1({error:error.safeCode},403);
  if(error.safeCode==="idea_not_found")return ideaJsonV1({error:error.safeCode},404);
  if(error.safeCode==="state_conflict")return ideaJsonV1({error:error.safeCode},409);
  if(error.safeCode==="invalid_operator_request")return ideaJsonV1({error:error.safeCode},400);
  return ideaJsonV1({error:"operator_boundary_unavailable"},503);}
export async function boundedJsonV1(request:Request,maximumBytes=8192){
  const contentType=request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
  if(contentType!=="application/json"||!Number.isSafeInteger(maximumBytes)||maximumBytes<1)throw new Error("invalid body");
  const declared=request.headers.get("content-length");
  if(declared!==null){const length=Number(declared);if(!Number.isSafeInteger(length)||length<1||length>maximumBytes)throw new Error("invalid body");}
  if(!request.body)throw new Error("invalid body");
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const{done,value}=await reader.read();if(done)break;if(!value)continue;total+=value.byteLength;if(total>maximumBytes){await reader.cancel();throw new Error("invalid body");}chunks.push(value);}}
  finally{reader.releaseLock();}
  if(total<1)throw new Error("invalid body");const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown;
}
export function exactCommandBodyV1(value:unknown):{commandId:unknown;requestedAt:unknown}{if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error("invalid body");
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(keys.length!==2||keys.some(key=>typeof key!=="string"||!["commandId","requestedAt"].includes(key)))throw new Error("invalid body");
  for(const key of keys as string[]){const descriptor=descriptors[key];if(!descriptor||!("value" in descriptor)||descriptor.get||descriptor.set||!descriptor.enumerable)throw new Error("invalid body");}
  return{commandId:descriptors.commandId!.value,requestedAt:descriptors.requestedAt!.value};}
