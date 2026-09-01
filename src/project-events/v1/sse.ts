import { encodeProjectEventCursorV1 } from "./contracts";
import type { ProjectEventPageV1 } from "./types";

function data(value:unknown):string{return JSON.stringify(value).replaceAll("\u2028","\\u2028").replaceAll("\u2029","\\u2029");}

export function formatProjectEventSseV1(page:ProjectEventPageV1):string{
  const lines=["retry: 1000",""];
  if(page.mode==="reset")lines.push("event: stream.reset",`data: ${data({code:"cursor_reset",pageDigest:page.pageDigest})}`,"");
  for(const event of page.events)lines.push(`id: ${encodeProjectEventCursorV1(event)}`,"event: project.event",`data: ${data(event)}`,"");
  lines.push("event: stream.head",`data: ${data({mode:page.mode,nextCursor:page.nextCursor,hasMore:page.hasMore,
    truncatedBefore:page.truncatedBefore,pageDigest:page.pageDigest})}`,"",": keepalive","");
  return lines.join("\n");
}

export function projectEventSseResponseV1(page:ProjectEventPageV1):Response{
  return new Response(formatProjectEventSseV1(page),{status:200,headers:{"content-type":"text/event-stream; charset=utf-8",
    "cache-control":"no-store, no-transform","x-accel-buffering":"no","x-content-type-options":"nosniff",
    "x-control-room-contract":page.contractVersion,"x-control-room-data-class":"protected-project-events",
    "x-control-room-stream-mode":"bounded-replay-reconnect"}});
}
