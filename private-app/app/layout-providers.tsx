"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { InstallationTopologyProvider } from "./installation-topology";
import { ProductConfigurationProvider } from "./product-configuration";
import { LocalRuntimeProvider } from "./local-runtime";

/**
 * The setup host is deliberately smaller than the signed-in product shell.
 * Keeping the normal providers outside /setup prevents unrelated product and
 * duplicate installation reads from crossing that loopback-only boundary.
 */
export function LayoutProviders({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  if (pathname === "/setup" || pathname.startsWith("/setup/") || pathname === "/session") return children;
  return <LocalRuntimeProvider><ProductConfigurationProvider>
    <InstallationTopologyProvider>{children}</InstallationTopologyProvider>
  </ProductConfigurationProvider></LocalRuntimeProvider>;
}
