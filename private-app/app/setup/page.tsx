import type { Metadata } from "next";
import { SetupWorkspace } from "./setup-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Set up Control Room",
  description: "Read-only source preview of the Agent Control Room installation journey.",
  robots: { index: false, follow: false },
};

/**
 * This route intentionally does not mount the normal project workspace. Its
 * browser reader is limited to the redacted setup status and setup progress.
 */
export default function SetupPage() {
  return <SetupWorkspace />;
}
