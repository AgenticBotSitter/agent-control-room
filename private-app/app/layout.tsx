import type { Metadata } from "next";
import "../../app/globals.css";
import "./private.css";

export const metadata: Metadata = { title: "Projects · Control Room", robots: { index: false, follow: false },
  description: "Your private Control Room projects." };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><a className="skip-link" href="#private-main">Skip to projects</a>{children}</body></html>;
}
