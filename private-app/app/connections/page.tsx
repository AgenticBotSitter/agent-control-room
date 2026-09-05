import type { Metadata } from "next";
import { PrivateConnections } from "./workspace";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connections · Control Room",
  description: "Private connection inventory across all workspaces in this Control Room account." };
export default function ConnectionsPage() { return <PrivateConnections />; }
