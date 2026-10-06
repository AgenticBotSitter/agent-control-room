import type { Metadata } from "next";
import "../../styles/control-room.css";
import "./private.css";
import { LayoutProviders } from "./layout-providers";
import { PwaRegistration } from "./pwa-registration";

export const metadata: Metadata = { title: "Projects · Control Room", robots: { index: false, follow: false },
  description: "Your private Control Room projects.", manifest: "/manifest.webmanifest", themeColor: "#111827" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><LayoutProviders><PwaRegistration /><a className="skip-link" href="#private-main">Skip to content</a>{children}</LayoutProviders></body></html>;
}
