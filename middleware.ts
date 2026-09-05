import { NextResponse } from "next/server";

/** Every VPS page/API/stream enters the same private composition; no preview route fallback. */
export async function middleware(request: Request) {
  if (process.env.CONTROL_ROOM_BUILD_TARGET === "vps-node") {
    const { handlePrivateWebRequest } = await import("./src/web/v1/private-process");
    return handlePrivateWebRequest(request, () => NextResponse.next());
  }
  return NextResponse.next();
}
