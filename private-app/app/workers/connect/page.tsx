import type { Metadata } from "next";
import { ConnectBotWorkspace } from "./connect-bot-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect a bot · Control Room",
  description: "Connect one bot to this private Control Room with a short-lived, digest-checked install line." };

export default function ConnectBotPage() { return <ConnectBotWorkspace />; }
