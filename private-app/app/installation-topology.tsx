"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parseInstallationSetupViewV1, type InstallationSetupViewV1 } from "../../src/harness/v1/installation-setup-wire";
import { verifyInstallationPlanViewV1, type InstallationPlanViewV1 } from "../../src/installer/v1/installation-plan-view";

type InstallationTopologyState = Readonly<{
  /** The setup read is deliberately distinct from an absent or unavailable plan. */
  state: "loading" | "available" | "unavailable";
  setup?: InstallationSetupViewV1;
  planState?: "loading" | "available" | "unavailable";
  plan?: InstallationPlanViewV1;
}>;
const InstallationTopologyContext = createContext<InstallationTopologyState>({ state: "loading", planState: "loading" });

/** Reads only an operator-prepared setup plan. A missing plan never implies a local or remote worker is available. */
export function InstallationTopologyProvider({ children }: { children: ReactNode }) {
  const [plan, setPlan] = useState<InstallationTopologyState>({ state: "loading", planState: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const [readinessResponse, planResponse] = await Promise.all([
          fetch("/api/v1/installation-readiness", { method: "GET", credentials: "same-origin",
            cache: "no-store", redirect: "error", signal: controller.signal }),
          fetch("/api/v1/installation-plan", { method: "GET", credentials: "same-origin",
            cache: "no-store", redirect: "error", signal: controller.signal }),
        ]);
        const setup = readinessResponse.ok
          ? parseInstallationSetupViewV1((await readinessResponse.json()).setup) : undefined;
        const installationPlan = planResponse.ok
          ? verifyInstallationPlanViewV1((await planResponse.json()).plan) : undefined;
        const value = Object.freeze({ state: setup ? "available" as const : "unavailable" as const,
          ...(setup ? { setup } : {}), planState: installationPlan ? "available" as const : "unavailable" as const,
          ...(installationPlan ? { plan: installationPlan } : {}) });
        if (!controller.signal.aborted && current === request) setPlan(value);
      } catch {
        // A stale setup success must never remain visible after the protected
        // read stops being available or returns malformed data.
        if (!controller.signal.aborted && current === request) setPlan({ state: "unavailable", planState: "unavailable" });
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
