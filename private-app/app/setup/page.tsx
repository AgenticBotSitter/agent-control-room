import type { Metadata } from "next";
import { SetupWorkspace } from "./setup-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Set up Control Room",
  description: "Owner-attended Control Room setup and passkey registration.",
  robots: { index: false, follow: false },
};

/**
 * This route intentionally does not mount the normal project workspace. Its
 * Without a single-use installer fragment, its browser reads remain limited to
 * redacted setup status and setup progress.
 */
export default function SetupPage() {
  return <SetupWorkspace />;
}
