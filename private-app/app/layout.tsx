import type { Metadata } from "next";
import "../../styles/control-room.css";
import "./private.css";

export const metadata: Metadata = { title: "Projects · Control Room", robots: { index: false, follow: false },
  description: "Your private Control Room projects." };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><a className="skip-link" href="#private-main">Skip to content</a>{children}</body></html>;
}
