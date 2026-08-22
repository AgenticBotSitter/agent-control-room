import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Control Room",
    template: "%s · Control Room",
  },
  description: "Private project-agnostic orchestration and capacity control.",
  openGraph: {
    title: "Control Room",
    description: "Private project-agnostic orchestration and capacity control.",
    images: [{ url: "/control-room-preview.png", width: 1664, height: 936 }],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#11140f" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
