import { PrivateProjectResultReview } from "../../../project-result-review-workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project inbox · Control Room" };

export default async function Page({ params, searchParams }: { params: Promise<{ projectId: string }>;
  searchParams: Promise<{ after?: string | string[] }> }) {
  const { projectId: rawProjectId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  const { after } = await searchParams;
  return <PrivateProjectResultReview key={`${projectId}:${typeof after === "string" ? after : ""}`} projectId={projectId}
    mode="inbox" after={typeof after === "string" ? after : undefined} />;
}
