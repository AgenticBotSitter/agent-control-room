import type { Metadata } from "next";
import { SessionWatchWorkspace } from "./workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Session watch · Control Room",
  description: "Saved cross-project agent session evidence for this private Control Room workspace." };

export default async function SessionWatchPage({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  const { after } = await searchParams;
  return <SessionWatchWorkspace after={typeof after === "string" ? after : undefined} />;
}
