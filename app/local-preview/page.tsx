import type { Metadata } from "next";
import { isControlRoomLocalPilotConfiguredV1 } from "../control-room-local-pilot-runtime";
import { LocalPilotOwnerSession } from "../components/local-pilot-owner-session";
import { LocalProjectWorkspace } from "./workspace";
import { catalogProjectIdSchema } from "../../src/web/v1/project-wire";
import "../../private-app/app/private.css";

export const metadata: Metadata = { title: "Local project preview", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function LocalPreviewPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isControlRoomLocalPilotConfiguredV1()) return <main><h1>Local preview is disabled</h1>
    <p>This page requires the explicitly configured local repository-fake pilot. No agent has been started.</p></main>;
  const query = await searchParams;
  if (Object.keys(query).some(key => !["project", "job", "after"].includes(key))
    || Object.values(query).some(value => value !== undefined && !catalogProjectIdSchema.safeParse(value).success)
    || query.job && !query.project || query.job && query.after) return <main><h1>Invalid preview link</h1><a href="/local-preview">Open projects</a></main>;
  const projectId = query.project as string | undefined, jobId = query.job as string | undefined, after = query.after as string | undefined;
  return <><LocalPilotOwnerSession /><LocalProjectWorkspace key={`${projectId ?? ""}/${jobId ?? ""}/${after ?? ""}`}
    projectId={projectId} jobId={jobId} after={after} /></>;
}
