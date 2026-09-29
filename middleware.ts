import { NextResponse } from "next/server";

/** Every VPS page/API/stream enters the same private composition; no preview route fallback. */
export async function middleware(request: Request) {
  if (process.env.CONTROL_ROOM_BUILD_TARGET === "vps-node") {
    const url = new URL(request.url);
    // This marker is injected only by the credential-free loopback setup
    // transport after it validates peer, Host, Origin and fetch-site headers.
    // The ordinary HTTPS transport never forwards a client-supplied marker.
    if (request.headers.get("x-control-room-local-setup") === "v1"
      && (request.method === "GET" || request.method === "HEAD") && !url.search
      && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
      && url.pathname === "/setup") return NextResponse.next();
    const { handlePrivateWebRequest } = await import("./src/web/v1/private-process");
    return handlePrivateWebRequest(request, () => NextResponse.next());
  }
  return NextResponse.next();
}
