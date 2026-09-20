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
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const response = await fetch("/api/v1/installation-readiness", { method: "GET", credentials: "same-origin",
          cache: "no-store", redirect: "error", signal: controller.signal });
        if (!response.ok) {
          if (!controller.signal.aborted && current === request) setPlan(undefined);
          return;
        }
        const responseBody = await response.json();
        const value = Object.freeze({ plan: verifyInstallationTopologyPlanV1(responseBody.plan),
          ...(responseBody.readiness === undefined ? {} : { readiness: verifyInstallationReadinessV1(responseBody.readiness) }) });
        if (!controller.signal.aborted && current === request) setPlan(value);
      } catch {
        // A stale setup success must never remain visible after the protected
        // read stops being available or returns malformed data.
        if (!controller.signal.aborted && current === request) setPlan(undefined);
      }
    };
    void load();
    const refreshVisible = () => { if (!document.hidden) void load(); };
    const interval = setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    return () => { controller.abort(); clearInterval(interval); window.removeEventListener("focus", refreshVisible); };
  }, []);
  return <InstallationTopologyContext.Provider value={plan}>{children}</InstallationTopologyContext.Provider>;
}

export function useInstallationTopology() { return useContext(InstallationTopologyContext); }
