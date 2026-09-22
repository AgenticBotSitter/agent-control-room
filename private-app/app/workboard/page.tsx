import type { Metadata } from "next";
import { PrivateControlRoomWorkboard } from "../control-room-workboard";
import { decodePrivateRouteSegment } from "../route-segment";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Control Room workboard · Control Room",
  description: "Read-only local Control Room workboard." };

export default async function WorkboardPage({ searchParams }: { searchParams: Promise<{ projectId?: string | string[] }> }) {
  const { projectId } = await searchParams;
  return <PrivateControlRoomWorkboard projectId={typeof projectId === "string" ? decodePrivateRouteSegment(projectId) : undefined} />;
}
