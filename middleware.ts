import { NextResponse } from "next/server";

/** The VPS artifact must not expose the legacy preview's fixture or header-trusting routes.
 * B-WIRE replaces this readiness response only after composing the reviewed auth/store services.
 * This guard intentionally covers pages, APIs and streams; it cannot be disabled at runtime.
 */
export function middleware() {
  if (process.env.CONTROL_ROOM_BUILD_TARGET === "vps-node") {
    return NextResponse.json({ error: "private_app_not_configured" }, {
      status: 503, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  }
  return NextResponse.next();
}
