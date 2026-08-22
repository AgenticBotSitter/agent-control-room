import type { Metadata } from "next";
import { ControlRoomDashboard } from "./control-room-dashboard";

export const metadata: Metadata = {
  title: { absolute: "Control Room" },
  description: "Private cross-project operations, workers, agents, blockers, and capacity simulation.",
};

export default function Home() {
  return <ControlRoomDashboard />;
}
