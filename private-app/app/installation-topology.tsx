"use client";

import { createContext, useContext, type ReactNode } from "react";
import { parseInstallationSetupViewV1, type InstallationSetupViewV1 } from "../../src/harness/v1/installation-setup-wire";
import { verifyInstallationPlanViewV1, type InstallationPlanViewV1 } from "../../src/installer/v1/installation-plan-view";
import { useLocalRuntime } from "./local-runtime";
import { usePolledRead } from "./use-polled-read";

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
  const runtime = useLocalRuntime();
  // A local runtime has no hosted setup to read. "unavailable" is a fact, not a
  // read to retry, so the hook stays disabled there and only the hosted mode
  // ever schedules. The shared hook owns the schedule: it pauses while the tab
  // is hidden, refreshes on focus, never overlaps a read, and backs off when
  // nothing changes or a read fails.
  const read = usePolledRead<InstallationTopologyState>({
    key: `installation-topology-${runtime.mode}`,
    baseIntervalMs: 30_000,
    enabled: runtime.mode === "hosted",
    read: async signal => {
      const [readinessResponse, planResponse] = await Promise.all([
        fetch("/api/v1/installation-readiness", { method: "GET", credentials: "same-origin",
          cache: "no-store", redirect: "error", signal }),
        fetch("/api/v1/installation-plan", { method: "GET", credentials: "same-origin",
          cache: "no-store", redirect: "error", signal }),
      ]);
      const setup = readinessResponse.ok
        ? parseInstallationSetupViewV1((await readinessResponse.json()).setup) : undefined;
      const installationPlan = planResponse.ok
        ? verifyInstallationPlanViewV1((await planResponse.json()).plan) : undefined;
      return Object.freeze({ state: setup ? "available" as const : "unavailable" as const,
        ...(setup ? { setup } : {}), planState: installationPlan ? "available" as const : "unavailable" as const,
        ...(installationPlan ? { plan: installationPlan } : {}) });
    },
  });
  const modeState: InstallationTopologyState = runtime.mode === "local"
    ? { state: "unavailable", planState: "unavailable" } : { state: "loading", planState: "loading" };
  // A failed hosted read must not leave a stale success on screen.
  const plan = read.error !== undefined ? { state: "unavailable", planState: "unavailable" } as const
    : read.value ?? modeState;
  return <InstallationTopologyContext.Provider value={plan}>{children}</InstallationTopologyContext.Provider>;
}

export function useInstallationTopology() { return useContext(InstallationTopologyContext); }
