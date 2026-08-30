import type { Metadata } from "next";
import { ControlRoomDashboard } from "./control-room-dashboard";
import { buildReadyFrontierAutomationProjectionFixtureV1, buildReadyFrontierCycleProjectionFixtureV1,
  buildReadyFrontierPromotionProjectionFixtureV1 } from "@/src/ready-frontier/v1";

export const metadata: Metadata = {
  title: { absolute: "Control Room" },
  description: "Private cross-project operations, workers, agents, blockers, and capacity simulation.",
};

export default function Home() {
  return <ControlRoomDashboard readyFrontier={buildReadyFrontierCycleProjectionFixtureV1()}
    readyFrontierAutomation={buildReadyFrontierAutomationProjectionFixtureV1()}
    readyFrontierPromotion={buildReadyFrontierPromotionProjectionFixtureV1()} />;
}
