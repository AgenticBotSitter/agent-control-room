import type { Metadata } from "next";
import { ControlRoomDashboard } from "./control-room-dashboard";
import { buildReadyFrontierAutomationProjectionFixtureV1, buildReadyFrontierCycleProjectionFixtureV1,
  buildReadyFrontierNoRelayProjectionFixtureV1, buildReadyFrontierPromotionProjectionFixtureV1,
  projectReadyFrontierNoRelayAttentionV1 } from "@/src/ready-frontier/v1";

export const metadata: Metadata = {
  title: { absolute: "Control Room" },
  description: "Private cross-project operations, workers, agents, blockers, and capacity simulation.",
};

export default function Home() {
  const noRelay = buildReadyFrontierNoRelayProjectionFixtureV1();
  return <ControlRoomDashboard readyFrontier={buildReadyFrontierCycleProjectionFixtureV1()}
    readyFrontierAutomation={buildReadyFrontierAutomationProjectionFixtureV1()}
    readyFrontierPromotion={buildReadyFrontierPromotionProjectionFixtureV1()}
    readyFrontierNoRelay={noRelay}
    readyFrontierNoRelayAttention={projectReadyFrontierNoRelayAttentionV1(noRelay)} />;
}
