import type { Metadata } from "next";
import { PrivateSettingsWorkspace } from "./workspace";

export const metadata: Metadata = { title: "Settings · Control Room" };

export default function SettingsPage() {
  return <PrivateSettingsWorkspace />;
}
