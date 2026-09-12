"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { productConfigurationSchemaV1, type ProductConfigurationV1 } from "../../src/config/v1/product-configuration";

type ProductConfigurationState = Readonly<ProductConfigurationV1> | undefined;
const ProductConfigurationContext = createContext<ProductConfigurationState>(undefined);

/** Presentation configuration is read from the authenticated private endpoint.
 * Absence preserves the portable artifact's neutral Control Room shell. */
export function ProductConfigurationProvider({ children }: { children: ReactNode }) {
  const [configuration, setConfiguration] = useState<ProductConfigurationState>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/product-configuration", { method: "GET", credentials: "same-origin",
          cache: "no-store", redirect: "error", signal: controller.signal });
        if (!response.ok) return;
        const value = productConfigurationSchemaV1.parse(await response.json());
        if (!controller.signal.aborted) setConfiguration(value);
      } catch { /* Keep the neutral shell when the optional configuration cannot be read. */ }
    })();
    return () => controller.abort();
  }, []);
  return <ProductConfigurationContext.Provider value={configuration}>{children}</ProductConfigurationContext.Provider>;
}

export function useProductConfiguration() { return useContext(ProductConfigurationContext); }
export function useProductDisplayName() { return useProductConfiguration()?.displayName ?? "Control Room"; }
export function useProductModule(name: keyof ProductConfigurationV1["modules"]) {
  const configuration = useProductConfiguration();
  // A pending or failed authenticated read cannot optimistically expose an
  // optional surface that the server may have disabled.
  return configuration?.modules[name] === true;
}
