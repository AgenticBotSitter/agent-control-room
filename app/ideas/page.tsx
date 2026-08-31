import type { Metadata } from "next";
import { IdeaLabWorkspace } from "@/app/components/idea-lab-workspace";
import { buildIdeaLabUiFixtureV1 } from "@/app/fixtures/idea-lab-ui";

export const metadata: Metadata = { title: "Idea Lab" };

export default function IdeaLabPage() {
  return <IdeaLabWorkspace fixture={buildIdeaLabUiFixtureV1()} />;
}
