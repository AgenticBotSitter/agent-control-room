"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { verifyInstallationTopologyPlanV1, type InstallationTopologyPlanV1 } from "../../src/harness/v1/installation-topology";
import { verifyInstallationReadinessV1, type InstallationReadinessV1 } from "../../src/harness/v1/installation-readiness";

type InstallationTopologyState = Readonly<{ plan: InstallationTopologyPlanV1; readiness?: InstallationReadinessV1 }> | undefined;
const InstallationTopologyContext = createContext<InstallationTopologyState>(undefined);

/** Reads only an operator-prepared setup plan. A missing plan never implies a local or remote worker is available. */
export function InstallationTopologyProvider({ children }: { children: ReactNode }) {
  const [plan, setPlan] = useState<InstallationTopologyState>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/installation-readiness", { method: "GET", credentials: "same-origin",
          cache: "no-store", redirect: "error", signal: controller.signal });
        if (!response.ok) return;
        const responseBody = await response.json();
        const value = Object.freeze({ plan: verifyInstallationTopologyPlanV1(responseBody.plan),
          ...(responseBody.readiness === undefined ? {} : { readiness: verifyInstallationReadinessV1(responseBody.readiness) }) });
        if (!controller.signal.aborted) setPlan(value);
      } catch { /* No saved plan means this view must remain unconfigured. */ }
    })();
    return () => controller.abort();
  }, []);
  return <InstallationTopologyContext.Provider value={plan}>{children}</InstallationTopologyContext.Provider>;
}

export function useInstallationTopology() { return useContext(InstallationTopologyContext); }
