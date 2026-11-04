import { createAccessVerifier, requireSameOrigin, WebAccessError, type AccessTrust, type GatewayAssertionProviderProfileV1 } from './access-verifier';
import type { LocalOwnerSessionServiceV1 } from './local-owner-session';
import { LoopProviderRefusedV1, type LoopProviderServiceV1 } from './loop-provider-service';
import { privateResponseHeaders, readBoundedJson, webFailure } from './http-common';
export const isLoopProviderRouteV1=(path:string)=>path==='/api/v1/loop-providers'||/^\/api\/v1\/loop-providers\/[a-z0-9][a-z0-9._-]{2,63}(?:\/remove)?$/.test(path);
export function createLoopProviderHttpHandlerV1(options:{origin:string;service:LoopProviderServiceV1;trust?:AccessTrust;gatewayAssertionProfile?:GatewayAssertionProviderProfileV1;clock?:()=>number;localOwnerSession?:LocalOwnerSessionServiceV1}) {
 const local=options.localOwnerSession;
 if(local&&(options.trust||options.gatewayAssertionProfile)||!local&&!options.trust)throw new Error('loop_provider_http_authentication_invalid');
 const verify=options.trust?createAccessVerifier(options.trust,options.gatewayAssertionProfile):undefined;
 return async(request:Request):Promise<Response>=>{
  let exceeded=false;
  try{
   const write=request.method==='PUT'||request.method==='POST';
   if(local)local.assertLocalRequest(request,write);else requireSameOrigin(request,options.origin);
   const identity=local?local.verify(request,(options.clock??Date.now)()):verify!(request,(options.clock??Date.now)());
   const url=new URL(request.url);if(url.search)throw new WebAccessError('invalid_request');
   if(url.pathname==='/api/v1/loop-providers'){
    if(request.method!=='GET'||request.body)throw new WebAccessError('invalid_request');
    return Response.json(await options.service.view(identity),{headers:privateResponseHeaders});
   }
   const refresh=url.pathname==='/api/v1/loop-providers/refresh-prices'&&request.method==='POST';
   const route=/^\/api\/v1\/loop-providers\/([a-z0-9][a-z0-9._-]{2,63})(\/remove)?$/.exec(url.pathname);
   if(!route)throw new WebAccessError('not_found');
   if(request.method!==(refresh||route[2]?'POST':'PUT')||!request.body||request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new WebAccessError('invalid_request');
   let bytes=0;
   const bounded=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>65536){exceeded=true;throw new Error('request_too_large');}controller.enqueue(chunk);}}));
   const body=await readBoundedJson(bounded,65536),key=request.headers.get('idempotency-key')??'';
   const result=refresh?await options.service.refreshPrices(identity,body,key,request.signal):route[2]?await options.service.remove(identity,route[1]!,body,key):await options.service.upsert(identity,route[1]!,body,key);
   return Response.json(result,{status:result.replayed?200:201,headers:privateResponseHeaders});
  }catch(error){
   if(exceeded)return Response.json({error:'request_too_large'},{status:413,headers:privateResponseHeaders});
   if(error instanceof LoopProviderRefusedV1)return Response.json({error:'provider_refused',reason:error.reason,message:error.message},{status:422,headers:privateResponseHeaders});
   return webFailure(error);
  }
 };
}
