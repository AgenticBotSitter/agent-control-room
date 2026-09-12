import type { Metadata } from "next";
import { PrivateConnections } from "../connections/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Workers · Control Room",
  description: "Saved worker connection inventory for this private Control Room workspace." };

export default function WorkersPage() { return <PrivateConnections />; }
